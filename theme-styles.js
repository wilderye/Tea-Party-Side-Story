const panelScope = '#teahouse-panel[data-appearance="tavern"]';
const prose = ':is(.tea-body,.play-prose)';
const neutralAncestors = new Set(['#chat', '.mes', '.mes_block']);
const proseTags = /^(?:p|q|em|i|b|strong|u|s|del|a|h[1-6]|blockquote|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|pre|code|kbd|samp|hr|img|ruby|rt|rp)(?=[.#[:\s>+~]|$)/;
// The prose wrapper's foreground and background must travel together.
const rootProperties = /^(?:color|background(?:-.+)?|line-height|letter-spacing|word-spacing|text-align|text-indent|text-transform|font-weight|font-style|font-variant(?:-.+)?)$/;
const bodyProperties = /^(?:color|background(?:-.+)?|border(?:-.+)?|outline(?:-.+)?|box-shadow|padding(?:-.+)?|margin(?:-.+)?|font-(?:size|weight|style|variant(?:-.+)?|stretch)|line-height|letter-spacing|word-spacing|text-.+|white-space|word-break|overflow-wrap|hyphens|vertical-align|list-style(?:-.+)?|counter-(?:reset|increment)|opacity|display|width|min-width|max-width|height|min-height|max-height|overflow(?:-[xy])?|tab-size|caption-side|empty-cells|border-collapse|border-spacing|content|position|inset(?:-.+)?|top|right|bottom|left|transform(?:-.+)?|box-decoration-break|-webkit-box-decoration-break)$/;

// Split at top level only. Commas/whitespace inside :is(), attributes and CSS
// strings belong to that selector; they must not turn into new scoped rules.
function splitSelector(source, separator) {
    const parts = []; let start = 0, depth = 0, quote = '';
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === '\\') { index++; continue; }
        if (quote) { if (character === quote) quote = ''; continue; }
        if (character === '"' || character === "'") { quote = character; continue; }
        if ('([{'.includes(character)) depth++;
        else if (')]}'.includes(character)) depth--;
        else if (!depth && separator.test(character)) {
            if (source.slice(start, index).trim()) parts.push(source.slice(start, index).trim());
            if ('>+~'.includes(character)) parts.push(character);
            start = index + 1;
        }
    }
    if (source.slice(start).trim()) parts.push(source.slice(start).trim());
    return parts;
}

function mapSelector(selector) {
    const parts = splitSelector(selector, /[\s>+~]/);
    const index = parts.findIndex(part => /^\.mes_text(?=[.#[:]|$)/.test(part));
    if (index >= 0) {
        // A sibling of the prose wrapper is outside the body. Descendant
        // sibling selectors (for example p + p) remain safely inside it.
        if (['+', '~'].includes(parts[index + 1])) return null;
        let ancestor = '', specificity = '';
        for (const part of parts.slice(0, index)) {
            if (part === '>') continue;
            if (neutralAncestors.has(part)) {
                // Keep the removed ancestor's specificity without adding real
                // Tavern classes/IDs that its scripts could mistake for messages.
                specificity += part[0] === '#' ? ':not(#tea-theme-unused)' : ':not(.tea-theme-unused)';
            } else if (/^(?:html|body)(?=[.#[:]|$)/.test(part)) ancestor += part + ' ';
            else return null;
        }
        const suffix = parts[index].slice('.mes_text'.length);
        return { selector: `${ancestor}${panelScope} ${prose}${specificity}${suffix}${index + 1 < parts.length ? ' ' + parts.slice(index + 1).join(' ') : ''}`,
            root: index === parts.length - 1 && !suffix.includes('::') };
    }
    if (selector.includes('.mes_text')) return null;
    // Variables defined on ordinary message wrappers may be used by body rules.
    if (parts.every(part => neutralAncestors.has(part) || part === '>')) return { selector: `${panelScope} :where(.tea-body,.play-prose)`, variablesOnly: true };
    let ancestor = '';
    while (/^(?:html|body)(?=[.#[:]|$)/.test(parts[0] || '')) {
        ancestor += parts.shift() + ' ';
        if (parts[0] === '>') parts.shift();
    }
    if (!proseTags.test(parts[0] || '') && !/^:(?:is|where)\(/.test(parts[0] || '')) return null;
    // :is/:where may group body tags, but must not smuggle in the page shell.
    if (/^:(?:is|where)\(/.test(parts[0]) && !/^:(?:is|where)\((?:\s*(?:p|q|em|strong|code|pre|blockquote|table|h[1-6])\s*,?)+\)$/.test(parts[0])) return null;
    return { selector: `${ancestor}${panelScope} :where(.tea-body,.play-prose) ${parts.join(' ')}`, root: false };
}

function resolveUrls(value, base) {
    return value.replace(/url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^)'"\\]*))\s*\)/gi, (match, double, single, plain) => {
        const url = (double ?? single ?? plain).trim();
        if (!url || url.startsWith('#') || url.startsWith('data:')) return match;
        try { return `url(${JSON.stringify(new URL(url, base).href)})`; } catch { return match; }
    });
}

function declarations(style, mapped, base) {
    const result = [];
    let fontSize = '';
    // A shorthand containing var() has empty longhands until computed. Read
    // the serialized declarations to retain its background/border as authored.
    for (const declaration of splitSelector(style.cssText, /;/)) {
        const property = declaration.slice(0, declaration.indexOf(':')).trim();
        if (property === 'text-shadow') continue;
        const custom = property.startsWith('--') && !/^--(?:tea|play)-/.test(property);
        if (mapped.variablesOnly && !custom) continue;
        if (!custom && !(mapped.root ? rootProperties : bodyProperties).test(property)) continue;
        let value = style.getPropertyValue(property);
        if (!value) continue;
        if (property === 'position' && value !== 'relative') continue;
        // Native font-size variables in code/headings should use the reader's
        // chosen size. Font families and the body base size stay panel-owned.
        value = value.replace(/var\(\s*--mainFontSize\s*([,)])/g, 'var(--tea-body-size$1');
        const serialized = `${property}:${resolveUrls(value, base)}${!mapped.variablesOnly && style.getPropertyPriority(property) ? '!important' : ''};`;
        if (property === 'font-size') fontSize = serialized;
        else result.push(serialized);
    }
    return { css: result.join(''), fontSize };
}

/** Read loaded styles only; never fetch CSS or inspect chat/settings data. */
export function readThemeBodyStyles() {
    const ownStyle = new URL('./style.css', import.meta.url).href;
    const skipped = new Set(), unreadable = new Set();
    let copied = 0;
    function readRules(sheet) {
        if (!sheet || sheet.disabled || sheet.ownerNode?.hasAttribute('data-tea-theme-style') || sheet.href?.split('?')[0] === ownStyle) return '';
        let rules;
        try { rules = sheet.cssRules; }
        catch { unreadable.add(sheet.href || 'inline'); return ''; }
        return convert(rules, sheet.href || document.baseURI, sheet.ownerNode?.id === 'custom-style');
    }
    function convert(rules, base, custom) {
        const output = [];
        for (const rule of rules) {
            if (rule.type === CSSRule.STYLE_RULE) {
                if (custom && rule.cssRules?.length && rule.cssText.includes('.mes_text')) skipped.add(rule.selectorText + ' (nested)');
                for (const selector of splitSelector(rule.selectorText, /,/)) {
                    const mapped = mapSelector(selector);
                    if (!mapped) { if (custom && selector.includes('.mes_text')) skipped.add(selector); continue; }
                    const body = declarations(rule.style, mapped, base);
                    if (body.css) output.push(`${mapped.selector}{${body.css}}`);
                    if (body.fontSize) {
                        // Restrict the actual matched element, including mixed :is()
                        // groups, so stronger theme rules cannot resize ordinary prose.
                        // Decorative pseudo-elements keep their own sizing.
                        const target = /::?(?:before|after|first-letter|first-line|marker)$/.test(mapped.selector) ? mapped.selector
                            : `:is(${mapped.selector}):where(h1,h2,h3,h4,h5,h6,pre,code,kbd,samp)`;
                        output.push(`${target}{${body.fontSize}}`);
                    }
                    if (body.css || body.fontSize) copied++;
                }
            } else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
                const body = convert(rule.cssRules, base, custom);
                if (body) output.push(`@${rule.type === CSSRule.MEDIA_RULE ? 'media' : 'supports'} ${rule.conditionText}{${body}}`);
            } else if (rule.type === CSSRule.IMPORT_RULE) {
                const body = readRules(rule.styleSheet);
                if (body) output.push(rule.media.mediaText ? `@media ${rule.media.mediaText}{${body}}` : body);
            } else if (rule.cssRules && custom && rule.cssText.includes('.mes_text')) skipped.add(rule.cssText.slice(0, rule.cssText.indexOf('{')).trim());
        }
        return output.join('\n');
    }
    const css = [...document.styleSheets].map(sheet => {
        const body = readRules(sheet);
        return body && sheet.media.mediaText ? `@media ${sheet.media.mediaText}{${body}}` : body;
    }).join('\n');
    return { css, copied, skipped: [...skipped], unreadable: unreadable.size };
}
