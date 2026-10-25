import { importPlayTaskModule, loadPlayModuleSource, quietPlayConsole } from './play-task-module.js';
import { PlaygroundError } from './playground.js';
import { readPlayHelperVariables } from './play-variable-context.js';

function omitMetadata(value) {
    if (Array.isArray(value)) return value.map(omitMetadata);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('$')).map(([key, child]) => [key, omitMetadata(child)]));
    return value;
}

/** Tavern-helper's get/format macros, supplied with the explicit target scopes. */
export function replacePlayVariableMacros(source, scopes, libraries) {
    const valueAt = (scope, path) => omitMetadata(libraries._.get(scopes[scope] ?? {}, libraries._.unescape(path)));
    let text = String(source ?? '').replace(/\{\{get_(message|chat|character|preset|global)_variable::(.*?)\}\}/gi, (match, scope, path) => {
        const value = valueAt(scope, path);
        return value === undefined ? match : typeof value === 'string' ? value : JSON.stringify(value);
    });
    for (const quoted of [true, false]) {
        const expression = quoted ? /^(.*)\{\{format_(message|chat|character|preset|global)_variable_quoted::(.*?)\}\}/gim
            : /^(.*)\{\{format_(message|chat|character|preset|global)_variable::(.*?)\}\}/gim;
        const apply = (_match, prefix, scope, path) => {
            const value = valueAt(scope, path);
            if (value === undefined || !libraries.YAML?.stringify) return _match || prefix + '{{format_' + scope + '_variable' + (quoted ? '_quoted' : '') + '::' + path + '}}';
            const inner = prefix.match(new RegExp(expression.source, 'im'));
            if (inner) prefix = apply('', inner[1], inner[2], inner[3]) + prefix.slice(inner[0].length);
            const options = quoted ? { blockQuote: 'literal', defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' } : { blockQuote: 'literal' };
            const output = typeof value === 'string' ? value : libraries.YAML.stringify(value, options).trimEnd();
            return prefix + output.replaceAll('\n', '\n' + ' '.repeat(prefix.length));
        };
        text = text.replace(expression, apply);
    }
    return text;
}

/** Native ordinary macro evaluation with request-local chat and variable stores. */
export async function createPlayMacroContext(context, modules, environment, resolved, localCore, events, prompt) {
    const libraries = { _: window._, YAML: modules.lib.yaml };
    const instructSource = await loadPlayModuleSource('/scripts/instruct-mode.js');
    const instructRule = instructSource.match(/export function getInstructMacros\(env\)\s*\{[\s\S]*?\n\}/)?.[0];
    if (!instructRule) throw new PlaygroundError('macro_version_not_supported', '当前酒馆的模板宏接口尚未支持独立角色处理，本次没有发送。');
    const getInstructMacros = new Function('power_user', instructRule.replace('export ', '') + '\nreturn getInstructMacros;')(environment.tavern.power);
    const bindings = {
        console: quietPlayConsole, chat: localCore.chat, chat_metadata: localCore.chat_metadata,
        extension_settings: environment.tavern.extensionSettings, power_user: environment.tavern.power,
        eventSource: events, event_types: context.eventTypes, main_api: 'openai', extension_prompts: localCore.extension_prompts,
        getCurrentChatId: () => resolved.chatId || null,
        getMaxPromptTokens: () => environment.tavern.settings.openai_max_context - environment.tavern.settings.openai_max_tokens,
        getMaxContextTokens: () => environment.tavern.settings.openai_max_context,
        getMaxResponseTokens: () => environment.tavern.settings.openai_max_tokens,
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
        Handlebars: modules.lib.Handlebars.create(),
        getInstructMacros, textgenerationwebui_banned_in_macros: [],
    };
    const variablePath = '/scripts/variables.js';
    const variables = await importPlayTaskModule(await loadPlayModuleSource(variablePath), new URL(variablePath, window.location.origin).href, bindings);
    bindings.getVariableMacros = variables.getVariableMacros;
    let evaluator;
    bindings.substituteParams = (...args) => substitute(...args);
    const macroPath = '/scripts/macros.js';
    const source = 'const $ = __teaEnvironment.$;\n' + await loadPlayModuleSource(macroPath);
    const macro = await importPlayTaskModule(source, new URL(macroPath, window.location.origin).href, {
        ...bindings, $: selector => selector === '#send_textarea' ? { val: () => prompt } : window.$(),
    });
    evaluator = macro.evaluateMacros;
    const card = environment.characterCard;
    const fields = {};
    const last = predicate => localCore.chat.findLast(predicate)?.mes ?? '';
    const raw = {
        user: environment.tavern.name1, char: card.name, group: card.name, charIfNotGroup: card.name,
        groupNotMuted: card.name, notChar: environment.tavern.name1,
        model: environment.tavern.model, input: prompt,
        lastMessage: () => localCore.chat.at(-1)?.mes ?? '', lastMessageId: () => String(localCore.chat.length - 1),
        lastUserMessage: () => last(message => message.is_user), lastCharMessage: () => last(message => !message.is_user && !message.is_system),
        firstIncludedMessageId: () => String(localCore.chat.length ? 0 : ''), firstDisplayedMessageId: '',
        lastSwipeId: () => String((localCore.chat.at(-1)?.swipes?.length ?? 1) - 1),
        currentSwipeId: () => String(localCore.chat.at(-1)?.swipe_id ?? 0),
        charVersion: card.data?.character_version ?? '', char_version: card.data?.character_version ?? '',
        description: () => fields.description ?? card.description ?? card.data?.description ?? '',
        personality: () => fields.personality ?? card.personality ?? card.data?.personality ?? '',
        scenario: () => fields.scenario ?? ((!environment.noChat && resolved.metadata.scenario) || card.scenario || card.data?.scenario || ''),
        persona: () => fields.persona ?? environment.tavern.power.persona_description ?? '',
        mesExamplesRaw: () => fields.mesExamples ?? card.mes_example ?? card.data?.mes_example ?? '',
        mesExamples: () => localCore.parseMesExamples(fields.mesExamples ?? card.mes_example ?? card.data?.mes_example ?? '', false).join(''),
        charPrompt: () => fields.system ?? card.data?.system_prompt ?? '',
        charInstruction: () => fields.jailbreak ?? card.data?.post_history_instructions ?? '',
        charJailbreak: () => fields.jailbreak ?? card.data?.post_history_instructions ?? '',
        charDepthPrompt: () => fields.charDepthPrompt ?? card.data?.extensions?.depth_prompt?.prompt ?? '',
        creatorNotes: () => fields.creatorNotes ?? card.data?.creator_notes ?? '',
    };
    const scopes = { message: resolved.variables, chat: resolved.metadata.variables ?? {},
        character: readPlayHelperVariables(card.data?.extensions?.tavern_helper),
        preset: environment.tavern.presetHelper?.variables ?? {}, global: environment.tavern.extensionSettings?.variables?.global ?? {} };
    function substitute(text, ...args) {
        const options = args[0] && typeof args[0] === 'object' ? args[0] : { original: args[2], dynamicMacros: args[5] };
        return evaluator(replacePlayVariableMacros(text, scopes, libraries), { ...raw, original: options.original ?? '', ...(options.dynamicMacros ?? {}) }, options.postProcessFn);
    }
    return { substitute, fields, scopes };
}
