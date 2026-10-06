import MarkdownIt from './vendor/markdown-it.js';

// Rendering never substitutes macros or modifies the source passed to SillyTavern.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
markdown.renderer.rules.table_open = () => '<div class="tea-table-scroll" tabindex="0" role="region" aria-label="表格，可横向滚动"><table>';
markdown.renderer.rules.table_close = () => '</table></div>';
const linkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return linkOpen ? linkOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};
export function renderMarkdown(source) { return markdown.render(source); }
