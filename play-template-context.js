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

/** Only the public compiler is optional. Never import or bootstrap plugin code. */
export function createPlayTemplateContext(environment, resolved, libraries, signal, host = globalThis.EjsTemplate) {
    const features = environment.tavern.templateFeatures;
    const disabled = environment.tavern.extensionSettings?.disabledExtensions ?? [];
    const enabled = features?.enabled !== false && !disabled.some(name => /(?:^|\/)ST-Prompt-Template$/.test(name));
    const compiled = new Map();
    const variables = structuredClone(resolved.variables ?? {});
    const chatVariables = structuredClone(resolved.metadata.variables ?? {});
    const scopes = { message: variables, local: chatVariables,
        chat: chatVariables, global: structuredClone(environment.tavern.extensionSettings?.variables?.global ?? {}) };
    const getvar = (key, options = {}) => {
        if (!options || typeof options !== 'object') options = { defaults: options };
        let values = scopes[options.scope ?? 'message'] ?? variables;
        if (options.withMsg) {
            const message = options.withMsg.id !== undefined ? resolved.messages.at(options.withMsg.id)
                : resolved.messages.findLast(item => options.withMsg.role === 'user' ? item.is_user : !item.is_user && !item.is_system);
            values = message?.variables?.[options.withMsg.swipe_id ?? message?.swipe_id ?? 0] ?? {};
        }
        let value = key == null ? values : libraries._.get(values, key, options.defaults);
        if (options.index !== undefined) value = libraries._.get(JSON.parse(value || '{}'), options.index, options.defaults);
        if (value === undefined) throw new Error('Template variable unavailable');
        return value && typeof value === 'object' || options.clone ? structuredClone(value) : value;
    };
    const data = {
        _: libraries._, variables, getvar,
        getMessageVar: (key, options) => getvar(key, { ...options, scope: 'message' }),
        getLocalVar: (key, options) => getvar(key, { ...options, scope: 'local' }),
        getGlobalVar: (key, options) => getvar(key, { ...options, scope: 'global' }),
        userName: resolved.persona.name, assistantName: environment.character.name, charName: environment.character.name,
        chatId: resolved.chatId, characterId: environment.sourceCharacterId, isDryRun: true,
        getCharData: () => structuredClone(environment.characterCard),
        getCharaData: () => structuredClone(environment.characterCard),
    };
    return {
        async process(source) {
            if (typeof source !== 'string' || !source.includes('<%') || !enabled) return source;
            signal.throwIfAborted();
            let timer, abort, active = true;
            try {
                if (typeof host?.compileTemplate !== 'function') return source;
                if (!compiled.has(source)) compiled.set(source, Promise.resolve(host.compileTemplate(source, {
                    logging: false, options: { async: true, client: true, _with: true, compileDebug: false, outputFunctionName: 'print' },
                    escaper: value => String(value ?? ''), includer: () => { throw new Error('Template include unavailable'); },
                })));
                const pending = (async () => {
                    const render = await compiled.get(source);
                    if (!active) return source;
                    signal.throwIfAborted();
                    const locals = { ...data, variables: structuredClone(variables) };
                    return render.call(locals, locals);
                })();
                const output = await Promise.race([pending,
                    new Promise(resolve => { timer = setTimeout(() => resolve(source), 3000); }),
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
