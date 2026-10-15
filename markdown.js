import MarkdownIt from './vendor/markdown-it.js';

// Rendering never substitutes macros or modifies the source passed to SillyTavern.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
const quoteEnds = new Map([['“', '”'], ['"', '"'], ['«', '»'], ['「', '」'], ['『', '』'], ['＂', '＂']]);

// Reserve double/triple underscores for Tavern's underline syntax. Code,
// escapes and link destinations are consumed by their existing inline rules.
markdown.inline.ruler.before('emphasis', 'tea_underline_markers', (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== '__') return false;
    const start = state.pos;
    while (state.src[state.pos] === '_') state.pos++;
    if (!silent) state.push('text', '', 0).content = state.src.slice(start, state.pos);
    return true;
});

// Only bare q/u pairs become formatting. Consume other tag-shaped text as one
// escaped token, including its quoted attributes; HTML execution stays disabled.
markdown.inline.ruler.before('html_inline', 'tea_format_tags', (state, silent) => {
    if (!/^<[!/?a-zA-Z]/.test(state.src.slice(state.pos, state.pos + 2))) return false;
    const start = state.pos;
    let quote = '', end = start + 1;
    if (state.src.startsWith('<!--', start)) {
        const close = state.src.indexOf('-->', start + 4);
        end = close < 0 ? state.posMax - 1 : Math.min(close + 2, state.posMax - 1);
    } else {
        for (; end < state.posMax; end++) {
            const character = state.src[end];
            if (quote) { if (character === quote) quote = ''; }
            else if (character === '"' || character === "'") quote = character;
            else if (character === '>') break;
            else if (character === '<' || character === '\n') return false;
        }
    }
    if (end === state.posMax) return false;
    if (!silent) {
        const token = state.push('text_special', '', 0);
        token.content = state.src.slice(start, end + 1);
        const match = /^<(\/?)(q|u)>$/i.exec(token.content);
        if (match) token.meta = { teaFormatTag: match[2].toLowerCase(), closing: Boolean(match[1]) };
    }
    state.pos = end + 1;
    return true;
});

function formatTags(tokens) {
    const opened = [], scopes = [], pairs = [];
    for (const token of tokens) {
        if (token.nesting === 1) scopes.push(token);
        else if (token.nesting === -1) scopes.pop();
        if (!token.meta?.teaFormatTag) continue;
        const { teaFormatTag: tag, closing } = token.meta;
        if (!closing) { opened.push({ token, scope: scopes.at(-1), depth: opened.length + scopes.length }); continue; }
        const start = opened.at(-1);
        if (start?.token.meta.teaFormatTag !== tag) { opened.length = 0; continue; }
        opened.pop();
        // A pair must stay within the same Markdown nesting. Malformed or
        // unfinished pairs remain visible, rather than producing broken HTML.
        if (start.scope === scopes.at(-1) && start.depth < markdown.options.maxNesting) pairs.push([start.token, token]);
    }
    for (const [start, end] of pairs) {
        const tag = start.meta.teaFormatTag;
        for (const [marker, nesting] of [[start, 1], [end, -1]]) {
            marker.type = `tea_${tag}_${nesting > 0 ? 'open' : 'close'}`;
            marker.tag = tag; marker.nesting = nesting; marker.content = '';
        }
    }
}

// Work on parsed inline text. Split existing formatting at range boundaries
// so partially overlapping quotes, emphasis and underlines stay balanced.
function inlineText(tokens, forQuotes = false) {
    const root = { children: [], start: 0 }, stack = [root];
    let text = '', protectedDepth = 0;
    for (const token of tokens) {
        if (token.nesting === 1) {
            const node = { token, children: [], start: text.length };
            stack.at(-1).children.push(node); stack.push(node);
            if (forQuotes && ['a', 'q'].includes(token.tag)) protectedDepth++;
        } else if (token.nesting === -1) {
            const node = stack.pop(); node.close = token; node.end = text.length;
            if (forQuotes && ['a', 'q'].includes(token.tag)) protectedDepth--;
        } else {
            const content = ['text', 'text_special'].includes(token.type) ? token.content
                : ['softbreak', 'hardbreak'].includes(token.type) ? '\n' : '\0';
            stack.at(-1).children.push({ token, start: text.length, end: text.length + content.length });
            text += content === '\n' ? '\n' : token.type === 'text' && !protectedDepth ? content : '\0'.repeat(content.length);
        }
    }
    root.end = text.length;
    return { root, text };
}

function wrapRanges(root, ranges, tag, state) {
    const grouped = new Map();
    for (const range of ranges) {
        let owner = root, child;
        // Keep a containing link or explicit format intact. Only split an
        // existing element when the new range actually crosses its boundary.
        while ((child = owner.children.find(node => node.children && node.start <= range.start && node.end >= range.end))) owner = child;
        if (!grouped.has(owner)) grouped.set(owner, []);
        grouped.get(owner).push(range);
    }
    function slice(node, start, end) {
        if (node.end <= start || node.start >= end) return [];
        if (node.children) {
            if (grouped.has(node) && start <= node.start && end >= node.end) return decorate(node);
            const children = node.children.flatMap(child => slice(child, start, end));
            return node.token && children.length ? [node.token, ...children, node.close] : children;
        }
        if (!['text', 'text_special'].includes(node.token.type)) return [node.token];
        const token = Object.assign(new state.Token(node.token.type, node.token.tag, 0), node.token);
        token.content = token.content.slice(Math.max(start - node.start, 0), end - node.start);
        return [token];
    }
    function decorate(node) {
        const contents = (start, end) => node.children.flatMap(child => slice(child, start, end));
        const result = []; let position = node.start;
        for (const { start, end, trim = 0 } of grouped.get(node) || []) {
            result.push(...contents(position, start), new state.Token(`tea_${tag}_open`, tag, 1),
                ...contents(start + trim, end - trim), new state.Token(`tea_${tag}_close`, tag, -1));
            position = end;
        }
        result.push(...contents(position, node.end));
        return node.token ? [node.token, ...result, node.close] : result;
    }
    return decorate(root);
}

markdown.core.ruler.before('text_join', 'tea_inline_formats', state => {
    for (const inline of state.tokens) {
        if (inline.type !== 'inline') continue;
        formatTags(inline.children);
        if (inline.content.includes('__')) {
            const { root, text } = inlineText(inline.children);
            const ranges = [];
            // Tavern accepts double or triple underscores at ASCII word
            // boundaries, including directly beside Chinese prose.
            for (const match of text.matchAll(/\b(___|__)(\S[\s\S]*?)\1\b/g)) {
                ranges.push({ start: match.index, end: match.index + match[0].length, trim: match[1].length });
            }
            if (ranges.length) inline.children = wrapRanges(root, ranges, 'u', state);
        }
        if (!/[“"«「『＂]/.test(inline.content)) continue;
        const { root, text } = inlineText(inline.children, true), ranges = [];
        for (let index = 0; index < text.length; index++) {
            if (!quoteEnds.has(text[index])) continue;
            const end = text.indexOf(quoteEnds.get(text[index]), index + 1), lineEnd = text.indexOf('\n', index + 1);
            if (end < 0 || (lineEnd >= 0 && end > lineEnd)) continue;
            ranges.push({ start: index, end: end + 1 }); index = end;
        }
        if (ranges.length) inline.children = wrapRanges(root, ranges, 'q', state);
    }
});
markdown.renderer.rules.table_open = () => '<div class="tea-table-scroll" tabindex="0" role="region" aria-label="表格，可横向滚动"><table>';
markdown.renderer.rules.table_close = () => '</table></div>';
const linkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return linkOpen ? linkOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};
export function renderMarkdown(source) { return markdown.render(source); }
