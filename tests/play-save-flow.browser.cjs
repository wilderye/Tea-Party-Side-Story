const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://test').pathname.slice(1));
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const button = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true });
const panel = page => page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
const branch = page => panel(page).locator('.play-branch-page');
const record = (page, id) => panel(page).locator(`[data-record="${id}"]`);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function setup(page, url, route) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await button(page, '打开小剧场面板').click(); await button(panel(page), '剧场演出').click();
    await panel(page).locator('.play-record').first().waitFor();
    await page.evaluate(() => {
        window.saveErrors = [];
        const session = runtime.session, edit = testHistory.editMessage.bind(testHistory);
        window.editGate = null;
        testHistory.editMessage = async (...args) => {
            if (window.delayEdit) await new Promise(resolve => window.editGate = resolve);
            if (window.failEdit) throw Error('模拟保存失败');
            return edit(...args);
        };
        window.session = session;
    });
    const id = await page.evaluate(() => seed.a);
    if (route === 'chat') {
        await button(panel(page), '历史记录').click();
        await panel(page).locator(`[data-chat-id="${id}"] .play-history-open`).click();
        await branch(page).locator('.play-assistant-message').first().waitFor();
    }
    assert.match(await panel(page).innerText(), /茶话会/);
    return id;
}
async function verifyEditing(page, url, route, role) {
    const id = await setup(page, url, route);
    const item = route === 'record' ? record(page, id) : branch(page).locator(`.play-${role}-message`).first();
    const editName = role === 'assistant' ? '编辑回复原文' : route === 'record' ? '修改提示词' : '修改用户消息';
    const fieldName = role === 'assistant' ? '回复原文' : route === 'record' ? '提示词原文' : '用户消息原文';
    await button(item, editName).click();
    const input = item.getByRole('textbox', { name: fieldName, exact: true });
    await input.fill(`${route}-${role}后台保存正文`);
    await page.evaluate(() => window.delayEdit = true);
    await button(item, '保存').click();
    await input.waitFor({ state: 'detached' }); await page.waitForFunction(() => typeof editGate === 'function');
    await item.getByText(`${route}-${role}后台保存正文`, { exact: true }).waitFor();
    assert.equal(await item.locator('[aria-busy="true"]').count(), 0);
    assert.equal(await page.evaluate(() => session.hasUnsaved()), true);
    const target = route === 'record' ? record(page, id) : branch(page).locator(`.play-${role === 'assistant' ? 'user' : 'assistant'}-message`).first();
    const nextName = role === 'assistant' ? route === 'record' ? '修改提示词' : '修改用户消息' : '编辑回复原文';
    await button(target, nextName).click(); await target.locator('textarea').waitFor();
    await target.locator('textarea').fill('B编辑草稿保留');
    await page.evaluate(() => { window.delayEdit = false; window.failEdit = true; editGate(); });
    await page.waitForFunction(() => saveErrors.length === 1); await settle(page);
    assert.equal(await target.locator('textarea').inputValue(), 'B编辑草稿保留');
    assert.equal(await item.getByText(`${route}-${role}后台保存正文`, { exact: true }).count(), 1);
    assert.equal(await page.locator('.play-feed .play-edit-form').count(), 1);
    await button(target, '取消').click();
    await page.evaluate(() => window.failEdit = false);
    await button(item, editName).click(); await button(item, '保存').click();
    await page.evaluate(id => session.flush(id), id);
    assert.equal(await page.evaluate(() => captured.length), 0);
    assert.equal(await page.locator('.play-result-error:visible').count(), 0);
    if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `save-${route}-${role}-${page.viewportSize().width}.png`) });
}
async function verifySending(page, url, route) {
    const id = await setup(page, url, route);
    await page.evaluate(() => {
        const save = testHistory.saveResult.bind(testHistory);
        window.delayFinal = true;
        testHistory.saveResult = async (...args) => { if (delayFinal) await new Promise(resolve => { (window.finalReleases ??= []).push(resolve); window.releaseFinal = resolve; }); return save(...args); };
        const favorites = runtime.listFavorites.bind(runtime);
        runtime.listFavorites = async () => { await new Promise(resolve => window.releaseFavorites = resolve); return favorites(); };
    });
    const input = route === 'record' ? panel(page).getByRole('textbox', { name: '小剧场提示词', exact: true })
        : branch(page).getByRole('textbox', { name: '分支聊天输入', exact: true });
    const sendName = route === 'record' ? '发送小剧场' : '发送消息';
    await input.fill('第一条先显示'); await button(panel(page), sendName).click();
    await panel(page).getByText('第一条先显示', { exact: true }).waitFor();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await page.evaluate(() => { emitGeneration('第一条最终正文'); finishGeneration('第一条最终正文'); });
    await page.waitForFunction(() => typeof releaseFinal === 'function');
    await panel(page).getByText('第一条最终正文', { exact: true }).waitFor();
    await input.fill('第二条立即显示');
    assert.equal(await button(panel(page), sendName).isDisabled(), false); await input.press('Control+Enter');
    await panel(page).getByText('第二条立即显示', { exact: true }).waitFor();
    if (route === 'chat') {
        assert.equal(await branch(page).getByRole('button', { name: '显示后面的消息', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => captured.length), 1);
        await button(branch(page), '停止这份回复').click();
        await page.waitForFunction(() => runtime.getStates().length === 0);
    } else {
        await page.waitForFunction(() => captured.length === 2);
        await page.evaluate(() => finishGeneration('第二条独立演出回复'));
    }
    await page.evaluate(() => { window.delayFinal = false; for (const release of finalReleases) release(); window.releaseFavorites?.(); });
    if (route === 'chat') await page.evaluate(id => session.flush(id), id);
    await settle(page);
    assert.equal(await panel(page).getByText('第二条立即显示', { exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => ctx.chat), [{ mes: '原聊天', is_user: false }]);
    if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `send-${route}-${page.viewportSize().width}.png`) });
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    if (process.env.TEA_QA_DIR) await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
            for (const route of ['record', 'chat']) for (const flow of ['user', 'assistant', 'send']) {
                const context = await browser.newContext({ viewport, hasTouch: true }), page = await context.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                try {
                    const url = `http://127.0.0.1:${server.address().port}/`;
                    if (flow === 'send') await verifySending(page, url, route); else await verifyEditing(page, url, route, flow);
                    assert.deepEqual(errors, []); assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
                    console.log(JSON.stringify({ viewport, route, flow, passed: true }));
                } catch (error) { console.error(JSON.stringify({errors, body: await panel(page).innerText()})); throw error; } finally { await context.close(); }
            }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
