// Flow: favorite a user message -> read the library entry -> edit/reopen/cancel.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = { id: '123456789012345678', type: 'standalone',
    title: '茶会选集里这份有原题目的雨夜故事标题足够长用来检查收藏目录是否只显示二十八字',
    body: '暂停当前剧情，写一段雨夜重逢的小剧场。\r\n让 {{char}} 为 {{user}} 递上一杯热茶。',
    author: '测试茶友', publishedAt: '2026-01-01T00:00:00Z' };
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

async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verify(page, url, viewport) {
    async function open() {
        await page.goto(url); await page.waitForFunction(() => window.ready);
        assert.equal(page.url(), url);
        assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        await page.evaluate(entry => fixture.community.set(entry.id, entry), source);
        await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    }
    await open();
    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const record = id => panel.locator(`[data-record="${id}"]`);
    const user = id => record(id).locator('.play-user-message');
    const star = id => user(id).locator('.tea-star');
    const manuscripts = () => page.evaluate(() => [...fixture.manuscripts.values()]);
    const catalogEntry = id => panel.locator(viewport.width <= 760 ? `.tea-feed-entry[data-id="${id}"]` : `.tea-story[data-id="${id}"]`);
    async function edit(id, text) {
        await user(id).getByRole('button', { name: '修改提示词', exact: true }).click();
        assert.equal(await star(id).isVisible(), false, '编辑时显示保存和取消，不同时显示收藏按钮');
        await user(id).getByRole('textbox', { name: '提示词原文', exact: true }).fill(text);
        await user(id).getByRole('button', { name: '保存', exact: true }).click();
        await user(id).getByRole('button', { name: '修改提示词', exact: true }).waitFor();
        await page.waitForFunction(async ({ id, text }) => (await runtime.getRound(id)).prompt === text, { id, text });
    }
    async function send(text) {
        if (text !== undefined) await panel.getByRole('textbox', { name: '小剧场提示词', exact: true }).fill(text);
        await button('发送小剧场').click();
        await page.waitForFunction(() => runtime.getState().phase === 'generating');
        const job = await page.evaluate(() => runtime.getState());
        await star(job.roundId).waitFor();
        return job.roundId;
    }
    async function finish() {
        await page.evaluate(() => finishGeneration('窗外的雨停了，她将温热的茶杯放在桌上。\n\n“再坐一会儿吧。”'));
        await page.waitForFunction(() => runtime.getState().phase === 'idle');
    }
    async function toggle(id, pressed) {
        await star(id).click();
        await page.waitForFunction(({ id, pressed }) => {
            const node = document.querySelector(`[data-record="${id}"] .play-user-message .tea-star`);
            return node?.getAttribute('aria-pressed') === String(pressed) && !node.disabled;
        }, { id, pressed });
    }

    await button('在插件中游玩').click();
    const sourceId = await send();
    await toggle(sourceId, true);
    assert.equal((await manuscripts()).length, 0, '原选集消息直接收藏，不另存手稿');
    assert.equal(await page.evaluate(id => Object.hasOwn(fixture.settings.favorites, id), source.id), true);
    assert.equal(await page.evaluate(() => runtime.getState().phase), 'generating', '用户消息可以在 AI 生成时收藏');
    await finish();
    assert.equal(await panel.getByRole('textbox', { name: '小剧场提示词', exact: true }).inputValue(), '', '发送含 Windows 换行的选集后也清空本次输入和来源');
    await button('我的收藏').click();
    await button('取消收藏').click();
    await button('剧场演出').click();
    assert.equal(await star(sourceId).getAttribute('aria-pressed'), 'false', '从目录取消后，返回消息时同步星标');
    await toggle(sourceId, true);

    const editedSource = '暂停当前剧情，改写为下雪的清晨。\n保留 {{char}}、{{user}} 与 <%= example %>。';
    await edit(sourceId, editedSource);
    assert.equal(await star(sourceId).getAttribute('aria-pressed'), 'false');
    await toggle(sourceId, true);
    const [copy] = await manuscripts();
    assert.equal(copy.title, source.title);
    assert.equal(copy.body, editedSource);
    assert.equal(copy.type, 'standalone');
    assert.equal(await page.evaluate(id => fixture.community.get(id).body, source.id), source.body);
    const assistant = record(sourceId).locator('.play-assistant-message');
    await assistant.getByRole('button', { name: '收藏演出记录', exact: true }).click();
    await assistant.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await runtime.listFavorites()).length), 1, '用户收藏没有混入 AI 演出记录');
    const layout = await record(sourceId).evaluate(node => {
        const headers = [...node.querySelectorAll('.play-message-meta')];
        return headers.map(header => {
            const buttons = [...header.querySelectorAll('.play-header-actions button')].filter(button => button.getClientRects().length);
            const bounds = header.getBoundingClientRect(), boxes = buttons.map(button => button.getBoundingClientRect());
            return { labels: buttons.map(button => button.getAttribute('aria-label')),
                inside: boxes.every(box => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
                sameRow: boxes.every(box => Math.abs(box.top - boxes[0].top) < 1),
                separate: boxes.every((box, index) => !index || box.left >= boxes[index - 1].right) };
        });
    });
    assert.deepEqual(layout.map(item => item.labels), [viewport.width <= 760 ? ['取消收藏', '修改提示词', '更多消息操作'] : ['取消收藏', '修改提示词', '删除用户消息'], viewport.width <= 760
        ? ['取消收藏', '编辑回复原文', '更多回复操作']
        : ['创建分支', '查看实际提示词', '删除 AI 消息', '取消收藏', '编辑回复原文']]);
    assert.ok(layout.every(item => item.inside && item.sameRow && item.separate), '用户和 AI 的三个操作按钮在同一行、不重叠、不越界');
    await record(sourceId).evaluate(node => {
        const feed = node.closest('.play-feed'); feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - 12;
    });
    await screenshot(page, `user-message-favorites-${viewport.width}.png`);

    const firstLine = '茶🍵'.repeat(20), prompt = `${firstLine}\n第二行保留 {{user}} 和 {{char}}。`;
    const typedId = await send(prompt); await finish();
    assert.equal((await page.evaluate(id => runtime.getRound(id), typedId)).origin, null, '接着手写的新消息不会继承上一篇选集的标题');
    await toggle(typedId, true);
    const typed = (await manuscripts()).find(item => item.body === prompt);
    assert.equal(typed.title, `${[...firstLine].slice(0, 28).join('')}...`);
    assert.equal(typed.body, prompt);
    await edit(typedId, `${prompt}\n补充一句对白。`);
    assert.equal(await star(typedId).getAttribute('aria-pressed'), 'false');
    await toggle(typedId, true);
    assert.equal((await manuscripts()).find(item => item.id === typed.id).body, prompt, '后续编辑不改写已收藏的手稿');
    assert.equal((await manuscripts()).length, 3);

    const finalPrompt = '重试保存的手写标题\n失败时也要保留 {{user}}、{{char}} 和全部正文。';
    await edit(typedId, finalPrompt);
    await page.evaluate(() => { window.failManuscriptSave = true; });
    await star(typedId).click();
    await panel.getByText('模拟手稿保存失败', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal(await star(typedId).getAttribute('aria-pressed'), 'false');
    assert.equal((await manuscripts()).length, 3);
    await page.evaluate(() => { window.failManuscriptSave = false; window.holdManuscriptSave = true; });
    await star(typedId).evaluate(node => { node.click(); node.click(); });
    await page.waitForFunction(() => typeof window.resumeManuscriptSave === 'function');
    assert.equal(await star(typedId).isDisabled(), true);
    assert.equal(await user(typedId).getByRole('button', { name: '修改提示词', exact: true }).isDisabled(), true);
    assert.equal(await user(typedId).getByRole('button', { name: '删除用户消息', exact: true, includeHidden: true }).isDisabled(), true);
    await page.evaluate(() => { window.holdManuscriptSave = false; resumeManuscriptSave(); });
    await user(typedId).getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    const saved = (await manuscripts()).find(item => item.body === finalPrompt);
    assert.equal((await manuscripts()).length, 4, '保存中重复点击只创建一份手稿');
    await toggle(typedId, false);
    assert.equal((await manuscripts()).length, 4);
    await toggle(typedId, true);
    assert.equal((await manuscripts()).length, 4);

    await button('我的收藏').click();
    const title = await catalogEntry(copy.id).locator(viewport.width <= 760 ? '.tea-article-title' : '.tea-story-title').textContent();
    assert.equal(title, `${[...source.title].slice(0, 28).join('')}...`, '有来源的长标题也按 28 字显示');
    if (viewport.width > 760) await catalogEntry(saved.id).click();
    const savedReader = viewport.width <= 760 ? catalogEntry(saved.id) : panel.locator('.tea-reader-footer');
    await savedReader.getByRole('button', { name: '取消收藏', exact: true }).click();
    await button('剧场演出').click();
    assert.equal(await star(typedId).getAttribute('aria-pressed'), 'false');
    await toggle(typedId, true);

    await open(); await button('剧场演出').click();
    await user(typedId).getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    assert.equal((await manuscripts()).length, 4, '刷新后直接读取已有手稿，不新增副本');
    assert.equal((await manuscripts()).find(item => item.id === saved.id).body, finalPrompt);
    await page.evaluate(async id => {
        const round = await testHistory.getRound(id);
        await testHistory.editPrompt(id, '其他窗口刚修改的消息', round.prompt);
    }, typedId);
    await star(typedId).click();
    await panel.getByText('这条用户消息已在其他窗口修改，已更新显示，请核对后再收藏。', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal((await manuscripts()).length, 4);
    assert.equal(await page.evaluate(id => Object.hasOwn(fixture.settings.favorites, id), saved.id), true, '过期页面不会误取消旧收藏');
    assert.equal(await star(typedId).getAttribute('aria-pressed'), 'false');
    await edit(typedId, finalPrompt);
    assert.equal(await star(typedId).getAttribute('aria-pressed'), 'true');
    const more = user(typedId).getByRole('button', { name: '更多消息操作', exact: true });
    if (await more.isVisible()) await more.click();
    await user(typedId).getByRole('button', { name: '删除用户消息', exact: true }).click();
    await user(typedId).waitFor({ state: 'hidden' });
    assert.equal((await manuscripts()).find(item => item.id === saved.id).body, finalPrompt, '删除用户消息保留手稿和收藏');
    assert.equal(await page.evaluate(id => Object.hasOwn(fixture.settings.favorites, id), saved.id), true);
    assert.equal(await record(typedId).locator('.play-assistant-message').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => ctx.chat), [{ mes: '原聊天', is_user: false }]);
    assert.equal(await panel.locator('vite-error-overlay, #webpack-dev-server-client-overlay').count(), 0);
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), '面板没有横向溢出');

    const input = panel.getByRole('textbox', { name: '小剧场提示词', exact: true });
    const choose = async name => {
        if (viewport.width <= 760) await button('选择角色').click();
        await panel.locator('.play-people').getByRole('button', { name, exact: true }).click();
        await panel.locator('.play-record:visible .play-assistant-meta .play-speaker').getByText(name, { exact: true }).first().waitFor();
    };
    await input.fill('甲的未发送草稿');
    await choose('测试乙');
    await input.fill('乙的未发送草稿');
    const requestCount = await page.evaluate(() => captured.length);
    await button('茶会选集').click(); await button('在插件中游玩').click();
    await panel.locator('.play-record:visible .play-assistant-meta .play-speaker').getByText('测试乙', { exact: true }).first().waitFor();
    assert.equal(await input.inputValue(), source.body.replace(/\r\n/g, '\n'), '原文填入所选角色的输入框');
    assert.equal(await input.evaluate(node => document.activeElement === node), true, '填入后聚焦输入框');
    assert.equal(await page.evaluate(() => captured.length), requestCount, '在插件中游玩只填入提示词，不立即生成');
    await screenshot(page, `entry-fill-selected-character-${viewport.width}.png`);
    await choose('测试甲');
    assert.equal(await input.inputValue(), '甲的未发送草稿', '没有覆盖主聊天角色在小剧场中的草稿');
    await choose('测试乙');
    assert.equal(await input.inputValue(), source.body.replace(/\r\n/g, '\n'), '切回所选角色仍保留选集原文');
    const selectedId = await send(); await finish();
    const selectedRound = await page.evaluate(id => runtime.getRound(id), selectedId);
    assert.equal((await page.evaluate(() => runtime.listCharacters())).find(character => character.id === selectedRound.characterId).avatar, 'B.png', '发送时实际使用演出页所选角色');
    assert.equal(selectedRound.origin.id, source.id, '保留选集来源');
    assert.equal(await page.evaluate(() => ctx.characterId), 0, '酒馆主聊天仍为甲');
    assert.deepEqual(await page.evaluate(() => ctx.chat), [{ mes: '原聊天', is_user: false }]);
    return { viewport, url, checks: '原篇目收藏、改写另存、原文保留、取消与重收藏、保存失败与重复点击、刷新恢复、三个按钮布局、选集填入所选角色并保留各自草稿及主聊天' };
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            const result = await verify(page, `http://127.0.0.1:${server.address().port}/`, viewport);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ ...result, errors }));
            await context.close();
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
