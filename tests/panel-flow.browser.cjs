// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const harness = `<!doctype html><meta charset="utf-8"><title>茶话会操作回归</title>
<!-- Relevant SillyTavern popup rules, including the cached Safari compatibility flag. -->
<style>
.popup{display:flex;flex-direction:column;min-height:fit-content;max-height:calc(100dvh - 2em)}
.popup .popup-body{display:flex;flex-direction:column;overflow:hidden;width:min(100%,100vw);height:100%;padding:1px}
.popup:not(:has(.img_enlarged_container)) .popup-body{max-height:95dvh}
.popup .popup-content{margin-top:10px;padding:0 8px;overflow:hidden;flex-grow:1}
body.safari .popup .popup-body{height:fit-content;max-height:90dvh}
</style>
<link rel="stylesheet" href="/style.css"><style>body{margin:0}dialog{border:0;padding:0}button,input,textarea,select{font:inherit}button{cursor:pointer}*{box-sizing:border-box}</style>
<textarea id="send_textarea" aria-label="模拟酒馆输入框"></textarea>
<script type="module">
import {createTheatrePanel} from '/panel.js';
const manuscripts = new Map(Array.from({length:20},(_,i)=>{
 const id='local:'+String(i).padStart(32,'0');
 return [id,{id,title:'查找手稿 '+i,type:'standalone',body:'保留关键词。'+('正文内容。'.repeat(200)),publishedAt:new Date(2026,0,20-i).toISOString()}];
}));
const state=window.fixture={settings:{enabled:true,pageSize:5,favorites:Object.fromEntries([...manuscripts.keys()].map((id,i)=>[id,100-i]))},manuscripts,community:new Map(),status:'',personalError:'',get entries(){return new Map([...this.community,...this.manuscripts])}};
let finish;
const context={POPUP_TYPE:{TEXT:1,CONFIRM:2},POPUP_RESULT:{AFFIRMATIVE:1,CANCELLED:0},callGenericPopup:async()=>window.approveLeave??false,
Popup:class{constructor(panel,type,text,options){this.dlg=document.createElement('dialog');this.dlg.className='popup';this.dlg.innerHTML='<div class="popup-body"><div class="popup-content"></div><div class="popup-crop-wrap" style="display:none"></div><textarea class="popup-input" style="display:none"></textarea><div class="popup-inputs" style="display:none"></div><div class="popup-controls"></div></div><div class="popup-button-close" style="display:none"></div>';this.dlg.querySelector('.popup-content').append(panel);this.options=options}show(){document.body.append(this.dlg);this.dlg.showModal();this.options.onOpen();return new Promise(r=>finish=r)}async complete(){if(await this.options.onClosing()){this.dlg.remove();finish()}}}};
const ui=createTheatrePanel(()=>context,state,{loaded:Promise.resolve(),saveSettings(){},toggleFavorite(id){delete state.settings.favorites[id]},updateLibrary(){window.updateCalls=(window.updateCalls||0)+1;state.updating=true;state.statusKind='update';state.status='正在检查更新…';ui.refresh();},
async saveManuscript(draft){if(window.failSave)throw Error('模拟保存失败');const item={...state.manuscripts.get(draft.id),...draft,id:draft.id||'local:new',publishedAt:'2026-01-01T00:00:00Z'};state.manuscripts.set(item.id,item);return item},async deleteManuscript(id){state.manuscripts.delete(id);delete state.settings.favorites[id]}});
window.ui=ui;ui.open();
</script>`;
async function settle(page) {
 await page.evaluate(()=>new Promise(resolve=>{
  let frames=0;const tick=()=>++frames===8?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick);
 }));
}
async function verifyLayout(page,mobile) {
 const panel=page.locator('#teahouse-panel');
 const button=name=>panel.getByRole('button',{name,exact:true}).filter({visible:true});
 async function assertHeight(label) {
  await settle(page);
  const boxes=await page.evaluate(()=>['.teahouse-dialog','.popup-body','.popup-content','#teahouse-panel'].map(selector=>{
   const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,height:r.height};
  }));
  const expected=mobile?page.viewportSize().height:Math.min(832,page.viewportSize().height-64);
  for(const box of boxes){assert.ok(Math.abs(box.height-expected)<1,label+': 填满固定高度');assert.ok(Math.abs(box.top-boxes[0].top)<1,label+': 上边缘固定');}
 }
 for(const safari of [false,true]) {
  await page.evaluate(flag=>document.body.classList.toggle('safari',flag),safari);
  for(const count of [0,1,3,20]) {
   await page.evaluate(n=>{
    const state=window.fixture;state.community.clear();
    for(let i=0;i<n;i++){const id='test:'+i;state.community.set(id,{id,title:'合成测试 '+i,type:'standalone',body:'合成短正文。',publishedAt:new Date(2026,0,30-i).toISOString()});}
    window.ui.refresh();
   },count);
   await assertHeight('Safari='+safari+', '+count+'条');
  }
  if(mobile)await button('搜索剧场').click();
  for(const query of ['合成测试 0','没有匹配的标题','']){await panel.getByRole('searchbox').fill(query);await assertHeight('搜索：'+query);}
  if(mobile)await button('取消搜索').click();
  await button('设置').click();await assertHeight('设置');
  await button('返回列表').click();
  for(const scope of ['我的收藏','亲笔手稿','茶会选集']){await button(scope).click();await assertHeight(scope);}
 }
 const code='  缩进与空行保留\n\n'+('合成测试文字。'.repeat(100))+'\n'+('unbroken'.repeat(100))+'\n**原样符号** <b>原样标签</b> {{user}}\n';
 const fence=String.fromCharCode(96).repeat(3);
 const source=fence+'text\n'+code+fence+'\n\n代码块之后的测试标记。';
 await page.evaluate(body=>{
  const state=window.fixture;state.community.clear();state.community.set('test:code',{id:'test:code',title:'合成代码块',type:'standalone',body});window.ui.refresh();
 },source);
 await settle(page);
 if(mobile){await panel.getByRole('button',{name:'展开全文：合成代码块',exact:true}).click();await settle(page);}
 assert.equal(await panel.locator('.tea-body pre code').filter({visible:true}).textContent(),code,'只改变视觉换行，代码内容原样显示');
 assert.equal(await panel.locator('pre strong, pre b').count(),0,'代码块内不再次解析 Markdown 或 HTML');
 const sizes=await panel.locator('pre').filter({visible:true}).evaluate(n=>({width:n.clientWidth,scrollWidth:n.scrollWidth,height:n.clientHeight,scrollHeight:n.scrollHeight}));
 assert.ok(sizes.scrollWidth<=sizes.width+1,'长行和连续英文不得横向溢出');
 assert.ok(sizes.scrollHeight<=sizes.height+1,'代码块不单独裁切高度');
 const footerTop=await panel.locator(mobile?'.tea-pagination':'.tea-reader-footer').evaluate(n=>n.getBoundingClientRect().top);
 const end=panel.getByText('代码块之后的测试标记。',{exact:true}).filter({visible:true});await end.scrollIntoViewIfNeeded();
 const scroll=panel.locator(mobile?'.tea-list':'.tea-reading');
 const scrollBox=await scroll.boundingBox(),endBox=await end.boundingBox();
 assert.ok(endBox.y>=scrollBox.y&&endBox.y+endBox.height<=scrollBox.y+scrollBox.height+1,'滚动后能够读到代码块后面的正文');
 assert.equal(await panel.locator(mobile?'.tea-pagination':'.tea-reader-footer').evaluate(n=>n.getBoundingClientRect().top),footerTop,'滚动正文时底部操作位置固定');
 await assertHeight('长代码块');
 if(process.env.TEA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.TEA_SCREENSHOT_DIR,mobile?'code-mobile.png':'code-desktop.png')});
 await button('填入输入框').click();
 assert.equal(await page.locator('#send_textarea').inputValue(),source,'填入酒馆的是原文，视觉换行不能改写原文');
 await page.reload();await panel.waitFor();
}
(async () => {
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  for(const mobile of [false,true]) {
   const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1332,height:896}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text())});
   await page.route('http://tea.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/')return route.fulfill({contentType:'text/html',body:harness});
    const relative=pathname.slice(1);
    if(!['panel.js','library.js','sha256.js','markdown.js','vendor/markdown-it.js','style.css','assets/tea-party.svg'].includes(relative))return route.abort();
    await route.fulfill({contentType:relative.endsWith('.css')?'text/css':relative.endsWith('.svg')?'image/svg+xml':'text/javascript',body:await fs.readFile(path.join(root,relative))});
   });
   await page.goto('http://tea.test/');
   const panel=page.locator('#teahouse-panel');
   await panel.waitFor(); assert.equal(await page.title(),'茶话会操作回归');
   assert.equal(page.url(),'http://tea.test/');
   await verifyLayout(page,mobile);
   const visibleButton=name=>panel.getByRole('button',{name,exact:true}).filter({visible:true});
   await visibleButton('设置').click();
   const fontTop=()=>panel.getByRole('combobox',{name:'正文字号'}).evaluate(n=>n.getBoundingClientRect().top);
   const beforeUpdateTop=await fontTop();
   assert.equal(await panel.locator('.tea-update-status').innerText(),'');
   await visibleButton('手动更新').click();
   assert.equal(await visibleButton('手动更新').isDisabled(),true);
   assert.equal(await visibleButton('手动更新').getAttribute('aria-busy'),'true');
   assert.equal(await panel.locator('.tea-manual-update svg').evaluate(n=>getComputedStyle(n).animationName),'tea-update-spin');
   assert.equal(await panel.locator('.tea-update-status').innerText(),'正在检查更新…');
   assert.equal(await fontTop(),beforeUpdateTop);
   assert.equal(await page.evaluate(()=>window.updateCalls),1);
   for(const status of ['茶会选集已是最新','更新未完成：'+('模拟很长的错误说明。'.repeat(30)),'']){
    await page.evaluate(text=>{window.fixture.updating=false;window.fixture.status=text;window.ui.refresh()},status);
    assert.equal(await panel.locator('.tea-update-status').innerText(),status);
    assert.equal(await visibleButton('手动更新').isDisabled(),false);
    assert.equal(await fontTop(),beforeUpdateTop,'更新结果出现和消失不能推动下方设置');
    assert.equal(await panel.locator('.tea-status').isVisible(),false,'设置内不重复显示更新浮动提示');
   }
   if(process.env.TEA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.TEA_SCREENSHOT_DIR,mobile?'update-settings-mobile.png':'update-settings-desktop.png')});
   await visibleButton('返回列表').click();
   assert.equal(await visibleButton('更新茶会选集').count(),0,'更新入口只保留在设置中');
   assert.equal(await visibleButton('重新打乱').count(),0,'按时间排序时隐藏重新打乱');
   await visibleButton('我的收藏').click();
   if(mobile) {
    const jump=()=>visibleButton('跳转到某页');
    await jump().click();
    await panel.getByRole('textbox',{name:'跳转页码'}).fill('0');
    await panel.getByRole('button',{name:'确认跳转',exact:true}).click();
    assert.equal(await panel.locator('.tea-page-error').innerText(),'请输入 1～4');
    assert.equal(await panel.locator('.tea-page-current').innerText(),'01');
    await panel.getByRole('textbox',{name:'跳转页码'}).fill('3');
    await panel.getByRole('button',{name:'确认跳转',exact:true}).click();
    assert.equal(await panel.locator('.tea-page-current').innerText(),'03');
    assert.equal(await panel.locator('.tea-feed-entry').first().getAttribute('data-id'),'local:00000000000000000000000000000010');
    assert.equal(await panel.locator('.tea-list').evaluate(n=>n.scrollTop),0);
    assert.equal(await panel.locator('.tea-page-popover').isVisible(),false);
    await jump().click();
    await page.keyboard.press('Escape');
    assert.equal(await panel.isVisible(),true,'关闭跳页框不会关闭整个面板');
    assert.equal(await panel.locator('.tea-page-popover').isVisible(),false);
    assert.equal(await panel.getByRole('searchbox').count(),0,'手机搜索默认收起');
    const listTop=await panel.locator('.tea-list').evaluate(n=>n.getBoundingClientRect().top);
    await visibleButton('搜索剧场').click();
    assert.equal(await panel.locator('.tea-list').evaluate(n=>n.getBoundingClientRect().top),listTop,'展开搜索不推移正文');
    await panel.getByRole('searchbox').fill('查找手稿 19');
    await panel.getByRole('searchbox').press('Enter');
    assert.equal(await panel.getByRole('searchbox').isVisible(),true,'收起键盘仍保留搜索条件');
    await visibleButton('清空搜索').click();
    assert.equal(await panel.getByRole('searchbox').inputValue(),'');
    await visibleButton('取消搜索').click();
    assert.equal(await panel.getByRole('searchbox').count(),0);
    assert.equal(await panel.locator('.tea-page-total').innerText(),'04','取消恢复全部结果');
    await visibleButton('搜索剧场').click();
    await panel.getByRole('searchbox').fill('查找手稿 19');
    assert.equal(await panel.locator('.tea-page-current').innerText(),'01');
    assert.equal(await panel.locator('.tea-page-total').innerText(),'01');
    assert.equal(await jump().isVisible(),true,'只有一页也保留页码');
    assert.equal(await visibleButton('下一页').isDisabled(),true);
    await panel.getByRole('searchbox').fill('');
    await visibleButton('设置').click();
    assert.equal(await panel.getByRole('combobox',{name:'正文字号'}).inputValue(),'15');
    await panel.getByRole('combobox',{name:'正文字号'}).selectOption('18');
    assert.equal(await page.evaluate(()=>window.fixture.settings.mobileFontSize),18);
    assert.equal(await page.evaluate(()=>window.fixture.settings.fontSize),undefined,'手机字号不修改电脑字号');
    await panel.getByRole('combobox',{name:'正文字号'}).selectOption('15');
    await visibleButton('返回列表').click();
   } else assert.equal(await panel.locator('.tea-page-jump').count(),0,'电脑端保留原分页');
   // Keep the original input connected while the IME owns its composition session.
   await panel.getByRole('searchbox').focus();
   await page.evaluate(()=>{
    const input=document.querySelector('input[type=search]');window.composingInput=input;
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    input.value='chazhao';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'chazhao'}));
    window.ui.refresh();
   });
   assert.equal(await page.evaluate(()=>window.composingInput===document.querySelector('input[type=search]')&&window.composingInput.isConnected),true);
   assert.equal(await panel.getByRole('searchbox').inputValue(),'chazhao');
   assert.equal(await panel.locator('.tea-empty').count(),0,'拼音阶段不执行搜索');
   await page.evaluate(()=>{
    const input=window.composingInput;input.value='查找手稿 1';input.setSelectionRange(6,6);
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'查找手稿 1'}));
    document.querySelector('input[type=search]').dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false}));
   });
   assert.equal(await panel.getByRole('searchbox').inputValue(),'查找手稿 1');
   assert.ok((await panel.locator('.tea-list').innerText()).includes('查找手稿 1'));
   // Cancel a second composition, then edit in the middle without moving the caret.
   await page.evaluate(()=>{
    const input=document.querySelector('input[type=search]');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    input.value='查找手稿 1p';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
    input.value='查找手稿 1';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));
    const next=document.querySelector('input[type=search]');next.value='查找X手稿 1';next.setSelectionRange(3,3);next.dispatchEvent(new InputEvent('input',{bubbles:true}));
   });
   assert.equal(await panel.getByRole('searchbox').evaluate(n=>n.selectionStart),3);
   assert.equal(await panel.getByRole('searchbox').inputValue(),'查找X手稿 1');
   await panel.getByRole('searchbox').fill('查找');
   await visibleButton('下一页').click();
   const pageBefore=await panel.locator('.tea-page-display').innerText();
   if(mobile) await panel.locator('.tea-list').evaluate(node=>node.scrollTop=200);
   else await panel.locator('.tea-story').nth(1).click();
   const selected=mobile?panel.locator('.tea-feed-entry').first():panel.locator('.tea-reading');
   const title=await selected.locator('.tea-article-title').innerText();
   const edit=mobile?selected.getByRole('button',{name:'编辑手稿'}):visibleButton('编辑手稿');
   await page.evaluate(()=>document.addEventListener('click',event=>{
    if(event.target.closest('[aria-label="编辑手稿"]'))window.beforeEditScroll=document.querySelector('.tea-list').scrollTop;
   },true));
   await edit.click();
   await panel.locator('textarea').fill('保存后的正文');
   await visibleButton('保存手稿').click();
   await panel.locator('.tea-article-title').filter({hasText:title}).first().waitFor();
   assert.equal(await panel.getByRole('searchbox').inputValue(),'查找');
   assert.equal(await visibleButton('我的收藏').getAttribute('aria-pressed'),'true');
   assert.equal(await panel.locator('.tea-page-display').innerText(),pageBefore);
   if(!mobile)assert.equal(await panel.locator('.tea-reading .tea-article-title').innerText(),title);
   else assert.ok(await page.evaluate(()=>Math.abs(document.querySelector('.tea-list').scrollTop-window.beforeEditScroll)<2),'手机返回原滚动位置');
   await page.evaluate(()=>window.ui.refresh());
   assert.equal(await panel.locator('.tea-status').innerText(),'手稿已保存','后台刷新不能抹掉手稿保存反馈');
   await panel.locator('.tea-status').waitFor({state:'visible'});
   await panel.locator('.tea-status').waitFor({state:'hidden',timeout:7000});
   // A failed save must leave the draft available for retry.
   await (mobile?panel.locator('.tea-feed-entry').first().getByRole('button',{name:'编辑手稿'}):visibleButton('编辑手稿')).click();
   await panel.locator('textarea').fill('失败时保留的草稿');
   await page.evaluate(()=>window.failSave=true);
   await visibleButton('保存手稿').click();
   assert.equal(await panel.locator('textarea').inputValue(),'失败时保留的草稿');
   await visibleButton('关闭编辑，返回列表').click();
   assert.equal(await panel.locator('textarea').inputValue(),'失败时保留的草稿','取消放弃不能丢失修改');
   await page.evaluate(()=>window.failSave=false);
   await visibleButton('保存手稿').click();
   // Changing a title so it no longer matches must preserve the user's search.
   await (mobile?panel.locator('.tea-feed-entry').first().getByRole('button',{name:'编辑手稿'}):visibleButton('编辑手稿')).click();
   await panel.locator('input[name=title]').fill('改名后不匹配');
   await visibleButton('保存手稿').click();
   assert.equal(await panel.getByRole('searchbox').inputValue(),'查找');
   assert.equal(await visibleButton('我的收藏').getAttribute('aria-pressed'),'true');
   assert.equal(await panel.locator('.tea-article-title').filter({hasText:'改名后不匹配'}).count(),0);
   const beforeNewPage=await panel.locator('.tea-page-display').innerText();
   await visibleButton('新建手稿').click();
   await panel.locator('input[name=title]').fill('新建的手稿');
   await panel.locator('textarea').fill('新建正文');
   await visibleButton('保存手稿').click();
   assert.equal(await panel.getByRole('searchbox').inputValue(),'查找');
   assert.equal(await visibleButton('我的收藏').getAttribute('aria-pressed'),'true');
   assert.equal(await panel.locator('.tea-page-display').innerText(),beforeNewPage);
   assert.equal(await panel.locator('.tea-status').innerText(),'手稿已保存到亲笔手稿');
   assert.deepEqual(errors,[]);
   if(process.env.TEA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.TEA_SCREENSHOT_DIR,mobile?'flow-mobile.png':'flow-desktop.png')});
   console.log(JSON.stringify({viewport:mobile?'390x844':'1332x896',checks:'面板固定高度及Safari兼容；代码块换行、完整阅读和原文填入；保存保留收藏/搜索/分页；保存失败保留草稿；取消放弃；筛选外移除；提示自动消失',errors}));
   await page.close();
  }
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
