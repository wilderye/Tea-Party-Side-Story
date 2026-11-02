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
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const button = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true });
const panel = page => page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
const branch = page => panel(page).locator('.play-branch-page');
const record = (page, id) => panel(page).locator(`[data-record="${id}"]`);
const field = (scope, role) => scope.getByRole('textbox', { name: role === 'user' ? '提示词原文' : '回复原文', exact: true });
const settle = page => page.waitForTimeout(150);
async function openChat(page, id) {
    if (!await panel(page).locator('.play-history-directory').isVisible()) await button(panel(page), '历史记录').click();
    await panel(page).locator(`[data-chat-id="${id}"] .play-history-open`).click();
    await branch(page).locator('.play-assistant-message').first().waitFor(); await settle(page);
}
async function openRecords(page) {
    if (!await panel(page).locator('.play-history-directory').isVisible()) await button(panel(page), '历史记录').click();
    await button(panel(page), '历史记录').click(); await settle(page);
}
async function setup(page, url) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await button(page, '打开小剧场面板').click(); await button(panel(page), '剧场演出').click();
    await panel(page).locator('.play-record').first().waitFor();
    return page.evaluate(async () => {
        const source = await runtime.getChat(seed.a);
        const first = await runtime.createBranch(source.id, source.messages[1].id);
        const second = await runtime.createBranch(source.id, source.messages[1].id);
        window.editWrites = [];
        for (const name of ['editPrompt', 'editResult', 'editMessage']) {
            const original = runtime[name].bind(runtime);
            runtime[name] = async (...args) => { editWrites.push({ name, id: args[0] }); return original(...args); };
        }
        return { a: seed.a, b: seed.b, hidden: seed.hidden, first: first.id, second: second.id };
    });
}
async function verifySwitch(page, url) {
    const ids = await setup(page, url), a = record(page, ids.a);
    await button(a, '修改提示词').click(); await field(a, 'user').fill('演出记录先保存的用户正文');
    await button(a, '编辑回复原文').click(); await field(a, 'assistant').waitFor();
    assert.equal(await field(a, 'user').count(), 0);
    assert.equal((await page.evaluate(id => runtime.getRound(id), ids.a)).prompt, '演出记录先保存的用户正文');
    await field(a, 'assistant').fill('从演出记录转到同一消息聊天视图');
    await openChat(page, ids.a);
    const ai = branch(page).locator('.play-assistant-message').first();
    const before = await page.evaluate(() => editWrites.length);
    assert.equal(before, 1, '仅切页不保存');
    await button(ai, '编辑回复原文').click();
    await field(ai, 'assistant').waitFor();
    assert.equal(await field(ai, 'assistant').inputValue(), '从演出记录转到同一消息聊天视图', '两页从当前正文打开编辑，不等待后台保存');
    await field(ai, 'assistant').fill('从聊天转回演出记录'); await openRecords(page);
    await button(record(page, ids.a), '编辑回复原文').click();
    assert.equal(await field(record(page, ids.a), 'assistant').inputValue(), '从聊天转回演出记录');
    await field(record(page, ids.a), 'assistant').fill('跨分支先保存');
    await openChat(page, ids.first); await button(branch(page).locator('.play-assistant-message').first(), '编辑回复原文').click();
    await field(branch(page), 'assistant').fill('分支一先保存');
    await openChat(page, ids.second); await button(branch(page).locator('.play-assistant-message').first(), '编辑回复原文').click();
    await field(branch(page), 'assistant').fill('分支二先保存');
    assert.equal((await page.evaluate(id => runtime.getChat(id), ids.first)).messages[1].results[0].text, '分支一先保存');
    await openRecords(page);
    if (page.viewportSize().width <= 760) await button(panel(page), '选择角色').click();
    await button(panel(page).locator('.play-people'), '测试乙').click();
    await button(record(page, ids.b), '编辑回复原文').click(); await field(record(page, ids.b), 'assistant').waitFor();
    assert.equal((await page.evaluate(id => runtime.getChat(id), ids.second)).messages[1].results[0].text, '分支二先保存');
    assert.equal(await page.locator('.play-feed .play-edit-form').count(), 1);
    await button(record(page, ids.b), '取消').click();
    assert.equal(await page.evaluate(() => captured.length), 0);
    assert.deepEqual(await page.evaluate(() => ctx.chat), [{ mes: '原聊天', is_user: false }]);
}
async function verifyFailure(page, url, sourcePage) {
    const ids = await setup(page, url);
    if (sourcePage === 'chat') await openChat(page, ids.first);
    const source = sourcePage === 'chat' ? branch(page).locator('.play-assistant-message').first() : record(page, ids.a);
    await button(source, '编辑回复原文').click();
    const input = field(source, 'assistant');
    await input.fill('保存失败时保留的草稿\n'.repeat(70));
    const state = await input.evaluate(node => { node.setSelectionRange(4, 12); node.scrollTop = 400; window.originalEditor = node; return { start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop, value: node.value }; });
    if (sourcePage === 'chat') await openRecords(page); else await openChat(page, ids.first);
    await page.evaluate(() => { window.failSave = true; });
    const target = sourcePage === 'chat' ? record(page, ids.a) : branch(page).locator('.play-assistant-message').first();
    await button(target, '编辑回复原文').click();
    await field(target, 'assistant').waitFor();
    await page.waitForFunction(() => saveErrors.length === 1);
    assert.equal(await input.count(), 0);
    assert.equal(await page.evaluate(({ id, state }) => runtime.session.currentRound(id).results[0].text === state.value,
        { id: sourcePage === 'chat' ? ids.first : ids.a, state }), true);
    await field(target, 'assistant').fill('B 的新草稿');
    assert.equal(await field(target, 'assistant').inputValue(), 'B 的新草稿');
    assert.equal(await page.locator('.play-feed .play-edit-form').count(), 1);
    if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `cross-page-failure-${sourcePage}-${page.viewportSize().width}.png`) });
    await page.evaluate(() => { window.failSave = false; });
    await page.evaluate(id => runtime.session.flush(id), sourcePage === 'chat' ? ids.first : ids.a);
    assert.equal(await field(target, 'assistant').inputValue(), 'B 的新草稿');
    await button(target, '取消').click();
    assert.equal(await page.evaluate(() => captured.length), 0);
}
async function verifyRace(page, url) {
    const ids = await setup(page, url);
    const a = record(page, ids.a), b = record(page, ids.hidden);
    await button(a, '修改提示词').click(); await field(a, 'user').fill('A 后台保存');
    await page.evaluate(() => { window.holdSave = true; window.resumeSave = null; });
    await button(b, '修改提示词').click(); await page.waitForFunction(() => typeof resumeSave === 'function');
    await field(b, 'user').waitFor();
    assert.equal(await field(a, 'user').count(), 0);
    await field(b, 'user').fill('B 编辑中的草稿');
    await page.evaluate(() => { window.holdSave = false; resumeSave(); });
    await page.evaluate(id => runtime.session.flush(id), ids.a);
    assert.deepEqual(await page.evaluate(() => editWrites.map(write => write.name)), ['editPrompt']);
    assert.equal(await field(b, 'user').inputValue(), 'B 编辑中的草稿');
    await button(b, '保存').click(); await field(b, 'user').waitFor({ state: 'detached' });
    assert.equal((await page.evaluate(id => runtime.getRound(id), ids.hidden)).prompt, 'B 编辑中的草稿');
}
async function verifyCharacterFailure(page, url) {
    const ids = await setup(page, url), source = record(page, ids.a);
    await button(source, '编辑回复原文').click(); await field(source, 'assistant').fill('跨角色保存失败的草稿');
    if (page.viewportSize().width <= 760) await button(panel(page), '选择角色').click();
    await button(panel(page).locator('.play-people'), '测试乙').click();
    await page.evaluate(() => { window.failSave = true; });
    await button(record(page, ids.b), '编辑回复原文').click();
    await field(record(page, ids.b), 'assistant').waitFor();
    await page.waitForFunction(() => saveErrors.length === 1);
    assert.equal(await field(source, 'assistant').count(), 0);
    assert.equal(await page.evaluate(id => runtime.session.currentRound(id).results[0].text, ids.a), '跨角色保存失败的草稿');
    await button(record(page, ids.b), '取消').click();
    assert.equal(await page.evaluate(() => captured.length), 0);
}
async function verifyDeletedSource(page, url, mode) {
    const ids = await setup(page, url);
    if (mode === 'chat') await openChat(page, ids.first);
    const source = mode === 'chat' ? branch(page).locator('.play-assistant-message').first() : record(page, ids.a);
    await button(source, '编辑回复原文').click(); const input = field(source, 'assistant');
    await input.fill('来源删除之后仍然保留的草稿');
    await input.evaluate(node => { window.originalEditor = node; });
    if (mode === 'chat') await openRecords(page); else await openChat(page, ids.first);
    await page.evaluate(id => testHistory.deleteChat(id), mode === 'chat' ? ids.first : ids.a);
    const target = mode === 'chat' ? record(page, ids.a) : branch(page).locator('.play-assistant-message').first();
    await button(target, '编辑回复原文').click();
    await field(target, 'assistant').waitFor();
    await page.waitForFunction(() => saveErrors.some(error => /已删除|已不存在/.test(error))); await settle(page);
    assert.equal(await input.count(), 0);
    assert.equal(await page.evaluate(id => runtime.session.currentRound(id).results[0].text, mode === 'chat' ? ids.first : ids.a), '来源删除之后仍然保留的草稿');
    assert.equal(await page.locator('.play-feed .play-edit-form').count(), 1);
    await button(target, '取消').click();
    assert.equal(await page.evaluate(() => captured.length), 0);
}
async function verifyRefreshFailure(page, url, mode) {
    const ids = await setup(page, url);
    if (mode === 'chat') await openChat(page, ids.first);
    const source = mode === 'chat' ? branch(page).locator('.play-user-message').first() : record(page, ids.a);
    const target = mode === 'chat' ? branch(page).locator('.play-assistant-message').first() : record(page, ids.hidden);
    await button(source, mode === 'chat' ? '修改用户消息' : '修改提示词').click();
    const input = source.getByRole('textbox', { name: mode === 'chat' ? '用户消息原文' : '提示词原文', exact: true });
    await input.fill('已保存后页面读取出错');
    await page.evaluate(mode => {
        const saving = runtime[mode === 'chat' ? 'editMessage' : 'editPrompt'];
        runtime[mode === 'chat' ? 'editMessage' : 'editPrompt'] = async (...args) => {
            const result = await saving(...args);
            const name = mode === 'chat' ? 'getChat' : 'getRound', read = runtime[name];
            runtime[name] = async (...args) => {
                window.afterSaveReads = (window.afterSaveReads ?? 0) + 1;
                throw Error('不应发生保存后重新读取');
            };
            return result;
        };
    }, mode);
    await button(target, mode === 'chat' ? '编辑回复原文' : '修改提示词').click();
    await target.getByRole('textbox', { name: mode === 'chat' ? '回复原文' : '提示词原文', exact: true }).waitFor();
    assert.equal(await input.count(), 0);
    assert.equal(await page.evaluate(id => runtime.session.currentRound(id).prompt, mode === 'chat' ? ids.first : ids.a), '已保存后页面读取出错');
    assert.equal(await page.evaluate(() => window.afterSaveReads ?? 0), 0);
    assert.equal(await page.evaluate(() => editWrites.length), 1);
    await button(target, '取消').click();
}
async function verifyOffscreenSave(page, url) {
    const ids = await setup(page, url), a = record(page, ids.a), b = record(page, ids.hidden);
    await page.evaluate(async id => {
        const round = await runtime.getRound(id);
        await testHistory.editPrompt(id, '后面消息的长正文。\n\n'.repeat(80), round.prompt);
        await ui.refresh();
    }, ids.hidden);
    await button(a, '编辑回复原文').click();
    const input = field(a, 'assistant'); await input.fill('保存后恢复为很长的正文。\n\n'.repeat(150));
    await b.evaluate((node, offset) => {
        const feed = node.closest('.play-feed'); feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - offset;
    }, page.viewportSize().width <= 760 ? 44 : 0); await settle(page);
    assert.ok(await a.locator('.play-assistant-message').evaluate(node => node.getBoundingClientRect().bottom <= node.closest('.play-feed').getBoundingClientRect().top + 44), '旧编辑已离开可见区域');
    const before = await b.evaluate(node => node.getBoundingClientRect().top);
    await button(b, '修改提示词').click(); await field(b, 'user').waitFor(); await settle(page);
    const after = await b.evaluate(node => node.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) < 2, `屏幕外旧编辑恢复成长正文时保持新消息位置：${JSON.stringify({ before, after })}`);
    await button(b, '取消').click();
}
async function gesture(page, client, x, y, distance) {
    const point = { x, y, radiusX: 4, radiusY: 4, force: 1 };
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    for (let step = 1; step <= 12; step++) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: y + distance * step / 12 }] });
        await page.waitForTimeout(22);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(450);
}
async function verifyTouch(page, url, mode) {
    const ids = await setup(page, url);
    if (mode === 'chat') await openChat(page, ids.first);
    const item = mode === 'chat' ? branch(page).locator('.play-assistant-message').first() : record(page, ids.a).locator('.play-assistant-message');
    await button(item, '编辑回复原文').click(); const input = field(item, 'assistant');
    await input.fill('第一个段落，窗外的雨停了。\n\n'.repeat(100));
    const bounds = await input.evaluate(node => {
        const feed = node.closest('.play-feed').getBoundingClientRect(), field = node.getBoundingClientRect();
        return { left: field.left - feed.left, right: feed.right - field.right };
    });
    if (page.viewportSize().width <= 760) { assert.equal(bounds.left, 28); assert.equal(bounds.right, 28); }
    const client = await page.context().newCDPSession(page);
    const prepare = async () => {
        await input.evaluate(node => { const feed = node.closest('.play-feed'); feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top + 100; node.scrollTop = 550; });
        await settle(page);
    };
    const state = () => input.evaluate(node => ({ outer: node.closest('.play-feed').scrollTop, inner: node.scrollTop }));
    for (const side of ['left', 'right', 'inside']) {
        await prepare();
        const target = await input.evaluate((node, side) => {
            const area = node.closest('.play-feed').getBoundingClientRect(), field = node.getBoundingClientRect();
            return { x: side === 'left' ? field.left - 13 : side === 'right' ? field.right + 13 : field.left + field.width / 2, y: area.top + Math.min(160, area.height * .3) };
        }, side);
        const before = await state(); await gesture(page, client, target.x, target.y, 130); const after = await state();
        if (side === 'inside') { assert.ok(Math.abs(after.inner - before.inner) > 40); assert.ok(Math.abs(after.outer - before.outer) < 2); }
        else { assert.ok(Math.abs(after.outer - before.outer) > 40, `${mode} ${side} 框外滑动聊天`); assert.equal(after.inner, before.inner); }
    }
    await item.evaluate(node => { const feed = node.closest('.play-feed'); feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - 110; }); await settle(page);
    for (const name of ['保存', '取消']) {
        const action = button(item, name), box = await action.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44);
        assert.equal(await action.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true);
    }
    if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `touch-${mode}-${page.viewportSize().width}.png`) });
    await button(item, '取消').click(); assert.equal(await page.evaluate(() => captured.length), 0);
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 390, height: 844 }, { width: 1332, height: 896 }]) {
            for (const [name, verify] of [['switch', verifySwitch], ['failure-record', (page, url) => verifyFailure(page, url, 'record')], ['failure-chat', (page, url) => verifyFailure(page, url, 'chat')], ['failure-character', verifyCharacterFailure], ['race', verifyRace], ['offscreen', verifyOffscreenSave],
                ['deleted-record', (page, url) => verifyDeletedSource(page, url, 'record')], ['deleted-chat', (page, url) => verifyDeletedSource(page, url, 'chat')],
                ['refresh-record', (page, url) => verifyRefreshFailure(page, url, 'record')], ['refresh-chat', (page, url) => verifyRefreshFailure(page, url, 'chat')],
                ['touch-record', (page, url) => verifyTouch(page, url, 'record')], ['touch-chat', (page, url) => verifyTouch(page, url, 'chat')]]) {
                const context = await browser.newContext({ viewport, hasTouch: true }), page = await context.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
                try {
                    await verify(page, `http://127.0.0.1:${server.address().port}/`);
                    assert.deepEqual(errors, []); assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
                    console.log(JSON.stringify({ name, viewport, passed: true, errors }));
                } finally { await context.close(); }
            }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
