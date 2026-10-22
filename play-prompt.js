import { PlaygroundError } from './playground.js';
import { createPreparedPlayRequest, getCustomApiConnection } from './play-request.js';
import { preparePlayPreset } from './play-preset.js';
import { legacyPlayParameters } from './play-parameters.js';
import { getPlayPreparationCoordinator } from './play-preparation.js';
import { readPlayContinuationSettings, playContinuationError } from './play-settings.js';

async function loadTavernModules() {
    const paths = {
        core: 'script.js', openai: 'scripts/openai.js', world: 'scripts/world-info.js',
        notes: 'scripts/authors-note.js', persona: 'scripts/power-user.js',
        regex: 'scripts/extensions/regex/engine.js', chats: 'scripts/chats.js',
        extensions: 'scripts/extensions.js',
        constants: 'scripts/constants.js', tools: 'scripts/tool-calling.js',
        tokenizers: 'scripts/tokenizers.js',
        utils: 'scripts/utils.js',
        reasoning: 'scripts/reasoning.js',
        sse: 'scripts/sse-stream.js',
    };
    const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) =>
        [name, await import(new URL('../../../../' + path, import.meta.url).href)]));
    return Object.fromEntries(entries);
}

// Native depth/outlet prompts are shared by ST's prompt builder. Restore only
// the temporary entries this preparation installed, never another request's.
function promptScope(core) {
    const prompts = core.extension_prompts;
    const managed = key => key === 'DEPTH_PROMPT' || key.startsWith('DEPTH_PROMPT_')
        || key === 'PERSONA_DESCRIPTION' || key === '2_floating_prompt'
        || key.startsWith('customDepthWI_') || key.startsWith('customWIOutlet_');
    const before = new Map(Object.entries(prompts).filter(([key]) => managed(key)));
    const owned = new Map();
    return {
        remember() {
            for (const key of new Set([...before.keys(), ...Object.keys(prompts).filter(managed)])) {
                if (prompts[key] !== before.get(key)) owned.set(key, prompts[key]);
            }
        },
        clearDepth() {
            for (const key of Object.keys(prompts)) {
                if (key === 'DEPTH_PROMPT' || key.startsWith('DEPTH_PROMPT_')
                    || key.startsWith('customDepthWI_') || key.startsWith('customWIOutlet_')) delete prompts[key];
            }
            this.remember();
        },
        restore() {
            for (const [key, value] of owned) {
                if (prompts[key] !== value) continue;
                if (before.has(key)) prompts[key] = before.get(key);
                else delete prompts[key];
            }
        },
    };
}

async function scanWorldInfo(core, world, chat, maxContext, scanData) {
    const metadata = core.chat_metadata;
    const hadTimers = Object.hasOwn(metadata, 'timedWorldInfo');
    const previous = metadata.timedWorldInfo;
    const temporary = structuredClone(previous && typeof previous === 'object' ? previous : {});
    // The native scanner both reads and updates this field. Keep its normal
    // sticky/cooldown rules, but do not advance the main chat's timers.
    // A host save during an async scan must also retain the original timers.
    Object.defineProperty(temporary, 'toJSON', { value: () => previous });
    metadata.timedWorldInfo = temporary;
    try {
        return await world.getWorldInfoPrompt(chat, maxContext, false, scanData);
    } finally {
        // updateChatMetadata may replace the container while retaining this
        // field. Restore only our field, preserving other metadata changes.
        for (const target of new Set([metadata, core.chat_metadata])) {
            if (target.timedWorldInfo !== temporary) continue;
            if (hadTimers) target.timedWorldInfo = previous;
            else delete target.timedWorldInfo;
        }
    }
}

function addPersona(modules, settings) {
    const { core, persona, notes, extensions } = modules;
    const positions = persona.persona_description_positions;
    const types = core.extension_prompt_types;
    core.setExtensionPrompt('PERSONA_DESCRIPTION', '', types.IN_PROMPT, 0);
    if (!settings.persona_description || settings.persona_description_position === positions.NONE) return;
    if ([positions.TOP_AN, positions.BOTTOM_AN].includes(settings.persona_description_position) && notes.shouldWIAddPrompt) {
        const key = notes.NOTE_MODULE_NAME, old = core.extension_prompts[key]?.value ?? '';
        const value = settings.persona_description_position === positions.TOP_AN
            ? settings.persona_description + '\n' + old : old + '\n' + settings.persona_description;
        const meta = core.chat_metadata, keys = notes.metadata_keys;
        core.setExtensionPrompt(key, value, meta[keys.position], meta[keys.depth],
            extensions.extension_settings.note?.allowWIScan, meta[keys.role]);
    }
    if (settings.persona_description_position === positions.AT_DEPTH) {
        core.setExtensionPrompt('PERSONA_DESCRIPTION', settings.persona_description, types.IN_CHAT,
            settings.persona_description_depth, true, settings.persona_description_role);
    }
}

async function formatHistory(modules, chat, environment, isContinue) {
    const { regex, chats } = modules;
    const canUseTools = environment.tavern.canUseTools ?? modules.tools.ToolManager.isToolCallingSupported();
    const regexText = (text, placement, depth) => {
        const scripts = environment.tavern.regexScripts;
        if (!scripts) return regex.getRegexedString(text, placement, { isPrompt: true, depth });
        for (const script of scripts) {
            if (!script.promptOnly || !script.placement?.includes(placement)) continue;
            if (script.minDepth !== null && Number.isFinite(Number(script.minDepth)) && script.minDepth >= -1 && depth < script.minDepth) continue;
            if (script.maxDepth !== null && Number.isFinite(Number(script.maxDepth)) && script.maxDepth >= 0 && depth > script.maxDepth) continue;
            text = regex.runRegexScript(script, text);
        }
        return text;
    };
    const history = chat.filter(message => !message.is_system || (canUseTools && Array.isArray(message.extra?.tool_invocations)));
    const prepared = await Promise.all(history.map(async (message, index) => {
        const placement = message.is_user ? regex.regex_placement.USER_INPUT : regex.regex_placement.AI_OUTPUT;
        let text = regexText(message.mes, placement, history.length - index - (isContinue ? 2 : 1));
        text = await chats.appendFileContent(message, text);
        const titles = [];
        if (message.extra?.append_title && message.extra.title) titles.push(message.extra.title);
        for (const media of message.extra?.media ?? []) {
            if (media.append_title && media.title) titles.push(media.title);
        }
        if (titles.length) text += '\n\n' + titles.join('\n\n');
        return { ...message, mes: text, index };
    }));
    // Earlier chat reasoning stays out of theatre prompts. The continuation
    // switch controls only the target's outbound prefix, not its saved reasoning.
    let continuationReasoning = '', reasoningPrefix = '';
    if (isContinue && prepared.length) {
        const target = prepared.at(-1);
        const text = regexText(String(target.extra?.reasoning ?? ''), regex.regex_placement.REASONING, -1);
        continuationReasoning = text === '\u200B' ? '' : text;
        if (continuationReasoning && environment.continuation?.sendReasoning !== false) {
            const template = environment.tavern.power.reasoning ?? {};
            const sub = value => modules.core.substituteParams(value || '');
            const opening = `${sub(template.prefix)}${text}`;
            const ending = `${sub(template.suffix)}${sub(template.separator)}`;
            reasoningPrefix = opening + ending;
            // Match PromptReasoning.addToMessage's incomplete-prefix behavior
            // without constructing its shared main-chat reasoning instance.
            target.mes = opening + (target.mes ? ending + target.mes : '');
        }
    }
    return { history: prepared, continuationReasoning, reasoningPrefix };
}

function customSettings(settings, api) {
    const connection = getCustomApiConnection(api);
    if (typeof api.model !== 'string' || !api.model.trim()) throw new PlaygroundError('missing_model', '请先在独立 API 设置中拉取并选择模型。');
    return {
        ...settings, ...connection,
        custom_model: api.model.trim(), reverse_proxy: '', proxy_password: '',
        custom_include_body: '', custom_exclude_body: '',
    };
}

async function preparePayload(context, modules, messages, environment, signal, toolsData, emit, type = 'normal') {
    const { openai } = modules;
    const { api, tavern } = environment;
    let settings = structuredClone(tavern.settings);
    if (api.mode === 'custom') settings = customSettings(settings, api);
    // Theatre requests prefer streaming independently of the main-chat switch.
    // Native parameter helpers retain any model-specific streaming restrictions.
    settings.stream_openai = true;
    const model = api.mode === 'custom' ? settings.custom_model : tavern.model ?? openai.getChatCompletionModel(settings);
    const modern = typeof openai.createGenerationParameters === 'function';
    const baseline = legacyPlayParameters(settings, model, messages, { ...tavern, modern, type }, text => modules.core.substituteParams(text));
    const bias = settings.bias_presets?.[settings.bias_preset_selected];
    let payload;
    if (modern) {
        // These native helpers still consult global settings. Supply their
        // captured values ourselves without changing the host's settings.
        settings.bias_preset_selected = '';
        settings.reverse_proxy = '';
        settings.function_calling = false;
        const { generate_data } = await openai.createGenerationParameters(settings, model, type, messages);
        payload = generate_data;
        for (const key of ['stop', 'logprobs', 'reverse_proxy', 'proxy_password', 'assistant_prefill', 'user_name', 'char_name', 'group_names']) {
            if (Object.hasOwn(baseline, key)) payload[key] = baseline[key];
            else delete payload[key];
        }
    } else payload = baseline;
    if (Array.isArray(bias) && bias.length && Object.hasOwn(payload, 'logit_bias')
        && ['openai', 'azure_openai', 'openrouter', 'electronhub', 'custom', 'chutes'].includes(settings.chat_completion_source)) {
        const response = await fetch(`/api/backends/chat-completions/bias?model=${encodeURIComponent(tavern.tokenizerModel || model)}`, {
            method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(bias), signal,
        });
        if (!response.ok) throw new PlaygroundError('bias_preparation_failed', '本次词语偏好设置处理失败，没有发送到模型。');
        payload.logit_bias = await response.json();
    }
    if (toolsData.tools?.length && !(['openai', 'azure_openai'].includes(settings.chat_completion_source) && /^(o1|gpt-5-chat-latest)/.test(model))) Object.assign(payload, toolsData);
    signal.throwIfAborted();
    await emit(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, payload);
    signal.throwIfAborted();
    return payload;
}

async function prepareNativeRequest(ctx, modules, { prompt, environment, signal, continueMessage, continueExtra }, prepareMessages, emit, isInterrupted) {
    const { core, openai, world, notes, constants, extensions } = modules;
    const context = ctx(), events = context.eventTypes;
    const guard = () => {
        signal.throwIfAborted();
        const current = ctx();
        if (isInterrupted()) throw new PlaygroundError('main_preparation_started', '主聊天开始准备新请求，本次小剧场没有发送，请重新发送。');
        if (current.characterId !== environment.characterId
            || current.getCurrentChatId() !== environment.chatId) {
            throw new PlaygroundError('chat_changed', '聊天环境已经改变，本次没有发送，请重新发送。');
        }
    };
    guard();
    const continuation = environment.continuation ?? readPlayContinuationSettings({});
    const continuationError = continueMessage && playContinuationError(continuation);
    if (continuationError) throw new PlaygroundError('invalid_continue_prompt', continuationError);
    const customPrompt = core.substituteParams(environment.playPrompt ?? '').trim();
    const promptPosition = environment.playPromptPosition ?? 'start';
    const leadingSystemPrompt = promptPosition === 'start' ? customPrompt : '';
    const scope = promptScope(core);
    try {
        // Same preparation notification used by independent generators.
        // Do not emit GENERATION_STARTED or any main-chat message/reply event.
        await emit(events.GENERATION_AFTER_COMMANDS, continueMessage ? 'continue' : 'normal', {}, false);
        guard();
        const fields = core.getCharacterCardFields();
        const character = context.characters[context.characterId];
        scope.clearDepth();
        const depth = character.data?.extensions?.depth_prompt;
        core.setExtensionPrompt(constants.inject_ids.DEPTH_PROMPT, fields.charDepthPrompt || '',
            core.extension_prompt_types.IN_CHAT, depth?.depth ?? core.depth_prompt_depth_default,
            extensions.extension_settings.note?.allowWIScan,
            core.getExtensionPromptRoleByName(depth?.role ?? core.depth_prompt_role_default));
        scope.remember();

        const chat = structuredClone(environment.chat);
        for (const index of environment.ignoredMessages ?? []) {
            if (chat[index]) (chat[index].extra ??= {})[constants.IGNORE_SYMBOL] = true;
        }
        // An in-progress main reply must affect neither history nor WI scans.
        if (Number.isInteger(environment.unfinishedMessageId) && environment.unfinishedMessageId >= 0) {
            chat.splice(environment.unfinishedMessageId, 1);
        }
        if (chat[0]) chat[0].mes = core.substituteParams(chat[0].mes);
        const userPrompt = core.substituteParams(prompt);
        const userMessage = !customPrompt || promptPosition === 'start' ? userPrompt
            : (promptPosition === 'user-before' ? [customPrompt, userPrompt] : [userPrompt, customPrompt]).join('\n\n');
        chat.push({ name: context.name1, is_user: true, is_system: false, mes: userMessage, extra: {} });
        if (continueMessage) {
            chat.push({ name: context.name2, is_user: false, is_system: false, mes: continueMessage, extra: structuredClone(continueExtra ?? {}) });
        }
        const { history, continuationReasoning, reasoningPrefix } = await formatHistory(modules, chat, environment, !!continueMessage);
        guard();
        const maxContext = environment.tavern.settings.openai_max_context - environment.tavern.settings.openai_max_tokens;
        const aborted = await extensions.runGenerationInterceptors(history, maxContext, continueMessage ? 'continue' : 'normal');
        guard();
        if (aborted) throw new PlaygroundError('generation_cancelled', '酒馆的发送前处理已取消本次请求。');

        notes.setFloatingPrompt();
        scope.remember();
        const worldChat = history.map(message => world.world_info_include_names
            ? message.name + ': ' + message.mes : message.mes).reverse();
        const info = await scanWorldInfo(core, world, worldChat, maxContext, {
            personaDescription: fields.persona, characterDescription: fields.description,
            characterPersonality: fields.personality, characterDepthPrompt: fields.charDepthPrompt,
            scenario: fields.scenario, creatorNotes: fields.creatorNotes, trigger: continueMessage ? 'continue' : 'normal',
        });
        scope.remember();
        guard();
        for (const entry of info.worldInfoDepth ?? []) {
            core.setExtensionPrompt(constants.inject_ids.CUSTOM_WI_DEPTH_ROLE(entry.depth, entry.role),
                entry.entries.join('\n'), core.extension_prompt_types.IN_CHAT, entry.depth, false, entry.role);
        }
        for (const [key, entries] of Object.entries(info.outletEntries ?? {})) {
            core.setExtensionPrompt(constants.inject_ids.CUSTOM_WI_OUTLET(key), entries.join('\n'), core.extension_prompt_types.NONE, 0);
        }
        addPersona(modules, environment.tavern.power);
        scope.remember();

        const examples = core.parseMesExamples(fields.mesExamples, false);
        for (const example of info.worldInfoExamples ?? []) {
            if (!example.content) continue;
            const parsed = core.parseMesExamples(core.baseChatReplace(example.content, context.name1, context.name2), false);
            if (example.position === world.wi_anchor_position.before) examples.unshift(...parsed);
            else examples.push(...parsed);
        }
        const { promptBias } = core.getBiasStrings(promptPosition === 'start' ? prompt : userMessage, continueMessage ? 'continue' : 'normal');
        const toolsData = {};
        const { tavern } = environment;
        const multiSwipe = tavern.settings.n > 1 && ['openai', 'azure_openai', 'custom', 'xai', 'aimlapi', 'moonshot'].includes(tavern.settings.chat_completion_source);
        if (tavern.canUseTools && !multiSwipe) await modules.tools.ToolManager.registerFunctionToolsOpenAI(toolsData);
        guard();
        const [messages] = await prepareMessages(context, modules, environment, {
            name2: context.name2, charDescription: fields.description, charPersonality: fields.personality,
            scenario: fields.scenario, personaDescription: fields.persona,
            worldInfoBefore: info.worldInfoBefore, worldInfoAfter: info.worldInfoAfter,
            extensionPrompts: core.extension_prompts, bias: promptBias,
            type: continueMessage ? 'continue' : 'normal',
            quietPrompt: '', quietImage: null,
            cyclePrompt: continueMessage || '',
            cycleReasoning: reasoningPrefix,
            systemPromptOverride: fields.system,
            jailbreakPromptOverride: fields.jailbreak, history,
            messageExamples: openai.setOpenAIMessageExamples(examples), toolsData, signal, leadingSystemPrompt,
        });
        guard();
        const data = { prompt: messages };
        await emit(events.GENERATE_AFTER_DATA, data, false);
        guard();
        const payload = await preparePayload(context, modules, data.prompt, environment, signal, toolsData, emit, continueMessage ? 'continue' : 'normal');
        guard();
        // Its budget was reserved before preset assembly. Insert only after all
        // host callbacks, so a callback cannot move another prompt ahead of it.
        if (leadingSystemPrompt) {
            const first = payload.messages?.[0];
            if (environment.tavern.settings.squash_system_messages && first?.role === 'system' && typeof first.content === 'string') {
                payload.messages[0] = { ...first, content: leadingSystemPrompt + '\n\n' + first.content };
            } else if (Array.isArray(payload.messages)) {
                payload.messages.unshift({ role: 'system', content: leadingSystemPrompt });
            }
        }
        return createPreparedPlayRequest(context, payload, {
            prefix: continueMessage || '', continueExtra, continuationReasoning,
            reasoning: modules.reasoning,
            streaming: { EventSourceStream: modules.sse?.default, getStreamingReply: modules.openai.getStreamingReply },
            showThoughts: environment.tavern.settings.show_thoughts !== false,
            processReasoning: text => {
                const processed = modules.regex.getRegexedString(text, modules.regex.regex_placement.REASONING);
                return environment.tavern.power.trim_spaces ? processed.trim() : processed;
            },
        });
    } finally {
        scope.remember();
        scope.restore();
    }
}

/** Lazy native imports; queue preparation cleanup even if a caller stops early. */
export function createNativePlayPreparer(ctx, { loadModules = loadTavernModules, prepareMessages = preparePlayPreset } = {}) {
    // Observe main-chat requests from plugin startup, before the theatre is
    // opened. Otherwise opening it while an API is waiting misses preparation.
    let coordinator = typeof ctx().eventSource?.emit === 'function' ? getPlayPreparationCoordinator(ctx()) : null;
    let loading, modules, tokenCountOffset = 0, pending = Promise.resolve();
    const ready = () => loading ??= loadModules().then(async value => {
        coordinator ??= getPlayPreparationCoordinator(ctx(), value.core);
        // An empty full count measures ST's fixed accounting offset without
        // sending text or depending on a particular model/version's constants.
        tokenCountOffset = await value.tokenizers?.countTokensOpenAIAsync?.([], true) ?? 0;
        modules = value;
        return value;
    }).catch(error => { loading = null; throw error; });
    const prepare = options => {
        const task = pending.then(async () => {
            options.signal.throwIfAborted();
            await ready();
            options.signal.throwIfAborted();
            return coordinator.run(options.signal, isInterrupted =>
                prepareNativeRequest(ctx, modules, options, prepareMessages, coordinator.emit, isInterrupted));
        });
        pending = task.catch(() => {});
        return task;
    };
    prepare.ready = ready;
    prepare.isReady = () => !!modules;
    prepare.capture = () => {
        // ST 1.14 applies this option; newer hosts ignore the obsolete setting.
        // Query the native formatter without substituting macros or sending data.
        const user = modules.openai.setOpenAIMessages([{ name: ctx().name1, is_user: true, mes: '', extra: {} }])[0]?.content ?? '';
        return {
            tokenizerModel: modules.tokenizers?.getTokenizerModel(), tokenCountOffset,
            wrapUserMessages: user.startsWith('"') && user.endsWith('"'),
            canUseTools: modules.tools.ToolManager.isToolCallingSupported(),
            reasoningSignatureSupported: modules.openai.isReasoningSignatureSupported?.() ?? false,
            imageInlining: modules.openai.isImageInliningSupported?.(),
            videoInlining: modules.openai.isVideoInliningSupported?.(),
            audioInlining: modules.openai.isAudioInliningSupported?.(),
            regexScripts: modules.extensions.extension_settings.disabledExtensions?.includes('regex') ? [] : modules.regex.getRegexScripts?.({ allowedOnly: true }),
        };
    };
    return prepare;
}
