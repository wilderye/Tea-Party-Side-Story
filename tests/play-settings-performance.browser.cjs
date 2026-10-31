// Browser plugin not available. Use the existing Playwright/Edge workflow.
// Flow: reading -> settings overlay -> return; retain bodies, reading position and scoped reads.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://test').pathname.slice(1);
    if (!name) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end(harness.replace("import {createTheatrePanel}", "import {createDiagnostics} from '/diagnostics.js'; window.diag=createDiagnostics();\nimport {createTheatrePanel}")
        .replace("this.dlg=document.createElement('dialog');", "this.dlg=document.createElement('dialog');this.dlg.addEventListener('cancel',event=>{event.preventDefault();void this.complete()});")
        .replace('const history=window.testHistory', 'window.bodyReads=[]; const history=window.testHistory')
        .replace('readFile:async name=>files.get(name)??null', "readFile:async name=>{if(name.startsWith('teahouse-play-body-'))bodyReads.push(name);return files.get(name)??null}")
        .replace('{...libraryActions,playground:runtime,promptFavorites}', '{...libraryActions,playground:runtime,promptFavorites,diagnostics:window.diag}'));
    }
    if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
    response.end(await fs.readFile(file));
  } catch (error) { response.statusCode = 500; response.end(error.message); }
});

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function verify(page, url, viewport) {
  await page.goto(url); await page.waitForFunction(() => window.ready);
  assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
  await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  const panel = page.locator('#teahouse-panel'), button = name => panel.getByRole('button', { name, exact: true });
  await button('剧场演出').click();
  await page.waitForFunction(() => document.querySelectorAll('.play-record:not([hidden])').length === 2);
  await page.waitForTimeout(150); await settle(page);
  await page.evaluate(() => { for (let i=0;i<100;i++) diag.info('合成操作记录'); });
  const settings = panel.locator('.tea-settings-layer');
  const open = async () => { await button('设置').click(); await settings.waitFor(); };
  const back = async () => { await settings.getByRole('button', { name: viewport.width <= 760 ? '返回剧场演出' : '设置', exact: true }).click(); await settings.waitFor({ state: 'detached' }); await settle(page); };
  const original = panel.locator(`[data-record="${await page.evaluate(() => seed.a)}"]`);
  const anchor = original.getByText('阅读位置验证第10段。', { exact: true });
  const position = async () => anchor.evaluate(node => node.getBoundingClientRect().top - node.closest('.play-feed').getBoundingClientRect().top);
  await anchor.evaluate(node => { const feed=node.closest('.play-feed'); feed.scrollTop+=node.getBoundingClientRect().top-feed.getBoundingClientRect().top-100; });
  const capture = () => original.evaluate(node => {
    const feed=node.closest('.play-feed'), tabs=document.querySelector('.play-catalog:not([hidden]) .tea-mobile-tabs');
    const top=Math.max(feed.getBoundingClientRect().top,tabs?.getClientRects().length?tabs.getBoundingClientRect().bottom:0);
    const anchor=[...feed.querySelectorAll('[data-read-anchor]')].find(item=>item.getClientRects().length && item.getBoundingClientRect().height && item.getBoundingClientRect().bottom>top+1);
    return { id:anchor.dataset.readAnchor, offset:top-anchor.getBoundingClientRect().top };
  });
  await settle(page); const before = await position(), reading = await capture();
  await anchor.evaluate(node => window.originalBody=node);
  const reads = await page.evaluate(() => bodyReads.length);
  await open();
  assert.equal(await panel.locator('.play-workspace').evaluate(node => node.getAttribute('aria-hidden')==='true' && !node.hidden), true);
  await anchor.evaluate(node => { const input=node.closest('.play-page').querySelector('textarea'); input.focus(); });
  assert.equal(await settings.evaluate(node => node.contains(document.activeElement)), true, '覆盖的正文不能取得输入焦点');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => !document.activeElement.closest('.play-workspace')), true);
  assert.equal(await settings.locator('.tea-log-entry').count(), 0, '折叠日志不创建条目');
  await settings.getByRole('button', { name: '查看日志', exact: true }).click();
  assert.ok(await settings.locator('.tea-log-entry').count() >= 100);
  await back();
  assert.equal(await anchor.evaluate(node => originalBody.isConnected && originalBody === node), true);
  assert.equal(await page.evaluate(() => bodyReads.length), reads, '普通设置切换不读取正文');
  assert.ok(Math.abs(await position()-before)<2, '返回后保留原段落位置');
  await open(); await settings.getByRole('combobox', { name: '正文字号', exact: true }).selectOption('22'); await back();
  const resized = await capture();
  assert.equal(resized.id, reading.id, '改字号后仍恢复原段落');
  assert.ok(Math.abs(resized.offset-reading.offset)<2, `改字号后保留段落位置 ${JSON.stringify(reading)} -> ${JSON.stringify(resized)}`);
  await open(); await settings.getByRole('combobox', { name: '正文字号', exact: true }).selectOption('18'); await back();
  await original.getByRole('button', { name: '编辑回复原文', exact: true }).click();
  const editor = original.getByRole('textbox', { name: '回复原文', exact: true });
  await editor.fill('设置切换保留未保存的草稿'); await editor.evaluate(node => window.originalEditor=node);
  await open(); await back();
  assert.equal(await editor.inputValue(), '设置切换保留未保存的草稿');
  assert.equal(await editor.evaluate(node => node===originalEditor), true);
  await original.getByRole('button', { name: '取消', exact: true }).click();
  await open(); await settings.getByRole('button', { name: '随文剧场用法', exact: true }).click();
  await button('返回设置').click();
  await button(viewport.width<=760?'返回剧场演出':'设置').click();
  await original.waitFor();
  await panel.getByRole('textbox', {name:'小剧场提示词',exact:true}).fill('演出记录设置期间生成');
  await panel.locator('.play-compose .play-send').click();
  await page.waitForFunction(() => runtime.getStates().some(job=>job.phase==='generating'));
  await page.evaluate(() => emitGeneration('演出记录打开设置前的正文'));
  const live = panel.locator('[data-record]').filter({hasText:'演出记录设置期间生成'});
  await live.getByText('演出记录打开设置前的正文', {exact:true}).waitFor();
  await open(); await page.evaluate(() => emitGeneration('演出记录设置期间收到的正文')); await page.waitForTimeout(40); await back();
  await live.getByText('演出记录设置期间收到的正文', {exact:true}).waitFor();
  await open(); await page.evaluate(() => finishGeneration('演出记录设置期间完成的正文'));
  await page.waitForFunction(() => runtime.getStates().length===0); await back();
  await live.getByText('演出记录设置期间完成的正文', {exact:true}).waitFor();
  const more = original.locator('.play-assistant-message').getByRole('button', { name: '更多回复操作', exact: true });
  if (await more.isVisible()) await more.click();
  await original.getByRole('button', { name: '创建分支', exact: true }).click();
  const branch = panel.locator('.play-branch-page').filter({ visible: true });
  await branch.locator('[data-message-id]').first().waitFor();
  await settle(page);
  const chatReads = await page.evaluate(() => bodyReads.length);
  await branch.locator('[data-message-id]').first().evaluate(node => window.chatBody=node);
  await open(); await back();
  assert.equal(await page.evaluate(() => bodyReads.length), chatReads, '分支设置返回不重新读取聊天');
  assert.equal(await page.evaluate(() => chatBody.isConnected), true);
  await branch.getByRole('textbox', { name: '分支聊天输入', exact: true }).fill('设置期间生成');
  await branch.locator('.play-send').click();
  await page.waitForFunction(() => runtime.getStates().some(job=>job.phase==='generating'));
  await page.evaluate(() => emitGeneration('设置打开前收到的正文')); await branch.getByText('设置打开前收到的正文', { exact: true }).waitFor();
  await open(); await page.evaluate(() => emitGeneration('设置打开期间收到的正文')); await back();
  await branch.getByText('设置打开期间收到的正文', { exact: true }).waitFor();
  await open(); await page.evaluate(() => finishGeneration('设置期间生成完成的正文'));
  await page.waitForFunction(() => runtime.getStates().length===0); await back();
  await branch.getByText('设置期间生成完成的正文', { exact: true }).waitFor();
  await open();
  if (viewport.width <= 760) await page.keyboard.press('Escape');
  else await settings.getByRole('button', { name: '关闭面板', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click(); await settle(page);
  await branch.getByText('设置期间生成完成的正文', { exact: true }).waitFor();
  assert.equal(await panel.locator('[inert]').filter({ has: page.locator('.play-branch-page') }).count(), 0);
  const screenshot = path.join(require('node:os').tmpdir(), `tea-settings-return-${viewport.width}.png`);
  await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ viewport, screenshot, passed: true, checks: 'overlay, body identity, no repeated reads, lazy logs, font position, edit draft, help, branch stream/completion, close/reopen' }));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type()==='error') errors.push(message.text()); });
      await verify(page, `http://127.0.0.1:${server.address().port}/`, viewport);
      assert.deepEqual(errors, []); await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
