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

test('流式收到的原始消息和未知控制字段进入日志，字节分片不改变正文与完成判断', async t => {
    const first = { choices: [{ delta: { content: 'private reply中文', reasoning_content: 'private thought' } }],
        futureControl: { flags: ['new-value'], nested: [{ position: 2 }] } };
    const final = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 8 },
        futureFinal: { marker: 'keep-final-field' } };
    const raw = 'id: synthetic-event\r\nevent: message\r\nretry: 900\r\nvendor-flag: keep-wire-field\r\n'
        + `data: ${JSON.stringify(first)}\r\n\r\n: heartbeat\r\n\r\ndata: ${JSON.stringify(final)}\r\n\r\n`;
    const bytes = new TextEncoder().encode(raw);
    const ctx = mockPlayContext(t, async () => new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream', 'X-Future-Header': 'keep-header', 'Set-Cookie': 'private cookie' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'stream-request', attempt: 1 });
    const result = await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() });
    assert.equal(result, 'private reply中文'); trace.finish('complete');
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    assert.equal(packets[0].headers['x-future-header'], 'keep-header'); assert.equal(packets[0].status, 200);
    const event = packets.find(packet => packet.kind === 'event' && packet.data?.futureControl);
    assert.deepEqual(event.data.futureControl, first.futureControl);
    assert.deepEqual(event.fields['vendor-flag'], ['keep-wire-field']); assert.deepEqual(event.fields.retry, ['900']);
    assert.deepEqual(packets.find(packet => packet.data?.futureFinal).data.futureFinal, final.futureFinal);
    const end = packets.at(-1);
    assert.equal(end.kind, 'stream-end'); assert.equal(end.endedBy, 'reader-end');
    assert.equal(end.readerDone, true); assert.equal(end.bodyEnded, true); assert.equal(end.completed, true);
    assert.equal(end.receivedBytes, bytes.length); assert.equal(end.receivedChunks, Math.ceil(bytes.length / 7));
    assert.equal(end.framedEvents, 3); assert.equal(end.dataEvents, 2); assert.equal(end.parsedEvents, 2);
    assert.equal(end.tail, null); assert.ok(end.firstDataAt); assert.ok(end.lastDataAt);
    assert.doesNotMatch(diagnostics.export(), /private reply|private thought|private cookie/);
});

test('结束字段已到但末尾没有消息分隔时，日志保留未交给原生读取器的完整元数据', async t => {
    const tail = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'private tail story' }] } }],
        futureTail: { code: 'terminal-control', detail: ['unknown-tail-field'] } };
    const raw = 'data: {"choices":[{"delta":{"content":"private body"}}]}\n\n'
        + 'event: message\nid: tail-event\ndata: ' + JSON.stringify(tail);
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'tail-request', attempt: 1 });
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error.code === 'stream_interrupted'; });
    const end = diagnostics.read().entries.flatMap(entry => entry.received ?? []).at(-1).data;
    assert.equal(end.readerDone, true); assert.equal(end.bodyEnded, true); assert.equal(end.completed, false);
    assert.equal(end.tail.delimited, false); assert.equal(end.tail.parsed, true);
    assert.equal(end.tail.data.candidates[0].finishReason, 'STOP'); assert.deepEqual(end.tail.data.futureTail, tail.futureTail);
    assert.deepEqual(end.tail.fields.id, ['tail-event']);
    assert.doesNotMatch(diagnostics.export(), /private body|private tail story/);
});

test('读取停止前已收到的后续消息仍保留非正文数据，原错误独立记录且不覆盖正文', async t => {
    const ctx = mockPlayContext(t, async () => streamResponse([
        { choices: [{ delta: { content: 'private body' } }] },
        { error: { message: 'original upstream failure', code: 'upstream_reset', request_id: 'r-future' } },
        { choices: [{ delta: { content: 'private unread body' } }], futureUnread: { reason: 'keep-received-field' } }, '[DONE]',
    ]));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'error-request', attempt: 1 }), seen = [];
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onText: text => seen.push(text), onReceived: trace.receiver() }), error => {
            trace.finish('failed', error); return error.message === 'original upstream failure';
        });
    assert.deepEqual(seen, ['private body']);
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    assert.equal(packets.find(packet => packet.data?.futureUnread).data.futureUnread.reason, 'keep-received-field');
    assert.equal(packets.at(-1).dataEvents, 4); assert.equal(packets.at(-1).eventsRead, 2);
    assert.equal(diagnostics.read().entries.at(-1).error.message, 'original upstream failure');
    assert.doesNotMatch(diagnostics.export(), /private body|private unread body/);
});

test('非流式成功及 HTTP 错误都记录去除正文后的完整响应，未来字段不依赖名单', async t => {
    let reply = { choices: [{ message: { content: 'private full reply' } }], futureProvider: { zone: 'new-zone', states: ['keep-state'] } };
    let status = 200;
    const ctx = mockPlayContext(t, async () => Response.json(reply, { status, headers: { 'X-Trace-Future': 'future-header' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'json-request', attempt: 1 });
    const request = createPreparedPlayRequest(ctx, data());
    assert.equal(await request.send({ onReceived: trace.receiver() }), 'private full reply');
    status = 429; reply = { error: { message: 'original capacity error', code: 'future-code', retry_after: 25,
        futureError: { level: 'new-level' }, request: { prompt: 'private request echo' } } };
    trace.update({ attempt: 2 });
    await assert.rejects(request.send({ onReceived: trace.receiver() }), error => {
        trace.finish('failed', error); return error.status === 429;
    });
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    assert.deepEqual(packets.find(packet => packet.data?.futureProvider).data.futureProvider, { zone: 'new-zone', states: ['keep-state'] });
    assert.deepEqual(packets.find(packet => packet.data?.error).data.error.futureError, { level: 'new-level' });
    assert.ok(packets.some(packet => packet.status === 429));
    assert.doesNotMatch(diagnostics.export(), /private full reply|private request echo/);
});

test('原始读取错误和主动取消有独立的流结束证据，诊断回调失败不改变请求结果', async t => {
    const original = new Error('actual connection reset', { cause: new Error('ECONNRESET') });
    const ctx = mockPlayContext(t, async () => new Response(new ReadableStream({ start(controller) { controller.error(original); } }),
        { headers: { 'Content-Type': 'text/event-stream' } }));
    const events = [];
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: value => events.push(value) }), error => error === original);
    assert.equal(events.at(-1).endedBy, 'error'); assert.equal(events.at(-1).stage, 'reading');
    assert.equal(events.at(-1).readerDone, false); assert.equal(events.at(-1).bodyEnded, false);
    t.mock.method(globalThis, 'fetch', async () => streamResponse([{ choices: [{ delta: { content: 'private reply' } }] }, '[DONE]']));
    const controller = new AbortController(), stopped = [];
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ signal: controller.signal, onText() { controller.abort(); }, onReceived: value => stopped.push(value) }), error => error.name === 'AbortError');
    assert.equal(stopped.at(-1).endedBy, 'aborted'); assert.equal(stopped.at(-1).aborted, true);
    assert.equal(await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived() { throw Error('diagnostics unavailable'); } }), 'private reply');
});

test('无法解析的末尾只记录格式证据和解析错误，不把未解析正文写入日志', async t => {
    const ctx = mockPlayContext(t, async () => new Response('data: {"choices":[{"delta":{"content":"private truncated story',
        { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'truncated-request', attempt: 1 });
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error.code === 'stream_interrupted'; });
    const end = diagnostics.read().entries.flatMap(entry => entry.received ?? []).at(-1).data;
    assert.equal(end.tail.parsed, false); assert.equal(end.tail.parseError.name, 'SyntaxError');
    assert.ok(end.tail.characters > 0); assert.equal(end.eventsRead, 0);
    assert.doesNotMatch(diagnostics.export(), /private truncated story/);
});

for (const delimited of [false, true]) test(`无 data 前缀的 238 字符接口错误保留全部非正文信息：分隔=${delimited}`, async t => {
    const detail = { error: { code: 500, message: 'synthetic provider failure', status: 'INTERNAL' },
        future: { trace: 'unknown-trace', retryable: true }, content: 'private tail', api_key: 'private key' };
    const tail = JSON.stringify(detail).padEnd(238, ' ');
    assert.equal(tail.length, 238);
    const raw = 'data: {"choices":[{"delta":{"content":"private body"}}]}\n\n' + tail + (delimited ? '\n\n' : '');
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'bare-error-request', attempt: 1 }), seen = [];
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver(), onText: text => seen.push(text) }), error => {
            trace.finish('failed', error); return error.code === 'stream_interrupted';
        });
    assert.deepEqual(seen, ['private body']);
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    const end = packets.findLast(packet => packet.kind === 'stream-end');
    const received = delimited ? packets.find(packet => packet.format === 'unprefixed') : end.tail;
    assert.equal(received.format, 'unprefixed'); assert.equal(received.delimited, delimited);
    assert.equal(received.hasData, false); assert.equal(received.parsed, true); assert.equal(received.characters, 238);
    assert.deepEqual(received.data.error, detail.error); assert.deepEqual(received.data.future, detail.future);
    assert.equal(end.completed, false); assert.equal(end.readerDone, true); assert.equal(end.bodyEnded, true);
    assert.equal(received.data.content, detail.content);
    assert.doesNotMatch(diagnostics.export(), /private body|private key/);
});

for (const delimited of [false, true]) test(`无 data 前缀的完成字段进入日志，不把原生读取器未识别的消息当作成功：分隔=${delimited}`, async t => {
    const detail = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'private final story' }] } }],
        usageMetadata: { totalTokenCount: 120 }, futureComplete: { marker: 'future-value' } };
    const raw = 'data: {"choices":[{"delta":{"content":"private body"}}]}\n\n'
        + JSON.stringify(detail) + (delimited ? '\n\n' : '');
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'bare-final-request', attempt: 1 });
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error.code === 'stream_interrupted'; });
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    const end = packets.findLast(packet => packet.kind === 'stream-end');
    const received = delimited ? packets.find(packet => packet.format === 'unprefixed') : end.tail;
    assert.equal(received.data.candidates[0].finishReason, 'STOP'); assert.deepEqual(received.data.usageMetadata, detail.usageMetadata);
    assert.deepEqual(received.data.futureComplete, detail.futureComplete); assert.equal(end.completed, false);
    assert.doesNotMatch(diagnostics.export(), /private body|private final story/);
});

for (const newline of ['\n', '\r\n', '\r']) test(`多行裸 JSON 的内部空行不会丢失元数据，中文跨字节分片仍正确：${JSON.stringify(newline)}`, async t => {
    const detail = { error: { code: 503, message: 'synthetic failure', status: 'UNAVAILABLE' },
        future: { labels: ['new-control'], nested: [{ state: 'unknown-state' }] },
        content: 'private 多行正文', request: { prompt: 'private request', api_key: 'private credential' } };
    const json = JSON.stringify(detail, null, 2).replaceAll('\n', newline).replace(newline, newline + newline);
    const raw = 'data: {"choices":[{"delta":{"content":"private body"}}]}\n\n' + '\uFEFF' + json + newline + newline;
    const bytes = new TextEncoder().encode(raw);
    const ctx = mockPlayContext(t, async () => new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset++) controller.enqueue(bytes.slice(offset, offset + 1));
        controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'pretty-json-request', attempt: 1 });
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error.code === 'stream_interrupted'; });
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    const received = packets.find(packet => packet.format === 'unprefixed' && packet.parsed);
    assert.deepEqual(received.data.error, detail.error); assert.deepEqual(received.data.future, detail.future);
    assert.equal(received.delimited, true); assert.equal(received.hasData, false);
    assert.equal(packets.at(-1).receivedBytes, bytes.length); assert.equal(packets.at(-1).receivedChunks, bytes.length);
    assert.equal(received.data.content, detail.content);
    assert.doesNotMatch(diagnostics.export(), /private body|private request|private credential/);
});

test('裸 JSON 数组及逐行 JSON 保留每条响应，顶层字符串正文也脱敏', async t => {
    const values = [{ error: { message: 'synthetic failure', code: 'unknown-code' }, text: 'private text' },
        { future: { position: 2 }, content: 'private content' }, 'private scalar body'];
    for (const raw of [JSON.stringify(values), values.map(value => JSON.stringify(value)).join('\n')]) {
        const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
        const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
        const trace = diagnostics.start('小剧场生成', { requestId: 'json-values-request', attempt: 1 });
        await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
            .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error.code === 'stream_interrupted'; });
        const tail = diagnostics.read().entries.flatMap(entry => entry.received ?? []).at(-1).data.tail;
        const received = tail.values ? tail.values.map(value => value.data) : tail.data;
        assert.equal(tail.parsed, true); assert.equal(received[0].error.code, 'unknown-code');
        assert.deepEqual(received[1].future, values[1].future); assert.equal(received[2], '[正文已移除]');
        assert.equal(received[0].text, values[0].text);
        assert.doesNotMatch(diagnostics.export(), /private content|private scalar body/);
    }
});

test('普通 SSE 消息夹杂未加前缀的 JSON 仍留下非正文信息，不改变正文读取', async t => {
    const extra = { error: { message: 'synthetic wire diagnostic', code: 'wire-code' }, future: { keep: ['unknown-field'] },
        content: 'private extra content', request: { prompt: 'private extra request' } };
    const raw = 'data: {"choices":[{"delta":{"content":"private body"}}]}\n' + JSON.stringify(extra)
        + '\n\ndata: [DONE]\n\n';
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'mixed-json-request', attempt: 1 });
    assert.equal(await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), 'private body'); trace.finish('complete');
    const event = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data)
        .find(packet => packet.unrecognized);
    assert.equal(event.hasData, true); assert.equal(event.parsed, true); assert.equal(event.unrecognized[0].parsed, true);
    assert.deepEqual(event.unrecognized[0].data.error, extra.error); assert.deepEqual(event.unrecognized[0].data.future, extra.future);
    assert.equal(event.unrecognized[0].data.content, extra.content);
    assert.doesNotMatch(diagnostics.export(), /private body|private extra request/);
});

test('事件头后没有 data 前缀的 JSON、未知字段中的 JSON 和特殊字段名都能安全记录', async t => {
    const extra = { error: { message: 'synthetic field error', code: 'field-code' }, future: { state: 'keep-state' },
        content: 'private field content', api_key: 'private field key' };
    const raw = 'event: error\nid: synthetic-event\n' + JSON.stringify(extra) + '\n\n'
        + 'vendor-info: ' + JSON.stringify(extra) + '\nconstructor: synthetic-constructor\n__proto__: synthetic-prototype\n\n'
        + 'data: {"choices":[{"delta":{"content":"private body"}}]}\n\ndata: [DONE]\n\n';
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'field-json-request', attempt: 1 });
    assert.equal(await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), 'private body'); trace.finish('complete');
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    const header = packets.find(packet => packet.unrecognized);
    assert.deepEqual(header.fields.event, ['error']); assert.deepEqual(header.fields.id, ['synthetic-event']);
    assert.equal(header.hasData, false); assert.deepEqual(header.unrecognized[0].data.error, extra.error);
    const field = packets.find(packet => packet.fields?.['vendor-info']);
    assert.deepEqual(field.fields['vendor-info'][0].data.future, extra.future);
    assert.equal(field.fields['vendor-info'][0].data.content, extra.content);
    assert.doesNotMatch(diagnostics.export(), /private body|private field key/);
});

for (const raw of ['{"choices":[{"delta":{"content":"private truncated body',
    '<html>504 Gateway Timeout upstream</html>', 'ECONNRESET socket hang up upstream', '\uFFFD504 upstream timeout']) {
    test(`无法解析的无前缀残片保留全文与格式证据，只移除可识别的正文：${raw[0]}`, async t => {
        const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
        const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
        const trace = diagnostics.start('小剧场生成', { requestId: 'unknown-tail-request', attempt: 1 });
        await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
            .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error.code === 'stream_interrupted'; });
        const tail = diagnostics.read().entries.flatMap(entry => entry.received ?? []).at(-1).data.tail;
        const fragment = tail.unrecognized?.[0] ?? tail;
        assert.equal(tail.hasData, false); assert.equal(tail.characters, raw.length);
        assert.equal(fragment.parsed, false); assert.equal(fragment.parseError.name, 'SyntaxError');
        assert.equal(fragment.shape.lines, 1); assert.equal(fragment.shape.replacementCharacters, raw.startsWith('\uFFFD') ? 1 : 0);
        if (raw.startsWith('{')) assert.doesNotMatch(diagnostics.export(), /private truncated body/);
        else assert.equal(tail.raw, raw);
    });
}

test('无前缀消息中的空行、引号和转义反斜线不会改变后续 SSE 分隔及完成判断', async t => {
    const detail = { future: { values: ['quoted " } [ \\ value', 'next-control'] }, content: 'private body fragment' };
    const json = JSON.stringify(detail, null, 2).replace('\n', '\n\n');
    const raw = json + '\n\ndata: {"choices":[{"delta":{"content":"private body"}}]}\n\ndata: [DONE]\n\n';
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'escaped-json-request', attempt: 1 });
    assert.equal(await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), 'private body'); trace.finish('complete');
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    assert.deepEqual(packets.find(packet => packet.format === 'unprefixed').data.future, detail.future);
    assert.equal(packets.at(-1).completed, true); assert.equal(packets.at(-1).tail, null);
    assert.doesNotMatch(diagnostics.export(), /private body fragment|private body/);
});

test('事件头及正文行后夹杂多行 JSON 时，内部空行不拆散异常数据', async t => {
    const detail = { error: { code: 500, message: 'synthetic mixed failure' }, future: { status: 'mixed-control' },
        content: 'private mixed body' };
    const json = JSON.stringify(detail, null, 2).replace('\n', '\n\n');
    for (const prefix of ['event: error\nid: synthetic-id\n', 'data: {"choices":[{"delta":{"content":"private body"}}]}\n']) {
        const raw = prefix + json + '\n\ndata: [DONE]\n\n';
        const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
        const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
        const trace = diagnostics.start('小剧场生成', { requestId: 'mixed-lines-request', attempt: 1 });
        assert.equal(await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
            .send({ onReceived: trace.receiver() }), prefix.startsWith('data:') ? 'private body' : ''); trace.finish('complete');
        const event = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data)
            .find(packet => packet.unrecognized?.some(fragment => fragment.parsed));
        assert.deepEqual(event.unrecognized.find(fragment => fragment.parsed).data.error, detail.error);
        assert.deepEqual(event.unrecognized.find(fragment => fragment.parsed).data.future, detail.future);
        assert.equal(event.unrecognized.find(fragment => fragment.parsed).data.content, detail.content);
        assert.doesNotMatch(diagnostics.export(), /private body/);
    }
});

test('分离的未知残片不会拼成虚构 JSON，未知字段里不完整的 JSON 只留下安全证据', async t => {
    const raw = '{"incomplete":\nid: real-boundary\n1}\n\n'
        + 'vendor-error: {"content":"private truncated field\n\n'
        + 'data: [DONE]\n\n';
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'separated-fragments-request', attempt: 1 });
    assert.equal(await createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), ''); trace.finish('complete');
    const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
    const first = packets.find(packet => packet.kind === 'event');
    assert.equal(first.parsed, false); assert.equal(first.data, undefined);
    const observed = packets.find(packet => packet.fields?.['vendor-error']) ?? packets.at(-1).tail;
    const field = observed.fields['vendor-error'][0];
    assert.equal(field.parsed, false); assert.equal(field.parseError.name, 'SyntaxError');
    assert.equal(field.shape.startsWith, 'object-start');
    assert.match(diagnostics.export(), /private truncated field/);
});

for (const raw of ['', 'data: {"choices":[{"delta":{"content":"hidden partial story"}}]}\n\n']) {
    test(`流结束恰好没有尾部时，保留读取、字节和完成证据，不编造超时原因：空流=${!raw}`, async t => {
        const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
        const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
        const trace = diagnostics.start('小剧场生成', { requestId: 'empty-tail-request', attempt: 1 });
        await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
            .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error.code === 'stream_interrupted'; });
        const end = diagnostics.read().entries.flatMap(entry => entry.received ?? []).at(-1).data;
        assert.equal(end.tail, null); assert.equal(end.readerDone, true); assert.equal(end.bodyEnded, true);
        assert.equal(end.completed, false); assert.equal(end.aborted, false);
        assert.equal(end.eventsRead, raw ? 1 : 0); assert.equal(end.receivedBytes, new TextEncoder().encode(raw).length);
        assert.doesNotMatch(diagnostics.export(), /hidden partial story|网络超时|网关超时|代理超时/);
    });
}

test('非流式 HTML 错误和 JSON 字符串错误原文保留，HTTP 错误内容不被误判成回复正文', async t => {
    for (const [raw, message] of [['<html><body>504 Gateway Timeout upstream</body></html>', '<html><body>504 Gateway Timeout upstream</body></html>'],
        [JSON.stringify('synthetic upstream error'), 'synthetic upstream error']]) {
        const ctx = mockPlayContext(t, async () => new Response(raw, { status: 502, headers: { 'X-Trace': 'keep-error-header' } }));
        const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
        const trace = diagnostics.start('小剧场生成', { requestId: 'http-text-error-request', attempt: 1 });
        await assert.rejects(createPreparedPlayRequest(ctx, data()).send({ onReceived: trace.receiver() }), error => {
            trace.finish('failed', error); return error.message === message && error.status === 502;
        });
        const packets = diagnostics.read().entries.flatMap(entry => entry.received ?? []).map(packet => packet.data);
        assert.equal(packets[0].headers['x-trace'], 'keep-error-header');
        assert.equal(packets[1].ok, false);
        if (packets[1].parsed) assert.equal(packets[1].data, message);
        else assert.equal(packets[1].raw, raw);
        assert.equal(diagnostics.read().entries.at(-1).error.message, message);
    }
});

test('残缺的多行 SSE JSON 内部空行保留原文，正文仍被移除，元数据不丢失', async t => {
    const raw = 'data: {\n\n"future":{"code":"keep-future-code"},\n"choices":[{"delta":{"content":"hidden multiline incomplete body';
    const ctx = mockPlayContext(t, async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }));
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const trace = diagnostics.start('小剧场生成', { requestId: 'multiline-sse-tail-request', attempt: 1 });
    await assert.rejects(createPreparedPlayRequest(ctx, { ...data(), stream: true }, { streaming: testStreaming })
        .send({ onReceived: trace.receiver() }), error => { trace.finish('failed', error); return error instanceof SyntaxError; });
    const tail = diagnostics.read().entries.flatMap(entry => entry.received ?? []).at(-1).data.tail;
    assert.ok(tail.raw.includes('"future":{"code":"keep-future-code"}'));
    assert.ok(tail.raw.startsWith('data: {\n\n')); assert.equal(tail.characters, raw.length);
    assert.doesNotMatch(diagnostics.export(), /hidden multiline incomplete body/);
});
