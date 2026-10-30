import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNativePlayPreparer } from '../play-prompt.js';
import { capturePlayEnvironment as captureIndependentEnvironment } from '../play-runtime.js';

// Prompt assembly tests supply already-resolved synthetic chat data. Real card,
// worldbook and template resolution is covered separately by integration tests.
function capturePlayEnvironment(context, settings) {
    const environment = captureIndependentEnvironment(context, settings);
    environment.noChat = false;
    environment.chat = structuredClone(context.chat);
    environment.chatId = context.chatId;
    environment.context.chatId = context.chatId;
    environment.context.chatMode = 'latest';
    for (let index = 0; index < context.chat.length; index++) {
        if (context.chat[index].extra?.[Symbol.for('ignore')]) environment.ignoredMessages.push(index);
    }
    environment.unfinishedMessageId = context.streamingProcessor?.isFinished === false ? context.streamingProcessor.messageId : -1;
    return environment;
}
import { DEFAULT_PLAY_PROMPT } from '../play-settings.js';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createPlayLocalEvents } from '../play-template-context.js';
import { testStreaming, streamResponse } from './play-fixture.js';

let sendResponse;
beforeEach(t => t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/backends/chat-completions/generate');
    return sendResponse(JSON.parse(options.body), options.signal);
}));

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('酒馆和分支统一遵守正则深度并过滤插件隐藏标签；显示专用规则不发给模型', async () => {
    const f = fixture(), options = f.options(), nativeCalls = [], calls = [];
    const scripts = [
        { placement: [1, 2], findRegex: '普通', replaceString: '替换', minDepth: 100, maxDepth: 100 },
        { placement: [1, 2], findRegex: '发送', replaceString: '处理', promptOnly: true, minDepth: 100, maxDepth: 100 },
        { placement: [1, 2], findRegex: '显示', replaceString: '不发送替换', markdownOnly: true },
    ];
    f.modules.regex.getRegexedString = (text, placement, config) => { nativeCalls.push({ text, placement, config }); return text; };
    options.environment.tavern.regexRules = scripts.map((script, index) => ({ key: String(index), enabled: true, script }));
    f.modules.regex.runRegexScript = (script, text) => { calls.push({ script, text }); return text.replaceAll(script.findRegex, script.replaceString); };
    options.environment.branchMode = true; options.environment.playHiddenTags = '隐藏';
    options.environment.playPrompt = '本轮要求'; options.environment.playPromptPosition = 'user-after';
    options.environment.branchHistory = [
        { role: 'user', text: '旧用户普通发送显示<隐藏>不发送</隐藏>' },
        { role: 'assistant', text: '旧AI普通发送显示<隐藏>不能见到</隐藏>' },
    ];
    options.prompt = '下一轮普通发送显示<隐藏>隐藏新输入</隐藏>';
    const original = structuredClone(f.context.chat);
    const request = await f.prepare(options); await request.send({ signal: options.signal });
    const messages = f.requests[0].payload.messages;
    const historyCalls = nativeCalls.filter(call => call.config?.isPrompt);
    assert.equal(historyCalls.length, 0, '原聊天也使用捕获的规则，仍遵守深度');
    assert.equal(messages.find(message => message.content === original[0].mes)?.role, 'assistant');
    assert.deepEqual(messages.slice(-3).map(message => message.content), ['旧用户普通发送显示', '旧AI普通发送显示', '下一轮普通发送显示\n\n本轮要求']);
    assert.equal(calls.length, 0, '当前深度不符合规则的 100 层条件，两种来源均不执行');
    assert.equal(messages.map(message => message.content).join('\n').split('本轮要求').length, 2);
    assert.deepEqual(f.context.chat, original);
});

for (const hidden of [false, true]) test(`酒馆4层接插件3层只保留最新5层，隐藏中间插件楼层=${hidden}`, async () => {
    const f = fixture();
    f.context.chat = Array.from({ length: 4 }, (_, i) => ({ name: '角色甲', is_user: false, mes: `酒馆${i + 1}` }));
    const options = f.options('插件3'); options.environment.branchMode = true; options.environment.playPrompt = '';
    options.environment.branchHistory = [{ role: 'user', text: '插件1' }, { role: 'assistant', text: '插件2', hidden }];
    const rule = { key: 'erase', enabled: true, script: { placement: [1, 2], promptOnly: true, minDepth: 5, maxDepth: null } };
    options.environment.tavern.regexRules = [rule];
    f.modules.regex.runRegexScript = () => '';
    let scanned;
    f.modules.world.getWorldInfoPrompt = async chat => { scanned = chat; return {}; };
    const before = structuredClone(f.context.chat);
    const request = await f.prepare(options); await request.send({ signal: options.signal });
    const texts = f.requests[0].payload.messages.map(message => message.content).filter(Boolean).filter(text => /^(酒馆|插件)/.test(text));
    assert.deepEqual(texts, hidden ? ['酒馆2', '酒馆3', '酒馆4', '插件1', '插件3'] : ['酒馆3', '酒馆4', '插件1', '插件2', '插件3']);
    assert.equal(scanned.some(text => text.includes('插件2')), !hidden);
    assert.deepEqual(f.context.chat, before);
});

for (const selected of [true, false]) test(`插件选择统一控制酒馆和分支发送正则，勾选=${selected}`, async () => {
    const f = fixture(), options = f.options('插件标记');
    options.environment.chat[0].mes = '酒馆标记'; options.environment.branchMode = true; options.environment.playPrompt = '';
    options.environment.tavern.regexRules = [{ key: 'replace', enabled: true, script: { placement: [1, 2], promptOnly: true, findRegex: '标记', replaceString: '处理' } }];
    options.environment.playRegex.overrides = { replace: selected };
    f.modules.regex.runRegexScript = (script, text) => text.replace(script.findRegex, script.replaceString);
    const request = await f.prepare(options); await request.send({ signal: options.signal });
    assert.deepEqual(f.requests[0].payload.messages.slice(-2).map(message => message.content), selected ? ['酒馆处理', '插件处理'] : ['酒馆标记', '插件标记']);
    options.environment.playRegex.enabled = false;
    const disabled = await f.prepare(options); await disabled.send({ signal: options.signal });
    assert.deepEqual(f.requests[1].payload.messages.slice(-2).map(message => message.content), ['酒馆标记', '插件标记']);
});

for (const position of ['start', 'user-before', 'user-after']) test(`隐藏末尾用户层不通过附加提示词恢复，提示词位置=${position}`, async () => {
    const f = fixture(), options = f.options('隐藏用户正文');
    options.environment.branchMode = true; options.environment.requestUser = { hidden: true };
    options.environment.branchHistory = [{ role: 'assistant', text: '保留分支正文' }];
    options.environment.playPrompt = '额外指令'; options.environment.playPromptPosition = position;
    let scan;
    f.modules.world.getWorldInfoPrompt = async chat => { scan = chat; return {}; };
    const request = await f.prepare(options); await request.send({ signal: options.signal });
    const contents = f.requests[0].payload.messages.map(message => message.content).join('\n');
    assert.doesNotMatch(contents, /隐藏用户正文/);
    assert.equal(contents.includes('额外指令'), position === 'start');
    assert.equal(scan.some(text => text.includes('隐藏用户正文')), false);
});

test('分支续写目标按 -1 执行规则，规则清空正文时拒绝发送且不冒用前一层', async () => {
    const f = fixture(), options = f.options('前一层');
    options.environment.branchMode = true; options.environment.playPrompt = '';
    options.continueMessage = '待续写正文';
    options.environment.tavern.regexRules = [{ key: 'last', enabled: true, script: { placement: [2], promptOnly: true, minDepth: -1, maxDepth: 0 } }];
    f.modules.regex.runRegexScript = (_script, text) => `${text}【处理】`;
    const request = await f.prepare(options); await request.send({ signal: options.signal });
    assert.equal(f.assemblies[0].history.at(-1).mes, '待续写正文【处理】');
    assert.equal(f.assemblies[0].history.at(-2).mes, '前一层');
    f.modules.regex.runRegexScript = () => '';
    await assert.rejects(f.prepare(options), { code: 'empty_continue_prompt' });
    assert.equal(f.requests.length, 1);
});

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
    const settings = { playPrompt: '最前面的已保存内容', playPromptConfig: { position: 'start' } };
    const environment = capturePlayEnvironment(f.context, settings); settings.playPrompt = '后来修改';
    const request = await f.prepare({ ...f.options(), environment }); await request.send({ signal: new AbortController().signal });
    assert.equal(f.requests[0].payload.messages[0].content, '最前面的已保存内容');
    settings.playPrompt = '';
    const cleared = await f.prepare({ ...f.options(), environment: capturePlayEnvironment(f.context, settings) });
    await cleared.send({ signal: new AbortController().signal });
    assert.equal(f.requests[1].payload.messages[0].content, '当前预设 / 角色说明 / 用户人设');
    assert.equal(f.assemblies[1].leadingSystemPrompt, '');
});

for (const missingPosition of [false, true]) test(`默认提示词附在最新用户消息后，准备环境缺少位置=${missingPosition}`, async () => {
    const f = fixture(), before = structuredClone(f.context.chat);
    const environment = capturePlayEnvironment(f.context, { playPrompt: '附加要求{{user}}' });
    assert.equal(environment.playPromptPosition, 'user-after');
    if (missingPosition) delete environment.playPromptPosition;
    const request = await f.prepare({ ...f.options(), environment });
    await request.send({ signal: new AbortController().signal });
    const messages = f.requests[0].payload.messages;
    assert.equal(messages[0].content, '当前预设 / 角色说明 / 用户人设');
    assert.equal(messages.at(-1).role, 'user');
    assert.equal(messages.at(-1).content, '本次用户小剧场\n\n附加要求用户');
    assert.equal(messages.filter(message => message.content.includes('附加要求用户')).length, 1);
    assert.equal(f.assemblies[0].leadingSystemPrompt, '');
    assert.deepEqual(f.context.chat, before);
});

for (const position of ['user-before', 'user-after']) {
    for (const continuation of [false, true]) test(`提示词在本次用户消息内部，位置=${position}，续写=${continuation}`, async () => {
        const f = fixture(), before = structuredClone(f.context.chat);
        const options = f.options();
        options.environment.playPrompt = '要求{{user}}【处理】'; options.environment.playPromptPosition = position;
        options.environment.tavern.regexRules = [{ key: 'remove-marker', enabled: true,
            script: { placement: [1, 2], promptOnly: true, findRegex: '【处理】', replaceString: '' } }];
        f.modules.regex.runRegexScript = (script, text) => text.replace(script.findRegex, script.replaceString);
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
    f.modules.regex.runRegexScript = (script, text) => {
        calls.push({ text, id: script.id });
        return script.id === 'zero' ? text + '【深度0】' : text.replace('【发送前删除】', '');
    };
    const before = structuredClone(f.context.powerUserSettings);
    const original = '待续写正文【发送前删除】';
    const options = { ...f.options(), continueMessage: original,
        continueExtra: { reasoning: '目标思维链【发送前删除】', api: 'openai', model: 'current-model' } };
    options.environment.tavern.regexRules = [
        { key: 'last-and-before', enabled: true, script: { id: 'last-and-before', placement: [1, 2, 3], promptOnly: true, minDepth: -1, maxDepth: 0 } },
        { key: 'zero', enabled: true, script: { id: 'zero', placement: [1, 2, 3], promptOnly: true, minDepth: 0, maxDepth: 0 } },
    ];
    await f.prepare(options);
    const assembly = f.assemblies.at(-1);
    assert.equal(assembly.history.at(-1).mes, '<think>目标思维链</think>\n待续写正文');
    assert.equal(assembly.history[0].mes, '主聊天旧回复');
    assert.equal(assembly.history.at(-2).mes, '本次用户小剧场【深度0】');
    assert.equal(assembly.cyclePrompt, '待续写正文', '两种续写方式使用已经完成发送正则处理的正文');
    assert.equal(assembly.cycleReasoning, '<think>目标思维链</think>\n');
    assert.deepEqual(calls.map(call => [call.text, call.id]), [
        ['本次用户小剧场', 'last-and-before'], ['本次用户小剧场', 'zero'],
        [original, 'last-and-before'], ['目标思维链【发送前删除】', 'last-and-before'],
    ]);
    assert.deepEqual(f.context.powerUserSettings, before, '酒馆主聊天的设置保持原值');
    calls.length = 0;
    const normal = f.options(); normal.environment.tavern.regexRules = options.environment.tavern.regexRules;
    await f.prepare(normal);
    assert.equal(f.assemblies.at(-1).history[0].mes, '主聊天旧回复');
    assert.equal(f.assemblies.at(-1).history.at(-1).mes, '本次用户小剧场【深度0】');
    assert.deepEqual(calls.map(call => call.id), ['last-and-before', 'zero']);
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
            chat: [],
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
        createScope: async () => ({ context, modules, events: source, dispose() {} }),
        prepareMessages: (_context, _modules, environment, options) => modules.openai.prepareOpenAIMessages({ ...options,
            settings: environment.tavern.settings, messages: modules.openai.setOpenAIMessages(options.history) }),
    });
    const options = (prompt = '本次{{user}}小剧场', api = { mode: 'tavern' }, signal = new AbortController().signal) =>
        ({ prompt, environment: capturePlayEnvironment(context, { playApi: api, playPromptConfig: { position: 'start' } }), signal });
    return { context, modules, source, events, prompts, order, requests, assemblies, prepare, options };
}

test('两份准备同时进行，主聊天事件不等待任务；停止和资料只属于各自请求', async () => {
    const f = fixture(), entered = [], gates = new Map(), disposed = [], scopedCores = [];
    const hostPrompts = { ...f.prompts }, hostMetadata = structuredClone(f.modules.core.chat_metadata);
    const prepare = createNativePlayPreparer(() => f.context, {
        loadModules: async () => f.modules,
        createScope: async (_context, modules, options) => {
            const gate = deferred(); gates.set(options.prompt, gate);
            const core = { ...modules.core, extension_prompts: {}, chat_metadata: {}, chat: [] };
            core.setExtensionPrompt = (key, value, position, depth, scan, role) => { core.extension_prompts[key] = { value, position, depth, scan, role }; };
            scopedCores.push(core);
            return { context: { ...f.context, chat: core.chat, chatMetadata: core.chat_metadata },
                modules: { ...modules, core,
                    notes: { ...modules.notes, setFloatingPrompt() {} },
                    world: { ...modules.world, getWorldInfoPrompt: async () => { entered.push(options.prompt); await gate.promise; return { worldInfoBefore: options.prompt }; } } },
                events: eventBus(), dispose: () => disposed.push(options.prompt) };
        },
        prepareMessages: async (_context, _modules, _environment, options) => [[{ role: 'system', content: options.worldInfoBefore }]],
    });
    const controller = new AbortController();
    const a = prepare({ ...f.options('甲'), signal: controller.signal });
    const rejected = assert.rejects(a, { name: 'AbortError' });
    const b = prepare(f.options('乙'));
    await nextTurn(); assert.deepEqual(entered, ['甲', '乙']);
    let mainStarted = false;
    f.source.on(f.events.GENERATION_STARTED, () => { mainStarted = true; });
    await f.source.emit(f.events.GENERATION_STARTED);
    assert.equal(mainStarted, true);
    controller.abort(); gates.get('甲').resolve(); await rejected;
    gates.get('乙').resolve(); const request = await b; await request.send({ signal: new AbortController().signal });
    assert.deepEqual(f.requests.at(-1).payload.messages.map(m => m.content), [DEFAULT_PLAY_PROMPT, '乙']);
    assert.deepEqual(f.prompts, hostPrompts); assert.deepEqual(f.modules.core.chat_metadata, hostMetadata);
    assert.notEqual(scopedCores[0], scopedCores[1]); assert.deepEqual(disposed.sort(), ['乙', '甲'].sort());
});

test('当前角色保留原生发送前回调和预设处理，不要求 EJS/MVU 独立兼容接口', async () => {
    const f = fixture(); let disposed = 0;
    const prepare = createNativePlayPreparer(() => f.context, { loadModules: async () => f.modules,
        createScope: async () => ({ native: true, dispose() { disposed++; } }),
        prepareMessages: (_context, _modules, environment, options) => f.modules.openai.prepareOpenAIMessages({ ...options,
            settings: environment.tavern.settings, messages: f.modules.openai.setOpenAIMessages(options.history) }),
    });
    const options = f.options(); options.environment.sourceCharacterId = f.context.characterId;
    const request = await prepare(options); await request.send({ signal: options.signal });
    assert.equal(disposed, 1); assert.equal(f.requests.length, 1);
    assert.ok(f.order.includes('before')); assert.ok(f.order.includes('assembled')); assert.ok(f.order.includes('preset'));
});

test('当前角色的第三方回调报错后回退基础处理，EJS 原文保留且只发送一次', async () => {
    const f = fixture(), attempts = [];
    f.source.on(f.events.GENERATION_AFTER_COMMANDS, () => { throw Error('Third-party plugin changed'); });
    const prepare = createNativePlayPreparer(() => f.context, { loadModules: async () => f.modules,
        createScope: async (_context, modules, options) => {
            attempts.push(!!options.forceIndependent);
            return options.forceIndependent ? { context: f.context, modules, events: createPlayLocalEvents(), dispose() {} }
                : { native: true, dispose() {} };
        },
        prepareMessages: (_context, _modules, environment, options) => f.modules.openai.prepareOpenAIMessages({ ...options,
            settings: environment.tavern.settings, messages: f.modules.openai.setOpenAIMessages(options.history) }),
    });
    const options = f.options(); options.environment.sourceCharacterId = f.context.characterId;
    const request = await prepare(options); await request.send({ signal: options.signal });
    assert.deepEqual(attempts, [false, true]); assert.equal(f.requests.length, 1);
    assert.ok(f.requests[0].payload.messages.some(message => message.content.includes('<%= 世界书内容 %>')));
});

test('原入口明确取消请求时不通过兼容回退绕过取消', async () => {
    const f = fixture(); let scopes = 0;
    f.modules.extensions.runGenerationInterceptors = async () => true;
    const prepare = createNativePlayPreparer(() => f.context, { loadModules: async () => f.modules,
        createScope: async () => { scopes++; return { native: true, dispose() {} }; },
    });
    const options = f.options();
    await assert.rejects(prepare(options), error => error.code === 'generation_cancelled');
    assert.equal(scopes, 1); assert.equal(f.requests.length, 0);
});

for (const hadHash of [false, true]) test(`旧版原生宏读取产生的聊天缓存不保留到主聊天，原缓存存在=${hadHash}`, async () => {
    const f = fixture(), metadata = f.modules.core.chat_metadata;
    if (hadHash) metadata.chat_id_hash = '';
    const before = structuredClone(metadata), substitute = f.modules.core.substituteParams;
    f.modules.core.substituteParams = (...args) => { metadata.chat_id_hash = 'synthetic-lazy-hash'; return substitute(...args); };
    await f.prepare(f.options());
    assert.deepEqual(metadata, before);
});

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
