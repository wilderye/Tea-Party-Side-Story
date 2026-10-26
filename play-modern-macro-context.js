import { importPlayTaskModule, loadPlayModuleSource } from './play-task-module.js';

/** Reuse native parsing/definitions with a task's own registry and variables. */
export async function createPlayModernMacroContext(bindings, variables, raw, localCore) {
    let engine;
    // Native registry/walker/engine imports form a cycle. This proxy forwards
    // method calls only after all three task-local closures have been loaded.
    const engineBinding = new Proxy({}, { get: (_target, key) => typeof engine?.[key] === 'function' ? engine[key].bind(engine) : engine?.[key] });
    const variableScope = scope => Object.fromEntries(Object.entries({ get: 'get', set: 'set', del: 'delete', add: 'add',
        inc: 'increment', dec: 'decrement', has: 'exists' }).map(([method, prefix]) =>
        [method, variables[`${prefix}${scope}Variable`]]));
    const nativeBindings = { ...bindings, MacroEngine: engineBinding,
        SillyTavern: { getContext: () => ({ variables: { local: variableScope('Local'), global: variableScope('Global') } }) },
        document: { querySelector: selector => selector === '#send_textarea' ? { value: raw.input } : null },
        groups: [], selected_group: null, name1: raw.user, name2: raw.char,
        getGeneratingModel: () => raw.model ?? '', parseMesExamples: (...args) => localCore.parseMesExamples(...args),
    };
    for (const name of ['logMacroGeneralError', 'logMacroInternalError', 'logMacroRuntimeWarning', 'logMacroSyntaxWarning',
        'logMacroRegisterError', 'logMacroRegisterWarning']) nativeBindings[name] = () => {};
    const load = async path => importPlayTaskModule('const SillyTavern = __teaEnvironment.SillyTavern;\nconst document = __teaEnvironment.document;\n'
        + await loadPlayModuleSource(path), new URL(path, window.location.origin).href, nativeBindings);
    const registry = await load('/scripts/macros/engine/MacroRegistry.js');
    Object.assign(nativeBindings, registry);
    const walker = await load('/scripts/macros/engine/MacroCstWalker.js');
    nativeBindings.MacroCstWalker = walker.MacroCstWalker;
    engine = (await load('/scripts/macros/engine/MacroEngine.js')).MacroEngine;
    for (const [filename, register] of [['core', 'Core'], ['env', 'Env'], ['chat', 'Chat'], ['time', 'Time'],
        ['variable', 'Variable'], ['instruct', 'Instruct'], ['state', 'State']]) {
        const definitions = await load(`/scripts/macros/definitions/${filename}-macros.js`);
        definitions[`register${register}Macros`]();
    }
    const fieldMap = { system: 'charPrompt', jailbreak: 'charInstruction', description: 'description', personality: 'personality',
        scenario: 'scenario', persona: 'persona', mesExamples: 'mesExamplesRaw', version: 'charVersion',
        charDepthPrompt: 'charDepthPrompt', creatorNotes: 'creatorNotes' };
    nativeBindings.getCharacterCardFieldsLazy = () => Object.defineProperties({
        firstMessage: localCore.characters[0]?.first_mes ?? localCore.characters[0]?.data?.first_mes ?? '',
        alternateGreetings: localCore.characters[0]?.data?.alternate_greetings ?? [],
    }, Object.fromEntries(Object.entries(fieldMap).map(([field, macro]) => [field,
        { enumerable: true, get: () => typeof raw[macro] === 'function' ? raw[macro]() : raw[macro] ?? '' }])));
    const builder = (await load('/scripts/macros/engine/MacroEnvBuilder.js')).MacroEnvBuilder;
    return (text, options) => engine.evaluate(text, builder.buildFromRawEnv({ content: text, replaceCharacterCard: true,
        original: options.original ?? '', dynamicMacros: options.dynamicMacros ?? {}, postProcessFn: options.postProcessFn }));
}
