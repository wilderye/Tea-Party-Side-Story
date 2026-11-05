// Browser plugin not available. Verify branch editors using synthetic history.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (!/^(?:[\w-]+\.(?:js|css)|vendor\/markdown-it\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(name)) {
            response.statusCode = 404; return response.end();
        }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, name)));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const button = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true });
const longText = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 段：窗外的雨声渐渐停下，茶壶里的水仍在轻轻沸腾。`).join('\n\n');
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function verify(page, url, viewport, nativeSizing) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await button(page, '打开小剧场面板').click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])'); assert.match(await panel.innerText(), /茶话会/);
    await button(panel, '剧场演出').click();
    const id = await page.evaluate(async () => {
        const source = await runtime.getChat(seed.a), branch = await runtime.createBranch(source.id, source.messages[1].id);
        for (let index = 0; index < 5; index++) {
            const stamp = new Date().toISOString(), resultId = crypto.randomUUID();
            await testHistory.begin({ roundId: branch.id, chatMode: true, operation: 'send', character: ctx.characters[0],
                prompt: `后续用户消息 ${index}`, resultId, startedAt: stamp, context: source.messages[1].results[0].context });
            await testHistory.saveResult(branch.id, resultId, { text: `后续 AI 消息 ${index}\n\n` + '虚构的正文段落。'.repeat(30), status: 'complete', finishedAt: stamp });
        }
        return branch.id;
    });
    await button(panel, '历史记录').click(); await panel.locator(`[data-chat-id="${id}"] .play-history-open`).click();
    const scope = panel.locator('.play-branch-page'), feed = scope.locator('.play-feed');
    await scope.locator('.play-assistant-message').nth(1).waitFor(); await settle(page);
    const draft = scope.getByRole('textbox', { name: '分支聊天输入', exact: true, includeHidden: true });
    await draft.fill('尚未发送的草稿。');
    const mobile = viewport.width <= 760, mainChat = await page.evaluate(() => structuredClone(ctx.chat));
    const catalog = panel.locator('.play-catalog:not([hidden])');
    const sheet = panel.locator('.play-edit-sheet');
    for (const role of ['user', 'assistant']) {
        const item = scope.locator(`.play-${role}-message`).nth(1), meta = item.locator('.play-message-meta');
        const name = role === 'user' ? '修改用户消息' : '编辑回复原文', label = role === 'user' ? '用户消息原文' : '回复原文';
        const editor = (mobile ? sheet : item).getByRole('textbox', { name: label, exact: true });
        const actions = mobile ? sheet.locator('.play-edit-sheet-head .play-edit-actions') : item.locator('.play-header-actions .play-edit-actions');
        await button(item, name).click(); await settle(page);
        const original = await editor.inputValue();
        assert.equal(await editor.evaluate(node => document.activeElement === node), !mobile, '桌面端聚焦文字框，手机端不自动弹出输入法');
        if (mobile) {
            const surface = await panel.boundingBox(), box = await sheet.boundingBox(), head = await sheet.locator('.play-edit-sheet-head').boundingBox();
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[key] - surface[key]) <= 1, '分支编辑页覆盖整个面板');
            assert.equal((await sheet.locator('h2').textContent()).trim(), '编辑');
            assert.equal(await sheet.locator('.play-edit-sheet-head').getByRole('button').count(), 2, '顶栏只有保存和取消');
            for (const action of ['保存', '取消']) {
                const position = await button(actions, action).boundingBox();
                assert.ok(position.y >= head.y - 1 && position.y + position.height <= head.y + head.height + 1 && position.x > box.x + box.width / 2, `${action}在右上角`);
            }
            const field = await editor.boundingBox();
            assert.ok(field.y >= head.y + head.height - 1 && Math.abs(field.y + field.height - (box.y + box.height)) <= 2, '输入框占满剩余空间');
            assert.equal(await sheet.evaluate(node => [...node.parentElement.children].every(child => child === node || child.inert)), true, '编辑页下方的内容不可操作');
            assert.equal(await item.locator('textarea').count(), 0, '手机端不在消息内显示编辑框');
            assert.equal(await editor.evaluate(node => getComputedStyle(node).fieldSizing === 'content'), false, '手机端输入框不按内容伸缩');
            const height = field.height;
            await editor.fill('雨停了。\n他把茶杯放回桌上。'); await settle(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - height) <= 1, '短文不改变输入框高度');
            await screenshot(page, `branch-${role}-short-${viewport.width}-${nativeSizing}.png`);
            await editor.fill(longText); await settle(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - height) <= 1, '长文不改变输入框高度');
            assert.ok(await editor.evaluate(node => node.scrollHeight > node.clientHeight));
            const keyboardHeight = Math.min(430, viewport.height - 180);
            await page.evaluate(height => {
                Object.defineProperty(visualViewport, 'height', { configurable: true, value: height });
                Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 32 });
                visualViewport.dispatchEvent(new Event('resize'));
            }, keyboardHeight); await settle(page);
            assert.equal((await panel.boundingBox()).height, keyboardHeight);
            const shrunk = await editor.boundingBox(), shrunkPanel = await panel.boundingBox();
            assert.ok(shrunk.height < height - 100 && shrunk.y + shrunk.height <= shrunkPanel.y + shrunkPanel.height + 1, '键盘出现后输入框跟着面板变矮');
            await editor.press('Control+End'); await editor.pressSequentially(' 继续输入。');
            assert.ok((await editor.inputValue()).endsWith(' 继续输入。'));
            await screenshot(page, `branch-${role}-keyboard-${viewport.width}-${nativeSizing}.png`);
            await page.evaluate(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); });
            await settle(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - height) <= 1, '收起键盘后恢复输入框高度');
        } else {
            assert.equal(await editor.evaluate(node => node.selectionStart === node.value.length), true, '桌面端光标在末尾');
            await editor.fill('雨停了。\n他把茶杯放回桌上。'); await settle(page);
            assert.ok((await editor.boundingBox()).height < 150, '桌面短文按内容显示紧凑编辑框');
            const field = await editor.boundingBox(), head = await meta.boundingBox(), position = await actions.boundingBox();
            assert.ok(position.y >= head.y && position.y + position.height <= head.y + head.height + 1 && position.y + position.height <= field.y + 1,
                '保存和取消位于消息头部');
            assert.equal(await editor.evaluate(node => getComputedStyle(node).fieldSizing === 'content'), nativeSizing);
            await screenshot(page, `branch-${role}-short-${viewport.width}-${nativeSizing}.png`);
            await editor.fill(longText); await settle(page);
            assert.ok(await editor.evaluate(node => node.scrollHeight > node.clientHeight));
            const beforeActions = await actions.boundingBox();
            await editor.evaluate(node => { node.scrollTop = node.scrollHeight; }); await settle(page);
            assert.equal((await actions.boundingBox()).y, beforeActions.y, '编辑框内部滚动不带走保存和取消');
            assert.ok(Math.abs(await editor.evaluate(node => parseFloat(getComputedStyle(node).maxHeight)) - viewport.height * .75) < 1);
            const before = await meta.boundingBox(), dimensions = await feed.evaluate(node => ({ max: node.scrollHeight - node.clientHeight, top: node.scrollTop }));
            const delta = dimensions.top + 50 <= dimensions.max ? 50 : -50;
            await feed.evaluate((node, delta) => { node.scrollTop += delta; }, delta); await settle(page);
            assert.ok(Math.abs(before.y - (await meta.boundingBox()).y - delta) < 2, '正文滚动带动整条消息移动，消息头部没有粘住');
            const scroll = await feed.evaluate(node => node.scrollTop);
            // Dispatch input without Playwright scrolling the offscreen field into view.
            await editor.evaluate(node => { node.value += '\n追加一段。'; node.dispatchEvent(new Event('input', { bubbles: true })); }); await settle(page);
            assert.ok(Math.abs(await feed.evaluate(node => node.scrollTop) - scroll) < 2, '输入不把正文强行拉回消息开头');
        }
        const edited = await editor.inputValue();
        await page.evaluate(() => {
            window.confirmCalls = [];
            ctx.callGenericPopup = async content => { confirmCalls.push(content.textContent); return confirmCalls.length > 1 ? 1 : 0; };
        });
        await button(actions, '取消').click(); await settle(page);
        assert.equal(await editor.inputValue(), edited, '选择不放弃时保留编辑内容');
        await button(actions, '取消').click(); await editor.waitFor({ state: 'detached' }); await settle(page);
        assert.deepEqual(await page.evaluate(() => confirmCalls), ['放弃修改？', '放弃修改？'], '有修改时取消先确认');
        if (mobile) {
            assert.equal(await sheet.count(), 0, '取消后关闭编辑页');
            assert.equal(await catalog.locator('.tea-mobile-tab-slot').isVisible(), true);
            assert.equal(await scope.locator('.play-chat-heading').isVisible(), true);
        }
        assert.equal(await draft.inputValue(), '尚未发送的草稿。');
        await button(item, name).click(); assert.equal(await editor.inputValue(), original, '取消不修改原文');
        if (mobile) assert.ok(await editor.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 2), '打开时显示末尾');
        const text = role === 'user' ? '清晨，他重新泡了一壶茶。' : '她推开窗，看见雨后的第一缕阳光。';
        await editor.fill(text); await page.evaluate(() => { window.failSave = true; window.saveErrors = []; });
        await button(actions, '保存').click();
        await editor.waitFor({ state: 'detached' });
        await page.waitForFunction(() => saveErrors.includes('模拟保存失败'));
        await item.getByText(text, { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => runtime.session.hasUnsaved()), true);
        if (mobile) assert.equal(await catalog.locator('.tea-mobile-tab-slot').isVisible(), true);
        await page.evaluate(() => { window.failSave = false; });
        await button(item, name).click(); await button(actions, '保存').click();
        await page.evaluate(id => runtime.session.flush(id), id);
        await editor.waitFor({ state: 'detached' }); await item.getByText(text, { exact: true }).waitFor();
        if (mobile) assert.equal(await catalog.locator('.tea-mobile-tab-slot').isVisible(), true);
        assert.equal(await draft.inputValue(), '尚未发送的草稿。');
    }
    assert.equal(await page.evaluate(() => captured.length), 0, '编辑保存不调用模型');
    assert.deepEqual(await page.evaluate(() => ctx.chat), mainChat);
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
    await screenshot(page, `branch-restored-${viewport.width}-${nativeSizing}.png`);
}
async function verifyOperations(page, url, viewport) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    await button(page, '打开小剧场面板').click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])'); await button(panel, '剧场演出').click();
    const id = await page.evaluate(async () => {
        const source = await runtime.getChat(seed.a), resultId = crypto.randomUUID(), stamp = new Date().toISOString();
        await testHistory.begin({ roundId: source.id, chatMode: true, operation: 'another', messageId: source.messages[1].id,
            character: ctx.characters[0], resultId, startedAt: stamp, context: source.messages[1].results[0].context });
        await testHistory.saveResult(source.id, resultId, { text: '第二个回复版本', status: 'complete', finishedAt: stamp });
        return (await runtime.createBranch(source.id, source.messages[1].id)).id;
    });
    // Both pages use the same result menu, including selection and dismissal.
    const record = panel.locator(`[data-record="${await page.evaluate(() => seed.a)}"]`);
    await page.evaluate(() => ui.refresh());
    const playCount = record.locator('.play-count'); await playCount.waitFor();
    await playCount.click(); await panel.getByRole('listbox', { name: '生成结果', exact: true }).waitFor();
    assert.equal(await playCount.getAttribute('aria-expanded'), 'true');
    await panel.getByRole('listbox').press('Escape');
    assert.equal(await playCount.getAttribute('aria-expanded'), 'false');
    assert.equal(await playCount.evaluate(node => document.activeElement === node), true);
    await button(panel, '历史记录').click(); await panel.locator(`[data-chat-id="${id}"] .play-history-open`).click();
    const scope = panel.locator('.play-branch-page'), firstUser = scope.locator('.play-user-message').first(), firstAi = scope.locator('.play-assistant-message').first();
    const count = firstAi.locator('.play-count'), versions = panel.getByRole('listbox', { name: '选择回复版本', exact: true });
    await count.click(); await versions.waitFor();
    assert.equal(await count.getAttribute('aria-expanded'), 'true');
    assert.equal(await versions.getByRole('option', { selected: true }).evaluate(node => document.activeElement === node), true);
    await versions.press('Home'); assert.equal(await versions.getByRole('option').first().evaluate(node => document.activeElement === node), true);
    await versions.press('End'); assert.equal(await versions.getByRole('option').last().evaluate(node => document.activeElement === node), true);
    await versions.press('ArrowUp'); await versions.press('Enter');
    await versions.waitFor({ state: 'detached' });
    await page.waitForFunction(id => runtime.getChat(id).then(chat => chat.messages[1].selectedResultId === chat.messages[1].results[0].id), id);
    await count.click(); await versions.press('Escape'); assert.equal(await count.getAttribute('aria-expanded'), 'false');
    await count.click(); await versions.press('Tab'); await versions.waitFor({ state: 'detached' });
    assert.equal(await count.getAttribute('aria-expanded'), 'false');
    await count.click(); await versions.waitFor(); await page.setViewportSize({ ...viewport, height: viewport.height - 1 });
    await versions.waitFor({ state: 'detached' }); await page.setViewportSize(viewport);
    await count.click(); await versions.waitFor(); await scope.locator('.play-chat-name').click(); await versions.waitFor({ state: 'detached' });
    await count.click(); await versions.waitFor();
    await scope.locator('.play-feed').evaluate(node => { node.scrollTop = node.scrollTop > 0 ? 0 : 40; });
    await versions.waitFor({ state: 'detached' });
    const original = await page.evaluate(id => runtime.getChat(id), id);
    await scope.getByRole('textbox', { name: '分支聊天输入', exact: true }).fill('当前请求的新消息'); await scope.locator('.play-send').click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    const latest = scope.locator('.play-assistant-message').last();
    await page.evaluate(() => emitGeneration('当前回复正在生成')); await latest.getByText('当前回复正在生成', { exact: true }).waitFor();
    for (const item of [firstUser, firstAi]) assert.equal(await button(item, item === firstUser ? '修改用户消息' : '编辑回复原文').isEnabled(), true);
    assert.equal(await latest.locator('[data-chat-action=edit]').isDisabled(), true);
    assert.equal(await latest.locator('.play-count').isDisabled(), true);
    const mobile = viewport.width <= 760, sheet = panel.locator('.play-edit-sheet');
    const editScope = item => mobile ? sheet : item, editActions = item => mobile ? sheet.locator('.play-edit-sheet-head .play-edit-actions') : item.locator('.play-edit-actions');
    await button(firstUser, '修改用户消息').click();
    const userEditor = editScope(firstUser).getByRole('textbox', { name: '用户消息原文', exact: true }); await userEditor.fill('生成期间改过的旧用户消息');
    const showPrompt = async item => {
        await button(item, '更多回复操作').click();
        const prompt = button(item, '查看实际提示词'); assert.equal(await prompt.isEnabled(), true);
        await prompt.click(); await panel.getByRole('dialog', { name: '实际发送的提示词', exact: true }).waitFor();
        await button(panel, '关闭提示词查看').click();
    };
    if (!mobile) await showPrompt(firstAi);
    await page.evaluate(() => ui.refresh()); await settle(page);
    assert.equal(await userEditor.inputValue(), '生成期间改过的旧用户消息');
    if (!mobile) await showPrompt(firstAi);
    await page.evaluate(() => emitGeneration('编辑期间仍然显示新收到的回复'));
    await latest.getByText('编辑期间仍然显示新收到的回复', { exact: true }).waitFor();
    assert.equal(await userEditor.inputValue(), '生成期间改过的旧用户消息');
    if (!mobile) assert.equal(await latest.locator('.play-stop').isVisible(), true, '编辑期间仍可停止当前生成');
    await screenshot(page, `branch-generating-edit-${viewport.width}.png`);
    await button(editActions(firstUser), '保存').click(); await userEditor.waitFor({ state: 'detached' });
    await button(firstAi, '编辑回复原文').click();
    await editScope(firstAi).getByRole('textbox', { name: '回复原文', exact: true }).fill('生成期间改过的旧 AI 消息');
    await button(editActions(firstAi), '保存').click();
    await firstAi.getByText('生成期间改过的旧 AI 消息', { exact: true }).waitFor();
    await button(firstAi, '更多回复操作').click(); await button(firstAi, '隐藏楼层').click();
    await firstAi.locator('.play-hidden-mark').waitFor({ state: 'attached' });
    await button(firstAi, '更多回复操作').click(); await button(firstAi, '显示楼层').click();
    await firstAi.locator('.play-hidden-mark').waitFor({ state: 'detached' });
    await button(firstAi, '收藏演出记录').click(); await button(firstAi, '取消收藏').waitFor();
    await button(scope, '聊天操作').click();
    assert.equal(await button(scope, '修改聊天名称').isEnabled(), true);
    assert.equal(await button(scope, '删除').isDisabled(), true); assert.equal(await button(scope, '删除该聊天').isDisabled(), true);
    await scope.locator('.play-chat-menu').evaluate(node => { node.open = false; });
    const currentUserId = await scope.locator('.play-user-message').last().getAttribute('data-message-id');
    const currentUser = scope.locator(`[data-message-id="${currentUserId}"]`);
    await button(currentUser, '更多消息操作').click(); await button(currentUser, '删除用户消息').click(); await currentUser.waitFor({ state: 'detached' });
    await page.evaluate(() => emitGeneration('单条旧消息删除后继续生成')); await latest.getByText('单条旧消息删除后继续生成', { exact: true }).waitFor();
    const requested = await page.evaluate(() => captured[0].branchHistory.map(message => message.text));
    assert.deepEqual(requested, [original.messages[0].text, original.messages[1].results[0].text]);
    await page.evaluate(() => finishGeneration('本次生成的最终回复')); await page.waitForFunction(() => runtime.getStates().length === 0);
    await latest.getByText('本次生成的最终回复', { exact: true }).waitFor();
    const saved = await page.evaluate(id => runtime.getChat(id), id);
    assert.equal(saved.messages[0].text, '生成期间改过的旧用户消息'); assert.equal(saved.messages[1].results[0].text, '生成期间改过的旧 AI 消息');
    assert.equal(saved.messages.length, 3); assert.equal(saved.messages.at(-1).results[0].text, '本次生成的最终回复');
    await screenshot(page, `branch-generating-saved-${viewport.width}.png`);
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const nativeSizing of [true, false]) for (const viewport of nativeSizing
            ? [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 744, height: 390 }, { width: 1332, height: 896 }]
            : [{ width: 390, height: 844 }, { width: 1332, height: 896 }]) {
            const context = await browser.newContext({ viewport });
            if (!nativeSizing) await context.addInitScript(() => {
                const supports = CSS.supports.bind(CSS);
                CSS.supports = (...args) => args[0] === 'field-sizing' ? false : supports(...args);
            });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            try {
                const url = `http://127.0.0.1:${server.address().port}/`; await verify(page, url, viewport, nativeSizing);
                assert.deepEqual(errors, []);
                console.log(JSON.stringify({ url, viewport, nativeSizing, passed: true, errors }));
            } finally { await context.close(); }
        }
        for (const viewport of [{ width: 390, height: 844 }, { width: 1332, height: 896 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            try {
                await verifyOperations(page, `http://127.0.0.1:${server.address().port}/`, viewport);
                assert.deepEqual(errors, []); console.log(JSON.stringify({ viewport, generationAndVersions: true, passed: true }));
            } finally { await context.close(); }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
