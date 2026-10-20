// Flow: browse synthetic stories -> close or play -> resume the same reading position.
// Browser plugin not available; use the repository's Playwright/Edge test harness.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const benchmark = process.argv.includes('--benchmark');
const baselinePanel = baseline ? execFileSync('git', ['show', 'HEAD:panel.js'], { cwd: root }) : null;
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://localhost').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(name === 'panel.js' && baselinePanel ? baselinePanel : await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => {
        let frames = 0;
        const tick = () => ++frames === 5 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
    }));
}

async function seed(page) {
    await page.evaluate(() => {
        const body = Array.from({ length: 50 }, (_, index) => `虚构测试正文第 ${index + 1} 段。只用于检查浏览位置和性能。`).join('\n\n');
        for (const [scope, count] of [['community', 120], ['manuscripts', 60]]) {
            fixture[scope].clear();
            for (let index = 0; index < count; index++) {
                const id = scope === 'community' ? `progress:${index}` : `local:${String(index).padStart(32, '0')}`;
                fixture[scope].set(id, { id, title: `${scope === 'community' ? '社区' : '手稿'}剧场 ${index + 1}`,
                    type: index % 3 ? 'standalone' : 'preset', author: '虚构作者', body,
                    publishedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
                if (scope === 'community' && index < 60) fixture.settings.favorites[id] = index + 1;
            }
        }
    });
}

async function snapshot(page) {
    return page.locator('#teahouse-panel').evaluate(panel => ({
        page: panel.querySelector('#tea-catalog .tea-page-current').textContent,
        ids: [...panel.querySelectorAll('.tea-story[data-id], .tea-feed-entry')].map(node => node.dataset.id),
        selected: panel.querySelector('.tea-reading')?.dataset.id,
        query: panel.querySelector('#tea-catalog input[type="search"]').value,
        type: panel.querySelector('.tea-kinds [aria-pressed="true"]').textContent,
        expanded: [...panel.querySelectorAll('.tea-feed-entry.tea-expanded')].map(node => node.dataset.id),
        listScroll: panel.querySelector('.tea-list').scrollTop,
        readingScroll: panel.querySelector('.tea-reading')?.scrollTop ?? 0,
    }));
}

function expectSnapshot(actual, expected, label) {
    for (const key of ['listScroll', 'readingScroll']) assert.ok(Math.abs(actual[key] - expected[key]) < 2, `${label}: ${key} (${actual[key]} / ${expected[key]})`);
    const content = value => Object.fromEntries(Object.entries(value).filter(([key]) => !key.endsWith('Scroll')));
    assert.deepEqual(content(actual), content(expected), label);
}

async function jump(page, number) {
    const panel = page.locator('#teahouse-panel');
    await panel.getByRole('button', { name: '跳转到某页', exact: true }).filter({ visible: true }).click();
    await panel.getByRole('textbox', { name: '跳转页码', exact: true }).fill(String(number));
    await panel.getByRole('button', { name: '确认跳转', exact: true }).click();
    await settle(page);
}

async function read(page, mobile) {
    await page.locator('#teahouse-panel').evaluate((panel, mobile) => {
        if (mobile) for (const entry of [...panel.querySelectorAll('.tea-feed-entry')].slice(0, 2)) {
            if (!entry.classList.contains('tea-expanded')) entry.querySelector('.tea-fold').click();
        }
        else panel.querySelectorAll('.tea-story')[1]?.click();
    }, mobile);
    await settle(page);
    await page.locator(mobile ? '.tea-list' : '.tea-reading').evaluate(node => { node.scrollTop = 740; });
    await settle(page);
    const saved = await snapshot(page);
    assert.ok(saved[mobile ? 'listScroll' : 'readingScroll'] > 700, '先滚动到长正文内部再测试恢复');
    return saved;
}

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verifyProgress(page, mobile) {
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('独立剧场').click();
    await jump(page, 3);
    const community = await read(page, mobile);
    await button('关闭面板').click();
    await panel.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await settle(page);
    expectSnapshot(await snapshot(page), community, '关闭再打开保留页码、篇目和正文位置');
    if (!mobile) {
        await button('收起左侧栏').click(); await settle(page);
        await panel.locator('.tea-reading').evaluate(node => { node.scrollTop = 980; });
        const collapsed = await snapshot(page);
        await button('关闭面板').click();
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
        expectSnapshot(await snapshot(page), collapsed, '收起目录时仍保留正文位置');
        await button('展开左侧栏').click(); await settle(page);
        await panel.locator('.tea-reading').evaluate(node => { node.scrollTop = 740; });
    }

    // Trigger the real entry-fill handler without Playwright scrolling its button into view.
    await panel.locator('.play-in-plugin').first().evaluate(node => node.click());
    await panel.locator('.play-compose-input:visible').waitFor();
    await button('设置').click();
    await button(mobile ? '返回剧场演出' : '设置').click();
    await button('茶会选集').click();
    await settle(page);
    expectSnapshot(await snapshot(page), community, '进入插件游玩后返回原来的阅读位置');

    await button('亲笔手稿').click();
    await button('随文剧场').click();
    if (mobile) await button('搜索剧场').click();
    await panel.getByRole('searchbox').fill('手稿');
    await jump(page, 2);
    const manuscripts = await read(page, mobile);
    await button('我的收藏').click();
    assert.equal(await panel.locator('#tea-catalog input[type="search"]').inputValue(), '', '手稿搜索词不会带入收藏');
    await jump(page, 2);
    const favorites = await read(page, mobile);
    await button('茶会选集').click(); await settle(page);
    expectSnapshot(await snapshot(page), community, '各栏目分别保存选集进度');
    await button('亲笔手稿').click(); await settle(page);
    expectSnapshot(await snapshot(page), manuscripts, '各栏目分别保存手稿进度和搜索分类');
    await button('我的收藏').click(); await settle(page);
    expectSnapshot(await snapshot(page), favorites, '各栏目分别保存收藏进度');

    await button('茶会选集').click(); await settle(page);
    await button('设置').click();
    await button(mobile ? '返回列表' : '设置').click(); await settle(page);
    expectSnapshot(await snapshot(page), community, '从设置返回也保留正文位置');
    await screenshot(page, `progress-${mobile ? 'mobile' : 'desktop'}.png`);

    await page.evaluate(async () => {
        const round = await runtime.getRound(seed.a), result = round.results[0];
        await runtime.addFavorite({ roundId: round.id, resultId: result.id, startedAt: result.startedAt,
            expectedText: result.text, firstLine: '虚构演出记录收藏' });
    });
    await button('我的收藏').click();
    await button('演出记录').click();
    await panel.locator('.tea-story').first().click();
    const favoriteReader = panel.locator('.play-favorite-reading:visible');
    await favoriteReader.getByText('阅读位置验证第24段。', { exact: true }).waitFor();
    await settle(page);
    await favoriteReader.evaluate(node => { node.scrollTop = 420; });
    const favoriteScroll = await favoriteReader.evaluate(node => node.scrollTop);
    assert.ok(favoriteScroll > 200);
    await button('关闭面板').click();
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
    assert.ok(Math.abs(await favoriteReader.evaluate(node => node.scrollTop) - favoriteScroll) < 2, '演出记录收藏关闭后恢复正文位置');
    if (mobile) await button('返回收藏目录').click();
    await button('茶会选集').click(); await settle(page);
    expectSnapshot(await snapshot(page), community, '阅读演出记录收藏后选集进度保持不变');

    await button('排序方式').click();
    await panel.getByRole('menuitemradio', { name: '随机顺序', exact: true }).click();
    await jump(page, 2);
    const random = await read(page, mobile);
    await button('剧场演出').click();
    await button('茶会选集').click(); await settle(page);
    expectSnapshot(await snapshot(page), random, '随机排序返回后顺序不变');
    await button('关闭面板').click();
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
    expectSnapshot(await snapshot(page), random, '关闭后随机顺序不变');

    if (mobile && !await panel.getByRole('searchbox').count()) await button('搜索剧场').click();
    await panel.getByRole('searchbox').fill('社区剧场'); await settle(page);
    assert.equal(await panel.locator('#tea-catalog .tea-page-current').textContent(), '01', '主动搜索从第一页开始');
    assert.equal(await panel.locator('.tea-list').evaluate(node => node.scrollTop), 0);
    if (mobile) await button('取消搜索').click();
    await jump(page, 2);
    await button('随文剧场').click(); await settle(page);
    assert.equal(await panel.locator('#tea-catalog .tea-page-current').textContent(), '01', '切换分类从第一页开始');
    await jump(page, 2);
    await button('排序方式').click();
    await panel.getByRole('menuitemradio', { name: '时间顺序', exact: true }).click(); await settle(page);
    assert.equal(await panel.locator('#tea-catalog .tea-page-current').textContent(), '01', '切换排序从第一页开始');

    await jump(page, 2);
    await button('关闭面板').click();
    await page.evaluate(() => { fixture.community.clear(); });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
    assert.equal(await panel.locator('#tea-catalog .tea-page-current').textContent(), '01', '原来的篇目被删除时回到有效页');
    assert.equal(await panel.locator('.tea-feed-entry, .tea-story[data-id]').count(), 0, '被删除的篇目不会重新出现');
    await page.reload(); await page.waitForFunction(() => window.ready);
    await seed(page);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
    assert.equal(await panel.locator('#tea-catalog .tea-page-current').textContent(), '01', '刷新后清空临时浏览进度');
    assert.equal(await button('全部').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => captured.length), 0, '所有浏览测试都没有发送模型请求');
}

async function measurePerformance(page) {
    return page.evaluate(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const samples = { close: [], switch: [], playClose: [] };
        const tab = name => [...document.querySelectorAll('#teahouse-panel .tea-tabs button')].find(node => node.textContent === name && node.getClientRects().length);
        for (let index = 0; index < 10; index++) {
            let started = performance.now();
            await ui.close();
            samples.close.push(performance.now() - started);
            void ui.open(); await frame(); await frame();
            started = performance.now();
            tab('亲笔手稿').click();
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            samples.switch.push(performance.now() - started);
            await frame(); tab('茶会选集').click(); await frame();
        }
        tab('剧场演出').click(); await frame(); await frame();
        for (let index = 0; index < 10; index++) {
            const started = performance.now();
            await ui.close(); samples.playClose.push(performance.now() - started);
            void ui.open(); await frame(); await frame();
        }
        tab('茶会选集').click(); await frame();
        // A catalog close must not persist data or inspect the conversation geometry.
        const panel = document.querySelector('#teahouse-panel');
        const originalQuery = panel.querySelector;
        const originalRect = Element.prototype.getBoundingClientRect;
        const originalWrite = Storage.prototype.setItem;
        let writes = 0, geometryReads = 0, conversationQueries = 0;
        panel.querySelector = function (selector) {
            if (selector.includes('.play-feed') || selector.includes('data-read-anchor')) conversationQueries++;
            return originalQuery.call(this, selector);
        };
        Element.prototype.getBoundingClientRect = function () { geometryReads++; return originalRect.call(this); };
        Storage.prototype.setItem = function (...args) { writes++; return originalWrite.apply(this, args); };
        await ui.close();
        panel.querySelector = originalQuery;
        Element.prototype.getBoundingClientRect = originalRect;
        Storage.prototype.setItem = originalWrite;
        const result = {};
        for (const [name, values] of Object.entries(samples)) {
            const sorted = values.slice().sort((a, b) => a - b);
            result[name] = { medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), maxMs: +sorted.at(-1).toFixed(2) };
        }
        return { ...result, catalogClose: { writes, geometryReads, conversationQueries } };
    });
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            const page = await browser.newPage({ viewport });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            assert.equal(await page.title(), '小剧场设置与原文编辑验证');
            await page.waitForFunction(() => window.ready); await seed(page);
            await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
            assert.ok(await page.locator('#tea-catalog').innerText(), '面板有实际内容，未出现空白或错误覆盖层');
            if (!benchmark) await verifyProgress(page, viewport.width <= 760);
            const performance = await measurePerformance(page);
            assert.deepEqual(performance.catalogClose, { writes: 0, geometryReads: 0, conversationQueries: 0 });
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ baseline, viewport, progressVerified: !benchmark, performance, errors }));
            await page.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
