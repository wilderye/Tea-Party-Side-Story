import MarkdownIt from './vendor/markdown-it.js';
import { renderTavernProse } from './play-tavern-render.js';
import { prepareHelperResources } from './play-helper-resources.js';
import { element } from './ui.js';
import { recordViewEvent } from './view-diagnostics.js';

const parser = new MarkdownIt({ html: true });
const htmlStart = /^(?:html|head|body|style|script|section|article|main|div|details|table|span|button|form|p|ul|ol|h[1-6])$/i;
const frameSizes = new WeakMap();
const frameJobs = new WeakMap();
const activeFrames = new Set();
const errorNames = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError']);
let frameObserver, diagnostics;

export function initializePlayRendering(log) {
    diagnostics = log;
}

function watchFrames() {
    if (frameObserver) return;
    frameObserver = new MutationObserver(records => {
        for (const job of activeFrames) job.update();
        for (const record of records) for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            frameJobs.get(node)?.update();
            for (const child of node.querySelectorAll('[data-web-preview],iframe.play-web-output')) frameJobs.get(child)?.update();
        }
    });
    frameObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'data-active'] });
}

export function helperResourceMarkup(resources) {
    return resources.map(resource => {
        const node = document.createElement(resource.tag);
        for (const [key, value] of Object.entries(resource.attributes)) {
            if (!['src', 'href', 'integrity', 'crossorigin'].includes(key)) node.setAttribute(key, value);
        }
        const bytes = new TextEncoder().encode(resource.text);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        node.setAttribute(resource.tag === 'script' ? 'src' : 'href', `data:${resource.tag === 'script' ? 'text/javascript' : 'text/css'};base64,${btoa(binary)}`);
        return node.outerHTML;
    }).join('\n');
}

function queueHtmlFrame(html, options, container) {
    const preview = element('div', undefined, 'tea-body play-prose');
    renderTavernProse(preview, html, options); preview.dataset.webPreview = 'true';
    let controller, frame;
    const job = { update() {
        const node = frame ?? preview;
        if (!node.isConnected) {
            controller?.abort(); controller = null;
            if (frame) {
                frameSizes.delete(frame); frameJobs.delete(frame); frame.removeAttribute('srcdoc');
                frame.replaceWith(preview); frame = null;
            }
            activeFrames.delete(job);
            return;
        }
        if (node.parentNode !== container) return;
        activeFrames.add(job);
        if (frame) return;
        if (node.closest('[hidden],[aria-hidden=true],.tea-panel-surface[data-active=false]')) {
            controller?.abort(); controller = null; return;
        }
        if (controller) return;
        const current = new AbortController(); controller = current;
        prepareHelperResources(current.signal).then(resources => {
            if (current.signal.aborted || !preview.isConnected || controller !== current) return;
            frame = htmlFrame(html, resources); frame.dataset.readAnchor = preview.dataset.readAnchor;
            frameJobs.set(frame, job);
            preview.replaceWith(frame);
        });
    } };
    frameJobs.set(preview, job); watchFrames(); queueMicrotask(job.update);
    return preview;
}

globalThis.addEventListener?.('message', event => {
    if (!['teahouse-output-height', 'teahouse-output-resource-error'].includes(event.data?.type)) return;
    for (const frame of document.querySelectorAll('.tea-panel-surface[data-active=true] iframe.play-web-output, #teahouse-panel iframe.play-web-output')) {
        if (frame.closest('[hidden],[aria-hidden=true]')) continue;
        if (frame.contentWindow !== event.source || frameSizes.get(frame) !== event.data.token) continue;
        if (event.data.type === 'teahouse-output-resource-error') {
            const index = event.data.index;
            if (!Number.isInteger(index) || index < 0 || index >= Number(frame.dataset.resourceCount)) return;
            if (event.data.kind === 'execution') {
                const position = Object.fromEntries(['line', 'column'].filter(key => Number.isSafeInteger(event.data[key]) && event.data[key] >= 0)
                    .map(key => [key, event.data[key]]));
                diagnostics?.warn('独立网页资源执行', { name: errorNames.has(event.data.name) ? event.data.name : 'Error' }, { count: index + 1, ...position });
            } else diagnostics?.info('独立网页资源未能载入', { count: index + 1 });
            diagnostics?.info('浏览器继续执行网页的后续脚本');
            break;
        }
        const height = event.data.height;
        if (typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= 100000) {
            recordViewEvent(frame, '网页高度变化', { record: frame.closest('.play-record')?.dataset.record, frameHeight: Math.ceil(height) });
            frame.style.height = `${Math.ceil(height)}px`;
        }
        break;
    }
});

function htmlFrame(html, resources) {
    const frame = element('iframe', undefined, 'play-web-output');
    frame.title = '小剧场网页';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.dataset.resourceCount = String(resources.length);
    // getRandomValues also works on the plain HTTP origins used by LAN clients.
    const token = [...crypto.getRandomValues(new Uint32Array(4))].join('-'); frameSizes.set(frame, token);
    const sizing = `document.addEventListener('DOMContentLoaded', () => {
        let last = 0, scheduled = false, changedContent = false;
        let width = innerWidth, viewportHeight = innerHeight;
        function size() {
            scheduled = false;
            const body = document.body;
            if (!body) return;
            // Resizing this iframe changes vh-based layouts inside it. Record
            // that new baseline without reporting it as newly added content.
            const heightOnlyResize = width === innerWidth && viewportHeight !== innerHeight;
            width = innerWidth; viewportHeight = innerHeight;
            const style = getComputedStyle(body);
            // Measure content, not body's min-height:100vh. The latter measures
            // the iframe's own viewport and grows again when we add margins.
            const range = document.createRange(); range.selectNodeContents(body);
            const bottom = Math.max(range.getBoundingClientRect().bottom, body.getBoundingClientRect().top);
            const height = Math.ceil(bottom + scrollY + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.marginBottom) || 0));
            if (height > 0 && height !== last) {
                last = height;
                if (!heightOnlyResize || changedContent) {
                    parent.postMessage({type:'teahouse-output-height', token:${JSON.stringify(token)}, height}, '*');
                }
            }
            changedContent = false;
        }
        function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(size); } }
        const target = document.body || document.documentElement;
        new ResizeObserver(schedule).observe(target);
        new MutationObserver(() => { changedContent = true; schedule(); })
            .observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
        document.addEventListener('toggle', () => { changedContent = true; schedule(); }, true);
        document.addEventListener('load', () => { changedContent = true; schedule(); }, true);
        window.addEventListener('load', schedule);
        window.addEventListener('resize', schedule);
        document.fonts?.ready.then(schedule);
        schedule();
    }, { once: true });`;
    const monitor = `addEventListener('error', event => {
        const nodes = [...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')].slice(0, ${resources.length});
        const index = nodes.findIndex(node => node === event.target || (node.src || node.href) === event.filename);
        const name = ${JSON.stringify([...errorNames])}.includes(event.error?.name) ? event.error.name : 'Error';
        if (index >= 0) parent.postMessage({type:'teahouse-output-resource-error', token:${JSON.stringify(token)}, index,
            kind:event instanceof ErrorEvent ? 'execution' : 'load', name, line:event.lineno, column:event.colno}, '*');
    }, true);`;
    const prelude = '<meta charset="utf-8"><script>' + monitor + sizing + '</script>' + helperResourceMarkup(resources);
    const opening = /^(\s*(?:<!doctype[^>]*>\s*)?(?:<html\b[^>]*>\s*)?<head\b[^>]*>)/i.exec(html);
    const root = /^(\s*(?:<!doctype[^>]*>\s*)?(?:<html\b[^>]*>\s*)?)/i.exec(html)[0];
    const offset = opening ? opening[0].length : root.length;
    frame.srcdoc = html.slice(0, offset) + prelude + html.slice(offset);
    return frame;
}

function* htmlTags(source, start = 0) {
    const tags = /`+|<!--[^]*?(?:-->|$)|<!doctype[^>]*>|<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/ig;
    tags.lastIndex = start;
    for (let match; (match = tags.exec(source));) {
        if (match[0].startsWith('`')) {
            const closing = new RegExp('(?<!`)' + match[0] + '(?!`)', 'g'); closing.lastIndex = tags.lastIndex;
            if (closing.exec(source)) tags.lastIndex = closing.lastIndex;
            continue;
        }
        const name = match[1]?.toLowerCase(), closing = match[0].startsWith('</');
        const token = { start: match.index, end: tags.lastIndex, name, closing, doctype: /^<!doctype/i.test(match[0]),
            void: /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name), closed: true };
        if (!closing && /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/.test(name)) {
            const end = new RegExp(`</${name}\\s*>`, 'ig'); end.lastIndex = tags.lastIndex;
            token.closed = name !== 'plaintext' && !!end.exec(source);
            token.end = token.closed ? end.lastIndex : source.length;
            token.raw = true; tags.lastIndex = token.end;
        }
        yield token;
    }
}

const optionalEnd = new Set(['li', 'dt', 'dd', 'p', 'rt', 'rp', 'optgroup', 'option', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
function closesOptional(open, next) {
    if (open === 'p') return /^(?:address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|main|menu|nav|ol|p|pre|section|table|ul)$/.test(next);
    if (open === 'li') return next === 'li';
    if (/^(?:dt|dd)$/.test(open)) return /^(?:dt|dd)$/.test(next);
    if (/^(?:rt|rp)$/.test(open)) return /^(?:rt|rp)$/.test(next);
    if (open === 'option') return /^(?:option|optgroup)$/.test(next);
    if (open === 'optgroup') return next === 'optgroup';
    if (/^(?:thead|tbody|tfoot)$/.test(open)) return /^(?:tbody|tfoot)$/.test(next);
    if (open === 'tr') return next === 'tr';
    return /^(?:td|th)$/.test(open) && /^(?:td|th|tr)$/.test(next);
}

function htmlElementEnd(source, start) {
    if (/^<(?:!doctype|html)\b/i.test(source.slice(start))) {
        for (const token of htmlTags(source, start)) {
            if (token.closing && token.name === 'html') return token.end;
            if (token.start > start && token.doctype) return token.start;
        }
        return source.length;
    }
    const stack = [];
    let first = true;
    for (const token of htmlTags(source, start)) {
        if (first && token.start !== start) return -1;
        first = false;
        if (!token.name) {
            if (!stack.length) return token.end;
            continue;
        }
        if (token.raw) {
            if (!token.closed) return -1;
            if (!stack.length) return token.end;
        } else if (token.closing) {
            while (stack.at(-1) !== token.name && optionalEnd.has(stack.at(-1))) stack.pop();
            if (stack.at(-1) !== token.name) return -1;
            stack.pop();
            if (!stack.length) return token.end;
        } else if (!token.void) {
            while (closesOptional(stack.at(-1), token.name)) {
                stack.pop();
                if (!stack.length) return token.start;
            }
            stack.push(token.name);
        } else if (!stack.length) return token.end;
    }
    return -1;
}

export function splitPlayText(source) {
    const tokens = parser.parse(source, {}), lines = source.split('\n'), offsets = [0];
    for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
    const codeRanges = tokens.filter(token => token.type === 'fence' || token.type === 'code_block')
        .map(token => [offsets[token.map[0]], offsets[token.map[1]]]);
    const crossesCode = (start, end) => codeRanges.some(range => start < range[1] && end > range[0]);
    const spans = [];
    let consumed = 0;
    for (const token of tokens) {
        if (!token.map || offsets[token.map[0]] < consumed) continue;
        const start = offsets[token.map[0]], end = Math.min(source.length, offsets[token.map[1]]);
        if (token.type === 'fence') {
            if (/^html$/i.test(token.info.trim())) { spans.push({ start, end, text: token.content }); consumed = end; }
            continue;
        }
        if (token.type !== 'html_block' && !(token.type === 'inline' && token.children.some(child => child.type === 'html_inline'))) continue;
        for (const tag of htmlTags(source, start)) {
            const begin = tag.start;
            if (begin >= end) break;
            if (begin < consumed) continue;
            if (/\\+$/.exec(source.slice(0, begin))?.[0].length % 2 === 1) continue;
            if (tag.raw && !/^(?:script|style)$/.test(tag.name)) {
                consumed = tag.end; continue;
            }
            if (tag.name === 'template' && !tag.closing) {
                const finish = htmlElementEnd(source, begin);
                consumed = finish < 0 ? source.length : finish; continue;
            }
            if (tag.closing || !tag.doctype && !htmlStart.test(tag.name)) continue;
            const completeDocument = /^<(?:!doctype|html)\b/i.test(source.slice(begin));
            let finish = htmlElementEnd(source, begin);
            if (finish < 0 || !completeDocument && crossesCode(begin, finish)) continue;
            while (!completeDocument) {
                const next = finish + /^\s*/.exec(source.slice(finish))[0].length;
                if (!/^<(?:[a-z][\w:-]*\b|!--)/i.test(source.slice(next))) break;
                if (/^<(?:!doctype|html)\b/i.test(source.slice(next))) break;
                const following = htmlElementEnd(source, next);
                if (following < 0 || crossesCode(finish, following)) break;
                finish = following;
            }
            const text = source.slice(begin, finish), template = document.createElement('template'); template.innerHTML = text;
            const executable = [...template.content.querySelectorAll('*')].some(node => node.localName === 'script'
                || [...node.attributes].some(attr => /^on/i.test(attr.name)));
            if (/^<(?:!doctype|html|head|body)\b/i.test(text) || executable) spans.push({ start: begin, end: finish, text });
            consumed = finish;
        }
    }
    const parts = []; let start = 0;
    for (const span of spans) {
        if (span.start > start) parts.push({ type: 'prose', text: source.slice(start, span.start) });
        parts.push({ type: 'web', text: span.text }); start = span.end;
    }
    if (start < source.length) parts.push({ type: 'prose', text: source.slice(start) });
    return parts;
}

/** Read a short preview without creating an iframe or loading document assets. */
export function playTextPreview(source, firstLine = false) {
    if (source.length > 16384 && !/<|```|~~~/.test(source)) source = source.trimStart().slice(0, 16384);
    const compact = text => text.replace(/\s+/g, ' ').trim();
    const htmlText = html => {
        const template = document.createElement('template'); template.innerHTML = html;
        for (const node of template.content.querySelectorAll('script,style,template,iframe,svg,[hidden],[aria-hidden="true"]')) node.remove();
        const title = template.content.querySelector('title,h1,h2')?.textContent;
        for (const node of template.content.querySelectorAll('head,meta,link')) node.remove();
        return compact(title || template.content.textContent || '');
    };
    if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(source)) return htmlText(source) || '网页结果';
    let web = false;
    for (const token of parser.parse(source, {})) {
        let text = '';
        if (token.type === 'html_block' || (token.type === 'fence' && /^html$/i.test(token.info.trim()))) {
            web = true; text = htmlText(token.content);
        } else if (token.type === 'inline') {
            for (const child of token.children) {
                if (['softbreak', 'hardbreak'].includes(child.type)) {
                    if (firstLine && text.trim()) break;
                    text += ' ';
                } else if (['text', 'code_inline', 'image'].includes(child.type)) text += child.content;
            }
        } else if (token.type === 'fence' || token.type === 'code_block') text = token.content.trim().split('\n')[0];
        if (compact(text)) return compact(text);
    }
    return web ? '网页结果' : '';
}

/** Full searchable text without running scripts or loading page resources. */
export function playSearchText(source) {
    const visibleHtml = html => {
        const template = document.createElement('template'); template.innerHTML = html;
        for (const node of template.content.querySelectorAll('script,style,template,iframe,svg,head,meta,link,[hidden],[aria-hidden="true"]')) node.remove();
        for (const node of template.content.querySelectorAll('[style]')) {
            if (node.style.display === 'none' || node.style.visibility === 'hidden') node.remove();
        }
        return template.content.textContent ?? '';
    };
    if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(source)) return visibleHtml(source).replace(/\s+/g, ' ').trim();
    const text = [];
    for (const token of parser.parse(source, {})) {
        if (token.type === 'html_block' || token.type === 'fence' && /^html$/i.test(token.info.trim())) text.push(visibleHtml(token.content));
        else if (token.type === 'fence' || token.type === 'code_block') text.push(token.content);
        else if (token.type === 'inline') {
            const html = token.children.some(child => child.type === 'html_inline');
            if (html) text.push(visibleHtml(parser.renderInline(token.content)));
            else text.push(token.children.map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : ' ').join(''));
        }
    }
    return text.join('\n').replace(/\s+/g, ' ').trim();
}

/** Render prose and fenced or unfenced HTML, without changing the saved text. */
export function renderPlayText(container, source, anchor, renderHtml = false, hideEnglishTags = false, identity = {}) {
    const fragment = document.createDocumentFragment(), options = { ...identity, hideEnglishTags };
    const parts = renderHtml ? splitPlayText(source) : [{ type: 'prose', text: source }];
    for (const part of parts) {
        if (!part.text.trim()) continue;
        if (part.type === 'web') fragment.append(queueHtmlFrame(part.text, options, container));
        else {
            const body = element('div', undefined, 'tea-body play-prose');
            renderTavernProse(body, part.text, options); fragment.append(body);
        }
    }
    recordViewEvent(container, '正文生成', { record: container.closest('.play-record')?.dataset.record,
        replaced: container.childElementCount > 0, added: fragment.childElementCount,
        framesAdded: fragment.querySelectorAll('iframe').length, framesRemoved: container.querySelectorAll('iframe').length });
    container.replaceChildren(fragment);
    let index = 0;
    for (const child of container.children) {
        if (child.matches('iframe,[data-web-preview]')) child.dataset.readAnchor = `${anchor}/${index++}`;
        else for (const block of child.children) block.dataset.readAnchor = `${anchor}/${index++}`;
    }
}
