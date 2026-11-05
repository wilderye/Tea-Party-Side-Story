import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { memoryFiles, characterA, contextA, time, deferred } from './play-fixture.js';
import { createPlayground } from '../playground.js';
import { createIndependentPlayScope } from '../play-independent.js';
import { createNativePlayPreparer } from '../play-prompt.js';
import { getPlayPersonaSession } from '../play-persona-session.js';
import { createPlayChatFavorites } from '../play-chat-favorites.js';
import { playRoundFile, playFavoriteFile, readPlayChat, readPlayRound, PLAY_HISTORY_INDEX } from '../play-history.js';
import { playMessageIdentity, playChatMessageIdentity } from '../play-message-context.js';

const identityA = { name: '用户甲', avatar: '用户甲.png' };
const identityB = { name: '用户乙', avatar: '用户乙.png' };
const contextFor = identity => ({ ...contextA, userName: identity.name, userAvatar: identity.avatar ?? '' });
const serviceFor = (f, prepareRequest) => createPlayground({ history: f.store, isCurrent: () => true,
    captureEnvironment: () => ({ character: characterA, context: { ...contextA }, independent: true }), prepareRequest });
const readRawChat = (f, id) => {
    const row = f.directory().rounds.find(row => row.id === id);
    return JSON.parse(f.files.get(playRoundFile(id, row.revision)));
};
const writeRawChat = (f, value) => {
    const row = f.directory().rounds.find(row => row.id === value.id);
    f.files.set(playRoundFile(value.id, row.revision), JSON.stringify(value));
};
async function seed(f, identity = identityA) {
    const round = await f.begin({ context: contextFor(identity) });
    await f.store.saveResult(round.id, round.results[0].id, { text: '第一份回复', status: 'complete', finishedAt: time(1) });
    return f.store.getChat(round.id);
}

test('新分支消息首次显示和首次保存就带本次人设，保存等待不会改变本次生成', async () => {
    const f = memoryFiles(), chat = await seed(f), saving = deferred(), saved = deferred();
    let currentIdentity = identityB, resolutions = 0, sends = 0;
    const displayed = [], firstSaves = [];
    const prepare = Object.assign(async request => {
        assert.deepEqual(request.resolvedContext.context, contextFor(identityB));
        await request.onPersonaResolved(request.resolvedContext.context);
        return { context: request.resolvedContext.context, send: async () => { sends++; return '本次回复'; } };
    }, { resolveContext: async () => { resolutions++; return { context: contextFor(currentIdentity) }; } });
    const service = serviceFor(f, prepare);
    service.subscribe(job => {
        const message = job.chat?.messages.find(message => message.role === 'user' && message.text === '首次显示验证');
        if (message) displayed.push(playChatMessageIdentity(job.chat.messages, message));
    });
    f.io.beforeWrite = async (name, text) => {
        if (name === PLAY_HISTORY_INDEX) { saving.resolve(); await saved.promise; }
        else if (name.startsWith(`teahouse-play-${chat.id}-`) && name.endsWith('.json')) {
            const value = JSON.parse(text), message = value.messages?.find(message => message.role === 'user' && message.createdAt !== chat.createdAt);
            if (message) firstSaves.push(message.userIdentity);
        }
    };
    const task = service.sendChat(chat.id, { character: characterA, characterId: chat.characterId, prompt: '首次显示验证' });
    try {
        await saving.promise;
        assert.ok(displayed.length);
        assert.deepEqual(displayed[0], identityB);
        assert.equal(service.getState().phase, 'preparing');
        assert.equal(sends, 0);
        currentIdentity = identityA;
    } finally { saved.resolve(); }
    const result = await task;
    assert.equal(resolutions, 1); assert.equal(sends, 1);
    assert.ok(displayed.every(identity => JSON.stringify(identity) === JSON.stringify(identityB)));
    assert.ok(firstSaves.length);
    assert.deepEqual(firstSaves[0], identityB);
    assert.deepEqual((await f.store.getChat(chat.id)).messages[2].userIdentity, identityB);
    assert.equal(result.result.context.userName, identityB.name);
});

test('人设选择完成前不创建消息，停止或取消不写入历史，也不开始提示词处理', async () => {
    for (const action of ['stop', 'cancel']) {
        const f = memoryFiles(), chat = await seed(f), choosing = deferred(), choice = deferred();
        let preparations = 0;
        const prepare = Object.assign(async () => { preparations++; return { send: async () => '不应发送' }; }, {
            resolveContext: async () => { choosing.resolve(); await choice.promise; return { context: contextFor(identityB) }; },
        });
        const service = serviceFor(f, prepare), writes = f.writes.length;
        const task = service.sendChat(chat.id, { character: characterA, characterId: chat.characterId, prompt: '等待人设选择' });
        await choosing.promise;
        assert.equal(service.session.currentChat(chat.id).messages.length, chat.messages.length);
        assert.equal(f.writes.length, writes);
        assert.equal(service.availability({ chatId: chat.id }).code, 'busy');
        if (action === 'stop') { service.stopAll(); assert.equal(await task, null); choice.resolve(); }
        else { choice.reject(new DOMException('取消人设选择', 'AbortError')); assert.equal(await task, null); }
        await nextTurn();
        assert.equal(preparations, 0); assert.equal(f.writes.length, writes);
        assert.equal(service.session.currentChat(chat.id).messages.length, chat.messages.length);
        assert.equal(service.availability({ chatId: chat.id }).available, true);
    }
});

test('发送前确定的人设只属于本次请求，换人设重新生成仍使用新的人设', async () => {
    const f = memoryFiles(), chat = await seed(f);
    let identity = identityA, resolutions = 0;
    const prepare = Object.assign(async request => {
        const context = request.resolvedContext?.context ?? contextFor(identity);
        await request.onPersonaResolved(context);
        return { context, send: async () => context.userName + '的回复' };
    }, { resolveContext: async () => { resolutions++; return { context: contextFor(identity) }; } });
    const service = serviceFor(f, prepare), target = { character: characterA, characterId: chat.characterId };
    const first = await service.sendChat(chat.id, { ...target, prompt: '本次发送' });
    identity = identityB;
    const current = await service.getChat(chat.id), assistant = current.messages.at(-1);
    const next = await service.regenerateChat(chat.id, assistant.id, first.result.id, target);
    assert.equal(resolutions, 1);
    assert.equal(next.result.context.userName, identityB.name);
    const regenerated = await service.getChat(chat.id);
    assert.deepEqual(regenerated.messages[2].userIdentity, identityA);
    assert.deepEqual(playChatMessageIdentity(regenerated.messages, regenerated.messages[2]), identityB);
});

test('新用户身份在准备阶段保存，重复设置不覆盖身份，重新打开保留', async () => {
    const f = memoryFiles(), ready = deferred(), finish = deferred();
    const service = serviceFor(f, async request => {
        await request.onPersonaResolved(contextFor(identityB)); ready.resolve();
        await finish.promise;
        return { context: contextFor(identityB), send: async ({ onText }) => { onText('正文'); return '完整正文'; } };
    });
    const task = service.send({ prompt: '新消息' }); await ready.promise;
    const state = service.getState(), raw = readRawChat(f, state.roundId);
    assert.deepEqual(raw.messages[0].userIdentity, identityB);
    assert.deepEqual((await service.getRound(state.roundId)).userIdentity, identityB);
    assert.deepEqual((await service.getChat(state.roundId)).messages[0].userIdentity, identityB);
    assert.equal(raw.messages[1].results[0].status, 'unfinished');
    const writes = f.writes.length;
    await f.store.setUserIdentity(state.roundId, state.userMessageId, state.resultId, identityA);
    assert.equal(f.writes.length, writes);
    finish.resolve(); await task;
    assert.deepEqual((await f.createStore().getChat(state.roundId)).messages[0].userIdentity, identityB);
});

test('重生成、另一个版本、切换版本、续写、分支和删除不改已发送用户身份', async () => {
    const f = memoryFiles(), chat = await seed(f);
    const service = serviceFor(f, async request => {
        await request.onPersonaResolved(contextFor(identityB));
        return { context: contextFor(identityB), send: async () => '乙生成的回复' };
    });
    const target = { character: characterA, characterId: chat.characterId };
    const added = await service.generateChatVersion(chat.id, chat.messages[1].id, target);
    let next = await f.store.getChat(chat.id);
    assert.deepEqual(next.messages[0].userIdentity, identityA);
    assert.equal(next.messages[1].results.at(-1).context.userName, identityB.name);
    await service.setMessageVersion(chat.id, chat.messages[1].id, chat.messages[1].selectedResultId);
    assert.deepEqual((await f.store.getChat(chat.id)).messages[0].userIdentity, identityA);
    await service.setMessageVersion(chat.id, chat.messages[1].id, added.result.id);
    await service.regenerateChat(chat.id, chat.messages[1].id, added.result.id, target);
    next = await f.store.getChat(chat.id);
    await service.continueChat(chat.id, chat.messages[1].id, next.messages[1].selectedResultId, target);
    const branch = await service.createBranch(chat.id, chat.messages[1].id);
    assert.deepEqual(branch.messages[0].userIdentity, identityA);
    const favorites = createPlayChatFavorites(f.store);
    const saved = await favorites.add(chat.id);
    await f.store.removeMessage(chat.id, chat.messages[1].id);
    assert.deepEqual((await f.store.getRound(chat.id)).userIdentity, identityA);
    assert.equal((await favorites.sync(saved.id)).messages[0].speakerName, identityA.name);
    await favorites.removeChat(chat.id);
    assert.equal((await favorites.read(saved.id)).messages[0].speakerAvatar, identityA.avatar);
});

test('新分支消息使用目标人设，没有头像保持空值；下一轮不覆盖上一轮', async () => {
    const f = memoryFiles(), chat = await seed(f);
    const service = serviceFor(f, async request => {
        await request.onPersonaResolved(contextFor({ name: '𠮷客', avatar: null }));
        return { context: contextFor({ name: '𠮷客', avatar: null }), send: async () => '回复' };
    });
    await service.sendChat(chat.id, { character: characterA, characterId: chat.characterId, prompt: '新消息' });
    const next = await f.store.getChat(chat.id);
    assert.deepEqual(next.messages[0].userIdentity, identityA);
    assert.deepEqual(next.messages[2].userIdentity, { name: '𠮷客', avatar: null });
    await f.store.removeMessage(chat.id, next.messages[1].id);
    assert.deepEqual((await f.store.getChat(chat.id)).messages[0].userIdentity, identityA);
});

test('旧记录只从同轮最初生成信息补齐，读取不写文件，版本切换前保留结果', async () => {
    const f = memoryFiles(), chat = await seed(f);
    const id = randomUUID();
    await f.begin({ roundId: chat.id, resultId: id, startedAt: time(2), context: contextFor(identityB) });
    await f.store.saveResult(chat.id, id, { text: '第二份回复', status: 'complete', finishedAt: time(3) });
    const raw = readRawChat(f, chat.id); delete raw.messages[0].userIdentity; writeRawChat(f, raw);
    const writes = f.writes.length;
    assert.deepEqual((await f.createStore().getRound(chat.id)).userIdentity, identityA);
    assert.deepEqual((await f.createStore().getChat(chat.id)).messages[0].userIdentity, identityA);
    assert.equal(f.writes.length, writes);
    await f.store.setMessageVersion(chat.id, chat.messages[1].id, chat.messages[1].selectedResultId);
    assert.deepEqual(readRawChat(f, chat.id).messages[0].userIdentity, identityA);
    const unknown = structuredClone(raw); unknown.messages[1].results = [unknown.messages[1].results[1]];
    unknown.messages[1].selectedResultId = id;
    assert.equal(readPlayChat(unknown, { bodyStored: true }).messages[0].userIdentity, null);
    unknown.messages.splice(1, 0, { ...unknown.messages[0], id: randomUUID(), createdAt: time(2) });
    assert.equal(readPlayChat(unknown, { bodyStored: true }).messages[0].userIdentity, null);
    assert.deepEqual(playMessageIdentity({ userIdentity: null }), { name: '用户', avatar: null });
    const old = readPlayRound({ format: 1, id: chat.id, characterId: chat.characterId, createdAt: chat.createdAt,
        origin: chat.origin, prompt: '旧消息', results: (await f.store.getRound(chat.id)).results });
    assert.deepEqual(old.userIdentity, identityA);
});

test('用户消息显示所选回复版本的人设，没有对应版本时使用发送时的人设', async () => {
    const f = memoryFiles(), chat = await seed(f), favorites = createPlayChatFavorites(f.store);
    const id = randomUUID();
    await f.begin({ roundId: chat.id, resultId: id, startedAt: time(2), context: contextFor(identityB) });
    await f.store.saveResult(chat.id, id, { text: '第二份回复', status: 'complete', finishedAt: time(3) });
    let current = await f.store.getChat(chat.id);
    assert.equal(current.messages[1].selectedResultId, id);
    assert.deepEqual(playChatMessageIdentity(current.messages, current.messages[0]), identityB);
    const favorite = await favorites.add(chat.id);
    assert.equal(favorite.messages[0].speakerName, identityB.name);
    assert.equal(favorite.messages[0].speakerAvatar, identityB.avatar);
    await f.store.setMessageVersion(chat.id, current.messages[1].id, current.messages[1].results[0].id, id);
    current = await f.store.getChat(chat.id);
    assert.deepEqual(playChatMessageIdentity(current.messages, current.messages[0]), identityA);
    assert.equal((await favorites.sync(favorite.id)).messages[0].speakerName, identityA.name, '收藏跟随来源聊天当前所选版本');
    const lone = { ...current.messages[0] };
    assert.deepEqual(playChatMessageIdentity([lone], lone), identityA, 'AI 回复删除后使用发送时的人设');
    const unknown = { ...lone, userIdentity: null };
    assert.deepEqual(playChatMessageIdentity([unknown], unknown), { name: '用户', avatar: null });
    const legacy = structuredClone(current);
    legacy.messages[1].results[0].context = { ...contextA };
    legacy.messages[0].userIdentity = identityB;
    assert.deepEqual(playChatMessageIdentity(legacy.messages, legacy.messages[0]), identityB, '没有人设信息的旧版本使用发送时的人设');
    assert.deepEqual(playMessageIdentity({ userIdentity: identityA }, { context: contextFor(identityB) }), identityB);
});

test('旧收藏即使来源修订未变也修正身份，冻结收藏保持已有信息', async () => {
    const f = memoryFiles(), chat = await seed(f), favorites = createPlayChatFavorites(f.store);
    const favorite = await favorites.add(chat.id), row = f.directory().favorites.find(row => row.id === favorite.id);
    const file = playFavoriteFile(row.id, row.revision), raw = JSON.parse(f.files.get(file));
    raw.messages[0].speakerName = identityB.name; raw.messages[0].speakerAvatar = identityB.avatar;
    f.files.set(file, JSON.stringify(raw));
    const fixed = await favorites.sync(favorite.id);
    assert.equal(fixed.messages[0].speakerName, identityA.name);
    assert.equal(fixed.messages[0].speakerAvatar, identityA.avatar);
    await favorites.removeChat(chat.id);
    assert.equal((await favorites.sync(favorite.id)).messages[0].speakerName, identityA.name);
});

test('准备失败、停止和最终保存失败仍保留已确认身份，迟到选择不得修改历史', async () => {
    for (const action of ['fail', 'stop', 'save-fail']) {
        const f = memoryFiles(), ready = deferred(), gate = deferred();
        const service = serviceFor(f, async request => {
            await request.onPersonaResolved(contextFor(identityA)); ready.resolve(); await gate.promise;
            if (action === 'fail') throw Error('模拟准备失败');
            return { context: contextFor(identityA), send: async () => {
                if (action === 'save-fail') f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟保存失败'); };
                return '正文';
            } };
        });
        const task = service.send({ prompt: '消息' }); await ready.promise;
        const state = service.getState(); if (action === 'stop') service.stop(state.resultId);
        gate.resolve();
        if (action === 'save-fail') {
            await task; f.io.beforeWrite = null; await service.session.flush(state.roundId);
        } else await task;
        assert.deepEqual((await f.createStore().getChat(state.roundId)).messages[0].userIdentity, identityA);
    }
    const f = memoryFiles(), ready = deferred(), gate = deferred(); let callback;
    const service = serviceFor(f, async request => { callback = request.onPersonaResolved; ready.resolve(); await gate.promise; return { send: async () => '正文' }; });
    const task = service.send({ prompt: '已停止的消息' }); await ready.promise;
    service.stopAll(); await task;
    const writes = f.writes.length;
    await assert.rejects(callback(contextFor(identityB)), { name: 'AbortError' });
    assert.equal(f.writes.length, writes); gate.resolve();
});

test('身份保存失败阻止模型请求，不混入配置或提示词内容', async () => {
    const f = memoryFiles(); let sends = 0;
    const service = serviceFor(f, async request => {
        f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('身份保存失败'); };
        try { await request.onPersonaResolved({ ...contextFor(identityA), key: 'private-key', prompt: 'private-prompt' }); }
        finally { f.io.beforeWrite = null; }
        return { send: async () => { sends++; return '正文'; } };
    });
    const result = await service.send({ prompt: '正常消息' });
    assert.equal(sends, 0); assert.equal(result, null);
    const id = (await service.listRounds((await service.listCharacters())[0].id))[0].id;
    assert.equal(service.session.currentRound(id).results[0].status, 'stopped');
    assert.equal(service.session.currentRound(id).results[0].error, undefined);
    await service.session.flush(id);
    const raw = readRawChat(f, id);
    assert.deepEqual(raw.messages[0].userIdentity, identityA);
    for (const text of f.files.values()) { assert.ok(!text.includes('private-key')); assert.ok(!text.includes('private-prompt')); }
});

test('实际人设选择入口在后续提示词处理前通知身份，并等待保存完成', async t => {
    const env = { character: characterA, characterCard: characterA, noChat: false,
        nativeChat: { chatId: 'latest', metadata: {}, messages: [] }, context: { ...contextA },
        tavern: { name1: identityA.name, userAvatar: identityA.avatar, power: { personas: { [identityA.avatar]: identityA.name } } } };
    const ctx = { characterId: 0, characters: [characterA], chatId: 'latest', name1: identityA.name };
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([{ file_name: 'latest.jsonl', last_mes: time(0) }])));
    ctx.getRequestHeaders = () => ({});
    const ready = deferred(), gate = deferred(); let complete = false;
    const task = createIndependentPlayScope(ctx, { utils: { timestampToMoment: value => ({ valueOf: () => Date.parse(value) }) } }, {
        environment: env, signal: new AbortController().signal, personaSession: { select: async () => ({ id: identityA.avatar, name: identityA.name, power: env.tavern.power }) },
        onPersonaResolved: async context => { assert.equal(context.userAvatar, identityA.avatar); ready.resolve(); await gate.promise; },
    }).then(value => { complete = true; return value; });
    await ready.promise; assert.equal(complete, false); gate.resolve(); assert.equal((await task).native, true);
});

test('实际准备入口复用发送前确定的人设和聊天，只在本次请求内复用', async t => {
    const env = { character: characterA, characterCard: characterA, noChat: false,
        nativeChat: { chatId: 'latest', metadata: {}, messages: [] }, context: { ...contextA },
        tavern: { name1: identityA.name, userAvatar: identityA.avatar, power: { personas: { [identityA.avatar]: identityA.name } } } };
    const ctx = { characterId: 0, characters: [characterA], chatId: 'latest', name1: identityA.name, getRequestHeaders: () => ({}),
        eventTypes: {}, eventSource: { on() {}, async emit() {} } };
    let reads = 0, selections = 0;
    t.mock.method(globalThis, 'fetch', async () => { reads++; return new Response(JSON.stringify([{ file_name: 'latest.jsonl', last_mes: time(0) }])); });
    const modules = { personas: { user_avatar: identityA.avatar }, utils: { timestampToMoment: value => ({ valueOf: () => Date.parse(value) }) } };
    const prepare = createNativePlayPreparer(() => ctx, { loadModules: async () => modules });
    const session = getPlayPersonaSession(() => ctx, () => modules.personas), select = session.select;
    t.mock.method(session, 'select', (...args) => { selections++; return select(...args); });
    const options = { environment: env, signal: new AbortController().signal };
    const resolvedContext = await prepare.resolveContext(options);
    assert.equal(reads, 1); assert.equal(selections, 1);
    assert.equal(resolvedContext.context.userName, identityA.name);
    assert.equal(resolvedContext.context.userAvatar, identityA.avatar);
    assert.equal(resolvedContext.context.chatId, 'latest');
    const scope = await createIndependentPlayScope(ctx, modules, { ...options, resolvedContext });
    assert.equal(scope.native, true); assert.equal(scope.resolved, resolvedContext);
    assert.equal(reads, 1); assert.equal(selections, 1);
    await createIndependentPlayScope(ctx, modules, { ...options, environment: structuredClone(env) });
    assert.equal(reads, 2); assert.equal(selections, 2);
});

test('并发请求分别保存人设，原消息删除后不重建，头像缺失不借用当前人设', async () => {
    const f = memoryFiles(), gates = new Map(), ready = deferred();
    const service = serviceFor(f, async request => {
        const gate = deferred(); gates.set(request.prompt, { gate, request });
        if (gates.size === 2) ready.resolve();
        await gate.promise;
        const identity = request.prompt === '甲' ? identityA : identityB;
        await request.onPersonaResolved(contextFor(identity));
        return { context: contextFor(identity), send: async () => '回复' };
    });
    const a = service.send({ prompt: '甲' }), b = service.send({ prompt: '乙' }); await ready.promise;
    const first = service.getStates().find(job => job.resultId === gates.get('甲').request.generationId);
    await f.store.removePrompt(first.roundId, '甲');
    gates.get('乙').gate.resolve(); const resultB = await b;
    gates.get('甲').gate.resolve(); const resultA = await a;
    assert.equal((await f.store.getRound(resultA.roundId)).prompt, null);
    assert.equal((await f.store.getChat(resultA.roundId)).messages.some(message => message.role === 'user'), false);
    assert.deepEqual((await f.store.getRound(resultB.roundId)).userIdentity, identityB);
    const unknown = await seed(f, { name: '只有名字', avatar: null });
    const favorite = await createPlayChatFavorites(f.store).add(unknown.id);
    assert.equal(favorite.messages[0].speakerName, '只有名字'); assert.equal(favorite.messages[0].speakerAvatar, '');
});
