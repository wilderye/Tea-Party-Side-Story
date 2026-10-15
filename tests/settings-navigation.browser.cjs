// Flow: open settings -> change the left selection -> toggle back to the selected content.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
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

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verifyDesktop(page, viewport) {
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const settings = panel.locator('.tea-settings');
    const settingsButton = button('设置');
    const selectedStory = () => panel.locator('.tea-story[aria-current="true"]').getAttribute('data-id');
    const positions = async () => ({ settings: await settingsButton.boundingBox(), close: await button('关闭面板').boundingBox() });
    const settingsState = () => settings.evaluate(node => ({
        scroll: node.scrollTop,
        prompt: node.querySelector('[aria-label="自定义小剧场提示词"]').value,
        rulesOpen: node.querySelector('.play-regex-list').open,
    }));
    const expectSettings = async saved => {
        await settle(page);
        assert.equal(await panel.getAttribute('data-mode'), 'settings');
        assert.equal(await settingsButton.getAttribute('aria-pressed'), 'true');
        if (saved) assert.deepEqual(await settingsState(), saved, '操作左侧目录后，设置值、展开状态和滚动位置不变');
    };
    const before = await positions();
    await screenshot(page, `library-${viewport.width}.png`);
    await settingsButton.click();
    await expectSettings();
    assert.deepEqual(await positions(), before, '进入设置后，设置按钮和关闭按钮不移动');
    assert.deepEqual(await panel.locator('.tea-tabs:visible button').allTextContents(), ['茶会选集', '亲笔手稿', '我的收藏', '剧场演出']);
    assert.equal(await panel.locator('.tea-view-title > button').count(), 0, '电脑设置标题不再显示返回箭头');
    await settings.getByRole('textbox', { name: '自定义小剧场提示词', exact: true }).fill('保留正在调整的设置。');
    await settings.locator('.play-regex-list > summary').click();
    await settings.getByRole('checkbox', { name: '全局替换', exact: true }).waitFor();
    await settings.evaluate(node => { node.scrollTop = 300; });
    const saved = await settingsState();
    assert.ok(saved.scroll > 0, '实际滚动设置后再验证位置保持');
    await button('目录剧场 1').click();
    await expectSettings(saved);
    assert.equal(await selectedStory(), 'navigation:1');
    await settingsButton.click();
    assert.equal(await panel.locator('.tea-reading').getAttribute('data-id'), 'navigation:1', '关闭设置显示刚选中的剧场');
    assert.equal(await settingsButton.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await positions(), before);

    await settingsButton.click();
    await settings.evaluate(node => { node.scrollTop = 200; });
    const catalogState = await settingsState();
    await panel.getByRole('navigation', { name: '剧场分类' }).getByRole('button', { name: '随文剧场', exact: true }).click();
    await expectSettings(catalogState);
    await panel.getByRole('navigation', { name: '剧场分类' }).getByRole('button', { name: '全部', exact: true }).click();
    await button('下一页').click();
    await expectSettings(catalogState);
    await panel.locator('.tea-story').first().click();
    const nextPageStory = await selectedStory();
    await settingsButton.click();
    assert.equal(await panel.locator('.tea-reading').getAttribute('data-id'), nextPageStory);

    await settingsButton.click();
    const sortState = await settingsState();
    await button('排序方式').click();
    await panel.getByRole('menuitemradio', { name: '随机顺序', exact: true }).click();
    await expectSettings(sortState);
    await button('重新打乱').click();
    await expectSettings(sortState);
    await panel.getByRole('searchbox').fill('目录剧场 2');
    await expectSettings(sortState);
    await panel.locator('.tea-story').first().click();
    const searchedStory = await selectedStory();
    await settingsButton.click();
    assert.equal(await panel.locator('.tea-reading').getAttribute('data-id'), searchedStory);
    await panel.getByRole('searchbox').fill('');
    await settingsButton.click();
    await button('亲笔手稿').click();
    assert.equal(await panel.getAttribute('data-mode'), 'list', '点击顶部其它栏目退出设置');
    assert.equal(await button('亲笔手稿').getAttribute('aria-pressed'), 'true');

    await button('剧场演出').click();
    await panel.locator('.play-people').getByRole('button', { name: '测试甲', exact: true }).waitFor();
    const playPositions = await positions();
    await settingsButton.click();
    assert.deepEqual(await positions(), playPositions);
    await settings.evaluate(node => { node.scrollTop = 320; });
    const characterState = await settingsState();
    await panel.locator('.play-people').getByRole('button', { name: '测试乙', exact: true }).click();
    await expectSettings(characterState);
    assert.equal(await panel.locator('.play-people').getByRole('button', { name: '测试乙', exact: true }).getAttribute('aria-pressed'), 'true');
    await settings.evaluate(node => { node.scrollTop = 0; });
    await screenshot(page, `settings-character-${viewport.width}.png`);
    const topbar = panel.locator('.tea-topbar:visible');
    const controls = await topbar.locator('button').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right };
    }));
    const bar = await topbar.boundingBox();
    assert.ok(controls.every(control => control.left >= bar.x && control.right <= bar.x + bar.width), '顶部按钮在窄电脑窗口里也不超出面板');
    assert.ok(controls.every((control, index) => !index || control.left >= controls[index - 1].right), '顶部栏目和按钮不重叠');
    await settingsButton.click();
    await panel.getByText('乙的旧记录 甲的规则', { exact: true }).waitFor();
    assert.equal(await panel.locator('.play-record:visible').count(), 1);
    await screenshot(page, `selected-character-${viewport.width}.png`);

    await button('我的收藏').click();
    await settingsButton.click();
    await settings.evaluate(node => { node.scrollTop = 180; });
    const favoriteState = await settingsState();
    await panel.getByRole('navigation', { name: '收藏分类' }).getByRole('button', { name: '演出记录', exact: true }).click();
    await panel.locator('.tea-story').nth(1).waitFor();
    await expectSettings(favoriteState);
    const target = panel.locator('.tea-story').nth(1), favoriteId = await target.getAttribute('data-id');
    await target.click();
    await expectSettings(favoriteState);
    await settingsButton.click();
    const favorite = await page.evaluate(id => runtime.getFavorite(id), favoriteId);
    await panel.locator('.play-favorite-reading:visible').waitFor();
    assert.equal(await selectedStory(), favoriteId);
    assert.equal(await panel.locator('.play-favorite-reading:visible .play-favorite-character').innerText(), favorite.characterName);
    const expectedText = favorite.characterName === '测试乙' ? '乙的旧记录' : '小剧场正文';
    await panel.locator('.play-favorite-reading:visible .play-favorite-content').getByText(expectedText, { exact: false }).waitFor();
    await settingsButton.click();
    await button('剧场演出').click();
    assert.equal(await panel.getAttribute('data-mode'), 'list');
    await settingsButton.click();
    await button('关闭面板').click();
    await panel.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    assert.equal(await settingsButton.getAttribute('aria-pressed'), 'false', '直接关闭后重开，设置按钮状态正确');
}

async function verifyMobile(page, viewport) {
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('设置').click();
    assert.equal(await panel.getAttribute('data-mode'), 'settings');
    assert.equal(await button('返回列表').isVisible(), true);
    assert.equal(await panel.locator('.tea-topbar:visible').count(), 0);
    await screenshot(page, `settings-mobile-${viewport.width}.png`);
    await button('返回列表').click();
    await button('剧场演出').click();
    await panel.locator('.play-record').first().waitFor();
    await button('设置').click();
    await button('返回剧场演出').click();
    assert.equal(await panel.locator('.play-page').isVisible(), true, '手机仍通过返回按钮回到演出');
    await button('关闭面板').click();
    await panel.waitFor({ state: 'detached' });
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 1000, height: 800 }, { width: 820, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            const url = `http://127.0.0.1:${server.address().port}/`;
            await page.goto(url); await page.waitForFunction(() => window.ready);
            assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
            await page.evaluate(async () => {
                for (let index = 0; index < 40; index++) fixture.community.set(`navigation:${index}`, {
                    id: `navigation:${index}`, title: `目录剧场 ${index}`, author: '测试作者', type: index % 2 ? 'preset' : 'standalone',
                    body: `第 ${index} 篇的正文。`, publishedAt: new Date(Date.UTC(2026, 0, 40 - index)).toISOString(),
                });
                for (const id of [seed.a, seed.b]) {
                    const round = await runtime.getRound(id), result = round.results[0];
                    await runtime.addFavorite({ roundId: id, resultId: result.id, startedAt: result.startedAt, expectedText: result.text, firstLine: id === seed.a ? '甲的收藏正文' : '乙的收藏正文' });
                }
            });
            await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
            await page.locator('#teahouse-panel .tea-list').waitFor();
            await settle(page);
            if (viewport.width > 760) await verifyDesktop(page, viewport); else await verifyMobile(page, viewport);
            assert.deepEqual(await page.evaluate(() => ({ characterId: ctx.characterId, chatId: ctx.chatId, requests: captured.length })),
                { characterId: 0, chatId: 'A-main', requests: 0 }, '浏览目录不切换酒馆聊天，也不发送生成请求');
            assert.deepEqual(errors, [], '没有页面错误或控制台警告');
            console.log(JSON.stringify({ viewport, passed: true, checks: viewport.width > 760
                ? '设置开关、固定顶栏、目录选择与筛选、角色和收藏切换、滚动保持、关闭'
                : '手机设置、返回列表与演出、关闭', errors }));
            await context.close();
        }
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
