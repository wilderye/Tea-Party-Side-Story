// Browser plugin not available; validate the real panel with Playwright + Edge.
// Flow: inherit Enter setting -> scoped add button -> select role -> save/read/edit.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: base } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = base.replace('<title>小剧场设置与原文编辑验证</title>', '<title>手动收藏与 Enter 发送验证</title>')
    .replace('const settings=JSON.parse', "ctx.shouldSendOnEnter=()=>window.enterMode===1||(window.enterMode===0&&!window.mobileDevice);window.enterMode=-1;const settings=JSON.parse");
const server = http.createServer(async (request, response) => {
    try {
        const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
        if (!relative) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (relative === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, relative);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            const url = `http://127.0.0.1:${server.address().port}/`;
            await page.goto(url); await page.waitForFunction(() => window.ready);
            assert.equal(page.url(), url); assert.equal(await page.title(), '手动收藏与 Enter 发送验证');
            await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
            const panel = page.locator('#teahouse-panel');
            const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
            const plus = () => panel.locator('.tea-topbar .tea-actions button, .tea-brand .tea-actions button, .play-favorite-mobile-head .tea-actions button')
                .filter({ has: page.locator('svg path[d="M12 4v16M4 12h16"]') }).filter({ visible: true });
            assert.equal(await plus().count(), 0, '茶会选集不显示加号');
            await button('亲笔手稿').click(); assert.equal(await button('新建手稿').count(), 1);
            await button('新建手稿').click(); assert.equal(await plus().count(), 0, '手稿编辑不显示加号');
            await button('关闭编辑，返回列表').click();
            await button('设置').click(); await page.waitForFunction(() => document.querySelector('#teahouse-panel').dataset.mode === 'settings');
            assert.equal(await plus().count(), 0, '设置页不显示加号');
            await button(viewport.width <= 760 ? '返回列表' : '设置').click();
            await button('我的收藏').click(); assert.equal(await plus().count(), 0);
            await button('随文剧场').click(); assert.equal(await plus().count(), 0);
            await button('剧场演出').click(); assert.equal(await plus().count(), 0);
            const input = panel.getByRole('textbox', { name: '小剧场提示词', exact: true }); await input.waitFor();
            await input.fill('禁用'); await input.press('Enter'); await input.press('Shift+Enter');
            assert.equal(await input.inputValue(), '禁用\n\n'); assert.equal(await page.evaluate(() => captured.length), 0);
            await page.evaluate(() => window.enterMode = 1);
            await input.fill('启用'); await input.press('Shift+Enter');
            assert.equal(await input.inputValue(), '启用\n');
            await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
            assert.equal(await page.evaluate(() => captured.length), 0, '输入法确认不发送');
            async function sendByKey(key, text) {
                await input.fill(text); await input.press(key);
                await page.waitForFunction(() => runtime.getState().phase === 'generating');
                await page.evaluate(() => { emitGeneration('合成回复'); finishGeneration('合成回复'); });
                await page.waitForFunction(() => runtime.getState().phase === 'idle');
            }
            await sendByKey('Enter', '启用后发送');
            await page.evaluate(() => { window.enterMode = 0; window.mobileDevice = true; });
            await input.fill('自动手机'); await input.press('Enter'); assert.equal(await input.inputValue(), '自动手机\n');
            await page.evaluate(() => window.mobileDevice = false); await sendByKey('Enter', '自动电脑');
            await page.evaluate(() => window.enterMode = -1); await sendByKey('Control+Enter', '保留快捷键');
            const roundOwner = await page.evaluate(async () => (await testHistory.getRound(seed.a)).characterId);
            const oldRoundCount = await page.evaluate(async id => (await testHistory.listRounds(id)).length, roundOwner);
            const main = await page.evaluate(() => ({ characterId: ctx.characterId, chat: ctx.chat, settings: ctx.extensionSettings }));
            await page.evaluate(async () => {
                for (let i = 0; i < 40; i++) ctx.characters.push({ avatar: 'synthetic-' + i + '.png', name: '合成角色' + String(i).padStart(2, '0') });
                ctx.characters.push({ avatar: 'same-one.png', name: '同名角色' }, { avatar: 'same-two.png', name: '同名角色' });
                const start = new Date().toISOString(), id = crypto.randomUUID();
                await testHistory.begin({ character: { avatar: 'deleted.png', name: '已删除角色' }, prompt: '旧提示词', resultId: id, startedAt: start, context: { chatId: 'old', apiMode: 'tavern' } });
                await testHistory.renameCharacter('deleted.png', null);
            });
            await button('我的收藏').click(); await button('演出记录').click();
            await button('添加演出记录收藏').click(); assert.equal(await plus().count(), 0);
            const composer = panel.getByRole('region', { name: '添加演出记录收藏', exact: true });
            const title = composer.getByRole('textbox', { name: '收藏标题', exact: true });
            const text = composer.getByRole('textbox', { name: '收藏内容', exact: true });
            assert.equal(await composer.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
            await title.fill('自行添加'); await text.fill('**手动正文**\n第二段原文');
            await composer.getByRole('button', { name: '选择角色', exact: true }).click();
            const picker = composer.getByRole('dialog', { name: '选择收藏所属角色', exact: true });
            await picker.waitFor(); await page.keyboard.press('Escape');
            assert.equal(await picker.isVisible(), false); assert.equal(await title.inputValue(), '自行添加');
            await composer.getByRole('button', { name: '选择角色', exact: true }).click();
            await screenshot(page, `${viewport.width}-manual-picker.png`);
            const pickerBox = await picker.locator('.play-character-browser').boundingBox(), panelBox = await panel.boundingBox();
            assert.ok(pickerBox.x >= panelBox.x && pickerBox.x + pickerBox.width <= panelBox.x + panelBox.width + 1);
            assert.ok(pickerBox.y >= panelBox.y && pickerBox.y + pickerBox.height <= panelBox.y + panelBox.height + 1);
            if (viewport.width > 760) {
                assert.equal(await picker.getByRole('button', { name: '下一页角色', exact: true }).isDisabled(), false);
                await picker.getByRole('button', { name: '下一页角色', exact: true }).click();
                assert.ok((await picker.locator('.tea-page-current').innerText()) !== '01');
            } else {
                await picker.locator('.play-people').evaluate(node => node.scrollTop = node.scrollHeight);
                await page.waitForFunction(() => document.querySelector('.play-favorite-picker-overlay .play-people').querySelectorAll('button').length > 24);
                assert.ok(Math.abs(pickerBox.width - panelBox.width) < 1, '手机角色界面占满面板');
            }
            const search = picker.getByRole('searchbox', { name: '搜索角色', exact: true });
            await search.fill('已删除角色'); await picker.getByText('没有找到这个角色', { exact: true }).waitFor();
            await search.fill('同名角色'); await picker.getByRole('button', { name: '同名角色', exact: true }).first().waitFor();
            assert.equal(await picker.getByRole('button', { name: '同名角色', exact: true }).count(), 2);
            await picker.getByRole('button', { name: '同名角色', exact: true }).nth(1).click();
            assert.equal(await picker.isVisible(), false); assert.equal(await title.inputValue(), '自行添加');
            assert.equal(await text.inputValue(), '**手动正文**\n第二段原文');
            await screenshot(page, `${viewport.width}-manual-form.png`);
            await page.evaluate(() => window.failSave = true);
            await composer.getByRole('button', { name: '保存', exact: true }).click();
            await composer.getByRole('alert').waitFor(); assert.equal(await title.inputValue(), '自行添加');
            assert.equal(await text.inputValue(), '**手动正文**\n第二段原文');
            await page.evaluate(() => { window.failSave = false; ctx.characters = ctx.characters.filter(card => card.avatar !== 'same-two.png'); });
            await composer.getByRole('button', { name: '保存', exact: true }).click();
            await composer.getByText('所选角色卡已不存在，请重新选择角色。', { exact: true }).waitFor();
            await composer.getByRole('button', { name: '选择角色', exact: true }).click();
            await search.fill('同名角色'); await picker.getByRole('button', { name: '同名角色', exact: true }).click();
            await composer.getByRole('button', { name: '保存', exact: true }).click();
            const reader = panel.locator('.play-favorite-reading:visible');
            await reader.getByText('手动正文', { exact: true }).waitFor();
            const saved = await page.evaluate(async () => { const row = (await runtime.listFavorites())[0]; return runtime.getFavorite(row.id); });
            assert.equal(saved.source.characterAvatar, 'same-one.png'); assert.equal(saved.source.type, 'manual');
            assert.equal(saved.characterName, '同名角色'); assert.equal(saved.text, '**手动正文**\n第二段原文');
            assert.deepEqual(await page.evaluate(() => ({ characterId: ctx.characterId, chat: ctx.chat, settings: ctx.extensionSettings })), main);
            assert.equal(await button('添加演出记录收藏').count(), 1, '电脑和手机阅读收藏时都有加号');
            assert.ok(await panel.evaluate(node => node.scrollWidth - node.clientWidth <= 1), '收藏阅读及顶部按钮不横向溢出');
            for (const control of await button('添加演出记录收藏').all()) {
                const bounds = await control.boundingBox(), area = await panel.boundingBox();
                assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width + 1, '加号按钮位于面板内');
            }
            await screenshot(page, `${viewport.width}-manual-reading.png`);
            await reader.getByRole('button', { name: '编辑演出记录收藏', exact: true }).click();
            assert.equal(await plus().count(), 0, '收藏编辑时隐藏加号');
            await reader.getByRole('textbox', { name: '收藏标题', exact: true }).fill('');
            await reader.getByRole('textbox', { name: '收藏内容', exact: true }).fill('改后的第一行\n第二行');
            await reader.getByRole('button', { name: '保存', exact: true }).click();
            await reader.getByText('改后的第一行', { exact: false }).waitFor();
            assert.equal(await reader.locator('.play-favorite-title').isVisible(), false);
            if (viewport.width <= 760) await button('返回收藏目录').click();
            assert.ok((await panel.locator(`.tea-story[data-id="${saved.id}"]`).innerText()).includes('改后的第一行'));
            await page.reload(); await page.waitForFunction(() => window.ready);
            await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
            await button('我的收藏').click(); await button('演出记录').click();
            await panel.locator('.tea-story').filter({ hasText: '改后的第一行' }).click();
            await reader.getByText('改后的第一行', { exact: false }).waitFor();
            await reader.getByRole('button', { name: '取消收藏', exact: true }).click();
            await page.waitForFunction(async () => (await runtime.listFavorites()).length === 0);
            await button('添加演出记录收藏').click();
            await title.fill('暂未保存');
            await page.evaluate(() => ctx.callGenericPopup = async () => 0);
            await composer.getByRole('button', { name: '取消添加收藏', exact: true }).click();
            assert.equal(await title.inputValue(), '暂未保存', '取消放弃时保留草稿');
            await page.evaluate(() => ctx.callGenericPopup = async () => 1);
            await composer.getByRole('button', { name: '取消添加收藏', exact: true }).click();
            assert.equal(await composer.count(), 0);
            await button('剧场演出').click();
            if (viewport.width <= 760) await button('选择角色').click();
            await panel.locator('.play-people').getByRole('button', { name: '测试乙', exact: true }).click();
            await panel.locator(`[data-record]`).filter({ hasText: '乙的旧记录' }).filter({ visible: true }).waitFor();
            if (viewport.width <= 760) await button('选择角色').click();
            await panel.locator('.play-people').getByRole('button', { name: '测试甲', exact: true }).click();
            const sourceRecord = panel.locator(`[data-record="${await page.evaluate(() => seed.a)}"]`);
            await sourceRecord.getByRole('button', { name: '收藏演出记录', exact: true }).click();
            await page.waitForFunction(async () => (await runtime.listFavorites()).length === 1);
            const generatedFavorite = await page.evaluate(async () => (await runtime.listFavorites())[0]);
            await button('我的收藏').click(); await button('演出记录').click();
            await button('添加演出记录收藏').click();
            await text.fill('与生成收藏并存'); await composer.getByRole('button', { name: '选择角色', exact: true }).click();
            await picker.getByRole('searchbox', { name: '搜索角色', exact: true }).fill('测试乙');
            await picker.getByRole('button', { name: '测试乙', exact: true }).click();
            await composer.getByRole('button', { name: '保存', exact: true }).click();
            await reader.getByText('与生成收藏并存', { exact: true }).waitFor();
            assert.equal(await page.evaluate(async () => (await runtime.listFavorites()).length), 2);
            assert.equal(await page.evaluate(id => runtime.getFavorite(id).then(value => value.source.type), generatedFavorite.id), undefined);
            if (viewport.width <= 760) await button('返回收藏目录').click();
            await button('剧场演出').click();
            await sourceRecord.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
            assert.equal(await sourceRecord.getByRole('button', { name: '取消收藏', exact: true }).getAttribute('aria-pressed'), 'true');
            assert.ok(await panel.evaluate(node => node.scrollWidth - node.clientWidth <= 1));
            assert.equal(await page.evaluate(async id => (await testHistory.listRounds(id)).length, roundOwner), oldRoundCount);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ viewport, url, checks: 'Enter设置、加号位置、角色搜索/分页、同名角色、删卡保护、保存失败保留草稿、读写恢复及取消收藏', errors }));
            await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
