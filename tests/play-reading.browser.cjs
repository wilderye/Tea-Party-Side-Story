// Browser plugin not available. Use the existing Playwright/Edge workflow.
// Flow: read history or return during continuation -> scroll up -> keep the reading position.
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

function readingPosition(feed) {
  const top = feed.getBoundingClientRect().top;
  const anchor = [...feed.querySelectorAll('[data-read-anchor]')].find(node => node.getClientRects().length && node.getBoundingClientRect().height && node.getBoundingClientRect().bottom > top + 1);
  return { anchor: anchor?.dataset.readAnchor, offset: anchor ? top - anchor.getBoundingClientRect().top : null,
    bottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 12 };
}

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
      if (['slow', 'states', 'switch', 'reopen-loading'].includes(mode) && id === rows.at(-10).id) await gate;
      await new Promise(resolve => setTimeout(resolve, 40)); progress.completed++;
      return structuredClone(records.get(id));
    };
    const ids = rows.map(row => row.id);
    if (['anchor', 'jump', 'automatic'].includes(mode)) localStorage.setItem('teahouse-play-view-v1', JSON.stringify({ format: 1,
      positions: [[original.characterId, { bottom: false, anchor: `${ids[90]}/assistant/head`, offset: 0 }]], selections: [], drafts: [] }));
    return ids;
  }, mode);
}

async function checkHistory(page, mode, viewport) {
  const ids = await seedLongHistory(page, mode);
  await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  const panel = page.locator('#teahouse-panel'), button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
  await button('剧场演出').click();
  const targetId = ['anchor', 'jump', 'automatic'].includes(mode) ? ids[90] : ids.at(-1);
  const target = panel.locator(`[data-record="${targetId}"]`);
  await target.waitFor();
  assert.equal(await page.evaluate(() => progress.started[0]), targetId);
  const firstCount = ['slow', 'states', 'switch'].includes(mode) ? 9 : 10;
  await page.waitForFunction(count => document.querySelectorAll('.play-record:not([hidden])').length === count, firstCount);
  assert.equal(await panel.locator('.play-record:not([hidden])').count(), firstCount, '首屏只读取附近10条，一条慢记录不阻挡其余记录显示');
  assert.equal(await panel.locator('.play-record:not([hidden])').last().locator('.play-message:not([hidden])').last()
    .evaluate(node => getComputedStyle(node).marginBottom), '0px', '加载按钮和隐藏记录不增加末尾消息的留白');
  const headOffset = record => record.locator('.play-assistant-meta').evaluate(node => node.getBoundingClientRect().top - document.querySelector('.play-feed').getBoundingClientRect().top);
  const before = await headOffset(target);
  if (mode === 'anchor') assert.ok(Math.abs(before) < 2, '优先恢复上次读到的消息位置');
  if (mode === 'automatic') {
    for (const [direction, count] of [['earlier', 20], ['later', 30]]) {
      await page.locator('.play-feed').evaluate((feed, direction) => {
        feed.scrollTop = direction === 'earlier' ? 80 : feed.scrollHeight - feed.clientHeight - 80;
      }, direction);
      const position = await page.locator('.play-feed').evaluate(readingPosition);
      await page.waitForFunction(count => document.querySelectorAll('.play-record:not([hidden])').length === count, count);
      const after = await page.locator('.play-feed').evaluate(readingPosition);
      assert.equal(after.anchor, position.anchor, `滚动后自动补入 ${direction} 记录，保留阅读段落`);
      assert.ok(Math.abs(after.offset - position.offset) < 2, `自动补入 ${direction} 记录保留段落位置`);
    }
    return;
  }
  if (mode === 'jump') {
    await button('跳到最新消息').click();
    await panel.locator(`[data-record="${ids.at(-1)}"]`).getByText('第 180 场的正文', { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.play-record:not([hidden])').length === 10);
    await page.waitForFunction(() => {
      const feed = document.querySelector('.play-feed');
      return feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 1;
    });
    assert.equal(await panel.locator('.play-record:not([hidden])').count(), 10, '从旧位置跳到最新消息只显示末尾10条');
    return;
  }
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
    const bId = await page.evaluate(() => seed.b), b = panel.locator(`[data-record="${bId}"]`);
    await b.getByText('乙的旧记录 乙的规则', { exact: true }).waitFor();
    await page.evaluate(() => resumeHistoryReads());
    await page.waitForTimeout(180);
    assert.equal(await panel.locator('.play-record:visible').count(), 1);
    assert.equal(await b.getByText('乙的旧记录 乙的规则', { exact: true }).isVisible(), true, '旧角色读取完成后仍显示新角色及其规则');
    assert.equal(await page.evaluate(() => ctx.characterId), 0, '插件选择角色不切换酒馆主聊天角色');
    assert.equal(await panel.locator('.play-compose').isVisible(), true, '选择其他角色仍可输入小剧场');
    assert.ok(await page.evaluate(() => progress.started.length <= 12), '切换角色后不继续读取上一角色的后续批次');
    return;
  }
  await page.evaluate(() => resumeHistoryReads());
  while (await panel.locator('.play-earlier-bar:visible').count() > 0) {
    await panel.locator('.play-earlier-bar').evaluate(node => node.click());
    await page.waitForTimeout(40);
  }
  while (await panel.locator('.play-later-bar:visible').count() > 0) {
    await panel.locator('.play-later-bar').evaluate(node => node.click());
    await page.waitForTimeout(40);
  }
  await page.waitForFunction(() => document.querySelectorAll('.play-record:not([hidden])').length === 180);
  await page.waitForTimeout(100);
  const prompts = (await panel.locator('.play-record:not([hidden]) .play-user-text').allTextContents()).map(text => text.trim());
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
  const capture = () => page.locator('.play-feed').evaluate(readingPosition);
  await open(); await button('剧场演出').click();
  await page.waitForFunction(count => document.querySelectorAll('.play-record:not([hidden])').length === count, mode === 'reopen-loading' ? 9 : 10);
  if (mode !== 'reopen-loading') {
    await page.evaluate(() => resumeHistoryReads());
    while (await page.locator('#teahouse-panel .play-earlier-bar:visible').count() > 0) {
      await page.locator('#teahouse-panel .play-earlier-bar').evaluate(node => node.click());
      await page.waitForTimeout(40);
    }
    await page.waitForFunction(() => document.querySelectorAll('.play-record:not([hidden])').length === 180);
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
    if (repeat === 2) {
      await button('茶会选集').click(); await button('剧场演出').click(); await settle();
    }
    await button('关闭面板').click();
    await page.locator('#teahouse-panel').waitFor({ state: 'detached' });
    await open(); await settle();
    await page.waitForTimeout(100);
    if (mode === 'reopen-loading' && repeat === 1) {
      await page.evaluate(() => resumeHistoryReads());
      while (await page.locator('#teahouse-panel .play-earlier-bar:visible').count() > 0) {
        await page.locator('#teahouse-panel .play-earlier-bar').evaluate(node => node.click());
        await page.waitForTimeout(40);
      }
      await page.waitForFunction(() => document.querySelectorAll('.play-record:not([hidden])').length === 180);
      await settle();
    }
    const after = await capture();
    if (before.bottom) assert.equal(after.bottom, true, '离开时在底部，重新打开仍在底部');
    else {
      assert.equal(after.anchor, before.anchor, `第 ${repeat + 1} 次重开保留同一个阅读段落`);
      assert.ok(Math.abs(after.offset - before.offset) < 2, `第 ${repeat + 1} 次重开及补入旧记录后，段落在屏幕上的位置保持不变：${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
  }
}

async function checkStreaming(page) {
  await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  await page.locator('#teahouse-panel').getByRole('button', { name: '剧场演出', exact: true }).filter({ visible: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.play-record:not([hidden])').length === 2);
  await page.evaluate(() => { window.streamingTask = runtime.send({ prompt: '大段流式正文的位置验证' }); });
  await page.waitForFunction(() => typeof emitGeneration === 'function' && document.querySelectorAll('.play-record:not([hidden])').length === 3);
  await page.evaluate(() => emitGeneration('第一段流式正文'));
  await page.getByText('第一段流式正文', { exact: true }).waitFor();
  const firstHeight = await page.locator('.play-feed').evaluate(feed => { feed.scrollTop = feed.scrollHeight; return feed.scrollHeight; });
  await page.evaluate(() => {
    window.streamBody = Array.from({ length: 40 }, (_, index) => `流式正文第 ${index} 段。`).join('\n\n');
    emitGeneration(streamBody);
  });
  await page.getByText('流式正文第 39 段。', { exact: true }).waitFor();
  const follow = await page.locator('.play-feed').evaluate(feed => ({ height: feed.scrollHeight, distance: feed.scrollHeight - feed.clientHeight - feed.scrollTop }));
  assert.ok(follow.height - firstHeight > 24);
  assert.ok(follow.distance <= 1, '一次新增超过24像素的流式正文仍跟随到底部');
  const movement = await page.locator('.play-feed').evaluate(async feed => {
    feed.scrollTop = feed.scrollHeight * 0.5;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    feed.scrollTop += 160;
    const requested = feed.scrollTop, added = document.createElement('p');
    added.textContent = '合成尺寸变化'; document.querySelector('.play-feed-content').append(added);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return { requested, actual: feed.scrollTop };
  });
  assert.ok(Math.abs(movement.actual - movement.requested) < 2, '滚动通知尚未到达时发生尺寸变化，不把用户拉回旧位置');
  await page.evaluate(async () => { finishGeneration(streamBody); await streamingTask; });
}

async function checkContinuationPosition(page, mode) {
  const id = await page.evaluate(async () => {
    const round = await runtime.getRound(seed.hidden), result = round.results[0];
    window.continueBase = Array.from({ length: 60 }, (_, index) => `原文第 ${index + 1} 段。阅读位置验证。`).join('\n\n');
    window.continueText = continueBase + '\n\n' + Array.from({ length: 40 }, (_, index) => `续写第 ${index + 1} 段。正在生成的正文。`).join('\n\n');
    await runtime.editResult(round.id, result.id, continueBase, result.text);
    return round.id;
  });
  const panel = page.locator('#teahouse-panel');
  const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const capture = () => page.locator('.play-feed').evaluate(readingPosition);
  await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  await button('剧场演出').click();
  const record = panel.locator(`[data-record="${id}"]`);
  await record.getByRole('button', { name: '续写', exact: true }).click();
  await page.waitForFunction(() => typeof emitGeneration === 'function');
  await page.evaluate(() => emitGeneration(continueText));
  await record.getByText('续写第 40 段。正在生成的正文。', { exact: true }).waitFor();
  await settle();
  if (mode === 'continue-reopen' || mode === 'continue-stop') {
    await button('关闭面板').click();
    await page.locator('#teahouse-panel').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  } else if (mode === 'continue-tab') {
    await button('茶会选集').click();
    await button('剧场演出').click();
  }
  await settle();
  await page.locator('.play-feed').evaluate(feed => { feed.scrollTop = feed.scrollHeight * 0.45; });
  await settle();
  const before = await capture();
  assert.equal(before.bottom, false, '续写期间向上翻阅普通文字');
  if (mode === 'continue-reopen' && process.env.TEA_QA_DIR) {
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `continue-reading-before-${page.viewportSize().width}.png`) });
  }
  await page.evaluate(mode => {
    if (mode === 'continue-stop') runtime.stop();
    else {
      // Complete in the same turn as the final chunk, before its render frame.
      emitGeneration(continueText + '\n\n续写结束标记。');
      finishGeneration(continueText + '\n\n续写结束标记。');
    }
  }, mode);
  await page.waitForFunction(() => runtime.getState().phase === 'idle');
  await settle();
  const after = await capture();
  if (mode === 'continue-reopen' && process.env.TEA_QA_DIR) {
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `continue-reading-after-${page.viewportSize().width}.png`) });
  }
  assert.equal(after.bottom, false, '续写结束或停止后不跳到底部');
  assert.equal(after.anchor, before.anchor, '保持向上翻阅时的同一个段落');
  assert.ok(Math.abs(after.offset - before.offset) < 2, `续写结束后保持段落位置：${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const saved = await page.evaluate(id => runtime.getRound(id), id);
  assert.equal(saved.results[0].status, mode === 'continue-stop' ? 'stopped' : 'complete');
  assert.ok(saved.results[0].text.startsWith(await page.evaluate(() => continueBase)), '保留续写前的正文');
  await button('跳到最新消息').click();
  await settle();
  assert.equal((await capture()).bottom, true, '仍可以主动跳到最新消息');
}

async function checkFavoriteProcessing(page, viewport) {
  const id = await page.evaluate(async () => {
    const round = await runtime.getRound(seed.a), result = round.results.at(-1);
    await runtime.editResult(round.id, result.id, 'A', result.text);
    rules.globalRules.push({ id: 'double-a', scriptName: '合成字母替换', findRegex: 'A', replaceString: 'AA', placement: [2] });
    return round.id;
  });
  await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
  const panel = page.locator('#teahouse-panel'), button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
  await button('剧场演出').click();
  const record = panel.locator(`[data-record="${id}"]`);
  await record.getByText('AA', { exact: true }).waitFor();
  await record.locator('.play-assistant-meta .tea-star').click();
  await page.waitForFunction(async () => (await runtime.listFavorites()).length === 1);
  const saved = await page.evaluate(async () => runtime.getFavorite((await runtime.listFavorites())[0].id));
  assert.equal(saved.text, 'AA'); assert.equal(saved.firstLine, 'AA', '收藏正文与列表文字只经过一次显示规则');
  if (viewport.width <= 760) await button('选择角色').click();
  await page.evaluate(() => { ctx.characters[0].name = '测试甲改名'; window.dispatchEvent(new Event('focus')); });
  await panel.locator('.play-people').getByRole('button', { name: '测试甲改名', exact: true }).waitFor();
  assert.equal(await panel.locator('.play-people').getByRole('button', { name: '测试甲', exact: true }).count(), 0, '复用角色目录时也更新名字');
  if (viewport.width <= 760) await button('返回演出记录').click();
  await button('我的收藏').click(); await button('演出记录').click();
  await panel.locator(`.tea-story[data-id="${saved.id}"]`).getByText('AA', { exact: true }).click();
  const reader = panel.locator('.play-favorite-reading');
  await reader.getByRole('button', { name: '编辑演出记录收藏', exact: true }).click();
  await reader.getByRole('textbox', { name: '收藏内容', exact: true }).fill('AAA');
  await reader.getByRole('button', { name: '保存', exact: true }).click();
  await reader.getByText('AAA', { exact: true }).waitFor();
  const edited = await page.evaluate(id => runtime.getFavorite(id), saved.id);
  assert.equal(edited.text, 'AAA'); assert.equal(edited.firstLine, 'AAA', '修改收藏也不重复处理列表文字');
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
      for (const mode of ['reopen', 'reopen-loading', 'reopen-bottom', 'anchor', 'jump', 'automatic', 'slow', 'states', 'switch', 'favorite', 'favorite-processing', 'stream', 'continue', 'continue-reopen', 'continue-tab', 'continue-stop']) {
        const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
        await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
        assert.equal(await page.title(), '小剧场设置与原文编辑验证');
        if (mode.startsWith('reopen')) await checkReopen(page, mode);
        else if (mode === 'favorite') await checkFavorite(page);
        else if (mode === 'favorite-processing') await checkFavoriteProcessing(page, viewport);
        else if (mode === 'stream') await checkStreaming(page);
        else if (mode.startsWith('continue')) await checkContinuationPosition(page, mode);
        else await checkHistory(page, mode, viewport);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ viewport, mode, passed: true, errors }));
        await context.close();
      }
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
