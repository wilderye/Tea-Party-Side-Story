// Browser plugin not available. Use Playwright/Edge with synthetic data only.
// Flow: mix roles/versions -> stop one reply -> stream others -> preserve reading.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: originalHarness } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = originalHarness.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">').replace(/prepareRequest:async request=>\{window\.captured\.push\(request\.environment\);[\s\S]*?\}\}\}\);/, `
prepareRequest:async request=>{
    window.captured.push(request.environment);window.capturedPrompts.push(request.prompt);
    const task={id:request.generationId,avatar:request.environment.character.avatar,signal:request.signal};
    (window.tasks??=[]).push(task);
    if(window.holdPreparation)await new Promise(resolve=>task.releasePreparation=resolve);
    return {send:({onText,signal})=>new Promise((resolve,reject)=>{
        window.modelCalls=(window.modelCalls??0)+1;task.text=onText;task.finish=resolve;
        signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    })};
}});`);
assert.notEqual(harness, originalHarness);
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});

function position(feed) {
    const top = feed.getBoundingClientRect().top;
    const anchor = [...feed.querySelectorAll('[data-read-anchor]')].find(node => node.getClientRects().length && node.getBoundingClientRect().height && node.getBoundingClientRect().bottom > top + 1);
    return { anchor: anchor?.dataset.readAnchor, offset: anchor ? top - anchor.getBoundingClientRect().top : null, bottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 24 };
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }, { width: 355, height: 780 }, { width: 320, height: 700 }]) {
            const context = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
            await page.waitForFunction(() => window.ready);
            await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
            const panel = page.locator('#teahouse-panel'), button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
            await button('剧场演出').click();
            const aId = await page.evaluate(() => seed.a), a = panel.locator(`[data-record="${aId}"]`);
            await a.getByRole('button', { name: '重新生成', exact: true }).click();
            await page.waitForFunction(() => window.modelCalls === 1);
            await a.getByRole('button', { name: '生成新剧场', exact: true }).click();
            await page.waitForFunction(() => window.modelCalls === 2);
            await a.getByRole('button', { name: '上一个结果', exact: true }).click();
            assert.equal(await a.getByRole('button', { name: '重新生成', exact: true }).isDisabled(), true);
            assert.equal(await a.getByRole('button', { name: '停止这份回复', exact: true }).isVisible(), true);
            const selected = await a.locator('.play-result:visible').getAttribute('data-play-result');
            const choose = async name => {
                if (viewport.width <= 760 && await button('选择角色').isVisible()) await button('选择角色').click();
                await panel.locator('.play-people').getByRole('button', { name, exact: true }).click();
            };
            await choose('测试乙');
            const input = panel.getByRole('textbox', { name: '小剧场提示词', exact: true });
            await input.fill('乙的并发小剧场'); await button('发送小剧场').click();
            await page.waitForFunction(() => window.modelCalls === 3);
            assert.equal(await page.evaluate(() => tasks[2].avatar), 'B.png');
            assert.equal(await page.evaluate(() => ctx.characterId), 0, '没有切换酒馆主角色');
            await choose('测试甲');
            assert.equal(await a.locator('.play-result:visible').getAttribute('data-play-result'), selected, '切回来仍看原来选择的版本');
            await a.getByRole('button', { name: '停止这份回复', exact: true }).click();
            await page.waitForFunction(() => tasks[0].signal.aborted && runtime.getStates().length === 2);
            assert.deepEqual(await page.evaluate(() => tasks.map(task => task.signal.aborted)), [true, false, false]);
            await page.evaluate(() => { tasks[1].text('隐藏版本继续生成'); tasks[2].finish('乙的完成回复 角色标记'); });
            await settle(page);
            assert.equal(await a.locator('.play-result:visible').getAttribute('data-play-result'), selected, '隐藏版本更新及另角色完成不会切版本');
            await input.fill('甲的新回复'); await button('发送小剧场').click();
            await page.waitForFunction(() => window.modelCalls === 4);
            const newRoundId = await page.evaluate(() => runtime.getState(tasks[3].id).roundId), reply = panel.locator(`[data-record="${newRoundId}"]`);
            await reply.getByRole('button', { name: '停止这份回复', exact: true }).waitFor();
            assert.equal(await reply.getByRole('button', { name: '回到这条消息开头', exact: true }).isVisible(), false, '短回复隐藏跳顶也能单独停止');
            const feed = panel.locator('.play-feed');
            const text = Array.from({ length: 35 }, (_, index) => `正在阅读第${index + 1}段。`).join('\n\n');
            await page.evaluate(text => tasks[3].text(text), text); await settle(page);
            assert.equal((await feed.evaluate(position)).bottom, true, '主动发送后滚到新回复并跟随末尾');
            const actions = await reply.locator('.play-message-actions').last().evaluate(node => {
                const stop = node.querySelector('.play-stop').getBoundingClientRect(), top = node.querySelector('.play-right-actions .tea-icon:last-child').getBoundingClientRect(), parent = node.getBoundingClientRect();
                return { stopLeft: stop.left, stopRight: stop.right, topLeft: top.left, topRight: top.right, parentRight: parent.right, height: stop.height };
            });
            assert.ok(actions.stopRight <= actions.topLeft + 1 && actions.topRight <= actions.parentRight + 1, '停止按钮在跳顶左边，手机无重叠或溢出');
            if (viewport.width < 760) assert.ok(actions.height >= 44);
            await feed.evaluate(node => { node.scrollTop = Math.max(0, node.scrollTop - 280); }); await settle(page);
            const before = await feed.evaluate(position); assert.equal(before.bottom, false);
            await page.evaluate(text => { tasks[1].text('隐藏版本更多内容'.repeat(100)); tasks[3].text(text + '\n\n新追加的末尾。'.repeat(12)); }, text);
            await settle(page); const after = await feed.evaluate(position);
            assert.equal(after.anchor, before.anchor); assert.ok(Math.abs(after.offset - before.offset) <= 2, '向上阅读后保持同一段落位置');
            await page.setViewportSize({ width: viewport.width, height: viewport.height - 220 }); await settle(page);
            const resized = await feed.evaluate(position); assert.equal(resized.anchor, before.anchor); assert.ok(Math.abs(resized.offset - before.offset) <= 2, '模拟手机键盘缩短页面时保持段落');
            await page.setViewportSize(viewport); await settle(page);
            await button('关闭面板').click(); await panel.waitFor({ state: 'detached' });
            assert.equal(await page.evaluate(() => tasks[3].signal.aborted), false);
            await page.evaluate(() => tasks[3].text('面板关闭后继续收到内容'));
            await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
            await reply.getByText('面板关闭后继续收到内容', { exact: true }).waitFor();
            await page.evaluate(() => { tasks[1].finish('甲的另一版本'); tasks[3].finish('甲的新回复完成'); });
            await page.waitForFunction(() => runtime.getStates().length === 0);
            await page.evaluate(() => window.holdPreparation = true);
            await input.fill('准备时停止'); await button('发送小剧场').click();
            await page.waitForFunction(() => tasks.length === 5);
            const preparingId = await page.evaluate(() => runtime.getState(tasks[4].id).roundId), preparing = panel.locator(`[data-record="${preparingId}"]`);
            await preparing.getByRole('button', { name: '停止这份回复', exact: true }).click();
            await page.waitForFunction(() => runtime.getStates().length === 0);
            await page.evaluate(() => tasks[4].releasePreparation()); await settle(page);
            assert.equal(await page.evaluate(() => window.modelCalls), 4, '准备期间停止，迟到准备不会发送');
            assert.ok(await panel.locator('.play-record:visible').count());
            assert.ok(await panel.evaluate(node => node.scrollWidth - node.clientWidth <= 1));
            assert.deepEqual(errors, []);
            if (process.env.TEA_QA_DIR) { await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `concurrent-replies-${viewport.width}.png`) }); }
            console.log(JSON.stringify({ viewport, mixedTasks: 5, modelCalls: 4, errors }));
            await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
