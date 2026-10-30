import { readPlaySettings } from './play-settings.js';

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Literal, case-sensitive pairs. Incomplete outer blocks remain visible. */
export function hidePlayTags(source, names) {
    const tags = [...new Set(names.split(/[,，\r\n]+/).map(name => name.trim()).filter(Boolean))];
    if (!tags.length || !source) return source;
    const pattern = new RegExp('(?<!`)`[^`\\r\\n]+`(?!`)|<(/?)(' + tags.map(escapeRegex).join('|') + ')>', 'g');
    const rawMatches = [...source.matchAll(pattern)];
    if (!rawMatches.length) return source;
    const matches = rawMatches.filter(m => !m[0].startsWith('`'));
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

/** Read all rules in host order; source identity keeps plugin choices stable. */
export function readTavernRegex(engine, context, character) {
    const hostEnabled = !context.extensionSettings?.disabledExtensions?.includes('regex');
    const current = context.characters?.[context.characterId];
    const target = character?.avatar ? context.characters?.find(item => item.avatar === character.avatar) : current;
    const owner = {
        GLOBAL: [],
        PRESET: [engine.getCurrentPresetAPI(), engine.getCurrentPresetName()],
        SCOPED: [target?.avatar ?? ''],
    };
    return Object.entries(engine.SCRIPT_TYPES).flatMap(([source, type]) => {
        const otherCharacter = source === 'SCOPED' && target?.avatar !== current?.avatar;
        const scripts = otherCharacter ? target?.data?.extensions?.regex_scripts ?? []
            : engine.getScriptsByType(type, { allowedOnly: false });
        const allowed = new Set((otherCharacter
            ? (context.extensionSettings?.character_allowed_regex?.includes(target?.avatar) ? scripts : [])
            : engine.getScriptsByType(type, { allowedOnly: true })).map(script => script.id));
        return scripts.map(script => ({ source, key: JSON.stringify([source, ...owner[source], script.id]),
            enabled: hostEnabled && allowed.has(script.id) && !script.disabled, script: structuredClone(script) }));
    });
}

/** The list and both processing stages share this choice; host settings stay read-only. */
export function isPlayRegexSelected(rule, settings) {
    const override = settings.regexOverrides?.[rule.key];
    return typeof override === 'boolean' ? override : rule.enabled !== false;
}

const WILDCARD_PREFIX = /^\s*(?:\((?:\?:)?(?:\[\\(?:s\\S|S\\s|d\\D|D\\d|w\\W|W\\w)\]|\.)[*+]\??\)|(?:\[\\(?:s\\S|S\\s|d\\D|D\\d|w\\W|W\\w)\]|\.)[*+]\??)/;

// A guard may reject text only when every possible match needs one of these
// literal strings. Unsupported syntax falls back to the host regex unchanged.
function regexRequirements(pattern) {
    let index = 0;
    const choose = candidates => candidates.filter(Boolean).sort((a, b) =>
        Math.min(...b.map(text => text.length)) - Math.min(...a.map(text => text.length)) || a.length - b.length)[0] ?? null;
    function expression(depth = 0) {
        if (depth > 32) throw Error();
        const alternatives = [];
        do {
            const candidates = [];
            let run = '';
            const flush = () => { if (run) candidates.push([run]); run = ''; };
            while (index < pattern.length && !['|', ')'].includes(pattern[index])) {
                let literal = null, required = null;
                const ch = pattern[index++];
                if (ch === '(') {
                    if (pattern.slice(index, index + 2) === '?:') index += 2;
                    else if (pattern[index] === '?') throw Error();
                    required = expression(depth + 1);
                    if (pattern[index++] !== ')') throw Error();
                } else if (ch === '[') {
                    let closed = false;
                    while (index < pattern.length) {
                        const item = pattern[index++];
                        if (item === '\\') index++;
                        else if (item === ']') { closed = true; break; }
                    }
                    if (!closed) throw Error();
                } else if (ch === '\\') {
                    const escaped = pattern[index++];
                    if (!escaped) throw Error();
                    if (/[dDsSwWbB]/.test(escaped)) { /* Class or boundary: no required literal. */ }
                    else if (escaped === 'x' || escaped === 'u') {
                        const length = escaped === 'x' ? 2 : 4;
                        const digits = pattern.slice(index, index + length);
                        if (digits.length !== length || !/^[0-9a-f]+$/i.test(digits)) throw Error();
                        literal = String.fromCharCode(parseInt(digits, 16)); index += length;
                    } else if (Object.hasOwn({ n: 1, r: 1, t: 1, f: 1, v: 1 }, escaped)) {
                        literal = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' }[escaped];
                    } else if (/[a-z0-9]/i.test(escaped)) throw Error();
                    else literal = escaped;
                } else if (!['.', '^', '$'].includes(ch)) {
                    if (['*', '+', '?'].includes(ch)) throw Error();
                    literal = ch;
                }
                if (literal !== null) required = [literal];
                let quantified = false, minimum = 1;
                if (['*', '+', '?'].includes(pattern[index])) {
                    quantified = true; minimum = pattern[index++] === '+' ? 1 : 0;
                } else {
                    const quantifier = pattern.slice(index).match(/^\{(\d+)(?:,\d*)?\}/);
                    if (quantifier) { quantified = true; minimum = Number(quantifier[1]); index += quantifier[0].length; }
                }
                if (quantified && pattern[index] === '?') index++;
                if (!quantified && literal !== null) run += literal;
                else {
                    flush();
                    if (minimum > 0 && required) candidates.push(required);
                }
            }
            flush(); alternatives.push(choose(candidates));
            if (pattern[index] !== '|') break;
            index++;
        } while (true);
        if (alternatives.some(item => !item)) return null;
        const result = [...new Set(alternatives.flat())];
        if (result.length > 100) throw Error();
        return result;
    }
    const result = expression();
    if (index !== pattern.length) throw Error();
    return result;
}

export function compileRegexGuard(findRegex) {
    if (typeof findRegex !== 'string' || !findRegex || findRegex.includes('{{')) return null;
    const match = findRegex.match(/^(\/?)(.+)\1([a-z]*)$/i);
    if (!match) return null;
    const [, , pattern, flags] = match;
    if (!WILDCARD_PREFIX.test(pattern) || flags.includes('v')) return null;
    if (flags.includes('u') && (/[\uD800-\uDFFF]/.test(pattern) || /\\u(?:d[89ab][0-9a-f]{2})/i.test(pattern))) return null;
    try {
        // Validate syntax before using any inference, including raw patterns.
        new RegExp(pattern, flags);
        const literals = regexRequirements(pattern);
        if (!literals?.length) return null;
        const ignoreCase = flags.includes('i');
        const checks = ignoreCase ? literals.map(text => new RegExp(escapeRegex(text), flags.includes('u') ? 'iu' : 'i')) : null;
        return { ignoreCase, literals,
            canMatch(text) { return checks ? checks.some(check => check.test(text)) : literals.some(literal => text.includes(literal)); },
        };
    } catch { return null; }
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

function processPlayRegex(source, settings, rules, runRegex, placement, purpose, depth, original = true) {
    let text = original ? hidePlayTags(source, settings.hiddenTags) : source;
    if (settings.regexEnabled) {
        // Branch originals have not passed Tavern's ordinary write-time stage.
        // Both display and sending run ordinary substitutions before their own stage.
        for (const only of [false, true]) {
            if (!only && !original) continue;
            for (const rule of rules) {
                const script = rule.script;
                if (!isPlayRegexSelected(rule, settings) || !script.placement?.includes(placement)) continue;
                if (only ? !script[purpose] : script.markdownOnly || script.promptOnly) continue;
                if (typeof depth === 'number') {
                    if (script.minDepth !== null && Number.isFinite(Number(script.minDepth)) && script.minDepth >= -1 && depth < script.minDepth) continue;
                    if (script.maxDepth !== null && Number.isFinite(Number(script.maxDepth)) && script.maxDepth >= 0 && depth > script.maxDepth) continue;
                }
                const guard = getRuleGuard(rule);
                if (guard && !guard.canMatch(text)) continue;
                // A plugin override may enable a script disabled in Tavern. Never
                // change the host object; its engine checks disabled itself.
                text = runRegex(script.disabled ? { ...script, disabled: false } : script, text);
            }
        }
    }
    // Marker visibility belongs to the renderer; keep this copy intact for
    // Markdown code examples and executable documents in isolated iframes.
    return text;
}

export function processPlayText(source, settings, rules, runRegex, placement = 2, depth) {
    return processPlayRegex(source, settings, rules, runRegex, placement, 'markdownOnly', depth);
}

export function processPlayPromptText(source, settings, rules, engine, placement, depth, original = true) {
    return processPlayRegex(source, settings, rules, (script, text) => engine.runRegexScript(script, text), placement, 'promptOnly', depth, original);
}

const loadNativeRegex = () => import(new URL('../../../../scripts/extensions/regex/engine.js', import.meta.url).href);

function displaySnapshot(config, rules) {
    return JSON.stringify([
        config?.hiddenTags,
        config?.regexEnabled,
        config?.regexOverrides,
        rules?.map(rule => [rule.key, rule.enabled, rule.script]),
    ]);
}

/** A view snapshot, refreshed on opening/settings actions; never a saved rule copy. */
export function createPlayDisplay(ctx, settings, loadEngine = loadNativeRegex, diagnostics) {
    let loading, engine, rules = [], sources = {}, config = structuredClone(readPlaySettings(settings)), revision = 0;
    let lastSnapshot = displaySnapshot(config, rules);
    let selectedCharacter;
    const roleRules = new Map();
    const roleEngines = new Map(), roleLoading = new Map();
    let refreshId = 0;

    async function ensure(character) {
        if (!character?.avatar || roleEngines.has(character.avatar)) return;
        if (!roleLoading.has(character.avatar)) {
            const id = refreshId;
            const task = (async () => {
                const loaded = await loadEngine(character);
                if (id !== refreshId) return;
                const loadedRules = readTavernRegex(loaded, ctx(), character);
                roleEngines.set(character.avatar, loaded);
                roleRules.set(character.avatar, loadedRules);
            })().finally(() => { if (roleLoading.get(character.avatar) === task) roleLoading.delete(character.avatar); });
            roleLoading.set(character.avatar, task);
        }
        await roleLoading.get(character.avatar);
    }

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
        ensure,
        async refresh(character) {
            const id = ++refreshId;
            if (character) selectedCharacter = character;
            let nextRules = rules;
            try {
                const context = ctx();
                const target = selectedCharacter ?? context.characters?.[context.characterId];
                roleEngines.clear(); roleRules.clear(); roleLoading.clear();
                await ensure(target);
                if (id !== refreshId) return rules;
                engine = roleEngines.get(target?.avatar) ?? await (loading ??= loadEngine(target));
                nextRules = readTavernRegex(engine, context, target);
                if (target?.avatar) roleRules.set(target.avatar, nextRules);
                sources = { PRESET: engine.getCurrentPresetName(), SCOPED: target?.name ?? '' };
            } catch (error) {
                if (id !== refreshId) return rules;
                diagnostics?.error('载入酒馆回复显示规则', error);
                loading = null; sources = {}; roleRules.clear(); roleEngines.clear(); roleLoading.clear(); engine = null;
                syncState(structuredClone(readPlaySettings(settings)), []);
                throw error;
            }
            syncState(structuredClone(readPlaySettings(settings)), nextRules);
            return rules;
        },
        process(source, character, requestContext, role = 'assistant', depth) {
            const targetRules = character?.avatar ? roleRules.get(character.avatar) ?? [] : rules;
            const target = character ?? selectedCharacter;
            const targetEngine = roleEngines.get(target?.avatar) ?? engine;
            const placement = role === 'user' ? targetEngine?.regex_placement.USER_INPUT ?? 1 : targetEngine?.regex_placement.AI_OUTPUT ?? 2;
            return processPlayText(source, config, targetRules, (script, text) => {
                // Resolve target names before the native engine consults the
                // host's current character while substituting replacement text.
                const names = value => String(value ?? '').replace(/\{\{char\}\}|<char>|\{\{user\}\}|<user>/gi,
                    match => /char/i.test(match) ? target?.name ?? ctx().name2 ?? '' : requestContext?.userName ?? match);
                const mode = Number(script.substituteRegex);
                const findRegex = mode === 1 ? names(script.findRegex) : mode === 2
                    ? String(script.findRegex).replace(/\{\{char\}\}|<char>|\{\{user\}\}|<user>/gi,
                        match => /char/i.test(match) ? escapeRegex(target?.name ?? ctx().name2 ?? '')
                            : requestContext?.userName === undefined ? match : escapeRegex(requestContext.userName)) : script.findRegex;
                return targetEngine.runRegexScript({ ...script, findRegex, replaceString: names(script.replaceString),
                    trimStrings: script.trimStrings?.map(names) }, text, { characterOverride: target?.name });
            }, placement, depth);
        },
    };
}

