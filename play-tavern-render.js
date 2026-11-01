import { renderMarkdown } from './markdown.js';
import { scopeProseAnimations } from './play-prose-style.js';

let renderer, initialization;
let scopeId = 0;

export function createTavernRenderer({ core, chats, power, utils, underscore, exclusion, libs, diagnostics }) {
    const functions = {
        messageFormatting: core.messageFormatting,
        reloadMarkdownProcessor: core.reloadMarkdownProcessor,
        addDOMPurifyHooks: chats.addDOMPurifyHooks,
        decodeStyleTags: chats.decodeStyleTags,
        encodeStyleTags: chats.encodeStyleTags,
        markdownUnderscoreExt: underscore.markdownUnderscoreExt,
        markdownExclusionExt: exclusion.markdownExclusionExt,
        fixMarkdown: power.fixMarkdown,
        canUseNegativeLookbehind: utils.canUseNegativeLookbehind,
        escapeHtml: utils.escapeHtml,
        escapeRegex: utils.escapeRegex,
        countOccurrences: utils.countOccurrences,
        isOdd: utils.isOdd,
    };
    for (const [name, fn] of Object.entries(functions)) {
        if (typeof fn !== 'function' || fn.toString().includes('[native code]')) throw new Error(`Unsupported Tavern formatter: ${name}`);
    }
    const settings = { user_prompt_bias: '', show_user_prompt_bias: false, reasoning: { prefix: '', suffix: '' } };
    const allowedSettings = new Set(['auto_fix_generated_markdown', 'encode_tags', 'allow_name2_display', 'markdown_escape_strings', ...Object.keys(settings)]);
    for (const fn of Object.values(functions)) {
        for (const match of fn.toString().matchAll(/\bpower_user\.(\w+)/g)) {
            if (!allowedSettings.has(match[1])) throw new Error(`Unsupported Tavern display setting: ${match[1]}`);
        }
    }
    const storage = new Map(), decodedStyles = [];
    let mediaAllowed = true, prefix = '', failed = false;
    const log = error => diagnostics?.warn('酒馆正文显示', error);
    const scope = {
        power_user: settings, chat: [], COMMENT_NAME_DEFAULT: 'Comment', systemUserName: 'System',
        substituteParams: text => text, getRegexedString: text => text,
        regex_placement: { USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, REASONING: 6 },
        MessageFormatter: { stage: {}, runStage: (_stage, text) => text },
        DOMPurify: libs.DOMPurify(window), showdown: libs.showdown,
        css: { parse: libs.css.parse, stringify: ast => { decodedStyles.push(libs.css.stringify(ast)); return ''; } },
        isExternalMediaAllowed: () => mediaAllowed, getCurrentEntityId: () => 'teahouse',
        accountStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        toastr: { warning: () => diagnostics?.info('正文按酒馆全局设置隐藏外部媒体'), clear() {} },
        t: parts => parts.join(''), console: { log() {}, warn() {}, error: () => log(new Error('Tavern display dependency failed')) },
        getStylePrefix: () => prefix,
    };
    const declarations = Object.entries(functions).map(([name, fn]) => `const ${name === 'decodeStyleTags' ? 'nativeDecodeStyleTags' : name} = (${fn.toString()});`).join('\n');
    const factory = new Function(...Object.keys(scope), `"use strict";
        let converter, mesForShowdownParse;
        ${declarations}
        const decodeStyleTags = text => text;
        addDOMPurifyHooks();
        return { format: messageFormatting, reload: reloadMarkdownProcessor, decode: nativeDecodeStyleTags };
    `);
    const local = factory(...Object.values(scope));
    let exclusionKey;
    const copy = typeof core.addCopyToCodeBlocks === 'function' ? new Function('$', 'hljs', 'copyText', 'toastr', 't',
        `return (${core.addCopyToCodeBlocks.toString()});`)(globalThis.jQuery, libs.hljs, utils.copyText,
        { info() {} }, parts => parts.join('')) : null;
    return {
        render(text, { name = '', role = 'assistant', selector, scope } = {}) {
            if (failed) return null;
            try {
                const current = power.power_user;
                settings.auto_fix_generated_markdown = !!current.auto_fix_generated_markdown;
                settings.encode_tags = !!current.encode_tags;
                settings.allow_name2_display = current.allow_name2_display !== false;
                settings.markdown_escape_strings = String(current.markdown_escape_strings ?? '').split(',')
                    .filter(value => !/{{|}}|<%|%>/.test(value)).join(',');
                mediaAllowed = !current.forbid_external_media;
                if (exclusionKey !== settings.markdown_escape_strings) {
                    local.reload(); exclusionKey = settings.markdown_escape_strings;
                }
                prefix = `${selector} `;
                const template = document.createElement('template');
                template.innerHTML = local.format(text, name, false, role === 'user', -1);
                for (const style of template.content.querySelectorAll('style')) style.remove();
                for (const node of template.content.querySelectorAll('custom-style')) {
                    decodedStyles.length = 0;
                    local.decode(`<custom-style>${node.textContent}</custom-style>`, { prefix });
                    const style = document.createElement('style'); style.textContent = decodedStyles.join('\n');
                    node.replaceWith(style);
                }
                decodedStyles.length = 0;
                scopeProseAnimations(template.content, scope);
                return template.content;
            } catch (error) {
                decodedStyles.length = 0;
                failed = true; log(error); diagnostics?.info('正文继续使用原有 Markdown 显示'); return null;
            }
        },
        decorate(body) {
            try {
                if (copy && globalThis.jQuery) copy(body);
                else if (libs.hljs) for (const code of body.querySelectorAll('pre code')) libs.hljs.highlightElement(code);
            } catch (error) { log(error); }
        },
    };
}

export function initializeTavernRenderer(diagnostics) {
    initialization ??= (async () => {
        try {
            const [core, chats, power, utils, underscore, exclusion, libs] = await Promise.all([
                import('/script.js'), import('/scripts/chats.js'), import('/scripts/power-user.js'), import('/scripts/utils.js'),
                import('/scripts/showdown-underscore.js'), import('/scripts/showdown-exclusion.js'), import('/lib.js'),
            ]);
            renderer = createTavernRenderer({ core, chats, power, utils, underscore, exclusion, libs, diagnostics });
        } catch (error) {
            diagnostics?.warn('建立酒馆正文显示', error);
            diagnostics?.info('正文继续使用原有 Markdown 显示');
        }
    })();
    return initialization;
}

export function renderTavernProse(body, text, options = {}) {
    body.dataset.teaProse = String(++scopeId);
    const content = renderer?.render(text, { ...options, scope: body.dataset.teaProse, selector: `[data-tea-prose="${body.dataset.teaProse}"]` });
    if (content) { body.replaceChildren(content); renderer.decorate(body); }
    else body.innerHTML = renderMarkdown(text, { hideEnglishTags: options.hideEnglishTags });
}
