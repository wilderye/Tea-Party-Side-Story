// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
const files = new Map();
let hold = null, entered = null, activeWrites = 0, maxWrites = 0;
const harness = `<!doctype html><meta charset="utf-8"><title>剧场演出回归验证</title>
<link rel="stylesheet" href="/style.css"><style>#teahouse-panel{display:block;height:auto;padding:20px;box-sizing:border-box}body{margin:0}</style>
<h1>剧场演出回归验证</h1><button id="render">显示网页回复</button><div id="teahouse-panel"><div id="output"></div></div>
<script type="module">
import { createPlayRuntime } from '/play-runtime.js';
import { renderPlayText } from '/play-render.js';
const ctx = { mainApi:'openai', characterId:0, name1:'你', name2:'角色',
 characters:[{avatar:'A.png',name:'角色'}], chat:[{name:'角色',mes:'原聊天',is_user:false,extra:{}}],
 chatCompletionSettings:{preset_settings:'测试预设'}, getCurrentChatId:()=>'test-chat',
 uuidv4:()=>{const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;const hex=[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20)},
 getRequestHeaders:()=>({'Content-Type':'application/json','X-CSRF-Token':'play-test'}),eventTypes:{},eventSource:{on(){}} };
window.requestCount = 0;
window.runtime = createPlayRuntime(()=>ctx,{enabled:true},undefined,{prepareRequest:async()=>({send:async args=> {
 window.requestCount++; return window.reply ? window.reply(args) : '模拟回复';
}})});
window.renderText = (text, renderHtml = true) => renderPlayText(document.getElementById('output'),text,'test',renderHtml,true);
document.getElementById('render').onclick=()=>window.renderText('<!doctype html><html><head><style>body{min-height:100vh}</style></head><body><p>网页回复正文</p><button id="expand">展开更多</button><div id="more"></div><script>document.getElementById("expand").onclick=()=>{document.getElementById("more").innerHTML="<p>更多内容</p>".repeat(40)};<'+ '/script></body></html>');
</script>`;
const allowed = new Set(['play-chat-favorites.js', 'style.css', 'play-runtime.js', 'playground.js', 'play-history.js', 'play-storage.js', 'diagnostics.js',
  'play-storage-worker.js', 'play-storage-lock.js', 'play-prompt.js', 'play-task-module.js', 'play-template-context.js','play-variable-context.js', 'play-preparation.js', 'play-preset.js', 'play-parameters.js', 'play-request.js',
  'play-render.js', 'play-settings.js', 'play-processing.js', 'ui.js', 'markdown.js', 'vendor/markdown-it.js']);
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://test'), file = url.pathname.slice(1);
    if (!file) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
    if (file === 'favicon.ico') { response.statusCode = 204; return response.end(); }
    if (allowed.has(file)) { response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); return response.end(await fs.readFile(path.join(root, file))); }
    if (file.startsWith('user/files/')) {
      const value = files.get(file.slice('user/files/'.length));
      response.statusCode = value === undefined ? 404 : 200; return response.end(value ?? 'missing');
    }
    if (file === 'api/files/upload' || file === 'api/files/delete') {
      assert.equal(request.headers['x-csrf-token'], 'play-test', '共享任务保留本次请求的认证头');
      let body = ''; for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      activeWrites++; maxWrites = Math.max(maxWrites, activeWrites);
      if (file === 'api/files/upload') {
        const wait = hold; hold = null; entered?.resolve(); entered = null;
        if (wait) await wait.promise;
        await new Promise(resolve => setTimeout(resolve, 15));
        files.set(data.name, Buffer.from(data.data, 'base64').toString('utf8'));
      } else files.delete(data.path.replace('user/files/', ''));
      activeWrites--; response.setHeader('Content-Type', 'application/json'); return response.end('{}');
    }
    response.statusCode = 404; response.end();
  } catch (error) { console.error(error); response.statusCode = 500; response.end('test server error'); }
});

async function verifyHtmlOutputs(page, host, viewport) {
  const card = '<style>body{margin:0;padding:16px;font:16px/1.7 sans-serif;background:#faf8f2}.scene{border:1px solid #b8c9bd;padding:20px;border-radius:12px}button{font:inherit;padding:8px 16px}</style>\n\n'
    + '<section class="scene"><h2>雨夜小剧场</h2><p id="story">角色推开了茶馆的门。</p><button id="next">展开后续</button><div id="ending"></div></section>\n\n'
    + '<script>document.getElementById("next").onclick=()=>{document.getElementById("ending").textContent="炉上的茶水恰好沸腾。"};</script>';
  for (const prefix of ['', '<thinking>思考内容仍然保留</thinking>\n', '<thinking>\n思考内容仍然保留\n</thinking>\n']) {
    await page.evaluate(text => window.renderText(text), prefix + card);
    assert.equal(await page.locator('iframe').count(), 1, '裸样式、正文和脚本共用一个网页，空行不会拆散网页');
    const frame = page.frameLocator('iframe');
    await frame.getByRole('heading', {name:'雨夜小剧场'}).waitFor();
    assert.equal(await frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(250, 248, 242)');
    if (prefix) assert.ok((await page.locator('.play-prose').innerText()).includes('思考内容仍然保留'), '思维链保留在网页之前，未应用清理规则');
    await frame.getByRole('button', {name:'展开后续'}).click();
    await frame.getByText('炉上的茶水恰好沸腾。', {exact:true}).waitFor();
    const contentHeight = await frame.locator('.scene').evaluate(node =>
      Math.ceil(node.getBoundingClientRect().bottom + parseFloat(getComputedStyle(document.body).paddingBottom)));
    await page.waitForFunction(height => document.querySelector('iframe')?.clientHeight >= height, contentHeight);
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts', '网页权限保持原状');
  }
  if (process.env.TEA_QA_DIR && host === '127.0.0.1') {
    await fs.mkdir(process.env.TEA_QA_DIR, {recursive:true});
    await page.frameLocator('iframe').locator('body').evaluate(() =>
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({path:path.join(process.env.TEA_QA_DIR, `html-fragment-${viewport.width}.png`), fullPage:true});
  }

  const wrapped = '<content><regard>' + card + '<script>document.body.dataset.template="<content>";</script></regard></content>';
  await page.evaluate(text => window.renderText(runtime.display.process(text)), wrapped);
  assert.equal(await page.locator('iframe').count(), 1, '隐藏正文标签后仍显示完整网页');
  assert.doesNotMatch(await page.locator('#output').innerText(), /<\/?(?:content|regard)>/);
  const wrappedFrame = page.frameLocator('iframe');
  await wrappedFrame.getByRole('button', {name:'展开后续'}).click();
  await wrappedFrame.getByText('炉上的茶水恰好沸腾。', {exact:true}).waitFor();
  assert.equal(await wrappedFrame.locator('body').getAttribute('data-template'), '<content>', '脚本内的同名字符串不被显示处理改写');
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');

  const document = '<!doctype html><html><body><div>完整网页正文</div></body></html>';
  for (const prefix of ['说明文字\n', '<thinking>思考内容仍然保留</thinking>\n', '说明文字 ']) {
    await page.evaluate(text => window.renderText(text), prefix + document);
    assert.equal(await page.locator('iframe').count(), 1, '完整网页前面有其他文字也能识别');
    await page.frameLocator('iframe').getByText('完整网页正文', {exact:true}).waitFor();
    assert.ok((await page.locator('#output').innerText() + await page.frameLocator('iframe').locator('body').innerText())
      .includes(prefix.includes('thinking') ? '思考内容仍然保留' : '说明文字'), '前缀内容未被删除');
  }
  await page.evaluate(text => window.renderText(text), '<thinking>思考内容仍然保留</thinking><div>同一行的网页正文</div>');
  await page.frameLocator('iframe').getByText('同一行的网页正文', {exact:true}).waitFor();
  assert.ok((await page.frameLocator('iframe').locator('body').innerText()).includes('思考内容仍然保留'));

  const proseCases = [
    '普通正文\n\n- 第一项\n- 第二项',
    '<thinking>\n仅有思考标签，仍按文字显示\n</thinking>',
    '请使用 `<div>代码示例</div>`，不要执行。',
    '```text\n<style>body{display:none}</style><div>代码示例</div>\n```',
    '    <div>缩进代码示例</div>',
    '<!-- 这里只是提到 <div> 的注释 -->',
  ];
  for (const text of proseCases) {
    await page.evaluate(source => window.renderText(source), text);
    assert.equal(await page.locator('iframe').count(), 0, '普通文字、思考标签和代码示例不会被误当网页');
  }
  for (const renderHtml of [false, true]) {
    await page.evaluate(enabled => window.renderText('<q>“__对白中的下划线__。”</q> <u>标签下划线</u>', enabled), renderHtml);
    assert.equal(await page.locator('iframe').count(), 0, '正文格式标签不会变成独立网页');
    assert.equal(await page.locator('.play-prose q').count(), 1, '生成中和完成后的对白格式一致');
    assert.equal(await page.locator('.play-prose u').count(), 2, '两种下划线写法均生效');
    assert.equal(await page.locator('.play-prose').innerText(), '“对白中的下划线。” 标签下划线');
  }
  await page.evaluate(text => window.renderText(text, false), card);
  assert.equal(await page.locator('iframe').count(), 0, '生成过程中仍只显示文字');

  const mixed = '前言\n\n```html\n<div>第一个网页</div>\n```\n\n```text\n<div>代码示例</div>\n```\n\n<style>div{color:rgb(12,34,56)}</style>\n<div>第二个网页</div>';
  await page.evaluate(text => window.renderText(text), mixed);
  assert.equal(await page.locator('iframe').count(), 2, '原有 HTML 代码块和裸网页可以一起显示');
  await page.frameLocator('iframe').nth(0).getByText('第一个网页', {exact:true}).waitFor();
  await page.frameLocator('iframe').nth(1).getByText('第二个网页', {exact:true}).waitFor();
  assert.equal(await page.locator('pre code').innerText(), '<div>代码示例</div>\n');
}

async function browserCapabilities(page, mode) {
  if (mode === 'native') return;
  await page.addInitScript(mode => {
    if (mode === 'missing') {
      Object.defineProperty(window, 'SharedWorker', { configurable:true, value:undefined });
    } else {
      window.SharedWorker = class {
        constructor() {
          if (mode === 'constructor-fails') throw new DOMException('Worker unavailable', 'SecurityError');
          const channel = new MessageChannel(); this.port = channel.port1;
          if (mode === 'load-fails') queueMicrotask(() => this.onerror?.({ preventDefault() {} }));
        }
      };
    }
  }, mode);
}

async function verifyExpiredWriter(page) {
  const result = await page.evaluate(async () => {
    const { createHistoryLock, HISTORY_FILE_TIMEOUT } = await import('/play-storage-lock.js');
    let timestamp = Date.now(), releaseOld, releaseNew, oldEntered, newEntered, oldError, thirdEntered = false;
    const enteredOld = new Promise(resolve => oldEntered = resolve), enteredNew = new Promise(resolve => newEntered = resolve);
    const oldGate = new Promise(resolve => releaseOld = resolve), newGate = new Promise(resolve => releaseNew = resolve);
    const lock = () => createHistoryLock({ now: () => timestamp, pollMs: 5 });
    const old = lock()(async check => { oldEntered(); await oldGate; await check(); }).catch(error => oldError = error.code);
    await enteredOld; timestamp += HISTORY_FILE_TIMEOUT * 2 + 1;
    const current = lock()(async check => { await check(); newEntered(); await newGate; });
    await enteredNew; releaseOld(); await old;
    const third = lock()(async () => { thirdEntered = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    const retainedNewLock = !thirdEntered;
    releaseNew(); await Promise.all([current, third]);
    return { oldError, retainedNewLock, thirdEntered };
  });
  assert.deepEqual(result, { oldError:'history_save_interrupted', retainedNewLock:true, thirdEntered:true },
    '暂停太久的页面不能继续写入，也不能释放新页面持有的锁');
}

(async () => {
  await new Promise(resolve => server.listen(0, process.env.TEA_HTTP_HOST ? '0.0.0.0' : '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel:'msedge', headless:true,
    args:['--host-resolver-rules=MAP tea.test 127.0.0.1', '--no-proxy-server'] });
  try {
    const httpHost = process.env.TEA_HTTP_HOST || 'tea.test';
    for (const scenario of [
      {host:'127.0.0.1', mode:'native'}, {host:httpHost, mode:'native'},
      {host:httpHost, mode:'missing'}, {host:httpHost, mode:'constructor-fails'},
      {host:httpHost, mode:'load-fails'}, {host:httpHost, mode:'no-ready'},
      {host:httpHost, mode:'mixed'},
    ]) {
      const {host, mode} = scenario;
      files.clear(); maxWrites = 0;
      const context = await browser.newContext();
      const a = await context.newPage(), b = await context.newPage(), errors = [];
      await browserCapabilities(a, mode === 'mixed' ? 'missing' : mode);
      await browserCapabilities(b, mode === 'mixed' ? 'native' : mode);
      let expectedMissingIndexLogs = 0;
      for (const page of [a, b]) {
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
          if (!['error','warning'].includes(message.type())) return;
          const text = message.text(), url = message.location().url;
          // A new history intentionally has no index file until its first save.
          if (text.includes('404') && url.endsWith('/user/files/teahouse-play-index.json')) { expectedMissingIndexLogs++; return; }
          errors.push(`${text} (${url})`);
        });
      }
      const url = `http://${host}:${server.address().port}/`;
      await Promise.all([a.goto(url), b.goto(url)]);
      await Promise.all([a.waitForFunction(()=>!!window.runtime), b.waitForFunction(()=>!!window.runtime)]);
      assert.equal(await b.title(), '剧场演出回归验证');
      await b.getByRole('heading', {name:'剧场演出回归验证'}).waitFor();
      const capabilities = await a.evaluate(()=>({ secure:isSecureContext, locks:!!navigator.locks,
        sharedWorker:typeof SharedWorker, indexedDB:typeof indexedDB, uuid:typeof crypto.randomUUID }));
      assert.equal(capabilities.locks, host === '127.0.0.1');
      assert.deepEqual(await a.evaluate(()=>runtime.listCharacters()), [], '空历史可以直接读取，无需启动保存服务');
      assert.deepEqual(await a.evaluate(()=>runtime.listFavorites()), []);
      const results = await Promise.all([a.evaluate(()=>runtime.send({prompt:'页面一'})), b.evaluate(()=>runtime.send({prompt:'页面二'}))]);
      assert.equal(JSON.parse(files.get('teahouse-play-index.json')).rounds.length, 2);
      assert.equal(maxWrites, 1, '两个页面的完整读写事务按顺序执行');
      const round = await b.evaluate(id=>runtime.getRound(id), results[0].roundId);
      assert.equal(round.results[0].text, '模拟回复');
      await b.evaluate(({roundId, resultId}) => runtime.editResult(roundId, resultId, '通过历史保存接口编辑后的正文', '模拟回复'),
        {roundId:round.id, resultId:round.results[0].id});
      assert.equal((await a.evaluate(id=>runtime.getRound(id),round.id)).results[0].text, '通过历史保存接口编辑后的正文', '页面与共享后台任务都支持编辑历史正文');
      await b.evaluate(({id,prompt}) => runtime.editPrompt(id, '原位置保存的用户消息', prompt), round);
      const promptEdited = await a.evaluate(id=>runtime.getRound(id),round.id);
      assert.equal(promptEdited.prompt, '原位置保存的用户消息', '页面、共享后台任务和兼容保存入口都支持修改用户消息');
      assert.equal(promptEdited.results[0].text, '通过历史保存接口编辑后的正文');
      assert.equal((await a.evaluate(()=>runtime.availability())).available, true);

      const favorite = await a.evaluate(({id,result}) => runtime.addFavorite({roundId:id,resultId:result.id,startedAt:result.startedAt,
        expectedText:'通过历史保存接口编辑后的正文',firstLine:'通过历史保存接口编辑后的正文'}), {id:round.id,result:round.results[0]});
      const editedFavorite = await b.evaluate(item => runtime.editFavorite(item.id,
        {title:'',text:'单独修改的收藏正文',firstLine:'单独修改的收藏正文'},item.revision), favorite);
      assert.equal((await a.evaluate(id=>runtime.getFavorite(id),favorite.id)).text,editedFavorite.text);
      await b.evaluate(({roundId,resultId})=>runtime.regenerate(roundId,resultId),{roundId:round.id,resultId:round.results[0].id});
      assert.equal((await a.evaluate(id=>runtime.getRound(id),round.id)).results.length,1,'两个保存入口都支持原位替换');
      assert.equal((await a.evaluate(id=>runtime.getFavorite(id),favorite.id)).text,'单独修改的收藏正文','重新生成不改收藏');
      assert.equal((await a.evaluate(()=>runtime.listFavorites())).length,1);
      await b.evaluate(id=>runtime.removeFavorite(id),favorite.id);
      assert.equal((await a.evaluate(()=>runtime.listFavorites())).length,0);

      const beforeCancel = [...files];
      await a.evaluate(async () => {
        let acquired;
        const ready = new Promise(resolve => acquired = resolve);
        const gate = new Promise(resolve => window.releaseStopTest = resolve);
        const { createHistoryLock } = await import('/play-storage-lock.js');
        const lock = navigator.locks?.request ? run => navigator.locks.request('teahouse-play-history', run) : createHistoryLock();
        window.stopTestHolder = lock(async () => { acquired(); await gate; });
        await ready;
      });
      const requestsBeforeCancel = await b.evaluate(() => window.requestCount);
      await b.evaluate(() => { window.cancelledSend = runtime.send({ prompt:'等待保存时停止，不应创建记录' }); });
      await b.waitForFunction(() => runtime.getState().phase === 'preparing');
      await b.waitForTimeout(150);
      assert.equal(await b.evaluate(() => runtime.stop()), true);
      await b.waitForFunction(() => runtime.getState().phase === 'idle', null, { timeout:1500 });
      assert.equal(await b.evaluate(() => window.cancelledSend), null, '取消无需等其他页面释放保存资格');
      assert.equal(await b.evaluate(() => window.requestCount), requestsBeforeCancel);
      await a.evaluate(async () => { window.releaseStopTest(); await window.stopTestHolder; });
      await b.waitForTimeout(250);
      assert.deepEqual([...files], beforeCancel, '队列恢复后也不补写已取消的记录');

      await a.reload(); await a.waitForFunction(()=>!!window.runtime);
      assert.equal((await a.evaluate(id=>runtime.getRound(id),round.id)).results[0].text, '模拟回复', '重新打开读取电脑上保存的结果');
      if (['native', 'missing'].includes(mode)) for (const viewport of [{width:1332,height:896},{width:390,height:844}]) {
        await b.setViewportSize(viewport);
        await b.locator('#render').click();
        await b.locator('iframe').waitFor();
        const iframe = b.locator('iframe'), content = b.frameLocator('iframe');
        await content.getByText('网页回复正文',{exact:true}).waitFor();
        await b.waitForTimeout(120);
        const heights = [];
        for (let i=0;i<4;i++) { await b.waitForTimeout(80); heights.push(await iframe.evaluate(node=>node.clientHeight)); }
        assert.ok(Math.max(...heights)-Math.min(...heights)<=1, '网页高度不随窗口高度样式不断增长');
        assert.ok(heights[0]<400, '短网页不被撑出大量空白');
        await content.getByRole('button',{name:'展开更多'}).click();
        await b.waitForTimeout(150);
        const expanded = await iframe.evaluate(node=>node.clientHeight);
        assert.ok(expanded>heights[0]+300,'交互新增内容仍会扩展高度');
        await b.waitForTimeout(200);
        assert.ok(Math.abs(await iframe.evaluate(node=>node.clientHeight)-expanded)<=1,'新增内容之后高度也能稳定');
        await verifyHtmlOutputs(b, host, viewport);
      }
      if (host === httpHost && mode === 'native') {
        entered = deferred(); const observed = entered.promise, gate = hold = deferred();
        const closing = a.evaluate(()=>runtime.send({prompt:'保存期间关闭页面'})).catch(()=>null);
        await observed;
        const other = b.evaluate(()=>runtime.send({prompt:'另一页继续发送'}));
        await a.close(); gate.resolve(); await Promise.all([closing,other]);
        assert.equal(JSON.parse(files.get('teahouse-play-index.json')).rounds.length,4,'关闭页面不打断共享任务中已开始的保存');
      }
      if (mode === 'missing') await verifyExpiredWriter(b);
      await b.evaluate(id=>runtime.generateAnother(id),round.id);
      const messages = await b.evaluate(id=>runtime.getRound(id),round.id);
      assert.equal(messages.results.length,2);
      const withoutReply = await b.evaluate(({id,results})=>runtime.removeReply(id,results),messages);
      assert.deepEqual(withoutReply.results,[],'页面、共享后台及兼容入口都删除 AI 消息的全部版本');
      const reader = a.isClosed() ? b : a;
      assert.deepEqual((await reader.evaluate(id=>runtime.getRound(id),round.id)).results,[]);
      const empty = await b.evaluate(({id,prompt})=>runtime.removePrompt(id,prompt),withoutReply);
      assert.equal(empty.prompt,null); assert.deepEqual(empty.results,[]);
      assert.equal((await b.evaluate(id=>runtime.listChats(id),round.characterId)).some(row=>row.id===round.id),true,
        '消息清空后仍保留历史聊天');
      assert.equal((await reader.evaluate(id=>runtime.listRounds(id),round.characterId)).some(row=>row.id===round.id),false,
        '删除用户消息后，两条消息都已移除的记录不会在其他窗口恢复');
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({host,mode,capabilities,checks:'并发保存、跨页读取和编辑收藏、原位重新生成、刷新恢复、独立删除用户消息与全部回复版本；等待时停止且不补写、原通道关闭页面、手机兼容、后台任务初始化失败、混合通道、过期保存者隔离',expectedMissingIndexLogs,errors}));
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
