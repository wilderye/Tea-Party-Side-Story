// Browser plugin not available. Use the existing Playwright/Edge workflow.
// Flow: settings -> toggle native reasoning -> choose mode -> persist -> continue.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://localhost').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});

async function verify(page, url, viewport) {
    const panel = page.locator('#teahouse-panel');
    const mode = panel.getByRole('combobox', { name: '续写方式', exact: true });
    const input = panel.getByRole('textbox', { name: '续写提示词', exact: true });
    const sendReasoning = panel.getByRole('switch', { name: '续写时发回原生思维链', exact: true });
    const error = panel.locator('.play-continue-error');
    const open = async () => {
        await page.waitForFunction(() => window.ready);
        assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
        await panel.getByRole('button', { name: '设置', exact: true }).filter({ visible: true }).click();
    };
    await page.goto(url); await open();
    assert.equal(await mode.inputValue(), 'history');
    assert.match(await input.inputValue(), /^Resume the preceding assistant reply/);
    assert.ok(!(await input.inputValue()).includes('{{lastChatMessage}}'));
    assert.equal(await sendReasoning.isChecked(), true, '默认保持原有发送行为');
    await sendReasoning.uncheck();
    assert.equal(await page.evaluate(() => fixture.settings.playContinueSendReasoning), false);
    await input.fill('第一种的测试指令');
    await mode.selectOption('prompt');
    assert.match(await input.inputValue(), /^Resume the reply provided below/);
    assert.ok((await input.inputValue()).includes('{{lastChatMessage}}'));
    await input.fill('第二种：缺少正文占位符');
    assert.equal(await error.isVisible(), true);
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    const rejected = await page.evaluate(async () => {
        const before = await runtime.getRound(seed.a);
        try { await runtime.continueResult(before.id, before.results[0].id); throw Error('应当拒绝'); }
        catch (error) {
            return { code: error.code, same: JSON.stringify(before) === JSON.stringify(await runtime.getRound(seed.a)), requests: captured.length };
        }
    });
    assert.deepEqual(rejected, { code: 'invalid_continue_prompt', same: true, requests: 0 });
    const second = '第二种的测试指令：\n{{lastChatMessage}}';
    await input.fill(second);
    assert.equal(await error.isVisible(), false); assert.equal(await input.getAttribute('aria-invalid'), 'false');
    await mode.selectOption('history'); assert.equal(await input.inputValue(), '第一种的测试指令');
    await mode.selectOption('prompt'); assert.equal(await input.inputValue(), second);
    await page.reload(); await open();
    assert.equal(await mode.inputValue(), 'prompt'); assert.equal(await input.inputValue(), second);
    assert.equal(await sendReasoning.isChecked(), false, '切换续写方式和刷新后仍保持关闭');
    await mode.selectOption('history'); assert.equal(await input.inputValue(), '第一种的测试指令');
    await mode.selectOption('prompt');
    await page.evaluate(async () => {
        const round = await runtime.getRound(seed.a), target = round.results[0];
        window.continueTask = runtime.continueResult(round.id, target.id);
        window.continueBase = target.text;
    });
    await page.waitForFunction(() => typeof window.finishGeneration === 'function');
    await page.evaluate(() => finishGeneration(continueBase + '\n测试续写正文'));
    const outcome = await page.evaluate(async () => {
        const result = await continueTask;
        return { text: result.result.text, continuation: captured.at(-1).continuation, phase: runtime.getState().phase };
    });
    assert.ok(outcome.text.endsWith('测试续写正文'));
    assert.deepEqual(outcome.continuation, { mode: 'prompt', prompt: second, sendReasoning: false }); assert.equal(outcome.phase, 'idle');
    await sendReasoning.check();
    await page.reload(); await open();
    assert.equal(await sendReasoning.isChecked(), true, '重新开启后保存设置');
    await input.scrollIntoViewIfNeeded();
    const bounds = await input.evaluate(node => {
        const rect = node.getBoundingClientRect(), section = node.closest('section');
        return { left: rect.left, right: rect.right, width: section.clientWidth, scrollWidth: section.scrollWidth };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= viewport.width);
    assert.ok(bounds.scrollWidth <= bounds.width + 1);
    await sendReasoning.scrollIntoViewIfNeeded();
    const toggleBounds = await sendReasoning.evaluate(node => {
        const label = node.closest('label'), rect = label.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: label.clientWidth, scrollWidth: label.scrollWidth };
    });
    assert.ok(toggleBounds.left >= 0 && toggleBounds.right <= viewport.width);
    assert.ok(toggleBounds.scrollWidth <= toggleBounds.width + 1);
    await page.screenshot({ path: path.join(os.tmpdir(), `teahouse-continue-${viewport.width}.png`) });
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            try {
                await verify(page, url, viewport);
                assert.deepEqual(errors, []);
                console.log(`PASS continuation ${viewport.width}x${viewport.height}: reasoning toggle, edit, persist, validate, continue and layout (${url})`);
            } finally { await context.close(); }
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
