/** Helper metadata is optional, including when its serialized shape changes. */
export function readPlayHelperVariables(value) {
    try {
        const helper = Array.isArray(value) ? Object.fromEntries(value) : value;
        const variables = helper?.variables;
        return variables && typeof variables === 'object' && !Array.isArray(variables) ? structuredClone(variables) : {};
    } catch { return {}; }
}

/** Optional initial data/templates. No MVU/Helper scripts, schema code or host writes. */
export async function readPlayInitialVariables(environment, worldContext, substitute, libraries, signal, processTemplate = text => text) {
    const data = {};
    let found = false;
    for (const name of worldContext.worldNames) {
        const book = await worldContext.loadWorldInfo(name);
        signal.throwIfAborted();
        for (const entry of Object.values(book?.entries ?? {})) {
            if (!String(entry.comment ?? '').toLowerCase().includes('[initvar]')) continue;
            try {
                let source = String(entry.content ?? '').trim();
                source = source.match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/i)?.[1] ?? source;
                source = source.match(/^```[^\n]*\n([\s\S]*?)\n```$/)?.[1] ?? source;
                source = substitute(source);
                source = await processTemplate(source);
                signal.throwIfAborted();
                // Failed optional content does not discard other readable entries.
                if (source.includes('<%') || source.includes('{{')) continue;
                const value = libraries.YAML?.parse ? libraries.YAML.parse(source) : JSON.parse(source);
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                libraries._.mergeWith(data, value, (_left, right) => Array.isArray(right) ? right : undefined);
                found = true;
            } catch {
                signal.throwIfAborted();
                continue;
            }
        }
    }
    return found ? { stat_data: data } : null;
}
