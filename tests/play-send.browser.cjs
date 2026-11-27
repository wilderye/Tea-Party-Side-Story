const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (name === 'thumbnail') {
            response.setHeader('Content-Type', 'image/svg+xml');
            return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#739785"/></svg>');
        }
        if (!/^(?:[\w-]+\.(?:js|css)|vendor\/markdown-it\.js|assets\/[\w/-]+\.(?:svg|woff2))$/.test(name)) {
            response.statusCode = 404; return response.end();
        }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, name)));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function finishLatest(page, text) {
    await page.evaluate(text => { emitGeneration(text); finishGeneration(text); }, text);
    await page.waitForFunction(() => runtime.getStates().length === 0);
    await settle(page);
}
async function verify(page, url, viewport) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url); await page.waitForFunction(() => window.ready);
    await page.evaluate(() => { ctx.shouldSendOnEnter = () => true; });
    assert.equal(page.url(), url);
    assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(), 0);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    await panel.getByRole('button', { name: '剧场演出', exact: true }).filter({ visible: true }).click();
    const originalId = await page.evaluate(() => seed.hidden);
    const record = panel.locator(`[data-record="${originalId}"]`);
    await record.waitFor(); await settle(page);
    const input = panel.locator('.play-compose-input').filter({ visible: true });
    const send = panel.locator('.play-send').filter({ visible: true });
    assert.equal(await send.isDisabled(), true);
    const remove = record.getByRole('button', { name: '删除 AI 消息', exact: true });
    if (!await remove.isVisible()) await record.getByRole('button', { name: '更多回复操作', exact: true }).click();
    await remove.click();
    await page.waitForFunction(id => runtime.session.currentChat(id)?.messages.at(-1)?.role === 'user', originalId);
    await settle(page);
    assert.equal(await send.isEnabled(), true);
    assert.equal(await input.inputValue(), '');
    const originalUser = await page.evaluate(async id => (await runtime.getChat(id)).messages.at(-1), originalId);
    await screenshot(page, `send-user-tail-${viewport.width}.png`);
    await send.click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    assert.equal(await page.evaluate(() => capturedPrompts.at(-1)), originalUser.text);
    assert.equal(await send.getAttribute('aria-label'), '停止所有生成');
    await finishLatest(page, '原用户消息得到的新回复');
    const answered = await page.evaluate(async id => {
        await runtime.session.flush(id); return runtime.getChat(id);
    }, originalId);
    assert.deepEqual(answered.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(answered.messages[0], originalUser);
    assert.equal(await send.isDisabled(), true);

    const createBranch = record.getByRole('button', { name: '创建分支', exact: true });
    if (!await createBranch.isVisible()) await record.getByRole('button', { name: '更多回复操作', exact: true }).click();
    await createBranch.click();
    const branch = panel.locator('.play-branch-page').filter({ visible: true });
    await branch.locator('[data-message-id]').first().waitFor(); await settle(page);
    const branchId = await page.evaluate(async id => {
        const source = await runtime.getChat(id);
        return (await runtime.listChats(source.characterId)).find(row => row.branched).id;
    }, originalId);
    const branchInput = branch.getByRole('textbox', { name: '分支聊天输入', exact: true });
    const branchSend = branch.locator('.play-send');
    const beforeAI = await page.evaluate(id => runtime.getChat(id), branchId);
    assert.equal(await branchSend.isEnabled(), true);
    await branchInput.press('Control+Enter');
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    assert.equal(await page.evaluate(() => capturedPrompts.at(-1)), undefined);
    await finishLatest(page, '继续剧情的新 AI 楼层');
    const afterAI = await page.evaluate(async id => {
        await runtime.session.flush(id); return runtime.getChat(id);
    }, branchId);
    assert.deepEqual(afterAI.messages.map(message => message.role), ['user', 'assistant', 'assistant']);
    assert.deepEqual(afterAI.messages.slice(0, 2), beforeAI.messages);
    assert.equal(afterAI.messages[2].results[0].text, '继续剧情的新 AI 楼层');

    await page.evaluate(async id => {
        const current = await runtime.getChat(id);
        await runtime.truncateChat(id, current.messages[1].id, current.revision);
    }, branchId);
    await page.waitForFunction(() => [...document.querySelectorAll('.play-branch-page [data-message-id]')].length === 1);
    const branchUser = await page.evaluate(async id => (await runtime.getChat(id)).messages[0], branchId);
    assert.equal(await branchInput.inputValue(), '');
    assert.equal(await branchSend.isEnabled(), true);
    await branchSend.click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    assert.equal(await page.evaluate(() => capturedPrompts.at(-1)), branchUser.text);
    await page.evaluate(() => emitGeneration('第一版正在生成'));
    const latest = branch.locator('.play-assistant-message').last();
    await latest.getByRole('button', { name: '生成新版本', exact: true }).click();
    await page.waitForFunction(() => runtime.getStates().length === 2 && captured.length === 4);
    await page.evaluate(() => emitGeneration('同一条回复的第二版正在生成'));
    await page.evaluate(async id => {
        const current = await runtime.getChat(id), card = ctx.characters[0];
        void runtime.send({ characterId: current.characterId, character: { avatar: card.avatar, name: card.name }, prompt: '同时生成的演出' });
    }, branchId);
    await page.waitForFunction(() => runtime.getStates().length === 3 && captured.length === 5);
    await branchInput.fill('保留在输入框里的下一条草稿');
    assert.equal(await branchSend.getAttribute('aria-label'), '停止所有生成');
    await branchInput.press('Control+Enter'); await branchInput.press('Enter'); await settle(page);
    assert.equal(await page.evaluate(() => runtime.getStates().length), 3);
    assert.equal(await page.evaluate(() => captured.length), 5);
    assert.equal(await branchInput.inputValue(), '保留在输入框里的下一条草稿');
    await screenshot(page, `branch-global-stop-${viewport.width}.png`);
    await branchSend.click();
    await page.waitForFunction(() => runtime.getStates().length === 0);
    const stopped = await page.evaluate(async id => {
        await runtime.session.flush(id); return runtime.getChat(id);
    }, branchId);
    assert.deepEqual(stopped.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(stopped.messages[0], branchUser);
    assert.equal(stopped.messages[1].results.length, 2);
    assert.ok(stopped.messages[1].results.every(result => result.status === 'stopped'));

    await branch.getByRole('button', { name: '关闭聊天页面', exact: true }).click();
    await panel.locator('.play-record').filter({ visible: true }).last().waitFor(); await settle(page);
    await page.evaluate(async id => {
        const current = await runtime.getChat(id), card = ctx.characters[0];
        void runtime.replyToLastMessage(id, { chatMode: true, characterId: current.characterId,
            character: { avatar: card.avatar, name: card.name } });
    }, branchId);
    await page.waitForFunction(() => runtime.getStates().length === 1 && captured.length === 6);
    await settle(page);
    assert.equal(await send.getAttribute('aria-label'), '停止所有生成');
    await input.fill('生成期间发送新的独立小剧场');
    assert.equal(await send.getAttribute('aria-label'), '发送小剧场');
    assert.equal(await send.isEnabled(), true);
    await send.click();
    await page.waitForFunction(() => runtime.getStates().length === 2 && captured.length === 7);
    await page.evaluate(() => emitGeneration('独立小剧场正在生成'));
    await settle(page);
    assert.equal(await input.inputValue(), '');
    assert.equal(await send.getAttribute('aria-label'), '停止所有生成');
    const geometry = await send.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return { visible: bounds.width > 0 && bounds.height > 0 && bounds.left >= 0
            && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1,
            bounds: bounds.toJSON(), viewport: { width: innerWidth, height: innerHeight } };
    });
    await screenshot(page, `theatre-global-stop-${viewport.width}.png`);
    assert.equal(geometry.visible, true, JSON.stringify(geometry));
    await send.click();
    await page.waitForFunction(() => runtime.getStates().length === 0);
    assert.equal(await send.isDisabled(), true);
    await settle(page);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: 'Edge', browserPlugin: 'absent', fallback: 'Browser plugin not available',
        url, viewport, requests: 7, pageIdentity: 'pass', meaningfulPage: 'pass', frameworkOverlay: 'absent',
        consoleErrors: 0, controlsVisible: true, checks: '空框回答用户、空框新增AI、无重复用户消息、多版本并行、生成中回车无动作、两个页面共同总停止、演出并发发送' }));
}

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/`;
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
            const page = await browser.newPage({ viewport });
            await verify(page, url, viewport); await page.close();
        }
    } finally { await browser?.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
