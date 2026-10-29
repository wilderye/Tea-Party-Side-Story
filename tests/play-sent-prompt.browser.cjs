// Browser plugin not available. Use Playwright/Edge and synthetic data only.
// Flow: each AI message's top-right button -> its current version's actual prompt -> copy -> switch versions.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: originalHarness } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
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
    const actualBodies = [], actualHeaders = [], requests = [];
    const server = http.createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        requests.push(pathname);
        if (pathname === '/api/backends/chat-completions/generate') {
            let body = ''; for await (const chunk of request) body += chunk;
            actualBodies.push(body); actualHeaders.push(request.headers);
            response.setHeader('Content-Type', 'application/json'); response.end('{"text":"合成回复正文"}'); return;
        }
        if (pathname.startsWith('/api/plugins/tea-prompt-capture')) { response.writeHead(403); response.end('Forbidden'); return; }
        if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
        try {
            const content = pathname === '/' ? harness : await fs.readFile(path.join(root, pathname));
            response.setHeader('Content-Type', pathname === '/' ? 'text/html; charset=utf-8' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
            response.end(content);
        } catch { response.writeHead(404); response.end(); }
    });
    server.listen(0, '127.0.0.1');
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
            const expandReplyTools = async message => {
                const more = message.getByRole('button', { name: '更多回复操作', exact: true });
                if (await more.isVisible()) await more.click();
            };
            const openPrompt = async message => { await expandReplyTools(message); await inspect(message).click(); };
            const viewer = page.getByRole('dialog', { name: '实际发送的提示词', exact: true });
            const open = async () => {
                await page.waitForFunction(() => window.ready);
                await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
                await button('剧场演出').click();
            };
            const send = async text => {
                await panel.getByRole('textbox', { name: '小剧场提示词', exact: true }).fill(text);
                await button('发送小剧场').click();
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
            const resultId = await ai().evaluate(node => runtime.getRound(node.closest('.play-record').dataset.record)
                .then(round => round.results.at(-1).id));
            assert.deepEqual(await page.evaluate(resultId => promptCapture.read(resultId), resultId),
                { messages: JSON.parse(actualBodies.at(-1)).messages }, '与酒馆收到的实际正文一致');
            assert.ok(actualHeaders.every(headers => !Object.keys(headers).some(key => key.startsWith('x-tea-prompt-'))));
            if (process.env.TEA_QA_DIR) {
                await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `sent-prompt-button-${viewport.width}.png`) });
            }
            await expandReplyTools(ai());
            const promptButton = inspect(ai());
            const bounds = await promptButton.boundingBox(), headBounds = await ai().locator('.play-assistant-meta').boundingBox();
            assert.ok(bounds.x > viewport.width / 2 && bounds.y >= headBounds.y && bounds.y < headBounds.y + headBounds.height, '按钮在这条 AI 消息右上角');
            assert.equal(await promptButton.evaluate(node => !!node.closest('.play-assistant-meta')), true);
            await promptButton.click();
            assert.ok((await viewer.locator('pre').textContent()).includes(text));
            assert.ok((await viewer.locator('pre').textContent()).includes('实际系统\n\n  缩进保持'));
            assert.doesNotMatch(await viewer.innerText(), /synthetic-secret|"messages"\s*:|服务器后续处理标记/);
            assert.equal(await viewer.getByRole('combobox').count(), 0);
            assert.equal(await viewer.getByRole('button').count(), 2);
            assert.doesNotMatch(await viewer.innerText(), /小剧场发给酒馆|酒馆发给模型|清空记录|刷新|重启|第 \d+ 次发送/);
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
            await openPrompt(firstMessage);
            assert.ok((await viewer.locator('pre').textContent()).includes(text));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /另一条回复的独立提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await openPrompt(ai());
            assert.ok((await viewer.locator('pre').textContent()).includes('另一条回复的独立提示词'));
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            const roundId = await ai().evaluate(node => node.closest('.play-record').dataset.record);
            await page.evaluate(async roundId => {
                const round = await runtime.getRound(roundId);
                await runtime.editPrompt(roundId, '新版本专属提示词', round.prompt);
                await runtime.generateAnother(roundId);
                ui.refresh();
            }, roundId);
            await openPrompt(ai());
            assert.ok((await viewer.locator('pre').textContent()).includes('新版本专属提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /另一条回复的独立提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await ai().getByRole('button', { name: '上一个结果', exact: true }).click();
            await openPrompt(ai());
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
            await openPrompt(ai());
            assert.ok((await viewer.locator('pre').textContent()).includes('重新生成的专属提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /新版本专属提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await page.evaluate(async roundId => {
                const round = await runtime.getRound(roundId);
                await runtime.editPrompt(roundId, '续写的专属提示词', round.prompt);
            }, roundId);
            await ai().getByRole('button', { name: '续写', exact: true }).click();
            await page.waitForFunction(() => runtime.getStates().length === 0);
            await openPrompt(ai());
            assert.equal(await viewer.getByRole('combobox').count(), 0);
            assert.ok((await viewer.locator('pre').textContent()).includes('续写的专属提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /重新生成的专属提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await expandReplyTools(ai()); await ai().getByRole('button', { name: '创建分支', exact: true }).click();
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
            await openPrompt(branch.locator(`[data-message-id="${firstBranchMessageId}"]`));
            assert.ok((await viewer.locator('pre').textContent()).includes('分支第一条专属提示词'));
            assert.doesNotMatch(await viewer.locator('pre').textContent(), /分支第二条专属提示词/);
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await openPrompt(branch.locator('.play-assistant-message').last());
            assert.ok((await viewer.locator('pre').textContent()).includes('分支第二条专属提示词'));
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            await button('关闭聊天页面').click();
            await send('刷新清空的合成测试');
            await page.reload(); await open();
            assert.equal(await page.evaluate(resultId => promptCapture.read(resultId), resultId), null);
            await openPrompt(ai());
            await viewer.getByText('这条回复没有可查看的提示词。', { exact: true }).waitFor();
            await viewer.getByRole('button', { name: '关闭提示词查看', exact: true }).click();
            assert.equal(requests.filter(pathname => pathname.startsWith('/api/plugins/tea-prompt-capture')).length, 0,
                '不请求已取消的服务器记录接口，因此不会由该接口产生 403');
            assert.doesNotMatch(await page.evaluate(() => JSON.stringify(Object.entries(localStorage))), /服务器后续处理标记|synthetic-secret|实际系统/);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ viewport, checks: 'per-AI-message button, correct version association, actual HTTP body, unchanged request headers, no server capture requests, text preservation, copy, regeneration, continuation, branch, refresh, no horizontal overflow', errors }));
            await context.close();
        }

    } finally {
        await browser.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
