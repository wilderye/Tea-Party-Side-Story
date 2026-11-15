const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: originalHarness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = originalHarness.replace('const runtime=window.runtime=', `
window.generationTasks=[];window.diagnosticErrors=[];
const diagnostics={error(operation,error){diagnosticErrors.push({operation,message:error.message});},info(){},warn(){},start(){return{update(){},finish(){}};}};
const runtime=window.runtime=`).replace('{loadRegex:async()=>engine,', '{loadRegex:async()=>engine,diagnostics,')
    .replace('prepareRequest:async request=>{', 'prepareRequest:window.testPreparer=async request=>{')
    .replace('window.emitGeneration=onText;window.finishGeneration=resolve;',
        'generationTasks.push({resultId:request.generationId,prompt:request.prompt,onText,finish:resolve,signal});')
    .replace('playground:runtime,promptFavorites});', 'playground:runtime,promptFavorites,diagnostics});')
    .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">');
assert.notEqual(harness, originalHarness);
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
const panelFor = page => page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
const button = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function setup(page, url) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    assert.equal(await page.evaluate(() => matchMedia('(max-width: 760px)').matches), page.viewportSize().width < 760);
    await button(page, '打开小剧场面板').click();
    const panel = panelFor(page);
    assert.match(await panel.innerText(), /茶话会/);
    await button(panel, '剧场演出').click();
    await panel.locator('.play-page .play-assistant-message').first().waitFor(); await settle(page);
    return panel;
}
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function verifyReturn(page, url, branched) {
    const panel = await setup(page, url);
    const mainChat = await page.evaluate(() => structuredClone(ctx.chat));
    const id = await page.evaluate(async branched => {
        let chat;
        const startedAt = new Date().toISOString(), resultId = crypto.randomUUID();
        const round = await testHistory.begin({ character: ctx.characters[0], prompt: '长聊天的起始用户消息', resultId, startedAt,
            context: { chatId: 'A-main', apiMode: 'tavern', characterName: '测试甲', userName: '茶客' } });
        await testHistory.saveResult(round.id, resultId, { text: '长聊天的起始回复', status: 'complete', finishedAt: startedAt });
        chat = branched ? await runtime.createBranch(round.id, (await testHistory.getChat(round.id)).messages[1].id)
            : await testHistory.getChat(round.id);
        for (let index = 0; index < 14; index++) {
            const resultId = crypto.randomUUID(), stamp = new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString();
            await testHistory.begin({ roundId: chat.id, chatMode: true, operation: 'send', character: ctx.characters[0],
                prompt: `后续用户消息 ${index}`, resultId, startedAt: stamp, context: chat.messages[1].results[0].context });
            await testHistory.saveResult(chat.id, resultId, { text: `后续回复 ${index}`, status: 'complete', finishedAt: stamp });
        }
        fixture.community.set('synthetic-entry', { id: 'synthetic-entry', title: '切换验证剧场', type: 'standalone',
            body: '选集中的虚构提示词', author: '合成作者', publishedAt: '2026-01-01' });
        window.returnChatId = chat.id;
        return chat.id;
    }, branched);
    await button(panel, '历史记录').click();
    await panel.locator(`[data-chat-id="${id}"] .play-history-open`).click();
    const chatPage = panel.locator('.play-branch-page');
    const chatInput = chatPage.getByRole('textbox', { name: '分支聊天输入', exact: true });
    await chatInput.waitFor(); await settle(page);
    assert.equal(await page.evaluate(() => runtime.session.currentRound(returnChatId).results[0].text), undefined);
    await chatInput.fill('历史聊天中的一次发送'); await chatPage.locator('.play-send').click();
    await page.waitForFunction(() => generationTasks.length === 1);
    await page.evaluate(() => { generationTasks[0].onText('历史聊天的完整虚构回复'); generationTasks[0].finish('历史聊天的完整虚构回复'); });
    await page.waitForFunction(() => runtime.getStates().length === 0 && !runtime.session.hasUnsaved());
    await button(panel, '茶会选集').click(); await button(panel, '在插件中游玩').click();
    const input = panel.locator('.play-page').getByRole('textbox', { name: '小剧场提示词', exact: true });
    await input.waitFor(); assert.equal(await input.inputValue(), '选集中的虚构提示词');
    await panel.locator('.play-page .play-send').click();
    await page.waitForFunction(() => generationTasks.length === 2); await settle(page);
    assert.equal(await input.inputValue(), '', '已接收的文字及时清空');
    assert.equal(await page.evaluate(() => runtime.getStates().length), 1, '一次点击只新增一份独立生成');
    if (!branched) {
        await panel.locator(`[data-record="${id}"]`).getByText('长聊天的起始回复', { exact: true }).waitFor();
        await panel.locator(`[data-record="${id}"]`).getByText('长聊天的起始用户消息', { exact: true }).waitFor();
    }
    await input.fill('第二份独立提示词'); await panel.locator('.play-page .play-send').click();
    await page.waitForFunction(() => generationTasks.length === 3); await settle(page);
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.evaluate(() => runtime.getStates().length), 2);
    assert.equal(await page.evaluate(() => generationTasks[1].signal.aborted), false, '发送新剧场不停止上一份');
    await page.evaluate(() => { generationTasks[1].onText('第一份在新发送后仍然更新'); generationTasks[2].onText('第二份独立更新'); });
    await panel.getByText('第一份在新发送后仍然更新', { exact: true }).waitFor();
    await panel.getByText('第二份独立更新', { exact: true }).waitFor();
    await screenshot(page, `history-return-${branched ? 'branch' : 'chat'}-${page.viewportSize().width}.png`);
    await input.fill('生成期间新写的草稿');
    await page.evaluate(() => { generationTasks[2].finish('第二份完整回复'); generationTasks[1].finish('第一份完整回复'); });
    await page.waitForFunction(() => runtime.getStates().length === 0 && !runtime.session.hasUnsaved());
    assert.equal(await input.inputValue(), '生成期间新写的草稿', '后续生成和保存不清空新草稿');
    assert.deepEqual(await page.evaluate(() => capturedPrompts.slice(-2)), ['选集中的虚构提示词', '第二份独立提示词']);
    assert.deepEqual(await page.evaluate(() => ctx.chat), mainChat);
    assert.deepEqual(await page.evaluate(() => diagnosticErrors), []);
}
async function verifyAcceptedInput(page, url) {
    const panel = await setup(page, url), input = panel.locator('.play-page').getByRole('textbox', { name: '小剧场提示词', exact: true });
    await page.evaluate(() => {
        const process = runtime.display.process;
        window.failedDisplay = false;
        runtime.display.process = function(text, ...args) {
            if (text === '已接收但显示暂时失败' && !failedDisplay) { failedDisplay = true; throw Error('模拟单条消息显示失败'); }
            return process.call(this, text, ...args);
        };
    });
    await input.fill('已接收但显示暂时失败'); await panel.locator('.play-page .play-send').click();
    await page.waitForFunction(() => generationTasks.length === 1 && failedDisplay); await settle(page);
    assert.equal(await input.inputValue(), '', '单条消息显示失败也不留下已经接收的文字');
    assert.equal(await page.evaluate(() => generationTasks.length), 1);
    await input.fill('后写的草稿');
    await page.evaluate(() => generationTasks[0].finish('正常完成的虚构回复'));
    await page.waitForFunction(() => runtime.getStates().length === 0 && !runtime.session.hasUnsaved());
    await panel.getByText('正常完成的虚构回复', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '后写的草稿');
    assert.deepEqual(await page.evaluate(() => diagnosticErrors.map(error => error.message)), ['模拟单条消息显示失败']);
}
async function verifyDraftPreservation(page, url) {
    const panel = await setup(page, url), input = panel.locator('.play-page').getByRole('textbox', { name: '小剧场提示词', exact: true });
    await input.fill('进入选集前的草稿');
    await page.evaluate(() => fixture.community.set('draft-entry', { id: 'draft-entry', title: '草稿验证剧场', type: 'standalone',
        body: '选集中选中的提示词', author: '合成作者', publishedAt: '2026-01-01' }));
    await button(panel, '茶会选集').click(); await button(panel, '在插件中游玩').click();
    assert.equal(await input.inputValue(), '选集中选中的提示词');
    await panel.locator('.play-page .play-send').click(); await page.waitForFunction(() => generationTasks.length === 1);
    assert.equal(await input.inputValue(), '进入选集前的草稿', '发送选集内容后仍按原规则恢复原草稿');
    await page.evaluate(() => generationTasks[0].finish('第一份虚构回复'));
    await page.waitForFunction(() => runtime.getStates().length === 0 && !runtime.session.hasUnsaved());
    await page.evaluate(() => { testPreparer.resolveContext = () => new Promise(resolve => { window.releaseAcceptance = () => resolve({ context: {} }); }); });
    await input.fill('准备中已点击的提示词'); await panel.locator('.play-page .play-send').click();
    await page.waitForFunction(() => typeof releaseAcceptance === 'function');
    assert.equal(await input.inputValue(), '准备中已点击的提示词', '尚未接收时保留待发送文字');
    await input.fill('等待时新写的草稿'); await page.evaluate(() => releaseAcceptance());
    await page.waitForFunction(() => generationTasks.length === 2);
    assert.equal(await input.inputValue(), '等待时新写的草稿', '迟到的接收通知不清空后来修改的草稿');
    await page.evaluate(() => generationTasks[1].finish('第二份虚构回复'));
    await page.waitForFunction(() => runtime.getStates().length === 0 && !runtime.session.hasUnsaved());
    assert.equal(await input.inputValue(), '等待时新写的草稿');
    assert.deepEqual(await page.evaluate(() => capturedPrompts), ['选集中选中的提示词', '准备中已点击的提示词']);
    assert.deepEqual(await page.evaluate(() => diagnosticErrors), []);
}
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/`;
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
            for (const scenario of ['chat', 'branch', 'display-failure', 'drafts']) {
                const context = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
                const page = await context.newPage(), errors = [];
                page.setDefaultTimeout(10000);
                page.on('pageerror', error => errors.push(error.message));
                page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
                if (scenario === 'display-failure') await verifyAcceptedInput(page, url);
                else if (scenario === 'drafts') await verifyDraftPreservation(page, url);
                else await verifyReturn(page, url, scenario === 'branch');
                assert.deepEqual(errors, []);
                console.log(JSON.stringify({ viewport, scenario, errors }));
                await context.close();
            }
        }
    } finally { await browser?.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
