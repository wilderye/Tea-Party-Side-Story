// Browser plugin not available. Use the project's Playwright/Edge workflow.
// Flow: settings -> section dividers and spacing -> wrapped tags -> cap at five lines -> reopen.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const settingsHarness = harness.replace("import {createTheatrePanel}",
    "import {createDiagnostics} from '/diagnostics.js';\nconst diagnostics = createDiagnostics();\nimport {createTheatrePanel}")
    .replace('{...libraryActions,playground:runtime,promptFavorites}', '{...libraryActions,playground:runtime,promptFavorites,diagnostics}');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://localhost').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(settingsHarness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verifySections(page, viewport) {
    const settings = page.locator('.tea-settings');
    const checkDividers = async () => {
        const metrics = await settings.evaluate(area => ({
            groups: [...area.children].map(group => ({ title: group.querySelector('h3').textContent,
                line: getComputedStyle(group).borderBottomWidth })),
            inside: [...area.querySelectorAll('.tea-setting-row,.tea-update-setting,.play-api-fields')]
                .filter(node => node.checkVisibility()).map(node => getComputedStyle(node).borderBottomWidth),
        }));
        assert.deepEqual(metrics.groups.map(group => group.title), ['剧场库', '小剧场生成', '回复显示', '阅读外观', '自动重试', '插件日志', '小剧场续写']);
        assert.deepEqual(metrics.groups.map(group => group.line), ['1px', '1px', '1px', '1px', '1px', '1px', '0px'], '相邻板块有线，末尾不再画线');
        assert.ok(metrics.inside.every(line => line === '0px'), '板块内部的设置之间没有分割线');
    };
    await checkDividers();
    const api = settings.getByRole('combobox', { name: '生成使用的 API', exact: true });
    await api.selectOption('custom'); await checkDividers();
    assert.equal(await settings.getByRole('textbox', { name: '接口地址', exact: true }).isVisible(), true);
    await settings.locator('.play-regex-list>summary').click();
    await settings.getByRole('checkbox', { name: '状态栏美化', exact: true }).waitFor(); await checkDividers();
    const appearance = settings.getByRole('combobox', { name: '外观', exact: true });
    for (const source of ['tavern', 'default']) { await appearance.selectOption(source); await checkDividers(); }
    const metrics = await settings.evaluate(area => ({
        appearance: ['height', 'fontSize', 'backgroundColor'].map(key => getComputedStyle(area.querySelector('[aria-label="外观"]'))[key]),
        prompt: ['height', 'fontSize'].map(key => getComputedStyle(area.querySelector('[aria-label="自定义小剧场提示词"]'))[key]),
        noteMargin: getComputedStyle(area.querySelector('.play-prompt-note')).marginBottom,
        apiPadding: getComputedStyle(area.querySelector('.play-api-fields')).paddingBottom,
        continuePadding: [...area.querySelectorAll('.play-continue-settings>.tea-setting-row')].map(row => getComputedStyle(row).paddingBottom),
    }));
    assert.deepEqual(metrics.appearance, [viewport.width <= 760 ? '32px' : '40px', '14px', 'rgb(250, 247, 238)'], '外观下拉框保留现有尺寸、字号和底色');
    assert.deepEqual(metrics.prompt, ['44px', viewport.width <= 760 ? '16px' : '14px'], '提示词下拉框保留现有样式');
    assert.equal(metrics.noteMargin, '4px'); assert.equal(metrics.apiPadding, '12px');
    assert.deepEqual(metrics.continuePadding, ['0px', '0px'], '续写设置去掉与说明之间重复的留白');
    await api.selectOption('tavern');
    await settings.locator('.play-regex-list>summary').click();
    await settings.evaluate(area => {
        const reading = [...area.children].find(group => group.querySelector('h3').textContent === '阅读外观');
        area.scrollTop += reading.getBoundingClientRect().top - area.getBoundingClientRect().top - 16;
    });
    await screenshot(page, `settings-sections-${viewport.width}.png`);
}

async function verifyTags(page, viewport, fallback) {
    const panel = page.locator('#teahouse-panel');
    const settings = panel.locator('.tea-settings');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const tags = settings.getByRole('textbox', { name: '隐藏标签', exact: true });
    const metrics = () => tags.evaluate(node => {
        const style = getComputedStyle(node);
        return { height: node.getBoundingClientRect().height, scroll: node.scrollHeight, client: node.clientHeight,
            line: parseFloat(style.lineHeight), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
            border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) };
    });
    assert.equal(await tags.inputValue(), 'think,thinking,update,status');
    const short = await metrics();
    assert.ok(short.height >= 42 && short.height <= short.line * 2 + short.padding + short.border,
        '默认标签只占一至两行，窄屏折行时自动增加高度');
    if ([1440, 390].includes(viewport.width)) {
        await tags.fill(Array.from({ length: 6 }, (_, i) => `hidden_tag_${i}`).join(',')); await settle(page);
        const wideHeight = (await metrics()).height;
        await page.setViewportSize({ ...viewport, width: viewport.width === 1440 ? 820 : 320 }); await settle(page);
        assert.ok((await metrics()).height > wideHeight, '窗口变窄后，已有标签自动折行并增高');
        await page.setViewportSize(viewport); await settle(page);
        assert.equal((await metrics()).height, wideHeight, '窗口变宽后，已有标签恢复原有高度');
    }
    const commaTags = Array.from({ length: 18 }, (_, i) => `hidden_tag_${i}`).join(',');
    await tags.fill(commaTags); await settle(page);
    const wrapped = await metrics();
    assert.ok(wrapped.height > short.height, '只有逗号、没有手动换行的长名单也会增高');
    assert.ok(wrapped.height <= wrapped.line * 5 + wrapped.padding + wrapped.border + 1, '自动折行最多占五行');
    assert.equal(await tags.inputValue(), commaTags, '调整高度不改变标签内容');
    for (const lines of [3, 5, 8]) {
        await tags.fill(Array.from({ length: lines }, (_, i) => `tag_${i}`).join('\n')); await settle(page);
        const size = await metrics(), expected = size.line * Math.min(lines, 5) + size.padding + size.border;
        assert.ok(Math.abs(size.height - expected) <= 1, `${lines} 行内容显示 ${Math.min(lines, 5)} 行高度`);
        assert.equal(size.scroll > size.client + 1, lines > 5, '只有超过五行时才需要框内滚动');
    }
    await tags.evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert.ok(await tags.evaluate(node => node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 2),
        '超过五行仍可滚动到最后一个标签');
    await settings.evaluate(node => {
        node.scrollTop += node.querySelector('.play-display-settings').getBoundingClientRect().top - node.getBoundingClientRect().top - 16;
    });
    if (!fallback) await screenshot(page, `hidden-tags-five-lines-${viewport.width}.png`);
    await button(viewport.width <= 760 ? '返回列表' : '设置').click(); await button('设置').click(); await settle(page);
    const reopened = await metrics();
    assert.ok(Math.abs(reopened.height - reopened.line * 5 - reopened.padding - reopened.border) <= 1,
        '重新打开设置时，保存的多行名单直接显示正确高度');
    assert.equal(await tags.inputValue(), Array.from({ length: 8 }, (_, i) => `tag_${i}`).join('\n'));
    await tags.fill('think'); await settle(page);
    assert.equal((await metrics()).height, 42, '删短后恢复一行高度');
    await tags.fill(''); await settle(page);
    assert.equal((await metrics()).height, 42, '清空后保留一行填写空间');
    await page.reload(); await page.waitForFunction(() => window.ready);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await button('设置').click();
    assert.equal(await tags.inputValue(), '', '自动增高不覆盖已保存的空内容');
    assert.ok(await panel.evaluate(node => node.scrollWidth - node.clientWidth <= 1));
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        for (const fallback of [false, true]) {
            for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
                const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
                if (fallback) await page.addInitScript(() => {
                    const supports = CSS.supports.bind(CSS);
                    CSS.supports = (property, value) => property === 'field-sizing' ? false : supports(property, value);
                });
                const url = `http://127.0.0.1:${server.address().port}/`;
                await page.goto(url); await page.waitForFunction(() => window.ready);
                if (fallback) await page.addStyleTag({ content: '.play-hidden-tags { field-sizing:fixed!important; }' });
                assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
                await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
                await page.locator('#teahouse-panel').getByRole('button', { name: '设置', exact: true }).filter({ visible: true }).click();
                await settle(page);
                assert.ok((await page.locator('.tea-settings').innerText()).includes('回复显示'));
                assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
                if (!fallback) await verifySections(page, viewport);
                await verifyTags(page, viewport, fallback);
                assert.deepEqual(errors, []);
                console.log(JSON.stringify({ url, viewport, fallback, checks: '板块分割线、内部无线、保留下拉框样式、已确认的空白、标签自动折行、五行上限、滚动到底、缩回一行、重新打开、留空保存、无溢出', errors }));
                await context.close();
            }
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
