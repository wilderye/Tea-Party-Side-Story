const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: base } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = base.replace('<title>小剧场设置与原文编辑验证</title>', '<title>收藏即时反馈验证</title>');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (!/^(?:[\w-]+\.(?:js|css)|vendor\/markdown-it\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(name)) {
            response.statusCode = 404; return response.end();
        }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, name)));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});

const idle = page => page.waitForFunction(() => !runtime.favoriteOperations.hasPending());
const star = message => message.locator('.tea-star');
async function tools(message) {
    const more = message.getByRole('button', { name: '更多回复操作', exact: true });
    if (await more.isVisible() && !await star(message).isVisible()) await more.click();
}
async function saveGate(page) {
    await page.evaluate(() => { window.holdSave = true; window.resumeSave = null; });
}
async function release(page) {
    await page.evaluate(() => { window.holdSave = false; resumeSave(); });
    await idle(page);
}
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verify(page, viewport, url) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '收藏即时反馈验证');
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('剧场演出').click();
    const seedId = await page.evaluate(() => seed.a);
    const record = panel.locator(`[data-record="${seedId}"]`);
    const ai = record.locator('.play-assistant-message'), user = record.locator('.play-user-message');
    await ai.waitFor(); await tools(ai); await star(ai).waitFor({ state: 'visible' });
    await page.waitForFunction(id => !document.querySelector(`[data-record="${id}"] .play-assistant-message .tea-star`)?.disabled, seedId);
    assert.ok((await panel.textContent()).includes('小剧场正文'));
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(), 0);
    const chatBefore = await page.evaluate(() => structuredClone(ctx.chat));

    await saveGate(page); await star(ai).click();
    await page.waitForFunction(() => typeof resumeSave === 'function');
    assert.equal(await star(ai).getAttribute('aria-pressed'), 'true');
    assert.equal(await star(ai).isEnabled(), true);
    assert.equal(await star(ai).evaluate(node => Number(getComputedStyle(node).opacity)), 1);
    assert.notEqual(await star(ai).locator('svg').evaluate(node => getComputedStyle(node).fill), 'none');
    assert.equal((await page.evaluate(() => runtime.listFavorites())).length, 0);
    await screenshot(page, `favorite-pending-${viewport.width}.png`);
    await star(ai).click();
    assert.equal(await star(ai).getAttribute('aria-pressed'), 'false');
    await release(page);
    assert.equal((await page.evaluate(() => runtime.listFavorites())).length, 0);
    assert.equal(await star(ai).getAttribute('aria-pressed'), 'false');

    await star(ai).click(); await idle(page);
    assert.equal((await page.evaluate(() => runtime.listFavorites())).length, 1);
    await page.evaluate(() => { window.failSave = true; });
    await star(ai).click(); await idle(page);
    await panel.locator('.tea-status').getByText('取消收藏失败', { exact: true }).waitFor();
    assert.equal(await star(ai).getAttribute('aria-pressed'), 'true');
    assert.equal((await page.evaluate(() => runtime.listFavorites())).length, 1);
    await page.evaluate(() => { window.failSave = false; });
    await star(ai).click(); await idle(page);
    await page.evaluate(() => { window.failSave = true; });
    await star(ai).click(); await idle(page);
    await panel.locator('.tea-status').getByText('收藏失败', { exact: true }).waitFor();
    assert.equal(await star(ai).getAttribute('aria-pressed'), 'false');
    assert.equal(await star(ai).isEnabled(), true);
    assert.equal(await star(ai).locator('svg').evaluate(node => getComputedStyle(node).fill), 'none');
    assert.equal((await page.evaluate(() => runtime.listFavorites())).length, 0);
    await screenshot(page, `favorite-failed-${viewport.width}.png`);
    await page.evaluate(() => { window.failSave = false; });
    await star(ai).click(); await idle(page);
    assert.equal(await star(ai).getAttribute('aria-pressed'), 'true');
    assert.equal(await panel.locator('.tea-status').isVisible(), false, '重试成功后不保留上一条收藏失败提示');

    await page.evaluate(() => { window.failManuscriptSave = true; });
    await star(user).click(); await idle(page);
    assert.equal(await star(user).getAttribute('aria-pressed'), 'false');
    await panel.locator('.tea-status').getByText('收藏失败', { exact: true }).waitFor();
    await page.evaluate(() => { window.failManuscriptSave = false; window.holdManuscriptSave = true; window.resumeManuscriptSave = null; });
    await star(user).click();
    await page.waitForFunction(() => typeof resumeManuscriptSave === 'function');
    assert.equal(await star(user).getAttribute('aria-pressed'), 'true');
    assert.equal(await star(user).isEnabled(), true);
    await star(user).click();
    assert.equal(await star(user).getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => { window.holdManuscriptSave = false; resumeManuscriptSave(); });
    await idle(page);
    assert.equal(await star(user).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => fixture.manuscripts.size), 1);

    const branchId = await page.evaluate(async id => {
        const chat = await runtime.getChat(id);
        return (await runtime.createBranch(chat.id, chat.messages[1].id, chat.revision)).id;
    }, seedId);
    await button('历史记录').click();
    await panel.locator(`[data-chat-id="${branchId}"] .play-history-open`).click();
    const branch = panel.locator('.play-branch-page');
    const reply = branch.locator('.play-assistant-message').first();
    await reply.waitFor(); await tools(reply);
    await page.evaluate(() => {
        window.favoriteWindowReads = 0; window.favoriteWindowReader = runtime.getChatWindow;
        runtime.getChatWindow = (...args) => { favoriteWindowReads++; return favoriteWindowReader(...args); };
        window.favoriteBody = document.querySelector('.play-branch-page .play-assistant-message .play-results');
    });
    await saveGate(page); await star(reply).click();
    await page.waitForFunction(() => typeof resumeSave === 'function');
    assert.equal(await star(reply).getAttribute('aria-pressed'), 'true');
    assert.equal(await star(reply).isEnabled(), true);
    assert.equal(await panel.locator('.tea-status').isVisible(), false);
    assert.equal(await branch.getByRole('textbox', { name: '分支聊天输入', exact: true }).isEnabled(), true);
    await screenshot(page, `branch-favorite-pending-${viewport.width}.png`);
    await release(page);
    assert.equal(await star(reply).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => favoriteWindowReads), 0);
    assert.equal(await reply.locator('.play-results').evaluate(node => node === favoriteBody), true);
    await page.evaluate(() => { window.failSave = true; });
    await star(reply).click(); await idle(page);
    await panel.locator('.tea-status').getByText('取消收藏失败', { exact: true }).waitFor();
    assert.equal(await star(reply).getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { window.failSave = false; });
    await star(reply).click(); await idle(page);
    assert.equal(await star(reply).getAttribute('aria-pressed'), 'false');

    await saveGate(page);
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    await branch.getByRole('button', { name: '收藏该聊天', exact: true }).click();
    await page.waitForFunction(() => typeof resumeSave === 'function');
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    assert.equal(await branch.getByRole('button', { name: '取消收藏该聊天', exact: true }).isEnabled(), true);
    await release(page);
    assert.equal(await page.evaluate(() => favoriteWindowReads), 0);
    assert.equal((await page.evaluate(id => runtime.listFavorites().then(rows => rows.filter(row => row.source.chatId === id)), branchId)).length, 1);
    assert.deepEqual(await page.evaluate(() => ctx.chat), chatBefore);
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ url, viewport, browser: 'Playwright + Edge',
        checks: '页面、星标立即变化、保存期间可操作、连续取消、收藏失败恢复、取消失败恢复、手稿失败与取消、分支正文不刷新、整条聊天即时反馈、主聊天保留', errors }));
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
            const context = await browser.newContext({ viewport });
            try { await verify(await context.newPage(), viewport, `http://127.0.0.1:${server.address().port}/`); }
            finally { await context.close(); }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
