// Browser plugin not available. Use the project's Playwright/Edge workflow.
// Flow: settings -> edit selected content directly -> rename/add/delete -> choose position -> reload.
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

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verify(page, url, viewport) {
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const select = panel.getByRole('combobox', { name: '自定义小剧场提示词', exact: true });
    const position = panel.getByRole('combobox', { name: '提示词插入位置', exact: true });
    const editor = panel.getByRole('dialog');
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('processingSettings')));
    const content = panel.getByRole('textbox', { name: '小剧场提示词内容', exact: true });
    const draftContent = editor.getByRole('textbox', { name: '内容', exact: true });
    const name = editor.getByRole('textbox', { name: '小剧场提示词名称', exact: true });
    const open = async () => {
        await page.waitForFunction(() => window.ready);
        assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
        await button('设置').click();
    };
    await page.addInitScript(() => {
        if (!localStorage.getItem('processingSettings')) localStorage.setItem('processingSettings',
            JSON.stringify({ enabled: true, pageSize: 5, favorites: {}, playPrompt: '原来已保存的提示词' }));
    });
    await page.goto(url); await open();
    assert.deepEqual(await select.locator('option').allTextContents(), ['默认提示词', '强调完整性']);
    assert.equal(await select.inputValue(), 'default'); assert.equal(await select.getAttribute('multiple'), null);
    assert.equal(await position.inputValue(), 'user-after');
    assert.deepEqual(await position.locator('option').allTextContents(), ['全部提示词前', '最新用户消息前', '最新用户消息后']);
    assert.equal(await content.inputValue(), '原来已保存的提示词');
    assert.equal(await button('删除提示词').count(), 0);
    for (const action of ['新增提示词', '修改提示词名称']) {
        const control = button(action);
        assert.equal((await control.innerText()).trim(), '', '新增与改名沿用纯图标按钮');
        assert.equal(await control.evaluate(node => getComputedStyle(node).borderTopWidth), '0px', '图标按钮没有边框');
        assert.equal(await control.locator('svg').count(), 1);
    }
    if (viewport.width > 760) {
        const labelBounds = await panel.locator('.play-prompt-position strong').boundingBox();
        const selectBounds = await position.boundingBox();
        const apiBounds = await panel.getByRole('combobox', { name: '生成使用的 API', exact: true }).boundingBox();
        assert.ok(Math.abs(labelBounds.y + labelBounds.height / 2 - selectBounds.y - selectBounds.height / 2) < 1,
            '电脑端插入位置名称与下拉框在同一行');
        assert.ok(Math.abs(selectBounds.x + selectBounds.width - apiBounds.x - apiBounds.width) < 1,
            '插入位置下拉框与其他设置的下拉框右侧对齐');
    }
    for (const control of [content, select, position, button('新增提示词'), button('修改提示词名称')]) {
        await control.focus();
        assert.equal(await control.evaluate(node => getComputedStyle(node).outlineStyle), 'none', '聚焦沿用插件现有样式，不添加高亮框');
    }
    await screenshot(page, `prompt-first-${viewport.width}.png`);
    await content.fill('直接编辑后保存的默认提示词');
    assert.equal((await saved()).playPromptConfig.presets[0].content, '直接编辑后保存的默认提示词');
    assert.equal((await saved()).playPrompt, undefined, '直接编辑也完成旧设置迁移');
    await button('修改提示词名称').click();
    assert.equal(await draftContent.count(), 0, '铅笔弹窗仅修改名称，不重复编辑内容');
    assert.equal(await editor.getByRole('heading').innerText(), '修改名称');
    assert.equal(await name.locator('..').evaluate(node => node.textContent.trim()), '', '改名输入框上方不重复名称说明');
    assert.equal(await name.evaluate(node => getComputedStyle(node).outlineStyle), 'none', '改名输入框不添加高亮框');
    await name.fill('取消的名字'); await editor.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await select.locator('option:checked').textContent(), '默认提示词');
    await select.selectOption('recommended');
    assert.equal((await saved()).playPrompt, undefined, '保存新配置后移除已迁移的旧字段');
    const recommended = await content.inputValue();
    assert.ok(recommended.startsWith('按要求输出思维链后仅输出小剧场内容'));
    assert.ok(recommended.endsWith('而非仅以人物的情感和关系来推动故事。'));
    const expected = await page.evaluate(async () => (await import('/play-settings.js')).RECOMMENDED_PLAY_PROMPT);
    assert.equal(recommended, expected, '推荐内容原样保留');
    assert.equal((await saved()).playPromptConfig.presets[0].content, '直接编辑后保存的默认提示词');
    await panel.locator('.tea-settings').evaluate(area => {
        area.scrollTop += area.querySelector('.play-prompt-settings').getBoundingClientRect().top - area.getBoundingClientRect().top;
    });
    await screenshot(page, `prompt-recommended-${viewport.width}.png`);
    if (viewport.width <= 760) {
        await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
        assert.ok(await content.evaluate(node => node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 2), '手机正文能够滚动到末尾');
        await screenshot(page, `prompt-content-end-${viewport.width}.png`);
        await content.evaluate(node => { node.scrollTop = 0; });
    }
    await button('修改提示词名称').click();
    await screenshot(page, `prompt-rename-${viewport.width}.png`);
    const renameBounds = await editor.boundingBox();
    assert.ok(renameBounds.width <= 440 && renameBounds.height < 300, '只改名字使用小弹窗');
    if (viewport.width <= 760) {
        assert.ok(Math.abs(renameBounds.y + renameBounds.height / 2 - viewport.height / 2) < 1,
            '手机键盘未显示时，修改名称弹窗居中');
        await page.evaluate(() => {
            Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 300 });
            Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 40 });
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
        const keyboardBounds = await editor.boundingBox();
        assert.ok(Math.abs(keyboardBounds.y + keyboardBounds.height / 2 - 190) < 1,
            '可见区域缩小且向下偏移时，弹窗在该区域居中');
        await screenshot(page, `prompt-rename-keyboard-${viewport.width}.png`);
        await name.fill('默认提示词'); await editor.getByRole('button', { name: '保存', exact: true }).click();
        const compactFooter = await editor.getByRole('button', { name: '保存', exact: true }).boundingBox();
        const nameBounds = await name.boundingBox();
        assert.ok(nameBounds.y >= 40 && nameBounds.y + nameBounds.height <= 340,
            '手机键盘显示及名称报错时，名称输入框仍在可见范围');
        assert.ok(compactFooter.y >= 40 && compactFooter.y + compactFooter.height <= 340,
            '手机键盘显示及名称报错时，保存按钮仍在可见范围');
        await screenshot(page, `prompt-rename-keyboard-error-${viewport.width}.png`);
        await name.fill('强调完整性');
        await page.evaluate(() => {
            delete window.visualViewport.height; delete window.visualViewport.offsetTop;
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
        const restoredBounds = await editor.boundingBox();
        assert.ok(Math.abs(restoredBounds.y + restoredBounds.height / 2 - viewport.height / 2) < 1,
            '手机键盘收起后，修改名称弹窗恢复屏幕居中');
    }
    await page.keyboard.press('Escape');
    assert.equal(await editor.count(), 0); assert.equal(await panel.isVisible(), true, 'Escape 只关闭改名弹窗');
    await position.selectOption('user-before'); await position.selectOption('user-after');
    assert.equal((await saved()).playPromptConfig.position, 'user-after');
    await button('新增提示词').click();
    assert.equal(await name.inputValue(), ''); assert.equal(await draftContent.inputValue(), '');
    await name.fill('默认提示词'); await draftContent.fill('名称冲突的内容');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(await editor.getByRole('alert').textContent(), '已有同名提示词，请换一个名称。');
    await name.fill('雨夜故事'); await draftContent.fill('保留 {{user}} 和 {{char}}。\n完整讲述这个故事。');
    await screenshot(page, `prompt-new-${viewport.width}.png`);
    const bounds = await editor.boundingBox();
    if (viewport.width <= 760) {
        assert.deepEqual(bounds, { x: 0, y: 0, width: viewport.width, height: viewport.height }, '手机编辑页铺满可见屏幕');
        await page.evaluate(() => document.querySelector('dialog.teahouse-dialog').style.setProperty('--tea-viewport-height', '430px'));
        assert.equal((await editor.boundingBox()).height, 430, '键盘缩小可见屏幕时编辑页跟着缩小');
        assert.ok((await editor.getByRole('button', { name: '保存', exact: true }).boundingBox()).y < 430, '键盘显示时保存按钮仍可见');
        await screenshot(page, `prompt-keyboard-${viewport.width}.png`);
        await page.evaluate(() => document.querySelector('dialog.teahouse-dialog').style.removeProperty('--tea-viewport-height'));
    } else {
        assert.ok(bounds.width <= 720 && bounds.x > 0 && bounds.height < viewport.height);
    }
    const contentBounds = await draftContent.boundingBox(), footerBounds = await editor.locator('footer').boundingBox();
    assert.ok(footerBounds.y - contentBounds.y - contentBounds.height <= 30, '内容填写区域使用编辑页剩余空间');
    assert.ok(await editor.evaluate(node => node.scrollWidth - node.clientWidth <= 1));
    assert.equal(await draftContent.evaluate(node => getComputedStyle(node).fontSize), '16px', '新增输入文字为16px，避免手机聚焦缩放');
    const cancelBounds = await editor.getByRole('button', { name: '取消', exact: true }).boundingBox();
    assert.ok(cancelBounds.width >= 80 && cancelBounds.height >= 44, '取消按钮有足够的点击区域');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const customId = await select.inputValue(); assert.ok(customId.startsWith('custom-'));
    assert.equal((await saved()).playPromptConfig.presets.length, 3);
    assert.equal(await content.inputValue(), '保留 {{user}} 和 {{char}}。\n完整讲述这个故事。');
    await content.fill('修改后的要求');
    await button('修改提示词名称').click(); await name.fill('雨夜完整故事');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(await select.locator('option:checked').textContent(), '雨夜完整故事');
    assert.equal(await content.inputValue(), '修改后的要求', '改名不改变已编辑的内容');
    await page.reload(); await open();
    assert.equal(await select.inputValue(), customId); assert.equal(await position.inputValue(), 'user-after');
    assert.equal(await content.inputValue(), '修改后的要求');
    await content.fill('正在编辑的内容'); await content.focus();
    await content.evaluate(node => node.setSelectionRange(2, 5));
    await page.evaluate(() => { ui.refreshStatus(); ui.refresh(); });
    assert.equal(await content.inputValue(), '正在编辑的内容');
    assert.equal(await content.evaluate(node => node === document.activeElement && node.selectionStart === 2 && node.selectionEnd === 5), true, '目录更新保留正在编辑的正文和光标');
    await button('修改提示词名称').click(); await name.fill('未保存的名字');
    await page.evaluate(() => { ui.refreshStatus(); ui.refresh(); });
    assert.equal(await name.inputValue(), '未保存的名字');
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await select.locator('option:checked').textContent(), '雨夜完整故事');
    await button('删除提示词').click();
    assert.equal((await saved()).playPromptConfig.presets.length, 3, '删除先显示确认弹窗');
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await content.inputValue(), '正在编辑的内容');
    await button('删除提示词').click();
    await editor.getByRole('button', { name: '确认删除', exact: true }).click();
    assert.equal(await select.inputValue(), 'default'); assert.equal(await position.inputValue(), 'user-after');
    assert.equal((await saved()).playPromptConfig.presets.length, 2);
    await content.fill('');
    await page.reload(); await open(); assert.equal(await content.inputValue(), '', '刷新后保留空内容');
    await button('修改提示词名称').click();
    const longName = '适合长篇故事和完整世界观变化的提示词名称'.repeat(4);
    await name.fill(longName); await editor.getByRole('button', { name: '保存', exact: true }).click();
    assert.ok(await panel.evaluate(node => node.scrollWidth - node.clientWidth <= 1), '长名字不撑宽面板');
    await select.selectOption('recommended');
    await panel.locator('.play-prompt-settings').scrollIntoViewIfNeeded();
    await screenshot(page, `prompt-settings-${viewport.width}.png`);
    assert.ok((await panel.innerText()).includes('小剧场生成'));
    assert.equal(await panel.locator('vite-error-overlay, nextjs-portal').count(), 0);
    assert.ok(await panel.evaluate(node => node.scrollWidth - node.clientWidth <= 1));
    assert.equal(await page.evaluate(() => captured.length), 0, '设置操作没有发送模型请求');
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 820, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            const url = `http://127.0.0.1:${server.address().port}/`;
            await verify(page, url, viewport); assert.deepEqual(errors, []);
            console.log(JSON.stringify({ url, viewport, checks: '正文直接编辑与自动保存、只改名、名称校验、新增删除、插入位置同行及右侧对齐、纯图标无边框、无聚焦高亮框、重载、焦点、长名字、手机全屏与键盘、无溢出', errors }));
            await context.close();
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
