const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: original } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = original.replace('Array.from({length:24}', 'Array.from({length:1}')
    .replace('const identity={userName:ctx.name1,userAvatar:persona.user_avatar};',
        'const identity=window.targetIdentity||{userName:ctx.name1,userAvatar:persona.user_avatar};');
const server = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://test').pathname.slice(1);
    if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
    if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
    if (!/^(?:[\w-]+\.(?:js|css)|vendor\/markdown-it\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(name)) {
        response.statusCode = 404; return response.end();
    }
    try {
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, name)));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const button = (panel, name) => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
async function header(message, name, avatar) {
    await message.locator('.play-speaker').getByText(name, { exact: true }).waitFor();
    const portrait = message.locator('.play-message-avatar');
    if (avatar) {
        assert.equal(await portrait.evaluate(node => node.tagName), 'IMG');
        assert.equal(await portrait.getAttribute('data-avatar'), avatar);
        await portrait.evaluate(img => img.decode());
    } else {
        assert.equal(await portrait.evaluate(node => node.tagName), 'SPAN');
        assert.equal(await portrait.textContent(), Array.from(name)[0]);
    }
}
async function more(message) {
    const toggle = message.getByRole('button', { name: '更多回复操作', exact: true });
    if (await toggle.isVisible()) await toggle.click();
}
async function finish(page, text) {
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await page.evaluate(text => window.finishGeneration(text), text);
    await page.waitForFunction(() => runtime.getStates().length === 0); await settle(page);
}
async function screenshot(page, name) {
    if (process.env.TEA_QA_DIR) { await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) }); }
}
async function verify(page, url, viewport) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.match(await page.title(), /小剧场/);
    await page.evaluate(() => {
        const native = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        Object.defineProperty(HTMLImageElement.prototype, 'src', { ...native, set(value) {
            const file = /^avatar:(.*)$/.exec(value)?.[1]
                ?? (value.startsWith('/thumbnail?') ? new URL(value, location.href).searchParams.get('file') : null);
            if (!file) return native.set.call(this, value);
            this.dataset.avatar = file;
            const color = file === 'user.png' ? '#73a389' : '#a875b5';
            native.set.call(this, 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${color}"/></svg>`));
        } });
        ctx.getThumbnailUrl = (_type, file) => `avatar:${file}`;
    });
    await button(page, '打开小剧场面板').click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    assert.match(await panel.innerText(), /茶话会/);
    await button(panel, '剧场演出').click();
    const id = await page.evaluate(() => seed.a), record = panel.locator(`[data-record="${id}"]`);
    await record.locator('.play-user-message').waitFor();
    await header(record.locator('.play-user-message'), '茶客', 'user.png');
    await more(record); await button(record, '创建分支').click();
    const branch = panel.locator('.play-branch-page').filter({ visible: true });
    await branch.locator('[data-message-id]').nth(1).waitFor();
    await header(branch.locator('.play-user-message').first(), '茶客', 'user.png');
    await page.evaluate(() => { window.targetIdentity = { userName: '目标乙', userAvatar: 'target.png' }; ctx.name1 = '主聊天丙'; persona.user_avatar = 'host.png'; ctx.eventSource.emit(ctx.eventTypes.PERSONA_CHANGED); });
    await button(branch, '生成新版本').click();
    await finish(page, '乙生成的新版本');
    await header(branch.locator('.play-user-message').first(), '茶客', 'user.png');
    await button(branch, '上一个结果').click(); await settle(page);
    await header(branch.locator('.play-user-message').first(), '茶客', 'user.png');
    await button(branch, '下一个结果').click(); await settle(page);
    await header(branch.locator('.play-user-message').first(), '茶客', 'user.png');
    const input = branch.getByRole('textbox', { name: '分支聊天输入', exact: true });
    await input.fill('目标角色的新消息'); await button(branch, '发送消息').click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await header(branch.locator('.play-user-message').nth(1), '目标乙', 'target.png');
    await input.fill('尚未发送的草稿');
    await page.evaluate(() => window.emitGeneration('生成中的正文')); await settle(page);
    assert.equal(await input.inputValue(), '尚未发送的草稿');
    await branch.locator('.play-user-message').nth(1).scrollIntoViewIfNeeded(); await settle(page);
    await screenshot(page, `identity-streaming-${viewport.width}.png`);
    await finish(page, '目标乙的完整回复');
    const firstAi = branch.locator('.play-assistant-message').first();
    await more(firstAi); await button(firstAi, '删除 AI 消息').click();
    await page.waitForFunction(() => document.querySelector('.play-branch-page')?.querySelectorAll('.play-assistant-message').length === 1);
    await header(branch.locator('.play-user-message').first(), '茶客', 'user.png');
    await page.evaluate(() => { window.targetIdentity = { userName: '𠮷客', userAvatar: '' }; });
    await input.fill('没有头像的消息'); await button(branch, '发送消息').click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await header(branch.locator('.play-user-message').nth(2), '𠮷客', null);
    await finish(page, '没有头像仍然可以正常聊天');
    const broken = branch.locator('.play-user-message').nth(1).locator('img.play-message-avatar');
    await broken.evaluate(img => img.dispatchEvent(new Event('error')));
    await header(branch.locator('.play-user-message').nth(1), '目标乙', null);
    await branch.locator('.play-user-message').nth(2).scrollIntoViewIfNeeded(); await settle(page);
    await screenshot(page, `identity-fallback-${viewport.width}.png`);
    await button(branch, '聊天操作').click(); await button(branch, '收藏该聊天').click();
    await page.waitForFunction(async () => (await runtime.listFavorites()).some(row => row.source.type === 'chat'));
    await button(panel, '我的收藏').click(); await button(panel, '演出记录').click();
    if (viewport.width <= 760) await panel.locator('.tea-story').filter({ visible: true }).first().click();
    const favorite = panel.locator('.play-favorite-content');
    await favorite.locator('.play-user-message').nth(2).waitFor();
    await header(favorite.locator('.play-user-message').first(), '茶客', 'user.png');
    await header(favorite.locator('.play-user-message').nth(1), '目标乙', 'target.png');
    await header(favorite.locator('.play-user-message').nth(2), '𠮷客', null);
    await button(panel, '前往分支').click(); await branch.locator('.play-user-message').nth(2).waitFor();
    await header(branch.locator('.play-user-message').nth(2), '𠮷客', null);
    await button(panel, '关闭面板').click(); await panel.waitFor({ state: 'detached' });
    await button(page, '打开小剧场面板').click(); await branch.locator('.play-user-message').nth(2).waitFor();
    await header(branch.locator('.play-user-message').first(), '茶客', 'user.png');
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, passed: true, checks: 'saved identity, version switch, target persona before completion, draft retained, deletion, missing/broken avatar, favorite and reopen', errors }));
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`, browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            const context = await browser.newContext({ viewport });
            await verify(await context.newPage(), url, viewport); await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
