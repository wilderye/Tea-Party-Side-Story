import { PlaygroundError } from './playground.js';
import { importPlayTaskModule, loadPlayModuleSource, quietPlayConsole } from './play-task-module.js';

const worldSettingNames = ['world_info', 'world_info_depth', 'world_info_min_activations', 'world_info_min_activations_depth_max',
    'world_info_budget', 'world_info_include_names', 'world_info_recursive', 'world_info_overflow_alert', 'world_info_case_sensitive',
    'world_info_match_whole_words', 'world_info_character_strategy', 'world_info_budget_cap', 'world_info_use_group_scoring', 'world_info_max_recursion_steps'];

/** One native scanner/regex instance per task, supplied with the target's context. */
export async function createPlayWorldContext(context, environment, localCore, substitute, events, signal, notes) {
    const filename = environment.character.avatar.replace(/\.[^/.]+$/, '');
    const extensionSettings = structuredClone(environment.tavern.extensionSettings ?? {});
    const books = new Map();
    const loadWorldInfo = name => {
        if (!name) return Promise.resolve(null);
        if (!books.has(name)) books.set(name, (async () => {
            signal.throwIfAborted();
            const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ name }), signal });
            if (!response.ok) throw new PlaygroundError('worldbook_read_failed', '目标角色使用的世界书读取失败，本次没有发送。');
            const value = await response.json();
            if (!value || value.error || typeof value.entries !== 'object') throw new PlaygroundError('worldbook_read_failed', '目标角色使用的世界书返回格式不正确，本次没有发送。');
            return value;
        })());
        return books.get(name).then(value => structuredClone(value));
    };
    const localContext = { ...context, characters: [environment.characterCard], characterId: 0,
        chat: localCore.chat, chatMetadata: localCore.chat_metadata,
        name1: environment.tavern.name1, name2: environment.character.name,
        extensionSettings, extensionPrompts: localCore.extension_prompts, tagMap: environment.tavern.tagMap ?? {},
        getCurrentChatId: () => environment.chatId || null, setExtensionPrompt: localCore.setExtensionPrompt };
    localContext.saveChat = async () => {};
    localContext.saveMetadata = async () => {};
    localContext.saveSettingsDebounced = () => {};
    localContext.getContext = () => localContext;
    const worldNames = [...new Set([...(environment.tavern.globalWorlds ?? []), environment.characterCard.data?.extensions?.world,
        ...(environment.tavern.worldSettings?.world_info?.charLore?.find(item => item.name === filename)?.extraBooks ?? []),
        environment.tavern.power.persona_description_lorebook, localCore.chat_metadata.world_info].filter(Boolean))];
    const bindings = { console: quietPlayConsole, chat_metadata: localCore.chat_metadata, worldNames,
        this_chid: 0, characters: localContext.characters, getCurrentChatId: localContext.getCurrentChatId,
        getContext: () => localContext, getCharaFilename: () => filename, getTagKeyForEntity: () => environment.character.avatar,
        getExtensionPromptByName: async key => substitute(localCore.extension_prompts[key]?.value ?? ''),
        eventSource: events, power_user: environment.tavern.power, extension_settings: extensionSettings,
        getPresetManager: () => ({ apiId: environment.tavern.presetApi,
            getSelectedPresetName: () => environment.tavern.settings.preset_settings,
            readPresetExtensionField: ({ path }) => structuredClone(environment.tavern.presetFields?.[path]) }),
        substituteParams: substitute, substituteParamsExtended: (text, _env, postProcessFn) => substitute(text, { postProcessFn }),
        name1: environment.tavern.name1, shouldWIAddPrompt: !!environment.tavern.shouldWIAddPrompt,
        isNoteActive: () => !!notes?.shouldWIAddPrompt,
    };
    const worldPath = '/scripts/world-info.js';
    const worldSource = await loadPlayModuleSource(worldPath);
    signal.throwIfAborted();
    const { regex } = await createPlayRegexContext(context, environment, localCore, substitute, events);
    bindings.getRegexedString = regex.getRegexedString;
    let source = worldSource.replace(/export async function loadWorldInfo\(name\)\s*\{/, '$&\nreturn await __teaEnvironment.loadWorldInfo(name);');
    if (source === worldSource) throw new PlaygroundError('world_scanner_not_supported', '当前酒馆的世界书读取接口尚未支持独立角色处理，本次没有发送。');
    source = source.replace('if (shouldWIAddPrompt)', 'if (__teaEnvironment.isNoteActive())');
    // The host scanner normally swallows load/callback errors. An independent
    // request must distinguish processing failure from an empty worldbook.
    const start = source.indexOf('export async function getSortedEntries()'), end = source.indexOf('function parseDecorators(', start);
    if (start < 0 || end < start) throw new PlaygroundError('world_scanner_not_supported', '当前酒馆的世界书选取接口尚未支持独立角色处理，本次没有发送。');
    const sorted = source.slice(start, end).replace(/catch\s*\(e\)\s*\{\s*console\.error\(e\);\s*return \[\];\s*\}/, 'catch (e) { throw e; }');
    if (sorted === source.slice(start, end)) throw new PlaygroundError('world_scanner_not_supported', '当前酒馆的世界书错误处理接口尚未支持独立角色处理，本次没有发送。');
    source = source.slice(0, start) + sorted + source.slice(end);
    source += '\nexport function configurePlayWorld(settings, globals) {\n' + worldSettingNames.map(name =>
        `if (Object.hasOwn(settings, '${name}')) ${name} = structuredClone(settings.${name});`).join('\n') + '\nselected_world_info = structuredClone(globals);\nworld_names = structuredClone(__teaEnvironment.worldNames);\n}\n';
    const world = await importPlayTaskModule(source, new URL(worldPath, window.location.origin).href, { ...bindings, loadWorldInfo });
    world.configurePlayWorld(environment.tavern.worldSettings ?? {}, environment.tavern.globalWorlds ?? []);
    return { world, regex, context: localContext, loadWorldInfo, books, worldNames };
}

/** Native regex rules can be bound without loading worldbooks or third-party code. */
export async function createPlayRegexContext(context, environment, core, substitute, events) {
    const localContext = { ...context, characterId: 0, characters: [environment.characterCard],
        extensionSettings: environment.tavern.extensionSettings ?? {}, chat: core.chat, chatMetadata: core.chat_metadata,
        name1: environment.tavern.name1, name2: environment.character.name, getCurrentChatId: () => environment.chatId || null };
    const bindings = { console: quietPlayConsole, getContext: () => localContext,
        getCurrentChatId: localContext.getCurrentChatId, this_chid: 0, characters: localContext.characters,
        power_user: environment.tavern.power, extension_settings: localContext.extensionSettings, eventSource: events,
        getPresetManager: () => ({ apiId: environment.tavern.presetApi,
            getSelectedPresetName: () => environment.tavern.settings.preset_settings,
            readPresetExtensionField: ({ path }) => structuredClone(environment.tavern.presetFields?.[path]) }),
        substituteParams: substitute, substituteParamsExtended: (text, _env, postProcessFn) => substitute(text, { postProcessFn }),
    };
    const path = '/scripts/extensions/regex/engine.js';
    const regex = await importPlayTaskModule(await loadPlayModuleSource(path), new URL(path, window.location.origin).href, bindings);
    return { regex, context: localContext };
}
