import MarkdownIt from './vendor/markdown-it.js';
import { renderMarkdown } from './markdown.js';
import { element } from './ui.js';

// HTML is enabled only for recognizing blocks. Prose still uses the escaped
// Markdown renderer, and every executable document stays in its own iframe.
const parser = new MarkdownIt({ html: true });
const htmlStart = /<!doctype\s+html\b|<(?:html|head|body|style|section|article|main|div)(?=[\s/>])/i;
const frameSizes = new WeakMap();

// The only message accepted from an output document is its own display height.
// No Tavern helpers, variables, slash commands or reply events are exposed.
globalThis.addEventListener?.('message', event => {
    if (event.data?.type !== 'teahouse-output-height') return;
    for (const frame of document.querySelectorAll('#teahouse-panel iframe.play-web-output')) {
        if (frame.contentWindow !== event.source || frameSizes.get(frame) !== event.data.token) continue;
        const height = event.data.height;
        if (typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= 100000) {
            frame.style.height = `${Math.ceil(height)}px`;
        }
        break;
    }
});

function htmlFrame(html) {
    const frame = element('iframe', undefined, 'play-web-output');
    frame.title = '小剧场网页';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // getRandomValues also works on the plain HTTP origins used by LAN clients.
    const token = [...crypto.getRandomValues(new Uint32Array(4))].join('-'); frameSizes.set(frame, token);
    const sizing = `(() => {
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
        new ResizeObserver(schedule).observe(document.body);
        new MutationObserver(() => { changedContent = true; schedule(); })
            .observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        window.addEventListener('load', schedule);
        window.addEventListener('resize', schedule);
        document.fonts?.ready.then(schedule);
        schedule();
    })();`;
    frame.srcdoc = html + '<script>' + sizing + '</script>';
    return frame;
}

function firstHtmlLine(source) {
    for (const token of parser.parse(source, {})) {
        if (token.type === 'html_block') {
            // A tag mentioned inside an HTML comment is still just a comment.
            const visible = token.content.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => comment.replace(/[^\n]/g, ' '));
            const match = htmlStart.exec(visible);
            if (match) return token.map[0] + visible.slice(0, match.index).split('\n').length - 1;
        } else if (token.type === 'inline' && token.children.some(child =>
            child.type === 'html_inline' && htmlStart.exec(child.content)?.index === 0)) {
            return token.map[0];
        }
    }
    return -1;
}

/** Read a short preview without creating an iframe or loading document assets. */
export function playTextPreview(source, firstLine = false) {
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

/** Render prose and fenced or unfenced HTML, without changing the saved text. */
export function renderPlayText(container, source, anchor, renderHtml = false) {
    const fragment = document.createDocumentFragment();
    const prose = text => {
        if (!text.trim()) return;
        const body = element('div', undefined, 'tea-body play-prose');
        body.innerHTML = renderMarkdown(text); fragment.append(body);
    };
    const unfenced = text => {
        const line = firstHtmlLine(text);
        if (line < 0) return prose(text);
        const lines = text.split('\n');
        prose(lines.slice(0, line).join('\n'));
        // Keep the remaining HTML together: styles and scripts may belong to
        // elements separated by blank lines. No thought/content tags are removed.
        fragment.append(htmlFrame(lines.slice(line).join('\n')));
    };
    if (renderHtml && /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(source)) {
        fragment.append(htmlFrame(source));
    } else if (renderHtml) {
        const blocks = parser.parse(source, {}).filter(token => token.type === 'fence' || token.type === 'code_block');
        const isHtmlFence = block => block.type === 'fence' && /^html$/i.test(block.info.trim());
        if (firstHtmlLine(source) < 0 && !blocks.some(isHtmlFence)) prose(source);
        else {
            const lines = source.split('\n'); let start = 0;
            for (const block of blocks) {
                unfenced(lines.slice(start, block.map[0]).join('\n'));
                if (isHtmlFence(block)) fragment.append(htmlFrame(block.content));
                else prose(lines.slice(block.map[0], block.map[1]).join('\n'));
                start = block.map[1];
            }
            unfenced(lines.slice(start).join('\n'));
        }
    } else prose(source);
    container.replaceChildren(fragment);
    let index = 0;
    for (const child of container.children) {
        if (child.matches('iframe')) child.dataset.readAnchor = `${anchor}/${index++}`;
        else for (const block of child.children) block.dataset.readAnchor = `${anchor}/${index++}`;
    }
}
