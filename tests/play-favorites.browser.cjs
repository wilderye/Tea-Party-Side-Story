// Browser plugin not available; use the project's Playwright + Edge workflow.
// Flow: favorite a reply -> add/replace results -> read/edit the independent copy.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness: base } = require('./play-processing.browser.cjs');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = base.replace('<title>小剧场设置与原文编辑验证</title>', '<title>演出记录收藏与重新生成验证</title>')
 .replace('const state={settings,', 'const state=window.fixture={settings,')
 .replace('window.finishGeneration=resolve;', 'window.finishGeneration=resolve;window.failGeneration=reject;')
 .replace('const history=window.testHistory=', 'window.fileReads=[];const history=window.testHistory=')
 .replace('readFile:async name=>files.get(name)??null', 'readFile:async name=>{window.fileReads.push(name);return files.get(name)??null}');
const server = http.createServer(async(request,response)=>{
 try {
  const relative=decodeURIComponent(new URL(request.url,'http://localhost').pathname.slice(1));
  if(!relative){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(harness);}
  if(relative==='favicon.ico'){response.statusCode=204;return response.end();}
  const file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!/\.(js|css|svg)$/.test(file)){response.statusCode=404;return response.end();}
  response.setHeader('Content-Type',relative.endsWith('.css')?'text/css':relative.endsWith('.svg')?'image/svg+xml':'text/javascript');
  response.end(await fs.readFile(file));
 }catch{response.statusCode=404;response.end();}
});
async function screenshot(page,name){
 if(!process.env.TEA_QA_DIR)return;
 await fs.mkdir(process.env.TEA_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEA_QA_DIR,name)});
}

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  for(const viewport of [{width:1332,height:896},{width:390,height:844},{width:320,height:568}]){
   const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
   const url=`http://127.0.0.1:${server.address().port}/`;await page.goto(url);await page.waitForFunction(()=>window.ready);
   assert.equal(await page.title(),'演出记录收藏与重新生成验证');assert.equal(page.url(),url);
   await page.evaluate(()=>fixture.community.set('source-story',{id:'source-story',title:'从选集带来的标题',type:'standalone',body:'源剧场提示词',author:'测试作者',publishedAt:'2026-01-01'}));
   await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
   const panel=page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])'),button=name=>panel.getByRole('button',{name,exact:true}).filter({visible:true});
   assert.equal(await panel.evaluate(node=>node.classList.contains('tea-compact')),true);
   assert.deepEqual(await panel.locator('.tea-tabs:visible button').allTextContents(),['茶会选集','亲笔手稿','我的收藏','剧场演出']);
   const ids=await page.evaluate(()=>window.seed);
   await button('剧场演出').click();
   const record=panel.locator(`[data-record="${ids.a}"]`);
   await record.locator('.play-count').waitFor();
   assert.equal(await record.locator('.play-count').innerText(),'1\n/ 1');
   assert.equal(await record.locator('.play-count svg').isVisible(),true,'只有一份结果也显示历史选择下箭头');
   await record.locator('.play-count').click();
   assert.equal(await panel.getByRole('listbox',{name:'生成结果',exact:true}).getByRole('option').count(),1);
   await page.keyboard.press('Escape');
   assert.equal(await panel.isVisible(),true,'关闭结果列表不会关闭整个面板');
   const original=await page.evaluate(id=>runtime.getRound(id),ids.a);
   await record.getByRole('button',{name:'收藏演出记录',exact:true}).click();
   await page.waitForFunction(async()=> (await runtime.listFavorites()).length===1);
   const originalFavorite = await page.evaluate(async () => runtime.getFavorite((await runtime.listFavorites())[0].id));
   assert.ok(originalFavorite.text.includes('全局已处理 甲的规则'));
   assert.doesNotMatch(originalFavorite.text, /默认隐藏的思考|默认隐藏状态|默认隐藏更新/);
   assert.equal(await record.getByRole('button',{name:'取消收藏',exact:true}).getAttribute('aria-pressed'),'true');
   assert.equal(await page.evaluate(()=>captured.length),0);
   async function generate(control,text){
    await control.click();await page.waitForFunction(()=>runtime.getState().phase==='generating');
    const job=await page.evaluate(()=>runtime.getState());
    await page.evaluate(text=>{emitGeneration(text);finishGeneration(text)},text);
    await page.waitForFunction(()=>runtime.getState().phase==='idle');
    await page.waitForFunction(id=>document.querySelector(`[data-play-result="${id}"]`)?.dataset.status==='complete',job.resultId);
    return job;
   }
   const second=await generate(record.getByRole('button',{name:'生成新剧场',exact:true}),'<content>第二份结果</content>');
   assert.equal(await record.locator('.play-count').innerText(),'2\n/ 2');
   await record.locator('.play-count').click();
   const results=panel.getByRole('listbox',{name:'生成结果',exact:true});
   assert.equal(await results.getByRole('option').count(),2);
   const menuBox=await results.boundingBox(),panelBox=await panel.boundingBox();
   assert.ok(menuBox.x>=panelBox.x&&menuBox.x+menuBox.width<=panelBox.x+panelBox.width+1,'列表不超出面板左右边缘');
   assert.ok(menuBox.y>=panelBox.y&&menuBox.y+menuBox.height<=panelBox.y+panelBox.height+1,'列表不超出面板上下边缘');
   if(viewport.width<=760){
    const replyBox=await record.locator('.play-results').boundingBox();
    assert.ok(Math.abs(menuBox.x-replyBox.x)<1,'手机历史列表左边缘对齐正文');
    assert.ok(Math.abs(menuBox.x+menuBox.width-replyBox.x-replyBox.width)<1,'手机历史列表右边缘对齐正文');
   }
   await results.getByRole('option').first().click();
   assert.equal(await record.locator('.play-count').innerText(),'1\n/ 2');
   await record.getByRole('button',{name:'下一个结果',exact:true}).click();
   await record.getByRole('button',{name:'收藏演出记录',exact:true}).click();
   await page.waitForFunction(async()=> (await runtime.listFavorites()).length===2);
   await record.getByRole('button',{name:'上一个结果',exact:true}).click();
   const replacement=await generate(record.getByRole('button',{name:'重新生成',exact:true}),'<content>替换第一份结果</content>');
   const replaced=await page.evaluate(id=>runtime.getRound(id),ids.a);
   assert.deepEqual(replaced.results.map(result=>result.id),[replacement.resultId,second.resultId]);
   assert.equal(await record.locator('.play-count').innerText(),'1\n/ 2');
   const snapshot=await page.evaluate(async source=>{const rows=await runtime.listFavorites();return runtime.getFavorite(rows.find(row=>row.source.resultId===source).id)},original.results[0].id);
   assert.equal(snapshot.text,originalFavorite.text);
   await record.getByRole('button',{name:'重新生成',exact:true}).click();await page.waitForFunction(()=>runtime.getState().phase==='generating');
   await page.evaluate(()=>{emitGeneration('失败时收到的片段');failGeneration(new Error('模拟接口失败'))});
   await page.waitForFunction(()=>runtime.getState().phase==='idle');await record.getByText('模拟接口失败',{exact:true}).waitFor();
   assert.equal((await page.evaluate(id=>runtime.getRound(id),ids.a)).results.length,2);
   await record.getByRole('button',{name:'重新生成',exact:true}).click();await page.waitForFunction(()=>runtime.getState().phase==='generating');
   await page.evaluate(()=>emitGeneration('停止时收到的片段'));await button('停止所有生成').click();
   await page.waitForFunction(()=>runtime.getState().phase==='idle');
   await record.getByRole('button',{name:'编辑回复原文',exact:true}).waitFor();
   const stopped=(await page.evaluate(id=>runtime.getRound(id),ids.a)).results[0];
   assert.equal(stopped.status,'stopped');assert.equal(stopped.text,'停止时收到的片段');
   assert.equal(await record.locator('.play-result-status').count(),0,'不在底部重复生成或停止状态');

   await button('茶会选集').click();await button('在插件中游玩').click();
   assert.equal(await panel.locator('.play-compose-context').isVisible(),false,'填入选集内容不增加已填入提示和撤回按钮');
   const generated=await generate(button('发送小剧场'),'<thinking>来源思考</thinking>\n<content>选集生成的原文</content>');
   const sourceRecord=panel.locator(`[data-record="${generated.roundId}"]`);
   await sourceRecord.getByRole('button',{name:'收藏演出记录',exact:true}).click();
   await page.waitForFunction(async()=> (await runtime.listFavorites()).length===3);
   await button('我的收藏').click();
   assert.deepEqual(await panel.getByRole('navigation',{name:'收藏分类'}).locator('button').allTextContents(),['独立剧场','随文剧场','演出记录']);
   assert.equal(await panel.locator('.tea-list-heading:visible').count(),0);
   await button('演出记录').click();await panel.locator('.tea-story').first().waitFor();
   if(viewport.width<=760)await button('搜索剧场').click();
   let search=panel.getByRole('searchbox',{name:'搜索标题或角色名字',exact:true});
   await search.focus();await page.keyboard.type('测试甲');
   assert.equal(await search.inputValue(),'测试甲');assert.equal(await search.evaluate(node=>document.activeElement===node),true,'连续输入保持在当前收藏搜索框');
   await search.fill('');if(viewport.width<=760)await button('取消搜索').click();
   await panel.locator('.tea-story').filter({hasText:'从选集带来的标题'}).click();
   const reader=panel.locator('.play-favorite-reading:visible');
   await reader.getByText('选集生成的原文',{exact:true}).waitFor();
   assert.equal(await reader.locator('.play-favorite-character').innerText(),'测试甲');
   await reader.getByRole('button',{name:'编辑演出记录收藏',exact:true}).click();
   assert.equal(await reader.locator('.play-favorite-character').isVisible(),false,'编辑收藏时隐藏角色名');
   assert.equal(await reader.getByRole('textbox',{name:'收藏标题',exact:true}).inputValue(),'从选集带来的标题');
   const favoriteText='第一行正文超过目录能显示的字数所以末尾应该截断并显示三个英文点点点\n<thinking>收藏中手写的标签内容</thinking>\n第二行不能进入标题';
   await reader.getByRole('textbox',{name:'收藏标题',exact:true}).fill('');
   await reader.getByRole('textbox',{name:'收藏内容',exact:true}).fill(favoriteText);
   for(const label of ['保存','取消'])assert.equal(await reader.getByRole('button',{name:label,exact:true}).textContent(),'');
   const colors=await reader.getByRole('textbox',{name:'收藏内容',exact:true}).evaluate(node=>({border:getComputedStyle(node).borderWidth,outline:getComputedStyle(node).outlineStyle,bg:getComputedStyle(node).backgroundColor,width:node.getBoundingClientRect().width,message:node.closest('.play-message').getBoundingClientRect().width}));
   assert.equal(colors.border,'0px');assert.equal(colors.outline,'none');assert.equal(colors.bg,'rgb(215, 223, 212)');assert.ok(Math.abs(colors.width-colors.message)<1);
   const titleBox=await reader.getByRole('textbox',{name:'收藏标题',exact:true}).boundingBox();
   const textBox=await reader.getByRole('textbox',{name:'收藏内容',exact:true}).boundingBox(),readerBox=await reader.boundingBox();
   assert.ok(Math.abs(titleBox.x-textBox.x)<1&&Math.abs(titleBox.width-textBox.width)<1,'收藏标题和正文使用同一整行宽度');
   assert.ok(Math.abs(textBox.y-titleBox.y-titleBox.height-12)<1,'标题与正文之间留出 12 像素页面底色');
   const unusedSpace=readerBox.y+readerBox.height-textBox.y-textBox.height;
   assert.ok(unusedSpace>=12&&unusedSpace<=28,'收藏编辑区用到阅读区底部，只有正常边距');
   assert.ok(await reader.evaluate(node=>node.scrollHeight-node.clientHeight<=1),'收藏编辑只有正文内部滚动');
   await screenshot(page,`${viewport.width}-favorite-edit.png`);
   await reader.getByRole('button',{name:'保存',exact:true}).click();
   await reader.getByRole('button',{name:'编辑演出记录收藏',exact:true}).waitFor();
   const saved=await page.evaluate(async id=>{const rows=await runtime.listFavorites();return runtime.getFavorite(rows.find(row=>row.source.roundId===id).id)},generated.roundId);
   assert.equal(saved.title,'');assert.equal(saved.text,favoriteText);assert.equal(saved.firstLine.includes('第二行'),false);
   assert.equal(await reader.locator('.play-favorite-character').isVisible(),true,'保存后阅读状态恢复角色名');
   assert.equal((await page.evaluate(id=>runtime.getRound(id),generated.roundId)).results[0].text,'<thinking>来源思考</thinking>\n<content>选集生成的原文</content>');
   assert.equal(await reader.locator('.play-favorite-title').isVisible(),false,'空标题不在正文上方重复第一行');
   assert.ok((await panel.locator(`.tea-story[data-id="${saved.id}"] .tea-story-title`).textContent()).endsWith('...'));
   await reader.getByRole('button',{name:'编辑演出记录收藏',exact:true}).click();
   await reader.getByRole('textbox',{name:'收藏标题',exact:true}).fill('失败后保留草稿');
   await page.evaluate(()=>window.failSave=true);await reader.getByRole('button',{name:'保存',exact:true}).click();
   await reader.getByRole('alert').waitFor();assert.equal(await reader.getByRole('textbox',{name:'收藏标题',exact:true}).inputValue(),'失败后保留草稿');
   await button('设置').click();await button(viewport.width<=760?'返回列表':'设置').click();
   assert.equal(await reader.getByRole('textbox',{name:'收藏标题',exact:true}).inputValue(),'失败后保留草稿');
   await reader.getByRole('button',{name:'取消',exact:true}).click();await page.evaluate(()=>window.failSave=false);
   assert.equal(await reader.locator('.play-favorite-character').isVisible(),true,'取消后阅读状态恢复角色名');
   if(viewport.width<=760)await button('返回收藏目录').click();
   await screenshot(page,`${viewport.width}-favorite-list.png`);
   const overflow=await panel.evaluate(node=>node.scrollWidth-node.clientWidth);assert.ok(overflow<=1,'收藏列表无横向溢出');
   if(viewport.width<=760){
    await button('剧场演出').click();await button('选择角色').click();
    const xs=await panel.evaluate(root=>['.play-character-heading svg','.play-character-search svg'].map(s=>root.querySelector(s).getBoundingClientRect().left));
    assert.ok(Math.abs(xs[0]-xs[1])<1,'返回箭头与搜索图标对齐');
   }
   await page.reload();await page.waitForFunction(()=>window.ready);await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
   await button('我的收藏').click();await button('演出记录').click();await panel.locator('.tea-story').first().waitFor();
   await panel.locator('.tea-story').first().click();
   await reader.getByRole('button',{name:'编辑演出记录收藏',exact:true}).waitFor();
   await reader.getByRole('button',{name:'编辑演出记录收藏',exact:true}).click();
   assert.equal(await reader.getByRole('textbox',{name:'收藏标题',exact:true}).inputValue(),'');
   assert.equal(await reader.getByRole('textbox',{name:'收藏内容',exact:true}).inputValue(),favoriteText);
   await reader.getByRole('button',{name:'取消',exact:true}).click();
   await reader.getByRole('button',{name:'取消收藏',exact:true}).click();
   await page.waitForFunction(async()=> (await runtime.listFavorites()).length===2);
   assert.deepEqual(errors,[]);
   console.log(JSON.stringify({viewport,checks:'分类、独立收藏、空标题编辑、失败保存、设置返回、追加和替换、失败与停止、刷新恢复、图标和手机对齐',errors}));
   await context.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
