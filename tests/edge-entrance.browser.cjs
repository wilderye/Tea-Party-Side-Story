const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = `<!doctype html><html><head><meta charset="utf-8"><title>侧边入口验证</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css">
<style>:root { --SmartThemeBotMesBlurTintColor:rgba(30, 40, 50, .5); }</style></head>
<body><div id="extensions_settings"></div><script type="module">
const saved = JSON.parse(new URLSearchParams(location.search).get('settings') || '{}');
const handlers = new Map();
const context = {
    extensionSettings: { teahouse: { favorites: {}, libraryUrl: 'https://library.invalid/', ...saved } }, chat: [],
    getCurrentChatId: () => 'edge-test', getRequestHeaders: () => ({}), saveSettingsDebounced() {}, registerMacro() {},
    substituteParams: value => value, uuidv4: () => crypto.randomUUID(), eventTypes: { APP_READY: 'app_ready' },
    eventSource: { on(name, handler) { handlers.set(name, handler); } },
    SlashCommandParser: { addCommandObject() {} }, SlashCommand: { fromProps: value => value },
};
window.SillyTavern = { getContext: () => context };
window.teaSettings = context.extensionSettings.teahouse;
await import('/index.js');
handlers.get('app_ready')();
window.ready = true;
</script></body></html>`;
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://localhost').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});
const viewports = [
    { name: 'desktop', options: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

async function open(context, settings) {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (!['error', 'warning'].includes(message.type())) return;
        if (message.text().includes('404')) return;
        errors.push(`${message.text()} (${message.location().url})`);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?settings=${encodeURIComponent(JSON.stringify(settings))}`);
    await page.waitForFunction(() => window.ready);
    return { page, errors };
}

async function read(page) {
    return page.evaluate(() => {
        const edge = document.querySelector('#teahouse-edge');
        const slider = document.querySelector('.teahouse-edge-opacity-row input[type=range]');
        return { opacity: getComputedStyle(edge).opacity, slider: slider.value,
            shown: slider.nextElementSibling.textContent, stored: window.teaSettings.edgeOpacity,
            migrated: window.teaSettings.edgeOpacityMigrated };
    });
}

async function verify(context, name) {
    const base = { edgeEnabled: true };
    const cases = [
        ['新安装', base, '1', null],
        ['旧版本自动写入的 80%', { ...base, edgeOpacity: 0.8 }, '1', null],
        ['旧版本自动写入的 50%', { ...base, edgeOpacity: 0.5 }, '1', null],
        ['迁移后选择的 50%', { ...base, edgeOpacity: 0.5, edgeOpacityMigrated: true }, '0.5', 0.5],
        ['迁移后选择的 80%', { ...base, edgeOpacity: 0.8, edgeOpacityMigrated: true }, '0.8', 0.8],
        ['保存值为 0', { ...base, edgeOpacity: 0, edgeOpacityMigrated: true }, '1', null],
        ['保存值超过上限', { ...base, edgeOpacity: 2, edgeOpacityMigrated: true }, '1', null],
        ['保存值不是数字', { ...base, edgeOpacity: 'abc', edgeOpacityMigrated: true }, '1', null],
    ];
    for (const [label, settings, opacity, stored] of cases) {
        const { page, errors } = await open(context, settings);
        const state = await read(page);
        const percent = String(Math.round(Number(opacity) * 100));
        assert.deepEqual(state, { opacity, slider: percent, shown: `${percent}%`, stored, migrated: true }, `${name}：${label}`);
        assert.deepEqual(errors, [], `${name}：${label}`);
        await page.close();
    }

    const { page, errors } = await open(context, base);
    if (name === 'desktop') {
        const look = await page.locator('#teahouse-edge').evaluate(node => {
            const style = getComputedStyle(node);
            return { background: style.backgroundColor, border: style.borderTopWidth, opacity: style.opacity };
        });
        assert.match(look.background, /^(rgb\(30, 40, 50\)|color\(srgb 0\.117647 0\.156863 0\.196078\))$/, '主题色半透明时，100% 的胶囊仍是实心');
        assert.deepEqual([look.border, look.opacity], ['0px', '1']);
    }
    const slider = page.getByRole('slider', { name: '不透明度', exact: true });
    assert.equal(await slider.count(), 1, `${name}：滑块有可读名称`);
    await slider.fill('50');
    await page.waitForTimeout(400);
    let state = await read(page);
    assert.deepEqual(state, { opacity: '0.5', slider: '50', shown: '50%', stored: 0.5, migrated: true }, `${name}：拖动后立即生效`);
    const savedSettings = await page.evaluate(() => JSON.parse(JSON.stringify(window.teaSettings)));
    await page.close();
    const reloaded = await open(context, savedSettings);
    state = await read(reloaded.page);
    assert.deepEqual(state, { opacity: '0.5', slider: '50', shown: '50%', stored: 0.5, migrated: true }, `${name}：刷新后保留 50%`);

    const edge = reloaded.page.locator('#teahouse-edge');
    const before = await edge.evaluate(node => node.getBoundingClientRect().width);
    await edge.hover();
    await reloaded.page.waitForTimeout(400);
    const hovered = await edge.evaluate(node => ({ opacity: getComputedStyle(node).opacity, width: node.getBoundingClientRect().width }));
    if (name === 'desktop') assert.deepEqual(hovered, { opacity: '1', width: 26 }, '电脑端悬停时完全显示并展开');
    else assert.deepEqual(hovered, { opacity: '0.5', width: before }, '手机端触碰后不停留在悬停状态');
    assert.deepEqual([...errors, ...reloaded.errors], []);
    await reloaded.page.close();
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        for (const { name, options } of viewports) {
            const context = await browser.newContext(options);
            await context.route('https://library.invalid/**', route => route.fulfill({ status: 404, body: '' }));
            await verify(context, name);
            console.log(JSON.stringify({ viewport: name, checks: '统一默认 100%、电脑端实心胶囊、旧默认值迁移、迁移后保留选择、无效值回到默认、滑块名称、拖动生效、刷新保留、悬停表现' }));
            await context.close();
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
