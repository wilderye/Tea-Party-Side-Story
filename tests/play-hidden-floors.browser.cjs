// Browser plugin not available. Edge/Playwright with synthetic chat and settings.
// Flow: branch -> hide one floor -> range manager -> save/show -> reopen -> depth refresh.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const setup = String.raw`
// The synthetic page supplies the host's Font Awesome classes used by the plugin.
const iconStyles = document.createElement('style'); iconStyles.textContent = ${JSON.stringify(`
.fa-solid { display:inline-block; font-family:'Font Awesome 6 Free'; font-weight:900; font-style:normal; line-height:1; }
.fa-ghost::before { content:'\\f6e2'; } .fa-eye::before { content:'\\f06e'; } .fa-eye-slash::before { content:'\\f070'; }
`)}; document.head.append(iconStyles);
const originalPopup = ctx.callGenericPopup;
ctx.callGenericPopup = async (content, type, value, options) => {
    if (!content?.classList?.contains('play-hidden-manager')) return originalPopup(content, type, value, options);
    const dialog = document.createElement('dialog'); dialog.className = 'popup';
    dialog.innerHTML = '<div class="popup-body"><div class="popup-content"></div></div>';
    dialog.querySelector('.popup-content').append(content);
    document.body.append(dialog); dialog.showModal();
    return new Promise(resolve => { options.onOpen({ dlg: dialog, complete: async () => {
        if (!options.onClosing()) return; dialog.close(); dialog.remove(); resolve(1);
    } }); });
};
window.depthRules = [];
const originalRules = engine.getScriptsByType;
engine.getScriptsByType = (type, options) => [...originalRules(type, options), ...(type === 0 ? window.depthRules : [])];
`;
const iconFont = process.env.TEA_QA_ICON_FONT ? require('node:fs').readFileSync(process.env.TEA_QA_ICON_FONT).toString('base64') : '';
const pageHtml = harness.replace('window.ready=true;', `${setup}\nwindow.ready=true;`).replace('</style>', `${iconFont ? `@font-face { font-family:'Font Awesome 6 Free'; font-weight:900; src:url(data:font/woff2;base64,${iconFont}) format('woff2'); }` : ''}</style>`);
const server = http.createServer(async (request, response) => {
    try {
        const file = new URL(request.url, 'http://test').pathname.slice(1);
        if (!file) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(pageHtml); }
        if (file === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (!/^(?:[\w-]+\.(?:js|css)|vendor\/markdown-it\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(file)) {
            response.statusCode = 404; return response.end();
        }
        response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2'
            : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, file)));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function verifyFloorHeader(message, viewport) {
    const layout = await message.locator('.play-message-meta').evaluate(node => {
        const box = selector => node.querySelector(selector).getBoundingClientRect();
        const name = box('.play-speaker'), floor = box('.play-floor-number'), time = box('.play-message-time');
        const ghost = node.querySelector('.play-hidden-mark')?.getBoundingClientRect();
        const identity = box('.play-message-identity'), tools = box('.play-header-actions');
        const head = node.getBoundingClientRect();
        const line = getComputedStyle(node, '::after');
        const contentWidth = Math.max(name.width, node.querySelector('.play-message-detail-row').getBoundingClientRect().width);
        const center = rect => (rect.top + rect.bottom) / 2;
        return { belowName: floor.top >= name.bottom && time.top >= name.bottom && (!ghost || ghost.top >= name.bottom),
            sameRow: Math.abs(center(floor) - center(time)) < 1 && (!ghost || Math.abs(center(time) - center(ghost)) < 1),
            gap: time.left - floor.right, ghostGap: ghost ? ghost.left - time.right : null,
            leftAligned: Math.abs(floor.left - name.left) < 1, rightAligned: Math.abs((ghost ?? time).right - name.right) < 1,
            separate: tools.right <= identity.left || tools.left >= identity.right || tools.top >= identity.bottom,
            slack: identity.width - contentWidth, lineHeight: line.height, lineMargin: line.marginLeft,
            inside: [name, floor, time, ghost, tools].filter(Boolean).every(rect => rect.left >= head.left - 1 && rect.right <= head.right + 1) };
    });
    assert.ok(layout.belowName && layout.sameRow, '楼层、时间和隐藏图标在名字下方的同一行');
    assert.equal(layout.gap, 9);
    if (layout.ghostGap !== null) assert.equal(layout.ghostGap, 9, '楼层、时间和隐藏图标用相同间距');
    assert.ok(layout.separate, '名字与楼层信息不遮挡操作按钮');
    assert.ok(layout.inside, '长名字和楼层信息也不越出消息头部');
    if (viewport.width > 760) {
        assert.ok(await message.evaluate(node => node.classList.contains('play-user-message'))
            ? layout.rightAligned : layout.leftAligned, '电脑版用户信息靠右，AI 信息靠左，符合版本 A');
        assert.ok(layout.slack < 1, '分支消息头部也不为短名字保留空位');
        assert.equal(layout.lineHeight, '1px'); assert.equal(layout.lineMargin, '0px');
    }
}
async function verify(page, url, viewport) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.match(await page.title(), /小剧场/);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('剧场演出').click(); await panel.locator('[data-record]').first().waitFor();
    await button('历史记录').click(); await panel.locator(`[data-chat-id]`).first().waitFor();
    const seedId = await page.evaluate(() => seed.a);
    await panel.locator(`[data-chat-id="${seedId}"]`).locator('.play-history-open').click();
    const branch = panel.locator('.play-branch-page'), user = branch.locator('.play-user-message').first(), ai = branch.locator('.play-assistant-message').first();
    await user.waitFor();
    const original = await page.evaluate(() => runtime.getChat(seed.a));
    assert.equal(await user.locator('.play-floor-number').innerText(), '#0');
    const userMore = user.getByRole('button', { name: '更多消息操作', exact: true });
    const toolsBefore = await user.locator('.play-header-actions').boundingBox();
    if (await userMore.isVisible()) {
        assert.equal(await user.getByRole('button', { name: '修改用户消息', exact: true }).isVisible(), true);
        assert.equal(await user.getByRole('button', { name: '隐藏楼层', exact: true }).isVisible(), false);
        assert.equal(await user.getByRole('button', { name: '删除用户消息', exact: true }).isVisible(), false);
        await userMore.click();
    }
    if (viewport.width > 760) {
        const toolsAfter = await user.locator('.play-header-actions').boundingBox();
        assert.ok(Math.abs(toolsBefore.x + toolsBefore.width - toolsAfter.x - toolsAfter.width) < 1, '分支消息的更多也靠右向左展开');
    }
    await user.getByRole('button', { name: '隐藏楼层', exact: true }).click();
    await user.getByRole('img', { name: '已隐藏，不发送给模型' }).waitFor();
    await verifyFloorHeader(user, viewport);
    if (viewport.width <= 760) {
        const layout = await user.locator('.play-message-meta').evaluate(node => {
            const box = selector => node.querySelector(selector).getBoundingClientRect();
            const avatar = box('.play-message-avatar'), name = box('.play-speaker'), floor = box('.play-floor-number'), time = box('.play-message-time'), ghost = box('.play-hidden-mark'), tools = box('.play-header-actions');
            const bounds = node.getBoundingClientRect(), center = (bounds.left + bounds.right) / 2;
            return { centered: [avatar, name, tools].every(item => Math.abs((item.left + item.right) / 2 - center) < 1),
                stacked: avatar.bottom < name.top && name.bottom <= time.top && time.bottom < tools.top,
                gap: time.left - floor.right, ghostGap: ghost.left - time.right,
                bodyGap: node.nextElementSibling.getBoundingClientRect().top - bounds.bottom };
        });
        assert.ok(layout.centered && layout.stacked, '分支手机头部的头像、名字、元信息和按钮分行居中');
        assert.equal(layout.gap, 9); assert.equal(layout.ghostGap, 9, '楼层、时间和小幽灵都用相同间距');
        assert.ok(layout.bodyGap >= 8 && layout.bodyGap <= 12, '分支手机头部到正文也使用缩小后的间距');
    }
    assert.equal((await page.evaluate(() => runtime.getChat(seed.a))).messages[0].text, original.messages[0].text);
    assert.match(await ai.innerText(), /小剧场正文/);
    await button('聊天操作').click(); await button('隐藏楼层管理').click();
    const dialog = page.getByRole('dialog', { name: '隐藏楼层管理' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.play-hidden-ranges').innerText(), '0');
    assert.equal(await dialog.locator('.tea-setting-description').count(), 0);
    assert.equal(await dialog.getByRole('spinbutton').count(), 0);
    assert.equal(await dialog.getByRole('textbox', { name: '起始楼层' }).getAttribute('inputmode'), 'numeric');
    await dialog.getByRole('button', { name: '隐藏', exact: true }).click();
    await dialog.getByText(/请输入有效/).waitFor();
    assert.equal((await page.evaluate(() => runtime.getChat(seed.a))).messages[1].hidden, undefined);
    await dialog.getByRole('textbox', { name: '起始楼层' }).fill('0.5');
    await dialog.getByRole('textbox', { name: '结束楼层' }).fill('1');
    await dialog.getByRole('button', { name: '隐藏', exact: true }).click();
    assert.equal(await dialog.getByText(/请输入有效/).isVisible(), true);
    await dialog.getByRole('textbox', { name: '起始楼层' }).fill('0');
    await dialog.getByRole('button', { name: '隐藏', exact: true }).click();
    await dialog.locator('.play-hidden-ranges').getByText('0–1', { exact: true }).waitFor();
    assert.equal(await ai.getByRole('img', { name: '已隐藏，不发送给模型' }).count(), 1);
    assert.equal(await ai.locator('.play-hidden-mark.fa-ghost').count(), 1);
    assert.equal(await ai.getByRole('button', { name: '续写', exact: true }).isDisabled(), true);
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await screenshot(page, `hidden-manager-${viewport.width}.png`);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await verifyFloorHeader(ai, viewport);
    await screenshot(page, `floor-header-a-${viewport.width}.png`);
    for (const message of [user, ai]) {
        const previous = await message.evaluate(node => {
            const name = node.querySelector('.play-speaker'), floor = node.querySelector('.play-floor-number');
            const previous = { name: name.textContent, floor: floor.textContent };
            name.textContent = '在雨夜的旧剧院等待下一场故事的林间旅人'; floor.textContent = '#1024'; return previous;
        });
        await verifyFloorHeader(message, viewport);
        await message.evaluate((node, previous) => {
            node.querySelector('.play-speaker').textContent = previous.name;
            node.querySelector('.play-floor-number').textContent = previous.floor;
        }, previous);
    }
    const more = ai.getByRole('button', { name: '更多回复操作', exact: true });
    if (await more.isVisible()) await more.click();
    await ai.getByRole('button', { name: '显示楼层', exact: true }).click();
    await ai.locator('.play-hidden-mark').waitFor({ state: 'detached' });
    assert.equal(await ai.getByRole('button', { name: '续写', exact: true }).isDisabled(), false);
    await page.evaluate(async () => {
        const chat = await runtime.getChat(seed.a);
        await runtime.setMessagesHidden(chat.id, [chat.messages[0].id], false, chat.revision);
        window.depthRules = [{ id: 'depth-display', scriptName: '测试深度显示', placement: [1, 2], markdownOnly: true,
            minDepth: 1, maxDepth: null, findRegex: '小剧场正文', replaceString: '深度变化后的正文' }];
        await runtime.display.refresh(ctx.characters[0]); await ui.refresh();
    });
    assert.match(await ai.innerText(), /小剧场正文/);
    await page.evaluate(async () => {
        const chat = await runtime.getChat(seed.a);
        const started = await testHistory.begin({ roundId: chat.id, chatMode: true, operation: 'send', prompt: '后续用户',
            character: { avatar: 'A.png', name: '测试甲' }, resultId: crypto.randomUUID(), startedAt: new Date().toISOString(),
            context: { chatId: 'A-main', apiMode: 'tavern', characterName: '测试甲', presetName: '测试预设' }, expectedRevision: chat.revision });
        const result = started.messages.at(-1).results[0];
        await testHistory.saveResult(chat.id, result.id, { text: '后续AI', status: 'complete', finishedAt: new Date().toISOString() });
        await ui.refresh();
    });
    await ai.getByText('深度变化后的正文', { exact: true }).waitFor();
    await button('聊天操作').click(); await button('隐藏楼层管理').click();
    await dialog.getByRole('textbox', { name: '起始楼层' }).fill('2');
    await dialog.getByRole('textbox', { name: '结束楼层' }).fill('3');
    await dialog.getByRole('button', { name: '隐藏', exact: true }).click();
    await dialog.locator('.play-hidden-ranges').getByText('2–3', { exact: true }).waitFor();
    await ai.getByText('小剧场正文', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await screenshot(page, `hidden-floors-${viewport.width}.png`);
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await button('关闭聊天页面').click();
    await panel.locator(`[data-chat-id="${seedId}"]`).locator('.play-history-open').click();
    await branch.locator('.play-hidden-mark').nth(1).waitFor();
    assert.equal(await branch.locator('.play-hidden-mark').count(), 2);
    await page.evaluate(async () => {
        let chat = await runtime.getChat(seed.a);
        await runtime.truncateChat(chat.id, chat.messages[2].id, chat.revision);
        chat = await runtime.getChat(seed.a);
        await runtime.setMessagesHidden(chat.id, [chat.messages[1].id], true, chat.revision); await ui.refresh();
    });
    await button('关闭聊天页面').click(); await button('历史记录').click();
    const record = panel.locator(`[data-record="${seedId}"]`);
    await record.waitFor();
    assert.equal(await record.locator('.play-continue').isVisible(), false, '演出记录只收起已在分支隐藏的原回复续写按钮');
    assert.equal(await record.locator('.play-hidden-mark,.is-hidden-floor').count(), 0, '演出记录不显示楼层隐藏状态');
    assert.match(await record.locator('.play-results').innerText(), /阅读位置验证第1段/);
    assert.equal(await record.locator('.play-again').isVisible(), true, '其他原有操作仍然保留');
    await page.evaluate(async () => {
        const chat = await runtime.getChat(seed.a);
        await runtime.setMessagesHidden(chat.id, [chat.messages[1].id], false, chat.revision); await ui.refresh();
    });
    await record.locator('.play-continue').waitFor({ state: 'visible' });
    await button('历史记录').click();
    await panel.locator(`[data-chat-id="${seedId}"]`).locator('.play-history-open').click();
    for (const theme of ['default', 'light', 'dark']) {
        await page.evaluate(async theme => {
            const { createAppearance } = await import('/appearance.js');
            const palette = theme === 'dark' ? { ink: '#e6e0d8', paper: '#25272c', accent: '#deae79' }
                : { ink: '#354352', paper: '#e1e7ed', accent: '#447799' };
            document.body.style.setProperty('--SmartThemeBodyColor', palette.ink);
            document.body.style.setProperty('--SmartThemeBlurTintColor', palette.paper);
            document.body.style.setProperty('--SmartThemeBorderColor', palette.accent);
            document.body.style.setProperty('--SmartThemeUnderlineColor', palette.accent);
            window.testAppearance ??= createAppearance(document.querySelector('#teahouse-panel'));
            window.testAppearance.apply(theme === 'default' ? 'default' : 'tavern');
        }, theme);
        await verifyFloorHeader(user, viewport);
        await screenshot(page, `floor-header-a-${theme}-${viewport.width}.png`);
        await button('聊天操作').click(); await button('隐藏楼层管理').click(); await dialog.waitFor();
        const colors = await dialog.evaluate(node => {
            const styles = getComputedStyle(node), panel = getComputedStyle(document.querySelector('#teahouse-panel'));
            const properties = ['--tea-paper', '--tea-ink', '--tea-heading', '--tea-muted', '--tea-line', '--tea-accent', '--tea-field-paper', '--tea-control-paper', '--tea-control-ink', 'color-scheme'];
            return { copied: properties.every(name => styles.getPropertyValue(name).trim() === panel.getPropertyValue(name).trim()),
                paper: styles.backgroundColor, ink: styles.color,
                button: getComputedStyle(node.querySelector('.play-hidden-range-actions button')).backgroundColor,
                buttonInk: getComputedStyle(node.querySelector('.play-hidden-range-actions button')).color };
        });
        assert.ok(colors.copied, `${theme} 管理弹窗继承面板正在使用的颜色`);
        if (theme === 'default') {
            assert.equal(colors.paper, 'rgb(250, 247, 238)'); assert.equal(colors.button, 'rgb(24, 62, 54)');
        } else assert.equal(colors.paper, theme === 'dark' ? 'rgb(37, 39, 44)' : 'rgb(225, 231, 237)');
        assert.notEqual(colors.button, colors.buttonInk, '操作按钮文字和底色区分清楚');
        await screenshot(page, `hidden-manager-${theme}-${viewport.width}.png`);
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, passed: true, flow: 'single hide/show, batch ranges, invalid input, continuation, persisted floors, depth cache refresh', url }));
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 1024, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
            const context = await browser.newContext({ viewport });
            await verify(await context.newPage(), url, viewport); await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
