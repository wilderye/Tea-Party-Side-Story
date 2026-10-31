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
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
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
async function verifyHeaderSpacing(record, viewport) {
    const layouts = await record.locator('.play-message-meta').evaluateAll(headers => headers.map(header => {
        const identity = header.querySelector('.play-message-identity'), bounds = identity.getBoundingClientRect();
        const contents = [...identity.children].map(node => node.getBoundingClientRect());
        const line = getComputedStyle(header, '::after');
        return { slack: bounds.width - Math.max(...contents.map(rect => rect.width)),
            height: line.height, minHeight: line.minHeight, maxHeight: line.maxHeight,
            margins: [line.marginLeft, line.marginRight], borders: [line.borderTopWidth, line.borderBottomWidth],
            padding: [line.paddingTop, line.paddingBottom], display: line.display };
    }));
    for (const layout of layouts) {
        if (viewport.width <= 760) { assert.equal(layout.display, 'none', '手机头部不显示横线'); continue; }
        assert.ok(layout.slack < 1, '名字和时间的区域按实际内容取宽，不为短名字保留大片空位');
        assert.equal(layout.height, '1px'); assert.equal(layout.minHeight, '1px'); assert.equal(layout.maxHeight, '1px');
        assert.deepEqual(layout.borders, ['0px', '0px']); assert.deepEqual(layout.padding, ['0px', '0px'], '横线没有额外厚度');
        assert.deepEqual(layout.margins, ['0px', '0px'], '横线只使用头部间距，不再叠加边距');
    }
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
    await verifyHeaderSpacing(record, viewport);
    const user = record.locator('.play-user-message'), reply = record.locator('.play-assistant-message');
    const removeUser = user.getByRole('button', { name: '删除用户消息', exact: true, includeHidden: true });
    const userMore = user.getByRole('button', { name: '更多消息操作', exact: true });
    const removeReply = reply.getByRole('button', { name: '删除 AI 消息', exact: true, includeHidden: true });
    await record.getByRole('button', { name: '第 2 / 2 个结果，选择历史结果', exact: true }).waitFor();
    await reply.getByRole('button', { name: '收藏演出记录', exact: true }).click();
    await reply.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    const favorite = await page.evaluate(async () => (await runtime.listFavorites())[0]);
    const visibleLabels = () => reply.locator('.play-header-actions').evaluate(tools => [...tools.querySelectorAll('button')]
        .filter(button => button.getClientRects().length).map(button => button.getAttribute('aria-label')));
    const more = reply.getByRole('button', { name: '更多回复操作', exact: true });
    const deleteReply = async () => { if (await more.isVisible()) await more.click(); await removeReply.click(); };
    assert.deepEqual(await visibleLabels(), ['取消收藏', '编辑回复原文', '更多回复操作'], '两端默认只显示收藏、编辑和最右侧的更多');
    const starStyle = await reply.locator('.tea-star').evaluate(node => ({ background: getComputedStyle(node).backgroundColor,
        fill: getComputedStyle(node.querySelector('svg')).fill }));
    assert.equal(starStyle.background, 'rgba(0, 0, 0, 0)', '已收藏只填充星星内部，不显示方块底色');
    assert.notEqual(starStyle.fill, 'none');
    await more.click(); await reply.locator('.play-header-actions').press('Escape');
    assert.deepEqual(await visibleLabels(), ['取消收藏', '编辑回复原文', '更多回复操作'], 'Esc 收起按钮');
    assert.equal(await more.evaluate(node => document.activeElement === node), true, 'Esc 后焦点回到更多');
    await more.click(); await reply.locator('.play-results').click();
    assert.deepEqual(await visibleLabels(), ['取消收藏', '编辑回复原文', '更多回复操作'], '点击按钮区外面收起按钮');
    await screenshot(page, `message-collapsed-${viewport.width}.png`);
    for (const message of [user, reply]) {
        const tools = message.locator('.play-header-actions'), toggle = tools.locator('.play-reply-more');
        const before = await tools.boundingBox();
        await toggle.click();
        const after = await tools.boundingBox();
        if (viewport.width > 760) {
            assert.ok(Math.abs(before.x + before.width - after.x - after.width) < 1, '电脑版更多向左展开，操作区右边缘不移动');
            assert.ok(after.x <= before.x, '新增操作向左展开；只有删除一项时替换更多的位置');
        }
        if (message === user) await tools.press('Escape');
    }
    const layout = await record.evaluate(node => {
        const header = node.querySelector('.play-assistant-meta'), buttons = [...header.querySelectorAll('button')].filter(button => button.getClientRects().length);
        const rects = buttons.map(button => button.getBoundingClientRect());
        const area = header.getBoundingClientRect();
        const box = selector => node.querySelector(selector).getBoundingClientRect();
        const userAvatar = box('.play-user-meta .play-message-avatar'), replyAvatar = box('.play-assistant-meta .play-message-avatar');
        const userIdentity = box('.play-user-meta .play-message-identity'), replyIdentity = box('.play-assistant-meta .play-message-identity');
        const replyTools = box('.play-assistant-meta .play-header-actions'), replyTime = box('.play-assistant-meta .play-message-time');
        return { labels: buttons.map(button => button.getAttribute('aria-label')),
            centered: [userAvatar, replyAvatar, userIdentity, replyIdentity, replyTools].every(rect => Math.abs((rect.left + rect.right) / 2 - (area.left + area.right) / 2) < 1),
            stacked: userIdentity.top > userAvatar.bottom && replyIdentity.top > replyAvatar.bottom && replyTools.top > replyIdentity.bottom,
            userOnRight: Math.abs(userAvatar.right - box('.play-user-text').right) < 1 && userIdentity.right < userAvatar.left
                && box('.play-user-meta .play-header-actions').right < userIdentity.left
                && Math.abs(box('.play-user-meta .play-speaker').right - box('.play-user-meta .play-message-time').right) < 1,
            sameRow: rects.every(rect => Math.abs(rect.top - rects[0].top) < 1),
            identityReadable: replyTime.right <= replyIdentity.right + 1 && replyTime.left >= replyIdentity.left - 1
                && (replyTools.left >= replyIdentity.right || replyTools.top >= replyIdentity.bottom),
            inside: rects.every(rect => rect.left >= area.left - 1 && rect.right <= area.right + 1 && rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1),
            bodyGap: box('.play-results').top - area.bottom,
            separate: rects.every((rect, index) => rects.slice(index + 1).every(other => rect.right <= other.left + 1
                || other.right <= rect.left + 1 || rect.bottom <= other.top + 1 || other.bottom <= rect.top + 1)) };
    });
    assert.deepEqual(layout.labels, ['创建分支', '查看实际提示词', '删除 AI 消息', '取消收藏', '编辑回复原文']);
    await verifyHeaderSpacing(record, viewport);
    if (viewport.width <= 760) {
        assert.equal(layout.centered && layout.stacked, true, '手机端头像、姓名和操作按钮分行居中');
        assert.ok(layout.bodyGap >= 8 && layout.bodyGap <= 12, '手机正文距离头部约十像素，仍为按钮留出点击空间');
    }
    else assert.equal(layout.userOnRight, true, '电脑端用户头像、姓名和时间靠右，操作按钮在其左侧');
    assert.equal(layout.identityReadable && layout.inside && layout.separate, true, '按钮不遮挡姓名、时间，也不重叠或越出消息顶部');
    assert.equal(layout.sameRow, true, '320px 手机也能让小图标操作区保持一行');
    await record.evaluate(node => {
        const feed = node.closest('.play-feed'); feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - 10;
    });
    await screenshot(page, `message-actions-${viewport.width}.png`);

    await page.evaluate(() => { window.confirmDeletion = 0; });
    await deleteReply();
    await page.waitForFunction(() => !!window.deleteConfirmation);
    assert.match(await page.evaluate(() => deleteConfirmation.text), /全部 2 个生成版本/);
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).results.length, 2);
    assert.equal(await reply.isVisible(), true, '取消删除保留原消息');

    await page.evaluate(() => { window.confirmDeletion = 1; window.failSave = true; });
    await deleteReply();
    await panel.getByText('模拟保存失败', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).results.length, 2);
    assert.equal(await reply.isVisible(), true, '保存失败时不先从界面移除消息');

    await page.evaluate(() => { window.failSave = false; });
    await deleteReply();
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

    if (await userMore.isVisible()) await userMore.click();
    await removeUser.click(); await user.waitFor({ state: 'hidden' });
    assert.equal(await reply.isVisible(), true);
    assert.equal((await page.evaluate(id => runtime.getRound(id), id)).prompt, null);
    assert.equal(await reply.getByRole('button', { name: '重新生成', exact: true }).isVisible(), false);
    assert.equal(await reply.getByRole('button', { name: '下一个结果', exact: true }).isDisabled(), true);
    await screenshot(page, `message-user-deleted-${viewport.width}.png`);

    await openPlay(page, url);
    await reply.getByText('删除旧消息后重新生成的回复。', { exact: true }).waitFor();
    assert.equal(await user.isVisible(), false, '重新打开不恢复已删除用户消息');
    await deleteReply(); await record.waitFor({ state: 'hidden' });
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
                    const saveBounds = await record.locator('.play-edit-form').getByRole('button', { name: '保存', exact: true }).boundingBox();
                    assert.ok(during.head >= bounds.y && saveBounds.y + saveBounds.height <= bounds.y + bounds.height + 1,
                        '手机进入编辑时露出消息头部及编辑框右上角的按钮');
                    assert.ok(editorBounds.height <= viewport.height * .75 + 1, '长文编辑沿用酒馆高度上限，正文仍可滚动');
                } else {
                    assert.ok(Math.abs(during.head - before.head) < 2 && Math.abs(during.body - before.body) < 2,
                        `${role} ${long ? '长' : '短'}消息进入编辑不跳动：${JSON.stringify({ before, during })}`);
                }
                assert.equal(await editor.evaluate(node => document.activeElement === node), true);
                assert.equal(await composer.inputValue(), '编辑时保留的输入草稿');
                if (finish === '保存') {
                    // Set the draft without Playwright scrolling a tall input into view.
                    await editor.evaluate((node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, text + '\n本次保存。');
                    await settle();
                }
                await record.locator('.play-edit-form').getByRole('button', { name: finish, exact: true }).click();
                await editor.waitFor({ state: 'detached' }); await settle();
                const afterFinish = await metrics(head);
                assert.ok(Math.abs(afterFinish.head - before.head) < 2, `${viewport.width} ${role} ${long ? '长' : '短'}消息 ${finish}后消息标题仍在原位置：${JSON.stringify({ before, during, afterFinish })}`);
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
                const action = await last.locator('.play-edit-form').getByRole('button', { name, exact: true }).boundingBox();
                assert.ok(action.y >= bounds.y && action.y + action.height <= bounds.y + bounds.height,
                    '手机在末尾编辑也露出保存和取消按钮');
            }
        } else {
            assert.ok(Math.abs(after.head - before.head) < 2, `停在末尾时编辑 ${role} 不自动回到消息顶部：${JSON.stringify({ before, after })}`);
        }
        await last.locator('.play-edit-form').getByRole('button', { name: '取消', exact: true }).click(); await settle();
        if (viewport.width <= 760) assert.ok(Math.abs((await metrics(head)).head - before.head) < 2, '手机退出编辑后回到原阅读位置');
    }
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const viewport of [{ width: 1332, height: 896 }, { width: 1024, height: 896 }, { width: 390, height: 844 }, { width: 360, height: 844 }, { width: 320, height: 844 }]) {
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
