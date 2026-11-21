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
            await testHistory.addManualFavorite({ character: ctx.characters[index % 2], title: `收藏第${index}条：这是一个较长的收藏标题，用于验证手机自动换行。`,
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
    const mobile = viewport.width <= 760;
    const navigationSelector = mobile ? '.play-favorite-inline-navigation' : '.play-favorite-navigation';
    const navigation = reader.locator(navigationSelector), footer = reader.locator('.play-favorite-footer');
    const previous = () => navigation.getByRole('button', { name: '上一条收藏', exact: true });
    const next = () => navigation.getByRole('button', { name: '下一条收藏', exact: true });
    const footerPrevious = () => footer.getByRole('button', { name: '上一条收藏', exact: true });
    const footerNext = () => footer.getByRole('button', { name: '下一条收藏', exact: true });
    const top = () => footer.getByRole('button', { name: '回顶', exact: true });
    const screenshot = async name => {
        if (!process.env.TEA_QA_DIR) return;
        await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `${viewport.width}-favorite-${name}.png`) });
    };
    const openCatalog = async () => { if (mobile) await button('返回收藏目录').click(); await settle(page); };
    const read = async id => {
        await panel.locator(`.tea-story[data-id="${id}"]`).click();
        await reader.locator('.play-prose').waitFor(); await settle(page);
    };
    const selected = () => reader.getAttribute('data-id');
    const turn = async (direction, id, atBottom = false) => {
        await (direction > 0 ? (atBottom ? footerNext() : next()) : (atBottom ? footerPrevious() : previous())).click();
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
    if (mobile) {
        assert.equal(await footerPrevious().isDisabled(), true);
        assert.equal(await footerNext().isEnabled(), true);
    }
    assert.equal(await reader.locator('.play-sent-prompt-action').count(), 0, '收藏阅读不再显示查看提示词按钮');
    await turn(1, ids[1]);
    const layout = await reader.evaluate((node, selector) => {
        const pane = node.getBoundingClientRect();
        const prose = node.querySelector('.play-prose').getBoundingClientRect();
        const buttons = [...node.querySelectorAll(`${selector} button`)].map(button => {
            const rect = button.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                background: getComputedStyle(button).backgroundColor };
        });
        return { pane: { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
            prose: { x: prose.x, right: prose.right }, buttons, overflow: node.scrollWidth - node.clientWidth };
    }, navigationSelector);
    assert.ok(layout.overflow <= 1, '长收藏没有横向溢出');
    const arrowWidth = 44;
    for (const arrow of layout.buttons) {
        assert.equal(arrow.width, arrowWidth); assert.equal(arrow.height, 44);
        assert.equal(arrow.background, 'rgba(0, 0, 0, 0)', '箭头背景透明');
        assert.ok(arrow.y > layout.pane.y && arrow.y + arrow.height < layout.pane.y + layout.pane.height);
    }
    if (mobile) {
        assert.equal(await reader.locator('.play-favorite-navigation').isVisible(), false, '手机不再显示固定在两侧的箭头');
        assert.ok(Math.abs(layout.buttons[1].x + arrowWidth - layout.prose.right) < 1, '手机顶部箭头位于正文右侧');
        assert.ok(Math.abs(layout.prose.x - 18) < 1 && Math.abs(viewport.width - layout.prose.right - 18) < 1,
            `手机收藏正文与剧场演出使用相同的左右边距：${JSON.stringify(layout.prose)}`);
        const heading = await reader.evaluate(node => {
            const title = node.querySelector('.play-favorite-title').getBoundingClientRect();
            const character = node.querySelector('.play-favorite-character').getBoundingClientRect();
            const tools = node.querySelector('.play-favorite-head>.play-header-actions').getBoundingClientRect();
            return { title: { x: title.x, right: title.right, bottom: title.bottom, height: title.height },
                character: { top: character.top, middle: character.top + character.height / 2 },
                tools: { top: tools.top, middle: tools.top + tools.height / 2 } };
        });
        assert.ok(Math.abs(heading.title.x - layout.prose.x) < 1 && Math.abs(heading.title.right - layout.prose.right) < 1,
            '手机收藏标题独占正文宽度');
        assert.ok(heading.title.height > 36, '长标题自动换行');
        assert.ok(heading.title.bottom <= Math.min(heading.character.top, heading.tools.top), '角色和图标排在标题下方');
        assert.ok(Math.abs(heading.character.middle - heading.tools.middle) < 1, '角色和图标位于同一行');
    } else {
        assert.equal(await reader.locator('.play-favorite-inline-navigation').isVisible(), false, '电脑版隐藏随文的顶部箭头');
        assert.ok(layout.buttons[0].x + arrowWidth <= layout.prose.x + 1, '左箭头的点击范围不覆盖正文');
        assert.ok(layout.buttons[1].x >= layout.prose.right - 1, '右箭头的点击范围不覆盖正文');
    }
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(), 0);
    await screenshot('top');
    const beforeScroll = await next().boundingBox();
    await reader.evaluate(node => { node.scrollTop = 460; }); await settle(page);
    if (mobile) assert.ok((await next().boundingBox()).y < beforeScroll.y - 400, '手机顶部箭头随正文滚动');
    else assert.ok(Math.abs((await next().boundingBox()).y - beforeScroll.y) < 1, '电脑版长正文滚动时两侧箭头保持原位');
    await reader.evaluate(node => { node.scrollTop = node.scrollHeight; }); await settle(page);
    if (!mobile) assert.ok(Math.abs((await next().boundingBox()).y - beforeScroll.y) < 1, '电脑版正文到底部时两侧箭头仍保持原位');
    assert.equal(await footer.isVisible(), true);
    const topBox = await top().boundingBox(), footerBoxes = [topBox];
    if (mobile) {
        const [leftBox, rightBox] = await Promise.all([footerPrevious().boundingBox(), footerNext().boundingBox()]);
        footerBoxes.push(leftBox, rightBox);
        assert.ok(Math.abs(leftBox.x - layout.prose.x) < 1 && Math.abs(rightBox.x + rightBox.width - layout.prose.right) < 1,
            '手机底部左右箭头分别靠正文左侧和右侧');
        assert.ok(Math.abs(topBox.x + topBox.width / 2 - (layout.prose.x + layout.prose.right) / 2) < 1, '手机回顶按钮位于底部中间');
    } else {
        assert.equal(await footer.getByRole('button').count(), 1, '电脑底部只显示回顶按钮');
        assert.equal(await footerPrevious().count(), 0, '电脑底部隐藏上一条收藏按钮');
        assert.equal(await footerNext().count(), 0, '电脑底部隐藏下一条收藏按钮');
        assert.ok(Math.abs(topBox.x + topBox.width - layout.prose.right) < 1, '电脑回顶按钮靠正文右侧');
    }
    for (const box of footerBoxes) {
        assert.ok(Math.abs(box.y - topBox.y) < 1 && box.y >= layout.pane.y
            && box.y + box.height <= layout.pane.y + layout.pane.height, '底部按钮处于同一行且完整可见');
    }
    await screenshot('bottom');
    await top().click(); await settle(page);
    assert.equal(await reader.evaluate(node => node.scrollTop), 0, '回顶按钮返回当前收藏开头');
    await reader.evaluate(node => { node.scrollTop = node.scrollHeight; }); await settle(page);
    await turn(1, ids[2], mobile);
    assert.equal(await reader.evaluate(node => node.scrollTop), 0, '新收藏从正文开头显示');
    await turn(-1, ids[1], mobile);
    assert.equal(await reader.evaluate(node => node.scrollTop), 0, '返回曾读过的收藏也从开头显示');

    // A mouse drag that leaves and returns must not be reduced to its final displacement.
    const arrow = await next().boundingBox();
    const x = arrow.x + arrow.width / 2, y = arrow.y + arrow.height / 2;
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
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        for (let step = 1; step <= 6; step++) {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - step * 20 }] });
            await page.waitForTimeout(20);
        }
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(350);
        assert.equal(await selected(), ids[2], '从箭头开始的手机拖动没有切换收藏');
        assert.ok(await reader.evaluate(node => node.scrollTop) > 30, '从箭头开始的手机拖动正常滚动正文');
        await reader.evaluate(node => { node.scrollTop = 0; }); await settle(page);
        const tapBox = await next().boundingBox();
        await page.touchscreen.tap(tapBox.x + tapBox.width / 2, tapBox.y + tapBox.height / 2); await settle(page);
        assert.equal(await selected(), ids[3], '拖动之后正常轻点仍能切换收藏');
        await touch.detach();
    }

    await button('编辑演出记录收藏').click();
    assert.equal(await next().isVisible(), false, '编辑收藏时隐藏箭头');
    assert.equal(await footer.isVisible(), false, '编辑收藏时隐藏底部翻页和回顶按钮');
    assert.equal(await reader.locator('.play-sent-prompt-action').count(), 0, '收藏编辑不再显示查看提示词按钮');
    await reader.getByRole('textbox', { name: '收藏内容', exact: true }).fill('合成未保存草稿');
    assert.ok(await reader.evaluate(node => node.scrollHeight - node.clientHeight <= 1), '编辑仍只有正文内部滚动');
    await button('取消').click();
    assert.equal(await next().isVisible(), true, '取消编辑后恢复箭头');
    assert.equal(await footer.isVisible(), true, '取消编辑后恢复底部按钮');
    let index = ids.indexOf(await selected());
    for (; index + 1 < ids.length; index++) await turn(1, ids[index + 1]);
    assert.equal(await next().isDisabled(), true, '最后一条不能继续切换');
    assert.equal(await previous().isEnabled(), true);
    if (mobile) {
        assert.equal(await footerNext().isDisabled(), true, '底部下一条按钮在最后一条也停用');
        assert.equal(await footerPrevious().isEnabled(), true);
    }
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
    if (mobile) {
        assert.equal(await footerPrevious().isDisabled(), true); assert.equal(await footerNext().isDisabled(), true, '底部箭头遵循相同的搜索边界');
    }
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
    assert.deepEqual(await page.evaluate(async () => ({ rows: await runtime.listFavorites(), chat: ctx.chat,
        round: await runtime.getRound(seed.a), settings: JSON.stringify(fixture.settings) })), original,
        '阅读和取消编辑不修改收藏内容、来源演出、聊天或最终设置');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, url, checks: '长标题换行、角色和图标同行、手机顶部箭头随文滚动与底部布局、电脑底部仅保留靠右回顶、首尾停用、目录跨页、拖动取消、原生触控、键盘、编辑保护、搜索与排序、数据不变', errors }));
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
