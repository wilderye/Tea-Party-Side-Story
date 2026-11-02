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
const settle = async page => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(80);
};
async function align(page, item, offset = 120) {
    await item.evaluate((node, offset) => {
        const feed = node.closest('.play-feed');
        feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - offset;
    }, offset);
    await settle(page);
}
async function clickWithoutScroll(page, locator, anchor) {
    const box = await locator.boundingBox(); assert.ok(box);
    assert.ok(await locator.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), { x: box.x + box.width / 2, y: box.y + box.height / 2 }), '按钮位于实际可点击的位置');
    if (anchor) await anchor.evaluate(node => {
        const read = () => node.getBoundingClientRect().top - node.closest('.play-feed').getBoundingClientRect().top;
        const before = read();
        window.positionFrames = new Promise(resolve => {
            document.addEventListener('pointerdown', () => {
                const samples = [];
                const sample = () => { samples.push(read() - before); if (samples.length < 6) requestAnimationFrame(sample); else resolve(samples); };
                requestAnimationFrame(sample);
            }, { once: true });
        });
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page);
    if (anchor) assert.ok((await page.evaluate(() => window.positionFrames)).every(delta => Math.abs(delta) < 2), '编辑切换的连续画面没有中间跳动');
}
const offset = item => item.evaluate(node => node.getBoundingClientRect().top - node.closest('.play-feed').getBoundingClientRect().top);
const inputState = editor => editor.evaluate(node => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop }));
async function seed(page, mode) {
    return page.evaluate(async mode => {
        const text = Array.from({ length: 65 }, (_, index) => `第 ${index + 1} 段：雨声渐渐停下，茶壶中的水仍在轻轻沸腾。`).join('\n\n');
        const original = await runtime.getRound(seed.a), context = original.results[0].context;
        if (mode === 'chat') {
            const source = await runtime.getChat(seed.a), branch = await runtime.createBranch(source.id, source.messages[1].id);
            for (let index = 0; index < 30; index++) {
                const resultId = crypto.randomUUID(), stamp = new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString();
                await testHistory.begin({ roundId: branch.id, chatMode: true, operation: 'send', character: ctx.characters[0],
                    prompt: text, resultId, startedAt: stamp, context });
                await testHistory.saveResult(branch.id, resultId, { text, status: 'complete', finishedAt: stamp });
            }
            return { id: branch.id };
        }
        for (let index = 0; index < 30; index++) {
            const resultId = crypto.randomUUID(), stamp = new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString();
            const round = await testHistory.begin({ character: ctx.characters[0], prompt: text, resultId, startedAt: stamp, context });
            await testHistory.saveResult(round.id, resultId, { text, status: 'complete', finishedAt: stamp });
        }
        return {};
    }, mode);
}
async function verify(page, url, viewport, mode) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    const ids = await seed(page, mode);
    await button(page, '打开小剧场面板').click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    await button(panel, '剧场演出').click();
    if (mode === 'chat') {
        await button(panel, '历史记录').click();
        await panel.locator(`[data-chat-id="${ids.id}"] .play-history-open`).click();
    }
    const scope = panel.locator(mode === 'chat' ? '.play-branch-page' : '.play-page:not(.play-history-page):not(.play-branch-page)');
    const feed = scope.locator('.play-feed');
    await scope.locator('.play-assistant-message').first().waitFor(); await settle(page);
    if (mode === 'chat') await button(scope, '显示更早的消息').click();
    else await scope.locator('.play-earlier-bar').evaluate(node => node.click());
    await page.waitForFunction(mode => document.querySelectorAll(mode === 'chat' ? '.tea-panel-surface[data-active=true] .play-branch-page [data-message-id]' : '.tea-panel-surface[data-active=true] .play-record:not([hidden])').length > (mode === 'chat' ? 24 : 10), mode);
    const initial = scope.locator('.play-assistant-message:not([hidden] *)').nth(2);
    const key = await initial.evaluate(node => node.dataset.messageId ?? node.closest('[data-record]').dataset.record);
    const item = mode === 'chat' ? scope.locator(`[data-message-id="${key}"]`) : scope.locator(`[data-record="${key}"] .play-assistant-message`);
    await align(page, item);
    const before = await offset(item);
    await clickWithoutScroll(page, button(item, '编辑回复原文'), item);
    const editor = item.getByRole('textbox', { name: '回复原文', exact: true });
    assert.ok(Math.abs(await offset(item) - before) < 2, '点击编辑保留同一消息的位置');
    assert.equal(await scope.locator('.play-compose').isVisible(), true);
    if (viewport.width <= 760) assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), true);
    await editor.evaluate(node => {
        window.editNode = node;
        node.value += '\n尚未保存的草稿'; node.dispatchEvent(new Event('input', { bubbles: true }));
        node.setSelectionRange(8, 20); node.scrollTop = 160;
    });
    const saved = await inputState(editor);
    await button(item, '更多回复操作').click(); await button(item, '查看实际提示词').click();
    await panel.getByRole('dialog', { name: '实际发送的提示词', exact: true }).waitFor();
    await button(panel, '关闭提示词查看').click();
    assert.deepEqual(await inputState(editor), saved, '查看提示词保留编辑内容和选区');
    await page.evaluate(() => ui.refresh()); await settle(page);
    assert.equal(await editor.evaluate(node => node === window.editNode), true);
    assert.deepEqual(await inputState(editor), saved, '刷新不替换编辑正文');
    await button(panel, '关闭面板').click(); await button(page, '打开小剧场面板').click(); await settle(page);
    await editor.waitFor();
    assert.deepEqual(await inputState(editor), saved, '重开旧消息附近的历史范围保留编辑');
    await button(scope, '跳到最新消息').click(); await settle(page);
    await page.waitForFunction(() => {
        const feed = document.querySelector('.tea-panel-surface[data-active=true] .play-feed');
        return feed.scrollHeight - feed.clientHeight - feed.scrollTop < 2;
    });
    assert.equal(await editor.isVisible(), false, '最新历史窗口不强行包含旧编辑消息');
    if (mode === 'chat') await button(scope, '显示更早的消息').click();
    else await scope.locator('.play-earlier-bar').evaluate(node => node.click());
    await editor.waitFor(); await settle(page);
    assert.equal(await editor.evaluate(node => node === window.editNode), true);
    assert.deepEqual(await inputState(editor), saved, '跨历史范围返回恢复同一编辑框、草稿、选区和框内位置');
    await align(page, item);
    await button(panel, '茶会选集').click(); await button(panel, '剧场演出').click(); await settle(page);
    await editor.waitFor(); assert.deepEqual(await inputState(editor), saved, '栏目往返保留编辑');
    await button(panel, '设置').click();
    const settings = panel.locator('.tea-settings-layer'); await settings.waitFor();
    await button(settings, viewport.width <= 760 ? '返回剧场演出' : '设置').click(); await settings.waitFor({ state: 'detached' }); await settle(page);
    assert.deepEqual(await inputState(editor), saved, '设置往返保留草稿、选区和框内位置');
    if (mode === 'chat') {
        await button(panel, '历史记录').click();
        await panel.locator(`[data-chat-id="${ids.id}"] .play-history-open`).click(); await editor.waitFor(); await settle(page);
    } else {
        if (viewport.width <= 760) await button(panel, '选择角色').click();
        await button(panel.locator('.play-people'), '测试乙').click(); await settle(page);
        if (viewport.width <= 760) await button(panel, '选择角色').click();
        await button(panel.locator('.play-people'), '测试甲').click(); await editor.waitFor(); await settle(page);
    }
    assert.deepEqual(await inputState(editor), saved, '角色或历史记录往返保留编辑');
    await button(panel, '关闭面板').click(); await button(page, '打开小剧场面板').click(); await settle(page);
    await editor.waitFor(); assert.deepEqual(await inputState(editor), saved, '关闭重开面板保留编辑');
    await align(page, item);
    await editor.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const selection = await editor.evaluate(node => [node.selectionStart, node.selectionEnd]);
    await item.locator('.play-message-top').evaluate(node => {
        const feed = node.closest('.play-feed');
        feed.scrollTop += node.getBoundingClientRect().bottom - feed.getBoundingClientRect().bottom + 56;
    }); await settle(page);
    await clickWithoutScroll(page, button(item, '回到这条消息开头'));
    assert.equal(await editor.evaluate(node => node.scrollTop), 0);
    assert.deepEqual(await editor.evaluate(node => [node.selectionStart, node.selectionEnd]), selection);
    assert.equal(await editor.evaluate(node => node === window.editNode), true);
    await align(page, item, 180);
    const beforeCancel = await offset(item);
    await clickWithoutScroll(page, button(item, '取消'), item);
    assert.ok(Math.abs(await offset(item) - beforeCancel) < 2, '取消保留退出前的位置');
    await clickWithoutScroll(page, button(item, '编辑回复原文'));
    await editor.evaluate(node => { node.value += '\n保存的修改'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => { window.holdSave = true; });
    await clickWithoutScroll(page, button(item, '保存')); await page.waitForFunction(() => typeof window.resumeSave === 'function');
    await feed.evaluate(node => { node.scrollTop += 50; }); await settle(page);
    const beforeSave = await offset(item);
    await page.evaluate(() => { window.holdSave = false; window.resumeSave(); window.resumeSave = null; });
    await editor.waitFor({ state: 'detached' }); await settle(page);
    assert.ok(Math.abs(await offset(item) - beforeSave) < 2, '保存等待期间滚动后，保留实际退出前的位置');
    assert.equal(await page.evaluate(() => captured.length), 0, '阅读与编辑不发送模型请求');
    const composer = scope.getByRole('textbox', { name: mode === 'chat' ? '分支聊天输入' : '小剧场提示词', exact: true });
    await composer.fill('模拟生成请求'); await scope.locator('.play-send').click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await page.evaluate(() => emitGeneration('正在生成的正文')); await settle(page);
    await composer.fill('下一条尚未发送的草稿');
    assert.equal(await button(scope, '停止所有生成').isEnabled(), true);
    const previousId = await scope.locator('.play-assistant-message:not([hidden] *)').first().evaluate(node => node.dataset.messageId ?? node.closest('[data-record]').dataset.record);
    const previous = mode === 'chat' ? scope.locator(`[data-message-id="${previousId}"]`) : scope.locator(`[data-record="${previousId}"] .play-assistant-message`);
    await align(page, previous); await clickWithoutScroll(page, button(previous, '编辑回复原文'));
    const anotherEditor = previous.getByRole('textbox', { name: '回复原文', exact: true });
    await anotherEditor.evaluate(node => { node.value += '\n生成期间的草稿'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await button(scope, '停止所有生成').isEnabled(), true);
    await button(previous, '更多回复操作').click();
    assert.equal(await button(previous, '删除 AI 消息').isDisabled(), true);
    assert.equal(await button(previous, '创建分支').isDisabled(), true);
    await button(previous, '删除 AI 消息').press('Escape');
    await page.evaluate(() => emitGeneration('编辑过程中仍然收到的正文')); await settle(page);
    assert.ok((await anotherEditor.inputValue()).endsWith('生成期间的草稿'));
    if (mode === 'chat') {
        assert.equal(await scope.locator('.play-send').isDisabled(), true);
        await composer.press('Control+Enter');
        assert.equal(await page.evaluate(() => runtime.getStates()[0].phase), 'generating', '发送快捷键不会停止');
        const state = await inputState(anotherEditor);
        const otherUserId = await previous.evaluate(node => node.previousElementSibling.dataset.messageId);
        await button(scope.locator(`[data-message-id="${otherUserId}"]`), '收藏用户消息').click(); await settle(page);
        assert.deepEqual(await inputState(anotherEditor), state, '收藏另一条消息不覆盖当前编辑');
        await page.evaluate(() => { ctx.POPUP_TYPE.INPUT = 3; ctx.callGenericPopup = async (_body, type) => type === 3 ? '编辑期间改过的聊天名称' : 1; });
        await button(scope, '聊天操作').click(); assert.equal(await button(scope, '修改聊天名称').isEnabled(), true);
        await button(scope, '修改聊天名称').click();
        await scope.getByText('编辑期间改过的聊天名称', { exact: true }).waitFor(); await settle(page);
        assert.deepEqual(await inputState(anotherEditor), state, '聊天改名不替换编辑正文或选区');
    }
    if (process.env.TEA_QA_DIR) {
        await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `edit-navigation-${mode}-${viewport.width}.png`) });
    }
    await button(scope, '停止所有生成').click(); await page.waitForFunction(() => runtime.getStates().length === 0);
    assert.equal(await composer.inputValue(), '下一条尚未发送的草稿');
    assert.ok((await anotherEditor.inputValue()).endsWith('生成期间的草稿'));
    await button(previous.locator('.play-header-actions .play-edit-actions'), '取消').click();
    const source = await previous.evaluate(node => ({ id: node.dataset.messageId ?? node.closest('[data-record]').dataset.record }));
    await align(page, previous); await clickWithoutScroll(page, button(previous, '编辑回复原文'));
    await anotherEditor.evaluate(node => { node.value += '\n来源删除后保留的草稿'; node.dispatchEvent(new Event('input', { bubbles: true })); node.setSelectionRange(5, 15); node.scrollTop = 110; });
    const missingState = await inputState(anotherEditor);
    await page.evaluate(async ({ mode, id, chatId }) => {
        if (mode === 'chat') await testHistory.removeMessage(chatId, id);
        else await testHistory.deleteChat(id);
        ui.refresh();
    }, { mode, id: source.id, chatId: ids.id });
    await settle(page); await anotherEditor.waitFor();
    assert.deepEqual(await inputState(anotherEditor), missingState, '来源删除后保留可读取的原草稿');
    await button(previous.locator('.play-header-actions .play-edit-actions'), '保存').click(); await previous.getByRole('alert').waitFor();
    assert.equal(await anotherEditor.inputValue(), missingState.value, '来源缺失时保存报错且不覆盖草稿');
    await button(previous.locator('.play-header-actions .play-edit-actions'), '取消').click(); await anotherEditor.waitFor({ state: 'detached' });
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(), 0);
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    console.log(JSON.stringify({ mode, viewport, position: 'stable', editor: 'preserved', navigation: 'available', stop: 'independent', passed: true }));
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) for (const mode of ['play', 'chat']) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            try { await verify(page, `http://127.0.0.1:${server.address().port}/`, viewport, mode); assert.deepEqual(errors, []); }
            catch (error) {
                if (process.env.TEA_QA_DIR) { await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `failed-${mode}-${viewport.width}.png`) }); }
                throw error;
            }
            finally { await context.close(); }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
