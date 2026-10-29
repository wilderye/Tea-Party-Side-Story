// Browser plugin not available. Use Playwright/Edge and synthetic data only.
// Flow: each AI message's top-right button -> only its actual prompts -> copy/clear -> refresh/restart.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: originalHarness } = require('./play-processing.browser.cjs');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const hostRequire = createRequire(path.join(process.env.TEA_TEST_MODULE_ROOT || path.resolve(root, '../酒馆测试环境/SillyTavern-1.19.0'), 'package.json'));
const express = hostRequire('express');
const harness = originalHarness.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace("import {createTheatrePanel} from '/panel.js';", `import {createTheatrePanel} from '/panel.js';
import {createPreparedPlayRequest} from '/play-request.js';
import {sentPromptCapture} from '/play-sent-prompt.js';
window.promptCapture=sentPromptCapture;`)
    .replace(/prepareRequest:async request=>\{window\.captured\.push\(request\.environment\);[\s\S]*?\}\}\}\);/, `
prepareRequest:async request=>{
    ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
    ctx.extractMessageFromData=data=>data.text;
    return createPreparedPlayRequest(ctx,{messages:[{role:'system',content:'实际系统\\n\\n  缩进保持'},
        {role:'user',content:request.prompt}],model:'synthetic-model',chat_completion_source:'custom',stream:false,
        custom_include_headers:'{"Authorization":"synthetic-secret"}'});
}});`);
assert.ok(harness.includes('return createPreparedPlayRequest'));

(async () => {
    const { installPromptCapture } = await import(pathToFileURL(path.join(root, 'tea-prompt-capture-server.mjs')).href);
    const { default: nativeFetch } = await import(pathToFileURL(hostRequire.resolve('node-fetch')).href);
    let nativeRouter;
    if (process.env.TEA_CAPTURE_NATIVE_ROOT) {
        const nativeRoot = path.resolve(process.env.TEA_CAPTURE_NATIVE_ROOT);
        const { setConfigFilePath } = await import(pathToFileURL(path.join(nativeRoot, 'src/util.js')).href);
        setConfigFilePath(path.join(nativeRoot, 'default/config.yaml'));
        ({ router: nativeRouter } = await import(pathToFileURL(path.join(nativeRoot, 'src/endpoints/backends/chat-completions.js')).href));
    }
    const actualBodies = [];
    const upstream = http.createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk;
        actualBodies.push(body); response.setHeader('Content-Type', 'application/json'); response.end('{"text":"合成回复正文"}');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const app = express(), generateRouter = nativeRouter || express.Router(), streamRouter = express.Router();
    app.use(express.json()); app.use((request, _response, next) => {
        request.user = { profile: { handle: 'synthetic-test-user' }, directories: { root: path.join(process.env.TEMP, 'tea-capture-nonexistent-profile') } };
        if (nativeRouter && request.path === '/api/backends/chat-completions/generate') {
            request.body.custom_url = `http://127.0.0.1:${upstream.address().port}`;
            request.body.custom_prompt_post_processing = '';
            request.body.custom_include_body = JSON.stringify({ messages: [
                { role: 'system', content: '服务器合并后的实际系统' },
                { role: 'user', content: request.body.messages.at(-1).content + '\n服务器后续处理标记' },
            ] });
        }
        next();
    });
    if (!nativeRouter) generateRouter.post('/generate', async (request, response) => {
        const messages = [{ role: 'system', content: '服务器合并后的实际系统' },
            { role: 'user', content: request.body.messages.at(-1).content + '\n服务器后续处理标记' }];
        const result = await nativeFetch(`http://127.0.0.1:${upstream.address().port}/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-secret' },
            body: JSON.stringify({ messages, model: 'synthetic-model' }),
        });
        response.json(await result.json());
    });
    let cleanup = installPromptCapture(generateRouter, streamRouter);
    app.use('/api/backends/chat-completions', generateRouter);
    app.use('/api/plugins/tea-prompt-capture', streamRouter);
    app.get('/', (_request, response) => response.type('html').send(harness));
    app.get('/favicon.ico', (_request, response) => response.sendStatus(204));
    app.use(express.static(root, { dotfiles: 'deny', index: false }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`, browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
            const context = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            const panel = page.locator('#teahouse-panel');
            const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
            const ai = () => panel.locator('.play-record:visible .play-assistant-message').last();
            const inspect = message => message.getByRole('button', { name: '查看实际提示词', exact: true });
            const viewer = page.getByRole('dialog', { name: '实际发送的提示词', exact: true });
            const open = async () => {
                await page.waitForFunction(() => window.ready);
                await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
                await button('剧场演出').click();
            };
            const send = async text => {
                await panel.getByRole('textbox', { name: '小剧场提示词', exact: true }).fill(text);
                await button('发送小剧场').click();
                await page.waitForFunction(() => window.promptCapture.read().records.at(-1)?.server.length > 0);
                await page.waitForFunction(() => window.runtime.getStates().length === 0);
            };
            await page.goto(url); await open();
            assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
            assert.ok((await panel.innerText()).includes('茶会选集'));
            assert.equal(await panel.locator('.tea-topbar .play-sent-prompt-action, .tea-mobile-actions .play-sent-prompt-action').count(), 0);
            assert.equal(await panel.locator('.play-user-message .play-sent-prompt-action').count(), 0);
            await button('剧场演出').click();
            const text = '正文 JSON：{"保留":true}\n\n  {{char}} <content>原样标签</content>\n' + 'continuous'.repeat(65);
            await send(text);
            const browserBody = await page.evaluate(() => promptCapture.read().records.at(-1).browser);
            if (process.env.TEA_QA_DIR) {
                await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `sent-prompt-button-${viewport.width}.png`) });
            }
            const promptButton = inspect(ai());
            const bounds = await promptButton.boundingBox(), headBounds = await ai().locator('.play-assistant-meta').boundingBox();
            assert.ok(bounds.x > viewport.width / 2 && bounds.y >= headBounds.y && bounds.y < headBounds.y + headBounds.height, '按钮在这条 AI 消息右上角');
            assert.equal(await promptButton.evaluate(node => !!node.closest('.play-assistant-meta')), true);
            await promptButton.click();
            assert.ok((await viewer.locator('pre').textContent()).includes(text));
            assert.ok((await viewer.locator('pre').textContent()).includes('实际系统\n\n  缩进保持'));
            assert.doesNotMatch(await viewer.innerText(), /synthetic-secret|"messages"\s*:|服务器后续处理标记/);
            await viewer.getByRole('button', { name: '酒馆发给模型', exact: true }).click();
            assert.ok((await viewer.locator('pre').textContent()).includes('服务器合并后的实际系统'));
            assert.ok((await viewer.locator('pre').textContent()).includes('服务器后续处理标记'));
            assert.deepEqual(await page.evaluate(() => promptCapture.read().records.at(-1).server[0].prompt.messages),
                JSON.parse(actualBodies.at(-1)).messages, '与实际模型接口收到的请求逐项相同');
            assert.notDeepEqual(browserBody.messages, JSON.parse(actualBodies.at(-1)).messages);
            await viewer.getByRole('button', { name: '复制提示词', exact: true }).click();
            assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'),
                await viewer.locator('pre').textContent(), 'Windows 剪贴板只转换换行符，正文不变');
            assert.ok(await viewer.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            assert.ok(await viewer.locator('pre').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            if (process.env.TEA_QA_DIR) {
                await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `sent-prompt-${viewport.width}.png`) });
            }
            await page.keyboard.press('Escape'); assert.equal(await viewer.count(), 0);
            await send('另一条回复的独立提示词');
            const firstMessage = panel.locator('.play-record:visible .play-assistant-message').filter({ hasText: '合成回复正文' }).first();
            await inspect(firstMessage).click();
            assert.ok((await viewer.locator('pre').textContent()).includes(text));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /另一条回复的独立提示词/);
            await viewer.getByRole('button', { name: '清空记录', exact: true }).click();
            assert.equal(await page.evaluate(() => promptCapture.read().records.length), 1, '只清空当前回复的记录');
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await inspect(ai()).click();
            assert.ok((await viewer.locator('pre').textContent()).includes('另一条回复的独立提示词'));
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            const roundId = await ai().evaluate(node => node.closest('.play-record').dataset.record);
            await page.evaluate(async roundId => {
                const round = await runtime.getRound(roundId);
                await runtime.editPrompt(roundId, '新版本专属提示词', round.prompt);
                await runtime.generateAnother(roundId);
                ui.refresh();
            }, roundId);
            await inspect(ai()).click();
            assert.ok((await viewer.locator('pre').textContent()).includes('新版本专属提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /另一条回复的独立提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await ai().getByRole('button', { name: '上一个结果', exact: true }).click();
            await inspect(ai()).click();
            assert.ok((await viewer.locator('pre').textContent()).includes('另一条回复的独立提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /新版本专属提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await ai().getByRole('button', { name: '下一个结果', exact: true }).click();
            await page.evaluate(async roundId => {
                const round = await runtime.getRound(roundId);
                await runtime.editPrompt(roundId, '重新生成的专属提示词', round.prompt);
            }, roundId);
            await ai().getByRole('button', { name: '重新生成', exact: true }).click();
            await page.waitForFunction(() => runtime.getStates().length === 0);
            await inspect(ai()).click();
            assert.ok((await viewer.locator('pre').textContent()).includes('重新生成的专属提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /新版本专属提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await ai().getByRole('button', { name: '续写', exact: true }).click();
            await page.waitForFunction(() => runtime.getStates().length === 0);
            await inspect(ai()).click();
            assert.equal(await viewer.getByRole('combobox', { name: '选择发送记录' }).locator('option').count(), 2,
                '同一回复的生成和续写记录归在一起');
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await ai().getByRole('button', { name: '创建分支', exact: true }).click();
            const branch = panel.locator('.play-branch-page:visible');
            const branchInput = branch.getByRole('textbox', { name: '分支聊天输入', exact: true });
            await branchInput.fill('分支第一条专属提示词');
            await branch.getByRole('button', { name: '发送消息', exact: true }).click();
            await page.waitForFunction(() => runtime.getStates().length === 0);
            const firstBranchAI = branch.locator('.play-assistant-message').last();
            const firstBranchMessageId = await firstBranchAI.getAttribute('data-message-id');
            await branchInput.fill('分支第二条专属提示词');
            await branch.getByRole('button', { name: '发送消息', exact: true }).click();
            await page.waitForFunction(() => runtime.getStates().length === 0);
            await inspect(branch.locator(`[data-message-id="${firstBranchMessageId}"]`)).click();
            assert.ok((await viewer.locator('pre').textContent()).includes('分支第一条专属提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /分支第二条专属提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await inspect(branch.locator('.play-assistant-message').last()).click();
            assert.ok((await viewer.locator('pre').textContent()).includes('分支第二条专属提示词'));
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await button('历史记录').click();
            await send('刷新清空的合成测试');
            await page.reload(); await open();
            assert.deepEqual(await page.evaluate(() => promptCapture.read().records), []);
            await inspect(ai()).click();
            await viewer.getByText('这条回复没有可查看的发送记录，或记录已清空。', { exact: true }).waitFor();
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await send('重启清空的合成测试');
            cleanup();
            await page.waitForFunction(() => promptCapture.read().records.length === 0);
            streamRouter.stack.length = 0;
            cleanup = installPromptCapture(generateRouter, streamRouter);
            assert.doesNotMatch(await page.evaluate(() => JSON.stringify(Object.entries(localStorage))), /服务器后续处理标记|synthetic-secret|实际系统/);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ viewport, checks: 'per-AI-message button, correct reply association, actual HTTP body, two distinct stages, text preservation, copy, per-reply clear, refresh, server restart, no horizontal overflow', errors }));
            await context.close();
        }
    } finally {
        await browser.close(); cleanup(); server.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
