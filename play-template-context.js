import { loadPlayModuleSource } from './play-task-module.js';

export function createPlayLocalEvents() {
    const listeners = new Map();
    const source = {
        on(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener); },
        makeFirst(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).unshift(listener); },
        makeLast(name, listener) { source.on(name, listener); },
        removeListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)); },
        async emit(name, ...args) { for (const listener of [...(listeners.get(name) ?? [])]) await listener(...args); },
        clear() { listeners.clear(); },
    };
    return source;
}

export function readPlayTemplateFeatures(host = globalThis.EjsTemplate) {
    try { return structuredClone(host?.getFeatures?.()); }
    catch { return { enabled: false }; }
}

let installedEngine;

async function compilePlayTemplate(source, options, host) {
    let engine;
    try {
        installedEngine ??= loadPlayModuleSource('/scripts/extensions/third-party/ST-Prompt-Template/src/3rdparty/ejs.js').then(text => {
            // Load the installed standard EJS library unchanged in a local
            // CommonJS container. It does not set window.ejs or plugin state.
            const module = { exports: {} };
            new Function('module', 'exports', text)(module, module.exports);
            if (typeof module.exports.compile !== 'function') throw new Error('Installed EJS engine unavailable');
            return module.exports;
        });
        engine = await installedEngine;
    } catch {
        if (typeof host?.compileTemplate !== 'function') throw new Error('Template compiler unavailable');
        return host.compileTemplate(source, options);
    }
    const render = engine.compile(source, options.options);
    return function(data) { return render.call(this, data, options.escaper, options.includer); };
}

/** Reuse the installed EJS engine; never copy or bootstrap plugin context code. */
export function createPlayTemplateContext(environment, resolved, libraries, signal, host = globalThis.EjsTemplate) {
    const features = environment.tavern.templateFeatures;
    const disabled = environment.tavern.extensionSettings?.disabledExtensions ?? [];
    const enabled = features?.enabled !== false && features?.generate_enabled !== false
        && !disabled.some(name => /(?:^|\/)ST-Prompt-Template$/.test(name));
    const compiled = new Map();
    let compilerTimedOut = false;
    // Each render gets its own data, including initial values read after this
    // context is created. No plugin cache or previous render is modified.
    const createData = () => {
        const chatVariables = structuredClone(resolved.metadata.variables ?? {});
        const globalVariables = structuredClone(environment.tavern.extensionSettings?.variables?.global ?? {});
        const variables = Object.assign({}, globalVariables, chatVariables, structuredClone(resolved.variables ?? {}));
        const scopes = { message: variables, cache: variables, local: chatVariables, chat: chatVariables, global: globalVariables };
        const getvar = (key, options = {}) => {
            if (!options || typeof options !== 'object') options = { defaults: options };
            let values = scopes[options.scope ?? 'cache'] ?? variables;
            if (options.withMsg) {
                const message = options.withMsg.id !== undefined ? resolved.messages.at(options.withMsg.id)
                    : resolved.messages.findLast(item => options.withMsg.role === 'user' ? item.is_user : !item.is_user && !item.is_system);
                values = message?.variables?.[options.withMsg.swipe_id ?? message?.swipe_id ?? 0] ?? {};
            }
            let value = key == null ? values : libraries._.get(values, key, options.defaults);
            if (options.index !== undefined) value = libraries._.get(JSON.parse(value || '{}'), options.index, options.defaults);
            return value && typeof value === 'object' || options.clone ? structuredClone(value) : value;
        };
        return {
            _: libraries._, variables, getvar,
            getMessageVar: (key, options) => getvar(key, { ...options, scope: 'message' }),
            getLocalVar: (key, options) => getvar(key, { ...options, scope: 'local' }),
            getGlobalVar: (key, options) => getvar(key, { ...options, scope: 'global' }),
            userName: resolved.persona.name, assistantName: environment.character.name, charName: environment.character.name,
            chatId: resolved.chatId, characterId: environment.sourceCharacterId, isDryRun: true,
            getCharData: () => structuredClone(environment.characterCard),
            getCharaData: () => structuredClone(environment.characterCard),
        };
    };
    return {
        async process(source) {
            if (typeof source !== 'string' || !source.includes('<%') || !enabled || compilerTimedOut) return source;
            signal.throwIfAborted();
            let timer, abort, active = true, compiling = true;
            try {
                if (!host) return source;
                if (!compiled.has(source)) compiled.set(source, compilePlayTemplate(source, {
                    logging: false, options: { async: true, client: true, _with: true, compileDebug: false, outputFunctionName: 'print' },
                    escaper: value => String(value ?? ''), includer: () => { throw new Error('Template include unavailable'); },
                }, host));
                const pending = (async () => {
                    const render = await compiled.get(source);
                    compiling = false;
                    if (!active) return source;
                    signal.throwIfAborted();
                    const locals = createData();
                    return render.call(locals, locals);
                })();
                const output = await Promise.race([pending,
                    new Promise(resolve => { timer = setTimeout(() => {
                        compilerTimedOut ||= compiling;
                        resolve(source);
                    }, 3000); }),
                    new Promise((_, reject) => {
                        abort = () => reject(signal.reason);
                        signal.addEventListener('abort', abort, { once: true });
                    }),
                ]);
                signal.throwIfAborted();
                return typeof output === 'string' ? output : source;
            } catch {
                signal.throwIfAborted();
                return source;
            } finally { active = false; clearTimeout(timer); signal.removeEventListener('abort', abort); }
        },
    };
}
