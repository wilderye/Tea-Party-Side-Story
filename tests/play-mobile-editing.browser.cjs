// Flow: edit a historical message -> open the keyboard -> type at the end -> save/cancel.
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
    await page.locator('#teahouse-panel').screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
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

async function verifyGeometry(panel, editor, actions) {
    const feed = await panel.locator('.play-feed').boundingBox(), box = await editor.boundingBox(), form = await editor.locator('..').boundingBox();
    assert.ok(box.height <= await editor.evaluate(node => parseFloat(getComputedStyle(node).maxHeight)) + 1, '编辑框遵循酒馆的高度上限');
    for (const name of ['保存', '取消']) {
        const action = await actions.getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(action.y >= form.y && action.y + action.height <= box.y + 1 && action.x >= box.x && action.x + action.width <= box.x + box.width, `${name}在编辑框右上角：${JSON.stringify({ feed, box, action })}`);
    }
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
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator('#teahouse-panel');
    await panel.getByRole('button', { name: '剧场演出', exact: true }).filter({ visible: true }).click();
    const id = await page.evaluate(() => seed.a), record = panel.locator(`[data-record="${id}"]`);
    await record.waitFor(); await settle(page);
    const original = await page.evaluate(async id => ({ round: await runtime.getRound(id), chat: structuredClone(ctx.chat) }), id);
    const composer = panel.getByRole('textbox', { name: '小剧场提示词', exact: true, includeHidden: true });
    const draft = '下一篇尚未发送的提示词。\n保留这段草稿。';
    await composer.fill(draft);
    const mobile = viewport.width <= 760, keyboardHeight = Math.min(430, viewport.height - 180);
    for (const [role, button, label] of [['user', '修改提示词', '提示词原文'], ['assistant', '编辑回复原文', '回复原文']]) {
        const actions = record.locator(`.play-${role}-message .play-edit-actions`);
        const originalText = role === 'user' ? original.round.prompt : original.round.results[0].text;
        await record.getByRole('button', { name: button, exact: true }).click(); await settle(page);
        const editor = record.getByRole('textbox', { name: label, exact: true });
        assert.equal(await editor.inputValue(), originalText);
        assert.equal(await panel.locator('.play-compose').isVisible(), !mobile, '手机编辑期间隐藏底部输入区域，桌面保持原布局');
        assert.equal(await composer.inputValue(), draft, '隐藏输入框保留原草稿');
        // Both layouts follow Tavern: short messages keep a compact editor.
        await editor.fill('雨停了。\n他把茶杯放回桌上。'); await settle(page);
        assert.ok((await editor.boundingBox()).height < 150, '手机和桌面短文编辑框都保持紧凑');
        await verifyGeometry(panel, editor, actions);
        await screenshot(page, `message-edit-short-${role}-${viewport.width}.png`);
        const longText = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 段：窗外的雨声渐渐停下，茶壶里的水仍在轻轻沸腾。`).join('\n\n');
        await editor.fill(longText); await settle(page);
        assert.ok(await editor.evaluate(node => node.scrollHeight > node.clientHeight), '长文在编辑框内部滚动');
        const transcript = panel.locator('.play-feed');
        const scrollGeometry = await transcript.evaluate(node => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
        const delta = scrollGeometry.top + 50 <= scrollGeometry.max ? 50 : -50;
        const headBefore = await actions.boundingBox();
        await transcript.evaluate((node, delta) => { node.scrollTop += delta; }, delta); await settle(page);
        assert.ok(Math.abs(headBefore.y - (await actions.boundingBox()).y - delta) < 2, '正文滚动会带动整条消息头部，不把消息头部粘在原处');
        const scrollBeforeInput = await transcript.evaluate(node => node.scrollTop);
        // Dispatch input without Playwright scrolling the offscreen field into view.
        await editor.evaluate(node => { node.value += '\n追加一段。'; node.dispatchEvent(new Event('input', { bubbles: true })); }); await settle(page);
        assert.ok(Math.abs(await transcript.evaluate(node => node.scrollTop) - scrollBeforeInput) < 2, '修改文字不强行拉回正在编辑的消息开头');
        if (mobile) {
            await verifyGeometry(panel, editor, actions);
            const editorHeightBeforeKeyboard = (await editor.boundingBox()).height;
            assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), false, '编辑时隐藏导航');
            assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-brand').isVisible(), true, '编辑时保留茶话会顶栏');
            await screenshot(page, `message-edit-${role}-${viewport.width}.png`);
            // iOS and modern Android can resize only visualViewport, including panning.
            await setKeyboard(page, keyboardHeight);
            assert.equal((await panel.boundingBox()).height, keyboardHeight, '模拟键盘后面板跟随可见屏幕缩小');
            assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), false, '键盘出现后保持同一条隐藏导航规则');
            assert.ok(Math.abs((await editor.boundingBox()).height - editorHeightBeforeKeyboard) <= 1, '仅 visualViewport 缩小时不根据面板剩余空间调整编辑框');
            await typeAtEnd(editor); await settle(page);
            await verifyGeometry(panel, editor, actions);
            await screenshot(page, `message-edit-keyboard-${role}-${viewport.width}.png`);
            await setKeyboard(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - editorHeightBeforeKeyboard) <= 1, '收起键盘后恢复编辑框高度');
            assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), false, '收起键盘仍在编辑时继续隐藏导航');
            // Some Android browsers resize the layout viewport as well.
            await page.setViewportSize({ width: viewport.width, height: keyboardHeight }); await settle(page);
            await typeAtEnd(editor); await settle(page);
            await verifyGeometry(panel, editor, actions);
            await screenshot(page, `message-edit-resized-${role}-${viewport.width}.png`);
            await editor.evaluate(node => { node.scrollTop = node.scrollHeight; });
            await panel.locator('.play-feed').evaluate(node => { node.scrollTop += 50; }); await settle(page);
            const feed = await panel.locator('.play-feed').boundingBox();
            for (const name of ['保存', '取消']) {
                const box = await actions.getByRole('button', { name, exact: true }).boundingBox();
                assert.ok(box.y >= (await editor.locator('..').boundingBox()).y && box.y + box.height <= (await editor.boundingBox()).y + 1, '滚动后保存和取消随整条消息移动，仍在编辑框右上角');
            }
            await page.setViewportSize(viewport); await settle(page);
        } else {
            assert.ok((await editor.boundingBox()).height <= viewport.height * .75 + 1, '桌面长文使用酒馆的 75dvh 高度上限');
        }
        if (mobile) await setKeyboard(page, keyboardHeight);
        await actions.getByRole('button', { name: '取消', exact: true }).click(); await settle(page);
        assert.equal(await panel.locator('.play-compose').isVisible(), true, '取消后恢复底部输入区域');
        if (mobile) assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), true, '取消后恢复导航');
        assert.equal(await composer.inputValue(), draft);
        assert.equal(await page.evaluate(async ({ id, role }) => {
            const round = await runtime.getRound(id);
            return role === 'user' ? round.prompt : round.results[0].text;
        }, { id, role }), originalText, '取消不改变原消息');
        if (mobile) await setKeyboard(page);

        await record.getByRole('button', { name: button, exact: true }).click();
        const savedText = role === 'user' ? '清晨，他重新泡了一壶茶。' : '她推开窗，看见雨后的第一缕阳光。';
        await editor.fill(savedText);
        if (mobile) await setKeyboard(page, keyboardHeight);
        await page.evaluate(() => { window.failSave = true; });
        await actions.getByRole('button', { name: '保存', exact: true }).click();
        await record.getByRole('alert').getByText('模拟保存失败', { exact: true }).waitFor();
        assert.equal(await editor.inputValue(), savedText, '保存失败保留正在修改的文字');
        assert.equal(await panel.locator('.play-compose').isVisible(), !mobile, '保存失败继续保持编辑状态');
        if (mobile) {
            const errorBox = await record.getByRole('alert').boundingBox();
            assert.ok(errorBox.height > 0, '保存失败显示原因，正文可以滚动查看');
        }
        await page.evaluate(() => { window.failSave = false; });
        await actions.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'detached' }); await settle(page);
        assert.equal(await panel.locator('.play-compose').isVisible(), true, '保存后恢复底部输入区域');
        if (mobile) assert.equal(await panel.locator('.play-catalog:not([hidden]) .tea-mobile-tab-slot').isVisible(), true, '保存后恢复导航');
        assert.equal(await composer.inputValue(), draft, '保存后恢复同一份草稿');
        assert.equal(await page.evaluate(async ({ id, role }) => {
            const round = await runtime.getRound(id);
            return role === 'user' ? round.prompt : round.results[0].text;
        }, { id, role }), savedText, '重试保存后只更新当前消息');
        if (mobile) await setKeyboard(page);
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
                console.log(JSON.stringify({ url, viewport, checks: '酒馆编辑框高度、两种键盘缩屏与偏移、隐藏和恢复导航、长文末尾输入、保存/取消随消息滚动、草稿恢复、取消、保存失败重试', errors }));
            } finally { await context.close(); }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
