const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const files = new Map(), reads = [], mutations = [];
const uuidSource = `const uuid=()=>{const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;
const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20)};`;
const html = harness
    .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace("import {createTheatrePanel}", uuidSource + "\nimport {createPlayFiles} from '/play-storage.js';\nimport {createTheatrePanel}")
    .replace(/const files=new Map[\s\S]*?uuid:\(\)=>crypto.randomUUID\(\)\}\);/, "const files={has:()=>!!localStorage.getItem('seed')};\nconst history=window.testHistory=createPlayHistory({...createPlayFiles(()=>ctx.getRequestHeaders()),uuid});")
    .replace('createPlayRuntime(()=>ctx,settings,history,', 'createPlayRuntime(()=>ctx,settings,undefined,')
    .replace('uuidv4:()=>crypto.randomUUID(),', "uuidv4:()=>crypto.randomUUID(),getRequestHeaders:()=>({'Content-Type':'application/json'}),")
    .replaceAll('crypto.randomUUID()', 'uuid()');
assert.ok(html.includes('createPlayRuntime(()=>ctx,settings,undefined,'));
assert.ok(html.includes('createPlayHistory({...createPlayFiles('));
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://test').pathname.slice(1));
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (name === 'thumbnail') {
            response.setHeader('Content-Type', 'image/svg+xml');
            return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#739785"/></svg>');
        }
        if (name.startsWith('user/files/')) {
            const file = name.slice('user/files/'.length), text = files.get(file);
            reads.push(file); response.statusCode = text === undefined ? 404 : 200; return response.end(text ?? '');
        }
        if (name === 'api/files/upload' || name === 'api/files/delete') {
            let body = ''; for await (const chunk of request) body += chunk;
            const data = JSON.parse(body); mutations.push(name);
            if (name.endsWith('upload')) files.set(data.name, Buffer.from(data.data, 'base64').toString('utf8'));
            else files.delete(data.path.replace('user/files/', ''));
            response.setHeader('Content-Type', 'application/json'); return response.end('{}');
        }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const panel = page => page.locator('.tea-panel-surface[data-active=true]');
const button = (page, name) => panel(page).getByRole('button', { name, exact: true }).filter({ visible: true });
const bodyReads = () => reads.filter(name => name.startsWith('teahouse-play-body-')).length;
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function verify(page, url, viewport, mode) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (!['error', 'warning'].includes(message.type())) return;
        if (message.text().includes('404') && message.location().url.endsWith('/user/files/teahouse-play-index.json')) return;
        errors.push(`${message.text()} (${message.location().url})`);
    });
    await page.goto(url);
    await page.waitForFunction(() => window.ready).catch(error => { error.pageErrors = errors; throw error; });
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    const capabilities = await page.evaluate(() => ({ secure: isSecureContext, locks: !!navigator.locks, sharedWorker: typeof SharedWorker }));
    assert.equal(capabilities.secure, false); assert.equal(capabilities.locks, false);
    if (mode === 'missing') assert.equal(capabilities.sharedWorker, 'undefined');
    const seed = await page.evaluate(async () => {
        let source = await testHistory.getChat(window.seed.a);
        for (let i = 1; i < 15; i++) {
            const stamp = new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(), resultId = ctx.uuidv4();
            await testHistory.begin({ roundId: source.id, chatMode: true, operation: 'send', character: ctx.characters[0],
                prompt: `局域网用户消息${i}`, resultId, startedAt: stamp, context: source.messages[1].results[0].context });
            await testHistory.saveResult(source.id, resultId, { text: `局域网回复${i}`, status: 'complete', finishedAt: stamp });
        }
        source = await testHistory.getChat(source.id);
        const branch = await testHistory.createBranch(source.id, source.messages.at(-1).id, source.revision);
        return { source: source.id, branch: branch.id };
    });
    await page.locator('#open').click(); await button(page, '剧场演出').click();
    await panel(page).locator('.play-prose').getByText('小剧场正文', { exact: true }).waitFor();
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(), 0);
    await button(page, '历史记录').click();
    await panel(page).locator(`[data-chat-id="${seed.branch}"] .play-history-preview`).getByText('局域网回复14', { exact: true }).waitFor();
    await screenshot(page, `lan-history-${mode}-${viewport.width}.png`);
    reads.length = 0;
    await panel(page).locator(`[data-chat-id="${seed.branch}"] .play-history-open`).click();
    const branch = panel(page).locator('.play-branch-page');
    await branch.getByText('局域网回复14', { exact: true }).waitFor(); await settle(page);
    assert.equal(await branch.locator('.play-feed-content > .play-message').count(), 24);
    assert.ok(bodyReads() <= 24);
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    await branch.getByRole('button', { name: '收藏该聊天', exact: true }).click();
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    await branch.getByRole('button', { name: '取消收藏该聊天', exact: true }).waitFor();
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    const favorite = await page.evaluate(async () => (await runtime.listFavorites())[0]);
    await page.reload(); await page.waitForFunction(() => window.ready);
    await page.locator('#open').click();
    reads.length = 0;
    await button(page, '我的收藏').click(); await button(page, '演出记录').click();
    if (viewport.width <= 760) await panel(page).locator(`.tea-story[data-id="${favorite.id}"]`).click();
    const reader = panel(page).locator('.play-favorite-reading[data-active=true]');
    await reader.locator('.play-favorite-content > .play-message').nth(23).waitFor();
    await page.waitForFunction(() => document.querySelector('.play-favorite-reading[data-active=true] .play-favorite-source-notice')?.hidden === true);
    await settle(page);
    assert.equal(await reader.locator('.play-favorite-content > .play-message').count(), 24);
    assert.equal(bodyReads(), 24);
    reads.length = 0; const beforeRefresh = mutations.length;
    await page.evaluate(() => ui.refresh()); await settle(page);
    assert.equal(bodyReads(), 0); assert.equal(mutations.length, beforeRefresh);
    await page.evaluate(async id => {
        const chat = await runtime.getChatMetadata(id), message = chat.messages[0];
        await runtime.editMessage(id, message.id, { text: '局域网更新后的用户消息', expectedText: '测试小剧场' });
        ui.refresh();
    }, seed.branch);
    await reader.getByText('局域网更新后的用户消息', { exact: true }).waitFor();
    reads.length = 0;
    await reader.getByRole('button', { name: '显示更多聊天内容', exact: true }).click();
    await reader.getByText('局域网回复14', { exact: true }).waitFor();
    assert.equal(await reader.locator('.play-favorite-content > .play-message').count(), 30);
    assert.ok(bodyReads() > 0 && bodyReads() <= 6);
    for (let i = 12; i < 15; i++) await reader.getByText(`局域网回复${i}`, { exact: true }).waitFor();
    assert.ok(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await screenshot(page, `lan-favorite-${mode}-${viewport.width}.png`);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ url, viewport, mode, capabilities, checks: '演出、历史预览、分支24条、聊天收藏24条、未变刷新、来源更新、显示更多仅新增范围', errors }));
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true,
        args: ['--host-resolver-rules=MAP tea.test 127.0.0.1', '--no-proxy-server'] });
    const url = `http://tea.test:${server.address().port}/`;
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            for (const mode of ['native', 'missing']) {
                files.clear(); reads.length = 0; mutations.length = 0;
                const context = await browser.newContext({ viewport, isMobile: viewport.width <= 760, hasTouch: viewport.width <= 760 });
                if (mode === 'missing') await context.addInitScript(() => Object.defineProperty(window, 'SharedWorker', { configurable: true, value: undefined }));
                try { await verify(await context.newPage(), url, viewport, mode); }
                finally { await context.close(); }
            }
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
