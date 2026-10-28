// Browser plugin not available; use the project's Playwright + Edge workflow.
// Flow: keep community tabs fixed -> follow other reading gestures -> preserve reading.
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
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function offset(page) {
    return page.locator('.tea-catalog:not([hidden]) .tea-mobile-tabs').evaluate(node => {
        const transform = getComputedStyle(node).transform;
        return transform === 'none' ? 0 : -new DOMMatrixReadOnly(transform).m42 || 0;
    });
}
async function touchScroll(page, selector, pixels, { horizontal = false, target } = {}) {
    const before = await page.locator(selector).evaluate(area => ({
        height: area.clientHeight, top: area.getBoundingClientRect().top, scroll: area.scrollTop,
        y: area.querySelector('.tea-article-title, .play-prose p')?.getBoundingClientRect().top,
    }));
    await page.locator(selector).evaluate((area, { pixels, horizontal, target }) => {
        const node = target ? area.querySelector(target) : area;
        const point = (x, y) => new Touch({ identifier: 1, target: node, clientX: x, clientY: y });
        const start = point(180, 400), moved = point(horizontal ? 180 - pixels : 180, horizontal ? 400 : 400 - pixels);
        node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [start] }));
        node.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [moved] }));
        if (!horizontal && !target) area.scrollTop += pixels;
        node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [moved] }));
    }, { pixels, horizontal, target });
    await settle(page);
    await page.locator(selector).evaluate(area => area.dispatchEvent(new Event('scrollend')));
    const after = await page.locator(selector).evaluate(area => ({
        height: area.clientHeight, top: area.getBoundingClientRect().top, scroll: area.scrollTop,
        y: area.querySelector('.tea-article-title, .play-prose p')?.getBoundingClientRect().top,
    }));
    assert.equal(after.height, before.height, '移动栏目不改变正文尺寸');
    assert.equal(after.top, before.top, '移动栏目不改变正文区域位置');
    if (before.y !== undefined) assert.ok(Math.abs(after.y - (before.y - after.scroll + before.scroll)) < 2,
        '文字只跟随阅读滚动，不受栏目补偿或布局变化影响');
}
async function nativeTouchScroll(page, selector, pixels) {
    const session = await page.context().newCDPSession(page);
    const box = await page.locator(selector).boundingBox();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    const before = await offset(page);
    await page.locator(selector).evaluate(area => {
        const nav = document.querySelector('.tea-catalog:not([hidden]) .tea-mobile-tabs');
        const currentOffset = () => -new DOMMatrixReadOnly(getComputedStyle(nav).transform).m42 || 0;
        window.nativeProof = { top: area.scrollTop, expected: currentOffset(), samples: [], finished: false, touchEnded: false };
        const track = () => {
            const top = Math.max(0, Math.min(area.scrollTop, area.scrollHeight - area.clientHeight));
            nativeProof.expected = Math.max(0, Math.min(44, nativeProof.expected + top - nativeProof.top));
            if (top === 0) nativeProof.expected = 0;
            nativeProof.top = top;
            nativeProof.samples.push({ top, expected: nativeProof.expected, touchEnded: nativeProof.touchEnded });
        };
        area.addEventListener('scroll', track, { passive: true });
        area.addEventListener('touchend', () => nativeProof.touchEnded = true, { once: true, passive: true });
        area.addEventListener('scrollend', () => { nativeProof.finished = true; area.removeEventListener('scroll', track); }, { once: true });
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - pixels * step / 8 }] });
        await page.waitForTimeout(18);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => nativeProof.finished);
    await settle(page);
    const proof = await page.evaluate(() => nativeProof);
    const enabled = await page.locator('.tea-catalog:not([hidden])').evaluate(catalog => catalog.dataset.scope !== 'community' && matchMedia('(max-width:760px)').matches);
    assert.ok(Math.abs(await offset(page) - (enabled ? proof.expected : 0)) < 1,
        '原生触摸按实际正文滚动距离跟随，包括松手滑行；选集保持固定');
    await session.detach(); return { before, ...proof };
}
async function nativeWheel(page, selector, pixels) {
    const before = { offset: await offset(page), top: await page.locator(selector).evaluate(area => area.scrollTop) };
    await page.locator(selector).evaluate(area => {
        window.wheelFinished = false;
        area.addEventListener('scrollend', () => wheelFinished = true, { once: true });
    });
    await page.locator(selector).hover(); await page.mouse.wheel(0, pixels);
    await page.waitForFunction(() => wheelFinished); await settle(page);
    const delta = await page.locator(selector).evaluate(area => area.scrollTop) - before.top;
    assert.ok(Math.abs(await offset(page) - Math.max(0, Math.min(44, before.offset + delta))) < 1,
        '滚轮栏目位移与正文实际滚动相同：' + JSON.stringify({ before, delta, after: await offset(page) }));
}
async function verifyContinuousScrolling(page, selector) {
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    await page.locator(selector).evaluate(area => {
        window.proof = { resize: 0, mutations: 0, first: area.firstElementChild, area };
        proof.resizeObserver = new ResizeObserver(() => proof.resize++);
        proof.mutationObserver = new MutationObserver(records => proof.mutations += records.length);
        proof.resizeObserver.observe(area);
        proof.mutationObserver.observe(area, { subtree: true, childList: true, attributes: true });
    });
    await settle(page); await page.evaluate(() => proof.resize = 0);
    const before = await session.send('Performance.getMetrics');
    await page.locator(selector).evaluate(area => new Promise(resolve => {
        let count = 0;
        const point = y => new Touch({ identifier: 1, target: area, clientX: 180, clientY: y });
        area.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [point(400)] }));
        const frame = () => {
            const delta = count < 22 ? 1 : count < 44 ? -1 : 1;
            window.testY = (count === 0 ? 400 : testY) - delta;
            area.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [point(testY)] }));
            area.scrollTop += delta;
            if (++count < 60) requestAnimationFrame(frame);
            else { area.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })); resolve(); }
        };
        requestAnimationFrame(frame);
    }));
    await settle(page);
    await page.locator(selector).evaluate(area => area.dispatchEvent(new Event('scrollend')));
    const after = await session.send('Performance.getMetrics');
    const layouts = after.metrics.find(item => item.name === 'LayoutCount').value - before.metrics.find(item => item.name === 'LayoutCount').value;
    const proof = await page.evaluate(() => {
        proof.resizeObserver.disconnect(); proof.mutationObserver.disconnect();
        return { resize: proof.resize, mutations: proof.mutations, sameArticle: proof.first === proof.area.firstElementChild };
    });
    assert.deepEqual(proof, { resize: 0, mutations: 0, sameArticle: true });
    assert.ok(layouts <= 1, '逐帧比例移动不反复计算页面布局');
    console.log(JSON.stringify({ proportionalFrames: 60, layouts, ...proof }));
    await session.detach();
}
async function verify(browser, viewport, reducedMotion = false, plainHttp = false) {
    const context = await browser.newContext({ viewport, hasTouch: true, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    try {
        if (plainHttp) await page.addInitScript(() => {
            // Synthetic history fixture uses UUIDs; production has its own fallback.
            if (!crypto.randomUUID) crypto.randomUUID = () => {
                const bytes = crypto.getRandomValues(new Uint8Array(16));
                bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
                const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
                return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
            };
        });
        const url = 'http://' + (plainHttp ? 'tea.test' : '127.0.0.1') + ':' + server.address().port + '/';
        await page.goto(url); await page.waitForFunction(() => window.ready);
        if (plainHttp) assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, rawUpdate: 'onpointerrawupdate' in window })),
            { secure: false, rawUpdate: false }, '普通HTTP不依赖受限制的手指接口');
        assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        await page.evaluate(() => {
            for (let i = 0; i < 12; i++) {
                const id = 'story:' + i;
                fixture.community.set(id, { id, title: '第' + (i + 1) + '篇合成故事', type: 'standalone', author: '合成作者',
                    publishedAt: new Date(2026, 0, 12 - i).toISOString(), body: '合成正文。'.repeat(150) });
                fixture.settings.favorites[id] = 12 - i;
            }
        });
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
        const panel = page.locator('#teahouse-panel');
        const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
        const slot = panel.locator('.tea-catalog:not([hidden]) .tea-mobile-tab-slot');
        const list = '.tea-catalog:not([hidden]) .tea-list';
        if (viewport.width > 760) {
            await touchScroll(page, list, 180); assert.equal(await offset(page), 0);
            await screenshot(page, 'navigation-desktop.png'); assert.deepEqual(errors, []); return;
        }
        const communityLayout = () => panel.locator('.tea-catalog:not([hidden])').evaluate(catalog => {
            const slot = catalog.querySelector('.tea-mobile-tab-slot').getBoundingClientRect();
            const tools = catalog.querySelector('.tea-mobile-tools').getBoundingClientRect();
            const list = catalog.querySelector('.tea-list');
            const box = list.getBoundingClientRect(), style = getComputedStyle(list);
            return { slotTop: slot.top, slotBottom: slot.bottom, toolsTop: tools.top, toolsBottom: tools.bottom,
                listTop: box.top, listHeight: box.height, paddingTop: style.paddingTop, scrollPaddingTop: style.scrollPaddingTop };
        });
        const communityBefore = await communityLayout();
        assert.equal(communityBefore.toolsTop, communityBefore.slotBottom, '选集分类行在栏目下方');
        assert.equal(communityBefore.listTop, communityBefore.toolsBottom, '选集正文不被固定栏目遮挡');
        assert.equal(communityBefore.paddingTop, '0px', '选集正文恢复原有顶部留白');
        assert.equal(communityBefore.scrollPaddingTop, '0px', '选集无收起功能的滚动补偿');
        await touchScroll(page, list, 22); assert.equal(await offset(page), 0, '茶会选集不随手指收起');
        await nativeTouchScroll(page, list, 44); assert.equal(await offset(page), 0, '茶会选集原生触摸不收起');
        await nativeTouchScroll(page, list, -22); assert.equal(await offset(page), 0);
        await page.locator(list).hover(); await page.mouse.wheel(0, 18); await settle(page);
        assert.equal(await offset(page), 0, '茶会选集滚轮不收起');
        assert.deepEqual(await communityLayout(), communityBefore, '选集栏目、分类和正文区域尺寸固定');
        assert.equal(await slot.evaluate(node => node.inert), false, '选集栏目一直可操作');
        await button('搜索剧场').click(); await panel.getByRole('searchbox').fill('合成故事'); await settle(page);
        await touchScroll(page, list, 20); assert.equal(await offset(page), 0, '选集搜索时栏目固定');
        assert.deepEqual(await communityLayout(), communityBefore);
        await button('取消搜索').click(); await button('独立剧场').click(); await button('全部').click(); await settle(page);
        await screenshot(page, 'navigation-community-fixed-' + viewport.width + '.png');
        await button('我的收藏').click(); await settle(page);
        await screenshot(page, 'navigation-expanded-' + viewport.width + '.png');
        // Finger movement alone does not move navigation. Native scrolling does.
        await page.locator(list).evaluate(area => {
            const point = y => new Touch({ identifier: 1, target: area, clientX: 180, clientY: y });
            area.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [point(400)] }));
            area.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [point(300)] }));
        });
        await settle(page); assert.equal(await offset(page), 0, '手指通知变化100px、正文没动时栏目不动');
        await page.locator(list).evaluate(area => area.scrollTop += 7); await settle(page);
        assert.equal(await offset(page), 7, '不等touchmove，正文移动7px栏目就收起7px');
        await page.locator(list).evaluate(area => area.scrollTop -= 3); await settle(page);
        assert.equal(await offset(page), 4, '反向实际滚动3px，栏目展开3px');
        await page.locator(list).evaluate(area => area.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })));
        await page.locator(list).evaluate(area => area.scrollTop += 6); await settle(page);
        assert.equal(await offset(page), 10, '松手后正文滑行6px，栏目继续移动6px');
        await page.locator(list).evaluate(area => area.dispatchEvent(new Event('scrollend')));
        await page.locator(list).evaluate(area => area.scrollTop += 20); await settle(page);
        assert.equal(await offset(page), 10, '阅读滚动结束后，程序改变位置不继续移动栏目');
        await page.locator(list).evaluate(area => area.scrollTop = 0); await settle(page);
        assert.equal(await offset(page), 0);
        await touchScroll(page, list, 22); assert.equal(await offset(page), 22, '从顶部立即按1:1收起一半');
        await screenshot(page, 'navigation-half-' + viewport.width + '.png');
        await touchScroll(page, list, 80, { horizontal: true }); assert.equal(await offset(page), 22);
        await touchScroll(page, list, -10); assert.equal(await offset(page), 12, '反向10px立即展开10px');
        await page.waitForTimeout(200); assert.equal(await offset(page), 12, '正文停止时不补播动画');
        await touchScroll(page, list, 32); assert.equal(await offset(page), 44);
        assert.equal(await slot.evaluate(node => node.inert), true);
        assert.equal(await button('设置').isVisible(), true);
        assert.equal(await button('搜索剧场').isVisible(), true);
        assert.equal(await button('独立剧场').isVisible(), true);
        await screenshot(page, 'navigation-collapsed-' + viewport.width + '.png');
        await touchScroll(page, list, -1); assert.equal(await offset(page), 43, '反向1px也立即有反馈');
        assert.equal(await slot.evaluate(node => node.inert), false);
        await touchScroll(page, list, -43); assert.equal(await offset(page), 0);
        await touchScroll(page, list, 22);
        await button('茶会选集').click(); await settle(page);
        assert.equal(await offset(page), 0, '从半收起页面切回茶会选集时完全展开');
        await touchScroll(page, list, 22); assert.equal(await offset(page), 0);
        assert.deepEqual(await communityLayout(), communityBefore, '切回选集仍使用原有固定正文区域');
        await button('我的收藏').click(); await settle(page); assert.equal(await offset(page), 0);
        await page.locator(list).evaluate(node => node.scrollTop = 200); await settle(page);
        assert.equal(await offset(page), 0, '程序滚动不收起');
        await verifyContinuousScrolling(page, list);
        await touchScroll(page, list, -100); assert.equal(await offset(page), 0);
        await page.locator(list).hover();
        await page.mouse.wheel(90, 0); await settle(page); assert.equal(await offset(page), 0);
        await nativeWheel(page, list, 18); assert.equal(await offset(page), 18);
        await nativeWheel(page, list, -8); assert.equal(await offset(page), 10);
        await nativeTouchScroll(page, list, 22);
        const inertia = await nativeTouchScroll(page, list, 60); assert.equal(await offset(page), 44);
        assert.ok(inertia.samples.some(sample => sample.touchEnded), '原生测试实际发生松手后滑行');
        await nativeTouchScroll(page, list, -80); assert.equal(await offset(page), 0);
        await touchScroll(page, list, 44); await button('搜索剧场').click(); await settle(page);
        assert.equal(await offset(page), 0, '聚焦输入框恢复入口');
        await touchScroll(page, list, 16); assert.equal(await offset(page), 16, '搜索打开时仍能阅读并收起');
        await panel.getByRole('searchbox').fill('合成故事'); await settle(page);
        await touchScroll(page, list, 14); assert.equal(await offset(page), 14, '搜索条件保留时仍能比例移动');
        await button('取消搜索').click(); await settle(page); assert.equal(await offset(page), 0);
        await touchScroll(page, list, 44);
        await button('下一页').click(); await settle(page); assert.equal(await offset(page), 0);
        await touchScroll(page, list, 44);
        await page.locator(list).evaluate(area => area.scrollTop = 0); await settle(page);
        assert.equal(await offset(page), 0, '回到顶部恢复入口');
        await page.locator(list).evaluate(area => {
            const initial = new Touch({ identifier: 1, target: area, clientX: 180, clientY: 400 });
            area.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [initial] }));
            area.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [new Touch({ identifier: 1, target: area, clientX: 180, clientY: 430 })] }));
            area.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
            area.dispatchEvent(new Event('scroll'));
        });
        await settle(page); assert.equal(await offset(page), 0, '顶部下拉回弹不收起');
        await button('我的收藏').click(); await settle(page);
        await touchScroll(page, list, 20); assert.equal(await offset(page), 20);
        await page.evaluate(() => { fixture.settings.favorites = {}; ui.refresh(); }); await settle(page);
        assert.equal(await offset(page), 0, '收藏变空时恢复');
        await button('亲笔手稿').click(); await settle(page);
        await touchScroll(page, list, 44); assert.equal(await offset(page), 0, '空内容不收起');
        await page.evaluate(() => {
            for (let index = 1; index <= 5; index++) {
                const id = 'local:' + String(index).repeat(32);
                fixture.manuscripts.set(id, { id, title: '合成手稿' + index, type: 'standalone', body: '合成手稿正文。'.repeat(300) });
            }
            ui.refresh();
        }); await settle(page);
        await touchScroll(page, list, 22); assert.equal(await offset(page), 22, '亲笔手稿也按正文实际距离收起');
        await touchScroll(page, list, -10); assert.equal(await offset(page), 12);
        await button('剧场演出').click(); await panel.locator('.play-prose').first().waitFor(); await settle(page);
        const feed = '.play-feed';
        await panel.locator(feed).evaluate(node => node.scrollTop = 200); await settle(page);
        await touchScroll(page, feed, 22); assert.equal(await offset(page), 22);
        await touchScroll(page, feed, -10); assert.equal(await offset(page), 12);
        await screenshot(page, 'navigation-play-half-' + viewport.width + '.png');
        await nativeTouchScroll(page, feed, 60); assert.equal(await offset(page), 44);
        await nativeTouchScroll(page, feed, -80); assert.equal(await offset(page), 0);
        await button('选择角色').click(); await settle(page);
        await button('返回演出记录').click(); await settle(page);
        assert.equal(await offset(page), 0, '角色目录返回按钮不被栏目遮住');
        // Content resizing during a gesture must not cancel responsive motion.
        await panel.locator(feed).evaluate(area => {
            const point = y => new Touch({ identifier: 1, target: area, clientX: 180, clientY: y });
            area.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [point(400)] }));
            const paragraph = document.createElement('p'); paragraph.textContent = '新增合成段落';
            area.querySelector('.play-feed-content').append(paragraph);
            area.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [point(380)] }));
            area.scrollTop += 20;
            area.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
        });
        await settle(page); assert.equal(await offset(page), 20, '内容高度变化不取消跟随');
        await panel.locator(feed).evaluate(area => area.dispatchEvent(new Event('scrollend')));
        const input = panel.getByRole('textbox', { name: '小剧场提示词', exact: true });
        await input.fill('合成生成请求'); await settle(page); assert.equal(await offset(page), 0);
        await touchScroll(page, feed, 22); assert.equal(await offset(page), 22, '输入框仍有焦点也可阅读');
        await input.evaluate(node => {
            const touch = y => new Touch({ identifier: 1, target: node, clientX: 180, clientY: y });
            node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(400)] }));
            node.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(350)] }));
            node.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
        });
        await settle(page); assert.equal(await offset(page), 22, '输入框内部滚动不移动栏目');
        await input.focus(); await settle(page);
        const generationOffset = await offset(page);
        await button('发送小剧场').click(); await page.waitForFunction(() => typeof window.emitGeneration === 'function');
        await page.evaluate(() => emitGeneration('生成正文。\n\n'.repeat(40))); await settle(page);
        assert.equal(await offset(page), generationOffset, '生成自动滚动不改变栏目');
        await page.evaluate(() => finishGeneration('生成正文。\n\n'.repeat(40))); await settle(page);
        // Programmatic reading restoration during a touch only re-bases scrolling.
        await panel.locator(feed).evaluate(area => area.scrollTop = area.scrollHeight); await settle(page);
        await panel.locator(feed).evaluate(area => {
            area.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: area, clientX: 180, clientY: 400 })] }));
            area.scrollTop -= 10;
        }); await settle(page);
        const beforeResize = await offset(page);
        await input.evaluate(node => { node.value = '合成输入。\n'.repeat(6); node.dispatchEvent(new InputEvent('input', { bubbles: true })); }); await settle(page);
        assert.equal(await offset(page), beforeResize, '阅读触摸期间输入框变高，程序恢复正文位置不移动栏目');
        await panel.locator(feed).evaluate(area => area.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })));
        await panel.locator(feed).evaluate(area => area.dispatchEvent(new Event('scrollend')));
        await input.fill(''); await settle(page);
        await page.evaluate(() => document.activeElement.blur());
        await panel.locator(feed).evaluate(node => node.scrollTop = 200); await settle(page);
        await touchScroll(page, feed, -44); assert.equal(await offset(page), 0);
        await touchScroll(page, feed, 22); assert.equal(await offset(page), 22);
        await page.setViewportSize({ width: 1000, height: 844 }); await settle(page);
        assert.equal(await offset(page), 0);
        await page.setViewportSize(viewport); await settle(page); assert.equal(await offset(page), 0);
        assert.equal(await slot.locator('nav').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        await button('关闭面板').click(); await settle(page);
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
        assert.equal(await offset(page), 0);
        await panel.locator(feed).evaluate(area => area.scrollTop = 200); await settle(page);
        await touchScroll(page, feed, 22); assert.equal(await offset(page), 22);
        const captureReading = () => panel.locator(feed).evaluate(area => {
            const nav = document.querySelector('.play-catalog:not([hidden]) .tea-mobile-tabs');
            const top = Math.max(area.getBoundingClientRect().top, nav.getBoundingClientRect().bottom);
            const anchor = [...area.querySelectorAll('[data-read-anchor]')].find(node => node.getClientRects().length
                && node.getBoundingClientRect().height && node.getBoundingClientRect().bottom > top + 1);
            return { id: anchor?.dataset.readAnchor, offset: anchor ? top - anchor.getBoundingClientRect().top : null };
        });
        const readingBeforeClose = await captureReading();
        await button('关闭面板').click(); await settle(page);
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
        assert.equal(await offset(page), 0);
        const readingAfterClose = await captureReading();
        assert.equal(readingAfterClose.id, readingBeforeClose.id, '半收起时关闭重开仍读到同一段');
        assert.ok(Math.abs(readingAfterClose.offset - readingBeforeClose.offset) < 2, '重开后按实际可见上边缘恢复阅读位置');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ viewport, reducedMotion, plainHttp, checks: 'community fixed, actual scroll 1:1, native touch/wheel and inertia, no touchmove dependency, immediate reverse, no animation, fixed viewport, search/input, streaming, content resize, paging, empty, breakpoint/reopen', errors }));
    } finally { await context.close(); }
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true,
        args: ['--host-resolver-rules=MAP tea.test 127.0.0.1', '--no-proxy-server'] });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) await verify(browser, viewport);
        await verify(browser, { width: 390, height: 844 }, true);
        await verify(browser, { width: 390, height: 844 }, false, true);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
