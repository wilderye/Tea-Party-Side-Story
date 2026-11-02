import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlayground } from '../playground.js';
import { memoryFiles, characterA, characterB, deferred, time } from './play-fixture.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await turn();
    }
    assert.fail('Expected task state did not arrive');
}

function fixture(t, prepare) {
    const f = memoryFiles(), calls = new Map(), events = [];
    let tick = 0;
    const service = createPlayground({ history: f.store, uuid: randomUUID, now: () => time(tick++),
        captureEnvironment: ({ character = characterA } = {}) => ({ character, chat: [],
            context: { chatId: `${character.avatar}-chat`, apiMode: 'tavern', characterName: character.name },
            api: { mode: 'tavern', key: 'synthetic-private-key' } }),
        isCurrent: () => true,
        prepareRequest: async request => {
            await prepare?.(request);
            return { send: async options => {
                const gate = deferred();
                calls.set(request.generationId, { request, options, gate });
                options.onText(`片段：${request.prompt}`);
                return gate.promise;
            } };
        },
    });
    service.subscribe(state => events.push(state));
    t.after(async () => {
        for (const state of service.getStates()) service.stop(state.resultId);
        for (const call of calls.values()) call.gate.resolve('清理后的回复');
        await turn();
    });
    return { ...f, service, calls, events };
}

async function completed(f, prompt = '原来的提示词') {
    const task = f.service.send({ prompt });
    const id = f.service.getState().resultId;
    await until(() => f.calls.has(id));
    f.calls.get(id).gate.resolve('原来的完整回复');
    return task;
}

test('十二份跨角色请求同时发送，单独停止不影响其余请求及保存', { timeout: 5000 }, async t => {
    const f = fixture(t);
    const tasks = Array.from({ length: 12 }, (_, i) => f.service.send({
        character: i % 2 ? characterB : characterA, prompt: `提示词${i}`,
    }));
    await until(() => f.calls.size === 12);
    assert.equal(f.service.getStates().length, 12);
    assert.equal(f.service.availability().available, true);
    assert.equal(f.service.stop(), false, '未指定回复时，不猜测停止哪一份并发任务');
    const calls = [...f.calls.entries()];
    assert.equal(f.service.stop(calls[0][0]), true);
    assert.equal(calls[0][1].options.signal.aborted, true);
    for (const [, call] of calls.slice(1)) assert.equal(call.options.signal.aborted, false);
    const stopped = await tasks[0];
    assert.equal(stopped.result.status, 'stopped');
    assert.equal(stopped.result.text, '片段：提示词0');
    for (const [, call] of [...calls].reverse()) call.gate.resolve(`完成：${call.request.prompt}`);
    const results = await Promise.all(tasks);
    assert.equal(f.service.getStates().length, 0);
    for (let i = 0; i < results.length; i++) {
        const saved = await f.store.getRound(results[i].roundId);
        assert.equal(saved.prompt, `提示词${i}`);
        assert.equal(saved.results[0].context.characterName, i % 2 ? characterB.name : characterA.name);
        assert.equal(saved.results[0].text, i ? `完成：提示词${i}` : '片段：提示词0');
    }
    assert.equal(new Set(f.events.filter(event => event.phase === 'idle' && event.resultId).map(event => event.resultId)).size, 12);
    assert.ok([...f.files.values()].every(text => !text.includes('synthetic-private-key')));
});

test('停止全部同时取消生成和准备中的请求，保留已完成回复及收到的片段', { timeout: 5000 }, async t => {
    const preparing = deferred();
    const f = fixture(t, request => request.prompt === '准备中的请求' ? preparing.promise : undefined);
    const first = await completed(f);
    const running = f.service.send({ prompt: '生成中的请求' });
    const waiting = f.service.send({ character: characterB, prompt: '准备中的请求' });
    await until(() => f.calls.size === 2 && f.service.getStates().some(job => job.phase === 'preparing' && job.roundId));
    assert.equal(f.service.stopAll(), 2);
    const [stopped, cancelled] = await Promise.all([running, waiting]);
    assert.equal(stopped.result.status, 'stopped');
    assert.equal(stopped.result.text, '片段：生成中的请求');
    assert.equal(cancelled.result.status, 'stopped');
    preparing.resolve(); await turn();
    assert.equal(f.calls.size, 2, '迟到的准备结果不会发送到模型');
    assert.equal((await f.store.getRound(first.roundId)).results[0].text, '原来的完整回复');
    assert.equal((await f.store.getRound(first.roundId)).results[0].status, 'complete');
    assert.equal(f.service.stopAll(), 0);
});

test('停止全部不取消已经结束生成的保存，保存失败也不算正在生成', { timeout: 5000 }, async t => {
    const f = fixture(t), saving = deferred();
    const saveResult = f.store.saveResult.bind(f.store);
    f.store.saveResult = async (roundId, resultId, update) => {
        if (update.text === '等待保存的完整回复') await saving.promise;
        return saveResult(roundId, resultId, update);
    };
    const first = f.service.send({ prompt: '第一份' });
    const firstId = f.service.getState().resultId;
    const second = f.service.send({ character: characterB, prompt: '第二份' });
    await until(() => f.calls.size === 2);
    f.calls.get(firstId).gate.resolve('等待保存的完整回复');
    await until(() => f.service.getState(firstId).phase === 'idle' && f.service.session.hasUnsaved());
    assert.equal(f.service.stopAll(), 1);
    assert.equal(f.calls.get(firstId).options.signal.aborted, false);
    assert.equal((await second).result.status, 'stopped');
    saving.resolve();
    assert.equal((await first).result.status, 'complete');

    f.store.saveResult = () => { throw new Error('模拟保存失败'); };
    const failed = f.service.send({ prompt: '保存失败的请求' }).catch(error => error);
    await until(() => f.calls.size === 3);
    const [failedId, failedCall] = [...f.calls.entries()].at(-1);
    failedCall.gate.resolve('已完成但保存失败的正文');
    const failedResult = await failed;
    assert.equal(failedResult.result.status, 'complete');
    assert.equal(f.service.stopAll(), 0);
    assert.equal(f.service.getState(failedId).phase, 'idle');
    assert.equal(f.service.session.currentRound(failedResult.roundId).results[0].text, '已完成但保存失败的正文');
    f.store.saveResult = saveResult;
    await f.service.session.flush(failedResult.roundId);
});

test('同一轮重新生成和新增版本并发，倒序完成也保持各自位置和正文', { timeout: 5000 }, async t => {
    const f = fixture(t), first = await completed(f);
    const tasks = [f.service.regenerate(first.roundId, first.result.id),
        ...Array.from({ length: 3 }, () => f.service.generateAnother(first.roundId))];
    await until(() => f.calls.size === 5);
    await assert.rejects(f.service.regenerate(first.roundId, first.result.id), { code: 'busy' });
    const before = await f.service.getRound(first.roundId);
    assert.equal(before.results.length, 4);
    const ids = before.results.map(result => result.id);
    for (const id of ids) {
        await assert.rejects(f.service.regenerate(first.roundId, id), { code: 'busy' });
        await assert.rejects(f.service.continueResult(first.roundId, id), { code: 'busy' });
    }
    for (const id of [...ids].reverse()) f.calls.get(id).gate.resolve(`结果：${id}`);
    await Promise.all(tasks);
    const saved = await f.createStore().getRound(first.roundId);
    assert.deepEqual(saved.results.map(result => result.id), ids);
    assert.deepEqual(saved.results.map(result => result.text), ids.map(id => `结果：${id}`));
    assert.ok(saved.results.every(result => result.status === 'complete'));
    assert.equal(f.service.getStates().length, 0);
});

test('同一轮单独停止和保存失败不丢失其他版本，补存不重复请求模型', { timeout: 5000 }, async t => {
    const f = fixture(t), first = await completed(f);
    const stoppedTask = f.service.regenerate(first.roundId, first.result.id);
    const completedTask = f.service.generateAnother(first.roundId);
    await until(() => f.calls.size === 3);
    const [[stoppedId, stoppedCall], [completedId, completedCall]] = [...f.calls].slice(1);
    const save = f.store.saveResult.bind(f.store);
    let failSave = true;
    f.store.saveResult = (...args) => {
        if (failSave && args[1] === stoppedId) throw Error('模拟单个版本保存失败');
        return save(...args);
    };
    f.service.stop(stoppedId);
    const stopped = await stoppedTask;
    assert.equal(stopped.result.status, 'stopped');
    assert.equal(completedCall.options.signal.aborted, false);
    stoppedCall.options.onText('停止后迟到的片段'); stoppedCall.gate.resolve('停止后迟到的终稿');
    completedCall.options.onText('另一版本继续生成');
    completedCall.gate.resolve('另一版本的完整正文');
    await completedTask;
    const current = f.service.session.currentRound(first.roundId);
    assert.deepEqual(current.results.map(result => [result.id, result.status, result.text]), [
        [stoppedId, 'stopped', '片段：原来的提示词'], [completedId, 'complete', '另一版本的完整正文'],
    ]);
    assert.equal(f.service.session.hasUnsaved(), true);
    assert.equal(f.service.getStates().length, 0);
    failSave = false;
    await f.service.session.flush(first.roundId);
    const saved = await f.createStore().getRound(first.roundId);
    assert.deepEqual(saved.results.map(result => [result.id, result.status, result.text]),
        current.results.map(result => [result.id, result.status, result.text]));
    assert.equal(f.service.session.hasUnsaved(), false);
    assert.equal(f.calls.size, 3);
});

test('续写读取和准备期间只锁对应版本，停止后迟到准备不会发送', { timeout: 5000 }, async t => {
    const waits = new Map();
    let held = false;
    const f = fixture(t, async request => {
        if (!held) return;
        const gate = deferred(); waits.set(request.generationId, gate);
        await gate.promise;
    });
    const first = await completed(f);
    held = true;
    const a = f.service.continueResult(first.roundId, first.result.id);
    const b = f.service.send({ character: characterB, prompt: '另一角色继续生成' });
    await until(() => waits.size === 2);
    assert.equal(f.service.availability({ resultId: first.result.id }).available, false);
    assert.equal(f.service.availability().available, true);
    await assert.rejects(f.service.regenerate(first.roundId, first.result.id), error => error.code === 'busy');
    f.service.stop(first.result.id);
    assert.equal((await a).result.status, 'stopped');
    for (const gate of waits.values()) gate.resolve();
    await until(() => f.calls.size === 2);
    const other = [...f.calls.values()].find(call => call.request.prompt === '另一角色继续生成');
    other.gate.resolve('另一角色完成');
    assert.equal((await b).result.status, 'complete');
    assert.equal(f.calls.size, 2, '原始完成请求和另一角色请求，停止的续写没有发送');
});

test('多份保存失败彼此独立，编辑补存分别完成，不请求模型', async t => {
    const f = fixture(t), failedIds = new Set(), save = f.store.saveResult.bind(f.store);
    f.store.saveResult = (...args) => { if (failedIds.has(args[1])) throw Error('save failed'); return save(...args); };
    const tasks = [f.service.send({ prompt: '第一份' }), f.service.send({ prompt: '第二份' })];
    await until(() => f.calls.size === 2);
    for (const [id, call] of f.calls) { failedIds.add(id); call.gate.resolve(`完整：${call.request.prompt}`); }
    const results = await Promise.all(tasks); assert.equal(f.service.getStates().length, 0);
    failedIds.clear();
    for (const result of results) { await f.service.editResult(result.roundId, result.result.id, result.result.text, result.result.text); await f.service.session.flush(result.roundId); }
    assert.equal(f.calls.size, 2); assert.equal(f.service.session.hasUnsaved(), false);
});

test('修改同一轮提示词时返回所有任务的实时内容，后续保存保留修改', { timeout: 5000 }, async t => {
    const f = fixture(t), first = await completed(f);
    const tasks = [f.service.generateAnother(first.roundId), f.service.generateAnother(first.roundId)];
    await until(() => f.calls.size === 3);
    const current = await f.service.editPrompt(first.roundId, '修改后的提示词', '原来的提示词');
    assert.equal(current.prompt, '修改后的提示词');
    assert.deepEqual(current.results.slice(1).map(result => result.text), ['片段：原来的提示词', '片段：原来的提示词']);
    for (const [id, call] of [...f.calls].slice(1)) call.gate.resolve(`完整：${id}`);
    await Promise.all(tasks);
    assert.equal((await f.store.getRound(first.roundId)).prompt, '修改后的提示词');
});
