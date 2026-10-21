// Flow: delay an old favorites read -> finish a user edit -> release the read.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
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

async function holdFavoriteRead(page, catalog = false) {
    await page.evaluate(catalog => {
        const original = runtime.listFavorites;
        window.favoriteReadCalls = 0;
        window.favoriteReadHeld = false;
        window.favoriteReadReturned = false;
        runtime.listFavorites = async (...args) => {
            window.favoriteReadCalls++;
            const rows = await original(...args);
            window.favoriteReadHeld = true;
            await new Promise(resolve => { window.releaseFavoriteRead = resolve; });
            window.favoriteReadReturned = true;
            runtime.listFavorites = original;
            return rows;
        };
        if (catalog) ui.refresh();
        else window.dispatchEvent(new Event('focus'));
    }, catalog);
    await page.waitForFunction(() => window.favoriteReadHeld);
}

async function releaseFavoriteRead(page) {
    assert.equal(await page.evaluate(() => window.favoriteReadCalls), 1, '只延迟一次旧读取，没有用额外刷新掩盖问题');
    await page.evaluate(() => window.releaseFavoriteRead());
    await page.waitForFunction(() => window.favoriteReadReturned);
    await settle(page);
}

async function verifyFavoriteReads(page, viewport) {
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('剧场演出').click();
    const id = await page.evaluate(() => seed.a), record = panel.locator(`[data-record="${id}"]`);
    const star = record.locator('.play-assistant-meta .tea-star');
    await star.waitFor();
    await page.waitForFunction(id => !document.querySelector(`[data-record="${id}"] .play-assistant-meta .tea-star`)?.disabled, id);
    for (const selected of [true, false]) {
        await holdFavoriteRead(page);
        await star.click();
        await page.waitForFunction(async selected => (await testHistory.listFavorites()).length === Number(selected), selected);
        await page.waitForFunction(({ id, selected }) => document.querySelector(`[data-record="${id}"] .play-assistant-meta .tea-star`)
            ?.getAttribute('aria-pressed') === String(selected), { id, selected });
        await releaseFavoriteRead(page);
        assert.equal(await star.getAttribute('aria-pressed'), String(selected), '旧目录不能恢复点击前的星标');
        assert.equal(await star.isEnabled(), true);
        assert.equal(await page.evaluate(async () => (await testHistory.listFavorites()).length), Number(selected));
    }
    await star.click();
    await record.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    await screenshot(page, `architecture-favorite-fixed-${viewport.width}.png`);
    await button('我的收藏').click();
    await button('演出记录').click();
    const favoriteId = await page.evaluate(async () => (await testHistory.listFavorites())[0].id);
    const row = panel.locator(`.tea-story[data-id="${favoriteId}"]`);
    await row.click();
    const reader = panel.locator('.play-favorite-reading:visible');
    await reader.getByRole('button', { name: '编辑演出记录收藏', exact: true }).waitFor();

    await holdFavoriteRead(page, true);
    await reader.getByRole('button', { name: '编辑演出记录收藏', exact: true }).click();
    await reader.getByRole('textbox', { name: '收藏标题', exact: true }).fill('刚保存的新标题');
    await reader.getByRole('button', { name: '保存', exact: true }).click();
    await reader.getByRole('button', { name: '编辑演出记录收藏', exact: true }).waitFor();
    await releaseFavoriteRead(page);
    assert.equal(await row.locator('.tea-story-title').textContent(), '刚保存的新标题', '旧读取不能把收藏目录标题改回去');
    assert.equal(await reader.locator('.play-favorite-title').textContent(), '刚保存的新标题');
    assert.equal((await page.evaluate(id => testHistory.getFavorite(id), favoriteId)).title, '刚保存的新标题');

    await holdFavoriteRead(page, true);
    await reader.getByRole('button', { name: '取消收藏', exact: true }).click();
    await page.waitForFunction(async () => (await testHistory.listFavorites()).length === 0);
    await releaseFavoriteRead(page);
    assert.equal(await row.count(), 0, '旧读取不能让已取消的收藏重新出现在目录');
    assert.equal(await panel.locator('.play-favorite-reading:visible').count(), 0);
    assert.equal(await page.evaluate(() => captured.length), 0, '收藏操作没有发送模型请求');
}

async function verifySettingsRefresh(page, viewport) {
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('茶会选集').click();
    await button('设置').click();
    const input = panel.getByRole('textbox', { name: '小剧场提示词内容', exact: true });
    await input.fill('正在编辑的小剧场要求。\n'.repeat(20));
    await input.focus();
    const saved = await input.evaluate(node => {
        window.settingsInput = node;
        window.settingsArea = node.closest('.tea-settings');
        // Include uncommitted IME text: a rebuild from saved settings loses it.
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '尚未确认' }));
        node.value += '尚未确认';
        node.setSelectionRange(5, 12);
        node.scrollTop = 20;
        return { value: node.value, start: node.selectionStart, end: node.selectionEnd,
            inputScroll: node.scrollTop, areaScroll: settingsArea.scrollTop };
    });
    const assertPreserved = async () => {
        const actual = await page.evaluate(() => ({
            connected: settingsInput.isConnected && settingsArea.isConnected,
            focused: document.activeElement === settingsInput,
            value: settingsInput.value, start: settingsInput.selectionStart, end: settingsInput.selectionEnd,
            inputScroll: settingsInput.scrollTop, areaScroll: settingsArea.scrollTop,
        }));
        assert.deepEqual(actual, { connected: true, focused: true, ...saved }, '输入框、输入法文字、选区和两层滚动位置都保持');
    };
    for (const [status, updating] of [['正在检查更新…', true], ['正在更新 1 / 2', true],
        ['茶会选集更新完成，共 60 条', false], ['更新未完成：模拟网络错误', false], ['', false]]) {
        await page.evaluate(({ status, updating }) => {
            Object.assign(fixture, { status, statusKind: status ? 'update' : '', updating });
            ui.refreshStatus();
        }, { status, updating });
        assert.equal(await panel.locator('.tea-update-status').textContent(), status);
        assert.equal(await button('手动更新').getAttribute('aria-busy'), String(updating));
        assert.equal(await button('手动更新').isDisabled(), updating);
        await assertPreserved();
    }
    await page.evaluate(() => {
        for (let index = 0; index < 60; index++) fixture.community.set('updated:' + index, {
            id: 'updated:' + index, type: 'standalone', title: '刚更新的剧场 ' + index,
            body: '用于验证新目录的虚构正文。', author: '测试作者', publishedAt: '2026-10-01T00:00:00Z',
        });
        ui.refresh();
    });
    await settle(page);
    await settle(page);
    await assertPreserved();
    assert.match(await panel.locator('.tea-list').textContent(), /刚更新的剧场/);
    if (viewport.width > 760) {
        const catalog = await panel.locator('.tea-catalog:visible').boundingBox();
        const settings = await panel.locator('.tea-settings').boundingBox();
        assert.ok(catalog.x + catalog.width <= settings.x + 1, '目录更新后设置仍在右侧');
    }
    await screenshot(page, `architecture-settings-fixed-${viewport.width}.png`);
    await input.evaluate(node => {
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '尚未确认' }));
        node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await button(viewport.width > 760 ? '设置' : '返回列表').click();
    await button('剧场演出').click();
    await button('设置').click();
    await input.focus();
    await input.evaluate(node => { window.settingsInput = node; });
    await page.evaluate(() => { ui.refreshStatus(); ui.refresh(); });
    await settle(page);
    assert.equal(await page.evaluate(() => settingsInput.isConnected && document.activeElement === settingsInput), true,
        '从演出页进入设置也保留当前输入框');
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            const url = `http://127.0.0.1:${server.address().port}/`;
            await page.goto(url);
            await page.waitForFunction(() => window.ready);
            assert.equal(page.url(), url);
            assert.equal(await page.title(), '小剧场设置与原文编辑验证');
            await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
            await verifyFavoriteReads(page, viewport);
            await verifySettingsRefresh(page, viewport);
            assert.ok((await page.locator('#teahouse-panel').innerText()).includes('小剧场生成'));
            assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
            assert.ok(await page.locator('#teahouse-panel').evaluate(node => node.scrollWidth - node.clientWidth <= 1));
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ url, viewport, checks: '收藏与取消、改名与删除、迟到目录、更新进度、设置焦点和输入法文字、选区与滚动、存储一致', errors }));
            await context.close();
        }
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
