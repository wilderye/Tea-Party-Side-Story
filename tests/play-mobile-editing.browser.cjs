// Flow: edit a historical message -> full-screen sheet on mobile -> open the keyboard -> type at the end -> save/cancel.
// Browser plugin not available; use the project's Playwright + Edge workflow.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.TEA_TEST_PLUGIN_ROOT ? path.resolve(process.env.TEA_TEST_PLUGIN_ROOT) : path.resolve(__dirname, '..');
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

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])').screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function setKeyboard(page, height = null) {
    await page.evaluate(height => {
        if (height !== null) {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: height });
            Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 32 });
        } else {
            delete visualViewport.height;
            delete visualViewport.offsetTop;
        }
        visualViewport.dispatchEvent(new Event('resize'));
    }, height);
    await settle(page);
}

async function verifyGeometry(editor, actions) {
    const box = await editor.boundingBox(), head = await actions.locator('..').boundingBox();
    assert.ok(box.height <= await editor.evaluate(node => parseFloat(getComputedStyle(node).maxHeight)) + 1, '编辑框遵循酒馆的高度上限');
    for (const name of ['保存', '取消']) {
        const action = await actions.getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(action.y >= head.y && action.y + action.height <= box.y + 1 && action.x >= box.x && action.x + action.width <= box.x + box.width, `${name}在消息头部：${JSON.stringify({ box, action })}`);
    }
}

async function verifySheet(panel, sheet, editor) {
    const surface = await panel.boundingBox(), box = await sheet.boundingBox(), head = await sheet.locator('.play-edit-sheet-head').boundingBox();
    const field = await editor.boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[key] - surface[key]) <= 1, `编辑页覆盖整个面板：${JSON.stringify({ surface, box })}`);
    assert.equal((await sheet.locator('h2').textContent()).trim(), '编辑', '顶栏左侧只写编辑');
    assert.equal(await sheet.locator('.play-edit-sheet-head').getByRole('button').count(), 2, '顶栏只有保存和取消');
    for (const name of ['保存', '取消']) {
        const action = await sheet.getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(action.y >= head.y - 1 && action.y + action.height <= head.y + head.height + 1 && action.x > box.x + box.width / 2, `${name}在右上角`);
    }
    assert.ok(field.y >= head.y + head.height - 1 && Math.abs(field.y + field.height - (box.y + box.height)) <= 2
        && Math.abs(field.width - box.width) <= 1, `输入框占满剩余空间：${JSON.stringify({ box, head, field })}`);
    assert.equal(await sheet.evaluate(node => [...node.parentElement.children].every(child => child === node || child.inert)), true, '编辑页下方的内容不可操作');
}

async function trackConfirm(page, answer) {
    await page.evaluate(answer => {
        window.confirmCalls = [];
        ctx.callGenericPopup = async (content, type, _text, options) => {
            confirmCalls.push({ text: content.textContent, type, ok: options?.okButton, cancel: options?.cancelButton });
            return answer;
        };
    }, answer);
}

async function typeAtEnd(editor) {
    await editor.press('Control+End');
    await editor.pressSequentially(' 继续修改最后一段。');
    assert.ok((await editor.inputValue()).endsWith(' 继续修改最后一段。'), '键盘出现后可以继续修改长文末尾');
    assert.ok(await editor.evaluate(node => {
        const style = getComputedStyle(node);
        // Native caret scrolling can leave the bottom padding and the unused
        // part of the final line box below the input's visible edge.
        const trailingSpace = parseFloat(style.paddingBottom) + parseFloat(style.lineHeight);
        return node.selectionEnd === node.value.length && node.scrollTop + node.clientHeight >= node.scrollHeight - trailingSpace;
    }), '正在输入的最后一行已滚入编辑框');
}

async function verifyEditing(page, url, viewport) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url);
    assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    assert.deepEqual(await page.evaluate(async () => {
        const { createPlayEditor } = await import('/play-editor.js');
        const editor = createPlayEditor({ text: '第一行\r\n第二行', onSave() {}, onCancel() {} });
        const untouched = editor.dirty;
        editor.input.value += '。';
        return { untouched, changed: editor.dirty };
    }), { untouched: false, changed: true }, 'Windows 换行的原文未修改时不算改动');
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    await panel.getByRole('button', { name: '剧场演出', exact: true }).filter({ visible: true }).click();
    const id = await page.evaluate(() => seed.a), record = panel.locator(`[data-record="${id}"]`);
    await record.waitFor(); await settle(page);
    const original = await page.evaluate(async id => ({ round: await runtime.getRound(id), chat: structuredClone(ctx.chat) }), id);
    const composer = panel.getByRole('textbox', { name: '小剧场提示词', exact: true, includeHidden: true });
    const draft = '下一篇尚未发送的提示词。\n保留这段草稿。';
    await composer.fill(draft);
    const mobile = viewport.width <= 760, keyboardHeight = Math.min(430, viewport.height - 180);
    const sheet = panel.locator('.play-edit-sheet');
    const longText = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 段：窗外的雨声渐渐停下，茶壶里的水仍在轻轻沸腾。`).join('\n\n');
    for (const [role, button, label] of [['user', '修改提示词', '提示词原文'], ['assistant', '编辑回复原文', '回复原文']]) {
        const actions = mobile ? sheet.locator('.play-edit-sheet-head .play-edit-actions') : record.locator(`.play-${role}-message .play-edit-actions`);
        const originalText = role === 'user' ? original.round.prompt : original.round.results[0].text;
        const editor = (mobile ? sheet : record).getByRole('textbox', { name: label, exact: true });
        const focused = () => editor.evaluate(node => document.activeElement === node);
        const savedRound = () => page.evaluate(async ({ id, role }) => {
            const round = await runtime.getRound(id);
            return role === 'user' ? round.prompt : round.results[0].text;
        }, { id, role });
        await record.getByRole('button', { name: button, exact: true }).click(); await settle(page);
        assert.equal(await editor.inputValue(), originalText);
        assert.equal(await composer.inputValue(), draft, '隐藏输入框保留原草稿');
        if (mobile) {
            await verifySheet(panel, sheet, editor);
            assert.equal(await focused(), false, '手机端打开编辑页不自动弹出输入法');
            assert.equal(await record.locator('textarea').count(), 0, '手机端不在消息内显示编辑框');
            await screenshot(page, `message-edit-open-${role}-${viewport.width}.png`);
            const height = (await editor.boundingBox()).height;
            await editor.fill('雨停了。\n他把茶杯放回桌上。'); await settle(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - height) <= 1, '短文不改变输入框高度');
            await editor.fill(longText); await settle(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - height) <= 1, '长文不改变输入框高度');
            assert.ok(await editor.evaluate(node => node.scrollHeight > node.clientHeight), '长文在输入框内部滚动');
            // iOS and modern Android can resize only visualViewport, including panning.
            await setKeyboard(page, keyboardHeight);
            assert.equal((await panel.boundingBox()).height, keyboardHeight, '模拟键盘后面板跟随可见屏幕缩小');
            await verifySheet(panel, sheet, editor);
            assert.ok((await editor.boundingBox()).height < height - 100, '键盘出现后输入框跟着面板变矮');
            await typeAtEnd(editor); await settle(page);
            await screenshot(page, `message-edit-keyboard-${role}-${viewport.width}.png`);
            await setKeyboard(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - height) <= 1, '收起键盘后恢复输入框高度');
            // Some Android browsers resize the layout viewport as well.
            await page.setViewportSize({ width: viewport.width, height: keyboardHeight }); await settle(page);
            await verifySheet(panel, sheet, editor);
            await typeAtEnd(editor); await settle(page);
            await screenshot(page, `message-edit-resized-${role}-${viewport.width}.png`);
            await page.setViewportSize(viewport); await settle(page);
            await verifySheet(panel, sheet, editor);
        } else {
            assert.equal(await focused(), true, '桌面端打开编辑后聚焦');
            assert.equal(await editor.evaluate(node => node.selectionStart === node.value.length && node.selectionEnd === node.value.length), true, '桌面端光标在末尾');
            assert.equal(await panel.locator('.play-compose').isVisible(), true, '桌面编辑期间保留底部输入区域');
            await editor.fill('雨停了。\n他把茶杯放回桌上。'); await settle(page);
            assert.ok((await editor.boundingBox()).height < 150, '桌面短文编辑框保持紧凑');
            await verifyGeometry(editor, actions);
            await screenshot(page, `message-edit-short-${role}-${viewport.width}.png`);
            await editor.fill(longText); await settle(page);
            assert.ok(await editor.evaluate(node => node.scrollHeight > node.clientHeight), '长文在编辑框内部滚动');
            assert.ok((await editor.boundingBox()).height <= viewport.height * .75 + 1, '桌面长文使用酒馆的 75dvh 高度上限');
            const transcript = panel.locator('.play-feed');
            const scrollBeforeInput = await transcript.evaluate(node => node.scrollTop);
            // Dispatch input without Playwright scrolling the offscreen field into view.
            await editor.evaluate(node => { node.value += '\n追加一段。'; node.dispatchEvent(new Event('input', { bubbles: true })); }); await settle(page);
            assert.ok(Math.abs(await transcript.evaluate(node => node.scrollTop) - scrollBeforeInput) < 2, '修改文字不强行拉回正在编辑的消息开头');
        }
        const edited = await editor.inputValue();
        await trackConfirm(page, 0);
        await actions.getByRole('button', { name: '取消', exact: true }).click(); await settle(page);
        assert.deepEqual(await page.evaluate(() => confirmCalls), [{ text: '放弃修改？', type: 2, ok: '放弃修改', cancel: '取消' }], '有修改时取消先确认');
        assert.equal(await editor.inputValue(), edited, '选择不放弃时保留编辑内容');
        if (mobile) await verifySheet(panel, sheet, editor);
        await trackConfirm(page, 1);
        await actions.getByRole('button', { name: '取消', exact: true }).click();
        await editor.waitFor({ state: 'detached' }); await settle(page);
        if (mobile) assert.equal(await sheet.count(), 0, '取消后关闭编辑页');
        assert.equal(await panel.locator('.play-compose').isVisible(), true, '取消后恢复底部输入区域');
        if (mobile) assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), true, '取消后恢复导航');
        assert.equal(await composer.inputValue(), draft);
        assert.equal(await savedRound(), originalText, '取消不改变原消息');

        await trackConfirm(page, 1);
        await record.getByRole('button', { name: button, exact: true }).click(); await settle(page);
        await actions.getByRole('button', { name: '取消', exact: true }).click(); await editor.waitFor({ state: 'detached' });
        assert.deepEqual(await page.evaluate(() => confirmCalls), [], '没有修改时直接取消');

        await record.getByRole('button', { name: button, exact: true }).click();
        await editor.fill(' ');
        await actions.getByRole('button', { name: '保存', exact: true }).click(); await settle(page);
        const error = (mobile ? sheet : record).locator('.play-edit-form .play-result-error');
        assert.equal(await error.textContent(), role === 'user' ? '提示词不能为空。' : '回复正文不能为空。', '保存错误显示在编辑处');
        assert.equal(await error.isVisible(), true);
        if (mobile) {
            assert.ok((await error.boundingBox()).y < (await editor.boundingBox()).y, '错误显示在输入框上方');
            await verifySheet(panel, sheet, editor);
            await screenshot(page, `message-edit-error-${role}-${viewport.width}.png`);
        }
        const savedText = role === 'user' ? '清晨，他重新泡了一壶茶。' : '她推开窗，看见雨后的第一缕阳光。';
        await editor.fill(savedText);
        await page.evaluate(() => { window.failSave = true; window.saveErrors = []; });
        await actions.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'detached' });
        await page.waitForFunction(() => saveErrors.includes('模拟保存失败'));
        await record.getByText(savedText, { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => runtime.session.hasUnsaved()), true);
        assert.equal(await panel.locator('.play-compose').isVisible(), true, '后台保存失败不阻挡继续使用输入框');
        await page.evaluate(() => { window.failSave = false; });
        await record.getByRole('button', { name: button, exact: true }).click();
        await actions.getByRole('button', { name: '保存', exact: true }).click();
        await page.evaluate(id => runtime.session.flush(id), id);
        await editor.waitFor({ state: 'detached' }); await settle(page);
        assert.equal(await panel.locator('.play-compose').isVisible(), true, '保存后恢复底部输入区域');
        if (mobile) assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), true, '保存后恢复导航');
        assert.equal(await composer.inputValue(), draft, '保存后恢复同一份草稿');
        assert.equal(await savedRound(), savedText, '重试保存后只更新当前消息');

        await record.getByRole('button', { name: button, exact: true }).click();
        await editor.fill(longText); await actions.getByRole('button', { name: '保存', exact: true }).click();
        await page.evaluate(id => runtime.session.flush(id), id); await editor.waitFor({ state: 'detached' });
        await record.getByRole('button', { name: button, exact: true }).click(); await settle(page);
        assert.ok(await editor.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollHeight - node.clientHeight - node.scrollTop < 2), '打开长文时显示末尾');
        assert.equal(await focused(), !mobile);
        if (!mobile) assert.equal(await editor.evaluate(node => node.selectionStart === node.value.length), true, '桌面端光标在长文末尾');
        await screenshot(page, `message-edit-end-${role}-${viewport.width}.png`);
        await actions.getByRole('button', { name: '取消', exact: true }).click(); await editor.waitFor({ state: 'detached' });
    }
    assert.equal(await page.evaluate(() => captured.length), 0, '编辑、取消和保存都不调用模型');
    assert.deepEqual(await page.evaluate(() => ctx.chat), original.chat, '不改变酒馆主聊天');
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), '没有横向溢出');
    assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
    await screenshot(page, `message-edit-restored-${viewport.width}.png`);
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 744, height: 390 }, { width: 1332, height: 896 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            try {
                const url = `http://127.0.0.1:${server.address().port}/`;
                await verifyEditing(page, url, viewport);
                assert.deepEqual(errors, [], '没有浏览器错误或警告');
                console.log(JSON.stringify({ url, viewport, checks: '手机全屏编辑页、两种键盘缩屏、不自动聚焦、显示末尾、放弃修改确认、保存错误、草稿恢复、保存失败重试', errors }));
            } finally { await context.close(); }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
