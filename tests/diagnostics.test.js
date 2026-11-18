import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, observePluginErrors, serializeDiagnosticResponse } from '../diagnostics.js';

function fixture(options = {}) {
    const files = new Map();
    const storage = { getItem: key => files.get(key) ?? null, setItem: (key, value) => files.set(key, value) };
    return { files, storage, logs: createDiagnostics({ storage, ...options }) };
}

test('保留错误文字、堆栈和原因，认证和无关请求内容不进入日志或导出', () => {
    const { logs, files } = fixture();
    const trace = logs.start('小剧场生成', { apiMode: 'custom', messages: ['不应记录的提示词'], settings: { key: 'hidden' } }, ['private-test-secret']);
    trace.update({ phase: 'generating', endpoint: 'https://account:password@example.invalid/v1?token=url-secret', stream: true });
    const cause = new Error('远端连接关闭'); cause.code = 'ECONNRESET';
    const error = new Error('socket hang up\nAuthorization: Bearer private-test-secret\n接口返回的完整第二行', { cause });
    error.request = { messages: ['不应记录的提示词'], key: 'private-test-secret' };
    trace.finish('failed', error);
    const exported = logs.export();
    assert.match(exported, /socket hang up/); assert.match(exported, /完整第二行/);
    assert.match(exported, /ECONNRESET/);
    assert.ok(exported.includes(logs.read().entries.at(-1).error.stack));
    assert.doesNotMatch(exported, /private-test-secret|url-secret|account:password|不应记录的提示词/);
    assert.doesNotMatch([...files.values()].join(''), /private-test-secret|url-secret|不应记录的提示词/);
});

test('刷新保留原记录，不从残留状态推断失败；只保留指定数量', () => {
    const { logs, storage } = fixture({ limit: 2 });
    logs.error('旧错误', '旧内容'); logs.error('新错误', '新内容'); logs.start('还在生成');
    const loaded = createDiagnostics({ storage, limit: 2 }).read().entries;
    assert.equal(loaded.length, 2); assert.equal(loaded[1].message, '开始');
    assert.equal(loaded[1].level, 'info'); assert.equal(loaded[0].error.message, '新内容');
    assert.doesNotMatch(JSON.stringify(loaded), /上次未正常结束/);
});

test('清空后迟到的请求结束不会把旧日志重新加回来', () => {
    const { logs } = fixture();
    const pending = logs.start('进行中的请求'); logs.clear();
    pending.update({ receivedCharacters: 10 }); pending.finish('failed', new Error('迟到错误'));
    assert.equal(logs.read().entries.length, 0);
});

test('存储失败仍可查看和导出完整错误，循环原因不会阻断日志', () => {
    const storage = { getItem: () => null, setItem: () => { throw Error('storage disabled'); } };
    const logs = createDiagnostics({ storage }), error = new Error('完整错误'); error.cause = error;
    logs.error('操作', error);
    assert.match(logs.read().persistenceError, /导出/);
    assert.match(logs.export(), /完整错误/); assert.match(logs.export(), /循环引用/);
});

test('普通操作、警告和生成节点按发生顺序记录，流式片段不刷屏', () => {
    let tick = 0;
    const { logs } = fixture({ now: () => new Date(Date.UTC(2026, 9, 13, 0, 0, tick++)).toISOString() });
    logs.info('打开插件设置');
    const pending = logs.start('小剧场生成', { phase: 'preparing' });
    logs.warn('读取头像，已使用默认显示', new Error('头像不可用'));
    pending.update({ phase: 'generating' });
    pending.update({ firstContentAt: '2026-10-13T00:00:05Z', receivedCharacters: 1 });
    for (let length = 2; length < 100; length++) pending.update({ receivedCharacters: length });
    logs.error('保存亲笔手稿', new Error('HTTP 507', { cause: new Error('磁盘已满') }));
    pending.finish('complete', null, { receivedCharacters: 100 });
    const entries = logs.read().entries;
    assert.deepEqual(entries.map(entry => [entry.operation, entry.level, entry.message]), [
        ['打开插件设置', 'info', ''], ['小剧场生成', 'info', '开始'], ['读取头像，已使用默认显示', 'warn', ''],
        ['小剧场生成', 'info', '已发出生成请求'], ['小剧场生成', 'info', '首次收到正文'],
        ['保存亲笔手稿', 'error', ''], ['小剧场生成', 'info', '已完成'],
    ]);
    assert.deepEqual(entries.map(entry => entry.at), entries.map(entry => entry.at).toSorted());
    assert.equal(entries.at(-1).receivedCharacters, 100);
    assert.equal(entries.some(entry => entry.pending), false);
});

test('旧版生成记录转成时间日志，保留原错误与请求时间', () => {
    const { files, storage } = fixture();
    files.set('teahouse-diagnostics-v1', JSON.stringify([
        { id: 'old-running', operation: '旧生成', startedAt: '2026-10-13T00:00:00Z', status: 'running' },
        { id: 'old-error', operation: '读取手稿', startedAt: '2026-10-12T00:00:00Z',
            finishedAt: '2026-10-12T00:00:01Z', status: 'failed', error: { message: '旧错误', stack: '旧调用位置' } },
    ]));
    const logs = createDiagnostics({ storage });
    const entries = logs.read().entries;
    assert.equal(entries[0].at, '2026-10-12T00:00:01Z'); assert.equal(entries[0].error.stack, '旧调用位置');
    assert.equal(entries[1].message, 'running');
    logs.info('新日志');
    assert.equal(createDiagnostics({ storage }).read().entries[0].error.message, '旧错误');
});

test('错误直接显示原文和原堆栈，操作名称不包在外面，导出为连续文本', () => {
    const { logs } = fixture({ now: () => '2026-10-13T12:00:00.000Z' });
    logs.info('打开插件设置');
    const error = new Error('request to https://EXAMPLE.invalid:443 failed, reason: socket hang up');
    error.name = 'FetchError';
    error.stack = `FetchError: ${error.message}\n    at ClientRequest.<anonymous> (index.js:123:45)\n\n完整的后续原文`;
    error.code = 'ECONNRESET';
    logs.error('不应该出现的分类标题', error);
    assert.equal(logs.export(), '[2026-10-13T12:00:00.000Z] [info] 打开插件设置\n\n'
        + `[2026-10-13T12:00:00.000Z] [error] ${error.stack}\ncode: ECONNRESET`);
    assert.doesNotMatch(logs.export(), /不应该出现的分类标题|类型：|信息：|调用位置：|完整错误：|"entries"/);
});

test('原错误信息不在堆栈中时两者都完整保留，缺少文字时不编造解释', () => {
    const { logs } = fixture();
    logs.error('不会显示的外层标题', { message: '完整原始第一行\r\n  保留缩进和换行', stack: '自定义原始堆栈', code: 500 });
    logs.error('另一个不会显示的外层标题', {});
    const exported = logs.export();
    assert.ok(exported.includes('完整原始第一行\r\n  保留缩进和换行\n自定义原始堆栈\ncode: 500'));
    assert.match(exported, /\[error\] \{\}$/);
    assert.doesNotMatch(exported, /不会显示的外层标题|错误未提供文字说明/);
});

test('正在进行的操作被较旧日志上限移出后仍能记录结果，清空后则不恢复旧操作', () => {
    const { logs } = fixture({ limit: 2 });
    const pending = logs.start('生成');
    logs.info('其他操作一'); logs.info('其他操作二');
    pending.finish('complete');
    assert.equal(logs.read().entries.at(-1).message, '已完成');
    const old = logs.start('旧操作'); logs.clear(); logs.info('清空后的新操作');
    old.update({ phase: 'generating' }); old.finish('failed', new Error('旧错误'));
    assert.equal(logs.read().entries.length, 1);
});

test('日志订阅可取消，查看器错误不会中断插件操作', () => {
    const { logs } = fixture();
    let calls = 0;
    const stop = logs.subscribe(() => calls++);
    logs.subscribe(() => { throw Error('查看器测试错误'); });
    logs.info('开始'); logs.clear(); assert.equal(calls, 2);
    stop(); logs.error('保存', new Error('失败')); assert.equal(calls, 2);
});

test('捕捉插件自己的意外错误与异步错误，不收集酒馆或其他插件错误', () => {
    const { logs } = fixture(), target = new EventTarget();
    const root = 'https://local.test/extensions/teahouse/';
    const stop = observePluginErrors(logs, { target, root });
    const dispatch = (type, fields) => target.dispatchEvent(Object.assign(new Event(type), fields));
    const ownError = new Error('按钮运行失败'); ownError.stack = `Error: 按钮运行失败\n at ${root}panel.js:10:3`;
    const hostError = new Error('其他插件失败'); hostError.stack = 'at https://local.test/extensions/other/index.js:10:3';
    dispatch('error', { error: ownError, filename: root + 'panel.js', lineno: 10, colno: 3 });
    dispatch('unhandledrejection', { reason: new Error('异步失败', { cause: ownError }) });
    dispatch('error', { error: hostError, filename: 'https://local.test/script.js' });
    dispatch('unhandledrejection', { reason: hostError });
    dispatch('unhandledrejection', { reason: '无法确认来源的错误' });
    assert.equal(logs.read().entries.length, 2);
    assert.equal(logs.read().entries[0].file, root + 'panel.js');
    assert.equal(logs.read().entries[1].error.cause.message, '按钮运行失败');
    stop(); dispatch('unhandledrejection', { reason: ownError });
    assert.equal(logs.read().entries.length, 2);
});

test('默认保留最近五百条，各级日志都按时间先后淘汰，刷新后保持一致', () => {
    const { logs, storage } = fixture();
    logs.error('最早的错误', new Error('保留最早错误'));
    for (let i = 0; i < 505; i++) logs.info(`操作 ${i}`);
    assert.equal(logs.read().limit, 500);
    assert.equal(logs.read().entries.length, 500);
    const loaded = createDiagnostics({ storage });
    assert.equal(loaded.read().entries.length, 500);
    assert.doesNotMatch(loaded.export(), /保留最早错误/);
    assert.equal(loaded.read().entries[0].operation, '操作 5');
    assert.match(loaded.export(), /操作 504/);
});

test('连一条日志也无法保存时不清空已有日志，仍能导出并记录存储原始错误', () => {
    const { logs, storage } = fixture();
    logs.error('旧错误', new Error('旧错误全文'));
    const saved = storage.getItem('teahouse-diagnostics-v1');
    storage.setItem = () => { throw new DOMException('browser quota full', 'QuotaExceededError'); };
    logs.error('新错误', new Error('新错误全文'));
    assert.equal(storage.getItem('teahouse-diagnostics-v1'), saved);
    assert.match(logs.read().persistenceError, /导出/);
    for (const expected of [/旧错误全文/, /新错误全文/, /QuotaExceededError/, /browser quota full/]) assert.match(logs.export(), expected);
});

test('全部是错误和警告时淘汰最早的一条，不截短保留的错误', () => {
    const { logs, storage } = fixture({ limit: 3 });
    logs.error('最早错误', new Error('old failure'));
    logs.warn('警告', new Error('warning details'));
    logs.error('第二个错误', new Error('second failure'));
    const error = new Error('latest failure\n' + '完整后续原文\n'.repeat(100));
    logs.error('最新错误', error);
    const entries = createDiagnostics({ storage, limit: 3 }).read().entries;
    assert.deepEqual(entries.map(entry => entry.operation), ['警告', '第二个错误', '最新错误']);
    assert.equal(entries.at(-1).error.message, error.message); assert.equal(entries.at(-1).error.stack, error.stack);
});

test('读取旧版未限制条数的日志时同样只保留最新记录，顺序保持不变', () => {
    const { storage } = fixture();
    storage.setItem('teahouse-diagnostics-v1', JSON.stringify([
        { id: 'warning', at: '2026-10-23T00:00:00Z', level: 'warn', error: { message: 'old warning' } },
        { id: 'ordinary', at: '2026-10-23T00:00:01Z', level: 'info', operation: 'old ordinary' },
        { id: 'error', at: '2026-10-23T00:00:02Z', level: 'error', error: { message: 'new failure' } },
        { id: 'latest', at: '2026-10-23T00:00:03Z', level: 'info', operation: 'latest ordinary' },
    ]));
    const entries = createDiagnostics({ storage, limit: 3 }).read().entries;
    assert.deepEqual(entries.map(entry => entry.id), ['ordinary', 'error', 'latest']);
});

test('浏览器提前存满时按顺序删旧记录后重试，保存后查看和导出与实际存储一致', () => {
    const { logs, storage } = fixture();
    logs.error('旧错误', new Error('old failure'));
    logs.info('旧普通记录'); logs.info('新普通记录');
    const write = storage.setItem;
    storage.setItem = (key, text) => {
        if (JSON.parse(text).length > 2) throw new DOMException('browser quota full', 'QuotaExceededError');
        write(key, text);
    };
    logs.error('新错误', new Error('new failure'));
    assert.equal(logs.read().persistenceError, '');
    assert.deepEqual(logs.read().entries.map(entry => entry.operation), ['新普通记录', '新错误']);
    assert.equal(logs.export(), createDiagnostics({ storage }).export());
});

test('浏览器只能保存一条错误时保留最新错误全文，普通存储故障不会触发删记录', () => {
    const { logs, storage } = fixture();
    logs.error('旧错误', new Error('old failure'));
    const write = storage.setItem;
    storage.setItem = (key, text) => {
        if (JSON.parse(text).length > 1) throw new DOMException('browser quota full', 'QuotaExceededError');
        write(key, text);
    };
    logs.error('新错误', new Error('new failure'));
    assert.equal(logs.read().entries.length, 1); assert.match(logs.export(), /new failure/);
    assert.doesNotMatch(logs.export(), /old failure/);
    storage.setItem = () => { throw new Error('storage disabled'); };
    logs.error('再一个错误', new Error('another failure'));
    assert.match(logs.export(), /new failure/); assert.match(logs.export(), /another failure/);
});

test('保留网络错误附带字段、嵌套接口详情和聚合错误，过滤请求与配置容器', () => {
    const { logs, storage } = fixture();
    const network = new Error('connect failed');
    Object.assign(network, { errno: -4078, syscall: 'connect', address: '127.0.0.1', port: 9000 });
    const error = new AggregateError([network, new Error('second failure')], 'multiple failures');
    error.detail = { type: 'gateway_error', request_id: 'r-55', retryable: true,
        metadata: { provider: 'test-provider', config: { api_key: 'private-secret' } } };
    error.response = { content: 'private reply' }; error.request = { messages: ['private prompt'] };
    logs.error('请求失败', error);
    const exported = createDiagnostics({ storage }).export();
    for (const text of ['connect failed', 'second failure', 'errno: -4078', 'syscall: connect', '127.0.0.1', '9000', 'r-55', 'test-provider']) {
        assert.ok(exported.includes(text), text);
    }
    assert.doesNotMatch(exported, /private-secret|private reply|private prompt/);
});

test('JSON 解析错误保留类型和调用位置，隐藏浏览器自动附带的原文片段', () => {
    const { logs } = fixture();
    try { JSON.parse('private reply text that must not be logged'); }
    catch (error) { logs.error('解析回复', error); }
    assert.match(logs.export(), /SyntaxError/); assert.match(logs.export(), /diagnostics.test.js/);
    assert.doesNotMatch(logs.export(), /private reply/);
});

test('相同错误被多处引用时保留每处信息，不误判为循环引用', () => {
    const { logs } = fixture();
    const cause = new Error('same underlying failure');
    const error = new AggregateError([cause, cause], 'request failures', { cause });
    logs.error('请求失败', error);
    const saved = logs.read().entries[0].error;
    assert.equal(saved.errors[0].stack, cause.stack); assert.equal(saved.errors[1].stack, cause.stack);
    assert.equal(saved.cause.stack, cause.stack); assert.doesNotMatch(logs.export(), /循环引用/);
});

test('显示观察只记录允许的标量，密集事件不逐次写存储，导出和刷新保留同一时间线', () => {
    const { logs, storage } = fixture();
    let writes = 0;
    const set = storage.setItem;
    storage.setItem = (...args) => { writes++; set(...args); };
    for (let sequence = 1; sequence <= 40; sequence++) logs.view('显示观察：记录读取完成', {
        session: 'qa-1', sequence, ordinal: sequence, durationMs: sequence * 3,
        text: '私密正文', characterName: '私密角色', settings: { password: '私密密钥' },
        resource: { url: 'https://private.invalid/secret' }, headers: { Authorization: 'Bearer secret' },
    });
    assert.equal(writes, 0, '密集显示事件先留在内存，避免渲染回调同步写入');
    logs.error('读取失败', new Error('actual read failure'));
    assert.equal(writes, 1, '原始错误和前面的观察一同保存');
    logs.view('显示观察：结束本次打开', { sequence: 41, session: 'qa-1' });
    const exported = logs.export();
    assert.equal(writes, 2, '导出前保存尚未写入的观察');
    assert.match(exported, /"ordinal":40/); assert.match(exported, /actual read failure/);
    assert.doesNotMatch(exported, /私密|private.invalid|secret|Authorization/);
    assert.equal(createDiagnostics({ storage }).export(), exported);
});

test('清空日志取消待保存观察，存储失败仍能导出观察', () => {
    const { logs, storage } = fixture();
    logs.view('旧观察', { sequence: 1 }); logs.clear(); logs.flush();
    assert.equal(logs.export(), '');
    storage.setItem = () => { throw Error('storage disabled'); };
    logs.view('新观察', { sequence: 2 }); logs.flush();
    assert.match(logs.export(), /新观察/); assert.match(logs.read().persistenceError, /导出/);
});

test('收到的响应只移除回复与思考文字、回显提示词和凭据，其它字段及结构完整保留', () => {
    const original = {
        vendor_future: { flags: ['new-control', 'another-control'], nested: [{ state: 'future-state', value: 7 }], context: 'keep-context' },
        choices: [{ delta: { content: 'private story', reasoning_content: 'private reasoning', refusal: 'private refusal',
            tool_calls: [{ id: 'call-id', function: { name: 'syntheticTool', arguments: 'private arguments' } }] },
            finish_reason: 'stop', logprobs: { content: [{ token: 'private token', bytes: [112, 114, 105], logprob: -0.2 }] } }],
        candidates: [{ index: 0, finishReason: 'STOP', safetyRatings: [{ category: 'TEST', probability: 'LOW' }],
            content: { role: 'model', parts: [{ text: 'private gemini story', thought: true, thoughtSignature: 'private signature' },
                { inlineData: { mimeType: 'image/png', data: 'private base64' } },
                { functionCall: { name: 'syntheticTool', args: { privateArgument: 'private argument value' } } }] } }],
        content_block: { type: 'thinking', thinking: 'private claude thought', signature: 'private claude signature' },
        reasoning_details: [{ type: 'reasoning.summary', summary: 'private thought summary', format: 'text', index: 0 }],
        rich: { text: { value: 'private rich text', annotations: [{ kind: 'citation', index: 0 }] } },
        futureOutputText: 'private future body', data: [112, 114, 105],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 60, thoughtsTokenCount: 20 },
        headers: { 'x-new-diagnostic': 'header-control', 'set-cookie': 'private cookie', 'x-api-key': 'private key' },
        echo: { request: { prompt: 'private prompt' }, settings: { password: 'private password' } },
        error: { message: 'original provider failure\nsecond line', summary: 'provider error summary', code: 'new-code', future: { phase: 'upstream' } },
    };
    const before = structuredClone(original), result = serializeDiagnosticResponse(original);
    assert.deepEqual(result.vendor_future, before.vendor_future);
    assert.deepEqual(result.usageMetadata, before.usageMetadata);
    assert.equal(result.choices[0].finish_reason, 'stop'); assert.equal(result.choices[0].logprobs.content[0].logprob, -0.2);
    assert.equal(result.candidates[0].content.role, 'model'); assert.equal(result.candidates[0].content.parts[0].thought, true);
    assert.deepEqual(result.candidates[0].safetyRatings, before.candidates[0].safetyRatings);
    assert.equal(result.candidates[0].content.parts[1].inlineData.mimeType, 'image/png');
    assert.equal(result.choices[0].delta.tool_calls[0].function.name, 'syntheticTool');
    assert.deepEqual(result.error, before.error); assert.equal(result.headers['x-new-diagnostic'], 'header-control');
    assert.equal(result.reasoning_details[0].summary, '[正文已移除]'); assert.equal(result.reasoning_details[0].format, 'text');
    assert.equal(result.choices[0].delta.content, '[正文已移除]'); assert.equal(result.futureOutputText, original.futureOutputText);
    const expected = structuredClone(original);
    expected.choices[0].delta.content = '[正文已移除]'; expected.choices[0].delta.reasoning_content = '[正文已移除]';
    expected.choices[0].delta.refusal = '[正文已移除]'; expected.choices[0].logprobs.content[0].token = '[正文已移除]';
    expected.choices[0].logprobs.content[0].bytes = '[正文已移除]'; expected.candidates[0].content.parts[0].text = '[正文已移除]';
    expected.content_block.thinking = '[正文已移除]'; expected.reasoning_details[0].summary = '[正文已移除]';
    expected.headers['set-cookie'] = '[已隐藏]'; expected.headers['x-api-key'] = '[已隐藏]';
    expected.echo.request.prompt = '[内容已移除]'; expected.echo.settings.password = '[已隐藏]';
    assert.deepEqual(result, expected);
    const raw = serializeDiagnosticResponse({ kind: 'event', parsed: false, raw: JSON.stringify(original) }).raw;
    assert.deepEqual(JSON.parse(raw), expected);
    assert.deepEqual(original, before);
});

test('错误文字、参数、媒体、签名及未知 text/content 字段完整保留，配置只隐藏提示词和凭据', () => {
    const original = {
        choices: [{ delta: { content: 'hidden final body', reasoning_content: 'hidden thought',
            tool_calls: [{ function: { name: 'syntheticTool', arguments: JSON.stringify({ text: 'tool text',
                content: 'tool content', prompt: 'generated tool prompt', key: 'tool option' }) } }] } }],
        candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'hidden gemini thought', thoughtSignature: 'keep-thought-signature' },
            { text: 'hidden gemini body', thoughtSignature: 'keep-final-signature' },
            { inlineData: { mimeType: 'image/png', data: 'data:image/png;base64,synthetic-media' } }] } }],
        usageMetadata: { thoughtsTokenCount: 80, candidatesTokenCount: 100 },
        key: 'response metadata key',
        error: { key: 'error metadata key', text: 'complete error text', content: 'complete error content', summary: 'complete error summary',
            detail: { text: 'nested error text', body: 'nested error body' } },
        future: { text: 'unknown metadata text', content: 'unknown metadata content', summary: 'unknown summary',
            key: 'metadata key', signature: 'metadata signature', bytes: [1, 2, 3] },
        request: { model: 'synthetic-model', key: 'hidden-request-key', temperature: 0.8, messages: [{ role: 'user', content: 'hidden prompt' }],
            headers: { Authorization: 'Bearer hidden-secret', 'x-trace': 'keep-header' },
            config: { retry_after: 9, unknown: ['keep-config'], api_key: 'hidden-secret' } },
    };
    const expected = structuredClone(original);
    expected.choices[0].delta.content = '[正文已移除]'; expected.choices[0].delta.reasoning_content = '[正文已移除]';
    expected.candidates[0].content.parts[0].text = '[正文已移除]'; expected.candidates[0].content.parts[1].text = '[正文已移除]';
    expected.request.messages = '[内容已移除]'; expected.request.headers.Authorization = '[已隐藏]';
    expected.request.config.api_key = '[已隐藏]'; expected.request.key = '[已隐藏]';
    const result = serializeDiagnosticResponse(original);
    assert.deepEqual(result, expected);
    const raw = serializeDiagnosticResponse({ kind: 'event', raw: JSON.stringify(original) }).raw;
    assert.deepEqual(JSON.parse(raw), expected);
    assert.deepEqual(serializeDiagnosticResponse(result), result);
});

test('截断原始 JSON 和 SSE 仅剔除回复、思考和回显敏感内容，其余原文保留', () => {
    const raw = 'data: {"future":{"text":"keep metadata","count":7},"choices":[{"delta":{"reasoning_content":"hidden thought",'
        + '"tool_calls":[{"function":{"arguments":"keep arguments"}}],"content":"hidden incomplete final body';
    const received = serializeDiagnosticResponse({ kind: 'stream-end', tail: { delimited: false, parsed: false, raw } });
    assert.equal(received.tail.raw, 'data: {"future":{"text":"keep metadata","count":7},"choices":[{"delta":{"reasoning_content":"[正文已移除]",'
        + '"tool_calls":[{"function":{"arguments":"keep arguments"}}],"content":"[正文已移除]');
    const prompt = '{"request":{"model":"keep-model","prompt":"hidden incomplete prompt';
    assert.equal(serializeDiagnosticResponse({ kind: 'body', parsed: false, raw: prompt }).raw,
        '{"request":{"model":"keep-model","prompt":"[内容已移除]');
    const credential = '{"error":{"code":500,"api_key":"hidden incomplete credential';
    assert.equal(serializeDiagnosticResponse({ kind: 'body', parsed: false, raw: credential }).raw,
        '{"error":{"code":500,"api_key":"[已隐藏]');
});

test('未知对象键安全保留，正文样式的错误详情和纯文本错误不会被误删', () => {
    const original = JSON.parse('{"constructor":"keep-constructor","__proto__":{"text":"keep-prototype-text"},"prototype":"keep-prototype"}');
    const result = serializeDiagnosticResponse(original);
    assert.deepEqual(result, original); assert.equal(Object.getPrototypeOf(result), Object.prototype);
    for (const raw of ['504 Gateway Timeout upstream socket hang up', '<html><body>502 ECONNRESET</body></html>',
        '{"error":{"text":"upstream error text","content":"upstream error content"}}']) {
        assert.equal(serializeDiagnosticResponse({ kind: 'event', parsed: false, raw }).raw, raw);
    }
});

test('带错误状态的顶层 text/content 是接口错误信息，结构化与原始记录都完整保留', () => {
    for (const original of [{ status: 503, text: 'complete upstream error', content: 'complete error detail' },
        { code: 429, text: 'complete quota error' }, { status: 'UNAVAILABLE', text: 'complete service error' }]) {
        assert.deepEqual(serializeDiagnosticResponse(original), original);
        const raw = JSON.stringify(original);
        assert.equal(serializeDiagnosticResponse({ kind: 'event', raw }).raw, raw);
    }
});

test('接口未知字段与日志内部字段同名时不被误认为日志包装，查看和刷新均完整保留', () => {
    const original = { choices: [{ delta: { content: 'hidden final story' } }],
        future: { kind: 'event', parsed: true, delimited: false,
            data: { text: 'unknown text metadata', content: 'unknown content metadata', summary: 'unknown summary metadata' },
            values: [{ data: { text: 'unknown nested text' }, parsed: true }] } };
    const expected = structuredClone(original); expected.choices[0].delta.content = '[正文已移除]';
    assert.deepEqual(serializeDiagnosticResponse(original), expected);
    assert.deepEqual(JSON.parse(serializeDiagnosticResponse({ kind: 'event', raw: JSON.stringify(original) }).raw), expected);
    const { logs, storage } = fixture();
    const trace = logs.start('小剧场生成', { requestId: 'unknown-name-request', attempt: 1 });
    trace.receiver()({ kind: 'event', data: original }); trace.finish('complete');
    assert.deepEqual(logs.read().entries.find(entry => entry.received).received[0].data.data, expected);
    const loaded = createDiagnostics({ storage });
    assert.equal(loaded.export(), logs.export());
    assert.deepEqual(loaded.read().entries.find(entry => entry.received).received[0].data.data.future, original.future);
});

test('响应批量记录保留超过五百条消息的全部非正文变化，查看和导出不逐包写存储', () => {
    const { logs, storage } = fixture();
    const trace = logs.start('小剧场生成', { requestId: 'synthetic-request', attempt: 1 });
    const receive = trace.receiver();
    let writes = 0; storage.setItem = () => { writes++; };
    for (let sequence = 0; sequence < 1000; sequence++) receive({ kind: 'event',
        data: { content: `private story ${sequence}`, future: { index: sequence, flag: 'new-field' } } });
    assert.equal(writes, 0);
    const packets = logs.read().entries.flatMap(entry => entry.received ?? []);
    assert.deepEqual(packets.map(packet => packet.data.data.future.index), Array.from({ length: 1000 }, (_, index) => index));
    assert.ok(logs.read().count < 1000);
    const error = new Error('original read failure'); trace.finish('failed', error);
    assert.equal(writes, 1);
    const exported = logs.export(); assert.doesNotMatch(exported, /private story/);
    const loaded = createDiagnostics({ storage: { getItem: () => JSON.stringify(logs.read().entries), setItem() {} } });
    assert.equal(loaded.export(), exported);
    assert.equal(loaded.read().entries.at(-1).error.message, 'original read failure');
    assert.ok(exported.indexOf('"index": 999') < exported.indexOf(error.stack));
});

test('完全相同的非正文响应合并次数，已查看记录不再修改，重试和并发请求分别编号', () => {
    const { logs } = fixture();
    const first = logs.start('小剧场生成', { requestId: 'first', attempt: 1 });
    const second = logs.start('小剧场生成', { requestId: 'second', attempt: 1 });
    const receiveFirst = first.receiver(), receiveSecond = second.receiver();
    for (const content of ['private one', 'private two', 'private three']) receiveFirst({ kind: 'event', data: { content, future: 'same' } });
    const viewed = logs.read().entries.find(entry => entry.received);
    assert.equal(viewed.received[0].count, 3); assert.equal(viewed.received[0].sequence, 1);
    assert.equal(viewed.received[0].lastSequence, 3);
    receiveFirst({ kind: 'event', data: { content: 'private four', future: 'same' } });
    receiveSecond({ kind: 'event', data: { content: 'private second', future: 'same' } });
    first.update({ attempt: 2 }); first.receiver()({ kind: 'event', data: { content: 'private retry', future: 'same' } });
    const entries = logs.read().entries.filter(entry => entry.received);
    assert.deepEqual(entries.map(entry => [entry.requestId, entry.attempt, entry.received[0].sequence]),
        [['first', 1, 1], ['first', 1, 4], ['second', 1, 1], ['first', 2, 1]]);
    assert.equal(entries[0].received[0].count, 3);
    logs.clear(); receiveFirst({ data: { future: 'late-old-data' } }); logs.flush();
    assert.equal(logs.export(), '');
});

test('迟到的接口结束信息保留原请求编号和重试次数，操作结束后仍脱敏，清空后不恢复', () => {
    const { logs } = fixture();
    const trace = logs.start('小剧场生成', { requestId: 'synthetic-request', attempt: 1 }, ['synthetic-secret']);
    const first = trace.receiver(); trace.update({ attempt: 2 });
    const second = trace.receiver(); trace.finish('stopped');
    first({ kind: 'stream-end', future: 'late-first', credential_echo: 'synthetic-secret' });
    second({ kind: 'stream-end', future: 'late-second', credential_echo: 'synthetic-secret' });
    const entries = logs.read().entries.filter(entry => entry.received);
    assert.deepEqual(entries.map(entry => [entry.requestId, entry.attempt, entry.received[0].sequence]),
        [['synthetic-request', 1, 1], ['synthetic-request', 2, 1]]);
    assert.doesNotMatch(logs.export(), /synthetic-secret/);
    logs.clear(); first({ kind: 'stream-end' }); second({ kind: 'stream-end' });
    assert.equal(logs.export(), '');
});

test('错误附带的接口响应采用同一内容过滤规则，保留原错误及接口未知字段', () => {
    const { logs } = fixture();
    const error = new Error('original upstream error');
    error.error = { error: { message: 'original upstream error', summary: 'diagnostic error summary', future: { code: 'new-provider-code' } },
        reasoning_details: [{ type: 'reasoning.summary', summary: 'private reasoning summary', format: 'text' }],
        choices: [{ delta: { content: 'private response content' } }] };
    logs.error('请求失败', error);
    const exported = logs.export();
    assert.match(exported, /original upstream error/); assert.match(exported, /diagnostic error summary|new-provider-code|reasoning.summary/);
    assert.doesNotMatch(exported, /private reasoning summary|private response content/);
});
