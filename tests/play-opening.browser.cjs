// Browser plugin not available. Real panel with synthetic records and controlled
// completion order; no Tavern data, remote resources, or model calls.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: base } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = base.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace("import {createTheatrePanel}", "import {createDiagnostics} from '/diagnostics.js';\nimport {createTheatrePanel}")
    .replace('loadRegex:async()=>engine', 'loadRegex:async()=>{if(window.regexGate)await regexGate;if(window.rejectRules)throw Error("synthetic rules unavailable");return engine;}')
    .replace('const ui=window.ui=', 'window.diagnostics=createDiagnostics();libraryActions.diagnostics=diagnostics;\nconst ui=window.ui=');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(name)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
});
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function seed(page) {
    await page.evaluate(async () => {
        const original = await runtime.getRound(seed.a), records = new Map(), gates = new Map();
        window.rows = []; window.started = []; window.completed = []; window.replacements = 0;
        window.regexGate = new Promise(resolve => window.releaseRegex = resolve);
        window.releaseRecord = (ordinal, failed = false) => gates.get(ordinal)?.(failed);
        for (let ordinal = 1; ordinal <= 61; ordinal++) {
            const round = structuredClone(original); round.id = crypto.randomUUID(); round.prompt = `private-prompt-${ordinal}`;
            round.results = [{ ...round.results[0], id: crypto.randomUUID(), text: `private-reply-${ordinal}\n\n全局标记\n\n` + '“虚构测试段落。”\n\n'.repeat(24) }];
            const gate = new Promise(resolve => gates.set(ordinal, resolve));
            records.set(round.id, { round, ordinal, gate }); rows.push({ id: round.id, revision: round.id, characterId: original.characterId, createdAt: round.createdAt });
        }
        const read = runtime.getRound, list = runtime.listRounds;
        runtime.listRounds = id => id === original.characterId ? Promise.resolve(rows) : list(id);
        runtime.getRound = async id => {
            const item = records.get(id); if (!item) return read(id);
            started.push(item.ordinal);
            if (await item.gate && !window.allowRetry) throw Error('synthetic record unavailable');
            completed.push(item.ordinal); return structuredClone(item.round);
        };
        const replace = Element.prototype.replaceChildren;
        Element.prototype.replaceChildren = function (...args) {
            if (this.matches('.play-result') && this.querySelector('.play-prose,iframe')) replacements++;
            return replace.apply(this, args);
        };
        fixture.community.set('private-entry', { id: 'private-entry', title: 'private-title', type: 'standalone', author: 'private-author', body: 'private-catalog-body\n\n“测试文字。”' });
    });
}
async function snapshot(page) {
    return page.evaluate(() => {
        const feed = document.querySelector('.play-feed');
        const shown = [...feed.querySelectorAll('.play-record')].filter(node => !node.closest('[hidden]'));
        return { count: shown.length, latest: shown.at(-1)?.dataset.record === rows.at(-1).id,
            distance: feed.scrollHeight - feed.clientHeight - feed.scrollTop, replacements,
            loading: !feed.querySelector('.play-empty').hidden, earlier: !feed.querySelector('.play-earlier-bar').hidden,
            busy: feed.getAttribute('aria-busy') };
    });
}
async function check(page, mode) {
    const panel = page.locator('#teahouse-panel'), button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await seed(page);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await button('剧场演出').click();
    await page.waitForFunction(() => started.length === 4); await settle(page);
    assert.deepEqual(await snapshot(page), { count: 0, latest: false, distance: 0, replacements: 0, loading: true, earlier: false, busy: 'true' });
    if (mode === 'latest-slow') {
        await page.evaluate(() => { for (let n = 1; n <= 60; n++) releaseRecord(n); releaseRegex(); });
        await page.waitForFunction(() => completed.length === 9 && runtime.display.revision > 0); await settle(page);
        assert.equal((await snapshot(page)).count, 0, '较早记录先完成也不能冒充最新正文');
        await page.evaluate(() => releaseRecord(61));
    } else if (mode === 'rules-slow' || mode === 'rules-fail') {
        await page.evaluate(() => { for (let n = 1; n <= 61; n++) releaseRecord(n); });
        await page.waitForFunction(() => completed.length === 10); await settle(page);
        assert.equal((await snapshot(page)).count, 0, '规则未准备好不显示随后需要替换的正文');
        await page.evaluate(fail => { window.rejectRules = fail; releaseRegex(); }, mode === 'rules-fail');
    } else if (mode === 'latest-fails') {
        await page.evaluate(() => { for (let n = 1; n <= 60; n++) releaseRecord(n); releaseRegex(); releaseRecord(61, true); });
        await panel.getByText('要显示的演出记录暂时无法读取。', { exact: true }).waitFor();
        assert.equal((await snapshot(page)).count, 0); assert.equal((await snapshot(page)).loading, false);
        await page.evaluate(() => window.allowRetry = true); await button('重新读取').click();
    } else {
        await page.evaluate(() => { releaseRegex(); releaseRecord(61); });
        await page.waitForFunction(() => document.querySelectorAll('.play-record').length === 1); await settle(page);
        assert.equal((await snapshot(page)).latest, true);
        await page.evaluate(() => window.originalProse = document.querySelector('.play-result .play-prose'));
        for (let n = 60; n >= 52; n--) {
            await page.evaluate(n => releaseRecord(n), n);
            await page.waitForFunction(n => completed.length === 62 - n, n); await settle(page);
            assert.ok((await snapshot(page)).distance < 2);
        }
        assert.equal(await page.evaluate(() => originalProse.isConnected), true);
    }
    await page.waitForFunction(() => document.querySelectorAll('.play-record').length === 10); await settle(page);
    const result = await snapshot(page);
    assert.equal(result.latest, true); assert.equal(result.replacements, 0); assert.ok(result.distance < 2);
    assert.equal(result.loading, false); assert.equal(result.busy, 'false');
    if (process.env.TEA_QA_DIR) { await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `opening-${mode}-${page.viewportSize().width}.png`) }); }
    await button('设置').click();
    await button('查看日志').click(); await page.waitForTimeout(300);
    const downloadEvent = page.waitForEvent('download'); await button('导出日志').click();
    const download = await downloadEvent, file = await download.path(), exported = await fs.readFile(file, 'utf8');
    for (const name of ['打开面板', '记录目录读取完成', '开始读取记录', mode === 'rules-fail' ? '显示规则读取失败' : '显示规则读取完成', '显示记录批次', '元素样式']) assert.ok(exported.includes(name), name);
    assert.match(exported, /"latestReady":true/); assert.match(exported, /"ordinal":61/);
    assert.doesNotMatch(exported, /private-prompt|private-reply|private-title|private-author|private-catalog-body|A\.png|B\.png/);
    const events = await page.evaluate(() => diagnostics.read().entries.filter(entry => entry.view));
    assert.ok(events.length < 400, '日志数量有界');
    assert.ok(events.every((entry, i) => i === 0 || entry.view.sequence > events[i - 1].view.sequence), '同次打开按观察顺序关联');
    const saved = await page.evaluate(() => diagnostics.export());
    await page.reload(); await page.waitForFunction(() => window.ready);
    const restored = await page.evaluate(() => diagnostics.export());
    assert.ok(restored.startsWith(saved), '刷新浏览器后保留此前观察，并可追加离开页面的事件');
    assert.match(restored, /离开浏览器页面/);
}
async function checkObservations(page) {
    await page.evaluate(() => {
        fixture.community.set('private-entry', { id: 'private-entry', title: 'private-title', type: 'standalone', author: 'private-author',
            body: 'private-catalog-text\n\n“不可写入日志的对白。”' });
    });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await page.waitForTimeout(550);
    await page.locator('.tea-feed-entry .tea-body').evaluate(body => { window.originalBody = body; body.style.opacity = '0'; });
    await page.waitForTimeout(400);
    await page.locator('.tea-feed-entry .tea-body').evaluate(body => { body.style.opacity = '1'; });
    await page.evaluate(async () => {
        const face = new FontFace('Synthetic QA Font', 'url(/assets/fonts/tea-conversation-serif.woff2)');
        document.fonts.add(face); await face.load();
        const image = document.createElement('img'); image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"/>');
        document.querySelector('.tea-feed-entry .tea-body').append(image);
        const until = performance.now() + 160; while (performance.now() < until) { /* synthetic long task */ }
    });
    await page.waitForTimeout(550);
    const entries = await page.evaluate(() => diagnostics.read().entries);
    assert.ok(entries.some(entry => entry.view?.probe === 'prose' && entry.view.opacity === '0'), '正文仍在但透明时留下样式证据');
    assert.ok(entries.some(entry => entry.view?.probe === 'prose' && entry.view.opacity === '1'), '恢复后仍观察同一正文');
    assert.ok(entries.some(entry => entry.operation === '显示观察：绘制间隔' && (entry.view.maxFrameGap > 100 || entry.view.longestTask > 100)));
    assert.ok(entries.some(entry => entry.operation === '显示观察：资源事件' && entry.view.imageKind === 'prose'));
    assert.ok(entries.some(entry => entry.operation === '显示观察：资源耗时' && entry.view.resourceKind === 'font'));
    assert.equal(await page.evaluate(() => originalBody.isConnected), true);
    assert.doesNotMatch(await page.evaluate(() => diagnostics.export()), /private-catalog-text|不可写入日志的对白|private-title|private-author|data:image|tea-conversation-serif/);
    await page.locator('#teahouse-panel').getByRole('button', { name: '关闭面板', exact: true }).click();
    await page.locator('#teahouse-panel').waitFor({ state: 'detached' });
    const before = await page.evaluate(() => diagnostics.export());
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => diagnostics.export()), before, '关闭面板后移除定时器和观察器，不继续写日志');
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 390, height: 844 }, { width: 1332, height: 896 }]) for (const mode of ['latest-slow', 'rules-slow', 'latest-first', 'latest-fails', 'rules-fail']) {
            const context = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
            await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
            await check(page, mode); assert.deepEqual(errors, []);
            console.log(JSON.stringify({ viewport, mode, passed: true, errors })); await context.close();
        }
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
        await checkObservations(page); assert.deepEqual(errors, []);
        console.log(JSON.stringify({ mode: 'style-font-image-paint-and-dispose', passed: true, errors })); await context.close();
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
