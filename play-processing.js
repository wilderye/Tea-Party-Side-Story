import { readPlaySettings } from './play-settings.js';

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Literal, case-sensitive pairs. Incomplete outer blocks remain visible. */
export function hidePlayTags(source, names) {
    const tags = [...new Set(names.split(/[,，\r\n]+/).map(name => name.trim()).filter(Boolean))];
    if (!tags.length || !source) return source;
    const pattern = new RegExp(`<(/?)(${tags.map(escapeRegex).join('|')})>`, 'g');
    const stack = [], parts = [];
    let cursor = 0, start = 0;
    for (const match of source.matchAll(pattern)) {
        if (!match[1]) {
            if (!stack.length) start = match.index;
            stack.push(match[2]);
        } else if (stack.at(-1) === match[2]) {
            stack.pop();
            if (!stack.length) {
                parts.push(source.slice(cursor, start));
                cursor = match.index + match[0].length;
            }
        }
    }
    parts.push(source.slice(cursor));
    return parts.join('');
}

/** Keep the host's source order, with source identity attached for exclusions. */
export function readTavernRegex(engine, context) {
    if (context.extensionSettings?.disabledExtensions?.includes('regex')) return [];
    const owner = {
        GLOBAL: [],
        PRESET: [engine.getCurrentPresetAPI(), engine.getCurrentPresetName()],
        SCOPED: [context.characters?.[context.characterId]?.avatar ?? ''],
    };
    return Object.entries(engine.SCRIPT_TYPES).flatMap(([source, type]) =>
        engine.getScriptsByType(type, { allowedOnly: true })
            .filter(script => !script.disabled && script.placement?.includes(engine.regex_placement.AI_OUTPUT)
                && (!script.promptOnly || script.markdownOnly))
            .map(script => ({ source, key: JSON.stringify([source, ...owner[source], script.id]), script: structuredClone(script) })));
}

export function processPlayText(source, settings, rules, runRegex) {
    let text = hidePlayTags(source, settings.hiddenTags);
    if (settings.regexEnabled) {
        const excluded = new Set(settings.excludedRegex);
        // ST runs ordinary output substitutions before display-only substitutions.
        for (const markdownOnly of [false, true]) {
            for (const rule of rules) {
                if (excluded.has(rule.key) || !!rule.script.markdownOnly !== markdownOnly) continue;
                text = runRegex(rule.script, text);
            }
        }
    }
    // Hide only body-wrapper markers in the display copy, after host regexes
    // have had a chance to use them. Keep HTML attributes, scripts, styles and
    // literal HTML code examples intact; the saved source is never changed.
    return text.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|pre|code)\b(?:[^<>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)|<(?:[^<>"']|"[^"]*"|'[^']*')*>/gi,
        tag => /^<\/?(?:content|内容|正文)>$/i.test(tag) ? '' : tag);
}

const loadNativeRegex = () => import(new URL('../../../../scripts/extensions/regex/engine.js', import.meta.url).href);

/** A view snapshot, refreshed on opening/settings actions; never a saved rule copy. */
export function createPlayDisplay(ctx, settings, loadEngine = loadNativeRegex, diagnostics) {
    let loading, engine, rules = [], sources = {}, config = structuredClone(readPlaySettings(settings)), revision = 0;
    return {
        get revision() { return revision; },
        get rules() { return rules; },
        get sources() { return sources; },
        updateSettings() { config = structuredClone(readPlaySettings(settings)); revision++; },
        async refresh() {
            try {
                engine = await (loading ??= loadEngine());
                const context = ctx();
                rules = readTavernRegex(engine, context);
                sources = { PRESET: engine.getCurrentPresetName(), SCOPED: context.characters?.[context.characterId]?.name ?? '' };
            } catch (error) {
                diagnostics?.error('载入酒馆回复显示规则', error);
                loading = null; rules = []; sources = {}; this.updateSettings(); throw error;
            }
            this.updateSettings();
            return rules;
        },
        process(source) { return processPlayText(source, config, rules, (script, text) => engine.runRegexScript(script, text)); },
    };
}
