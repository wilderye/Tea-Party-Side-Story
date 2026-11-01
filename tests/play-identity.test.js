import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryFiles, characterA, contextA, time, deferred } from './play-fixture.js';
import { createPlayground } from '../playground.js';
import { createIndependentPlayScope } from '../play-independent.js';
import { createPlayChatFavorites } from '../play-chat-favorites.js';
import { playRoundFile, playFavoriteFile, readPlayChat, readPlayRound, PLAY_HISTORY_INDEX } from '../play-history.js';
import { playMessageIdentity } from '../play-message-context.js';

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
            await assert.rejects(task, /模拟保存失败/); f.io.beforeWrite = null; await service.retrySave(state.resultId);
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
    assert.equal(sends, 0); assert.equal(result.result.status, 'failed');
    const raw = readRawChat(f, result.roundId);
    assert.equal(raw.messages[0].userIdentity, null);
    for (const text of f.files.values()) { assert.ok(!text.includes('private-key')); assert.ok(!text.includes('private-prompt')); }
});

test('实际人设选择入口在后续提示词处理前通知身份，并等待保存完成', async t => {
    const env = { character: characterA, characterCard: characterA, noChat: false,
        nativeChat: { chatId: 'latest', metadata: {}, messages: [] }, context: { ...contextA },
        tavern: { name1: identityA.name, userAvatar: identityA.avatar, power: { personas: { [identityA.avatar]: identityA.name } } } };
    const ctx = { characterId: 0, characters: [characterA], chatId: 'latest' };
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([{ file_name: 'latest.jsonl', last_mes: time(0) }])));
    ctx.getRequestHeaders = () => ({});
    const ready = deferred(), gate = deferred(); let complete = false;
    const task = createIndependentPlayScope(ctx, { utils: { timestampToMoment: value => ({ valueOf: () => Date.parse(value) }) } }, {
        environment: env, signal: new AbortController().signal, personaSession: { select: async () => ({ id: identityA.avatar, name: identityA.name, power: env.tavern.power }) },
        onPersonaResolved: async context => { assert.equal(context.userAvatar, identityA.avatar); ready.resolve(); await gate.promise; },
    }).then(value => { complete = true; return value; });
    await ready.promise; assert.equal(complete, false); gate.resolve(); assert.equal((await task).native, true);
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
