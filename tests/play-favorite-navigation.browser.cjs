// Browser plugin not available; use the repository's Playwright + Edge workflow.
// Flow: open synthetic performance favorites -> tap arrows or drag -> verify reading and catalog state.
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
        const frame = () => ++count === 4 ? resolve() : requestAnimationFrame(frame);
        requestAnimationFrame(frame);
    }));
}

async function verify(page, viewport) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url);
    assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    const ids = await page.evaluate(async () => {
        for (let index = 1; index <= 20; index++) {
            await testHistory.addManualFavorite({ character: ctx.characters[index % 2], title: `收藏第${index}条`,
                text: Array.from({ length: 32 }, (_, paragraph) => `第${index}条收藏的第${paragraph + 1}段。用于验证长正文滚动和两侧箭头。`).join('\n\n'),
                firstLine: `第${index}条收藏的正文` });
        }
        fixture.community.set('standalone', { id: 'standalone', title: '独立收藏', type: 'standalone', body: '独立剧场正文', author: '合成作者', publishedAt: '2026-01-01' });
        fixture.community.set('preset', { id: 'preset', title: '随文收藏', type: 'preset', body: '随文剧场正文', author: '合成作者', publishedAt: '2026-01-01' });
        fixture.settings.favorites = { standalone: 1, preset: 2 };
        fixture.settings.sortMode = 'time';
        return (await runtime.listFavorites()).map(item => item.id);
    });
    const original = await page.evaluate(async () => ({ rows: await runtime.listFavorites(), chat: ctx.chat,
        round: await runtime.getRound(seed.a), settings: JSON.stringify(fixture.settings) }));
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const reader = panel.locator('.play-favorite-reading[data-active=true]:visible');
    const previous = () => reader.getByRole('button', { name: '上一条收藏', exact: true });
    const next = () => reader.getByRole('button', { name: '下一条收藏', exact: true });
    const mobile = viewport.width <= 760;
    const openCatalog = async () => { if (mobile) await button('返回收藏目录').click(); await settle(page); };
    const read = async id => {
        await panel.locator(`.tea-story[data-id="${id}"]`).click();
        await reader.locator('.play-prose').waitFor(); await settle(page);
    };
    const selected = () => reader.getAttribute('data-id');
    const turn = async (direction, id) => {
        await (direction > 0 ? next() : previous()).click();
        await page.waitForFunction(id => document.querySelector('.tea-panel-surface[data-active=true] .play-favorite-reading[data-active=true]')?.dataset.id === id, id);
        await reader.locator('.play-prose').waitFor(); await settle(page);
    };
    await button('我的收藏').click();
    assert.equal(await panel.locator('.play-favorite-navigation button:visible').count(), 0, '独立收藏不出现阅读切换箭头');
    await button('随文剧场').click();
    assert.equal(await panel.locator('.play-favorite-navigation button:visible').count(), 0, '随文收藏不出现阅读切换箭头');
    await button('演出记录').click(); await settle(page);
    if (mobile) assert.equal(await panel.locator('.play-favorite-navigation button:visible').count(), 0, '手机收藏目录不显示阅读箭头');
    await read(ids[0]);
    assert.equal(await previous().isDisabled(), true);
    assert.equal(await next().isEnabled(), true);
    await turn(1, ids[1]);
    const layout = await reader.evaluate(node => {
        const pane = node.getBoundingClientRect();
        const prose = node.querySelector('.play-prose').getBoundingClientRect();
        const buttons = [...node.querySelectorAll('.play-favorite-navigation button')].map(button => {
            const rect = button.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                background: getComputedStyle(button).backgroundColor };
        });
        return { pane: { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
            prose: { x: prose.x, right: prose.right }, buttons, overflow: node.scrollWidth - node.clientWidth };
    });
    assert.ok(layout.overflow <= 1, '长收藏没有横向溢出');
    for (const arrow of layout.buttons) {
        assert.equal(arrow.width, 44); assert.equal(arrow.height, 44);
        assert.equal(arrow.background, 'rgba(0, 0, 0, 0)', '箭头背景透明');
        assert.ok(arrow.y > layout.pane.y && arrow.y + arrow.height < layout.pane.y + layout.pane.height);
    }
    assert.ok(layout.buttons[0].x + 44 <= layout.prose.x + 1, '左箭头的点击范围不覆盖正文');
    assert.ok(layout.buttons[1].x >= layout.prose.right - 1, '右箭头的点击范围不覆盖正文');
    const beforeScroll = await next().boundingBox();
    await reader.evaluate(node => { node.scrollTop = 460; }); await settle(page);
    assert.ok(Math.abs((await next().boundingBox()).y - beforeScroll.y) < 1, '长正文滚动时箭头保持原位');
    await reader.evaluate(node => { node.scrollTop = node.scrollHeight; }); await settle(page);
    assert.ok(Math.abs((await next().boundingBox()).y - beforeScroll.y) < 1, '正文到底部时箭头仍保持原位');
    await turn(1, ids[2]);
    assert.equal(await reader.evaluate(node => node.scrollTop), 0, '新收藏从正文开头显示');
    await turn(-1, ids[1]);
    assert.equal(await reader.evaluate(node => node.scrollTop), 0, '返回曾读过的收藏也从开头显示');

    // A mouse drag that leaves and returns must not be reduced to its final displacement.
    const arrow = await next().boundingBox();
    const x = arrow.x + 22, y = arrow.y + 22;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y - 65, { steps: 5 }); await page.mouse.move(x, y, { steps: 5 }); await page.mouse.up();
    await settle(page); assert.equal(await selected(), ids[1], '拖出又返回箭头不切换收藏');
    await next().focus(); await page.keyboard.press('Enter'); await settle(page);
    assert.equal(await selected(), ids[2], '取消拖动后键盘仍能正常使用箭头');

    // Send native touch input to Edge: the browser must perform scrolling itself.
    if (mobile) {
        await reader.evaluate(node => { node.scrollTop = 0; }); await settle(page);
        const touch = await page.context().newCDPSession(page);
        const box = await next().boundingBox();
        const point = { x: box.x + 22, y: box.y + 22 };
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        for (let step = 1; step <= 6; step++) {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - step * 20 }] });
            await page.waitForTimeout(20);
        }
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(350);
        assert.equal(await selected(), ids[2], '从箭头开始的手机拖动没有切换收藏');
        assert.ok(await reader.evaluate(node => node.scrollTop) > 30, '从箭头开始的手机拖动正常滚动正文');
        const tapBox = await next().boundingBox();
        await page.touchscreen.tap(tapBox.x + 22, tapBox.y + 22); await settle(page);
        assert.equal(await selected(), ids[3], '拖动之后正常轻点仍能切换收藏');
        await touch.detach();
    }

    await button('编辑演出记录收藏').click();
    assert.equal(await next().isVisible(), false, '编辑收藏时隐藏箭头');
    await reader.getByRole('textbox', { name: '收藏内容', exact: true }).fill('合成未保存草稿');
    assert.ok(await reader.evaluate(node => node.scrollHeight - node.clientHeight <= 1), '编辑仍只有正文内部滚动');
    await button('取消').click();
    assert.equal(await next().isVisible(), true, '取消编辑后恢复箭头');
    let index = ids.indexOf(await selected());
    for (; index + 1 < ids.length; index++) await turn(1, ids[index + 1]);
    assert.equal(await next().isDisabled(), true, '最后一条不能继续切换');
    assert.equal(await previous().isEnabled(), true);
    await openCatalog();
    assert.equal(await panel.locator(`.tea-story[data-id="${ids.at(-1)}"]`).getAttribute('aria-current'), 'true', '跨页阅读后目录同步到当前收藏');
    assert.ok(Number(await panel.locator('.tea-page-current').textContent()) > 1, '实际跨越目录分页');

    if (mobile) await button('搜索剧场').click();
    const search = panel.getByRole('searchbox', { name: '搜索标题或角色名字', exact: true });
    await search.fill('测试甲'); await settle(page);
    const filtered = await page.evaluate(async () => (await runtime.listFavorites()).filter(item => item.characterName === '测试甲').map(item => item.id));
    await panel.locator('.tea-story').first().click(); await settle(page);
    assert.equal(await selected(), filtered[0]);
    for (let index = 1; index < filtered.length; index++) await turn(1, filtered[index]);
    assert.equal(await next().isDisabled(), true, '箭头仅遍历当前搜索结果');
    await openCatalog();
    await search.fill('收藏第20条'); await settle(page);
    await panel.locator('.tea-story').first().click(); await settle(page);
    assert.equal(await previous().isDisabled(), true); assert.equal(await next().isDisabled(), true, '只有一条搜索结果时两个箭头均停用');
    await openCatalog(); await search.fill(''); if (mobile) await button('取消搜索').click();
    await button('排序方式').click(); await panel.getByRole('menuitemradio', { name: '随机顺序', exact: true }).click();
    await settle(page);
    const order = await panel.locator('.tea-story').evaluateAll(nodes => nodes.map(node => node.dataset.id));
    await read(order[0]);
    for (let index = 1; index < order.length; index++) await turn(1, order[index]);
    await openCatalog();
    assert.deepEqual(await panel.locator('.tea-story').evaluateAll(nodes => nodes.map(node => node.dataset.id)), order, '箭头切换沿用随机目录顺序且不会重新打乱');
    await button('排序方式').click(); await panel.getByRole('menuitemradio', { name: '时间顺序', exact: true }).click();
    await settle(page); await read(ids[0]); await turn(1, ids[1]);
    if (process.env.TEA_QA_DIR) {
        await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `${viewport.width}-favorite-arrows.png`) });
    }
    assert.deepEqual(await page.evaluate(async () => ({ rows: await runtime.listFavorites(), chat: ctx.chat,
        round: await runtime.getRound(seed.a), settings: JSON.stringify(fixture.settings) })), original,
        '阅读和取消编辑不修改收藏内容、来源演出、聊天或最终设置');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, url, checks: '透明箭头、阅读与目录跨页、首尾停用、长文固定位置、拖动取消、手机原生滚动、键盘、编辑保护、搜索和随机排序、数据不变', errors }));
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
            const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 760 });
            try { await verify(await context.newPage(), viewport); }
            finally { await context.close(); }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
