import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNativePlayPreparer } from '../play-prompt.js';
import { capturePlayEnvironment } from '../play-runtime.js';
import { DEFAULT_PLAY_PROMPT } from '../play-settings.js';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { testStreaming, streamResponse } from './play-fixture.js';

let sendResponse;
beforeEach(t => t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/backends/chat-completions/generate');
    return sendResponse(JSON.parse(options.body), options.signal);
}));

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

for (const squash of [false, true]) test(`自定义提示词在发送前回调之后仍位于最前面且只出现一次，合并系统消息=${squash}`, async () => {
    const f = fixture(); f.context.chatCompletionSettings.squash_system_messages = squash;
    f.source.on(f.events.GENERATE_AFTER_DATA, data => data.prompt.unshift({ role: 'system', content: '拼装后的扩展内容' }));
    f.source.on(f.events.CHAT_COMPLETION_SETTINGS_READY, data => data.messages.unshift({ role: 'system', content: '最后回调的内容' }));
    const options = f.options(); options.environment.playPrompt = '只写{{user}}的小剧场';
    const request = await f.prepare(options); await request.send({ signal: new AbortController().signal });
    const messages = f.requests[0].payload.messages;
    assert.equal(messages[0].role, 'system'); assert.ok(messages[0].content.startsWith('只写用户的小剧场'));
    assert.equal(messages.map(message => message.content).join('\n').split('只写用户的小剧场').length, 2);
    assert.equal(f.assemblies[0].leadingSystemPrompt, '只写用户的小剧场', '提前交给预设拼装预留长度');
    assert.equal(messages[squash ? 1 : 2].content, '拼装后的扩展内容');
});

test('清空自定义提示词后不附加，发送时捕获的提示词不会被后来修改覆盖', async () => {
    const f = fixture();
    const settings = { playPrompt: '最前面的已保存内容' };
    const environment = capturePlayEnvironment(f.context, settings); settings.playPrompt = '后来修改';
    const request = await f.prepare({ ...f.options(), environment }); await request.send({ signal: new AbortController().signal });
    assert.equal(f.requests[0].payload.messages[0].content, '最前面的已保存内容');
    settings.playPrompt = '';
    const cleared = await f.prepare({ ...f.options(), environment: capturePlayEnvironment(f.context, settings) });
    await cleared.send({ signal: new AbortController().signal });
    assert.equal(f.requests[1].payload.messages[0].content, '当前预设 / 角色说明 / 用户人设');
    assert.equal(f.assemblies[1].leadingSystemPrompt, '');
});

for (const position of ['user-before', 'user-after']) {
    for (const continuation of [false, true]) test(`提示词在本次用户消息内部，位置=${position}，续写=${continuation}`, async () => {
        const f = fixture(), before = structuredClone(f.context.chat);
        const options = f.options();
        options.environment.playPrompt = '要求{{user}}【处理】'; options.environment.playPromptPosition = position;
        f.modules.regex.getRegexedString = text => text.replace('【处理】', '');
        const expected = position === 'user-before' ? '要求用户\n\n本次用户小剧场' : '本次用户小剧场\n\n要求用户';
        let scanned, intercepted;
        const scan = f.modules.world.getWorldInfoPrompt;
        f.modules.world.getWorldInfoPrompt = (...args) => { scanned = args[0]; return scan(...args); };
        f.modules.extensions.runGenerationInterceptors = history => { intercepted = structuredClone(history); return false; };
        if (continuation) { options.continueMessage = '需要续写的正文'; options.continueExtra = {}; }
        const request = await f.prepare(options); await request.send({ signal: new AbortController().signal });
        const messages = f.requests[0].payload.messages;
        assert.equal(messages.filter(message => message.role === 'user' && message.content === expected).length, 1);
        assert.equal(messages.filter(message => message.content.includes('要求用户')).length, 1, '同一要求只出现一次');
        assert.equal(f.assemblies[0].leadingSystemPrompt, '', '用户消息内的要求按消息长度计算，不另行预留系统提示词长度');
        assert.equal(intercepted.findLast(message => message.is_user).mes, expected);
        assert.ok(scanned.includes('用户: ' + expected), '拼接完成的用户消息进入原有世界书扫描');
        assert.deepEqual(f.context.chat, before, '主聊天原文保持原样');
    });
    test(`用户消息位置=${position}，留空时不拼接分隔符`, async () => {
        const f = fixture(), options = f.options();
        options.environment.playPrompt = ''; options.environment.playPromptPosition = position;
        const request = await f.prepare(options); await request.send({ signal: new AbortController().signal });
        assert.equal(f.requests[0].payload.messages.at(-1).content, '本次用户小剧场');
        assert.equal(f.assemblies[0].leadingSystemPrompt, '');
    });
}

test('续写正文和思维链使用 -1 深度；不加入较早思维链，也不改原文占位符', async () => {
    const f = fixture(), calls = [];
    f.context.powerUserSettings.reasoning = { add_to_prompts: true, max_additions: 10,
        prefix: '<think>', suffix: '</think>', separator: '\n' };
    f.context.chat[0].extra = { reasoning: '更早的主聊天思维链' };
    f.modules.regex.getRegexedString = (text, placement, options) => {
        calls.push({ text, placement, options });
        return options?.isPrompt ? text.replace('【发送前删除】', '') : text;
    };
    const before = structuredClone(f.context.powerUserSettings);
    const original = '待续写正文【发送前删除】';
    const options = { ...f.options(), continueMessage: original,
        continueExtra: { reasoning: '目标思维链【发送前删除】', api: 'openai', model: 'current-model' } };
    await f.prepare(options);
    const assembly = f.assemblies.at(-1);
    assert.equal(assembly.history.at(-1).mes, '<think>目标思维链</think>\n待续写正文');
    assert.equal(assembly.history[0].mes, '主聊天旧回复');
    assert.equal(assembly.cyclePrompt, original);
    assert.equal(assembly.cycleReasoning, '<think>目标思维链</think>\n');
    assert.deepEqual(calls.filter(call => call.options?.isPrompt).map(call => [call.text, call.options.depth]), [
        ['主聊天旧回复', 1], ['本次用户小剧场', 0], [original, -1], ['目标思维链【发送前删除】', -1],
    ]);
    assert.deepEqual(f.context.powerUserSettings, before, '酒馆主聊天的设置保持原值');
    calls.length = 0;
    await f.prepare(f.options());
    assert.equal(f.assemblies.at(-1).history[0].mes, '主聊天旧回复');
    assert.deepEqual(calls.filter(call => call.options?.isPrompt).map(call => call.options.depth), [1, 0]);
});

test('第二种提示词校验早于世界书、发送前回调与模型请求', async () => {
    const f = fixture();
    const options = f.options();
    options.environment.continuation = { mode: 'prompt', prompt: '缺少占位符' };
    await assert.rejects(f.prepare({ ...options, continueMessage: '待续写正文' }), error => error.code === 'invalid_continue_prompt');
    assert.deepEqual(f.order, []);
    assert.equal(f.requests.length, 0);
});

test('添加到提示词关闭或最大值为零时，续写仍发送目标自身的思维链', async () => {
    for (const addToPrompts of [false, true]) {
        const f = fixture();
        f.context.powerUserSettings.reasoning = { add_to_prompts: addToPrompts, max_additions: 0,
            prefix: '<think>', suffix: '</think>', separator: '\n' };
        await f.prepare({ ...f.options(), continueMessage: '原正文', continueExtra: { reasoning: '原生思维链' } });
        assert.equal(f.assemblies.at(-1).history.at(-1).mes, '<think>原生思维链</think>\n原正文');
    }
});

for (const mode of ['history', 'prompt']) for (const sendReasoning of [false, true]) {
    test(`续写原生思维链开关只改变发送前缀，保留正文 CoT 和已收思维链：方式=${mode}，开关=${sendReasoning}`, async () => {
        const f = fixture();
        f.context.powerUserSettings.reasoning = { add_to_prompts: false, max_additions: 0,
            prefix: '<think>', suffix: '</think>', separator: '\n' };
        const body = '<thinking>正文 CoT</thinking>\n剧情';
        const extra = { reasoning: '原生思维链', reasoning_signature: 'synthetic-signature', api: 'openai', model: 'current-model' };
        const before = structuredClone({ chat: f.context.chat, extra, power: f.context.powerUserSettings });
        const options = { ...f.options(), continueMessage: body, continueExtra: extra };
        options.environment.continuation = { mode, prompt: '接着写：{{lastChatMessage}}', sendReasoning };
        const request = await f.prepare(options), received = [];
        await request.send({ signal: options.signal, onReasoning: value => received.push(value) });
        const assembly = f.assemblies.at(-1), prefix = sendReasoning ? '<think>原生思维链</think>\n' : '';
        assert.equal(assembly.history.at(-1).mes, prefix + body);
        assert.equal(assembly.cycleReasoning, prefix);
        assert.equal(assembly.cyclePrompt, body);
        assert.equal(JSON.stringify(f.requests.at(-1).payload.messages).includes('原生思维链'), sendReasoning);
        assert.equal(received.at(-1).reasoning, extra.reasoning, '关闭发送不清空流式续写保留的原生思维链');
        assert.deepEqual({ chat: f.context.chat, extra, power: f.context.powerUserSettings }, before);
    });
}

function eventBus() {
    const listeners = new Map();
    const removeListener = (event, listener) => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== listener));
    return {
        listeners,
        on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
        makeFirst(event, listener) { removeListener(event, listener); listeners.set(event, [listener, ...(listeners.get(event) ?? [])]); },
        makeLast(event, listener) { removeListener(event, listener); this.on(event, listener); },
        removeListener,
        async emit(event, ...args) { for (const listener of [...(listeners.get(event) ?? [])]) await listener(...args); },
    };
}

function fixture() {
    const source = eventBus(), order = [], requests = [], assemblies = [];
    const events = {
        GENERATION_STARTED: 'start', GENERATION_AFTER_COMMANDS: 'before',
        GENERATE_AFTER_DATA: 'assembled', CHAT_COMPLETION_SETTINGS_READY: 'ready',
        GENERATION_ENDED: 'ended', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered',
    };
    const prompts = {
        DEPTH_PROMPT: { value: '原角色备注' },
        customDepthWI_5_0: { value: '上次世界书' },
        '2_floating_prompt': { value: '原作者注释' },
        unrelated: { value: '其他插件提示词', filter: () => true },
    };
    const context = {
        characterId: 0, chatId: 'main-a', mainApi: 'openai', name1: '用户', name2: '角色甲',
        characters: [{ name: '角色甲', avatar: 'A.png', data: { extensions: { depth_prompt: { depth: 3, role: 'system' } } } }],
        chat: [{ name: '角色甲', is_user: false, mes: '主聊天旧回复', variables: [{ stat_data: { value: 20 } }] }],
        chatCompletionSettings: { preset_settings: '当前预设' }, powerUserSettings: {},
        getCurrentChatId() { return this.chatId; }, symbols: { ignore: Symbol.for('ignore') },
        eventSource: source, eventTypes: events,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        extractMessageFromData: data => data.choices[0].message.content,
    };
    sendResponse = async (payload, signal) => {
        requests.push({ payload, signal });
        const content = '<UpdateVariable>value=80</UpdateVariable>\n<% 不执行回复 %>';
        return payload.stream ? streamResponse([{ choices: [{ delta: { content } }] }, '[DONE]'])
            : Response.json({ choices: [{ message: { content } }] });
    };
    const fields = { description: '角色说明', personality: '角色性格', persona: '用户人设', scenario: '场景',
        mesExamples: '角色示例', system: '角色主提示', jailbreak: '角色后置提示', charDepthPrompt: '本次角色备注', creatorNotes: '作者说明' };
    const modules = {
        core: {
            extension_prompts: prompts, extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1 },
            chat_metadata: {}, depth_prompt_depth_default: 4, depth_prompt_role_default: 'system',
            getCharacterCardFields() { order.push('fields'); return fields; },
            getExtensionPromptRoleByName: () => 0,
            setExtensionPrompt(key, value, position, depth, scan, role) { prompts[key] = { value, position, depth, scan, role }; },
            substituteParams: text => text.replaceAll('{{user}}', '用户'),
            baseChatReplace: text => text,
            parseMesExamples: text => [text], getMaxContextSize: () => 32000,
            getBiasStrings: () => ({ promptBias: '' }),
        },
        openai: {
            getStreamingReply: testStreaming.getStreamingReply,
            oai_settings: { preset_settings: '当前预设', chat_completion_source: 'openai', openai_model: 'current-model',
                temp_openai: 0.7, top_p_openai: 0.9, freq_pen_openai: 0, pres_pen_openai: 0, openai_max_context: 34000, openai_max_tokens: 2000, stream_openai: false },
            setOpenAIMessages: history => history.filter(message => !message.extra?.[Symbol.for('ignore')])
                .map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })).reverse(),
            setOpenAIMessageExamples: examples => examples,
            async prepareOpenAIMessages(options) {
                order.push('preset');
                assemblies.push({ ...options, extensionPrompts: structuredClone(Object.fromEntries(Object.entries(prompts).filter(([key]) => key !== 'unrelated'))) });
                return [[{ role: 'system', content: '当前预设 / ' + options.charDescription + ' / ' + options.personaDescription },
                    { role: 'system', content: options.worldInfoBefore }, ...options.messages.toReversed()]];
            },
            getChatCompletionModel: settings => settings.chat_completion_source === 'custom' ? settings.custom_model : settings.openai_model,
            async createGenerationParameters(settings, model, type, messages) {
                order.push('parameters');
                return { generate_data: { type, messages, model, stream: settings.stream_openai, temperature: settings.temp_openai,
                    chat_completion_source: settings.chat_completion_source, custom_url: settings.custom_url,
                    custom_include_headers: settings.custom_include_headers,
                    custom_prompt_post_processing: settings.custom_prompt_post_processing } };
            },
        },
        sse: { default: testStreaming.EventSourceStream },
        world: {
            world_info_include_names: true, wi_anchor_position: { before: 0, after: 1 },
            async getWorldInfoPrompt(chat, max, dryRun, scan) {
                order.push('world');
                assert.equal(dryRun, false);
                assert.equal(max, 32000);
                assert.equal(scan.characterDescription, '角色说明');
                assert.ok(chat.some(message => /用户: /.test(message)));
                return { worldInfoBefore: '<%= 世界书内容 %>', worldInfoAfter: '',
                    worldInfoDepth: [{ depth: 2, role: 0, entries: ['本次深度世界书'] }],
                    outletEntries: { place: ['本次指定位置世界书'] },
                    worldInfoExamples: [{ position: 0, content: '世界书示例' }] };
            },
        },
        notes: { NOTE_MODULE_NAME: '2_floating_prompt', metadata_keys: {}, shouldWIAddPrompt: false,
            setFloatingPrompt() { prompts['2_floating_prompt'] = { value: '本次作者注释' }; } },
        persona: { power_user: {}, persona_description_positions: { NONE: 0, TOP_AN: 1, BOTTOM_AN: 2, AT_DEPTH: 3 } },
        regex: { regex_placement: { USER_INPUT: 1, AI_OUTPUT: 2, REASONING: 3 }, getRegexedString: text => text },
        chats: { appendFileContent: async (_message, text) => text },
        reasoning: { PromptReasoning: class { addToMessage(text) { return text; } isLimitReached() { return true; } } },
        extensions: { extension_settings: { note: { allowWIScan: true } }, runGenerationInterceptors: async () => false },
        constants: { IGNORE_SYMBOL: Symbol.for('ignore'), inject_ids: { DEPTH_PROMPT: 'DEPTH_PROMPT', CUSTOM_WI_DEPTH_ROLE: (depth, role) => 'customDepthWI_' + depth + '_' + role,
            CUSTOM_WI_OUTLET: key => 'customWIOutlet_' + key } },
        tools: { ToolManager: { isToolCallingSupported: () => false } },
    };
    source.on(events.GENERATION_AFTER_COMMANDS, () => order.push('before'));
    source.on(events.GENERATE_AFTER_DATA, () => order.push('assembled'));
    context.chatCompletionSettings = modules.openai.oai_settings;
    context.getChatCompletionModel = () => modules.openai.getChatCompletionModel(context.chatCompletionSettings);
    const prepare = createNativePlayPreparer(() => context, { loadModules: async () => modules,
        prepareMessages: (_context, _modules, environment, options) => modules.openai.prepareOpenAIMessages({ ...options,
            settings: environment.tavern.settings, messages: modules.openai.setOpenAIMessages(options.history) }),
    });
    const options = (prompt = '本次{{user}}小剧场', api = { mode: 'tavern' }, signal = new AbortController().signal) =>
        ({ prompt, environment: capturePlayEnvironment(context, { playApi: api }), signal });
    return { context, modules, source, events, prompts, order, requests, assemblies, prepare, options };
}

test('原生流程保留预设、人设、主聊天和本次用户消息，等待发送前处理；回复不通知其他插件', async () => {
    const f = fixture(), before = structuredClone(f.context.chat), oldPrompts = { ...f.prompts };
    f.source.on(f.events.GENERATION_STARTED, () => assert.fail('不得启动主聊天生成'));
    f.source.on(f.events.CHAT_COMPLETION_SETTINGS_READY, async data => {
        await Promise.resolve();
        f.order.push('processed');
        data.messages = data.messages.map(message => ({ ...message, content: message.content.replace('<%= 世界书内容 %>', '处理后的世界书') }));
        data.temperature = 0.6; // Respect the host's normal request processing.
    });
    const request = await f.prepare(f.options());
    assert.equal(f.requests.length, 0, '准备完成不等于向模型发送');
    assert.deepEqual(f.prompts, oldPrompts, '临时深度世界书和作者注释恢复');
    const reply = await request.send({ signal: new AbortController().signal });
    assert.match(reply, /<% 不执行回复 %>/);
    const payload = f.requests[0].payload;
    assert.deepEqual(payload.messages.map(message => message.content),
        [DEFAULT_PLAY_PROMPT, '当前预设 / 角色说明 / 用户人设', '处理后的世界书', '主聊天旧回复', '本次用户小剧场']);
    assert.equal(payload.messages.at(-1).role, 'user');
    assert.equal(payload.temperature, 0.6, '不重写其他插件正常处理后的请求参数');
    assert.deepEqual(f.order, ['before', 'fields', 'world', 'preset', 'assembled', 'parameters', 'processed']);
    assert.deepEqual(f.context.chat, before);
    assert.equal(f.assemblies[0].extensionPrompts.customDepthWI_2_0.value, '本次深度世界书');
    assert.equal(f.assemblies[0].extensionPrompts.customDepthWI_5_0, undefined);
    assert.deepEqual(f.assemblies[0].messageExamples, ['世界书示例', '角色示例']);
});

test('不检测或补救缺失的 EJS 插件，不删改用户提示词', async () => {
    const f = fixture(), prompt = '<%= user_setting %>\n原样提示词';
    const request = await f.prepare(f.options(prompt));
    await request.send({ signal: new AbortController().signal });
    assert.equal(f.requests[0].payload.messages.at(-1).content, prompt);
    assert.equal(f.requests[0].payload.messages[2].content, '<%= 世界书内容 %>');
});

test('酒馆原有的隐藏消息标记在复制后仍生效，不重新发送被排除的消息', async () => {
    const f = fixture();
    f.context.chat.push({ name: '角色甲', is_user: false, mes: '酒馆排除的旧内容', extra: { [Symbol.for('ignore')]: true } });
    const request = await f.prepare(f.options());
    await request.send({ signal: new AbortController().signal });
    assert.doesNotMatch(JSON.stringify(f.requests[0].payload.messages), /酒馆排除的旧内容/);
    assert.equal(f.context.chat.at(-1).extra[Symbol.for('ignore')], true);
});

test('独立 API 仍使用当前预设，用本次配置生成请求，不修改酒馆 API 设置', async () => {
    const f = fixture();
    f.modules.openai.oai_settings.custom_prompt_post_processing = 'strict';
    const before = structuredClone(f.modules.openai.oai_settings);
    const request = await f.prepare(f.options('新小剧场', { mode: 'custom', url: 'https://example.invalid/v1/chat/completions', model: 'private-model', key: 'private-key' }));
    await request.send({ signal: new AbortController().signal });
    const payload = f.requests[0].payload;
    assert.equal(payload.chat_completion_source, 'custom');
    assert.equal(payload.model, 'private-model');
    assert.equal(payload.custom_url, 'https://example.invalid/v1');
    assert.deepEqual(JSON.parse(payload.custom_include_headers), { Authorization: 'Bearer private-key' });
    assert.equal(payload.temperature, 0.7);
    assert.equal(payload.stream, true, '小剧场默认流式，不跟随主聊天的非流式开关');
    assert.equal(payload.custom_prompt_post_processing, 'strict', '独立 API 保留酒馆已有的消息格式处理');
    assert.equal(payload.messages[0].content, DEFAULT_PLAY_PROMPT);
    assert.match(payload.messages[1].content, /当前预设/);
    assert.deepEqual(f.modules.openai.oai_settings, before);
    assert.equal(request.context.key, undefined);
});

for (const legacy of [false, true]) test(`等待期间修改预设、模型和采样参数，只影响下一次请求：旧版=${legacy}`, async () => {
    const f = fixture();
    if (legacy) delete f.modules.openai.createGenerationParameters;
    f.modules.openai.sendOpenAIRequest = () => assert.fail('不调用读取全局设置的旧版发送函数');
    const options = f.options();
    Object.assign(f.modules.openai.oai_settings, { preset_settings: '新的预设', openai_model: 'new-model', temp_openai: 1.2 });
    const request = await f.prepare(options);
    await request.send({ signal: new AbortController().signal });
    assert.equal(f.assemblies[0].settings.preset_settings, '当前预设');
    assert.equal(f.requests[0].payload.model, 'current-model');
    assert.equal(f.requests[0].payload.temperature, 0.7);
    const next = await f.prepare(f.options());
    await next.send({ signal: new AbortController().signal });
    assert.equal(f.requests[1].payload.model, 'new-model');
    assert.equal(f.requests[1].payload.temperature, 1.2);
    assert.equal(f.modules.openai.oai_settings.preset_settings, '新的预设');
});

test('独立 API 未选模型时提示拉取并选择，不发送生成请求', async () => {
    const f = fixture();
    await assert.rejects(f.prepare(f.options('新小剧场', { mode: 'custom', url: 'https://example.invalid/v1', key: '' })),
        error => error.code === 'missing_model' && /拉取并选择模型/.test(error.message));
    assert.equal(f.requests.length, 0);
});

test('旧版独立 API 不调用当前 API，不需要酒馆助手', async () => {
    const f = fixture();
    delete f.modules.openai.createGenerationParameters;
    Object.assign(f.modules.openai.oai_settings, { top_k_openai: 0, seed: -1, n: 1, custom_prompt_post_processing: 'strict' });
    f.modules.openai.sendOpenAIRequest = () => assert.fail('独立 API 不使用当前连接');
    const request = await f.prepare(f.options('旧版独立请求', { mode: 'custom', url: 'http://localhost:9999/v1', model: 'local', key: '' }));
    await request.send({ signal: new AbortController().signal });
    assert.equal(f.requests[0].payload.model, 'local');
    assert.equal(f.requests[0].payload.max_tokens, 2000);
    assert.equal(f.requests[0].payload.top_k, undefined, '普通 OpenAI 兼容请求不添加非通用 top_k');
    assert.equal(f.requests[0].payload.seed, undefined, '未指定随机种子时不发送 -1');
    assert.equal(f.requests[0].payload.n, undefined);
    assert.deepEqual(JSON.parse(f.requests[0].payload.custom_include_headers), { Authorization: '' });
    assert.equal(f.requests[0].payload.custom_prompt_post_processing, 'strict');
});

test('世界书处理失败或停止时清理临时内容，不发送请求', async () => {
    const f = fixture(), old = { ...f.prompts };
    f.modules.world.getWorldInfoPrompt = async () => { throw new Error('host error'); };
    await assert.rejects(f.prepare(f.options()), /host error/);
    assert.deepEqual(f.prompts, old);
    assert.equal(f.requests.length, 0);
    const controller = new AbortController();
    f.modules.world.getWorldInfoPrompt = async () => { controller.abort(); return {}; };
    await assert.rejects(f.prepare(f.options('停止', undefined, controller.signal)), error => error.name === 'AbortError');
    assert.deepEqual(f.prompts, old);
});

test('世界书沿用正常计时规则，但扫描和中途保存都不改变主聊天的计时数据', async () => {
    const f = fixture(), core = f.modules.core, world = f.modules.world.getWorldInfoPrompt;
    const original = { sticky: { old: { start: 1, end: 4, hash: 1 } }, cooldown: { old: { start: 1, end: 6, hash: 1 } } };
    const before = structuredClone(original);
    core.chat_metadata = { timedWorldInfo: original, note_prompt: '原作者注释' };
    f.modules.world.getWorldInfoPrompt = async (...args) => {
        const temporary = core.chat_metadata.timedWorldInfo;
        assert.notEqual(temporary, original);
        assert.deepEqual(temporary, before, '先读取主聊天当前的黏性和冷却状态');
        assert.equal(args[2], false, '保持原生非 dry-run 扫描和激活事件');
        delete temporary.sticky.old;
        temporary.cooldown.old.end = 8;
        temporary.sticky.new = { start: 2, end: 5, hash: 2 };
        core.chat_metadata.note_prompt = '用户刚修改的作者注释';
        assert.deepEqual(JSON.parse(JSON.stringify(core.chat_metadata)), {
            timedWorldInfo: before, note_prompt: '用户刚修改的作者注释',
        }, '异步扫描期间保存聊天也不会存入临时计时数据');
        assert.deepEqual(original, before, '嵌套修改没有触及原数据');
        return world(...args);
    };
    await f.prepare(f.options());
    assert.equal(core.chat_metadata.timedWorldInfo, original);
    assert.deepEqual(original, before);
    assert.equal(core.chat_metadata.note_prompt, '用户刚修改的作者注释');
});

for (const outcome of ['success', 'failure', 'abort']) test(`原本没有计时数据时，扫描结束后不留下新字段：${outcome}`, async () => {
    const f = fixture(), core = f.modules.core, controller = new AbortController();
    f.modules.world.getWorldInfoPrompt = async () => {
        core.chat_metadata.timedWorldInfo.sticky = { new: { start: 2, end: 5 } };
        assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(core.chat_metadata)), 'timedWorldInfo'), false);
        if (outcome === 'failure') throw new Error('world failure');
        if (outcome === 'abort') controller.abort();
        return {};
    };
    const task = f.prepare(f.options('临时扫描', undefined, controller.signal));
    if (outcome === 'failure') await assert.rejects(task, /world failure/);
    else if (outcome === 'abort') await assert.rejects(task, { name: 'AbortError' });
    else await task;
    assert.equal(Object.hasOwn(core.chat_metadata, 'timedWorldInfo'), false);
    assert.equal(f.requests.length, 0);
});

test('元数据容器替换后只清理仍属于本次扫描的计时字段', async () => {
    const f = fixture(), core = f.modules.core;
    const previous = { sticky: {}, cooldown: {} }, replacement = { sticky: { host: { end: 8 } }, cooldown: {} };
    core.chat_metadata.timedWorldInfo = previous;
    const originalContainer = core.chat_metadata;
    f.modules.world.getWorldInfoPrompt = async () => {
        core.chat_metadata = { ...core.chat_metadata, user_edit: '保留用户修改' };
        return {};
    };
    await f.prepare(f.options());
    assert.equal(core.chat_metadata.timedWorldInfo, previous);
    assert.equal(originalContainer.timedWorldInfo, previous);
    assert.equal(core.chat_metadata.user_edit, '保留用户修改');
    f.modules.world.getWorldInfoPrompt = async () => {
        core.chat_metadata = { timedWorldInfo: replacement, user_edit: '新的元数据' };
        return {};
    };
    await f.prepare(f.options());
    assert.equal(core.chat_metadata.timedWorldInfo, replacement, '不覆盖其他操作换入的计时数据');
    assert.equal(core.chat_metadata.user_edit, '新的元数据');
});

for (const event of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS']) {
    for (const dryRun of [false, true]) test(`主聊天准备等待迟到世界书清理，再写自己的注释：${event}，dryRun=${dryRun}`, { timeout: 2000 }, async () => {
        const f = fixture(), entered = deferred(), finish = deferred(), core = f.modules.core;
        const originalPrompts = { ...f.prompts }, timers = { sticky: {}, cooldown: {} };
        core.chat_metadata = { note_prompt: '保持第三人称叙述。', timedWorldInfo: timers };
        f.modules.world.getWorldInfoPrompt = async () => {
            entered.resolve(); await finish.promise;
            // Native WI writes its A/N and timers after the async scan returns.
            f.prompts['2_floating_prompt'] = { value: '保持第三人称叙述。\n夜市中有售卖花灯的摊位。' };
            core.chat_metadata.timedWorldInfo.sticky.nightMarket = { start: 2, end: 5 };
            return {};
        };
        const preparation = f.prepare(f.options());
        const rejected = assert.rejects(preparation, error => error.code === 'main_preparation_started');
        await entered.promise;
        let started = false;
        const newPrompt = { value: '主聊天新请求' };
        f.source.on(f.events[event], () => {
            assert.deepEqual(f.prompts, originalPrompts, '主聊天的第一个准备回调已看不到小剧场临时内容');
            assert.equal(core.chat_metadata.timedWorldInfo, timers);
            assert.deepEqual(timers, { sticky: {}, cooldown: {} });
            f.prompts.DEPTH_PROMPT = newPrompt;
            f.prompts['2_floating_prompt'] = { value: core.chat_metadata.note_prompt };
            started = true;
        });
        const main = f.source.emit(f.events[event], 'normal', {}, dryRun);
        await nextTurn(); assert.equal(started, false, '扫描仍在运行，主聊天尚未开始改共享提示词');
        finish.resolve(); await rejected; await main;
        assert.equal(started, true);
        assert.equal(f.prompts.DEPTH_PROMPT, newPrompt);
        assert.equal(f.prompts['2_floating_prompt'].value, '保持第三人称叙述。');
        assert.equal(core.chat_metadata.note_prompt, '保持第三人称叙述。');
        assert.equal(f.requests.length, 0);
    });
}

for (const outcome of ['failure', 'abort']) test(`小剧场扫描${outcome}后仍释放正在等待的主聊天`, { timeout: 2000 }, async () => {
    const f = fixture(), entered = deferred(), finish = deferred(), controller = new AbortController();
    const original = { ...f.prompts };
    f.modules.world.getWorldInfoPrompt = async () => {
        entered.resolve(); await finish.promise;
        f.prompts['2_floating_prompt'] = { value: '迟到的世界书' };
        if (outcome === 'failure') throw new Error('world failure');
        return {};
    };
    const task = f.prepare(f.options('等待中的扫描', undefined, controller.signal));
    const rejected = assert.rejects(task, outcome === 'failure' ? /world failure/ : { name: 'AbortError' });
    await entered.promise;
    const main = f.source.emit(f.events.GENERATION_STARTED, 'normal', {}, false);
    if (outcome === 'abort') controller.abort();
    finish.resolve(); await rejected; await main;
    assert.deepEqual(f.prompts, original);
    assert.equal(f.requests.length, 0);
});

test('取消后的下一次小剧场继续等主聊天准备结束；主聊天预览结束也会释放等待', { timeout: 2000 }, async () => {
    const f = fixture(), entered = deferred(), finish = deferred(), world = f.modules.world.getWorldInfoPrompt;
    f.modules.world.getWorldInfoPrompt = async (...args) => { entered.resolve(); await finish.promise; return world(...args); };
    const first = f.prepare(f.options());
    const rejected = assert.rejects(first, error => error.code === 'main_preparation_started');
    await entered.promise;
    const main = f.source.emit(f.events.GENERATION_STARTED, 'normal', {}, true);
    const next = f.prepare(f.options('下一次请求'));
    finish.resolve(); await rejected; await main;
    await nextTurn();
    assert.equal(f.assemblies.length, 0, '排在后面的小剧场不能抢在已等待的主聊天前准备');
    await f.source.emit(f.events.GENERATE_AFTER_DATA, { prompt: [] }, true);
    await next;
    assert.equal(f.assemblies.length, 1);
});

test('主聊天全部发送前回调完成后即可并行，不等待主聊天生成结束', { timeout: 2000 }, async () => {
    const f = fixture(); await f.prepare.ready();
    f.modules.core.is_send_press = true;
    await f.source.emit(f.events.GENERATION_STARTED, 'normal', {}, false);
    const entered = deferred(), finish = deferred();
    let processed = false;
    // Registered after the coordinator: the observer must still await it.
    f.source.on(f.events.CHAT_COMPLETION_SETTINGS_READY, async data => {
        if (!data.isMain) return;
        entered.resolve(); await finish.promise; processed = true;
    });
    const mainReady = f.source.emit(f.events.CHAT_COMPLETION_SETTINGS_READY, { isMain: true });
    await entered.promise;
    const playTask = f.prepare(f.options()); await nextTurn();
    assert.equal(f.order.includes('world'), false, '不在主聊天尚未处理完提示词时扫描世界书');
    finish.resolve(); await mainReady;
    const request = await playTask;
    assert.equal(processed, true); assert.equal(f.modules.core.is_send_press, true, '主聊天仍在等回复');
    await request.send({ signal: new AbortController().signal });
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].payload.stream, true);
});

test('尚未打开剧场时已观察主聊天准备，打开后不用等整篇生成完', { timeout: 2000 }, async () => {
    const f = fixture();
    f.modules.core.is_send_press = true;
    await f.source.emit(f.events.GENERATION_STARTED, 'normal', {}, false);
    await f.source.emit(f.events.CHAT_COMPLETION_SETTINGS_READY, { messages: [] });
    const request = await f.prepare(f.options());
    await request.send({ signal: new AbortController().signal });
    assert.equal(f.requests.length, 1); assert.equal(f.modules.core.is_send_press, true);
});

test('正在输出的主聊天回复不进入小剧场消息，也不参与世界书扫描', async () => {
    const f = fixture(); await f.prepare.ready();
    f.context.chat.push({ is_user: false, name: '角色甲', mes: '尚未生成完的片段', extra: {} });
    f.context.streamingProcessor = { messageId: 1, isFinished: false };
    let scanned;
    const world = f.modules.world.getWorldInfoPrompt;
    f.modules.world.getWorldInfoPrompt = (...args) => { scanned = args[0]; return world(...args); };
    const request = await f.prepare(f.options()); await request.send({ signal: new AbortController().signal });
    assert.doesNotMatch(JSON.stringify(f.requests[0].payload.messages), /尚未生成完/);
    assert.doesNotMatch(JSON.stringify(scanned), /尚未生成完/);
    assert.match(JSON.stringify(f.requests[0].payload.messages), /主聊天旧回复/);
    assert.equal(f.context.chat[1].mes, '尚未生成完的片段', '主聊天原文保留');
});

test('主聊天返回时等小剧场临时提示词恢复后再运行回复处理', { timeout: 2000 }, async () => {
    const f = fixture(), entered = deferred(), finish = deferred();
    const original = { ...f.prompts }, world = f.modules.world.getWorldInfoPrompt;
    f.modules.world.getWorldInfoPrompt = async (...args) => { entered.resolve(); await finish.promise; return world(...args); };
    const preparation = f.prepare(f.options()); await entered.promise;
    let rendered = false;
    f.source.on(f.events.CHARACTER_MESSAGE_RENDERED, () => { assert.deepEqual(f.prompts, original); rendered = true; });
    const render = f.source.emit(f.events.CHARACTER_MESSAGE_RENDERED, 1, 'normal');
    await nextTurn(); assert.equal(rendered, false);
    finish.resolve(); await preparation; await render;
    assert.equal(rendered, true);
});

test('等主聊天准备期间仍可停止，停止后不偷偷发送', { timeout: 2000 }, async () => {
    const f = fixture(); await f.prepare.ready();
    await f.source.emit(f.events.GENERATION_STARTED, 'normal', {}, false);
    const controller = new AbortController();
    const task = f.prepare(f.options('待发送', undefined, controller.signal));
    await nextTurn(); controller.abort();
    await assert.rejects(task, error => error.name === 'AbortError');
    await f.source.emit(f.events.GENERATION_ENDED);
    assert.equal(f.requests.length, 0); assert.equal(f.order.includes('world'), false);
});

for (const legacy of [false, true]) for (const prefill of [false, true]) {
    test(`续写不发送助手预填，普通生成保留预填且不改酒馆设置：旧版=${legacy}，预填开关=${prefill}`, async () => {
        const f = fixture();
        Object.assign(f.context.chatCompletionSettings, { chat_completion_source: 'claude', continue_prefill: prefill,
            assistant_prefill: '助手预填{{user}}' });
        if (legacy) delete f.modules.openai.createGenerationParameters;
        else {
            const parameters = f.modules.openai.createGenerationParameters;
            f.modules.openai.createGenerationParameters = async (...args) => {
                const result = await parameters(...args);
                result.generate_data.assistant_prefill = '原生参数助手预填';
                return result;
            };
        }
        const originalSettings = structuredClone(f.context.chatCompletionSettings);
        const continued = await f.prepare({ ...f.options(), continueMessage: '待续写的旧正文' });
        await continued.send({ signal: new AbortController().signal });
        assert.equal(f.requests[0].payload.type, 'continue');
        assert.equal(Object.hasOwn(f.requests[0].payload, 'assistant_prefill'), false);
        const normal = await f.prepare(f.options());
        await normal.send({ signal: new AbortController().signal });
        assert.equal(f.requests[1].payload.assistant_prefill, '助手预填用户');
        assert.deepEqual(f.context.chatCompletionSettings, originalSettings);
    });
}

test('续写准备将待续写消息推入聊天并以 continue 模式拼装，不额外加空格', async () => {
    const f = fixture();
    const options = { ...f.options(), continueMessage: '待续写的旧正文' };
    const request = await f.prepare(options);
    const result = await request.send({ signal: new AbortController().signal });
    assert.equal(f.assemblies[0].type, 'continue');
    assert.equal(f.assemblies[0].cyclePrompt, '待续写的旧正文');
    const messages = f.requests[0].payload.messages;
    const lastMessage = messages.at(-1);
    assert.equal(lastMessage.role, 'assistant');
    assert.equal(lastMessage.content, '待续写的旧正文');
    assert.ok(result.startsWith('待续写的旧正文'));
});

for (const apiMode of ['tavern', 'custom']) {
    test(`世界书按本次操作筛选普通生成和续写条目，且不修改主聊天：API=${apiMode}`, async () => {
        const f = fixture(), before = structuredClone(f.context.chat);
        const scanWorld = f.modules.world.getWorldInfoPrompt;
        const entries = [
            { triggers: [], content: '通用世界书条目' },
            { triggers: ['normal'], content: '仅普通生成的世界书条目' },
            { triggers: ['continue'], content: '仅续写的世界书条目' },
        ];
        f.modules.world.getWorldInfoPrompt = async (...args) => {
            const result = await scanWorld(...args), scan = args[3];
            result.worldInfoBefore = entries.filter(entry => !entry.triggers.length || entry.triggers.includes(scan.trigger))
                .map(entry => entry.content).join('\n');
            return result;
        };
        const api = apiMode === 'custom'
            ? { mode: 'custom', url: 'https://example.invalid/v1', model: 'test-model', key: '' }
            : { mode: 'tavern' };
        for (const continueMessage of [undefined, '待续写的旧正文', undefined]) {
            const request = await f.prepare({ ...f.options('本次小剧场', api), continueMessage });
            await request.send({ signal: new AbortController().signal });
            const contents = f.requests.at(-1).payload.messages.map(message => message.content).join('\n');
            assert.match(contents, /通用世界书条目/);
            assert.ok(contents.includes(continueMessage ? '仅续写的世界书条目' : '仅普通生成的世界书条目'));
            assert.ok(!contents.includes(continueMessage ? '仅普通生成的世界书条目' : '仅续写的世界书条目'));
            assert.deepEqual(f.context.chat, before);
        }
    });
}
