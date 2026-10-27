import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparedPlayRequest, fetchCustomApiModels } from '../play-request.js';
import { testStreaming, streamResponse, mockPlayContext, deferred } from './play-fixture.js';
import { createDiagnostics } from '../diagnostics.js';

const data = () => ({ messages: [{ role: 'system', content: '已处理的当前预设' }, { role: 'user', content: '本次小剧场' }],
    model: 'test-model', chat_completion_source: 'custom', custom_url: 'https://example.invalid/v1',
    temperature: 0.8, stream: false });

test('同一份请求拒绝重叠发送，失败后的顺序重试会释放发送占用', async t => {
    const started = deferred(), finish = deferred(); let calls = 0;
    const ctx = mockPlayContext(t, async () => {
        calls++; if (calls > 1) return Response.json('成功');
        started.resolve(); await finish.promise;
        return Response.json({ error: 'rate limited' }, { status: 429 });
    }, value => value);
    const request = createPreparedPlayRequest(ctx, data()), first = request.send({});
    await started.promise;
    await assert.rejects(request.send({}), error => error.code === 'request_already_sending');
    assert.equal(calls, 1); finish.resolve();
    await assert.rejects(first, error => error.status === 429);
    assert.equal(await request.send({}), '成功'); assert.equal(calls, 2);
});

test('通过酒馆拉取独立 API 模型，不要求先选模型，也不改酒馆连接', async t => {
    const context = { getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' }),
        chatCompletionSettings: { custom_url: 'https://tavern.invalid/v1', custom_model: 'tavern-model' } };
    const api = { mode: 'custom', url: 'https://example.invalid/v1/chat/completions/', key: 'synthetic-test-key' };
    const before = structuredClone({ api, settings: context.chatCompletionSettings });
    const controller = new AbortController(); let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls++;
        assert.equal(url, '/api/backends/chat-completions/status');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-CSRF-Token'], 'test-token');
        assert.equal(options.signal, controller.signal);
        assert.deepEqual(JSON.parse(options.body), {
            chat_completion_source: 'custom', custom_url: 'https://example.invalid/v1',
            custom_include_headers: JSON.stringify({ Authorization: 'Bearer synthetic-test-key' }),
        });
        return Response.json({ data: [{ id: 'zeta-chat' }, { id: 'alpha-chat' }, { id: 'alpha-chat' }, null, {}, { id: 42 }, { id: ' ' }] });
    });
    assert.deepEqual(await fetchCustomApiModels(context, api, controller.signal), ['alpha-chat', 'zeta-chat']);
    assert.equal(calls, 1);
    assert.deepEqual({ api, settings: context.chatCompletionSettings }, before);
});

test('无密钥的模型拉取明确覆盖酒馆已保存的密钥', async t => {
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        assert.deepEqual(JSON.parse(JSON.parse(options.body).custom_include_headers), { Authorization: '' });
        return Response.json({ data: [] });
    });
    assert.deepEqual(await fetchCustomApiModels({ getRequestHeaders: () => ({}) }, { url: 'http://localhost:9000/v1', key: '' }), []);
});

test('无效地址和已经取消的模型拉取不发送请求', async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('不应发送请求'));
    const context = { getRequestHeaders: () => ({}) };
    for (const url of ['', 'not-a-url', 'ftp://example.invalid/v1']) {
        await assert.rejects(fetchCustomApiModels(context, { url }), error => error.code === 'invalid_api_url');
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchCustomApiModels(context, { url: 'https://example.invalid/v1' }, controller.signal), error => error.name === 'AbortError');
});

test('模型拉取区分请求错误、格式错误和空列表，保留返回的错误文字', async t => {
    let reply;
    t.mock.method(globalThis, 'fetch', async () => reply);
    const load = () => fetchCustomApiModels({ getRequestHeaders: () => ({}) }, { url: 'https://example.invalid/v1' });
    reply = new Response('', { status: 403, statusText: 'Forbidden' });
    await assert.rejects(load(), error => error.status === 403 && error.message === 'HTTP 403 Forbidden');
    for (const error of [true, 'upstream unavailable', { message: 'upstream unavailable' }]) {
        reply = Response.json({ error, data: { data: [] } });
        await assert.rejects(load(), result => {
            assert.equal(result.name, 'PlayApiError'); assert.deepEqual(result.error.error, error);
            return result.message === (error === true ? '接口返回错误，但没有提供错误说明。' : 'upstream unavailable');
        });
    }
    reply = Response.json({ data: {} });
    await assert.rejects(load(), error => error.code === 'invalid_model_list');
    reply = new Response('<html>not JSON</html>');
    await assert.rejects(load(), SyntaxError);
    reply = Response.json({ data: [] });
    assert.deepEqual(await load(), []);
});

test('模型列表读取中取消后，不返回迟到的结果', async t => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => {
        controller.abort(); return JSON.stringify({ data: [{ id: 'old-model' }] });
    } }));
    await assert.rejects(fetchCustomApiModels({ getRequestHeaders: () => ({}) },
        { url: 'https://example.invalid/v1' }, controller.signal), error => error.name === 'AbortError');
});

test('顺序重发保持第一次处理好的全部消息与参数，使用酒馆认证头，响应原文不执行', async t => {
    const calls = [];
    const raw = '<% globalThis.__playOutputExecuted = true %>\n<UpdateVariable>_.set("好感度",80)</UpdateVariable>';
    const ctx = mockPlayContext(t, async (payload, signal, options) => {
        calls.push({ payload, signal });
        assert.equal(options.headers['X-CSRF-Token'], 'synthetic-token');
        return Response.json({ choices: [{ message: { content: raw } }] });
    });
    const payload = data(), expected = structuredClone(payload);
    const request = createPreparedPlayRequest(ctx, payload);
    payload.messages[0].content = '后改的预设';
    const controller = new AbortController();
    assert.equal(await request.send({ signal: controller.signal }), raw);
    assert.deepEqual(calls[0].payload, expected);
    assert.equal(globalThis.__playOutputExecuted, undefined);
    request.context.model = '不能改动实际模型';
    assert.equal(await request.send({ signal: controller.signal }), raw);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].payload, expected);
});

test('酒馆连接和独立 API 都保持预处理请求，不在发送层重新组装预设', async t => {
    const seen = [];
    const ctx = mockPlayContext(t, async payload => { seen.push(payload); return Response.json('正文'); }, result => result);
    const tavern = { ...data(), chat_completion_source: 'openai' };
    delete tavern.custom_url;
    const custom = { ...data(), proxy_password: 'custom-key' };
    for (const payload of [tavern, custom]) await createPreparedPlayRequest(ctx, payload).send({ signal: new AbortController().signal });
    assert.deepEqual(seen, [tavern, custom]);
    assert.deepEqual(seen[0].messages, seen[1].messages);
});

test('流式使用累计正文；取消会传到请求且不会执行工具返回信息', async t => {
    const controller = new AbortController(), seen = [];
    let receivedSignal;
    const ctx = mockPlayContext(t, async (_data, signal) => {
        receivedSignal = signal;
        return streamResponse([
            { choices: [{ delta: { content: '甲', tool_calls: [{ name: 'modifyMainChat' }] } }] },
            { choices: [{ delta: { content: '乙' } }] },
            { choices: [{ delta: { content: '丙' } }] }, '[DONE]',
        ]);
    });
    const request = createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming });
    await assert.rejects(request.send({ signal: controller.signal, onText: text => {
        seen.push(text);
        if (text === '甲乙') controller.abort();
    } }), error => error.name === 'AbortError');
    assert.deepEqual(seen, ['甲', '甲乙']);
    assert.equal(receivedSignal.aborted, true);
});

test('开始前已经停止的请求不发送；缺少正文或宿主接口的请求被拒绝', async t => {
    let sends = 0;
    const ctx = mockPlayContext(t, async () => { sends++; return Response.json('正文'); }, value => value);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createPreparedPlayRequest(ctx, data()).send({ signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(sends, 0);
    assert.throws(() => createPreparedPlayRequest(ctx, { ...data(), messages: [] }));
    assert.throws(() => createPreparedPlayRequest({}, data()));
});

for (const stream of [false, true]) test(`每次只请求一份回复，不丢弃额外付费结果：流式=${stream}`, async t => {
    let received;
    const ctx = mockPlayContext(t, async payload => {
        received = payload;
        return stream ? streamResponse([{ choices: [{ delta: { content: '一份完整回复' } }] }, '[DONE]']) : Response.json('一份完整回复');
    }, value => value);
    const original = { ...data(), n: 3, stream };
    const result = await createPreparedPlayRequest(ctx, original, { streaming: testStreaming }).send({ signal: new AbortController().signal });
    assert.equal(received.n, 1);
    assert.equal(original.n, 3, '不改酒馆预设的多回复设置');
    assert.equal(result, '一份完整回复');
});

for (const stream of [false, true]) test(`原生思维链和签名单独返回，正文不混入思维链：流式=${stream}`, async t => {
    const extras = [], texts = [];
    const ctx = mockPlayContext(t, async () => stream ? streamResponse([
        { choices: [{ delta: { reasoning_content: '思考' } }] },
        { choices: [{ delta: { content: '正文', reasoning_content: '完成' } }], signature: 'native-signature' }, '[DONE]',
    ]) : Response.json({ text: '正文', thought: '思考完成', signature: 'native-signature' }), value => value.text);
    const reasoning = {
        extractReasoningFromData(value, options) {
            assert.equal(options.mainApi, 'openai'); assert.equal(options.chatCompletionSource, 'custom');
            assert.equal(options.ignoreShowThoughts, true); return value.thought;
        },
        extractReasoningSignatureFromData: value => value.signature,
    };
    const result = await createPreparedPlayRequest(ctx, { ...data(), stream }, { reasoning, streaming: testStreaming })
        .send({ signal: new AbortController().signal, onReasoning: extra => extras.push(extra), onText: text => texts.push(text) });
    assert.equal(result, '正文'); assert.equal(texts.at(-1), '正文');
    assert.deepEqual(extras.at(-1), { reasoning: '思考完成', reasoning_signature: 'native-signature', reasoning_duration: null,
        api: 'custom', model: 'test-model' });
});

test('流式续写沿用目标思维链，有新思维链时采用新内容，签名不沿用旧值', async t => {
    const extras = [];
    const ctx = mockPlayContext(t, async () => streamResponse([
        { choices: [{ delta: { content: '续' } }] },
        { choices: [{ delta: { content: '写', reasoning_content: '本次的新思维链' } }], signature: 'new-signature' }, '[DONE]',
    ]));
    const request = createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming,
        prefix: '旧正文', continuationReasoning: '发送前处理后的旧思维链',
        continueExtra: { reasoning: '旧思维链', reasoning_signature: 'old-signature', reasoning_duration: 1200 } });
    assert.equal(await request.send({ signal: new AbortController().signal, onReasoning: extra => extras.push(extra) }), '旧正文续写');
    assert.equal(extras[0].reasoning, '发送前处理后的旧思维链');
    assert.equal(extras[0].reasoning_signature, null);
    assert.equal(extras.at(-1).reasoning, '本次的新思维链');
    assert.equal(extras.at(-1).reasoning_signature, 'new-signature');
});

test('非流式续写按酒馆 appendFinal 将新思维链接在已保存的思维链后', async t => {
    let extra;
    const ctx = mockPlayContext(t, async () => Response.json({ text: '续写', thought: '新思维链' }), value => value.text);
    const request = createPreparedPlayRequest(ctx, data(), { prefix: '旧正文', continueExtra: { reasoning: '旧思维链' },
        reasoning: { extractReasoningFromData: value => value.thought }, processReasoning: text => text.replace('新', '处理后的新') });
    assert.equal(await request.send({ signal: new AbortController().signal, onReasoning: value => { extra = value; } }), '旧正文续写');
    assert.equal(extra.reasoning, '旧思维链处理后的新思维链');
});

for (const stream of [false, true]) test(`HTTP 错误保留状态和接口全部错误字段：流式=${stream}`, async t => {
    const detail = { error: { message: 'upstream overloaded\ntry again later', code: 'rate_limit', type: 'capacity_error',
        retry_after: 25, metadata: { request_id: 'request-42', region: 'test-region' } } };
    const ctx = mockPlayContext(t, async () => Response.json(detail, { status: 429, statusText: 'Too Many Requests' }));
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream }, { streaming: testStreaming }).send({}), error => {
        assert.equal(error.message, detail.error.message); assert.equal(error.status, 429);
        assert.equal(error.statusText, 'Too Many Requests'); assert.deepEqual(error.error, detail);
        return true;
    });
});

test('非 JSON 的 HTTP 错误保留全部原文，不缩成一个状态码', async t => {
    const original = 'upstream connect error\n  connection reset before headers\nECONNRESET';
    const ctx = mockPlayContext(t, async () => new Response(original, { status: 502, statusText: 'Bad Gateway' }));
    await assert.rejects(createPreparedPlayRequest(ctx, data()).send({}), error => error.message === original && error.status === 502);
});

for (const detail of [
    { error: { message: 'overloaded', type: 'overloaded_error', request_id: 'r-1' } },
    { detail: { error: { message: 'permission denied', code: 'permission_error' } } },
    { message: 'upstream disconnected', code: 'ECONNRESET' },
]) test(`HTTP 200 流内错误不会被当成空正文：${JSON.stringify(detail)}`, async t => {
    const ctx = mockPlayContext(t, async () => streamResponse([detail, '[DONE]']));
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming }).send({}), error => {
        assert.equal(error.name, 'PlayApiError'); assert.deepEqual(error.error, detail); return true;
    });
});

test('已经收到正文后再报错，停止继续读取并完整记录错误，诊断不包含正文和请求', async t => {
    const detail = { error: { message: 'stream provider failed', code: 'upstream_reset',
        metadata: { request_id: 'r-22' }, request: { messages: ['private prompt'], api_key: 'synthetic-secret' } } };
    const ctx = mockPlayContext(t, async () => streamResponse([
        { choices: [{ delta: { content: 'private reply' } }] }, detail,
        { choices: [{ delta: { content: '不应读到的后续' } }] }, '[DONE]',
    ]));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const seen = [];
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onText: text => seen.push(text) }), error => {
            diagnostics.error('读取流式回复', error); return error.message === 'stream provider failed';
        });
    assert.deepEqual(seen, ['private reply']);
    assert.match(diagnostics.export(), /upstream_reset/); assert.match(diagnostics.export(), /r-22/);
    assert.doesNotMatch(diagnostics.export(), /private reply|private prompt|synthetic-secret|不应读到的后续/);
});

test('event:error 的普通文字也会原样报错', async t => {
    const ctx = mockPlayContext(t, async () => new Response('event: error\ndata: upstream socket closed\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }));
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({}), error => error.message === 'upstream socket closed');
});

test('没有完成标记便断流，已收正文不会被当成完整结果', async t => {
    const ctx = mockPlayContext(t, async () => streamResponse([{ choices: [{ delta: { content: '未写完' } }] }]));
    const seen = [];
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onText: text => seen.push(text) }), error => error.code === 'stream_interrupted');
    assert.deepEqual(seen, ['未写完']);
});

for (const final of ['[DONE]', { choices: [{ delta: {}, finish_reason: 'stop' }] }, { type: 'message_stop' },
    { type: 'message-end' }, { candidates: [{ finishReason: 'STOP' }] }]) {
    test(`兼容常见接口的流式完成标记：${JSON.stringify(final)}`, async t => {
        const ctx = mockPlayContext(t, async () => streamResponse([{ choices: [{ delta: { content: '完整正文' } }] }, final]));
        assert.equal(await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming }).send({}), '完整正文');
    });
}

test('流的读取错误保留原始原因，清理流时不会用另一个错误替换它', async t => {
    const original = new Error('socket hang up', { cause: new Error('ECONNRESET') });
    const ctx = mockPlayContext(t, async () => new Response(new ReadableStream({ start(controller) { controller.error(original); } }),
        { headers: { 'Content-Type': 'text/event-stream' } }));
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming }).send({}), error => error === original);
});
