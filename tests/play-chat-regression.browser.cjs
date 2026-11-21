// Browser plugin not available. Edge/Playwright uses synthetic history only.
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
        if (!/^(?:[\w-]+\.(?:js|css)|vendor\/markdown-it\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(name)) {
            response.statusCode = 404; return response.end();
        }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2'
            : name.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, name)));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const button = (panel, name) => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function openPanel(page, url) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.match(await page.title(), /小剧场/);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    assert.match(await panel.innerText(), /茶话会/);
    return panel;
}
async function history(page, panel) {
    await button(panel, '剧场演出').click(); await panel.locator('[data-record]').first().waitFor();
    await button(panel, '历史记录').click(); await panel.locator('.play-history-row').first().waitFor();
}
async function verifyLateReads(page, url) {
    const panel = await openPanel(page, url); await history(page, panel);
    await page.evaluate(() => {
        const original = runtime.listCharacters; let first = true;
        runtime.listCharacters = async (...args) => {
            if (first) { first = false; window.readHeld = true; await new Promise(resolve => window.releaseRead = resolve); }
            return original(...args);
        };
    });
    const id = await page.evaluate(() => seed.a);
    await panel.locator(`[data-chat-id="${id}"] .play-history-open`).click(); await page.waitForFunction(() => window.readHeld);
    const people = panel.locator('.play-chat-catalog .play-people');
    await people.getByRole('button', { name: '测试乙', exact: true }).click();
    await panel.locator('.play-history-directory').getByText('乙的旧记录 乙的规则', { exact: true }).waitFor();
    await page.evaluate(() => window.releaseRead()); await settle(page);
    assert.equal(await people.locator('[aria-pressed="true"]').getAttribute('aria-label'), '测试乙');
    assert.equal(await panel.locator('.play-history-directory').isVisible(), true);
    await screenshot(page, 'branch-late-read-fixed.png');

    // Returning to history must also invalidate an in-flight chat open.
    await page.evaluate(() => {
        const original = runtime.getChatWindow; let first = true;
        runtime.getChatWindow = async (...args) => {
            if (first) { first = false; window.chatHeld = true; await new Promise(resolve => window.releaseChat = resolve); }
            return original(...args);
        };
    });
    await panel.locator('.play-history-open').first().click(); await page.waitForFunction(() => window.chatHeld);
    await button(panel, '历史记录').click(); await page.evaluate(() => window.releaseChat()); await settle(page);
    assert.equal(await panel.locator('.play-history-directory').isVisible(), true);
    assert.equal(await people.locator('[aria-pressed="true"]').getAttribute('aria-label'), '测试乙');

    // Closing the panel must not discard the requested destination.
    await page.evaluate(() => {
        const original = runtime.getChatWindow; let first = true;
        window.chatHeld = false;
        runtime.getChatWindow = async (...args) => {
            if (first) { first = false; window.chatHeld = true; await new Promise(resolve => window.releaseChat = resolve); }
            return original(...args);
        };
    });
    await panel.locator('.play-history-open').first().click(); await page.waitForFunction(() => window.chatHeld);
    await button(panel, '关闭面板').click(); await panel.waitFor({ state: 'detached' });
    await page.evaluate(() => window.releaseChat()); await settle(page);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await panel.locator('.play-branch-page').getByText('乙的旧记录 乙的规则', { exact: true }).waitFor();
}
async function verifyWebState(page, url, mobile) {
    const panel = await openPanel(page, url); await history(page, panel);
    const id = await page.evaluate(() => seed.a);
    await panel.locator(`[data-chat-id="${id}"] .play-history-open`).click();
    const branch = panel.locator('.play-branch-page'); await branch.locator('.play-assistant-message').first().waitFor();
    await page.evaluate(async () => {
        const chat = await runtime.getChat(seed.a), assistant = chat.messages[1], result = assistant.results[0];
        await runtime.editMessage(chat.id, assistant.id, { resultId: result.id, expectedText: result.text,
            text: '<!doctype html><html><body><button onclick="this.textContent=Number(this.textContent)+1">0</button></body></html>' });
        ui.refresh();
    });
    const frame = branch.frameLocator('iframe.play-web-output'); await frame.getByRole('button', { name: '0', exact: true }).click();
    await frame.getByRole('button', { name: '1', exact: true }).waitFor();
    const user = branch.locator('.play-user-message').first();
    const editScope = page.viewportSize().width <= 760 ? panel.locator('.play-edit-sheet') : user;
    await user.getByRole('button', { name: '修改用户消息', exact: true }).click();
    await editScope.getByRole('button', { name: '取消', exact: true }).click();
    await frame.getByRole('button', { name: '1', exact: true }).waitFor();
    await user.getByRole('button', { name: '修改用户消息', exact: true }).click();
    await editScope.getByRole('textbox', { name: '用户消息原文', exact: true }).fill('修改后的虚构用户消息');
    await editScope.getByRole('button', { name: '保存', exact: true }).click();
    await user.getByText('修改后的虚构用户消息', { exact: true }).waitFor();
    await frame.getByRole('button', { name: '1', exact: true }).waitFor();
    await button(branch, '聊天操作').click(); await button(branch, '删除').click();
    await button(branch, '取消').click(); await frame.getByRole('button', { name: '1', exact: true }).waitFor();
    await page.evaluate(() => ui.refresh()); await settle(page);
    await frame.getByRole('button', { name: '1', exact: true }).waitFor();
    await screenshot(page, `branch-web-state-${mobile ? 'mobile' : 'desktop'}.png`);
}
async function verifyUserMessageRendering(page, url) {
    const prompt = '{{user}} 对 <user> 说话。{{char}} 与 <char>。\n\n{{USER}} / <USER> / {{CHAR}} / <CHAR>\n\n<story>标签内容</story>\n\n{{other}} 和 <character> 保留。\n\n规则：人设标记';
    const aiText = 'AI 消息：{{user}} 与 {{char}}。';
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.match(await page.title(), /小剧场/);
    const ids = await page.evaluate(async ({ prompt, aiText }) => {
        const round = await runtime.getRound(seed.a);
        await testHistory.editPrompt(round.id, prompt, round.prompt);
        await testHistory.editResult(round.id, round.results[0].id, aiText, round.results[0].text);
        ctx.name1 = '当前人设';
        rules.globalRules.push({ id: 'user-display', scriptName: '合成用户显示规则', findRegex: '人设标记', replaceString: '{{user}}/{{char}}',
            placement: [1], minDepth: null, maxDepth: null, markdownOnly: true, trimStrings: [] });
        await runtime.display.refresh(ctx.characters[0]);
        const source = await runtime.getChat(seed.a), branch = await runtime.createBranch(source.id, source.messages[1].id);
        const ai = branch.messages[1], first = ai.results[0], secondId = crypto.randomUUID();
        await testHistory.begin({ roundId: branch.id, chatMode: true, operation: 'another', messageId: ai.id,
            character: ctx.characters[0], resultId: secondId, startedAt: '2026-01-02T00:00:00Z',
            context: { ...first.context, userName: '后来的茶客', userAvatar: 'second-user.png' } });
        await testHistory.saveResult(branch.id, secondId, { text: aiText, status: 'complete', finishedAt: '2026-01-02T00:00:01Z' });
        await testHistory.setMessageVersion(branch.id, ai.id, first.id, secondId);
        return { sourceId: source.id, branchId: branch.id, bodyRevision: branch.messages[0].bodyRevision, mainChat: structuredClone(ctx.chat) };
    }, { prompt, aiText });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator('.tea-panel-surface[data-active=true]');
    await button(panel, '剧场演出').click();
    const record = panel.locator(`[data-record="${ids.sourceId}"]`);
    await record.locator('.play-user-text').getByText('规则：茶客/测试甲', { exact: true }).waitFor();
    const recordText = await record.locator('.play-user-text').innerText();
    await button(panel, '历史记录').click();
    await panel.locator(`[data-chat-id="${ids.branchId}"] .play-history-open`).click();
    const branch = panel.locator('.play-branch-page[aria-hidden=false]'), user = branch.locator('.play-user-message').first();
    await user.locator('.play-user-text').getByText('规则：茶客/测试甲', { exact: true }).waitFor();
    assert.equal(await user.locator('.play-user-text').innerText(), recordText);
    assert.match(recordText, /茶客 对 茶客 说话。测试甲 与 测试甲。/);
    assert.match(recordText, /茶客 \/ 茶客 \/ 测试甲 \/ 测试甲/);
    assert.ok(recordText.includes('<story>标签内容</story>'));
    assert.ok(recordText.includes('{{other}} 和 <character> 保留。'));
    assert.equal(await branch.locator('.play-assistant-message .play-results').innerText(), aiText);
    assert.equal(await user.locator('iframe').count(), 0);
    await branch.locator('.play-assistant-message [data-chat-action=next]').click();
    await user.locator('.play-speaker').getByText('后来的茶客', { exact: true }).waitFor();
    await user.locator('.play-user-text').getByText('规则：后来的茶客/测试甲', { exact: true }).waitFor();
    assert.ok((await user.locator('.play-user-text').innerText()).includes('后来的茶客 对 后来的茶客 说话。'));
    await screenshot(page, `branch-user-names-${page.viewportSize().width}.png`);
    await branch.locator('.play-assistant-message [data-chat-action=previous]').click();
    await user.locator('.play-speaker').getByText('茶客', { exact: true }).waitFor();
    await user.locator('.play-user-text').getByText('规则：茶客/测试甲', { exact: true }).waitFor();
    assert.equal(await user.locator('.play-user-text').innerText(), recordText);
    await user.getByRole('button', { name: '修改用户消息', exact: true }).click();
    const editScope = page.viewportSize().width <= 760 ? panel.locator('.play-edit-sheet') : user;
    const editor = editScope.getByRole('textbox', { name: '用户消息原文', exact: true });
    await editor.waitFor(); assert.equal(await editor.inputValue(), prompt);
    await editScope.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await user.locator('.play-user-text').innerText(), recordText);
    const stored = await page.evaluate(async id => ({ chat: await runtime.getChat(id), mainChat: ctx.chat }), ids.branchId);
    assert.equal(stored.chat.messages[0].text, prompt);
    assert.equal(stored.chat.messages[0].bodyRevision, ids.bodyRevision);
    assert.deepEqual(stored.mainChat, ids.mainChat);
}
async function verifyCatalog(page, url) {
    const panel = await openPanel(page, url);
    await page.evaluate(() => {
        for (let i = 0; i < 28; i++) ctx.characters.push({ avatar: `synthetic-${i}.png`, name: `虚构角色${i}` });
    });
    await button(panel, '剧场演出').click(); await panel.locator('[data-record]').first().waitFor(); await settle(page);
    const playPages = await panel.locator('.play-catalog:not(.play-chat-catalog) .tea-page-total').innerText();
    await button(panel, '历史记录').click(); await panel.locator('.play-history-row').first().waitFor(); await settle(page);
    assert.equal(await panel.locator('.play-chat-catalog .tea-page-total').innerText(), playPages);
    const people = panel.locator('.play-chat-catalog .play-people');
    const search = panel.locator('.play-chat-catalog').getByRole('searchbox', { name: '搜索角色', exact: true });
    await search.fill('虚构角色27'); await people.getByRole('button', { name: '虚构角色27', exact: true }).waitFor();
    await people.getByRole('button', { name: '虚构角色27', exact: true }).click();
    await panel.getByText('这个角色还没有演出记录。', { exact: true }).waitFor();
    assert.equal(await people.locator('[aria-pressed="true"]').getAttribute('aria-label'), '虚构角色27');
    await search.fill(''); await page.waitForFunction(() => document.querySelectorAll('.play-chat-catalog .play-person').length > 1);
    await page.setViewportSize({ width: 1332, height: 640 }); await settle(page);
    const dimensions = await people.evaluate(node => ({ height: node.clientHeight, scrollHeight: node.scrollHeight }));
    assert.ok(dimensions.scrollHeight <= dimensions.height + 1, '缩小窗口后重新计算页数，角色不被遮住');
    await screenshot(page, 'branch-catalog-resized.png');
    await page.setViewportSize({ width: 390, height: 844 }); await settle(page);
    await button(panel, '选择角色').click();
    await search.fill('虚构角色27'); await people.getByRole('button', { name: '虚构角色27', exact: true }).waitFor();
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await screenshot(page, 'branch-catalog-mobile.png');
}
async function verifyFavoriteFailure(page, url) {
    const panel = await openPanel(page, url);
    await page.evaluate(async () => {
        await runtime.favoriteChat(seed.a);
        const chat = await runtime.getChat(seed.a), user = chat.messages[0];
        await runtime.editMessage(chat.id, user.id, { text: '更新后的虚构收藏消息', expectedText: user.text });
        window.failSave = true;
    });
    await button(panel, '我的收藏').click(); await button(panel, '演出记录').click();
    const content = panel.locator('.play-favorite-content');
    await content.getByText('测试小剧场', { exact: true }).waitFor();
    await button(panel, '重试更新收藏').waitFor();
    assert.match(await panel.innerText(), /正在显示已保存的内容/);
    await screenshot(page, 'branch-favorite-update-failed.png');
    await page.evaluate(() => window.failSave = false); await button(panel, '重试更新收藏').click();
    await content.getByText('更新后的虚构收藏消息', { exact: true }).waitFor();
    assert.equal(await button(panel, '重试更新收藏').count(), 0);
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const [name, verify, viewport] of [
            ['late reads', verifyLateReads, { width: 1332, height: 896 }],
            ['web state desktop', (page, url) => verifyWebState(page, url, false), { width: 1332, height: 896 }],
            ['web state mobile', (page, url) => verifyWebState(page, url, true), { width: 390, height: 844 }],
            ['user message rendering desktop', verifyUserMessageRendering, { width: 1332, height: 896 }],
            ['user message rendering mobile', verifyUserMessageRendering, { width: 390, height: 844 }],
            ['catalog', verifyCatalog, { width: 1332, height: 896 }],
            ['favorite failure', verifyFavoriteFailure, { width: 1332, height: 896 }],
        ]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await verify(page, url);
            assert.deepEqual(errors, []);
            assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
            console.log(JSON.stringify({ name, viewport, passed: true, errors }));
            await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
