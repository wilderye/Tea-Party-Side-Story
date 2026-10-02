const macroName = '茶话会小剧场';
const internalName = 'teaPartyTheatreInternal';

export async function registerTheatreMacro(context, handler, loadMacros = () => import('/scripts/macros/macro-system.js')) {
    if (!context.powerUserSettings?.experimental_macro_engine) {
        context.registerMacro(macroName, handler, '本次生成的茶话会预设剧场');
        return;
    }
    const { macros } = await loadMacros();
    macros.registry.registerMacro(internalName, {
        category: 'extension', description: macroName, handler,
    });
    const replaceName = text => typeof text === 'string'
        ? text.replaceAll(`{{${macroName}}}`, `{{${internalName}}}`) : text;
    if (typeof macros.engine.addPreProcessor === 'function') {
        macros.engine.addPreProcessor(replaceName, { source: 'teahouse' });
    } else {
        // ST 1.15 has the new engine but no public preprocessor hook.
        // Convert only our macro name, keeping ST's parser, environment and receiver.
        const evaluate = macros.engine.evaluate;
        macros.engine.evaluate = function (text, ...args) {
            return evaluate.call(this, replaceName(text), ...args);
        };
    }
}
