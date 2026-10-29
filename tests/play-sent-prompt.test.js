import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { readSentPrompt, formatSentPrompt, createSentPromptCapture } from '../play-sent-prompt.js';
import { createPreparedPlayRequest } from '../play-request.js';
import { installPromptCapture } from '../tea-prompt-capture-server.mjs';

const payload = () => ({ messages: [{ role: 'system', content: '系统原文\n\n  缩进' },
    { role: 'user', content: '正文中的 JSON：{"保留":true}\n<content>{{char}}</content>' }],
    model: 'synthetic-model', chat_completion_source: 'custom', stream: false,
    custom_include_headers: '{"Authorization":"synthetic-secret"}', proxy_password: 'synthetic-secret' });

test('去掉传输 JSON 后保留顺序、空行、缩进和正文中的 JSON，不保留连接与密钥', () => {
    const prompt = readSentPrompt(JSON.stringify(payload()));
    assert.deepEqual(Object.keys(prompt), ['messages']);
    assert.equal(formatSentPrompt(prompt), '【1 · system / 系统】\n系统原文\n\n  缩进\n\n【2 · user / 用户】\n正文中的 JSON：{"保留":true}\n<content>{{char}}</content>');
    assert.doesNotMatch(JSON.stringify(prompt), /synthetic-secret|custom_include_headers|model/);
    assert.equal(formatSentPrompt(readSentPrompt({ systemInstruction: { parts: [{ text: '实际系统' }] },
        contents: [{ role: 'model', parts: [{ text: '第一段' }, { text: '第二段' }] }] })),
    '【系统提示词】\n实际系统\n\n【1 · model / 助手】\n第一段\n第二段');
});

test('工具定义和回复格式要求确实送给模型时显示，图片明确标记而不执行正文', () => {
    const prompt = readSentPrompt({ messages: [{ role: 'user', content: [{ type: 'text', text: '<script>原样提示词</script>' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic-image' } }] }],
    tools: [{ type: 'function', function: { name: 'synthetic_tool', description: '真正发送的工具说明' } }],
    response_format: { type: 'json_schema', json_schema: { name: 'synthetic_format', schema: { type: 'object' } } },
    custom_include_body: '{"messages":["不能提前推算"]}', Authorization: 'synthetic-secret' });
    const text = formatSentPrompt(prompt);
    assert.ok(text.includes('<script>原样提示词</script>'));
    assert.ok(text.includes('[图片或文件内容，无法作为文字显示]'));
    assert.ok(text.includes('真正发送的工具说明')); assert.ok(text.includes('synthetic_format'));
    assert.doesNotMatch(text, /不能提前推算|synthetic-secret|synthetic-image/);
    const google = readSentPrompt({ contents: [{ role: 'user', parts: [{ text: '正文' }] }],
        generationConfig: { responseSchema: { type: 'OBJECT', description: '实际格式说明' } } });
    assert.deepEqual(readSentPrompt(google), google, '服务器提取的回复格式经浏览器接收后仍然保留');
    assert.ok(formatSentPrompt(google).includes('实际格式说明'));
});

test('记录与 fetch 收到的字符串完全对应，未发送、已取消和准备阶段均不生成记录，重试单独记录', async t => {
    const transmitted = [], capture = createSentPromptCapture({ uuid: randomUUID, fetchRequest: async () => new Response('', { status: 404 }) });
    const context = { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), extractMessageFromData: data => data.text };
    t.mock.method(globalThis, 'fetch', async (_url, options) => { transmitted.push(options); return Response.json({ text: '模拟正文' }); });
    const data = payload(), request = createPreparedPlayRequest(context, data, { promptCapture: capture });
    assert.equal(capture.read().records.length, 0);
    data.messages[0].content = '准备后改变原对象';
    await request.send({ resultId: 'reply-a' }); await request.send({ resultId: 'reply-a' });
    const records = capture.read().records;
    assert.equal(records.length, 2);
    assert.notEqual(records[0].id, records[1].id);
    assert.deepEqual(records.map(record => record.resultId), ['reply-a', 'reply-a']);
    assert.deepEqual(records.map(record => record.browser), transmitted.map(send => readSentPrompt(send.body)));
    assert.equal(transmitted[0].body, transmitted[1].body);
    assert.equal(transmitted[0].headers['X-Tea-Prompt-Request'], records[0].id);
    assert.doesNotMatch(JSON.stringify(records), /synthetic-secret/);
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(request.send({ signal: stopped.signal }), { name: 'AbortError' });
    assert.equal(capture.read().records.length, 2);
    await request.send({ resultId: 'reply-b' });
    capture.clear('reply-a');
    assert.deepEqual(capture.read().records.map(record => record.resultId), ['reply-b'], '清空一条回复不删除其他回复记录');
    capture.clear(); assert.deepEqual(capture.read().records, []);
});

test('服务器流只接收本页面本次发送；重启断开连接后清空两份记录，不使用任何浏览器储存', async () => {
    let enqueue, end;
    const capture = createSentPromptCapture({ uuid: randomUUID, fetchRequest: async () => new Response(new ReadableStream({
        start(controller) { enqueue = data => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
            end = () => controller.close(); enqueue({ type: 'ready' }); },
    }), { headers: { 'Content-Type': 'text/event-stream' } }) });
    const trace = await capture.begin({ getRequestHeaders: () => ({}) }); trace.sent(JSON.stringify(payload()));
    enqueue({ type: 'prompt', id: randomUUID(), prompt: { messages: ['别的页面'] } });
    enqueue({ type: 'prompt', id: trace.headers['X-Tea-Prompt-Request'], sentAt: '2026-10-29T08:00:00Z',
        prompt: { messages: [{ role: 'user', content: '真实后续处理' }], authorization: 'synthetic-secret' } });
    await setImmediate();
    assert.equal(capture.read().records[0].server.length, 1);
    assert.equal(capture.read().records[0].server[0].prompt.messages[0].content, '真实后续处理');
    assert.doesNotMatch(JSON.stringify(capture.read()), /synthetic-secret|别的页面/);
    const freshPage = createSentPromptCapture(); assert.deepEqual(freshPage.read().records, []);
    end(); await setImmediate(); assert.deepEqual(capture.read().records, []);
    capture.dispose(); freshPage.dispose();
});

test('服务器记录的是 HTTP 发送字节，两个同时请求不会串台，断开的页面不保留旧记录', async t => {
    const received = [], server = http.createServer(async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        received.push(Buffer.concat(chunks).toString('utf8'));
        response.end('ok');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const send = body => new Promise((resolve, reject) => {
        const request = http.request(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { Authorization: 'synthetic-secret' } },
            response => { response.resume(); response.on('end', resolve); });
        request.on('error', reject); request.write(body.slice(0, 17)); request.end(body.slice(17));
    });
    const generateRouter = { async handle(request, response) {
        await new Promise(resolve => setTimeout(resolve, request.delay));
        // A synthetic server conversion deliberately differs from input messages.
        await send(JSON.stringify({ system: `服务器 ${request.label}`, messages: [{ role: 'user', content: request.label + '\n{"正文":true}' }],
            model: 'actual-model', secret: 'synthetic-secret' }));
        response.done = true;
    } };
    let stream;
    const cleanup = installPromptCapture(generateRouter, { post(_route, handler) { stream = handler; } });
    t.after(cleanup);
    const connect = (handle, sessionId) => {
        const response = new EventEmitter(), events = [];
        Object.assign(response, { set() {}, flushHeaders() {}, write(frame) {
            const line = frame.split('\n').find(line => line.startsWith('data: ')); if (line) events.push(JSON.parse(line.slice(6)));
        }, end() { response.emit('close'); }, sendStatus(code) { response.status = code; } });
        stream({ user: { profile: { handle } }, get: () => sessionId }, response);
        return { response, events };
    };
    const aId = randomUUID(), bId = randomUUID(), a = connect('user-a', aId), b = connect('user-b', bId);
    const inbound = (sessionId, handle, label, delay) => {
        const headers = { 'x-tea-prompt-session': sessionId, 'x-tea-prompt-request': randomUUID() };
        return { headers, get(name) { return headers[name.toLowerCase()]; }, method: 'POST', path: '/generate', user: { profile: { handle } }, label, delay };
    };
    const first = inbound(aId, 'user-a', '甲', 12), second = inbound(bId, 'user-b', '乙', 0);
    await Promise.all([generateRouter.handle(first, {}), generateRouter.handle(second, {})]);
    assert.equal(a.events.length, 2); assert.equal(b.events.length, 2);
    assert.equal(a.events[1].prompt.system, '服务器 甲'); assert.equal(b.events[1].prompt.system, '服务器 乙');
    for (const event of [a.events[1], b.events[1]]) {
        const exact = received.find(body => JSON.parse(body).system === event.prompt.system);
        assert.deepEqual(event.prompt, readSentPrompt(exact));
        assert.doesNotMatch(JSON.stringify(event), /synthetic-secret/);
    }
    assert.deepEqual(first.headers, {}, '关联标记不会被酒馆转发给模型');
    await generateRouter.handle(inbound(aId, 'user-b', '越权', 0), {});
    assert.equal(a.events.length, 2); assert.equal(b.events.length, 2);
    a.response.end();
    const reopened = connect('user-a', aId); assert.deepEqual(reopened.events, [{ type: 'ready' }]);
    b.response.end(); reopened.response.end();
});
