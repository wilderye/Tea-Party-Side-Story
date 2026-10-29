import test from 'node:test';
import assert from 'node:assert/strict';
import { readSentPrompt, formatSentPrompt, createSentPromptCapture } from '../play-sent-prompt.js';
import { createPreparedPlayRequest } from '../play-request.js';

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
    assert.deepEqual(readSentPrompt(google), google, '提取后仍然保留实际回复格式');
    assert.ok(formatSentPrompt(google).includes('实际格式说明'));
});

test('只记录实际发给酒馆的字符串，按回复版本读取，不增加请求或修改酒馆请求头', async t => {
    const transmitted = [], capture = createSentPromptCapture();
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-token' };
    const context = { getRequestHeaders: () => headers, extractMessageFromData: data => data.text };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate');
        assert.equal(options.headers, headers);
        transmitted.push(options); return Response.json({ text: '模拟正文' });
    });
    const data = payload(), request = createPreparedPlayRequest(context, data, { promptCapture: capture });
    assert.equal(capture.read('reply-a'), null);
    data.messages[0].content = '准备后改变原对象';
    await request.send({ resultId: 'reply-a' }); await request.send({ resultId: 'reply-a' });
    assert.equal(transmitted.length, 2);
    assert.deepEqual(capture.read('reply-a'), readSentPrompt(transmitted[1].body));
    assert.equal(transmitted[0].body, transmitted[1].body);
    assert.doesNotMatch(JSON.stringify(capture.read('reply-a')), /synthetic-secret/);
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(request.send({ signal: stopped.signal }), { name: 'AbortError' });
    assert.equal(transmitted.length, 2);
    const second = payload(); second.messages[1].content = '另一个版本的提示词';
    await createPreparedPlayRequest(context, second, { promptCapture: capture }).send({ resultId: 'reply-b' });
    assert.deepEqual(capture.read('reply-b'), readSentPrompt(transmitted[2].body));
    assert.deepEqual(capture.read('reply-a'), readSentPrompt(transmitted[1].body));
    assert.equal(capture.read('missing'), null);
});

test('续写只替换当前版本的记录，较早的其他版本仍可查看，记录仅在页面内存中', () => {
    const capture = createSentPromptCapture();
    let updates = 0;
    const unsubscribe = capture.subscribe(() => updates++);
    capture.record('reply-a', JSON.stringify({ messages: [{ role: 'user', content: '首次生成' }] }));
    capture.record('reply-b', JSON.stringify({ messages: [{ role: 'user', content: '另一个版本' }] }));
    capture.record('reply-a', JSON.stringify({ messages: [{ role: 'user', content: '续写的实际发送' }] }));
    assert.equal(capture.read('reply-a').messages[0].content, '续写的实际发送');
    assert.equal(capture.read('reply-b').messages[0].content, '另一个版本');
    for (let index = 0; index < 25; index++) capture.record(`later-${index}`, JSON.stringify(payload()));
    assert.equal(capture.read('reply-b').messages[0].content, '另一个版本', '不因后续发送而丢失旧版本提示词');
    const snapshot = capture.read('reply-a'); snapshot.messages[0].content = '改变读取结果';
    assert.equal(capture.read('reply-a').messages[0].content, '续写的实际发送');
    const freshPage = createSentPromptCapture(); assert.equal(freshPage.read('reply-a'), null);
    assert.equal(updates, 28); unsubscribe();
    capture.dispose(); capture.record('reply-a', JSON.stringify(payload()));
    assert.equal(capture.read('reply-a'), null); assert.equal(updates, 28);
});

test('酒馆拒绝真实生成请求时保留原始错误，提示词查看自身不发送验证请求', async t => {
    const capture = createSentPromptCapture();
    let calls = 0;
    const context = { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), extractMessageFromData: data => data.text };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls++;
        assert.equal(url, '/api/backends/chat-completions/generate');
        assert.deepEqual(options.headers, context.getRequestHeaders());
        return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
    });
    await assert.rejects(createPreparedPlayRequest(context, payload(), { promptCapture: capture }).send({ resultId: 'reply-a' }),
        error => error.status === 403 && error.message === 'Forbidden');
    assert.equal(calls, 1);
    assert.deepEqual(capture.read('reply-a'), readSentPrompt(JSON.stringify(payload())));
});
