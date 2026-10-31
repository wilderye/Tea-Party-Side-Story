// Flow: settings -> appearance -> colors/body styles change, defaults and drafts survive.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const palettes = {
    iceberg: { BodyColor: '#4d4e50', EmColor: '#acacac', UnderlineColor: '#acacac', QuoteColor: '#8d9297',
        BlurTintColor: '#efefef', ChatTintColor: '#f5f5f5', BorderColor: 'rgba(93,93,93,.68)' },
    '1914': { BodyColor: '#5a524c', EmColor: '#796291', UnderlineColor: 'rgba(116,71,40,.9)', QuoteColor: '#594969',
        BlurTintColor: '#dddad7', ChatTintColor: 'rgba(198,191,180,0)', BorderColor: '#95715d' },
    dark: { BodyColor: '#e6e0d8', EmColor: '#aeb9cf', UnderlineColor: '#deae79', QuoteColor: '#b7aedf',
        BlurTintColor: '#25272c', ChatTintColor: 'rgba(0,0,0,.25)', BorderColor: '#646773' },
};
const sample = '## 雨后的茶会\n\n门廊外，雨水沿着屋檐落下。*这一刻很安静。* 杯子放在桌角，纸页上的__今晚见__仍然清晰。\n\n“**再坐一会儿吧。** 茶才刚刚沏好。外面的雨还没有停，沿着窗沿往下流，桌上的书可以慢慢翻，想说的话也可以慢慢说。__不必急着回答__，等茶稍微凉一点，我们再接着讲刚才的故事。”\n\n> 桌上的便笺写着：\n> 愿你今晚有一个好梦。\n\n| 茶点 | 数量 |\n| --- | --- |\n| 桂花糕 | 两块 |\n| 清茶 | 一壶 |\n\n行内代码：`“保留代码原样”`。\n\n```text\nprint("晚安")\n```';
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (!/^(?:[\w-]+\.(?:js|css)|vendor\/[\w-]+\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(name)) {
            response.statusCode = 404; return response.end();
        }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, name)));
    } catch { response.statusCode = 404; response.end(); }
});

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function setPalette(page, palette) {
    await page.evaluate(palette => {
        for (const [name, value] of Object.entries(palette)) document.documentElement.style.setProperty('--SmartTheme' + name, value);
    }, palette);
}

async function snapshot(panel) {
    return panel.evaluate(node => {
        const selectors = ['.tea-catalog', '.tea-brand', '.tea-workspace', '.tea-settings', '.tea-setting-row select',
            '.play-reading-area', '.play-prose', '.play-speaker', '.play-message-time', '.play-compose-input', '.play-send',
            '.play-header-actions .tea-icon', '.tea-settings-group>h3', '.play-person[aria-pressed=true]'];
        return Object.fromEntries(selectors.flatMap(selector => {
            const element = node.querySelector(selector) ?? (node.dataset.mode === 'settings'
                ? node.closest('#teahouse-panel-host')?.querySelector('.tea-panel-surface[data-surface=play]')?.querySelector(selector) : null);
            // The mobile settings view unmounts the performance-only person selector.
            // It has no style to compare there; all shared controls remain required.
            if (!element && selector === '.play-person[aria-pressed=true]' && matchMedia('(max-width: 760px)').matches) return [];
            const style = getComputedStyle(element);
            return [[selector, Object.fromEntries(['color', 'backgroundColor', 'borderTopColor', 'fontFamily', 'fontSize', 'lineHeight', 'padding', 'borderRadius']
                .map(property => [property, style[property]]))]];
        }));
    });
}

async function verifyPalette(page, url, viewport) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await page.evaluate(async () => {
        const round = await testHistory.getRound(seed.hidden);
        await testHistory.editResult(round.id, round.results[0].id,
            '<div>独立网页回复</div><button id="step">继续</button><span id="count">0</span><script>document.getElementById("step").onclick=()=>document.getElementById("count").textContent=Number(document.getElementById("count").textContent)+1;</script>', round.results[0].text);
    });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('剧场演出').click(); await panel.locator('.play-record:visible').first().waitFor();
    const webpage = panel.frameLocator('iframe.play-web-output');
    await webpage.locator('#step').waitFor();
    await webpage.locator('#step').evaluate(node => new Promise(resolve => {
        if (node.ownerDocument.readyState === 'complete') resolve();
        else node.ownerDocument.defaultView.addEventListener('load', resolve, { once: true });
    }));
    await webpage.getByRole('button', { name: '继续', exact: true }).click();
    assert.equal(await webpage.locator('#count').textContent(), '1');
    await panel.locator('iframe.play-web-output').evaluate(node => { window.originalThemeFrame = node; });
    const composer = panel.getByRole('textbox', { name: '小剧场提示词', exact: true });
    await composer.fill('换主题后仍然保留的草稿');
    const data = await page.evaluate(() => ({ chat: ctx.chat, files: localStorage.getItem('historyFiles'), requests: captured.length }));
    const closeSettings = () => button(viewport.width > 760 ? '设置' : '返回剧场演出').click();
    const capturePosition = () => panel.locator('.play-feed:visible').evaluate(feed => {
        if (feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 12) return { bottom: true };
        const top = feed.getBoundingClientRect().top;
        const anchor = [...feed.querySelectorAll('[data-read-anchor]')].find(node => node.getClientRects().length && node.getBoundingClientRect().bottom > top + 1);
        return { id: anchor.dataset.readAnchor, offset: anchor.getBoundingClientRect().top - top };
    });
    await panel.locator('.play-feed:visible').evaluate(feed => { feed.scrollTop = 180; });
    let readingPosition = await capturePosition();
    await button('设置').click();
    const appearance = panel.getByRole('combobox', { name: '外观', exact: true });
    assert.equal(await appearance.inputValue(), 'default');
    assert.deepEqual(await appearance.locator('option').allTextContents(), ['默认', '跟随酒馆主题']);
    const defaults = await snapshot(panel);
    for (const [name, palette] of Object.entries(palettes)) {
        await setPalette(page, palette);
        await appearance.scrollIntoViewIfNeeded();
        const settingsScroll = await panel.locator('.tea-settings').evaluate(node => node.scrollTop);
        await appearance.selectOption('tavern');
        assert.equal(await panel.getAttribute('data-appearance'), 'tavern');
        assert.ok(Math.abs(await panel.locator('.tea-settings').evaluate(node => node.scrollTop) - settingsScroll) < 2);
        const themed = await snapshot(panel);
        assert.notEqual(themed['.tea-catalog'].color, defaults['.tea-catalog'].color);
        for (const selector of Object.keys(defaults)) {
            for (const property of ['fontFamily', 'fontSize', 'lineHeight', 'padding', 'borderRadius']) {
                assert.equal(themed[selector][property], defaults[selector][property], `${name}: ${selector} keeps ${property}`);
            }
        }
        if (name === '1914') {
            assert.equal(themed['.play-reading-area'].backgroundColor, 'rgb(221, 218, 215)', '透明聊天底色叠在界面底色上');
            assert.equal(themed['.play-prose'].color, 'rgb(90, 82, 76)');
        }
        if (name === 'dark') {
            assert.equal(themed['.play-prose'].color, 'rgb(230, 224, 216)');
            assert.equal(await panel.evaluate(node => getComputedStyle(node).colorScheme), 'dark');
        }
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('processingSettings')).appearance), 'tavern');
        if (name === '1914') await screenshot(page, `appearance-settings-${viewport.width}.png`);
        await closeSettings();
        assert.equal(await composer.inputValue(), '换主题后仍然保留的草稿');
        assert.equal(await webpage.locator('#count').textContent(), '1', '切换外观不会重置网页回复');
        assert.equal(await panel.locator('iframe.play-web-output').evaluate(node => node === window.originalThemeFrame), true);
        const restored = await capturePosition();
        if (readingPosition.bottom) assert.equal(restored.bottom, true);
        else { assert.equal(restored.id, readingPosition.id); assert.ok(Math.abs(restored.offset - readingPosition.offset) < 2, '切换外观保持读到的段落位置'); }
        const record = panel.locator('.play-record:visible').first();
        await record.scrollIntoViewIfNeeded();
        await screenshot(page, `appearance-${name}-${viewport.width}.png`);
        await record.getByRole('button', { name: '编辑回复原文', exact: true }).click();
        assert.equal(await record.getByRole('textbox', { name: '回复原文', exact: true }).evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
        await record.locator('.play-assistant-message .play-edit-form').getByRole('button', { name: '取消', exact: true }).click();
        readingPosition = await capturePosition();
        await button('设置').click(); await appearance.selectOption('default');
        assert.deepEqual(await snapshot(panel), defaults, `${name}: 默认配色和排版完整恢复`);
    }
    await appearance.selectOption('tavern');
    await page.reload(); await page.waitForFunction(() => window.ready);
    await setPalette(page, palettes['1914']);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await button('剧场演出').click(); await panel.locator('.play-record:visible').first().waitFor();
    assert.equal(await panel.getAttribute('data-appearance'), 'tavern', '刷新后保留外观选择');
    assert.equal(await panel.locator('.play-reading-area:visible').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(221, 218, 215)');
    await button('设置').click();
    const font = panel.getByRole('combobox', { name: '字体', exact: true });
    await page.evaluate(() => { document.body.style.fontFamily = '"Clear Han Serif", serif'; });
    await font.selectOption('tavern'); await appearance.selectOption('default');
    assert.equal(await panel.evaluate(node => getComputedStyle(node).fontFamily), await page.evaluate(() => getComputedStyle(document.body).fontFamily), '外观和字体独立');
    await appearance.selectOption('tavern'); await font.selectOption('default');
    assert.equal(await panel.getAttribute('data-appearance'), 'tavern');
    assert.equal(await panel.locator('.play-prose').first().evaluate(node => getComputedStyle(node).fontSize), '18px');
    assert.deepEqual(await page.evaluate(() => ({ chat: ctx.chat, files: localStorage.getItem('historyFiles'), requests: captured.length })), data, '只改显示，不改历史和主聊天、不发请求');
    assert.equal(await panel.locator('.tea-settings').isVisible(), true, '页面不是空白或错误遮罩');
}

async function verifyScopedRules(page, url, viewport) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    const result = await page.evaluate(async () => {
        const source = document.createElement('style'); source.id = 'custom-style';
        source.textContent = `
            .mes_text { font:italic 44px/2 Georgia!important; position:fixed; width:200vw; --local-color:rgb(30,90,120);
                --body-paper:rgb(37,39,44); color:rgb(248,248,248); background:var(--body-paper); }
            #chat .mes .mes_text q { background:rgb(20,30,40); }
            .mes_text q { background:rgb(99,88,77); color:var(--local-color); }
            .mes_text p { font-size:22px!important; }
            #chat .mes .mes_text :is(p,q,strong) { font-size:44px!important; }
            .mes_text :is(p,code) { font-size:calc(var(--mainFontSize) * .8)!important; }
            .mes_text h2 { font-size:1.5em; }
            .mes_text blockquote { font-size:40px; }
            .mes { --local-color:rgb(255,0,0)!important; }
            .mes_text q[data-note="a,b"]::after { content:"a;b"; border-bottom:1px solid currentColor; font-size:.5em; }
            .mes_text .paper-swatch { background-image:url("assets/theme-paper.svg"); }
            @media(min-width:800px) { .mes_text :is(q,em) { padding-inline-start:7px; } }
            @supports(display:grid) { .mes_text q { outline:1px solid currentColor; } }
            #chat .mes[is_user=true] .mes_text q { color:magenta!important; }
            @layer unsupported-theme { .mes_text q { color:orange; } }
        `;
        document.head.append(source);
        const outside = document.createElement('q'); outside.textContent = '外面的文字'; document.body.append(outside);
        const outsideBefore = getComputedStyle(outside).cssText + getComputedStyle(outside).color;
        const panel = document.createElement('div'); panel.id = 'teahouse-panel'; panel.style.cssText = 'display:block;width:600px;--tea-body-size:18px';
        panel.innerHTML = '<div class="tea-body"><h2>标题</h2><p><q data-note="a,b">“<strong>对白</strong>”</q><code>代码</code></p><blockquote><p>引用</p></blockquote></div>'; document.body.append(panel);
        const body = panel.querySelector('.tea-body'), quote = panel.querySelector('q');
        const width = body.getBoundingClientRect().width, family = getComputedStyle(body).fontFamily;
        const defaultColors = [getComputedStyle(body).color, getComputedStyle(body).backgroundColor];
        const appearance = (await import('/appearance.js')).createAppearance(panel); appearance.apply('tavern');
        const unreadable = document.createElement('style'); document.head.append(unreadable);
        Object.defineProperty(unreadable.sheet, 'cssRules', { get() { throw new DOMException('Cross origin', 'SecurityError'); } });
        const report = (await import('/theme-styles.js')).readThemeBodyStyles();
        const actual = { color: getComputedStyle(quote).color, background: getComputedStyle(quote).backgroundColor,
            bodyColor: getComputedStyle(body).color, bodyBackground: getComputedStyle(body).backgroundColor,
            padding: getComputedStyle(quote).paddingInlineStart, after: getComputedStyle(quote, '::after').content,
            afterSize: getComputedStyle(quote, '::after').fontSize,
            outline: getComputedStyle(quote).outlineWidth, size: getComputedStyle(body).fontSize,
            proseSizes: [...body.querySelectorAll('p,q,strong,blockquote')].map(node => getComputedStyle(node).fontSize),
            headingSize: getComputedStyle(body.querySelector('h2')).fontSize, codeSize: getComputedStyle(body.querySelector('code')).fontSize,
            sameFamily: getComputedStyle(body).fontFamily === family, sameWidth: body.getBoundingClientRect().width === width,
            outsideUnchanged: getComputedStyle(outside).cssText + getComputedStyle(outside).color === outsideBefore,
            relativeUrl: report.css.includes(new URL('assets/theme-paper.svg', document.baseURI).href),
            unsupported: report.skipped.length, unreadable: report.unreadable };
        panel.style.setProperty('--tea-body-size', '24px');
        actual.resized = ['p', 'q', 'h2', 'code'].map(selector => getComputedStyle(body.querySelector(selector)).fontSize);
        appearance.apply('default'); appearance.dispose();
        actual.colorsRestored = JSON.stringify([getComputedStyle(body).color, getComputedStyle(body).backgroundColor]) === JSON.stringify(defaultColors);
        actual.cleaned = !document.querySelector('style[data-tea-theme-style]');
        return actual;
    });
    assert.deepEqual(result, { color: 'rgb(30, 90, 120)', background: 'rgb(20, 30, 40)', padding: viewport.width >= 800 ? '7px' : '0px',
        bodyColor: 'rgb(248, 248, 248)', bodyBackground: 'rgb(37, 39, 44)', colorsRestored: true,
        after: '"a;b"', afterSize: '9px', outline: '1px', size: '18px', sameFamily: true, sameWidth: true, outsideUnchanged: true,
        proseSizes: ['18px', '18px', '18px', '18px', '18px'], headingSize: '27px', codeSize: '14.4px',
        resized: ['24px', '24px', '36px', '19.2px'],
        relativeUrl: true, unsupported: 2, unreadable: 1, cleaned: true });
}

async function verifyDefaultProse(page, url) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    const result = await page.evaluate(async () => {
        const source = document.createElement('style'); source.id = 'custom-style';
        source.textContent = `
            q { font:italic 40px Georgia!important; text-decoration:underline!important; display:block!important;
                color:red!important; background:yellow!important; padding:12px!important; border:3px solid red!important; }
            q::before { content:"「"!important; }
            q::after { content:"」"!important; }
            em,u { color:blue!important; background:yellow!important; padding:12px!important; border:3px solid red!important; }
            u { font-size:40px!important; text-decoration:none!important; display:block!important; }
            em::before,u::before { content:"额外装饰"!important; }
        `;
        document.head.append(source);
        const outside = document.createElement('q'); outside.textContent = '酒馆文字'; document.body.append(outside);
        const panel = document.createElement('div'); panel.id = 'teahouse-panel'; panel.style.setProperty('--tea-body-size', '18px');
        const body = document.createElement('div'); body.className = 'tea-body play-prose';
        body.innerHTML = (await import('/markdown.js')).renderMarkdown('他说：“你好。”\n\n*“保留斜体。”*\n\n**“保留粗体。”**\n\n*斜体旁注* __下划线__ <u>标签下划线</u>\n\n“__强调的对白__。”');
        panel.append(body); document.body.append(panel);
        const appearance = (await import('/appearance.js')).createAppearance(panel);
        const quote = body.querySelector('q');
        function snapshot() {
            const style = getComputedStyle(quote), parent = getComputedStyle(quote.parentElement);
            const underline = body.querySelector('u'), underlined = getComputedStyle(underline), emphasis = getComputedStyle(body.querySelectorAll('em')[1]);
            return { text: body.textContent, display: style.display, decoration: style.textDecorationLine,
                size: style.fontSize, font: style.fontFamily === parent.fontFamily, style: style.fontStyle,
                color: style.color, background: style.backgroundColor, padding: style.padding, border: style.borderTopWidth, boxDecoration: style.boxDecorationBreak,
                before: getComputedStyle(quote, '::before').content, after: getComputedStyle(quote, '::after').content,
                emphasis: emphasis.fontStyle, emphasisColor: emphasis.color, emphasisBackground: emphasis.backgroundColor,
                strong: getComputedStyle(body.querySelector('strong')).fontWeight,
                underline: { count: body.querySelectorAll('u').length, decoration: underlined.textDecorationLine, lineColor: underlined.textDecorationColor,
                    size: underlined.fontSize, display: underlined.display, inheritsText: underlined.color === getComputedStyle(underline.parentElement).color,
                    background: underlined.backgroundColor, padding: underlined.padding, border: underlined.borderTopWidth,
                    before: getComputedStyle(underline, '::before').content, quotedColor: getComputedStyle(body.querySelector('q u')).color } };
        }
        appearance.apply('default'); const original = snapshot();
        appearance.apply('tavern'); const following = snapshot();
        appearance.apply('default'); const restored = snapshot(); appearance.dispose();
        return { original, following, restored, outside: { size: getComputedStyle(outside).fontSize, before: getComputedStyle(outside, '::before').content } };
    });
    assert.deepEqual(result.original, { text: '他说：“你好。”\n“保留斜体。”\n“保留粗体。”\n斜体旁注 下划线 标签下划线\n“强调的对白。”\n', display: 'inline', decoration: 'none',
        size: '18px', font: true, style: 'normal', color: 'rgb(60, 99, 82)', background: 'rgba(82, 126, 98, 0.12)', padding: '0.63px 0px', border: '0px', boxDecoration: 'clone',
        before: 'none', after: 'none', emphasis: 'italic', emphasisColor: 'rgb(97, 113, 95)', emphasisBackground: 'rgba(0, 0, 0, 0)', strong: '700',
        underline: { count: 3, decoration: 'underline', lineColor: 'rgb(179, 108, 82)', size: '18px', display: 'inline', inheritsText: true,
            background: 'rgba(0, 0, 0, 0)', padding: '0px', border: '0px', before: 'none', quotedColor: 'rgb(60, 99, 82)' } });
    assert.deepEqual(result.restored, result.original, '切回默认后恢复自有正文配色并清除主题装饰');
    assert.equal(result.following.before, '"「"'); assert.equal(result.following.after, '"」"');
    assert.equal(result.following.decoration, 'underline', '跟随模式仍允许主题对白装饰');
    assert.deepEqual(result.outside, { size: '40px', before: '"「"' }, '默认对白规则只作用于小剧场');
}

async function verifyProseScope(page, url) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    await page.evaluate(async () => {
        const source = document.createElement('style'); source.id = 'custom-style';
        source.textContent = `
            .mes_text + iframe { display:none; }
            #chat .mes_text ~ iframe { opacity:0; }
            .mes_text > p + p { color:rgb(30,90,120); margin-left:12px; }
        `;
        document.head.append(source);
        const panel = document.createElement('div'); panel.id = 'teahouse-panel'; panel.style.cssText = 'display:block;width:100%;height:auto';
        document.body.append(panel);
        (await import('/play-render.js')).renderPlayText(panel,
            '网页前的说明。\n\n第二段说明。\n\n```html\n<div>独立网页回复</div><button id="step">继续</button><span id="count">0</span><script>document.getElementById("step").onclick=()=>document.getElementById("count").textContent=Number(document.getElementById("count").textContent)+1;</script>\n```',
            'scope-test', true);
        window.scopeFrame = panel.querySelector('iframe');
        window.scopeAppearance = (await import('/appearance.js')).createAppearance(panel);
        scopeAppearance.apply('default');
    });
    const webpage = page.frameLocator('#teahouse-panel iframe');
    await webpage.getByRole('button', { name: '继续', exact: true }).click();
    const result = await page.evaluate(async () => {
        scopeAppearance.apply('tavern');
        const frame = document.querySelector('#teahouse-panel iframe'), paragraph = document.querySelector('#teahouse-panel .tea-body > p + p');
        return { display: getComputedStyle(frame).display, opacity: getComputedStyle(frame).opacity,
            sameFrame: frame === scopeFrame, color: getComputedStyle(paragraph).color, margin: getComputedStyle(paragraph).marginLeft,
            skipped: (await import('/theme-styles.js')).readThemeBodyStyles().skipped };
    });
    assert.deepEqual(result, { display: 'block', opacity: '1', sameFrame: true, color: 'rgb(30, 90, 120)', margin: '12px',
        skipped: ['.mes_text + iframe', '#chat .mes_text ~ iframe'] });
    assert.equal(await page.locator('#teahouse-panel iframe').isVisible(), true, '正文旁边的网页回复保持可见');
    assert.equal(await webpage.locator('#count').textContent(), '1', '网页内部状态保留');
    await page.evaluate(() => { scopeAppearance.apply('default'); scopeAppearance.dispose(); });
    assert.equal(await webpage.locator('#count').textContent(), '1');
}

async function setBodyTheme(page, css, nativeCss) {
    await page.evaluate(({ css, nativeCss }) => {
        // Keep the actual body declarations. External fonts and decorative
        // images are outside this test; no remote resource is downloaded.
        const local = source => source.replace(/@import\s+[^;]+;/g, '').replace(/@font-face\s*\{[^}]*\}/g, '')
            .replace(/url\(\s*(?:"[^"\\]*"|'[^'\\]*'|[^)]*)\s*\)/g, 'none');
        const parsed = new CSSStyleSheet(); parsed.replaceSync(local(nativeCss));
        function extract(rules) {
            return [...rules].map(rule => {
                if (rule.type === CSSRule.STYLE_RULE) return rule.selectorText.includes('.mes_text')
                    || rule.selectorText.split(',').some(selector => /^\s*(?:code|hr|q|:root)\s*$/.test(selector)) ? rule.cssText : '';
                if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
                    const contents = extract(rule.cssRules);
                    return contents ? rule.cssText.slice(0, rule.cssText.indexOf('{') + 1) + contents + '}' : '';
                }
                return '';
            }).join('\n');
        }
        for (const [id, content] of [['tavern-body-base', extract(parsed.cssRules)], ['custom-style', local(css)]]) {
            let style = document.getElementById(id);
            if (!style) { style = document.createElement('style'); style.id = id; document.head.append(style); }
            style.textContent = content;
        }
    }, { css, nativeCss });
}

async function verifyBodyTheme(page, url, viewport, theme, css, nativeCss) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    await setBodyTheme(page, css, nativeCss); await setPalette(page, palettes[theme]);
    await page.evaluate(async sample => {
        const round = await testHistory.getRound(seed.a);
        await testHistory.editResult(round.id, round.results[0].id, sample, round.results[0].text);
        fixture.community.set('theme-reading', { id: 'theme-reading', title: '雨后的茶会', author: '测试', body: sample, type: 'standalone' });
        const reference = document.createElement('section'); reference.id = 'chat'; reference.hidden = true;
        reference.style.color = 'var(--SmartThemeBodyColor)';
        reference.innerHTML = '<div class="mes"><div class="mes_block"><div class="mes_text"></div></div></div>';
        reference.querySelector('.mes_text').innerHTML = (await import('/markdown.js')).renderMarkdown(sample);
        document.body.append(reference);
    }, sample);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('剧场演出').click(); await panel.locator('.play-record:visible').first().waitFor();
    const data = await page.evaluate(() => ({ chat: ctx.chat, files: localStorage.getItem('historyFiles'), requests: captured.length }));
    const before = await panel.locator('.play-prose').first().evaluate(node => ({ size: getComputedStyle(node).fontSize, family: getComputedStyle(node).fontFamily }));
    const defaultProse = panel.locator('.play-record:visible').first().locator('.play-results .play-prose');
    const rendered = await defaultProse.innerHTML();
    assert.deepEqual(await defaultProse.evaluate(body => ({
        quote: getComputedStyle(body.querySelector('q')).color, emphasis: getComputedStyle(body.querySelector('em')).color,
        underline: getComputedStyle(body.querySelector('u')).textDecorationLine,
        lineColor: getComputedStyle(body.querySelector('u')).textDecorationColor,
        fits: body.scrollWidth <= body.clientWidth + 1,
    })), { quote: 'rgb(60, 99, 82)', emphasis: 'rgb(97, 113, 95)', underline: 'underline', lineColor: 'rgb(179, 108, 82)', fits: true },
    `${theme}: 默认外观使用自己的配色，长对白无横向溢出`);
    await panel.locator('.play-feed:visible').evaluate(node => { node.scrollTop = 0; });
    await screenshot(page, `body-default-${theme}-${viewport.width}.png`);
    await button('设置').click();
    const appearance = panel.getByRole('combobox', { name: '外观', exact: true });
    await appearance.selectOption('tavern');
    const closeSettings = () => button(viewport.width > 760 ? '设置' : '返回剧场演出').click();
    await closeSettings();
    const comparisons = await page.evaluate(() => {
        const body = document.querySelector(`[data-record="${seed.a}"] .play-results .play-prose`), reference = document.querySelector('#chat .mes_text');
        // Compare decorations at the same user-selected size, including em padding.
        reference.style.setProperty('font-size', getComputedStyle(body).fontSize, 'important');
        const properties = {
            q: ['color', 'backgroundColor', 'backgroundImage', 'boxDecorationBreak', 'borderLeftStyle', 'borderLeftWidth', 'borderLeftColor', 'marginLeft', 'marginRight'],
            em: ['color', 'fontStyle'],
            u: ['color', 'textDecorationLine', 'textDecorationColor'],
            blockquote: ['backgroundColor', 'borderLeftStyle', 'borderLeftWidth', 'borderLeftColor', 'paddingLeft', 'paddingRight'],
            table: ['backgroundColor', 'color', 'borderTopWidth', 'borderTopColor', 'boxShadow'],
            th: ['borderRightWidth', 'borderBottomWidth', 'paddingLeft'],
            code: ['backgroundColor', 'color', 'borderBottomStyle', 'borderBottomWidth'],
            pre: ['backgroundColor', 'borderLeftColor', 'borderLeftWidth', 'paddingLeft'],
        };
        return Object.entries(properties).map(([selector, names]) => {
            const collect = root => Object.fromEntries(names.map(name => [name, getComputedStyle(root.querySelector(selector))[name]]));
            return { selector, actual: collect(body), expected: collect(reference) };
        });
    });
    for (const { selector, actual, expected } of comparisons) {
        assert.deepEqual(actual, expected, `${theme}: ${selector} 使用美化的实际装饰`);
    }
    assert.deepEqual(await panel.locator('.play-prose').first().evaluate(node => ({ size: getComputedStyle(node).fontSize, family: getComputedStyle(node).fontFamily })), before,
        '美化的 22px 和字体声明不会盖掉独立字体、字号');
    const prose = panel.locator('.play-record:visible').first().locator('.play-results .play-prose');
    assert.equal(await prose.innerHTML(), rendered, '切换外观不改变格式识别或正文内容');
    assert.equal(await prose.locator('u').count(), 2, '两种外观都识别下划线');
    assert.equal(await prose.locator('q').count(), 1, '对白已识别，代码里的引号保持原样');
    assert.equal(await prose.locator('q').evaluate(node => getComputedStyle(node).quotes), 'none', '不额外显示一对浏览器引号');
    const arrangement = await panel.locator('.play-record:visible').first().evaluate(node => {
        const a = getComputedStyle(node.querySelector('.play-user-meta .play-message-avatar')).order;
        const b = getComputedStyle(node.querySelector('.play-user-meta .play-message-identity')).order;
        return Number(a) < Number(b);
    });
    assert.equal(arrangement, viewport.width <= 760, '手机用户消息头靠左，电脑靠右');
    await panel.locator('.play-feed:visible').evaluate(node => { node.scrollTop = 0; });
    await screenshot(page, `body-${theme}-${viewport.width}.png`);
    await button('茶会选集').click();
    assert.equal(await panel.locator('.tea-body:visible q').count(), 1, '剧场库也使用同一套对白和正文样式');
    await button('剧场演出').click();
    await panel.locator('.play-record:visible').first().getByRole('button', { name: '收藏演出记录', exact: true }).click();
    await button('我的收藏').click();
    await panel.getByRole('button', { name: '演出记录', exact: true }).filter({ visible: true }).click();
    if (viewport.width <= 760) await panel.locator('.tea-story:visible').first().click();
    await panel.locator('.play-favorite-content:visible q').waitFor();
    assert.equal(await panel.locator('.play-favorite-content:visible q').evaluate(node => getComputedStyle(node).backgroundImage), comparisons[0].actual.backgroundImage, '收藏沿用同一套美化');
    await button('关闭面板').click(); await panel.waitFor({ state: 'detached' });
    assert.equal(await page.locator('style[data-tea-theme-style]').count(), 0, '关闭后移除复制的局部规则');
    assert.deepEqual(await page.evaluate(() => ({ chat: ctx.chat, requests: captured.length })), { chat: data.chat, requests: data.requests });
    const report = await page.evaluate(async () => {
        const { copied, skipped, unreadable } = (await import('/theme-styles.js')).readThemeBodyStyles();
        return { copied, skipped, unreadable };
    });
    assert.deepEqual(report.skipped, [], `${theme}: 样例的正文选择器全部可转换`);
    console.log(`PASS actual ${theme} body styles ${viewport.width}x${viewport.height}; copied ${report.copied}, unreadable ${report.unreadable}`);
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            const page = await browser.newPage({ viewport }), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            await verifyPalette(page, `http://127.0.0.1:${server.address().port}/`, viewport);
            await verifyScopedRules(page, `http://127.0.0.1:${server.address().port}/`, viewport);
            await verifyDefaultProse(page, `http://127.0.0.1:${server.address().port}/`);
            await verifyProseScope(page, `http://127.0.0.1:${server.address().port}/`);
            assert.deepEqual(errors, []); await page.close();
            console.log(`PASS appearance colors, settings, persistence and font independence ${viewport.width}x${viewport.height}`);
            if (process.env.TEA_THEME_DIR && process.env.TEA_TAVERN_CSS) {
                const nativeCss = await fs.readFile(process.env.TEA_TAVERN_CSS, 'utf8');
                for (const [theme, filename] of [['iceberg', '冰山之下.json'], ['1914', 'SillyTavern1914_PC_L.json']]) {
                    const fixture = JSON.parse(await fs.readFile(path.join(process.env.TEA_THEME_DIR, filename), 'utf8'));
                    const themedPage = await browser.newPage({ viewport }), themeErrors = [];
                    themedPage.on('pageerror', error => themeErrors.push(error.message));
                    themedPage.on('console', message => { if (['error', 'warning'].includes(message.type())) themeErrors.push(message.text()); });
                    await verifyBodyTheme(themedPage, `http://127.0.0.1:${server.address().port}/`, viewport, theme, fixture.custom_css, nativeCss);
                    assert.deepEqual(themeErrors, []); await themedPage.close();
                }
            }
        }
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
