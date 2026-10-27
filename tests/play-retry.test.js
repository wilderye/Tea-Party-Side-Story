import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createPlayground } from '../playground.js';
import { createPreparedPlayRequest } from '../play-request.js';
import { createDiagnostics } from '../diagnostics.js';
import { PLAY_HISTORY_INDEX } from '../play-history.js';
import { characterA, contextA, memoryFiles, deferred, mockPlayContext, streamResponse, testStreaming } from './play-fixture.js';

const config = overrides => ({ rateLimit: true, empty: true, maxRetries: 3, intervalSeconds: 0, ...overrides });
const apiError = (status = 429) => Response.json({ error: { message: 'original failure', code: status } }, { status });
const reply = text => Response.json({ text });

function fixture(t, respond, { retry = config(), stream = false, apiMode = 'tavern', checkpointMs = 0 } = {}) {
    const io = memoryFiles(), calls = [], prepared = [];
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const environment = { character: characterA, context: { ...contextA, apiMode }, independent: true, retry,
        api: { mode: apiMode, key: 'synthetic-secret' }, tavern: { settings: {} } };
    const payload = { messages: [{ role: 'user', content: 'private synthetic prompt' }], model: 'synthetic-model',
        chat_completion_source: apiMode === 'custom' ? 'custom' : 'openai', temperature: 0.7, stream };
    const context = mockPlayContext(t, async (data, signal, options) => {
        calls.push({ body: options.body, signal, at: Date.now() });
        return respond(calls.length, { data, signal, environment, payload, io });
    }, data => data.text);
    const service = createPlayground({ history: io.store, captureEnvironment: () => environment, isCurrent: () => true,
        diagnostics, uuid: randomUUID, checkpointMs,
        prepareRequest: async request => {
            prepared.push(request);
            return createPreparedPlayRequest(context, payload, { streaming: testStreaming,
                prefix: request.continueMessage, continueExtra: request.continueExtra,
                reasoning: { extractReasoningFromData: data => data.thought || '' } });
        } });
    return { ...io, calls, prepared, diagnostics, service, environment, payload };
}

for (const stream of [false, true]) for (const apiMode of ['tavern', 'custom']) {
    test(`429后空内容再成功，顺序沿用同一请求且只保留一个结果：${apiMode} 流式=${stream}`, async t => {
        const f = fixture(t, (attempt, { environment, payload }) => {
            if (attempt === 1) {
                environment.retry.maxRetries = 0;
                environment.retry.rateLimit = false;
                payload.model = 'later-model'; payload.messages[0].content = 'later prompt';
                return apiError();
            }
            if (attempt === 2) return stream
                ? streamResponse([{ choices: [{ delta: { reasoning_content: 'discarded thought' } }], signature: 'discarded' }, '[DONE]'])
                : Response.json({ text: null, thought: 'discarded thought' });
            return stream ? streamResponse([{ choices: [{ delta: { content: '最终正文' } }] }, '[DONE]']) : reply('最终正文');
        }, { stream, apiMode });
        const states = []; f.service.subscribe(state => states.push(state));
        const result = await f.service.send({ prompt: 'private synthetic prompt' });
        assert.equal(f.calls.length, 3); assert.equal(f.prepared.length, 1);
        assert.ok(f.calls.every(call => call.body === f.calls[0].body));
        assert.equal(result.result.text, '最终正文'); assert.equal(result.result.status, 'complete');
        assert.equal(result.result.extra.reasoning, '');
        assert.deepEqual(states.filter(state => state.phase === 'retry-wait').map(state => state.retry.reason), ['rateLimit', 'empty']);
        const saved = await f.createStore().getRound(result.roundId);
        assert.equal(saved.results.length, 1); assert.equal(saved.results[0].id, result.result.id);
        const entries = f.diagnostics.read().entries;
        assert.equal(entries.filter(entry => entry.error).length, 2);
        assert.match(f.diagnostics.export(), /开始第 2\/3 次自动重试/);
        assert.doesNotMatch(f.diagnostics.export(), /private synthetic prompt|最终正文|discarded thought|synthetic-secret/);
        assert.ok(entries.findIndex(entry => entry.error) < entries.findIndex(entry => entry.operation.startsWith('将在')));
    });
}

test('默认关闭、单独开关和0次限制均按选择生效，未选中的失败立即结束', async t => {
    for (const [retry, type, expected] of [
        [undefined, '429', 1], [undefined, 'empty', 1],
        [config({ rateLimit: false }), '429', 1], [config({ empty: false }), 'empty', 1],
        [config({ empty: false }), '429', 4], [config({ rateLimit: false }), 'empty', 4],
        [config({ maxRetries: 0 }), '429', 1], [config({ maxRetries: 0 }), 'empty', 1],
    ]) {
        const f = fixture(t, () => type === '429' ? apiError() : reply(''), { retry: retry ?? null });
        const result = await f.service.send({ prompt: '测试开关' });
        assert.equal(f.calls.length, expected);
        assert.equal(result.result.status, 'failed');
        if (expected > 1) assert.match(result.result.error.message, /已自动重试 3 次/);
    }
});

test('429与空内容交替出现共用3次上限，最后一个原始错误与已重试次数保存到同一结果', async t => {
    const f = fixture(t, attempt => attempt % 2 ? apiError() : reply(' \n\t'));
    const result = await f.service.send({ prompt: '交替失败' });
    assert.equal(f.calls.length, 4);
    assert.equal(result.result.error.code, 'empty_response');
    assert.match(result.result.error.message, /已自动重试 3 次/);
    assert.equal(f.diagnostics.read().entries.filter(entry => entry.error).length, 4);
    assert.equal((await f.createStore().getRound(result.roundId)).results.length, 1);
});

test('明确的HTTP200流内429错误可重试，错误说明提到429、网络断流和其他HTTP错误不重试', async t => {
    for (const detail of [{ error: { code: 429 } }, { detail: { error: { status_code: '429' } } }, { error: { statusCode: 429 } }]) {
        const f = fixture(t, attempt => attempt === 1 ? streamResponse([detail, '[DONE]'])
            : streamResponse([{ choices: [{ delta: { content: '成功' } }] }, '[DONE]']), { stream: true });
        assert.equal((await f.service.send({ prompt: '流内429' })).result.status, 'complete');
        assert.equal(f.calls.length, 2);
    }
    for (const respond of [
        () => Response.json({ error: { message: 'text mentions 429', code: 'not_a_rate_limit' } }),
        () => apiError(401), () => apiError(500),
        () => { throw new TypeError('network unavailable'); },
        () => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
        const f = fixture(t, respond);
        assert.equal((await f.service.send({ prompt: '不符合重试条件' })).result.status, 'failed');
        assert.equal(f.calls.length, 1);
    }
    const f = fixture(t, () => streamResponse([]), { stream: true });
    assert.equal((await f.service.send({ prompt: '异常断流' })).result.error.code, 'stream_interrupted');
    assert.equal(f.calls.length, 1);
});

test('空HTTP响应重试，正文被隐藏标签包裹仍算有内容', async t => {
    const f = fixture(t, attempt => attempt === 1 ? new Response(' \n') : reply('<think>有原文</think>'));
    const result = await f.service.send({ prompt: '空响应' });
    assert.equal(f.calls.length, 2); assert.equal(result.result.text, '<think>有原文</think>');
    assert.equal(result.result.status, 'complete');
});

test('收到部分正文后遇到429也不重试，保留正文和原始错误', async t => {
    const f = fixture(t, () => streamResponse([
        { choices: [{ delta: { content: '半篇正文' } }] }, { error: { code: 429, message: 'partial rate limit' } }, '[DONE]',
    ]), { stream: true });
    const result = await f.service.send({ prompt: '保留半篇' });
    assert.equal(f.calls.length, 1); assert.equal(result.result.text, '半篇正文');
    assert.equal(result.result.status, 'failed'); assert.equal(result.result.error.message, 'partial rate limit');
});

test('续写空增量会重试；每次都从原正文续写，旧正文不算本次已收内容，也不重复追加', async t => {
    const f = fixture(t, attempt => attempt === 1 ? reply('原正文') : attempt === 2 ? apiError()
        : attempt === 3 ? Response.json({ text: '', thought: 'discarded thought' }) : reply('新增正文'));
    const first = await f.service.send({ prompt: '续写测试' });
    const continued = await f.service.continueResult(first.roundId, first.result.id);
    assert.equal(f.calls.length, 4); assert.equal(f.prepared.length, 2);
    assert.equal(continued.result.text, '原正文新增正文');
    assert.equal(continued.result.extra.reasoning, '');
    const round = await f.createStore().getRound(first.roundId);
    assert.equal(round.results.length, 1); assert.equal(round.results[0].id, first.result.id);
    assert.ok(f.calls.slice(1).every(call => call.body === f.calls[1].body));
});

test('重新生成的自动重试只替换所选结果，生成新剧场的重试也只新增一个结果', async t => {
    const f = fixture(t, attempt => [2, 4].includes(attempt) ? apiError() : reply(`正文${attempt}`));
    const first = await f.service.send({ prompt: '测试版本' });
    const replacement = await f.service.regenerate(first.roundId, first.result.id);
    assert.equal(replacement.result.text, '正文3');
    await f.service.generateAnother(first.roundId);
    const round = await f.createStore().getRound(first.roundId);
    assert.deepEqual(round.results.map(result => result.text), ['正文3', '正文5']);
    assert.equal(f.prepared.length, 3); assert.equal(f.calls.length, 5);
});

test('间隔从失败结束后开始且每次固定，等待期间不能编辑结果、不能重复重生成', async t => {
    const failureTimes = [], waiting = deferred();
    const f = fixture(t, async attempt => {
        if (attempt < 3) { await delay(20); failureTimes.push(Date.now()); return apiError(); }
        return reply('成功');
    }, { retry: config({ intervalSeconds: 0.04 }) });
    f.service.subscribe(state => { if (state.phase === 'retry-wait') waiting.resolve(state); });
    const task = f.service.send({ prompt: '间隔测试' }), state = await waiting.promise;
    assert.equal(f.service.availability({ resultId: state.resultId }).code, 'busy');
    await assert.rejects(f.service.editResult(state.roundId, state.resultId, '不能编辑', state.text), /生成或保存/);
    await assert.rejects(f.service.regenerate(state.roundId, state.resultId), /等待或停止/);
    await task;
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls[1].at - failureTimes[0] >= 35);
    assert.ok(f.calls[2].at - failureTimes[1] >= 35);
});

test('等待期间停止立即取消倒计时，间隔结束后也不发出下一次；下次任务仍可正常发送', async t => {
    const waiting = deferred();
    const f = fixture(t, attempt => attempt === 1 ? apiError() : reply('新任务成功'), { retry: config({ intervalSeconds: 0.04 }) });
    f.service.subscribe(state => { if (state.phase === 'retry-wait') waiting.resolve(state); });
    const task = f.service.send({ prompt: '等待期间停止' }), state = await waiting.promise;
    assert.equal(f.service.stop(state.resultId), true);
    assert.equal((await task).result.status, 'stopped');
    await delay(65);
    assert.equal(f.calls.length, 1); assert.equal(f.service.getState().phase, 'idle');
    assert.equal((await f.service.send({ prompt: '下次正常发送' })).result.text, '新任务成功');
});

test('停止所有生成包含多份等待重试的回复，每份均不再发送', async t => {
    const waiting = deferred(), ids = new Set();
    const f = fixture(t, () => apiError(), { retry: config({ intervalSeconds: 0.04 }) });
    f.service.subscribe(state => { if (state.phase === 'retry-wait') { ids.add(state.resultId); if (ids.size === 2) waiting.resolve(); } });
    const tasks = [f.service.send({ prompt: '第一份' }), f.service.send({ prompt: '第二份' })];
    await waiting.promise; assert.equal(f.service.stopAll(), 2);
    assert.deepEqual((await Promise.all(tasks)).map(item => item.result.status), ['stopped', 'stopped']);
    await delay(65); assert.equal(f.calls.length, 2);
});

test('重试请求已经发出后停止会中断该连接，不再发送后续重试', async t => {
    const started = deferred(); let activeSignal;
    const f = fixture(t, (attempt, { signal }) => {
        if (attempt === 1) return apiError();
        activeSignal = signal; started.resolve();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const task = f.service.send({ prompt: '停止已经发送的重试' });
    await started.promise; f.service.stop();
    assert.equal((await task).result.status, 'stopped');
    assert.equal(activeSignal.aborted, true); assert.equal(f.calls.length, 2);
});

test('失败请求的迟到回调不能覆盖正在重试的正文，主动取消也不触发重试', async () => {
    const io = memoryFiles(), firstFinished = deferred(), release = deferred();
    let sends = 0, oldCallbacks;
    const environment = { character: characterA, context: contextA, retry: config() };
    const service = createPlayground({ history: io.store, captureEnvironment: () => environment, isCurrent: () => true, checkpointMs: 0,
        prepareRequest: async () => ({ send: async options => {
            sends++;
            if (sends === 1) { oldCallbacks = options; throw Object.assign(new Error('429'), { status: 429 }); }
            options.onText('新正文'); firstFinished.resolve(); await release.promise; return '新正文';
        } }) });
    const task = service.send({ prompt: '迟到回调' });
    await firstFinished.promise;
    oldCallbacks.onText('旧请求迟到正文'); oldCallbacks.onReasoning({ reasoning: '旧请求迟到思维链' });
    assert.equal(service.getState().text, '新正文');
    release.resolve(); const result = await task;
    assert.equal(result.result.text, '新正文'); assert.deepEqual(result.result.extra, {});
    let abortCalls = 0;
    const cancelled = createPlayground({ history: memoryFiles().store, captureEnvironment: () => environment, isCurrent: () => true,
        prepareRequest: async () => ({ send: async () => { abortCalls++; throw new DOMException('cancelled', 'AbortError'); } }) });
    assert.equal((await cancelled.send({ prompt: '主动取消' })).result.status, 'stopped');
    assert.equal(abortCalls, 1);
});

test('流式续写收到新增正文后遇到429不重试，原正文与已收增量都保留', async t => {
    const f = fixture(t, attempt => attempt === 1
        ? streamResponse([{ choices: [{ delta: { content: '原正文' } }] }, '[DONE]'])
        : streamResponse([{ choices: [{ delta: { content: '新增半篇' } }] }, { error: { code: 429, message: 'partial429' } }]), { stream: true });
    const first = await f.service.send({ prompt: '流式续写部分失败' });
    const continued = await f.service.continueResult(first.roundId, first.result.id);
    assert.equal(f.calls.length, 2); assert.equal(continued.result.text, '原正文新增半篇');
    assert.equal(continued.result.status, 'failed'); assert.equal(continued.result.error.message, 'partial429');
});

test('回复保存失败只重试保存，不再次请求模型；准备阶段429也不属于模型自动重试', async t => {
    const f = fixture(t, (_attempt, { io }) => { io.io.beforeWrite = () => { throw Error('save failed'); }; return reply('保留正文'); });
    await assert.rejects(f.service.send({ prompt: '保存失败' }), /save failed/);
    assert.equal(f.calls.length, 1);
    f.io.beforeWrite = null; await f.service.retrySave(); assert.equal(f.calls.length, 1);
    const files = memoryFiles(); let preparations = 0;
    const service = createPlayground({ history: files.store, captureEnvironment: () => f.environment, isCurrent: () => true,
        prepareRequest: async () => { preparations++; throw Object.assign(new Error('prepare429'), { status: 429 }); } });
    assert.equal((await service.send({ prompt: '准备错误' })).result.status, 'failed');
    assert.equal(preparations, 1);
});

test('慢速思维链保存完成后才开始下一次，最终结果不保留上次空回复的思维链', async t => {
    const saved = deferred(), release = deferred(), firstDone = deferred();
    const f = fixture(t, async attempt => {
        if (attempt > 1) return streamResponse([{ choices: [{ delta: { content: '成功正文' } }] }, '[DONE]']);
        return streamResponse([{ choices: [{ delta: { reasoning_content: 'discarded thought' } }] }, '[DONE]']);
    }, { stream: true, checkpointMs: 1, retry: config({ intervalSeconds: 0.03 }) });
    // A delayed checkpoint may already be running when the empty response is
    // discovered. Keep it pending past the retry interval.
    let held = false;
    f.io.beforeWrite = async (name, text) => {
        if (!held && name !== PLAY_HISTORY_INDEX && text.includes('discarded thought')) {
            held = true; saved.resolve(); await release.promise;
        }
    };
    f.service.subscribe(state => { if (state.phase === 'retry-wait') firstDone.resolve(); });
    const task = f.service.send({ prompt: '慢速保存' });
    await firstDone.promise; await saved.promise; await delay(45); assert.equal(f.calls.length, 1);
    release.resolve();
    const result = await task;
    assert.equal(result.result.extra.reasoning, '');
    assert.equal((await f.createStore().getRound(result.roundId)).results[0].extra.reasoning, '');
});
