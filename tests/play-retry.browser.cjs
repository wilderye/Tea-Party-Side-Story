// Browser plugin not available. Playwright/Edge uses synthetic characters,
// settings, history and HTTP replies; no real Tavern profile is accessed.
// Flow: settings -> retry switches/numbers -> send -> countdown -> retry or stop.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: originalHarness } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = originalHarness.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace("import {createTheatrePanel} from '/panel.js';", `import {createTheatrePanel} from '/panel.js';
import {createPreparedPlayRequest} from '/play-request.js';
import {createDiagnostics} from '/diagnostics.js';
const diagnostics=window.diagnostics=createDiagnostics({storage:localStorage});`)
    .replace(/prepareRequest:async request=>\{window\.captured\.push\(request\.environment\);[\s\S]*?\}\}\}\);/, `
diagnostics,prepareRequest:async request=>{
    window.captured.push(request.environment);window.capturedPrompts.push(request.prompt);
    ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
    ctx.extractMessageFromData=data=>data.text;
    return createPreparedPlayRequest(ctx,{messages:[{role:'user',content:request.prompt}],
        model:'synthetic-model',chat_completion_source:request.environment.api.mode==='custom'?'custom':'openai',stream:false},
        {prefix:request.continueMessage,continueExtra:request.continueExtra,reasoning:{extractReasoningFromData:data=>data.thought||''}});
}});`)
    .replace('{...libraryActions,playground:runtime,promptFavorites}', '{...libraryActions,playground:runtime,promptFavorites,diagnostics}');
assert.notEqual(harness, originalHarness);
assert.ok(harness.includes('return createPreparedPlayRequest'));
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});

async function verify(page, url, viewport) {
    const calls = [];
    let responses = [];
    await page.route('**/api/backends/chat-completions/generate', async route => {
        calls.push({ body: route.request().postData(), at: Date.now() });
        const next = responses.shift() || { status: 429, json: { error: { message: 'synthetic rate limit', code: 429 } } };
        await route.fulfill(next);
    });
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const retry = panel.locator('.play-retry-settings');
    const rateLimit = retry.getByRole('checkbox', { name: '429 时重试', exact: true });
    const empty = retry.getByRole('checkbox', { name: '空内容时重试', exact: true });
    const maxRetries = retry.getByRole('spinbutton', { name: '自动重试次数', exact: true });
    const interval = retry.getByRole('spinbutton', { name: '重试间隔（秒）', exact: true });
    const input = panel.getByRole('textbox', { name: '小剧场提示词', exact: true });
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('processingSettings')).playRetry);
    const idle = () => page.waitForFunction(() => runtime.getStates().length === 0);
    const openSettings = async () => { await button('设置').click(); await retry.scrollIntoViewIfNeeded(); };
    const closeSettings = () => button(viewport.width > 760 ? '设置' : '返回剧场演出').click();
    const send = async prompt => { await input.fill(prompt); await button('发送小剧场').click(); };
    const screenshot = async name => {
        if (!process.env.TEA_QA_DIR) return;
        await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `retry-${name}-${viewport.width}.png`) });
    };
    const latest = async () => page.evaluate(async () => {
        const rows = await runtime.listRounds((await runtime.listCharacters()).find(character => character.avatar === 'A.png').id);
        return runtime.getRound(rows.at(-1).id);
    });
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await button('剧场演出').click(); await openSettings();
    assert.equal(await rateLimit.isChecked(), false); assert.equal(await empty.isChecked(), false);
    assert.equal(await maxRetries.inputValue(), '3'); assert.equal(await interval.inputValue(), '2');
    const layout = await retry.evaluate(section => {
        const rect = node => {
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const group = section.parentElement;
        return { heading: group.querySelector('h3').textContent, next: group.nextElementSibling.querySelector('h3').textContent,
            descriptions: section.querySelectorAll('p').length,
            conditions: [...section.querySelectorAll('.play-retry-condition')].map(rect),
            numbers: [...section.querySelectorAll('.play-retry-number')].map(field => ({
                name: rect(field.firstChild), input: rect(field.querySelector('input')), unit: field.querySelector('.play-retry-unit').textContent,
            })) };
    });
    assert.equal(layout.heading, '自动重试'); assert.equal(layout.next, '插件日志'); assert.equal(layout.descriptions, 0);
    assert.equal(layout.conditions[0].y, layout.conditions[1].y, '两个重试条件组成同一行');
    const [count, spacing] = layout.numbers;
    assert.deepEqual(layout.numbers.map(field => field.unit), ['次', '秒']);
    assert.ok(layout.numbers.every(field => field.input.height === 36 && field.input.width === 72), '两端数字框均为72×36，不随页面宽度撑开');
    if (viewport.width > 760) {
        assert.ok(Math.abs(count.name.y + count.name.height / 2 - count.input.y - count.input.height / 2) <= 1);
        assert.ok(count.name.right < count.input.x && spacing.name.right < spacing.input.x, '电脑端名称在左，输入框在右');
        assert.equal(count.input.x, spacing.input.x, '两行数字框对齐');
        assert.ok(spacing.input.y >= count.input.bottom + 12, '电脑端两项上下排列');
        assert.ok(count.input.width <= 100, '短数字不占满页面宽度');
    } else {
        assert.ok(count.name.bottom + 7 <= count.input.y && spacing.name.bottom + 7 <= spacing.input.y, '手机端名称在上，输入框在下');
        assert.equal(count.input.y, spacing.input.y, '手机端两组并排且输入框对齐');
        assert.ok(count.input.right < spacing.input.x);
    }
    await screenshot('defaults');
    await rateLimit.check(); await empty.check(); await maxRetries.fill('2');
    assert.deepEqual(await saved(), { rateLimit: true, empty: true, maxRetries: 2, intervalSeconds: 2 });
    await maxRetries.fill('-1'); await interval.click(); assert.equal(await maxRetries.inputValue(), '2');
    await interval.fill(''); await rateLimit.click(); assert.equal(await interval.inputValue(), '2');
    await rateLimit.check();
    const bounds = await retry.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
        overflow: node.scrollWidth - node.clientWidth }));
    assert.ok(bounds.left >= 0 && bounds.right <= viewport.width && bounds.overflow <= 1);
    await screenshot('settings'); await closeSettings();

    responses = [{ status: 429, json: { error: { message: 'synthetic rate limit', code: 429 } } },
        { json: { text: '', thought: 'discarded thought' } }, { json: { text: '自动重试成功的正文' } }];
    await send('重试验证');
    await panel.getByText('遇到 429，2 秒后进行第 1/2 次自动重试。', { exact: true }).waitFor();
    await button('停止这份回复').waitFor();
    assert.equal(await button('停止所有生成').isEnabled(), true);
    await screenshot('countdown');
    await panel.getByText('遇到 429，1 秒后进行第 1/2 次自动重试。', { exact: true }).waitFor();
    await panel.getByText('遇到空内容，2 秒后进行第 2/2 次自动重试。', { exact: true }).waitFor();
    await idle(); await panel.getByText('自动重试成功的正文', { exact: true }).waitFor();
    assert.equal(calls.length, 3); assert.ok(calls.every(call => call.body === calls[0].body));
    assert.ok(calls[1].at - calls[0].at >= 1900 && calls[2].at - calls[1].at >= 1900);
    const round = await latest(); assert.equal(round.results.length, 1); assert.equal(round.results[0].status, 'complete');
    assert.equal(round.results[0].extra.reasoning, '');
    assert.equal(await page.evaluate(() => captured.length), 1);
    await screenshot('success');

    await send('停止等待');
    await panel.getByText('遇到 429，2 秒后进行第 1/2 次自动重试。', { exact: true }).waitFor();
    await button('停止这份回复').click(); await idle();
    await page.waitForTimeout(2100);
    assert.equal(calls.length, 4); assert.equal((await latest()).results[0].status, 'stopped');
    const timeline = await page.evaluate(() => diagnostics.export());
    assert.match(timeline, /开始第 2\/2 次自动重试/); assert.doesNotMatch(timeline, /discarded thought|自动重试成功的正文/);

    await openSettings(); await rateLimit.uncheck(); await interval.fill('0.1'); await closeSettings();
    await send('仅空内容重试'); await idle();
    assert.equal(calls.length, 5); assert.equal((await latest()).results[0].status, 'failed');
    responses = [{ json: { text: '' } }, { json: { text: '单独开启空内容重试成功' } }];
    await send('空内容单独开关'); await idle(); assert.equal(calls.length, 7);
    assert.equal((await latest()).results[0].text, '单独开启空内容重试成功');

    await openSettings(); await rateLimit.check(); await empty.uncheck(); await closeSettings();
    responses = [{ json: { text: '' } }]; await send('仅429重试'); await idle(); assert.equal(calls.length, 8);
    responses = [{ status: 429, json: { error: 'rate limited' } }, { json: { text: '单独开启429重试成功' } }];
    await send('429单独开关'); await idle(); assert.equal(calls.length, 10);

    await openSettings(); await empty.check(); await closeSettings();
    await send('次数用尽'); await idle();
    assert.equal(calls.length, 13); assert.match((await latest()).results[0].error.message, /已自动重试 2 次/);
    await panel.getByText('synthetic rate limit\n已自动重试 2 次。', { exact: true }).waitFor();
    await screenshot('exhausted');

    await page.reload(); await page.waitForFunction(() => window.ready);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await button('剧场演出').click(); await openSettings();
    assert.equal(await rateLimit.isChecked(), true); assert.equal(await empty.isChecked(), true);
    assert.equal(await maxRetries.inputValue(), '2'); assert.equal(await interval.inputValue(), '0.1');
    assert.equal(calls.length, 13, '刷新页面不恢复已结束的自动重试');
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
            const context = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            try {
                await verify(page, url, viewport);
                // Simulated HTTP429 requests intentionally produce browser HTTP errors.
                assert.deepEqual(errors.filter(message => !/Failed to load resource: the server responded with a status of 429/.test(message)), []);
                console.log(`PASS automatic retry ${viewport.width}x${viewport.height}: defaults, persistence, switches, shared limit, identical HTTP payload, countdown, stop and layout (${url})`);
            } finally { await context.close(); }
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
