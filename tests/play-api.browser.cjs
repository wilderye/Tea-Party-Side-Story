// Flow: settings -> independent API -> URL/key -> fetch -> select -> saved model.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
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
    const calls = [], gates = [];
    let reply = { data: [{ id: 'zeta-chat' }, { id: 'alpha-chat' }, { id: 'alpha-chat' }] }, gate;
    await page.route('**/api/backends/chat-completions/status', async route => {
        const request = route.request(), response = reply, wait = gate;
        assert.equal(request.headers()['x-csrf-token'], 'synthetic-model-test');
        calls.push(request.postDataJSON());
        if (wait) await wait.promise;
        if (!page.isClosed()) await route.fulfill({ json: response });
    });
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const fields = panel.locator('.play-api-fields');
    const mode = panel.getByRole('combobox', { name: '生成使用的 API', exact: true });
    const address = fields.getByRole('textbox', { name: '接口地址', exact: true });
    const key = fields.getByLabel('API 密钥', { exact: true });
    const models = fields.getByRole('combobox', { name: '模型', exact: true });
    const refresh = fields.getByRole('button', { name: '拉取模型', exact: true });
    const status = fields.getByRole('status');
    const savedApi = () => page.evaluate(() => JSON.parse(localStorage.getItem('processingSettings')).playApi);
    const options = () => models.locator('option:not([disabled])').evaluateAll(nodes => nodes.map(node => node.value));
    const start = async () => {
        const requested = page.waitForRequest('**/api/backends/chat-completions/status');
        await refresh.click(); await requested;
    };
    const finish = () => page.waitForFunction(() => document.querySelector('.play-api-model-refresh')?.getAttribute('aria-busy') === 'false');
    const open = async () => {
        await page.waitForFunction(() => window.ready);
        assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        await page.evaluate(() => { ctx.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-model-test' }); });
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
        await button('设置').click();
    };
    try {
        await page.goto(url); await open();
        await mode.selectOption('custom');
        assert.equal(await fields.locator('input').count(), 2, '只保留地址和密钥两个输入框');
        assert.equal(await fields.locator('input[aria-label="模型"]').count(), 0);
        assert.equal(await models.isDisabled(), true); assert.equal(await refresh.isDisabled(), true);
        await address.fill('https://example.invalid/v1/chat/completions');
        await key.fill('synthetic-test-key');
        assert.equal(calls.length, 0, '填写设置不会自动请求模型');

        gate = deferred(); gates.push(gate); await start();
        assert.equal(await refresh.isDisabled(), true); assert.equal(await models.isDisabled(), true);
        assert.equal(await status.innerText(), '正在拉取模型…');
        assert.equal(calls[0].custom_url, 'https://example.invalid/v1');
        assert.deepEqual(JSON.parse(calls[0].custom_include_headers), { Authorization: 'Bearer synthetic-test-key' });
        gate.resolve(); gate = null; await finish();
        assert.deepEqual(await options(), ['alpha-chat', 'zeta-chat']);
        assert.equal(await models.inputValue(), '', '拉取后由用户选择模型');
        await models.selectOption('zeta-chat'); assert.equal((await savedApi()).model, 'zeta-chat');
        await mode.selectOption('tavern'); assert.equal(await fields.isVisible(), false);
        await mode.selectOption('custom'); assert.equal(await models.inputValue(), 'zeta-chat');
        await page.evaluate(() => ui.refresh());
        assert.deepEqual(await options(), ['alpha-chat', 'zeta-chat'], '设置重新显示时保留模型列表');

        await fields.scrollIntoViewIfNeeded();
        const bounds = await fields.locator('.play-api-model-row').evaluate(node => {
            const row = node.getBoundingClientRect(), select = node.querySelector('select').getBoundingClientRect();
            const button = node.querySelector('button').getBoundingClientRect();
            return { rowLeft: row.left, rowRight: row.right, selectRight: select.right, buttonLeft: button.left,
                buttonRight: button.right, scrollWidth: node.scrollWidth, width: node.clientWidth };
        });
        assert.ok(bounds.selectRight <= bounds.buttonLeft && bounds.buttonRight <= bounds.rowRight + 1);
        assert.ok(bounds.rowLeft >= 0 && bounds.rowRight <= viewport.width && bounds.scrollWidth <= bounds.width + 1);
        if (process.env.TEA_QA_DIR) {
            await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `independent-api-${viewport.width}.png`) });
        }

        await page.reload(); await open();
        assert.equal(await mode.inputValue(), 'custom'); assert.equal(await models.inputValue(), 'zeta-chat');
        assert.equal(calls.length, 1, '刷新页面后直接显示已保存模型，不自动拉取');
        await start(); await finish(); assert.equal(await models.inputValue(), 'zeta-chat');
        reply = { error: true }; await start(); await finish();
        assert.match(await status.innerText(), /拉取模型失败/);
        assert.equal(await models.inputValue(), 'zeta-chat', '失败保留上次选择');
        assert.deepEqual(await options(), ['alpha-chat', 'zeta-chat']);
        assert.equal(await refresh.isEnabled(), true, '失败后可以重试');
        reply = { data: [{ id: 'new-chat' }] }; await start(); await finish();
        assert.equal((await savedApi()).model, ''); assert.match(await status.innerText(), /重新选择/);
        await models.selectOption('new-chat');

        gate = deferred(); gates.push(gate); reply = { data: [{ id: 'stale-chat' }] }; await start();
        await address.fill('https://second.invalid/v1');
        assert.equal((await savedApi()).model, ''); assert.equal(await models.isDisabled(), true);
        const oldGate = gate; gate = null; reply = { data: [{ id: 'second-chat' }] };
        await start(); await finish(); await models.selectOption('second-chat');
        oldGate.resolve();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await options(), ['second-chat'], '旧接口的迟到结果不会覆盖新列表');
        assert.equal((await savedApi()).model, 'second-chat');
        await key.fill(''); assert.equal((await savedApi()).model, '');
        await start(); await finish();
        assert.deepEqual(JSON.parse(calls.at(-1).custom_include_headers), { Authorization: '' });
        await models.selectOption('second-chat');

        gate = deferred(); gates.push(gate); reply = { data: [{ id: 'closed-chat' }] }; await start();
        await button(viewport.width > 760 ? '设置' : '返回列表').click();
        gate.resolve(); gate = null;
        await button('设置').click();
        assert.equal(await refresh.isEnabled(), true, '离开设置取消正在等待的请求');
        assert.equal((await savedApi()).model, 'second-chat');
        reply = { data: [] }; await start(); await finish();
        assert.equal(await models.isDisabled(), true); assert.equal((await savedApi()).model, '');
        assert.equal(await status.innerText(), '接口未返回可选模型。');
        reply = { data: {} }; await start(); await finish();
        assert.match(await status.innerText(), /拉取模型失败/);
    } finally { for (const pending of gates) pending.resolve(); }
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
                assert.deepEqual(errors, [], '页面没有运行错误或警告');
                console.log(`PASS independent API ${viewport.width}x${viewport.height}: fetch, select, save, retry, stale requests and layout (${url})`);
            } finally { await context.close(); }
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
