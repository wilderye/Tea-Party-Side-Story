import { readPlaySettings } from './play-settings.js';

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Literal, case-sensitive pairs. Incomplete outer blocks remain visible. */
export function hidePlayTags(source, names) {
    const tags = [...new Set(names.split(/[,，\r\n]+/).map(name => name.trim()).filter(Boolean))];
    if (!tags.length || !source) return source;
    const pattern = new RegExp(`<(/?)(${tags.map(escapeRegex).join('|')})>`, 'g');
    const matches = [...source.matchAll(pattern)];
    if (!matches.length) return source;

    const remainingCloses = {};
    for (const tag of tags) remainingCloses[tag] = 0;
    for (const m of matches) {
        if (m[1]) remainingCloses[m[2]] = (remainingCloses[m[2]] || 0) + 1;
    }

    const stack = [], parts = [];
    let cursor = 0, start = 0, lastClosedTag = null;

    for (const match of matches) {
        const isClose = Boolean(match[1]);
        const tag = match[2];

        if (!isClose) {
            lastClosedTag = null;
            const openInStack = stack.filter(t => t === tag).length;
            if (!stack.length || remainingCloses[tag] > openInStack) {
                if (!stack.length) start = match.index;
                stack.push(tag);
            }
        } else {
            remainingCloses[tag]--;
            const idx = stack.lastIndexOf(tag);
            if (idx !== -1) {
                stack.length = idx;
                if (!stack.length) {
                    parts.push(source.slice(cursor, start));
                    cursor = match.index + match[0].length;
                    lastClosedTag = tag;
                }
            } else if (!stack.length && lastClosedTag === tag && /^\s*$/.test(source.slice(cursor, match.index))) {
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

const WILDCARD_PREFIX = /^\s*(?:\((?:\?:)?(?:\[\\(?:s\\S|S\\s|d\\D|D\\d|w\\W|W\\w)\]|\.)[*+]\??\)|(?:\[\\(?:s\\S|S\\s|d\\D|D\\d|w\\W|W\\w)\]|\.)[*+]\??)/;

export function splitAlternatives(str) {
    const parts = [];
    let depthParen = 0, inClass = false, escaped = false, start = 0;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '[' && !inClass) { inClass = true; continue; }
        if (ch === ']' && inClass) { inClass = false; continue; }
        if (inClass) continue;
        if (ch === '(') depthParen++;
        else if (ch === ')') { if (depthParen > 0) depthParen--; }
        else if (ch === '|' && depthParen === 0) {
            parts.push(str.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(str.slice(start));
    return parts;
}

export function extractLiteralsFromAlternative(alt) {
    const tokens = [];
    let i = 0;
    while (i < alt.length) {
        const ch = alt[i];
        if (ch === '\\') {
            i++;
            if (i >= alt.length) break;
            const next = alt[i];
            if (/[dswbDSWB]/.test(next)) {
                tokens.push({ type: 'other' });
                i++;
            } else if (next === 'n') {
                tokens.push({ type: 'lit', char: '\n' });
                i++;
            } else if (next === 't') {
                tokens.push({ type: 'lit', char: '\t' });
                i++;
            } else if (next === 'r') {
                tokens.push({ type: 'lit', char: '\r' });
                i++;
            } else if (next === 'x' && /^[0-9a-fA-F]{2}/.test(alt.slice(i + 1, i + 3))) {
                tokens.push({ type: 'lit', char: String.fromCharCode(parseInt(alt.slice(i + 1, i + 3), 16)) });
                i += 3;
            } else if (next === 'u' && /^[0-9a-fA-F]{4}/.test(alt.slice(i + 1, i + 5))) {
                tokens.push({ type: 'lit', char: String.fromCharCode(parseInt(alt.slice(i + 1, i + 5), 16)) });
                i += 5;
            } else {
                tokens.push({ type: 'lit', char: next });
                i++;
            }
        } else if (ch === '[') {
            let j = i + 1;
            while (j < alt.length) {
                if (alt[j] === '\\') j += 2;
                else if (alt[j] === ']') { j++; break; }
                else j++;
            }
            tokens.push({ type: 'other' });
            i = j;
        } else if (ch === '(' || ch === ')') {
            tokens.push({ type: 'other' });
            i++;
        } else if (ch === '{') {
            const end = alt.indexOf('}', i + 1);
            if (tokens.length > 0 && end !== -1 && /^\{\d+(?:,\d*)?\}/.test(alt.slice(i))) {
                if (/^\{0\b/.test(alt.slice(i))) tokens[tokens.length - 1].optional = true;
                i = end + 1;
                if (alt[i] === '?') i++;
            } else {
                tokens.push({ type: 'lit', char: '{' });
                i++;
            }
        } else if (/[*+?]/.test(ch)) {
            if (tokens.length > 0) {
                if (ch === '*' || ch === '?') tokens[tokens.length - 1].optional = true;
            }
            i++;
            if (alt[i] === '?') i++;
        } else if (/[.^$|]/.test(ch)) {
            tokens.push({ type: 'other' });
            i++;
        } else {
            tokens.push({ type: 'lit', char: ch });
            i++;
        }
    }
    const runs = [];
    let current = '';
    for (const token of tokens) {
        if (token.type === 'lit' && !token.optional) {
            current += token.char;
        } else {
            if (current) runs.push(current);
            current = '';
        }
    }
    if (current) runs.push(current);
    if (!runs.length) return null;
    runs.sort((a, b) => b.length - a.length);
    return runs[0];
}

export function compileRegexGuard(findRegex) {
    if (typeof findRegex !== 'string' || !findRegex || findRegex.includes('{{')) return null;
    const match = findRegex.match(/^(\/?)(.+)\1([a-z]*)$/i);
    if (!match) return null;
    const [, , pattern, flags] = match;
    const ignoreCase = flags.includes('i');

    const prefixMatch = pattern.match(WILDCARD_PREFIX);
    if (!prefixMatch) return null;

    let rest = pattern.slice(prefixMatch[0].length).trim();
    if (!rest) return null;

    while ((rest.startsWith('(?:') && rest.endsWith(')')) || (rest.startsWith('(') && rest.endsWith(')'))) {
        const offset = rest.startsWith('(?:') ? 3 : 1;
        let depth = 0, wrapsAll = true;
        for (let i = 0; i < rest.length - 1; i++) {
            if (rest[i] === '\\') { i++; continue; }
            if (rest[i] === '(') depth++;
            else if (rest[i] === ')') {
                depth--;
                if (depth === 0) { wrapsAll = false; break; }
            }
        }
        if (wrapsAll && depth === 1) {
            rest = rest.slice(offset, -1).trim();
        } else {
            break;
        }
    }

    const alternatives = splitAlternatives(rest);
    if (!alternatives.length) return null;

    const literals = [];
    for (const alt of alternatives) {
        const lit = extractLiteralsFromAlternative(alt.trim());
        if (!lit) return null;
        literals.push(ignoreCase ? lit.toLowerCase() : lit);
    }

    return {
        ignoreCase,
        literals,
        canMatch(text) {
            if (!text) return false;
            const target = ignoreCase ? text.toLowerCase() : text;
            for (let i = 0; i < literals.length; i++) {
                if (target.includes(literals[i])) return true;
            }
            return false;
        },
    };
}

const ruleGuardCache = new WeakMap();

function getRuleGuard(rule) {
    if (!rule || typeof rule !== 'object') return null;
    let guard = ruleGuardCache.get(rule);
    if (guard === undefined) {
        guard = compileRegexGuard(rule.script?.findRegex);
        ruleGuardCache.set(rule, guard);
    }
    return guard;
}

export function processPlayText(source, settings, rules, runRegex) {
    let text = hidePlayTags(source, settings.hiddenTags);
    if (settings.regexEnabled) {
        const excluded = new Set(settings.excludedRegex);
        // ST runs ordinary output substitutions before display-only substitutions.
        for (const markdownOnly of [false, true]) {
            for (const rule of rules) {
                if (excluded.has(rule.key) || !!rule.script.markdownOnly !== markdownOnly) continue;
                const guard = getRuleGuard(rule);
                if (guard && !guard.canMatch(text)) continue;
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

function displaySnapshot(config, rules) {
    return JSON.stringify([
        config?.hiddenTags,
        config?.regexEnabled,
        config?.excludedRegex,
        rules?.map(rule => [rule.key, rule.script]),
    ]);
}

/** A view snapshot, refreshed on opening/settings actions; never a saved rule copy. */
export function createPlayDisplay(ctx, settings, loadEngine = loadNativeRegex, diagnostics) {
    let loading, engine, rules = [], sources = {}, config = structuredClone(readPlaySettings(settings)), revision = 0;
    let lastSnapshot = displaySnapshot(config, rules);

    function syncState(nextConfig, nextRules) {
        const nextSnapshot = displaySnapshot(nextConfig, nextRules);
        config = nextConfig;
        rules = nextRules;
        if (nextSnapshot !== lastSnapshot) {
            lastSnapshot = nextSnapshot;
            revision++;
        }
    }

    return {
        get revision() { return revision; },
        get rules() { return rules; },
        get sources() { return sources; },
        updateSettings() { syncState(structuredClone(readPlaySettings(settings)), rules); },
        async refresh() {
            let nextRules = rules;
            try {
                engine = await (loading ??= loadEngine());
                const context = ctx();
                nextRules = readTavernRegex(engine, context);
                sources = { PRESET: engine.getCurrentPresetName(), SCOPED: context.characters?.[context.characterId]?.name ?? '' };
            } catch (error) {
                diagnostics?.error('载入酒馆回复显示规则', error);
                loading = null; sources = {};
                syncState(structuredClone(readPlaySettings(settings)), []);
                throw error;
            }
            syncState(structuredClone(readPlaySettings(settings)), nextRules);
            return rules;
        },
        process(source) { return processPlayText(source, config, rules, (script, text) => engine.runRegexScript(script, text)); },
    };
}

