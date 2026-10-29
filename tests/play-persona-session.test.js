import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlayPersonaSession } from '../play-persona-session.js';
import { resolvePlayCharacterContext } from '../play-character-context.js';
import { deferred } from './play-fixture.js';

const signal = () => new AbortController().signal;

function fixture() {
    const listeners = new Map(), popups = [], choices = [];
    const context = {
        characterId: 0, groupId: null, chatId: '', name1: '当前用户',
        characters: [{ avatar: 'A.png', name: '测试甲' }, { avatar: 'B.png', name: '测试乙' }],
        eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona', CHARACTER_RENAMED: 'rename', CHARACTER_DELETED: 'delete' },
        eventSource: {
            on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
            async emit(event, ...args) { for (const listener of [...(listeners.get(event) ?? [])]) await listener(...args); },
        },
        Popup: { util: { popups } }, POPUP_RESULT: { CANCELLED: 0 },
    };
    const power = {
        personas: { current: '当前用户', first: '用户一', second: '用户二', other: '用户三' },
        persona_allow_multi_connections: true, persona_description: '当前描述',
        persona_descriptions: {
            first: { description: '描述一', connections: [{ id: 'A.png' }, { id: 'B.png' }] },
            second: { description: '描述二', connections: [{ id: 'A.png' }, { id: 'B.png' }] },
            other: { description: '描述三', connections: [] },
        },
    };
    const personas = { user_avatar: 'current', askForPersonaSelection(title, text, ids) {
        const pending = deferred();
        const popup = { complete(result) {
            const index = popups.indexOf(popup);
            if (index >= 0) popups.splice(index, 1);
            pending.resolve(result === 0 ? null : result);
        } };
        popups.push(popup); choices.push({ title, text, ids, popup });
        return pending.promise;
    } };
    const session = getPlayPersonaSession(() => context, () => personas);
    const select = (index = 0, metadata = {}, abortSignal = signal()) => session.select(power,
        context.characters[index], metadata, { avatar: personas.user_avatar, name: context.name1 }, abortSignal);
    return { context, power, personas, choices, popups, session, select };
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

test('同一角色首次弹窗，之后新开小剧场也沿用；各角色分别记住，重新打开酒馆不继承', async () => {
    const f = fixture(), original = structuredClone(f.power);
    const first = f.select(); await tick();
    f.choices[0].popup.complete('second');
    assert.equal((await first).id, 'second');
    assert.equal((await f.select()).id, 'second');
    assert.equal((await f.select(0, { persona: 'first' })).id, 'second');
    assert.equal(f.choices.length, 1);
    const another = f.select(1); await tick();
    f.choices[1].popup.complete('first');
    assert.equal((await another).id, 'first');
    assert.equal((await f.select(0)).id, 'second');
    assert.equal((await f.select(1)).id, 'first');
    assert.deepEqual(f.power, original); assert.equal(f.personas.user_avatar, 'current');
    assert.equal(f.context.chatId, '');
    assert.equal(getPlayPersonaSession(() => f.context, () => f.personas), f.session);
    const restarted = fixture(), pending = restarted.select(); await tick();
    assert.equal(restarted.choices.length, 1);
    restarted.choices[0].popup.complete('first'); await pending;
});

test('同一角色同时开始两份小剧场只弹一次，不同角色的弹窗依次显示', async () => {
    const f = fixture(), first = f.select(), second = f.select(), third = f.select(1);
    await tick(); assert.equal(f.choices.length, 1); assert.equal(f.popups.length, 1);
    f.choices[0].popup.complete('second');
    assert.equal((await first).id, 'second'); assert.equal((await second).id, 'second');
    await tick(); assert.equal(f.choices.length, 2); assert.equal(f.popups.length, 1);
    f.choices[1].popup.complete('first'); assert.equal((await third).id, 'first');
});

test('主聊天后来选择人设优先，切走角色后也记住；临时选择不要求锁定聊天或绑定角色', async () => {
    const f = fixture(), first = f.select(); await tick();
    f.choices[0].popup.complete('second'); await first;
    f.context.chatId = 'main-a'; f.personas.user_avatar = 'other';
    await f.context.eventSource.emit(f.context.eventTypes.PERSONA_CHANGED, 'other');
    f.context.characterId = 1; f.context.chatId = 'main-b'; f.personas.user_avatar = 'first';
    await f.context.eventSource.emit(f.context.eventTypes.CHAT_CHANGED, 'main-b');
    const resolved = await f.select(0, { persona: 'first' });
    assert.equal(resolved.id, 'other'); assert.equal(resolved.power.persona_description, '描述三');
    assert.equal((await f.select(1)).id, 'first'); assert.equal(f.choices.length, 1);
});

test('等待主聊天全部回调结束再使用人设，即使回调后注册且选择同一头像没有人设变更事件', async () => {
    const f = fixture(), changing = deferred(), entered = deferred();
    f.context.eventSource.on(f.context.eventTypes.CHAT_CHANGED, async () => {
        entered.resolve(); await changing.promise;
        f.personas.user_avatar = 'second';
    });
    f.context.chatId = 'main-a';
    const changed = f.context.eventSource.emit(f.context.eventTypes.CHAT_CHANGED, 'main-a');
    await entered.promise;
    const selecting = f.select(); await tick();
    assert.equal(f.choices.length, 0);
    changing.resolve(); await changed;
    assert.equal((await selecting).id, 'second'); assert.equal(f.choices.length, 0);
    f.context.characterId = 1; f.context.chatId = 'main-b';
    await f.context.eventSource.emit(f.context.eventTypes.CHAT_CHANGED, 'main-b');
    f.context.chatId = '';
    assert.equal((await f.select(1)).id, 'second'); assert.equal(f.choices.length, 0);
});

test('准备接口刚加载时可沿用当前主聊天人设，群聊和未打开聊天不影响单个角色的记录', async () => {
    const f = fixture(); f.context.chatId = 'main-a'; f.personas.user_avatar = 'second';
    f.session.refresh(); f.context.chatId = '';
    assert.equal((await f.select()).id, 'second');
    f.context.groupId = 'group'; f.context.chatId = 'group-chat'; f.personas.user_avatar = 'first';
    await f.context.eventSource.emit(f.context.eventTypes.PERSONA_CHANGED, 'first');
    f.context.groupId = null; f.context.chatId = '';
    await f.context.eventSource.emit(f.context.eventTypes.PERSONA_CHANGED, 'first');
    assert.equal((await f.select()).id, 'second'); assert.equal(f.choices.length, 0);
});

test('主聊天在小剧场弹窗期间选好人设，关闭小剧场弹窗并沿用主聊天选择', async () => {
    const f = fixture(), pending = f.select(); await tick();
    f.context.chatId = 'main-a'; f.personas.user_avatar = 'first';
    await f.context.eventSource.emit(f.context.eventTypes.PERSONA_CHANGED, 'first');
    assert.equal((await pending).id, 'first'); assert.equal(f.popups.length, 0);
    f.context.chatId = '';
    assert.equal((await f.select()).id, 'first'); assert.equal(f.choices.length, 1);
});

test('旧版酒馆没有人设变更通知时，保存设置后也记住主聊天的新选择', async () => {
    const f = fixture();
    delete f.context.eventTypes.PERSONA_CHANGED;
    f.context.eventTypes.SETTINGS_UPDATED = 'settings';
    f.context.chatId = 'main-a'; f.personas.user_avatar = 'second';
    await f.context.eventSource.emit(f.context.eventTypes.SETTINGS_UPDATED);
    f.context.characterId = 1; f.context.chatId = 'main-b'; f.personas.user_avatar = 'first';
    assert.equal((await f.select(0)).id, 'second'); assert.equal(f.choices.length, 0);
});

test('通知处理中切走主聊天，人设选择仍记在通知开始时所属的角色', async () => {
    const f = fixture();
    delete f.context.eventTypes.PERSONA_CHANGED;
    f.context.eventTypes.SETTINGS_UPDATED = 'settings';
    f.context.chatId = 'main-a'; f.personas.user_avatar = 'second';
    f.context.eventSource.on(f.context.eventTypes.SETTINGS_UPDATED, () => { f.context.chatId = ''; });
    await f.context.eventSource.emit(f.context.eventTypes.SETTINGS_UPDATED);
    assert.equal((await f.select()).id, 'second'); assert.equal(f.choices.length, 0);
});

test('取消或停止不记住选择，下一次仍弹窗；等待主聊天时也可以停止', async () => {
    const f = fixture(), cancelled = f.select(); await tick();
    const rejection = assert.rejects(cancelled, { name: 'AbortError' });
    f.choices[0].popup.complete(0); await rejection;
    const controller = new AbortController(), stopped = f.select(0, {}, controller.signal); await tick();
    const stoppedRejection = assert.rejects(stopped, { name: 'AbortError' });
    controller.abort(); await stoppedRejection; assert.equal(f.popups.length, 0);
    const next = f.select(); await tick(); assert.equal(f.choices.length, 3);
    f.choices[2].popup.complete('first'); assert.equal((await next).id, 'first');
    const changing = deferred();
    f.context.eventSource.on(f.context.eventTypes.CHAT_CHANGED, () => changing.promise);
    f.context.chatId = 'main-a';
    const change = f.context.eventSource.emit(f.context.eventTypes.CHAT_CHANGED, 'main-a');
    const waitingController = new AbortController();
    const waiting = f.select(0, {}, waitingController.signal);
    const waitingRejection = assert.rejects(waiting, { name: 'AbortError' });
    await tick(); waitingController.abort(); await waitingRejection;
    changing.resolve(); await change;
});

test('记住的人设已删除或解除角色绑定时重新选择，角色改名保留记录，删卡清除记录', async () => {
    const f = fixture(), first = f.select(); await tick();
    f.choices[0].popup.complete('second'); await first;
    f.power.persona_descriptions.second.connections = [{ id: 'B.png' }];
    assert.equal((await f.select()).id, 'first');
    f.power.persona_descriptions.second.connections.push({ id: 'A.png' });
    const second = f.select(); await tick();
    f.choices[1].popup.complete('second'); await second;
    f.context.characters[0].avatar = 'renamed.png';
    for (const descriptor of Object.values(f.power.persona_descriptions)) {
        for (const connection of descriptor.connections) if (connection.id === 'A.png') connection.id = 'renamed.png';
    }
    await f.context.eventSource.emit(f.context.eventTypes.CHARACTER_RENAMED, 'A.png', 'renamed.png');
    assert.equal((await f.select()).id, 'second');
    delete f.power.personas.second;
    assert.equal((await f.select()).id, 'first');
    f.power.personas.second = '用户二';
    const third = f.select(); await tick(); f.choices[2].popup.complete('second'); await third;
    await f.context.eventSource.emit(f.context.eventTypes.CHARACTER_DELETED, { character: f.context.characters[0] });
    const recreated = f.select(); await tick(); assert.equal(f.choices.length, 4);
    f.choices[3].popup.complete('first'); await recreated;
});

test('角色资料处理入口实际使用本次启动的选择，仍不读取禁用的聊天或修改酒馆人设', async () => {
    const f = fixture(), env = () => ({ noChat: true, character: f.context.characters[0],
        tavern: { power: structuredClone(f.power), userAvatar: 'current', name1: '当前用户' } });
    const resolve = () => resolvePlayCharacterContext(f.context, env(), signal(), {
        fetchJson: () => { throw Error('不应读取聊天'); },
        selectPersona: (power, character, metadata, current) => f.session.select(power, character, metadata, current, signal()),
        initializeVariables: async () => ({}),
    });
    const first = resolve(); await tick(); f.choices[0].popup.complete('second');
    assert.equal((await first).persona.id, 'second');
    assert.equal((await resolve()).persona.id, 'second'); assert.equal(f.choices.length, 1);
    assert.equal(f.personas.user_avatar, 'current'); assert.equal(f.power.persona_description, '当前描述');
});
