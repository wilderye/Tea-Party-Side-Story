import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../markdown.js';

const submission = `暂停正文剧情，生成一个if线。
如果{{user}}和{{char}}处于一个昼夜生物钟分化的世界中，人类在进化中由于基因差异，严格分化成了“白昼型”和“极夜型”两种体质。白昼型在夜间会失去几乎所有精力，极夜型虽然没有精力问题，却见不得强光，整个社会的运转也因此分为日夜两套系统，那么她们的故事将会是什么样的？
请写一个有头有尾的完整故事。
字数不少于8000字。用“你”代称{{user}}。`;

test('投稿单次换行保留；Windows 换行一致且宏保持不变', () => {
    const expected = `<p>${submission.replaceAll('\n', '<br>\n').replace('“白昼型”', '<q>“白昼型”</q>').replace('“极夜型”', '<q>“极夜型”</q>').replace('“你”', '<q>“你”</q>')}</p>\n`;
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

test('对白包含粗斜体和不同引号，保留原始引号与宏', () => {
    assert.equal(renderMarkdown('他说：“你好，**{{user}}**，*请坐*。”\n“茶已经好了。”'),
        '<p>他说：<q>“你好，<strong>{{user}}</strong>，<em>请坐</em>。”</q><br>\n<q>“茶已经好了。”</q></p>\n');
    assert.equal(renderMarkdown('"hello" «bonjour» 「你好」 『你好』 ＂你好＂'),
        '<p><q>&quot;hello&quot;</q> <q>«bonjour»</q> <q>「你好」</q> <q>『你好』</q> <q>＂你好＂</q></p>\n');
});

test('引号与强调范围交叉时分开强调，不产生交叉闭合的标签', () => {
    assert.equal(renderMarkdown('*他问：“你好*，欢迎。”'), '<p><em>他问：</em><q><em>“你好</em>，欢迎。”</q></p>\n');
    assert.equal(renderMarkdown('“他说**你好。” 后来**'), '<p><q>“他说<strong>你好。”</strong></q><strong> 后来</strong></p>\n');
    assert.equal(renderMarkdown('“她说「你好」。”'), '<p><q>“她说「你好」。”</q></p>\n');
});

test('代码、转义、链接和 HTML 示例中的引号不当作对白', () => {
    assert.equal(renderMarkdown('\x60“代码”\x60\n\n\x60\x60\x60txt\n“代码块”\n\x60\x60\x60'),
        '<p><code>“代码”</code></p>\n<pre><code class="language-txt">“代码块”\n</code></pre>\n');
    const source = '\\"转义\\" <span title="example">示例</span> [“链接”](/path "title")';
    const html = renderMarkdown(source);
    assert.ok(!html.includes('<q>'));
    assert.match(html, /&lt;span title=&quot;example&quot;&gt;/);
    assert.match(html, /href="\/path" title="title"/);
    assert.match(html, /“链接”<\/a>/);
});

test('未闭合对白和逐步到达的流式内容不隐藏文字、不跨段落配对', () => {
    assert.equal(renderMarkdown('“还没'), '<p>“还没</p>\n');
    assert.equal(renderMarkdown('“还没**说完**'), '<p>“还没<strong>说完</strong></p>\n');
    assert.equal(renderMarkdown('“还没**说完**。” 后文'), '<p><q>“还没<strong>说完</strong>。”</q> 后文</p>\n');
    assert.equal(renderMarkdown('“第一段\n\n第二段”'), '<p>“第一段</p>\n<p>第二段”</p>\n');
});

test('双下划线和三下划线按酒馆规则显示，保留中文、粗斜体和宏', () => {
    assert.equal(renderMarkdown('__下划线__ ___同样是下划线___ **仍是粗体** *仍是斜体*'),
        '<p><u>下划线</u> <u>同样是下划线</u> <strong>仍是粗体</strong> <em>仍是斜体</em></p>\n');
    assert.equal(renderMarkdown('正文__紧贴中文__继续，___**{{user}}**，*{{char}}*___。'),
        '<p>正文<u>紧贴中文</u>继续，<u><strong>{{user}}</strong>，<em>{{char}}</em></u>。</p>\n');
    assert.equal(renderMarkdown('a__word__b ____原样的单下划线____ __ 未贴合 __'),
        '<p>a__word__b <u>_原样的单下划线_</u> __ 未贴合 __</p>\n');
    assert.equal(renderMarkdown('__第一行\n第二行__'), '<p><u>第一行<br>\n第二行</u></p>\n');
});

test('下划线不改代码、转义或链接地址，链接文字仍可带下划线', () => {
    assert.equal(renderMarkdown('`__代码__` \\_\\_转义\\_\\_\n\n```text\n___代码块___\n```'),
        '<p><code>__代码__</code> __转义__</p>\n<pre><code class="language-text">___代码块___\n</code></pre>\n');
    assert.equal(renderMarkdown('[前__下划线__后](/__path__ "__title__")'),
        '<p><a href="/__path__" title="__title__" target="_blank" rel="noopener noreferrer">前<u>下划线</u>后</a></p>\n');
    assert.equal(renderMarkdown('__尚未完成'), '<p>__尚未完成</p>\n');
    assert.equal(renderMarkdown('__尚未**完成**__'), '<p><u>尚未<strong>完成</strong></u></p>\n');
});

test('引号按酒馆规则在同一行内配对，格式嵌套保留', () => {
    assert.equal(renderMarkdown('“第一行\n第二行”'), '<p>“第一行<br>\n第二行”</p>\n');
    assert.equal(renderMarkdown('“第一行  \n第二行”'), '<p>“第一行<br>\n第二行”</p>\n');
    assert.equal(renderMarkdown('“你好，__请坐__。” *“保留斜体。”*'),
        '<p><q>“你好，<u>请坐</u>。”</q> <em><q>“保留斜体。”</q></em></p>\n');
    assert.equal(renderMarkdown('“外层「未闭合的内层。”'), '<p><q>“外层「未闭合的内层。”</q></p>\n');
    assert.equal(renderMarkdown('“”'), '<p><q>“”</q></p>\n');
});

test('只识别成对的裸 q/u 标签，保留嵌套且不重复包裹引号', () => {
    assert.equal(renderMarkdown('<q>“你好，<u>**{{user}}**</u>。”</q>'),
        '<p><q>“你好，<u><strong>{{user}}</strong></u>。”</q></p>\n');
    assert.equal(renderMarkdown('<Q>__下划线__\n第二行</Q> <u>*斜体*</u>'),
        '<p><q><u>下划线</u><br>\n第二行</q> <u><em>斜体</em></u></p>\n');
    assert.equal(renderMarkdown('`<q>代码</q>` &lt;u&gt;文字&lt;/u&gt;'),
        '<p><code>&lt;q&gt;代码&lt;/q&gt;</code> &lt;u&gt;文字&lt;/u&gt;</p>\n');
});

test('未闭合、交叉或带属性的格式标签保持可见，其他 HTML 不执行', () => {
    for (const source of ['<q>未完成', '<u>未完成', '<q><u>交叉</q></u>']) {
        assert.equal(renderMarkdown(source), `<p>${source.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>\n`);
    }
    assert.equal(renderMarkdown('*<q>第一段* *第二段</q>*'),
        '<p><em>&lt;q&gt;第一段</em> <em>第二段&lt;/q&gt;</em></p>\n');
    assert.equal(renderMarkdown('<q onclick="alert(1)">文字</q>'),
        '<p>&lt;q onclick=&quot;alert(1)&quot;&gt;文字&lt;/q&gt;</p>\n');
    assert.equal(renderMarkdown('<span title="<q>原样</q>">示例</span>'),
        '<p>&lt;span title=&quot;&lt;q&gt;原样&lt;/q&gt;&quot;&gt;示例&lt;/span&gt;</p>\n');
    assert.equal(renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>'),
        '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;</p>\n');
    for (const source of ['<!-- <q>标签示例</q> __下划线示例__ -->', '<!-- <q>未闭合注释</q>']) {
        assert.equal(renderMarkdown(source), `<p>${source.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>\n`);
    }
});

test('过深的格式标签保留为文字，不阻止整篇正文显示', () => {
    const source = '<q>'.repeat(2000) + '__嵌套正文__' + '</q>'.repeat(2000);
    const html = renderMarkdown(source);
    assert.ok(html.includes('<u>嵌套正文</u>'));
    assert.ok(html.includes('&lt;q&gt;'));
    assert.equal((html.match(/<q>/g) || []).length, (html.match(/<\/q>/g) || []).length);
});
