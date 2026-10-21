import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparedPlayRequest, fetchCustomApiModels } from '../play-request.js';

const data = () => ({ messages: [{ role: 'system', content: '已处理的当前预设' }, { role: 'user', content: '本次小剧场' }],
    model: 'test-model', chat_completion_source: 'custom', custom_url: 'https://example.invalid/v1',
    temperature: 0.8, stream: false });

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
        await assert.rejects(load(), result => result.code === 'model_list_failed'
            && result.message === (error === true ? '接口未能返回模型列表。' : 'upstream unavailable'));
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
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => {
        controller.abort(); return { data: [{ id: 'old-model' }] };
    } }));
    await assert.rejects(fetchCustomApiModels({ getRequestHeaders: () => ({}) },
        { url: 'https://example.invalid/v1' }, controller.signal), error => error.name === 'AbortError');
});

test('仅使用独立发送接口，保留处理好的全部消息与参数，响应原文不执行', async () => {
    const calls = [];
    const raw = '<% globalThis.__playOutputExecuted = true %>\n<UpdateVariable>_.set("好感度",80)</UpdateVariable>';
    const ctx = { ChatCompletionService: { async sendRequest(payload, extract, signal) {
        calls.push({ payload, extract, signal }); return { choices: [{ message: { content: raw } }] };
    } }, extractMessageFromData: (result, api) => { assert.equal(api, 'openai'); return result.choices[0].message.content; } };
    const payload = data(), expected = structuredClone(payload);
    const request = createPreparedPlayRequest(ctx, payload);
    payload.messages[0].content = '后改的预设';
    const controller = new AbortController();
    assert.equal(await request.send({ signal: controller.signal }), raw);
    assert.deepEqual(calls[0].payload, expected);
    assert.equal(calls[0].extract, false);
    assert.equal(globalThis.__playOutputExecuted, undefined);
    await assert.rejects(request.send({ signal: controller.signal }), /已经发送/);
    assert.equal(calls.length, 1);
});

test('酒馆连接和独立 API 都保持预处理请求，不在发送层重新组装预设', async () => {
    const seen = [];
    const ctx = { ChatCompletionService: { async sendRequest(payload) { seen.push(payload); return '正文'; } }, extractMessageFromData: result => result };
    const tavern = { ...data(), chat_completion_source: 'openai' };
    delete tavern.custom_url;
    const custom = { ...data(), proxy_password: 'custom-key' };
    for (const payload of [tavern, custom]) await createPreparedPlayRequest(ctx, payload).send({ signal: new AbortController().signal });
    assert.deepEqual(seen, [tavern, custom]);
    assert.deepEqual(seen[0].messages, seen[1].messages);
});

test('流式使用累计正文；取消会传到请求且不会执行工具返回信息', async () => {
    const controller = new AbortController(), seen = [];
    let receivedSignal;
    const ctx = { ChatCompletionService: { async sendRequest(_data, _extract, signal) {
        receivedSignal = signal;
        return async function* () {
            yield { text: '甲', state: { toolCalls: [{ name: 'modifyMainChat' }] } };
            yield { text: '甲乙' };
            yield { text: '甲乙丙' };
        };
    } }, extractMessageFromData: value => value };
    const request = createPreparedPlayRequest(ctx, { ...data(), stream: true });
    await assert.rejects(request.send({ signal: controller.signal, onText: text => {
        seen.push(text);
        if (text === '甲乙') controller.abort();
    } }), error => error.name === 'AbortError');
    assert.deepEqual(seen, ['甲', '甲乙']);
    assert.equal(receivedSignal.aborted, true);
});

test('开始前已经停止的请求不发送；缺少正文或宿主接口的请求被拒绝', async () => {
    let sends = 0;
    const ctx = { ChatCompletionService: { sendRequest: async () => { sends++; return '正文'; } }, extractMessageFromData: value => value };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createPreparedPlayRequest(ctx, data()).send({ signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(sends, 0);
    assert.throws(() => createPreparedPlayRequest(ctx, { ...data(), messages: [] }));
    assert.throws(() => createPreparedPlayRequest({}, data()));
});

for (const stream of [false, true]) test(`每次只请求一份回复，不丢弃额外付费结果：流式=${stream}`, async () => {
    let received;
    const ctx = { ChatCompletionService: { async sendRequest(payload) {
        received = payload;
        return stream ? async function* () { yield { text: '一份完整回复' }; } : '一份完整回复';
    } }, extractMessageFromData: value => value };
    const original = { ...data(), n: 3, stream };
    const result = await createPreparedPlayRequest(ctx, original).send({ signal: new AbortController().signal });
    assert.equal(received.n, 1);
    assert.equal(original.n, 3, '不改酒馆预设的多回复设置');
    assert.equal(result, '一份完整回复');
});

for (const stream of [false, true]) test(`原生思维链和签名单独返回，正文不混入思维链：流式=${stream}`, async () => {
    const extras = [], texts = [];
    const ctx = { ChatCompletionService: { async sendRequest() {
        return stream ? async function* () {
            yield { text: '', state: { reasoning: '思考' } };
            yield { text: '正文', state: { reasoning: '思考完成', signature: 'native-signature' } };
        } : { text: '正文', thought: '思考完成', signature: 'native-signature' };
    } }, extractMessageFromData: value => value.text };
    const reasoning = {
        extractReasoningFromData(value, options) {
            assert.equal(options.mainApi, 'openai'); assert.equal(options.chatCompletionSource, 'custom');
            assert.equal(options.ignoreShowThoughts, true); return value.thought;
        },
        extractReasoningSignatureFromData: value => value.signature,
    };
    const result = await createPreparedPlayRequest(ctx, { ...data(), stream }, { reasoning })
        .send({ signal: new AbortController().signal, onReasoning: extra => extras.push(extra), onText: text => texts.push(text) });
    assert.equal(result, '正文'); assert.equal(texts.at(-1), '正文');
    assert.deepEqual(extras.at(-1), { reasoning: '思考完成', reasoning_signature: 'native-signature', reasoning_duration: null,
        api: 'custom', model: 'test-model' });
});

test('流式续写沿用目标思维链，有新思维链时采用新内容，签名不沿用旧值', async () => {
    const extras = [];
    const ctx = { ChatCompletionService: { async sendRequest() { return async function* () {
        yield { text: '续', state: { reasoning: '' } };
        yield { text: '续写', state: { reasoning: '本次的新思维链', signature: 'new-signature' } };
    }; } }, extractMessageFromData: value => value };
    const request = createPreparedPlayRequest(ctx, { ...data(), stream: true }, { prefix: '旧正文', continuationReasoning: '发送前处理后的旧思维链',
        continueExtra: { reasoning: '旧思维链', reasoning_signature: 'old-signature', reasoning_duration: 1200 } });
    assert.equal(await request.send({ signal: new AbortController().signal, onReasoning: extra => extras.push(extra) }), '旧正文续写');
    assert.equal(extras[0].reasoning, '发送前处理后的旧思维链');
    assert.equal(extras[0].reasoning_signature, null);
    assert.equal(extras.at(-1).reasoning, '本次的新思维链');
    assert.equal(extras.at(-1).reasoning_signature, 'new-signature');
});

test('非流式续写按酒馆 appendFinal 将新思维链接在已保存的思维链后', async () => {
    let extra;
    const ctx = { ChatCompletionService: { sendRequest: async () => ({ text: '续写', thought: '新思维链' }) }, extractMessageFromData: value => value.text };
    const request = createPreparedPlayRequest(ctx, data(), { prefix: '旧正文', continueExtra: { reasoning: '旧思维链' },
        reasoning: { extractReasoningFromData: value => value.thought }, processReasoning: text => text.replace('新', '处理后的新') });
    assert.equal(await request.send({ signal: new AbortController().signal, onReasoning: value => { extra = value; } }), '旧正文续写');
    assert.equal(extra.reasoning, '旧思维链处理后的新思维链');
});
