import { resolvePlayCharacterContext, selectPlayPersona } from './play-character-context.js';
import { createPlayMacroContext } from './play-macro-context.js';
import { createPlayWorldContext, createPlayRegexContext } from './play-world-context.js';
import { createPlayLocalEvents, createPlayTemplateContext } from './play-template-context.js';
import { readPlayInitialVariables } from './play-variable-context.js';
import { createPlayNoteContext } from './play-note-context.js';
import { createPlayExampleFormatter } from './play-example-context.js';

const personaQueues = new WeakMap();

function selectPersonaForTask(context, modules, signal) {
    return (personas, character) => {
        const previous = personaQueues.get(context.eventSource) ?? Promise.resolve();
        const task = previous.then(async () => {
            signal.throwIfAborted();
            const before = new Set(context.Popup.util.popups);
            const selection = modules.personas.askForPersonaSelection('选择用户设定', `为「${character.name}」的本次小剧场选择用户设定。`, personas, { okButton: '取消' });
            const popup = context.Popup.util.popups.find(item => !before.has(item));
            const abort = () => { if (popup) void popup.complete(context.POPUP_RESULT.CANCELLED); };
            signal.addEventListener('abort', abort, { once: true });
            try { const result = await selection; signal.throwIfAborted(); return result; }
            finally { signal.removeEventListener('abort', abort); }
        });
        personaQueues.set(context.eventSource, task.catch(() => {}));
        return task;
    };
}

async function buildPlayCore(context, modules, environment, resolved, events, prompt) {
    const localCore = { ...modules.core, chat: structuredClone(resolved.messages), chat_metadata: structuredClone(resolved.metadata),
        this_chid: 0, characters: [environment.characterCard], name1: resolved.persona.name, name2: environment.character.name,
        extension_prompts: {}, eventSource: events, getCurrentChatId: () => resolved.chatId || null,
        main_api: 'openai', user_avatar: resolved.persona.id,
        saveSettingsDebounced() {}, saveChat: async () => {}, saveChatConditional: async () => {}, saveMetadata: async () => {},
    };
    localCore.setExtensionPrompt = (key, value, position, depth, scan = false, role = 0) => {
        localCore.extension_prompts[key] = { value, position, depth, scan, role };
    };
    const macros = await createPlayMacroContext(context, modules, environment, resolved, localCore, events, prompt);
    localCore.substituteParams = macros.substitute;
    localCore.substituteParamsExtended = (text, dynamicMacros, postProcessFn) => macros.substitute(text, { dynamicMacros, postProcessFn });
    localCore.getCharacterCardFields = () => macros.fields;
    localCore.baseChatReplace = (text, user, character) => macros.substitute(String(text ?? ''),
        { dynamicMacros: { ...(user ? { user } : {}), ...(character ? { char: character } : {}) } }).replace(/\r/g, '');
    localCore.parseMesExamples = text => {
        if (!text || text === '<START>') return [];
        const examples = text.startsWith('<START>') ? text : '<START>\n' + text.trim();
        return examples.split(/<START>/gi).slice(1).map(block => '<START>\n' + block.trim() + '\n');
    };
    const refreshFields = () => {
        const card = environment.characterCard, meta = resolved.metadata, power = environment.tavern.power;
        const field = value => macros.substitute(String(value ?? '').trim()).replace(/\r/g, '');
        Object.assign(macros.fields, {
            persona: field(power.persona_description), description: field(card.description ?? card.data?.description),
            personality: field(card.personality ?? card.data?.personality),
            scenario: field((!environment.noChat && meta.scenario) || card.scenario || card.data?.scenario),
            mesExamples: field((!environment.noChat && meta.mes_example) || card.mes_example || card.data?.mes_example),
            system: power.prefer_character_prompt ? field((!environment.noChat && meta.system_prompt) || card.data?.system_prompt) : '',
            jailbreak: power.prefer_character_jailbreak ? field(card.data?.post_history_instructions) : '',
            charDepthPrompt: field(card.data?.extensions?.depth_prompt?.prompt), creatorNotes: field(card.data?.creator_notes),
        });
    };
    refreshFields();
    localCore.getBiasStrings = (text, type) => ({ promptBias: type === 'continue' ? '' :
        macros.substitute(modules.core.extractMessageBias?.(text) || environment.tavern.power.user_prompt_bias || '') });
    return { localCore, macros, refreshFields };
}

export function canUseNativePlayScope(context, environment, resolved) {
    return !environment.noChat && !!environment.nativeChat && resolved.chatId === environment.nativeChat.chatId
        && context.characters?.[context.characterId]?.avatar === environment.character.avatar
        && (context.getCurrentChatId?.() ?? context.chatId) === resolved.chatId
        && resolved.persona.id === environment.tavern.userAvatar;
}

/** Native current-chat preparation remains available; other cards are independent. */
export async function createIndependentPlayScope(context, modules, options) {
    const { environment, signal, prompt } = options;
    const resolved = await resolvePlayCharacterContext(context, environment, signal, {
        timestamp: value => modules.utils.timestampToMoment(value).valueOf(),
        choosePersona: selectPersonaForTask(context, modules, signal),
        initializeVariables: async () => ({}),
    });
    environment.chatId = resolved.chatId;
    environment.chat = structuredClone(resolved.messages);
    environment.tavern.name1 = resolved.persona.name;
    environment.tavern.name2 = environment.character.name;
    environment.tavern.power = resolved.persona.power;
    environment.context = { ...environment.context, chatId: resolved.chatId, userName: resolved.persona.name, userAvatar: resolved.persona.id ?? '' };
    if (!options.forceIndependent && canUseNativePlayScope(context, environment, resolved)) {
        return { native: true, resolved, dispose() {} };
    }
    // Ignore markers and unfinished-reply indices belong only to the captured chat.
    if (resolved.chatId !== environment.nativeChat?.chatId) {
        environment.ignoredMessages = [];
        environment.unfinishedMessageId = -1;
    }
    const events = createPlayLocalEvents();
    const { localCore, macros, refreshFields } = await buildPlayCore(context, modules, environment, resolved, events, prompt);
    const setOpenAIMessageExamples = await createPlayExampleFormatter(environment);
    const notes = await createPlayNoteContext(modules, environment, localCore);
    const worldContext = await createPlayWorldContext(context, environment, localCore, macros.substitute, events, signal, notes);
    const template = createPlayTemplateContext(environment, resolved, { _: window._ }, signal);
    if (resolved.variableSource === 'initial') {
        const initial = await readPlayInitialVariables(environment, worldContext, macros.substitute,
            { _: window._, YAML: modules.lib.yaml }, signal, template.process);
        Object.assign(resolved.variables, initial ?? {});
        refreshFields();
    }
    // Render once after native selection and assembly, as the installed template
    // plugin does for chat completions. Rendering every loaded entry beforehand
    // executes inactive templates and changes the scanner's empty-entry handling.
    events.on(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, async data => {
        for (const message of data.messages) {
            if (typeof message.content === 'string') message.content = await template.process(message.content);
            else if (Array.isArray(message.content)) for (const part of message.content) {
                if (part.type === 'text') part.text = await template.process(part.text);
            }
        }
    });
    environment.characterId = 0;
    return { context: worldContext.context, modules: { ...modules, core: localCore, world: worldContext.world, regex: worldContext.regex, notes,
        openai: { ...modules.openai, setOpenAIMessageExamples },
        extensions: { ...modules.extensions, extension_settings: environment.tavern.extensionSettings, runGenerationInterceptors: async () => false } },
        template, worldContext, macros, resolved, events, dispose: () => events.clear() };
}

/** Display rules need names and native macros, never chat loading or script setup. */
export async function createPlayDisplayRegex(context, modules, character, captured) {
    const card = context.characters?.find(item => item.avatar === character.avatar) ?? { ...character, data: {} };
    const environment = { noChat: true, character, characterCard: structuredClone(card), sourceCharacterId: context.characters?.indexOf(card),
        tavern: { ...structuredClone(captured), settings: structuredClone(context.chatCompletionSettings ?? {}),
            power: structuredClone(context.powerUserSettings ?? {}), name1: context.name1, name2: character.name } };
    const persona = await selectPlayPersona(environment.tavern.power, character, {},
        { avatar: captured.userAvatar, name: context.name1 }, async ids => ids[0]);
    environment.tavern.power = persona.power;
    environment.tavern.name1 = persona.name;
    const resolved = { chatId: '', messages: [], metadata: {}, variables: {}, persona };
    const events = createPlayLocalEvents();
    const { localCore, macros } = await buildPlayCore(context, modules, environment, resolved, events, '');
    const { regex } = await createPlayRegexContext(context, environment, localCore, macros.substitute, events);
    return { ...regex, taskBound: true };
}
