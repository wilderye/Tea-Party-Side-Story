import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../markdown.js';

const submission = `暂停正文剧情，生成一个if线。
如果{{user}}和{{char}}处于一个昼夜生物钟分化的世界中，人类在进化中由于基因差异，严格分化成了“白昼型”和“极夜型”两种体质。白昼型在夜间会失去几乎所有精力，极夜型虽然没有精力问题，却见不得强光，整个社会的运转也因此分为日夜两套系统，那么她们的故事将会是什么样的？
请写一个有头有尾的完整故事。
字数不少于8000字。用“你”代称{{user}}。`;

test('投稿单次换行保留；Windows 换行一致且宏保持不变', () => {
    const expected = `<p>${submission.replaceAll('\n', '<br>\n')}</p>\n`;
    assert.equal(renderMarkdown(submission), expected);
    assert.equal(renderMarkdown(submission.replaceAll('\n', '\r\n')), expected);
});

test('软换行不破坏段落、引用、列表、硬换行与代码块', () => {
    const html = renderMarkdown('第一行\n第二行\n\n另一段\n\n> 引用一\n> 引用二\n\n- 项一\n  续行\n- 项二\n\n硬换行  \n下一行\n\n```text\n代码一\n代码二\n```');
    assert.match(html, /第一行<br>\n第二行<\/p>\n<p>另一段/);
    assert.match(html, /引用一<br>\n引用二/);
    assert.match(html, /项一<br>\n续行<\/li>\n<li>项二/);
    assert.match(html, /硬换行<br>\n下一行/);
    assert.match(html, /<code class="language-text">代码一\n代码二\n<\/code>/);
});

test('Markdown preserves all heading levels, nested structures, code and tables', () => {
    const source = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n\n> Outer\n>\n> > Inner\n\n1. First\n   - Nested\n\n**Bold** *Emphasis* ~~Deleted~~\n\n```text\n{{char}} <script>literal</script>\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const html = renderMarkdown(source);
    for (let n = 1; n <= 6; n++) assert.match(html, new RegExp(`<h${n}>H${n}</h${n}>`));
    for (const tag of ['blockquote', 'ol', 'ul', 'strong', 'em', 's', 'pre', 'table']) assert.ok(html.includes(`<${tag}`));
    assert.ok(html.includes('{{char}} &lt;script&gt;literal&lt;/script&gt;'));
    assert.match(html, /tea-table-scroll/);
});
test('Markdown escapes submitted HTML and refuses executable links', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[run](javascript:alert(1))\n\n[safe](https://example.com)');
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('href="javascript:'));
    assert.match(html, /&lt;img/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /target="_blank"/);
});
