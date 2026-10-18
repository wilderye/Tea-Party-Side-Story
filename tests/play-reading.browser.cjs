// Flow: open a long history -> read/edit while older files load -> preserve state.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
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

async function seedLongHistory(page, mode) {
  return page.evaluate(async mode => {
    const original = await runtime.getRound(seed.a), records = new Map();
    const gate = new Promise(resolve => window.resumeHistoryReads = resolve);
    const progress = window.progress = { started: [], completed: 0 };
    for (let index = 0; index < 180; index++) {
      const round = structuredClone(original);
      round.id = crypto.randomUUID(); round.prompt = `第 ${index + 1} 场的提示词`;
      round.results = [{ ...round.results[0], id: crypto.randomUUID(), text: `第 ${index + 1} 场的正文\n\n继续阅读这一场的小剧场。` }];
      if (mode === 'states' && index === 179) round.results[0].text = '<div>网页里的小剧场</div><button id="step">继续</button><span id="count">0</span><script>document.getElementById("step").onclick=()=>document.getElementById("count").textContent=Number(document.getElementById("count").textContent)+1;</script>';
      records.set(round.id, round);
    }
    const rows = [...records.values()].map(round => ({ id: round.id, revision: round.id, characterId: round.characterId,
      createdAt: round.createdAt, lastPlayedAt: round.createdAt }));
    const list = runtime.listRounds, read = runtime.getRound;
    runtime.listRounds = id => id === original.characterId ? Promise.resolve(rows) : list(id);
    runtime.getRound = async id => {
      if (!records.has(id)) return read(id);
      progress.started.push(id);
      if (progress.started.length > 6) await gate;
      await new Promise(resolve => setTimeout(resolve, 40)); progress.completed++;
      return structuredClone(records.get(id));
    };
    const ids = rows.map(row => row.id);
    if (mode === 'anchor') localStorage.setItem('teahouse-play-view-v1', JSON.stringify({ format: 1,
      positions: [[original.characterId, { bottom: false, anchor: `${ids[90]}/assistant/head`, offset: 0 }]], selections: [], drafts: [] }));
    return ids;
  }, mode);
}

async function checkHistory(page, mode, viewport) {
  const ids = await seedLongHistory(page, mode);
  await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  const panel = page.locator('#teahouse-panel'), button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
  await button('剧场演出').click();
  const targetId = mode === 'anchor' ? ids[90] : ids.at(-1);
  const target = panel.locator(`[data-record="${targetId}"]`);
  await target.waitFor();
  assert.equal(await page.evaluate(() => progress.started[0]), targetId);
  assert.equal(await panel.locator('.play-record').count(), mode === 'anchor' ? 90 : 10, '第一批仅按需展示最新10条或保存的锚点位置，不全量加载全部文件');
  const headOffset = record => record.locator('.play-assistant-meta').evaluate(node => node.getBoundingClientRect().top - document.querySelector('.play-feed').getBoundingClientRect().top);
  const before = await headOffset(target);
  if (mode === 'anchor') assert.ok(Math.abs(before) < 2, '优先恢复上次读到的消息位置');
  let editor;
  if (mode === 'states') {
    await target.frameLocator('iframe').getByRole('button', { name: '继续', exact: true }).click();
    const previous = panel.locator(`[data-record="${ids.at(-2)}"]`);
    await previous.getByRole('button', { name: '编辑回复原文', exact: true }).click();
    editor = previous.getByRole('textbox', { name: '回复原文', exact: true });
    await editor.fill('后台读取期间保留的草稿');
    await editor.evaluate(node => window.originalEditor = node);
  }
  if (mode === 'switch') {
    if (viewport.width <= 760) await button('选择角色').click();
    await panel.locator('.play-people').getByRole('button', { name: '测试乙', exact: true }).click();
    await panel.getByText('乙的旧记录 甲的规则', { exact: true }).waitFor();
    await page.evaluate(() => resumeHistoryReads());
    await page.waitForTimeout(180);
    assert.equal(await panel.locator('.play-record:visible').count(), 1);
    assert.equal(await panel.locator('.play-compose').isVisible(), false);
    assert.ok(await page.evaluate(() => progress.started.length <= 12), '切换角色后不继续读取上一角色的后续批次');
    return;
  }
  await page.evaluate(() => resumeHistoryReads());
  while (await panel.locator('.play-earlier-bar:visible').count() > 0) {
    await panel.locator('.play-earlier-bar').click();
    await page.waitForTimeout(40);
  }
  await page.waitForFunction(() => document.querySelectorAll('.play-record').length === 180);
  await page.waitForTimeout(100);
  const prompts = (await panel.locator('.play-record .play-user-text').allTextContents()).map(text => text.trim());
  assert.deepEqual(prompts, Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 场的提示词`), '相同创建时间也保持目录顺序');
  if (mode === 'anchor') {
    const after = await headOffset(target);
    assert.ok(Math.abs(after - before) < 2, `补入旧记录不改变阅读位置：${before} -> ${after}`);
  }
  if (mode === 'states') {
    assert.equal(await editor.inputValue(), '后台读取期间保留的草稿');
    assert.equal(await editor.evaluate(node => node === window.originalEditor), true);
    assert.equal(await target.frameLocator('iframe').locator('#count').innerText(), '1', '补入记录不重建已有网页');
  }
}

async function checkFavorite(page) {
  await page.evaluate(async () => {
    const { createPlayFavoriteReader } = await import('/play-favorites-view.js');
    window.favoriteCurrent = { id: 'favorite-test', revision: 'one', title: '原标题', characterName: '角色',
      text: '<div>收藏正文</div><button id="step">继续</button><span id="count">0</span><script>document.getElementById("step").onclick=()=>document.getElementById("count").textContent="1";</script>' };
    window.reader = createPlayFavoriteReader({ display: { process: text => text }, getFavorite: async () => {
      if (window.failFavorite) { window.failFavorite = false; throw Error('模拟读取失败'); }
      return { ...favoriteCurrent };
    } }, { onChange() {}, onRemove() {}, notify() {} });
    document.body.append(reader.node); await reader.load(favoriteCurrent);
  });
  const favorite = page.locator('.play-favorite-reading');
  await favorite.frameLocator('iframe').getByRole('button', { name: '继续', exact: true }).click();
  await page.evaluate(async () => { favoriteCurrent.title = '修改标题'; favoriteCurrent.revision = 'two'; await reader.load(favoriteCurrent); });
  assert.equal(await favorite.locator('h2').innerText(), '修改标题');
  assert.equal(await favorite.frameLocator('iframe').locator('#count').innerText(), '1', '只改标题保留网页状态');
  await page.evaluate(async () => { favoriteCurrent.revision = 'three'; window.failFavorite = true; await reader.load(favoriteCurrent); });
  await favorite.getByText('模拟读取失败', { exact: true }).waitFor();
  await favorite.getByRole('button', { name: '重新读取收藏', exact: true }).click();
  await favorite.frameLocator('iframe').getByText('收藏正文', { exact: true }).waitFor();
  assert.equal(await favorite.getByRole('button', { name: '重新读取收藏', exact: true }).count(), 0);
}

async function checkReopen(page, mode) {
  const ids = await seedLongHistory(page, mode);
  const open = () => page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  const button = name => page.locator('#teahouse-panel').getByRole('button', { name, exact: true }).filter({ visible: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const capture = () => page.locator('.play-feed').evaluate(feed => {
    const top = feed.getBoundingClientRect().top;
    const anchor = [...feed.querySelectorAll('[data-read-anchor]')].find(node => node.getClientRects().length && node.getBoundingClientRect().height && node.getBoundingClientRect().bottom > top + 1);
    return { anchor: anchor?.dataset.readAnchor, offset: anchor ? top - anchor.getBoundingClientRect().top : null,
      bottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 12 };
  });
  await open(); await button('剧场演出').click();
  await page.waitForFunction(() => document.querySelectorAll('.play-record').length === 10);
  if (mode !== 'reopen-loading') {
    await page.evaluate(() => resumeHistoryReads());
    while (await page.locator('#teahouse-panel .play-earlier-bar:visible').count() > 0) {
      await page.locator('#teahouse-panel .play-earlier-bar').click();
      await page.waitForTimeout(40);
    }
    await page.waitForFunction(() => document.querySelectorAll('.play-record').length === 180);
  }
  await settle();
  if (mode === 'reopen-bottom') await page.locator('.play-feed').evaluate(feed => { feed.scrollTop = feed.scrollHeight; });
  else {
    const id = mode === 'reopen-loading' ? ids.at(-3) : ids[90];
    await page.locator(`[data-record="${id}"] .play-assistant-meta`).evaluate(node => {
      const feed = document.querySelector('.play-feed');
      feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top + 8;
    });
  }
  await settle();
  const before = await capture();
  assert.equal(before.bottom, mode === 'reopen-bottom', '分别验证中间的段落和底部位置');
  for (let repeat = 0; repeat < 3; repeat++) {
    await button('关闭面板').click();
    await page.locator('#teahouse-panel').waitFor({ state: 'detached' });
    await open(); await settle();
    await page.waitForTimeout(100);
    if (mode === 'reopen-loading' && repeat === 1) {
      await page.evaluate(() => resumeHistoryReads());
      while (await page.locator('#teahouse-panel .play-earlier-bar:visible').count() > 0) {
        await page.locator('#teahouse-panel .play-earlier-bar').click();
        await page.waitForTimeout(40);
      }
      await page.waitForFunction(() => document.querySelectorAll('.play-record').length === 180);
      await settle();
    }
    const after = await capture();
    if (before.bottom) assert.equal(after.bottom, true, '离开时在底部，重新打开仍在底部');
    else {
      assert.equal(after.anchor, before.anchor, `第 ${repeat + 1} 次重开保留同一个阅读段落`);
      assert.ok(Math.abs(after.offset - before.offset) < 2, '重开及补入旧记录后，段落在屏幕上的位置保持不变');
    }
  }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
      for (const mode of ['reopen', 'reopen-loading', 'reopen-bottom', 'anchor', 'states', 'switch', 'favorite']) {
        const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
        await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
        assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        if (mode.startsWith('reopen')) await checkReopen(page, mode);
        else if (mode === 'favorite') await checkFavorite(page); else await checkHistory(page, mode, viewport);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ viewport, mode, passed: true, errors }));
        await context.close();
      }
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
