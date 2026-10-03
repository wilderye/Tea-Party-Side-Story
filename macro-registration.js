export const theatreMacros = [
    { key: 'community', name: '茶话会小剧场', internal: 'teaPartyTheatreInternal' },
    { key: 'favorites', name: '我收藏的小剧场', internal: 'teaPartyFavoriteTheatreInternal' },
];

export async function registerTheatreMacros(context, handlers, loadMacros = () => import('/scripts/macros/macro-system.js')) {
    if (!context.powerUserSettings?.experimental_macro_engine) {
        for (const { key, name } of theatreMacros) context.registerMacro(name, handlers[key], `本次生成的${name}`);
        return;
    }
    const { macros } = await loadMacros();
    for (const { key, name, internal } of theatreMacros) {
        macros.registry.registerMacro(internal, { category: 'extension', description: name, handler: handlers[key] });
    }
    const replaceNames = text => {
        if (typeof text !== 'string') return text;
        for (const { name, internal } of theatreMacros) text = text.replaceAll(`{{${name}}}`, `{{${internal}}}`);
        return text;
    };
    if (typeof macros.engine.addPreProcessor === 'function') {
        macros.engine.addPreProcessor(replaceNames, { source: 'teahouse' });
    } else {
        // ST 1.15 has the new engine but no public preprocessor hook.
        const evaluate = macros.engine.evaluate;
        macros.engine.evaluate = function (text, ...args) { return evaluate.call(this, replaceNames(text), ...args); };
    }
}
