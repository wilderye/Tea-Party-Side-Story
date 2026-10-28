// Flow: open a message -> delete/cancel -> verify saved history and surviving messages.
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

async function openPlay(page, url) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url);
    assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator('#teahouse-panel');
    await panel.getByRole('button', { name: '剧场演出', exact: true }).filter({ visible: true }).click();
    await panel.locator('.play-record').filter({ visible: true }).first().waitFor();
    await page.evaluate(() => {
        window.confirmDeletion = 1;
        ctx.callGenericPopup = async (body, type, value, options) => {
            window.deleteConfirmation = { text: body.textContent, type, options };
            return window.confirmDeletion;
        };
    });
    return panel;
}

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verifyDeletion(page, url, viewport) {
    const panel = await openPlay(page, url);
    const id = await page.evaluate(async () => {
        const round = await runtime.getRound(seed.a);
        await testHistory.editResult(round.id, round.results[0].id, '茶壶里的水刚好沸腾。\n\n“要再来一杯吗？”她轻声问。', round.results[0].text);
        const next = await testHistory.begin({ roundId: round.id, character: ctx.characters[0],
            resultId: crypto.randomUUID(), startedAt: new Date().toISOString(), context: round.results[0].context });
        await testHistory.saveResult(round.id, next.results.at(-1).id,
            { status: 'complete', text: '窗外的雨渐渐停了。\n\n他将茶杯放回桌上，笑着点了点头。', finishedAt: new Date().toISOString() });
        await ui.refresh(); return round.id;
    });
    const record = panel.locator(`[data-record="${id}"]`);
    const user = record.locator('.play-user-message'), reply = record.locator('.play-assistant-message');
    const removeUser = user.getByRole('button', { name: '删除用户消息', exact: true });
    const removeReply = reply.getByRole('button', { name: '删除 AI 消息', exact: true });
    await record.getByRole('button', { name: '第 2 / 2 个结果，选择历史结果', exact: true }).waitFor();
    await reply.getByRole('button', { name: '收藏演出记录', exact: true }).click();
    await reply.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    const favorite = await page.evaluate(async () => (await runtime.listFavorites())[0]);
    const layout = await record.evaluate(node => {
        const header = node.querySelector('.play-assistant-meta'), buttons = [...header.querySelectorAll('button')];
        const rects = buttons.map(button => button.getBoundingClientRect());
        const area = header.getBoundingClientRect();
        const box = selector => node.querySelector(selector).getBoundingClientRect();
        const userAvatar = box('.play-user-meta .play-message-avatar'), replyAvatar = box('.play-assistant-meta .play-message-avatar');
        const userIdentity = box('.play-user-meta .play-message-identity'), replyIdentity = box('.play-assistant-meta .play-message-identity');
        return { labels: buttons.map(button => button.getAttribute('aria-label')),
            avatarsAligned: Math.abs(userAvatar.left - replyAvatar.left) < 1 && Math.abs(userAvatar.left - box('.play-user-text').left) < 1,
            namesAligned: Math.abs(userIdentity.left - replyIdentity.left) < 1 && userIdentity.left > userAvatar.right,
            userOnRight: Math.abs(userAvatar.right - box('.play-user-text').right) < 1 && userIdentity.right < userAvatar.left
                && box('.play-user-meta .play-header-actions').right < userIdentity.left
                && Math.abs(box('.play-user-meta .play-speaker').right - box('.play-user-meta .play-message-time').right) < 1,
            sameRow: rects.every(rect => Math.abs(rect.top - rects[0].top) < 1),
            inside: rects.every(rect => rect.left >= area.left - 1 && rect.right <= area.right + 1),
            separate: rects.every((rect, index) => index === 0 || rect.left >= rects[index - 1].right) };
    });
    assert.deepEqual(layout.labels, ['创建分支', '取消收藏', '编辑回复原文', '删除 AI 消息']);
    if (viewport.width <= 760) assert.equal(layout.avatarsAligned && layout.namesAligned, true, '手机端用户与 AI 的头像、姓名和时间共用左侧排列');
    else assert.equal(layout.userOnRight, true, '电脑端用户头像、姓名和时间靠右，操作按钮在其左侧');
    assert.equal(layout.sameRow && layout.inside && layout.separate, true, '收藏、编辑、删除在同一行且不重叠');
    await record.evaluate(node => {
        const feed = node.closest('.play-feed'); feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - 10;
    });
    await screenshot(page, `message-actions-${viewport.width}.png`);

    await page.evaluate(() => { window.confirmDeletion = 0; });
    await removeReply.click();
    await page.waitForFunction(() => !!window.deleteConfirmation);
    assert.match(await page.evaluate(() => deleteConfirmation.text), /全部 2 个生成版本/);
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).results.length, 2);
    assert.equal(await reply.isVisible(), true, '取消删除保留原消息');

    await page.evaluate(() => { window.confirmDeletion = 1; window.failSave = true; });
    await removeReply.click();
    await panel.getByText('模拟保存失败', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).results.length, 2);
    assert.equal(await reply.isVisible(), true, '保存失败时不先从界面移除消息');

    await page.evaluate(() => { window.failSave = false; });
    await removeReply.click();
    await reply.waitFor({ state: 'hidden' });
    assert.equal(await user.isVisible(), true);
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).results.length, 0);
    assert.equal((await page.evaluate(id => runtime.getFavorite(id), favorite.id)).text, '窗外的雨渐渐停了。\n\n他将茶杯放回桌上，笑着点了点头。');
    await user.getByRole('button', { name: '生成回复', exact: true }).click();
    await page.waitForFunction(() => runtime.getState().phase === 'generating');
    assert.equal(await removeUser.isDisabled(), true);
    assert.equal(await removeReply.isDisabled(), true);
    assert.equal(await page.evaluate(() => capturedPrompts.at(-1)), '测试小剧场');
    await page.evaluate(() => finishGeneration('删除旧消息后重新生成的回复。'));
    await page.waitForFunction(() => runtime.getState().phase === 'idle');
    await reply.getByText('删除旧消息后重新生成的回复。', { exact: true }).waitFor();
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).results.length, 1);

    await removeUser.click(); await user.waitFor({ state: 'hidden' });
    assert.equal(await reply.isVisible(), true);
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).prompt, null);
    assert.equal(await reply.getByRole('button', { name: '重新生成', exact: true }).isVisible(), false);
    assert.equal(await reply.getByRole('button', { name: '下一个结果', exact: true }).isDisabled(), true);
    await screenshot(page, `message-user-deleted-${viewport.width}.png`);

    await openPlay(page, url);
    await reply.getByText('删除旧消息后重新生成的回复。', { exact: true }).waitFor();
    assert.equal(await user.isVisible(), false, '重新打开不恢复已删除用户消息');
    await removeReply.click(); await record.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(async id => {
        const owner = (await runtime.listCharacters()).find(item => item.avatar === 'A.png');
        return (await runtime.listRounds(owner.id)).some(row => row.id === id);
    }, id), false);
    assert.equal((await page.evaluate(() => runtime.listFavorites())).length, 1);
    assert.deepEqual(await page.evaluate(() => ctx.chat), [{ mes: '原聊天', is_user: false }]);
    assert.equal(await panel.locator('.play-record').filter({ visible: true }).count(), 1, '其他演出记录保持可读');
}

async function verifyEditPosition(page, url, viewport) {
    await page.evaluate(() => localStorage.clear());
    const panel = await openPlay(page, url);
    const ids = await page.evaluate(async () => {
        const target = await testHistory.getRound(seed.hidden);
        const trailing = await testHistory.begin({ character: ctx.characters[0], prompt: '末尾用户消息',
            resultId: crypto.randomUUID(), startedAt: new Date().toISOString(), context: target.results[0].context });
        await testHistory.saveResult(trailing.id, trailing.results[0].id, { status: 'complete',
            text: Array.from({ length: 45 }, (_, index) => `后续消息第 ${index + 1} 段。`).join('\n\n'), finishedAt: new Date().toISOString() });
        await ui.refresh(); return { target: target.id, trailing: trailing.id };
    });
    const record = panel.locator(`[data-record="${ids.target}"]`), feed = panel.locator('.play-feed');
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metrics = head => head.evaluate(node => ({ head: node.getBoundingClientRect().top,
        body: node.parentElement.children[1].getBoundingClientRect().top, scroll: node.closest('.play-feed').scrollTop }));
    const composer = panel.getByRole('textbox', { name: '小剧场提示词', exact: true, includeHidden: true });
    await composer.fill('编辑时保留的输入草稿');
    for (const role of ['user', 'assistant']) {
        const head = record.locator(`.play-${role}-meta`);
        for (const long of [false, true]) {
            const text = long ? Array.from({ length: 50 }, (_, index) => `编辑定位第 ${index + 1} 段，保留这段文字。`).join('\n\n') : '一段简短的消息。';
            await page.evaluate(async ({ id, role, text }) => {
                const round = await testHistory.getRound(id);
                if (role === 'user') await testHistory.editPrompt(id, text, round.prompt);
                else await testHistory.editResult(id, round.results[0].id, text, round.results[0].text);
                await ui.refresh();
            }, { id: ids.target, role, text });
            await record.locator(role === 'user' ? '.play-user-text' : '.play-results').getByText(long ? '编辑定位第 1 段，保留这段文字。' : text, { exact: true }).waitFor();
            for (const finish of ['取消', '保存']) {
                await head.evaluate(node => {
                    const feed = node.closest('.play-feed');
                    feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - 170;
                });
                await settle(); const before = await metrics(head);
                if (long && finish === '取消') await screenshot(page, `edit-${role}-before-${viewport.width}.png`);
                await head.getByRole('button', { name: role === 'user' ? '修改提示词' : '编辑回复原文', exact: true }).click();
                const editor = record.getByRole('textbox', { name: role === 'user' ? '提示词原文' : '回复原文', exact: true });
                await editor.waitFor(); await settle();
                const during = await metrics(head);
                if (long && finish === '取消') await screenshot(page, `edit-${role}-after-${viewport.width}.png`);
                if (viewport.width <= 760) {
                    const bounds = await feed.boundingBox(), editorBounds = await editor.boundingBox();
                    assert.ok(during.head >= bounds.y && editorBounds.y + editorBounds.height <= bounds.y + bounds.height + 1,
                        '手机进入编辑时让按钮和大编辑框完整显示');
                } else {
                    assert.ok(Math.abs(during.head - before.head) < 2 && Math.abs(during.body - before.body) < 2,
                        `${role} ${long ? '长' : '短'}消息进入编辑不跳动：${JSON.stringify({ before, during })}`);
                }
                assert.equal(await editor.evaluate(node => document.activeElement === node), true);
                assert.equal(await composer.inputValue(), '编辑时保留的输入草稿');
                if (finish === '保存') await editor.fill(text + '\n本次保存。');
                await head.getByRole('button', { name: finish, exact: true }).click();
                await editor.waitFor({ state: 'detached' }); await settle();
                assert.ok(Math.abs((await metrics(head)).head - before.head) < 2, `${role} ${finish}后消息标题仍在原位置`);
            }
        }
    }
    await page.evaluate(async id => {
        const round = await testHistory.getRound(id);
        await testHistory.editResult(id, round.results[0].id, '末尾的简短回复。', round.results[0].text);
        await ui.refresh();
    }, ids.trailing);
    const last = panel.locator(`[data-record="${ids.trailing}"]`);
    await last.getByText('末尾的简短回复。', { exact: true }).waitFor();
    for (const role of ['user', 'assistant']) {
        await feed.evaluate(node => { node.scrollTop = node.scrollHeight; }); await settle();
        const head = last.locator(`.play-${role}-meta`), before = await metrics(head);
        await head.getByRole('button', { name: role === 'user' ? '修改提示词' : '编辑回复原文', exact: true }).click(); await settle();
        const after = await metrics(head);
        if (viewport.width <= 760) {
            const bounds = await feed.boundingBox();
            for (const name of ['保存', '取消']) {
                const action = await head.getByRole('button', { name, exact: true }).boundingBox();
                assert.ok(action.y >= bounds.y && action.y + action.height <= bounds.y + bounds.height,
                    '手机在末尾编辑也露出保存和取消按钮');
            }
        } else {
            assert.ok(Math.abs(after.head - before.head) < 2, `停在末尾时编辑 ${role} 不自动回到消息顶部：${JSON.stringify({ before, after })}`);
        }
        await head.getByRole('button', { name: '取消', exact: true }).click(); await settle();
        if (viewport.width <= 760) assert.ok(Math.abs((await metrics(head)).head - before.head) < 2, '手机退出编辑后回到原阅读位置');
    }
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            await verifyDeletion(page, url, viewport);
            await verifyEditPosition(page, url, viewport);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ viewport, url, checks: 'message delete, all versions, cancel, failed save, favorite copy, regenerate, reload, responsive user header alignment, edit/save/cancel position for long and short messages, main chat unchanged', errors }));
            await context.close();
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
