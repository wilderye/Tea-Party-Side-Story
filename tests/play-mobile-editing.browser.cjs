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

async function verifyGeometry(panel, editor, actions, mobile) {
    const feed = await panel.locator('.play-feed').boundingBox(), box = await editor.boundingBox();
    if (mobile) {
        const tabs = panel.locator('.play-catalog:not([hidden]) .tea-mobile-tabs');
        const tabBox = await tabs.isVisible() ? await tabs.boundingBox() : null;
        const inset = tabBox ? Math.max(0, tabBox.y + tabBox.height - feed.y) : 0;
        feed.y += inset; feed.height -= inset;
    }
    if (mobile) {
        const header = await actions.boundingBox();
        assert.ok(box.height >= Math.max(80, feed.height - header.height - 60), `手机编辑框使用居中头部下面的剩余空间：${JSON.stringify({ feed, box, header })}`);
        assert.ok(box.y >= feed.y && box.y + box.height <= feed.y + feed.height + 1, '整个编辑框都在可见正文区域内，长文末尾不会藏到键盘后面');
    } else {
        assert.ok(box.height < 150, '桌面短文字保持原来的紧凑高度');
    }
    for (const name of ['保存', '取消']) {
        const action = await actions.getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(action.y >= feed.y && action.y + action.height <= box.y + 1 && action.y + action.height <= feed.y + feed.height, `${name}完整露在编辑框上方：${JSON.stringify({ feed, box, action })}`);
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
        const actions = record.locator(`.play-${role}-meta`);
        const originalText = role === 'user' ? original.round.prompt : original.round.results[0].text;
        await record.getByRole('button', { name: button, exact: true }).click(); await settle(page);
        const editor = record.getByRole('textbox', { name: label, exact: true });
        assert.equal(await editor.inputValue(), originalText);
        assert.equal(await panel.locator('.play-compose').isVisible(), !mobile, '手机编辑期间隐藏底部输入区域，桌面保持原布局');
        assert.equal(await composer.inputValue(), draft, '隐藏输入框保留原草稿');
        // The reply contains long text; short content must still keep the mobile editor large.
        await editor.fill('雨停了。\n他把茶杯放回桌上。'); await settle(page);
        await verifyGeometry(panel, editor, actions, mobile);
        const longText = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 段：窗外的雨声渐渐停下，茶壶里的水仍在轻轻沸腾。`).join('\n\n');
        await editor.fill(longText); await settle(page);
        assert.ok(await editor.evaluate(node => node.scrollHeight > node.clientHeight), '长文在编辑框内部滚动');
        if (mobile) {
            await verifyGeometry(panel, editor, actions, true);
            const editorHeightBeforeKeyboard = (await editor.boundingBox()).height;
            assert.equal(await panel.locator('.play-catalog').isVisible(), viewport.height > 560, '空间充足时保留导航，短屏编辑时让出导航占用的空间');
            await screenshot(page, `message-edit-${role}-${viewport.width}.png`);
            // iOS and modern Android can resize only visualViewport, including panning.
            await setKeyboard(page, keyboardHeight);
            assert.equal((await panel.boundingBox()).height, keyboardHeight, '模拟键盘后面板跟随可见屏幕缩小');
            assert.equal(await panel.locator('.play-catalog').isVisible(), false, '键盘上方空间不足时暂时收起标题和页面标签');
            await typeAtEnd(editor); await settle(page);
            await verifyGeometry(panel, editor, actions, true);
            await screenshot(page, `message-edit-keyboard-${role}-${viewport.width}.png`);
            await setKeyboard(page);
            assert.ok(Math.abs((await editor.boundingBox()).height - editorHeightBeforeKeyboard) <= 1, '收起键盘后恢复编辑框高度');
            assert.equal(await panel.locator('.play-catalog').isVisible(), viewport.height > 560, '收起键盘后按可见空间恢复导航');
            // Some Android browsers resize the layout viewport as well.
            await page.setViewportSize({ width: viewport.width, height: keyboardHeight }); await settle(page);
            await typeAtEnd(editor); await settle(page);
            await verifyGeometry(panel, editor, actions, true);
            await screenshot(page, `message-edit-resized-${role}-${viewport.width}.png`);
            await editor.evaluate(node => { node.scrollTop = node.scrollHeight; });
            await panel.locator('.play-feed').evaluate(node => { node.scrollTop += 50; }); await settle(page);
            const feed = await panel.locator('.play-feed').boundingBox();
            for (const name of ['保存', '取消']) {
                const box = await actions.getByRole('button', { name, exact: true }).boundingBox();
                assert.ok(box.y >= feed.y && box.y + box.height <= feed.y + feed.height, '滚动后保存和取消仍留在可见区域');
            }
            await page.setViewportSize(viewport); await settle(page);
        } else {
            assert.ok((await editor.boundingBox()).height <= 420, '桌面长文仍使用原有高度上限');
        }
        if (mobile) await setKeyboard(page, keyboardHeight);
        await actions.getByRole('button', { name: '取消', exact: true }).click(); await settle(page);
        assert.equal(await panel.locator('.play-compose').isVisible(), true, '取消后恢复底部输入区域');
        assert.equal(await panel.locator('.play-catalog').isVisible(), true, '取消后恢复标题和页面标签');
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
            const errorBox = await record.getByRole('alert').boundingBox(), feedBox = await panel.locator('.play-feed').boundingBox();
            assert.ok(errorBox.y >= feedBox.y && errorBox.y + errorBox.height <= feedBox.y + feedBox.height + 1, '键盘出现时保存失败的原因也能完整看到');
        }
        await page.evaluate(() => { window.failSave = false; });
        await actions.getByRole('button', { name: '保存', exact: true }).click();
        await editor.waitFor({ state: 'detached' }); await settle(page);
        assert.equal(await panel.locator('.play-compose').isVisible(), true, '保存后恢复底部输入区域');
        assert.equal(await panel.locator('.play-catalog').isVisible(), true, '保存后恢复标题和页面标签');
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
                console.log(JSON.stringify({ url, viewport, checks: '大编辑框、两种键盘缩屏与偏移、收起和恢复导航、长文末尾输入可见、固定保存/取消、草稿恢复、取消、保存失败重试、桌面高度保持', errors }));
            } finally { await context.close(); }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
