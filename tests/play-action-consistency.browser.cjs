const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: originalHarness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const requestPattern = /prepareRequest:async request=>\{window\.captured\.push\(request\.environment\);[\s\S]*?\}\}\}\);/;
assert.match(originalHarness, requestPattern);
const harness = originalHarness.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace(requestPattern, `prepareRequest:async request=>{
        const identity={userName:ctx.name1,userAvatar:persona.user_avatar};
        await request.onPersonaResolved?.(identity);
        const task={id:request.generationId,prompt:request.prompt,prefix:request.continueMessage??'',signal:request.signal};
        (window.tasks??=[]).push(task);
        return {context:identity,send:({onText,signal})=>new Promise((resolve,reject)=>{
            window.modelCalls=(window.modelCalls??0)+1;
            task.text=text=>onText(task.prefix+text);task.finish=text=>resolve(task.prefix+text);
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
        })};
    }});`);
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://test').pathname.slice(1));
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const button = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function verify(browser, url, viewport, route) {
    const mobile = viewport.width <= 760;
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [];
    let stage = '打开页面';
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    const activate = locator => mobile ? locator.tap() : locator.click();
    try {
        await page.goto(url); await page.waitForFunction(() => window.ready);
        assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        const seed = await page.evaluate(async () => {
            const round = await testHistory.getRound(window.seed.a), result = round.results[0];
            await testHistory.editResult(round.id, result.id, '版本一已保存的正文', result.text);
            await testHistory.editPrompt(round.id, '版本并行测试', round.prompt);
            const chat = await runtime.getChat(round.id);
            return { id: round.id, oldId: result.id, messageId: chat.messages[1].id,
                mainChat: structuredClone(ctx.chat), characterId: ctx.characterId, chatId: ctx.chatId };
        });
        await activate(button(page, '打开小剧场面板'));
        const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
        await activate(button(panel, '剧场演出'));
        if (route === 'chat') {
            await activate(button(panel, '历史记录'));
            await activate(panel.locator(`[data-chat-id="${seed.id}"] .play-history-open`));
        }
        const surface = route === 'chat' ? panel.locator('.play-branch-page').filter({ visible: true }) : panel.locator(`[data-record="${seed.id}"]`);
        const reply = surface.locator('.play-assistant-message');
        const user = surface.locator('.play-user-message');
        const newVersion = route === 'chat' ? '生成新版本' : '生成新剧场';
        const selected = () => page.evaluate(id => runtime.session.currentRound(id).selectedResultId, seed.id);
        const expand = async node => {
            const more = button(node, node === user ? '更多消息操作' : '更多回复操作');
            if (await more.count() && await more.getAttribute('aria-expanded') !== 'true') await activate(more);
        };
        const protectedAction = async name => {
            const control = reply.getByRole('button', { name, exact: true, includeHidden: true });
            assert.equal(await control.evaluate(node => node.disabled || node.hidden), true, name + '保护整条 AI 消息');
        };
        const choose = async index => {
            await activate(reply.locator('.play-count'));
            const menu = panel.getByRole('listbox', { name: route === 'chat' ? '选择回复版本' : '生成结果', exact: true });
            await menu.waitFor(); await activate(menu.getByRole('option').nth(index)); await settle(page);
        };
        const flush = () => page.evaluate(id => runtime.session.flush(id), seed.id);
        const waitCalls = count => page.waitForFunction(count => window.modelCalls === count, count);
        const emit = (index, text) => page.evaluate(({ index, text }) => tasks[index].text(text), { index, text });
        const finish = (index, text) => page.evaluate(({ index, text }) => tasks[index].finish(text), { index, text });
        await reply.getByText('版本一已保存的正文', { exact: true }).waitFor();

        stage = '生成中回看和版本菜单';
        await activate(button(reply, newVersion)); await waitCalls(1);
        await emit(0, '版本二正在生成');
        await reply.getByText('版本二正在生成', { exact: true }).waitFor();
        assert.equal(await button(reply, '上一个结果').isEnabled(), true);
        assert.equal(await reply.locator('.play-count').isEnabled(), true);
        assert.equal(await button(reply, '更多回复操作').isVisible(), true);
        await expand(reply); await protectedAction('创建分支'); await protectedAction('删除 AI 消息');
        await flush();
        await page.evaluate(() => {
            window.originalSelection = testHistory.setMessageVersion.bind(testHistory);
            window.originalWindow = testHistory.getChatWindow.bind(testHistory);
            window.selectionReleased = false; window.selectionWindowReads = 0;
            const gate = new Promise(resolve => window.releaseSelection = () => { window.selectionReleased = true; resolve(); });
            testHistory.setMessageVersion = async (...args) => { await gate; return originalSelection(...args); };
            testHistory.getChatWindow = (...args) => { window.selectionWindowReads++; return originalWindow(...args); };
        });
        stage = '保存阻塞时立即切换已有版本';
        await activate(button(reply, '上一个结果'));
        await reply.getByText('版本一已保存的正文', { exact: true }).waitFor({ timeout: 1500 });
        assert.equal(await selected(), seed.oldId);
        assert.equal(await page.evaluate(() => selectionReleased), false);
        await choose(1); await reply.getByText('版本二正在生成', { exact: true }).waitFor();
        await choose(0); await reply.getByText('版本一已保存的正文', { exact: true }).waitFor();
        await emit(0, '隐藏的版本二继续生成'); await settle(page);
        assert.equal(await selected(), seed.oldId);
        assert.equal(await reply.getByText('隐藏的版本二继续生成', { exact: true }).isVisible(), false);
        assert.equal(await page.evaluate(() => selectionWindowReads), 0);
        assert.equal(await page.evaluate(() => runtime.getStates()[0].phase), 'generating');
        assert.equal(await reply.locator('.play-count').isEnabled(), true);
        if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `immediate-version-${route}-${viewport.width}.png`) });
        await page.evaluate(() => releaseSelection()); await flush();
        assert.equal(await page.evaluate(id => testHistory.getChat(id).then(chat => chat.messages[1].selectedResultId), seed.id), seed.oldId);
        await page.evaluate(() => { testHistory.setMessageVersion = originalSelection; testHistory.getChatWindow = originalWindow; });

        stage = '收藏和编辑旧版本';
        await activate(button(reply, '收藏演出记录'));
        await button(reply, '取消收藏').waitFor();
        await page.waitForFunction(() => !runtime.favoriteOperations.hasPending());
        const favorite = await page.evaluate(async id => (await runtime.listFavorites()).find(favorite => favorite.source.resultId === id), seed.oldId);
        assert.ok(favorite);
        assert.equal((await page.evaluate(id => runtime.getFavorite(id), favorite.id)).text, '版本一已保存的正文');
        await activate(button(reply, '编辑回复原文'));
        const editRoot = mobile ? panel.locator('.play-edit-sheet') : reply;
        const edit = editRoot.getByRole('textbox', { name: '回复原文', exact: true });
        await edit.waitFor(); await edit.fill('旧版本修改已保存');
        await activate(button(editRoot, '保存')); await edit.waitFor({ state: 'detached' });
        await flush(); await reply.getByText('旧版本修改已保存', { exact: true }).waitFor();
        const savedOld = await page.evaluate(({ id, oldId }) => testHistory.getChat(id).then(chat => chat.messages[1].results.find(result => result.id === oldId).text), seed);
        assert.equal(savedOld, '旧版本修改已保存');
        assert.equal(await page.evaluate(() => runtime.getStates()[0].text), '隐藏的版本二继续生成');
        if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `old-version-${route}-${viewport.width}.png`) });

        stage = '旧版本重新生成和续写';
        await activate(button(reply, '重新生成')); await waitCalls(2);
        await emit(1, '旧版本重新生成中');
        assert.equal(await page.evaluate(() => runtime.getStates().length), 2);
        await button(reply, '停止这份回复').waitFor();
        await finish(1, '旧版本重新生成完成');
        await page.waitForFunction(() => runtime.getStates().length === 1); await flush();
        await reply.getByText('旧版本重新生成完成', { exact: true }).waitFor();
        const replacementId = await selected(); assert.notEqual(replacementId, seed.oldId);
        await activate(button(reply, '续写')); await waitCalls(3);
        assert.equal(await page.evaluate(() => tasks[2].prefix), '旧版本重新生成完成');
        await emit(2, '，续写正在进行');
        await reply.getByText('旧版本重新生成完成，续写正在进行', { exact: true }).waitFor();
        await finish(2, '，续写完成');
        await page.waitForFunction(() => runtime.getStates().length === 1); await flush();
        await reply.getByText('旧版本重新生成完成，续写完成', { exact: true }).waitFor();
        assert.equal(await selected(), replacementId);

        stage = '并行新增和单独停止';
        await choose(1); await activate(button(reply, newVersion)); await waitCalls(4);
        await emit(3, '版本三中途停止保留');
        await button(reply, '停止这份回复').waitFor();
        await activate(button(reply, '停止这份回复'));
        await page.waitForFunction(() => runtime.getStates().length === 1); await flush();
        assert.deepEqual(await page.evaluate(() => tasks.map(task => task.signal.aborted)), [false, false, false, true]);
        await reply.getByText('版本三中途停止保留', { exact: true }).waitFor();
        await choose(0); await emit(0, '版本二独立继续生成'); await settle(page);
        await reply.getByText('旧版本重新生成完成，续写完成', { exact: true }).waitFor();
        assert.equal(await selected(), replacementId);

        stage = '多版本停止所有生成';
        await choose(2); await activate(button(reply, newVersion)); await waitCalls(5);
        await emit(4, '版本四停止前的正文'); await choose(0);
        const sendScope = route === 'chat' ? surface.locator('.play-compose') : panel;
        const stopAll = button(sendScope, '停止所有生成');
        await stopAll.waitFor(); await activate(stopAll);
        await page.waitForFunction(() => runtime.getStates().length === 0); await flush();
        assert.deepEqual(await page.evaluate(() => tasks.map(task => task.signal.aborted)), [true, false, false, true, true]);
        const stopped = await page.evaluate(id => testHistory.getChat(id), seed.id);
        assert.deepEqual(stopped.messages[1].results.map(result => result.status), ['complete', 'stopped', 'stopped', 'stopped']);

        stage = '删除用户消息不取消生成';
        await choose(3); await activate(button(reply, newVersion)); await waitCalls(6);
        await emit(5, '删除用户消息时仍在生成');
        await expand(user); await activate(button(user, '删除用户消息'));
        await user.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => runtime.getStates().length), 1);
        assert.equal(await page.evaluate(() => tasks[5].signal.aborted), false);
        assert.equal(await page.evaluate(() => tasks[5].prompt), '版本并行测试');
        await expand(reply); await protectedAction('创建分支'); await protectedAction('删除 AI 消息');
        await finish(5, '用户消息删除后生成完成');
        await page.waitForFunction(() => runtime.getStates().length === 0); await flush();
        await reply.getByText('用户消息删除后生成完成', { exact: true }).waitFor();

        stage = '分支保留全部已保存版本';
        const source = await page.evaluate(id => testHistory.getChat(id), seed.id);
        assert.equal(source.messages.length, 1); assert.equal(source.messages[0].results.length, 5);
        await expand(reply); await activate(button(reply, '创建分支'));
        const branchPage = panel.locator('.play-branch-page').filter({ visible: true });
        await branchPage.getByText('用户消息删除后生成完成', { exact: true }).waitFor();
        const branch = await page.evaluate(async characterId => {
            const row = (await runtime.listChats(characterId)).find(row => row.branched);
            return runtime.getChat(row.id);
        }, source.characterId);
        assert.deepEqual(branch.messages[0].results.map(result => result.text), source.messages[0].results.map(result => result.text));
        assert.ok(branch.messages[0].results.every(result => !source.messages[0].results.some(original => original.id === result.id)));
        assert.deepEqual(await page.evaluate(() => ctx.chat), seed.mainChat);
        assert.equal(await page.evaluate(() => ctx.characterId), seed.characterId);
        assert.equal(await page.evaluate(() => ctx.chatId), seed.chatId);
        assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
        assert.deepEqual(errors, []);
        if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `all-versions-${route}-${viewport.width}.png`) });
        console.log(JSON.stringify({ viewport, route, passed: true, versions: 5, requests: 6, errors,
            checks: '保存阻塞时立即切换、连续切换保持最后选择、生成中回看、数字菜单、旧版本收藏编辑、并行重新生成续写、新增版本、单独停止、停止所有生成、删除用户消息、分支保留全部版本' }));
    } catch (error) {
        console.error(JSON.stringify({ viewport, route, stage, errors }));
        if (process.env.TEA_QA_DIR) await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `failure-${route}-${viewport.width}.png`) });
        throw error;
    } finally { await context.close(); }
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    if (process.env.TEA_QA_DIR) await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
            for (const route of ['record', 'chat']) await verify(browser, url, viewport, route);
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
