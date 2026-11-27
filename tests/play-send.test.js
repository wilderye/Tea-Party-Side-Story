import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayground } from '../playground.js';
import { getPlayComposerAction } from '../play-message-context.js';
import { memoryFiles, characterA, contextA, deferred, time } from './play-fixture.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let step = 0; step < 300; step++) { if (predicate()) return; await turn(); }
    assert.fail('Expected generation state did not arrive');
}

async function fixture(prepare) {
    const files = memoryFiles(), initial = await files.begin();
    await files.store.saveResult(initial.id, initial.results[0].id,
        { text: '原来的完整回复', status: 'complete', finishedAt: time(1) });
    const original = await files.store.getChat(initial.id);
    const branch = await files.store.createBranch(original.id, original.messages.at(-1).id);
    const requests = [];
    const service = createPlayground({ history: files.store, isCurrent: () => true,
        captureEnvironment: () => ({ character: characterA, context: contextA, independent: true }),
        prepareRequest: async request => {
            requests.push(request);
            return prepare ? prepare(request) : { send: async () => '新的一条 AI 回复' };
        },
    });
    return { ...files, original, branch, requests, service,
        target: { character: characterA, characterId: original.characterId } };
}

test('两页共用发送规则，空框按末尾角色判断，回车不能触发总停止', () => {
    for (const chatMode of [false, true]) {
        assert.equal(getPlayComposerAction({ chatMode, lastRole: 'user' }), 'reply');
        assert.equal(getPlayComposerAction({ chatMode, lastRole: 'assistant' }), chatMode ? 'reply' : null);
        assert.equal(getPlayComposerAction({ chatMode }), null);
        assert.equal(getPlayComposerAction({ chatMode, prompt: '新内容' }), 'send');
        for (const phase of ['preparing', 'generating', 'retry-wait']) {
            const jobs = [{ phase, requestedRoundId: 'another-chat' }];
            assert.equal(getPlayComposerAction({ chatMode, lastRole: 'user', jobs }), 'stop');
            assert.equal(getPlayComposerAction({ chatMode, lastRole: 'assistant', jobs, prompt: '   ' }), 'stop');
            assert.equal(getPlayComposerAction({ chatMode, jobs, prompt: '新内容' }), chatMode ? 'stop' : 'send');
            assert.equal(getPlayComposerAction({ chatMode, jobs, allowStop: false }), null);
            assert.equal(getPlayComposerAction({ chatMode, jobs, prompt: '新内容', allowStop: false }), chatMode ? null : 'send');
        }
        assert.equal(getPlayComposerAction({ chatMode, lastRole: 'user', jobs: [{ phase: 'idle' }] }), 'reply');
    }
});

for (const chatMode of [false, true]) test((chatMode ? '分支' : '演出') + '空框回答已有用户消息，只新增 AI 楼层', async () => {
    const f = await fixture(), id = (chatMode ? f.branch : f.original).id;
    const round = await f.store.getRound(id);
    await f.store.removeReply(id, round.results);
    const before = await f.store.getChat(id), user = before.messages.at(-1);
    const result = await f.service.replyToLastMessage(id, { ...f.target, chatMode,
        messageId: user.id, expectedRevision: before.revision });
    const saved = await f.createStore().getChat(id);
    assert.deepEqual(saved.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(saved.messages[0], user);
    assert.notEqual(saved.messages[1].id, (chatMode ? f.branch : f.original).messages[1].id);
    assert.equal(saved.messages[1].results.length, 1);
    assert.equal(saved.messages[1].results[0].text, '新的一条 AI 回复');
    assert.equal(saved.messages[1].results[0].id, result.result.id);
    assert.deepEqual(saved.startMessageIds, [user.id, saved.messages[1].id]);
    assert.equal(f.requests[0].prompt, user.text);
    assert.equal(f.requests[0].environment.requestUser.id, user.id);
    assert.equal(f.requests[0].continueMessage, undefined);
});

test('分支末尾是 AI 时新增下一条 AI，原消息和全部版本保持原样', async () => {
    const f = await fixture(), before = await f.store.getChat(f.branch.id);
    await f.service.replyToLastMessage(before.id, { ...f.target, chatMode: true,
        messageId: before.messages.at(-1).id, expectedRevision: before.revision });
    const saved = await f.createStore().getChat(before.id);
    assert.deepEqual(saved.messages.map(message => message.role), ['user', 'assistant', 'assistant']);
    assert.deepEqual(saved.messages.slice(0, 2), before.messages);
    assert.deepEqual(saved.startMessageIds, before.startMessageIds);
    assert.equal(saved.messages[2].results[0].text, '新的一条 AI 回复');
    assert.equal(f.requests[0].prompt, undefined);
    assert.equal(f.requests[0].continueMessage, undefined);
    assert.deepEqual(f.requests[0].environment.branchHistory.map(message => message.text),
        [before.messages[0].text, before.messages[1].results[0].text]);
    assert.equal(f.requests[0].environment.requestUser, null);
});

test('分支末尾用户消息来自后续对话时，沿用该消息并保留之前的历史', async () => {
    const f = await fixture();
    await f.service.sendChat(f.branch.id, { ...f.target, prompt: '最后一条用户消息' });
    let current = await f.store.getChat(f.branch.id);
    await f.service.removeMessage(current.id, current.messages.at(-1).id);
    current = await f.store.getChat(current.id);
    const user = current.messages.at(-1);
    await f.service.replyToLastMessage(current.id, { ...f.target, chatMode: true, messageId: user.id });
    const saved = await f.store.getChat(current.id), request = f.requests.at(-1);
    assert.deepEqual(saved.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.deepEqual(saved.messages.slice(0, 3), current.messages);
    assert.equal(request.prompt, '最后一条用户消息');
    assert.equal(request.environment.requestUser.id, user.id);
    assert.equal(request.environment.branchHistory.length, 2);
});

test('演出末尾是 AI 时拒绝空框回答，过期的末尾消息也不能追加回复', async () => {
    const f = await fixture(), before = await f.store.getChat(f.original.id);
    await assert.rejects(f.service.replyToLastMessage(before.id, f.target), { code: 'empty_prompt' });
    assert.equal(f.requests.length, 0);
    assert.deepEqual((await f.store.getChat(before.id)).messages, before.messages);
    await f.service.ensureChat(before.id);
    await assert.rejects(f.service.replyToLastMessage(before.id, f.target), { code: 'empty_prompt' });
    await f.service.replyToLastMessage(f.branch.id, { ...f.target, chatMode: true });
    const saved = await f.store.getChat(f.branch.id);
    await assert.rejects(f.service.replyToLastMessage(saved.id, { ...f.target, chatMode: true,
        messageId: f.branch.messages.at(-1).id }), { code: 'chat_conflict' });
    assert.equal(f.requests.length, 1);
    assert.deepEqual((await f.store.getChat(saved.id)).messages, saved.messages);
});

test('空框新回复等待读取时不锁住原 AI 消息，停止后迟到读取不会发送', async t => {
    const f = await fixture(), before = f.branch, waiting = deferred();
    await f.service.ensureChat(before.id);
    const ensure = f.service.session.ensureChat;
    f.service.session.ensureChat = async (...args) => { await waiting.promise; return ensure(...args); };
    const task = f.service.replyToLastMessage(before.id, { ...f.target, chatMode: true, messageId: before.messages.at(-1).id });
    t.after(async () => { f.service.stopAll(); waiting.resolve(); await task; });
    assert.equal(f.service.getActionPermission('edit', { chat: before, messageId: before.messages.at(-1).id }).available, true);
    f.service.stopAll();
    await task;
    waiting.resolve(); await turn();
    assert.equal(f.requests.length, 0);
    assert.deepEqual((await f.store.getChat(before.id)).messages, before.messages);
});

test('新的 AI 楼层可以同时生成多个版本，总停止共同取消演出和分支任务', async t => {
    const calls = new Map(), tasks = [];
    const f = await fixture(request => ({ send: async options => {
        const gate = deferred();
        calls.set(request.generationId, { gate, signal: options.signal });
        options.onText('收到的片段');
        return gate.promise;
    } }));
    t.after(async () => {
        f.service.stopAll();
        for (const call of calls.values()) call.gate.resolve('测试清理');
        await Promise.allSettled(tasks);
    });
    tasks.push(f.service.replyToLastMessage(f.branch.id, { ...f.target, chatMode: true }));
    await until(() => calls.size === 1);
    await assert.rejects(f.service.replyToLastMessage(f.branch.id, { ...f.target, chatMode: true }), { code: 'busy' });
    const current = f.service.session.currentChat(f.branch.id);
    tasks.push(f.service.generateChatVersion(current.id, current.messages.at(-1).id, f.target));
    tasks.push(f.service.send({ ...f.target, prompt: '同时生成的独立演出' }));
    await until(() => calls.size === 3);
    assert.equal(f.service.getStates().length, 3);
    assert.equal(f.service.stopAll(), 3);
    for (const call of calls.values()) assert.equal(call.signal.aborted, true);
    await Promise.all(tasks);
    const saved = await f.store.getChat(f.branch.id);
    assert.equal(saved.messages.length, 3);
    assert.equal(saved.messages.at(-1).results.length, 2);
    assert.ok(saved.messages.at(-1).results.every(result => result.status === 'stopped' && result.text === '收到的片段'));
    assert.deepEqual(saved.messages.slice(0, 2), f.branch.messages);
});

test('没有活动任务时分支可以接着未完成的旧 AI 消息新增回复，不改写旧状态', async () => {
    const files = memoryFiles(), initial = await files.begin();
    const original = await files.store.getChat(initial.id), requests = [];
    const service = createPlayground({ history: files.store, isCurrent: () => true,
        captureEnvironment: () => ({ character: characterA, context: contextA, independent: true }),
        prepareRequest: async request => { requests.push(request); return { send: async () => '继续剧情的新回复' }; },
    });
    await service.replyToLastMessage(original.id, { chatMode: true, character: characterA });
    const saved = await files.store.getChat(original.id);
    assert.equal(saved.messages.length, 3);
    assert.deepEqual(saved.messages[1], original.messages[1]);
    assert.equal(saved.messages[1].results[0].status, 'unfinished');
    assert.equal(requests.length, 1);
});
