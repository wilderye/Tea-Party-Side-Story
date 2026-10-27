// Browser plugin not available; use the project's Playwright + Edge workflow.
// Flow: scroll synthetic catalogs/history -> hide/reveal tabs -> preserve reading.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://test').pathname.slice(1));
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => {
        let count = 0;
        const frame = () => ++count === 14 ? resolve() : requestAnimationFrame(frame);
        requestAnimationFrame(frame);
    }));
}

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function nativeTouchScroll(page, selector, pixels) {
    const session = await page.context().newCDPSession(page);
    const box = await page.locator(selector).boundingBox();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - pixels * step / 8 }] });
        await page.waitForTimeout(20);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(page); await session.detach();
}

async function touchScroll(page, selector, pixels, { horizontal = false, end = true } = {}) {
    return page.locator(selector).evaluate((area, { pixels, horizontal, end }) => {
        const point = (x, y) => new Touch({ identifier: 1, target: area, clientX: x, clientY: y });
        const send = (type, touch) => area.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
            touches: type === 'touchend' ? [] : [touch], changedTouches: [touch] }));
        const start = point(180, 400), moved = point(horizontal ? 180 - pixels : 180, horizontal ? 400 : 400 - pixels);
        send('touchstart', start); send('touchmove', moved);
        area.scrollTop += pixels;
        const anchor = area.querySelector('.tea-article-title, .play-prose p');
        const before = { y: anchor?.getBoundingClientRect().top, height: area.clientHeight, position: area.scrollTop };
        area.dispatchEvent(new Event('scroll'));
        const after = { y: anchor?.getBoundingClientRect().top, height: area.clientHeight, position: area.scrollTop };
        if (end) send('touchend', moved);
        return { before, after };
    }, { pixels, horizontal, end });
}

async function verifyContinuousScrolling(page, selector) {
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    await page.locator(selector).evaluate(area => {
        window.scrollProof = { resize: 0, changes: 0, first: area.firstElementChild, area };
        scrollProof.resizeObserver = new ResizeObserver(() => scrollProof.resize++);
        scrollProof.mutationObserver = new MutationObserver(records => scrollProof.changes += records.length);
        scrollProof.resizeObserver.observe(area);
        scrollProof.mutationObserver.observe(area, { subtree: true, childList: true, attributes: true });
    });
    await settle(page);
    await page.evaluate(() => scrollProof.resize = 0);
    const before = await session.send('Performance.getMetrics');
    await touchScroll(page, selector, 3, { end: false });
    await page.locator(selector).evaluate(area => new Promise(resolve => {
        let count = 0;
        const frame = () => {
            area.scrollTop += 2;
            if (++count < 60) requestAnimationFrame(frame);
            else { area.dispatchEvent(new TouchEvent('touchend', { bubbles: true })); resolve(); }
        };
        requestAnimationFrame(frame);
    }));
    await settle(page);
    const after = await session.send('Performance.getMetrics');
    const delta = name => after.metrics.find(metric => metric.name === name).value - before.metrics.find(metric => metric.name === name).value;
    const proof = await page.evaluate(() => {
        scrollProof.resizeObserver.disconnect(); scrollProof.mutationObserver.disconnect();
        return { resize: scrollProof.resize, changes: scrollProof.changes, sameArticle: scrollProof.first === scrollProof.area.firstElementChild };
    });
    assert.deepEqual(proof, { resize: 0, changes: 0, sameArticle: true }, '持续阅读不调整区域、不改写文章节点');
    assert.ok(delta('LayoutCount') <= 1, '持续阅读不反复计算页面布局');
    console.log(JSON.stringify({ continuousScrollFrames: 60, layoutCount: delta('LayoutCount'), ...proof }));
    await session.detach();
}

async function verify(browser, viewport, reducedMotion = false) {
    const context = await browser.newContext({ viewport, hasTouch: true, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    try {
        const url = `http://127.0.0.1:${server.address().port}/`;
        await page.goto(url); await page.waitForFunction(() => window.ready);
        assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        await page.evaluate(() => {
            for (let i = 0; i < 12; i++) {
                const id = `story:${i}`;
                fixture.community.set(id, { id, title: `第${i + 1}篇合成故事`, type: 'standalone', author: '合成作者',
                    publishedAt: new Date(2026, 0, 12 - i).toISOString(), body: '合成正文。'.repeat(150) });
                fixture.settings.favorites[id] = 12 - i;
            }
        });
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
        const panel = page.locator('#teahouse-panel');
        const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
        const hidden = () => panel.evaluate(node => node.classList.contains('tea-mobile-navigation-collapsed'));
        const slot = panel.locator('.tea-catalog:not([hidden]) .tea-mobile-tab-slot');
        const list = '.tea-catalog:not([hidden]) .tea-list';
        if (viewport.width > 760) {
            await touchScroll(page, list, 180); assert.equal(await hidden(), false, '电脑布局不收起栏目');
            await screenshot(page, 'navigation-desktop.png');
            assert.deepEqual(errors, []); return;
        }
        assert.equal(await slot.evaluate(node => node.offsetHeight), 44);
        await screenshot(page, `navigation-expanded-${viewport.width}.png`);
        await page.locator(list).evaluate(node => node.scrollTop = 160); await settle(page);
        assert.equal(await hidden(), false, '恢复位置和程序滚动不收起栏目');
        await touchScroll(page, list, 8); assert.equal(await hidden(), false, '小幅下滑不触发');
        await touchScroll(page, list, 80, { horizontal: true }); assert.equal(await hidden(), false, '横滑不触发');
        const movement = await touchScroll(page, list, 80); await settle(page);
        assert.equal(await hidden(), true);
        assert.equal(movement.after.height - movement.before.height, 44, '收起真正增加阅读高度');
        assert.ok(Math.abs(movement.after.y - movement.before.y) < 1, '收起保持正文屏幕位置');
        assert.equal(await slot.evaluate(node => node.inert), true, '隐藏栏目不能被点击或聚焦');
        assert.equal(await button('设置').isVisible(), true);
        assert.equal(await button('搜索剧场').isVisible(), true);
        assert.equal(await button('全部').isVisible(), true);
        await screenshot(page, `navigation-collapsed-${viewport.width}.png`);
        await verifyContinuousScrolling(page, list);
        await touchScroll(page, list, -5); assert.equal(await hidden(), true, '轻微反向不展开');
        const reveal = await touchScroll(page, list, -24); await settle(page);
        assert.equal(await hidden(), false);
        assert.ok(Math.abs(reveal.after.y - reveal.before.y) < 1, '展开保持正文屏幕位置');
        assert.equal(await slot.evaluate(node => node.offsetHeight), 44);
        assert.equal(await slot.evaluate(node => node.inert), false);

        // Real browser scrolling with passive wheel listeners also works.
        await page.locator(list).hover(); await page.mouse.wheel(90, 0); await settle(page);
        assert.equal(await hidden(), false, '横向滚轮不收起');
        await page.mouse.wheel(0, 90); await settle(page); assert.equal(await hidden(), true);
        await page.mouse.wheel(0, -30); await settle(page); assert.equal(await hidden(), false);
        await nativeTouchScroll(page, list, 100); assert.equal(await hidden(), true, '浏览器真实触摸滑动收起');
        await nativeTouchScroll(page, list, -80); assert.equal(await hidden(), false, '浏览器真实触摸滑动展开');

        await touchScroll(page, list, 80); await button('搜索剧场').click(); await settle(page);
        assert.equal(await hidden(), false, '开始搜索展开栏目');
        await touchScroll(page, list, 80); assert.equal(await hidden(), false, '搜索期间保持入口');
        await button('取消搜索').click(); await settle(page);
        await page.locator(list).evaluate(node => node.scrollTop = 160);
        await touchScroll(page, list, 80); assert.equal(await hidden(), true);
        await button('下一页').click(); await settle(page);
        assert.equal(await hidden(), false, '翻页回顶部展开');
        assert.equal(await page.locator(list).evaluate(node => node.scrollTop), 0);
        await touchScroll(page, list, 90); assert.equal(await hidden(), true);
        await touchScroll(page, list, -1000); await settle(page);
        assert.equal(await hidden(), false, '回到顶部展开');
        assert.equal(await page.locator(list).evaluate(node => node.scrollTop), 0);

        // Safari-style overscroll, canceled gestures and late automatic scrolls.
        await touchScroll(page, list, 120); assert.equal(await hidden(), true);
        await page.locator(list).evaluate(area => {
            const original = area.scrollTop;
            const touch = new Touch({ identifier: 1, target: area, clientX: 180, clientY: 400 });
            area.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch] }));
            const moved = new Touch({ identifier: 1, target: area, clientX: 180, clientY: 430 });
            area.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [moved] }));
            Object.defineProperty(area, 'scrollTop', { configurable: true, get: () => -24 });
            area.dispatchEvent(new Event('scroll')); delete area.scrollTop;
            area.scrollTop = original; area.dispatchEvent(new Event('scroll'));
            area.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true }));
        });
        assert.equal(await hidden(), true, '顶部回弹不反向展开');
        await touchScroll(page, list, -30); assert.equal(await hidden(), false);
        await touchScroll(page, list, 80); assert.equal(await hidden(), true);
        await page.locator(list).evaluate(area => area.scrollTop = 0); await settle(page);
        assert.equal(await hidden(), false, '程序回到顶部也恢复栏目入口');
        await page.locator(list).evaluate(area => area.scrollTop = 180); await settle(page);
        await touchScroll(page, list, 3);
        await page.waitForTimeout(700);
        await page.locator(list).evaluate(area => area.scrollTop += 100); await settle(page);
        assert.equal(await hidden(), false, '旧手势结束后程序滚动不收起');

        await button('我的收藏').click(); await settle(page);
        await touchScroll(page, list, 120); assert.equal(await hidden(), true, '收藏列表也支持');
        await touchScroll(page, list, -24); assert.equal(await hidden(), false);
        const favoriteState = await page.evaluate(() => JSON.stringify(fixture.settings.favorites));
        await touchScroll(page, list, 80); assert.equal(await hidden(), true);
        await page.evaluate(() => { fixture.settings.favorites = {}; ui.refresh(); }); await settle(page);
        assert.equal(await hidden(), false, '收藏变为空列表时展开，避免栏目无法找回');
        await page.evaluate(value => { fixture.settings.favorites = JSON.parse(value); ui.refresh(); }, favoriteState); await settle(page);
        await button('亲笔手稿').click(); await settle(page);
        await touchScroll(page, list, 120); assert.equal(await hidden(), false, '空内容保持展开');

        await button('剧场演出').click();
        const feed = '.play-feed';
        await panel.locator('.play-prose').first().waitFor(); await settle(page);
        await panel.locator(feed).evaluate(node => node.scrollTop = 100); await settle(page);
        assert.equal(await hidden(), false, '剧场恢复阅读位置不收起');
        const playHide = await touchScroll(page, feed, 100); await settle(page);
        assert.equal(await hidden(), true, '剧场阅读下滑收起');
        assert.ok(Math.abs(playHide.before.y - playHide.after.y) < 2, '剧场收起立即保留段落');
        const savedY = playHide.after.y;
        assert.ok(Math.abs(await panel.locator('.play-prose p').first().evaluate(node => node.getBoundingClientRect().top) - savedY) < 2,
            '剧场尺寸观察器不能恢复旧位置');
        const playReveal = await touchScroll(page, feed, -30); await settle(page);
        assert.equal(await hidden(), false);
        assert.ok(Math.abs(playReveal.before.y - playReveal.after.y) < 2);
        await screenshot(page, `navigation-play-${viewport.width}.png`);
        const input = panel.getByRole('textbox', { name: '小剧场提示词', exact: true });
        await input.fill('合成生成请求');
        await button('发送小剧场').click();
        await page.waitForFunction(() => typeof window.emitGeneration === 'function');
        await page.evaluate(() => emitGeneration('生成正文。\n\n'.repeat(40))); await settle(page);
        assert.equal(await hidden(), false, '生成自动滚动不收起');
        await page.evaluate(() => finishGeneration('生成正文。\n\n'.repeat(40))); await settle(page);
        assert.equal(await hidden(), false);
        await input.focus();
        await touchScroll(page, feed, -100); assert.equal(await hidden(), false, '输入时保持展开');

        await page.evaluate(() => document.activeElement.blur());
        await page.locator(feed).evaluate(node => node.scrollTop = 160); await settle(page);
        await touchScroll(page, feed, 100); assert.equal(await hidden(), true);
        await page.setViewportSize({ width: 1000, height: 844 }); await settle(page);
        assert.equal(await hidden(), false, '切电脑布局清除隐藏状态');
        await page.setViewportSize(viewport); await settle(page);
        assert.equal(await hidden(), false, '返回手机栏目可用');
        if (reducedMotion) assert.equal(await slot.locator('nav').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        await button('关闭面板').click(); await settle(page);
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
        assert.equal(await hidden(), false, '关闭重开不保留隐藏状态');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ viewport, reducedMotion, checks: 'thresholds, native touch/wheel, bounce, reading position, controls, search, paging, short content, streaming, breakpoint, reopen', errors }));
    } finally { await context.close(); }
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
            await verify(browser, viewport);
        }
        await verify(browser, { width: 390, height: 844 }, true);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
