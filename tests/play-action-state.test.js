import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlayground } from '../playground.js';
import { memoryFiles, characterA, contextA, deferred, time } from './play-fixture.js';
import { PLAY_HISTORY_INDEX, playStartRound } from '../play-history.js';
import { getPlayActionPermission } from '../play-message-context.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let index = 0; index < 300; index++) { if (predicate()) return; await turn(); }
    assert.fail('Expected operation state did not arrive');
}

async function fixture(t) {
    const files = memoryFiles(), calls = [], tasks = [], cleanup = [];
    let tick = 10;
    const initial = await files.begin();
    const saved = await files.store.saveResult(initial.id, initial.results[0].id,
        { text: '版本一已保存的正文', status: 'complete', finishedAt: time(1) });
    const service = createPlayground({ history: files.store, uuid: randomUUID, now: () => time(tick++),
        captureEnvironment: () => ({ character: characterA, context: contextA, independent: true }), isCurrent: () => true,
        prepareRequest: async request => ({ send: async options => {
            const gate = deferred(), prefix = request.continueMessage ?? '';
            calls.push({ id: request.generationId, request, options, finish: text => gate.resolve(prefix + text) });
            options.onText(prefix + '正在生成的片段');
            return gate.promise;
        } }),
    });
    await service.ensureChat(saved.id);
    t.after(async () => {
        for (const release of cleanup) release();
        service.stopAll();
        for (const call of calls) call.finish('测试清理');
        await Promise.allSettled(tasks);
    });
    const start = async operation => {
        const count = calls.length, task = operation();
        tasks.push(task); task.catch(() => {});
        await until(() => calls.length > count);
        return { task, call: calls.at(-1) };
    };
    return { ...files, service, calls, cleanup, start, id: saved.id, oldId: saved.results[0].id };
}

async function generating(f, chatMode = false) {
    const chat = await f.service.getChat(f.id), message = chat.messages[1];
    const running = await f.start(() => chatMode ? f.service.generateChatVersion(f.id, message.id) : f.service.generateAnother(f.id));
    await f.service.setMessageVersion(f.id, message.id, f.oldId, running.call.id);
    return running;
}

test('同一状态的演出和聊天目标使用相同规则，准备、生成、重试均可回看已保存版本', async t => {
    const f = await fixture(t), running = await generating(f);
    const expected = { choose: true, another: true, again: true, continue: true, favorite: true, edit: true, branch: false, remove: false };
    for (const status of ['preparing', 'generating', 'retry-wait', 'unfinished']) {
        const chat = await f.service.getChat(f.id), message = chat.messages[1];
        message.results.find(result => result.id === running.call.id).status = status;
        for (const [action, allowed] of Object.entries(expected)) {
            const targets = [{ chat, messageId: message.id, resultId: f.oldId }, { round: playStartRound(chat), resultId: f.oldId }];
            for (const target of targets) assert.equal(getPlayActionPermission(action, target).available, allowed, status + ' ' + action);
        }
    }
    running.call.options.onText('隐藏版本仍在生成');
    assert.equal((await f.service.getChat(f.id)).messages[1].selectedResultId, f.oldId);
    running.call.finish('版本二完成');
    await running.task;
    const saved = await f.store.getChat(f.id);
    assert.equal(saved.messages[1].selectedResultId, f.oldId);
    assert.equal(saved.messages[1].results.find(result => result.id === running.call.id).text, '版本二完成');
});

for (const [name, action] of [['新增版本', 'another'], ['重新生成旧版本', 'regenerate'], ['续写旧版本', 'continue']]) {
    for (const chatMode of [false, true]) test((chatMode ? '聊天' : '演出') + name + '与另一个版本并行，分别保存且不覆盖隐藏版本', async t => {
        const f = await fixture(t), running = await generating(f, chatMode), chat = await f.service.getChat(f.id), message = chat.messages[1];
        const next = await f.start(() => {
            if (action === 'another') return chatMode ? f.service.generateChatVersion(f.id, message.id) : f.service.generateAnother(f.id);
            if (action === 'regenerate') return chatMode ? f.service.regenerateChat(f.id, message.id, f.oldId) : f.service.regenerate(f.id, f.oldId);
            return chatMode ? f.service.continueChat(f.id, message.id, f.oldId) : f.service.continueResult(f.id, f.oldId);
        });
        assert.equal(f.service.getStates().length, 2);
        await assert.rejects(f.service.regenerate(f.id, running.call.id), { code: 'busy' });
        await assert.rejects(f.service.continueChat(f.id, message.id, running.call.id), { code: 'busy' });
        next.call.finish('另一个操作完成');
        const completed = await next.task;
        assert.equal(completed.result.status, 'complete');
        assert.equal(f.service.getStates().length, 1);
        running.call.finish('隐藏版本最后完成');
        await running.task;
        const saved = await f.store.getChat(f.id), results = saved.messages[1].results;
        assert.equal(results.find(result => result.id === running.call.id).text, '隐藏版本最后完成');
        assert.equal(results.find(result => result.id === next.call.id).text,
            action === 'continue' ? '版本一已保存的正文另一个操作完成' : '另一个操作完成');
        assert.ok(results.every(result => result.status === 'complete'));
    });
}

for (const chatMode of [false, true]) test((chatMode ? '聊天' : '演出') + '可编辑和收藏旧版本，正在生成的版本不受影响', async t => {
    const f = await fixture(t), running = await generating(f, chatMode), chat = await f.service.getChat(f.id), message = chat.messages[1];
    const update = { text: '已编辑并保存的旧版本', expectedText: '版本一已保存的正文', resultId: f.oldId };
    if (chatMode) await f.service.editMessage(f.id, message.id, update);
    else await f.service.editResult(f.id, f.oldId, update.text, update.expectedText);
    await f.service.session.flush(f.id);
    assert.equal(f.service.getState(running.call.id).text, '正在生成的片段');
    const old = (await f.service.getChat(f.id)).messages[1].results.find(result => result.id === f.oldId);
    const favorite = await f.service.addFavorite({ roundId: f.id, messageId: message.id, resultId: f.oldId,
        startedAt: old.startedAt, expectedText: old.text, firstLine: old.text });
    assert.equal(favorite.text, update.text);
    await assert.rejects(f.service.editMessage(f.id, message.id,
        { text: '禁止修改', expectedText: '', resultId: running.call.id }), { code: 'busy' });
    assert.throws(() => f.service.addChatFavorite({ chatId: f.id }), { code: 'busy' });
    await assert.rejects(f.service.createBranch(f.id, message.id), { code: 'busy' });
    running.call.finish('版本二完成');
    await running.task;
    const saved = await f.store.getChat(f.id);
    assert.equal(saved.messages[1].results.find(result => result.id === f.oldId).text, update.text);
    const branch = await f.service.createBranch(f.id, message.id);
    assert.deepEqual(branch.messages[1].results.map(result => result.text), saved.messages[1].results.map(result => result.text));
    assert.notEqual(branch.messages[1].results[0].id, f.oldId);
});

for (const chatMode of [false, true]) test((chatMode ? '聊天' : '演出') + '消息删除保护全部 AI 版本，删除用户消息不取消已启动的生成', async t => {
    const f = await fixture(t), running = await generating(f, chatMode), chat = await f.service.getChat(f.id), message = chat.messages[1];
    await assert.rejects(f.service.removeReply(f.id, message.results), { code: 'busy' });
    await assert.rejects(f.service.removeMessage(f.id, message.id), { code: 'busy' });
    assert.throws(() => f.service.deleteChat(f.id), { code: 'busy' });
    assert.throws(() => f.service.truncateChat(f.id, message.id), { code: 'busy' });
    if (chatMode) await f.service.removeMessage(f.id, chat.messages[0].id);
    else await f.service.removePrompt(f.id, chat.messages[0].text);
    assert.equal(f.service.getStates().length, 1);
    assert.equal(running.call.request.prompt, chat.messages[0].text);
    running.call.finish('用户消息删除后生成完成');
    await running.task;
    const saved = await f.store.getChat(f.id);
    assert.equal(saved.messages.some(message => message.role === 'user'), false);
    assert.equal(saved.messages[0].results.find(result => result.id === running.call.id).text, '用户消息删除后生成完成');
    assert.equal(saved.messages[0].results.find(result => result.id === f.oldId).text, '版本一已保存的正文');
});

test('生成完成但尚未保存时只保护该版本，保存确认后两种目标同时恢复操作', async t => {
    const f = await fixture(t), running = await generating(f), entered = deferred(), release = deferred();
    f.cleanup.push(() => release.resolve());
    f.io.beforeWrite = async name => { if (name === PLAY_HISTORY_INDEX) { entered.resolve(); await release.promise; } };
    running.call.finish('等待保存确认的版本二');
    await entered.promise;
    assert.equal(f.service.getStates().length, 0);
    const chat = await f.service.getChat(f.id), message = chat.messages[1], round = playStartRound(chat);
    for (const target of [{ chat, messageId: message.id }, { round }]) {
        for (const action of ['choose', 'edit', 'favorite']) assert.equal(f.service.getActionPermission(action, { ...target, resultId: f.oldId }).available, true);
        for (const action of ['edit', 'favorite', 'again', 'continue']) assert.equal(f.service.getActionPermission(action, { ...target, resultId: running.call.id }).available, false);
        assert.equal(f.service.getActionPermission('branch', target).available, false);
    }
    await assert.rejects(f.service.editResult(f.id, running.call.id, '不能提前写入', '等待保存确认的版本二'), { code: 'busy' });
    release.resolve();
    await running.task;
    for (const target of [{ chat: await f.service.getChat(f.id), messageId: message.id }, { round: f.service.session.currentRound(f.id) }]) {
        assert.equal(f.service.getActionPermission('edit', { ...target, resultId: running.call.id }).available, true);
        assert.equal(f.service.getActionPermission('branch', target).available, true);
    }
});

for (const chatMode of [false, true]) test((chatMode ? '聊天' : '演出') + '保存失败后允许编辑补存，生成和复制仍保护尚未保存的版本', async t => {
    const f = await fixture(t), running = await generating(f, chatMode), events = [];
    f.service.subscribe(event => {
        if (event.type === 'save-error') events.push(f.service.getActionPermission('edit', { chatId: f.id, resultId: running.call.id }).available);
    });
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟保存失败'); };
    running.call.finish('尚未保存的版本二');
    await running.task;
    assert.deepEqual(events, [true]);
    const chat = await f.service.getChat(f.id), message = chat.messages[1];
    for (const target of [{ chat, messageId: message.id }, { round: playStartRound(chat) }]) {
        assert.equal(f.service.getActionPermission('edit', { ...target, resultId: running.call.id }).available, true);
        for (const action of ['again', 'continue', 'favorite', 'branch', 'remove']) {
            assert.equal(f.service.getActionPermission(action, { ...target, resultId: running.call.id }).available, false);
        }
    }
    f.io.beforeWrite = null;
    if (chatMode) await f.service.editMessage(f.id, message.id, { resultId: running.call.id,
        text: '补存并修正的版本二', expectedText: '尚未保存的版本二' });
    else await f.service.editResult(f.id, running.call.id, '补存并修正的版本二', '尚未保存的版本二');
    await f.service.session.flush(f.id);
    const saved = await f.store.getChat(f.id);
    assert.equal(saved.messages[1].results.find(result => result.id === running.call.id).text, '补存并修正的版本二');
    assert.equal(saved.messages[1].results.find(result => result.id === f.oldId).text, '版本一已保存的正文');
    assert.equal(f.calls.length, 1);
});
