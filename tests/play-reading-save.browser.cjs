// Browser plugin not available; use the repository's Playwright/Edge workflow.
// Flow: scroll synthetic history -> save locally -> reopen/reload at the same paragraph.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sharedKey = 'teahouse-play-view-v1';
const readingKey = 'teahouse-play-reading-v1:test-user';
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://test').pathname.slice(1));
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (name === 'scripts/user.js') {
            response.setHeader('Content-Type', 'text/javascript');
            return response.end("export const getCurrentUserHandle = () => 'test-user';");
        }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});

async function open(page) {
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await page.locator('#teahouse-panel').getByRole('button', { name: '剧场演出', exact: true }).filter({ visible: true }).click();
    await page.locator('.play-record:visible').first().waitFor();
    await page.waitForTimeout(500);
}

async function watchSharedSaves(page) {
    await page.evaluate(key => {
        const account = localStorage;
        window.sharedWrites = [];
        ctx.accountStorage = { getItem: name => account.getItem(name), setItem(name, value) {
            if (name === key) window.sharedWrites.push(JSON.parse(value));
            account.setItem(name, value);
        } };
        // Exercise the real production account lookup import, using a synthetic module.
        delete ctx.getCurrentUserHandle;
    }, sharedKey);
}

async function position(page) {
    return page.locator('.play-feed').evaluate(feed => {
        const top = feed.getBoundingClientRect().top;
        const anchor = [...feed.querySelectorAll('[data-read-anchor]')].find(node => node.getClientRects().length
            && node.getBoundingClientRect().height && node.getBoundingClientRect().bottom > top + 1);
        return { anchor: anchor?.dataset.readAnchor, offset: anchor ? top - anchor.getBoundingClientRect().top : null };
    });
}

function samePosition(actual, expected, message) {
    assert.equal(actual.anchor, expected.anchor, message);
    assert.ok(Math.abs(actual.offset - expected.offset) < 2, `${message}: ${JSON.stringify(actual)} / ${JSON.stringify(expected)}`);
}

async function verifyScrolling(page, viewport) {
    await watchSharedSaves(page);
    const legacy = await page.evaluate(key => {
        const value = { format: 1, positions: [], selections: [], drafts: [] };
        localStorage.setItem(key, JSON.stringify(value));
        return JSON.stringify(value);
    }, sharedKey);
    await open(page);
    await page.locator('.play-feed').evaluate(feed => { feed.scrollTop = 380; });
    await page.waitForTimeout(450);
    const expected = await position(page);
    assert.ok(expected.anchor, '测试正文存在可恢复的段落');
    const firstSave = await page.evaluate(key => localStorage.getItem(key), readingKey);
    assert.ok(firstSave, '滚动位置保存到独立存储');
    for (let index = 0; index < 3; index++) {
        await page.locator('.play-feed').evaluate(feed => { feed.scrollTop += 60; });
        await page.waitForTimeout(1400);
    }
    const finalPosition = await position(page);
    assert.equal(await page.evaluate(() => sharedWrites.length), 0, '仅滚动没有安排保存酒馆全部设置');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), sharedKey), legacy, '旧账号数据没有因滚动被改写');
    await page.locator('#teahouse-panel').getByRole('button', { name: '关闭面板', exact: true }).filter({ visible: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => sharedWrites.length), 0, '关闭面板也不会无故保存全部设置');
    await open(page);
    samePosition(await position(page), finalPosition, '关闭重开保持段落和偏移');
    await page.reload();
    await page.waitForFunction(() => window.ready);
    await watchSharedSaves(page);
    await open(page);
    samePosition(await position(page), finalPosition, '刷新页面从独立存储恢复位置');
    assert.equal(await page.evaluate(() => sharedWrites.length), 0);

    const choose = async name => {
        const panel = page.locator('#teahouse-panel');
        if (viewport.width <= 760) await panel.getByRole('button', { name: '选择角色', exact: true }).filter({ visible: true }).click();
        await panel.locator('.play-people').getByRole('button', { name, exact: true }).click();
        await page.waitForTimeout(450);
    };
    await choose('测试乙');
    const b = await page.evaluate(() => seed.b);
    await page.locator(`[data-record="${b}"]:visible`).waitFor();
    await choose('测试甲');
    samePosition(await position(page), finalPosition, '切换角色再返回保持各自阅读位置');
    assert.equal(await page.evaluate(() => sharedWrites.length), 0, '只切换角色不保存酒馆设置');

    const input = page.getByRole('textbox', { name: '小剧场提示词', exact: true });
    await input.fill('尚未发送的合成草稿');
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).drafts.some(([, draft]) => draft.text === '尚未发送的合成草稿'), sharedKey);
    assert.ok(await page.evaluate(() => sharedWrites.length) > 0, '真正编辑草稿仍保存到账号');
    assert.equal(await page.evaluate(key => Object.hasOwn(JSON.parse(localStorage.getItem(key)), 'positions'), sharedKey), false,
        '迁移成功后，草稿保存不再带上阅读位置');
    await page.evaluate(() => { sharedWrites.length = 0; });
    const feedBox = await page.locator('.play-feed').boundingBox();
    await page.mouse.move(feedBox.x + feedBox.width / 2, feedBox.y + feedBox.height / 2);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(1400);
    assert.equal(await page.evaluate(() => sharedWrites.length), 0, '有草稿时，真实滚轮仍不触发账号保存');
    const afterWheel = await position(page);
    await page.reload(); await page.waitForFunction(() => window.ready); await watchSharedSaves(page); await open(page);
    assert.equal(await page.getByRole('textbox', { name: '小剧场提示词', exact: true }).inputValue(), '尚未发送的合成草稿');
    samePosition(await position(page), afterWheel, '草稿和位置分别恢复');
    if (process.env.TEA_QA_DIR) {
        await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `reading-storage-${viewport.width}.png`) });
    }
}

async function verifyLegacyMigration(page) {
    await watchSharedSaves(page);
    const expected = await page.evaluate(key => {
        const value = { format: 1, positions: [[ctx.characters[0].id, { bottom: false, scrollTop: 280 }]],
            selections: [], drafts: [] };
        return value;
    }, sharedKey);
    // The history character ID is generated separately from Tavern's catalog.
    await page.evaluate(async ({ key, value }) => {
        const round = await runtime.getRound(seed.a);
        value.positions[0][0] = round.characterId;
        value.drafts.push([round.characterId, { text: '旧版本保留的草稿', origin: null }]);
        localStorage.setItem(key, JSON.stringify(value));
    }, { key: sharedKey, value: expected });
    const original = await page.evaluate(key => localStorage.getItem(key), sharedKey);
    await open(page);
    assert.equal(await page.getByRole('textbox', { name: '小剧场提示词', exact: true }).inputValue(), '旧版本保留的草稿');
    assert.ok(Math.abs(await page.locator('.play-feed').evaluate(feed => feed.scrollTop) - 280) < 2);
    assert.ok(await page.evaluate(key => localStorage.getItem(key), readingKey));
    assert.equal(await page.evaluate(key => localStorage.getItem(key), sharedKey), original, '迁移只复制阅读位置，不改旧草稿');
    assert.equal(await page.evaluate(() => sharedWrites.length), 0);
}

async function verifyResultSelection(page) {
    await watchSharedSaves(page);
    await page.evaluate(async () => {
        const round = await runtime.getRound(seed.a), resultId = crypto.randomUUID(), startedAt = new Date().toISOString();
        await testHistory.begin({ roundId: round.id, character: ctx.characters[0], resultId, startedAt,
            context: { chatId: 'A-main', apiMode: 'tavern', characterName: '测试甲', presetName: '合成预设' } });
        await testHistory.saveResult(round.id, resultId, { text: '第二个合成生成版本', status: 'complete', finishedAt: startedAt });
        window.selectionRoundId = round.id;
        window.selectionResultId = resultId;
    });
    await open(page);
    const id = await page.evaluate(() => selectionRoundId), record = page.locator(`[data-record="${id}"]`);
    await record.getByRole('button', { name: '上一个结果', exact: true }).click();
    await record.getByRole('button', { name: '第 1 / 2 个结果，选择历史结果', exact: true }).waitFor();
    await record.getByRole('button', { name: '下一个结果', exact: true }).click();
    await record.getByText('第二个合成生成版本', { exact: true }).waitFor();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.selections
        .some(([id, result]) => id === selectionRoundId && result === selectionResultId), sharedKey);
    await page.reload(); await page.waitForFunction(() => window.ready); await watchSharedSaves(page); await open(page);
    await page.locator(`[data-record="${id}"]`).getByRole('button', { name: '第 2 / 2 个结果，选择历史结果', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sharedWrites.length), 0, '恢复已有生成版本选择不会重复保存账号设置');
}

async function verifyDeniedStorage(page) {
    await watchSharedSaves(page);
    await page.evaluate(async key => {
        const round = await runtime.getRound(seed.a);
        localStorage.setItem(key, JSON.stringify({ format: 1, positions: [[round.characterId, { bottom: false, scrollTop: 220 }]],
            drafts: [[round.characterId, { text: '保留的草稿' }]], selections: [] }));
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function(name) {
            if (name.startsWith('teahouse-play-reading-')) throw new DOMException('测试存储被禁止', 'SecurityError');
            return original.call(this, name);
        };
    }, sharedKey);
    await open(page);
    assert.equal(await page.getByRole('textbox', { name: '小剧场提示词', exact: true }).inputValue(), '保留的草稿');
    await page.getByRole('textbox', { name: '小剧场提示词', exact: true }).fill('保存失败后仍可编辑的草稿');
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).drafts.some(([, draft]) => draft.text === '保存失败后仍可编辑的草稿'), sharedKey);
    assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)).positions, sharedKey)).length, 1,
        '独立存储失败时，编辑草稿不删除迁移前的位置');
    assert.equal(await page.locator('.play-record:visible').count() > 0, true, '本地存储失败仍能查看已有正文');
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            for (const mode of ['scrolling', 'migration', 'selection', 'denied']) {
                const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
                await page.goto(`http://127.0.0.1:${server.address().port}/`);
                await page.waitForFunction(() => window.ready);
                assert.equal(await page.title(), '小剧场设置与原文编辑验证');
                if (mode === 'scrolling') await verifyScrolling(page, viewport);
                else if (mode === 'migration') await verifyLegacyMigration(page);
                else if (mode === 'selection') await verifyResultSelection(page);
                else await verifyDeniedStorage(page);
                assert.deepEqual(errors, []);
                console.log(JSON.stringify({ viewport, mode, passed: true, errors }));
                await context.close();
            }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
