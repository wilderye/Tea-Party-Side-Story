// Browser plugin not available; use Playwright/Edge and synthetic data only.
// Flow: type/wrap/delete -> cap composer height -> preserve history position.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: originalHarness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = originalHarness.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const settle = page => page.evaluate(() => new Promise(resolve => {
    let frames = 0;
    const frame = () => ++frames === 5 ? resolve() : requestAnimationFrame(frame);
    requestAnimationFrame(frame);
}));
const position = feed => {
    const top = feed.getBoundingClientRect().top;
    const anchor = [...feed.querySelectorAll('[data-read-anchor]')].find(node => node.getClientRects().length
        && node.getBoundingClientRect().height && node.getBoundingClientRect().bottom > top + 1);
    return { anchor: anchor?.dataset.readAnchor, offset: anchor ? top - anchor.getBoundingClientRect().top : null,
        bottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 2 };
};
async function assertPosition(feed, before, label) {
    const after = await feed.evaluate(position);
    if (before.bottom) assert.equal(after.bottom, true, label);
    else {
        assert.equal(after.anchor, before.anchor, label);
        assert.ok(Math.abs(after.offset - before.offset) < 2, `${label}: ${after.offset} / ${before.offset}`);
    }
}
async function open(page, url) {
    await page.goto(url);
    assert.equal(page.url(), url);
    assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await page.waitForFunction(() => window.ready);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])').getByRole('button', { name: '剧场演出', exact: true }).filter({ visible: true }).click();
    await page.locator('.play-record:visible').first().waitFor();
    await settle(page);
}
async function verify(page, viewport, fallback, url) {
    if (fallback) await page.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = (property, value) => property === 'field-sizing' ? false : supports(property, value);
    });
    await open(page, url);
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])'), input = panel.locator('.play-compose-input'), feed = panel.locator('.play-feed');
    const send = panel.locator('.play-send'), cap = viewport.width > 760 ? 20 : 8;
    assert.equal(await input.evaluate(node => node.classList.contains('is-native-sized')), !fallback);
    assert.equal(await input.getAttribute('data-max-lines'), String(cap));
    assert.equal(await send.isDisabled(), true);
    assert.equal(await panel.locator('vite-error-overlay,nextjs-portal').count(), 0);
    await input.fill('输入测试'); await settle(page);
    const oneLine = await input.evaluate(node => node.clientHeight);
    assert.equal(oneLine, 44);
    assert.equal(await send.isEnabled(), true);
    const lines = count => Array.from({ length: count }, (_, index) => `测试第${index + 1}行`).join('\n');
    await input.fill(lines(3)); await settle(page);
    assert.equal(await input.evaluate(node => node.clientHeight), 92, '三行自适应增高');
    await input.fill('中文换行测试'.repeat(60)); await settle(page);
    assert.ok(await input.evaluate(node => node.clientHeight > 44), '连续文字按实际宽度换行');
    await input.fill(lines(cap + 12)); await settle(page);
    const capped = await input.evaluate(node => ({ height: node.clientHeight, maximum: parseFloat(node.style.maxHeight),
        scrollHeight: node.scrollHeight, pageHeight: node.closest('.play-page').clientHeight }));
    assert.ok(capped.height <= cap * 24 + 20 + 1 && capped.height <= capped.maximum + 1);
    assert.ok(capped.scrollHeight > capped.height, '超出上限后保留框内滚动');
    assert.ok(capped.pageHeight - capped.height >= 32, '保留上方阅读空间');
    await input.fill('输入测试'); await settle(page);
    assert.equal(await input.evaluate(node => node.clientHeight), oneLine, '删除后缩回一行');

    for (const atBottom of [false, true]) {
        await feed.evaluate((node, bottom) => { node.scrollTop = bottom ? node.scrollHeight : 270; }, atBottom); await settle(page);
        const before = await feed.evaluate(position);
        for (const text of [lines(4), lines(cap + 12), '缩回一行']) {
            await input.fill(text); await settle(page); await assertPosition(feed, before, `增高/缩回保持读到的段落或底部 (${atBottom}, ${text.split('\n').length}行)`);
        }
    }

    await input.fill('拼音'); await settle(page);
    const composition = await input.evaluate(async (node, fallback) => {
        const oldHeight = node.clientHeight;
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        node.value = '拼音第一行\n拼音第二行\n拼音第三行';
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const during = node.clientHeight;
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', isComposing: false }));
        return { oldHeight, during };
    }, fallback);
    await settle(page);
    if (fallback) assert.equal(composition.during, composition.oldHeight, '兼容处理不打断输入法组字');
    assert.equal(await input.evaluate(node => node.clientHeight), 92, '组字结束后高度正确');
    assert.equal(await page.evaluate(() => captured.length), 0, '组字期间回车不发送');

    await input.fill('输入'); await settle(page);
    const hotPath = await input.evaluate(node => {
        let active = false, reads = 0;
        const descriptors = ['clientHeight', 'clientWidth', 'scrollHeight', 'scrollTop'].map(key => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)]);
        const hidden = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
        let historyWrites = 0;
        descriptors.forEach(([key, descriptor]) => Object.defineProperty(Element.prototype, key, { ...descriptor,
            get() { if (active) reads++; return descriptor.get.call(this); } }));
        Object.defineProperty(HTMLElement.prototype, 'hidden', { ...hidden, set(value) {
            if (active && this.closest('.play-record')) historyWrites++;
            hidden.set.call(this, value);
        } });
        try {
            active = true; node.value += '测试';
            node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        } finally {
            active = false;
            descriptors.forEach(([key, descriptor]) => Object.defineProperty(Element.prototype, key, descriptor));
            Object.defineProperty(HTMLElement.prototype, 'hidden', hidden);
        }
        return { reads, historyWrites };
    });
    assert.deepEqual(hotPath, { reads: 0, historyWrites: 0 }, '输入事件不读取页面尺寸、不刷新历史按钮');
    await settle(page);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('teahouse-play-view-v1'))?.drafts?.some(([, draft]) => draft.text === '输入测试'));
    await panel.getByRole('button', { name: '关闭面板', exact: true }).filter({ visible: true }).click();
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await settle(page);
    assert.equal(await input.inputValue(), '输入测试', '关闭再打开面板保留草稿');
    await panel.getByRole('button', { name: '关闭面板', exact: true }).filter({ visible: true }).click();
    await open(page, url);
    assert.equal(await input.inputValue(), '输入测试', '刷新页面后保留草稿');
    await input.fill(lines(cap + 12)); await settle(page);
    await page.setViewportSize({ width: viewport.width, height: 520 }); await settle(page);
    assert.ok(await input.evaluate(node => node.clientHeight <= parseFloat(node.style.maxHeight) + 1), '缩小窗口后重新限制高度');
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), '没有横向溢出');
    if (process.env.TEA_QA_DIR) {
        await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `composer-${viewport.width}-${fallback ? 'fallback' : 'native'}.png`) });
    }
    return { viewport, fallback, hotPath, passed: true };
}
module.exports = { harness, open, settle };
if (require.main === module) (async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            for (const fallback of [false, true]) {
                const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
                const result = await verify(page, viewport, fallback, url);
                assert.deepEqual(errors, []);
                console.log(JSON.stringify(result));
                await context.close();
            }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
