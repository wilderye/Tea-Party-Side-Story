// Flow: edit a message in place -> save/cancel -> preserve history and composer.
// Real panel/history flow with synthetic characters, rules and model output.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const harness = String.raw`<!doctype html><meta charset="utf-8"><title>小剧场设置与原文编辑验证</title>
<link rel="stylesheet" href="/style.css"><style>
body{margin:0}button,input,textarea,select{font:inherit}*{box-sizing:border-box}dialog{border:0;padding:0}
.popup{display:flex;flex-direction:column;min-height:fit-content;max-height:calc(100dvh - 2em)}
.popup .popup-body{display:flex;flex-direction:column;overflow:hidden;width:min(100%,100vw);height:100%;padding:1px}
.popup .popup-content{margin-top:10px;padding:0 8px;overflow:hidden;flex-grow:1}
</style><button id="open">打开小剧场面板</button><textarea id="send_textarea" hidden></textarea>
<script type="module">
import {createTheatrePanel} from '/panel.js';
import {createPlayRuntime} from '/play-runtime.js';
import {createPlayHistory,PLAY_HISTORY_INDEX} from '/play-history.js';
import {createPlayPromptFavorites} from '/play-prompt-favorites.js';
import {readManuscripts} from '/library.js';
const files=new Map(JSON.parse(localStorage.getItem('historyFiles')||'[]'));
const history=window.testHistory=createPlayHistory({readFile:async name=>files.get(name)??null,
writeFile:async(name,text)=>{if(window.failSave&&name===PLAY_HISTORY_INDEX)throw Error('模拟保存失败');if(window.holdSave&&name===PLAY_HISTORY_INDEX)await new Promise(resolve=>window.resumeSave=resolve);files.set(name,text);localStorage.setItem('historyFiles',JSON.stringify([...files]));},
removeFile:async name=>{files.delete(name);localStorage.setItem('historyFiles',JSON.stringify([...files]));},uuid:()=>crypto.randomUUID()});
const listeners=new Map();
const persona=window.persona={user_avatar:'user.png'};
const ctx=window.ctx={mainApi:'openai',characterId:0,name1:'茶客',name2:'测试甲',chatId:'A-main',
characters:[{avatar:'A.png',name:'测试甲'},{avatar:'B.png',name:'测试乙'}],chat:[{mes:'原聊天',is_user:false}],
chatCompletionSettings:{preset_settings:'预设甲'},extensionSettings:{},accountStorage:localStorage,getCurrentUserHandle:()=> 'test-user',
uuidv4:()=>crypto.randomUUID(),getCurrentChatId:()=>ctx.chatId,getChatCompletionModel:()=>'test-model',
getThumbnailUrl:()=> 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#739785"/></svg>'),
eventTypes:{CHAT_CHANGED:'chatChanged',PERSONA_CHANGED:'personaChanged'},eventSource:{on(event,fn){if(!listeners.has(event))listeners.set(event,[]);listeners.get(event).push(fn)},emit(event){for(const fn of listeners.get(event)||[])fn()}},
POPUP_TYPE:{TEXT:1,CONFIRM:2},POPUP_RESULT:{CANCELLED:0,AFFIRMATIVE:1},callGenericPopup:async()=>1,
Popup:class{constructor(panel,_type,_text,options){this.options=options;this.dlg=document.createElement('dialog');this.dlg.className='popup';this.dlg.innerHTML='<div class="popup-body"><div class="popup-content"></div></div>';this.dlg.querySelector('.popup-content').append(panel)}
show(){document.body.append(this.dlg);this.dlg.showModal();this.options.onOpen();return new Promise(resolve=>this.finish=resolve)}
async complete(){if(await this.options.onClosing()){this.dlg.remove();this.finish()}}}};
const script=(id,scriptName,findRegex,replaceString,extra={})=>({id,scriptName,findRegex,replaceString,placement:[2],minDepth:999,maxDepth:0,...extra});
const globalRules=[script('global','全局替换','全局标记','全局已处理')];
const presetRules=[script('same','状态栏美化','<status>([\\s\\S]*?)</status>','<div class="status-card">状态卡：$1</div>',{markdownOnly:true})];
const characterRules=[
 [script('same','角色替换','角色标记','甲的规则')],
 [script('same','角色替换','角色标记','乙的规则')]];
ctx.characters.forEach((character,index)=>character.data={extensions:{regex_scripts:characterRules[index]}});
ctx.extensionSettings.character_allowed_regex=['A.png','B.png'];
const engine={SCRIPT_TYPES:{GLOBAL:0,PRESET:2,SCOPED:1},regex_placement:{AI_OUTPUT:2},
getCurrentPresetAPI:()=>'openai',getCurrentPresetName:()=>ctx.chatCompletionSettings.preset_settings,
getScriptsByType:type=>{if(window.failRegex)throw Error('模拟读取正则失败');return type===0?globalRules:type===2?presetRules:characterRules[ctx.characterId];},
runRegexScript:(rule,text)=>text.replace(new RegExp(rule.findRegex,'g'),rule.replaceString)};
window.rules={globalRules,presetRules,characterRules};
const settings=JSON.parse(localStorage.getItem('processingSettings')||'null')||{enabled:true,pageSize:5,favorites:{}};
window.captured=[];window.capturedPrompts=[];
const runtime=window.runtime=createPlayRuntime(()=>ctx,settings,history,{loadRegex:async()=>engine,loadPersona:async()=>persona,
prepareRequest:async request=>{window.captured.push(request.environment);window.capturedPrompts.push(request.prompt);return{send:({onText,signal})=>new Promise((resolve,reject)=>{
window.emitGeneration=onText;window.finishGeneration=resolve;
signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})}}});
if(!files.has(PLAY_HISTORY_INDEX)){
const seed=async(character,text,offset)=>{const startedAt=new Date(Date.UTC(2026,0,1,0,0,offset)).toISOString();
const round=await history.begin({character,prompt:'测试小剧场',resultId:crypto.randomUUID(),startedAt,context:{chatId:character.avatar+'-main',apiMode:'tavern',characterName:character.name,presetName:'生成时预设'}});
return history.saveResult(round.id,round.results[0].id,{text,status:'complete',finishedAt:startedAt});};
const a=await seed(ctx.characters[0],'<think>默认隐藏的思考</think><thinking>默认隐藏的思考</thinking>\n<content>\n<内容>\n**小剧场正文** 全局标记 角色标记\n<status>默认隐藏状态</status><update>默认隐藏更新</update>\n\n'+Array.from({length:24},(_,i)=>'阅读位置验证第'+(i+1)+'段。').join('\n\n')+'\n</内容>\n</content>',0);
const hidden=await seed(ctx.characters[0],'<thinking>找回整段小剧场</thinking>',1);
const b=await seed(ctx.characters[1],'乙的旧记录 角色标记',2);
localStorage.setItem('seed',JSON.stringify({a:a.id,hidden:hidden.id,b:b.id}));}
window.seed=JSON.parse(localStorage.getItem('seed'));
const state=window.fixture={settings,community:new Map(),manuscripts:readManuscripts(JSON.parse(localStorage.getItem('manuscripts')||'{"format":1,"entries":[]}')),
get entries(){return new Map([...this.community,...this.manuscripts])},status:'',personalError:''};
const libraryActions={loaded:Promise.resolve(),saveSettings(){localStorage.setItem('processingSettings',JSON.stringify(settings))},
toggleFavorite(id){if(Object.hasOwn(settings.favorites,id))delete settings.favorites[id];else settings.favorites[id]=Date.now();this.saveSettings()},
async saveManuscript(draft){
 if(window.failManuscriptSave)throw Error('模拟手稿保存失败');
 if(window.holdManuscriptSave)await new Promise(resolve=>window.resumeManuscriptSave=resolve);
 const previous=state.manuscripts.get(draft.id),item={...draft,id:previous?.id||'local:'+crypto.randomUUID(),publishedAt:previous?.publishedAt||new Date().toISOString()};
 const next=readManuscripts({format:1,entries:[...state.manuscripts.values()].filter(entry=>entry.id!==item.id).concat(item)});
 localStorage.setItem('manuscripts',JSON.stringify({format:1,entries:[...next.values()]}));state.manuscripts=next;return item;
}};
const promptFavorites=window.promptFavorites=createPlayPromptFavorites(state,{...libraryActions,toggleFavorite:id=>libraryActions.toggleFavorite(id)});
const ui=window.ui=createTheatrePanel(()=>ctx,state,{...libraryActions,playground:runtime,promptFavorites});
document.getElementById('open').onclick=()=>void ui.open();window.ready=true;
</script>`;
module.exports = { harness, verifyPromptEdit, verifyUnsavedPromptEdit };
const allowed = new Set(['panel.js','appearance.js','ui.js','diagnostics.js','diagnostics-view.js','play-view.js','play-character-picker.js','play-favorite-composer.js','play-reading-storage.js','play-editor.js','play-favorites-view.js','play-prompt-favorites.js','play-render.js','play-runtime.js','play-history.js',
 'play-storage.js','play-storage-worker.js','play-storage-lock.js','play-prompt.js','play-task-module.js','play-template-context.js','play-variable-context.js','play-preparation.js','play-preset.js','play-parameters.js','play-request.js',
 'playground.js','play-settings.js','play-processing.js','play-settings-view.js','library.js','sha256.js',
 'markdown.js','theme-styles.js','vendor/markdown-it.js','style.css','assets/tea-party.svg','assets/fonts/tea-conversation-serif.woff2']);
const server = http.createServer(async (request,response) => {
 try {
  const file = new URL(request.url,'http://test').pathname.slice(1);
  if (!file) {response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(harness);}
  if(file==='favicon.ico'){response.statusCode=204;return response.end();}
  if(!allowed.has(file)){response.statusCode=404;return response.end();}
  response.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'text/javascript');
  response.end(await fs.readFile(path.join(root,file)));
 } catch(error){response.statusCode=500;response.end(error.message);}
});
async function screenshot(page,name) {
 if(!process.env.TEA_QA_DIR)return;
 await fs.mkdir(process.env.TEA_QA_DIR,{recursive:true});
 await page.screenshot({path:path.join(process.env.TEA_QA_DIR,name)});
}

async function verifyEntryFill(page) {
 const panel=page.locator('#teahouse-panel');
 const button=name=>panel.getByRole('button',{name,exact:true}).filter({visible:true});
 const input=panel.getByRole('textbox',{name:'小剧场提示词',exact:true,includeHidden:true});
 const requestCount=await page.evaluate(()=>captured.length);
 let body='暂停当前剧情，写一篇雨中的小剧场。\n\n保留 {{char}} 和 {{user}}。';
 await page.evaluate(body=>{
  fixture.community.clear();
  fixture.community.set('entry-fill-test',{id:'entry-fill-test',title:'待填入的小剧场',type:'standalone',body,author:'测试'});
 },body);
 for(const previous of [null,'','手动改过的内容']) {
  if(previous!==null)await input.fill(previous);
  await button('茶会选集').click();
  await button('在插件中游玩').click();await input.waitFor();
  assert.equal(await input.inputValue(),body,'首次选择、清空或修改后重选同一篇，都填入所选原文');
  assert.equal(await input.evaluate(node=>document.activeElement===node),true,'切换到演出页面后聚焦输入框');
 }
 body+='\n这是更新后的原文。';
 await page.evaluate(body=>{fixture.community.get('entry-fill-test').body=body;},body);
 await button('茶会选集').click();await button('在插件中游玩').click();
 assert.equal(await input.inputValue(),body,'同一篇原文更新后重新选择，使用更新后的内容');
 const record=panel.locator('.play-record:visible').last();
 await record.getByRole('button',{name:'修改提示词',exact:true}).click();
 const editor=record.getByRole('textbox',{name:'提示词原文',exact:true});
 await editor.fill('正在编辑的提示词');
 assert.equal(await input.inputValue(),body,'原位置编辑不会替换底部填入的原文');
 await record.locator('.play-user-meta').getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await input.inputValue(),body,'取消编辑后仍保留底部填入的原文');
 assert.equal(await page.evaluate(()=>captured.length),requestCount,'填入内容和修改草稿都不会发送模型请求');
}

async function verifyPromptEdit(page,viewport,openSettings,closeSettings) {
 const panel=page.locator('#teahouse-panel'),record=panel.locator('.play-record:visible').last();
 const id=await record.getAttribute('data-record');
 const original=await page.evaluate(id=>runtime.getRound(id),id),requests=await page.evaluate(()=>captured.length);
 const mainChat=await page.evaluate(()=>structuredClone(ctx.chat));
 const input=panel.getByRole('textbox',{name:'小剧场提示词',exact:true,includeHidden:true});
 const composer='底部尚未发送的草稿';await input.fill(composer);
 const action=name=>record.locator('.play-user-meta').getByRole('button',{name,exact:true});
 await record.getByRole('button',{name:'修改提示词',exact:true}).click();
 const edit=record.getByRole('group',{name:'编辑提示词原文',exact:true});
 const editor=edit.getByRole('textbox',{name:'提示词原文',exact:true});
 assert.equal(await editor.inputValue(),original.prompt);
 assert.equal(await editor.evaluate(node=>document.activeElement===node),true);
 assert.equal(await record.locator('.play-user-text .play-edit-form').count(),1,'用户消息在原位置使用共享编辑框');
 assert.equal(await input.inputValue(),composer);
 assert.equal(await record.locator('.play-edit-prompt').count(),0,'编辑期间小铅笔由保存和取消图标替换');
 assert.equal(await record.locator('.play-again').isDisabled(),true);
 assert.equal(await record.locator('.play-count').isDisabled(),true);
 for(const name of ['保存','取消']){
  assert.equal(await action(name).textContent(),'');assert.equal(await action(name).locator('svg').count(),1);
 }
 const messageBox=await record.locator('.play-user-message').boundingBox(),editorBox=await editor.boundingBox();
 assert.ok(Math.abs(editorBox.x-messageBox.x)<1&&Math.abs(editorBox.width-messageBox.width)<1,'用户编辑框与消息边缘对齐');
 assert.ok((await action('保存').boundingBox()).y<editorBox.y,'保存和取消图标位于消息顶部');
 if(viewport.width<=760)assert.ok(editorBox.height>400,'手机用户编辑框占据大部分可见区域');
 else assert.ok(editorBox.height<150,'桌面短用户消息沿用回复编辑框的紧凑高度');
 assert.equal(await panel.locator('.play-compose').isVisible(),viewport.width>760,'手机编辑用户消息时隐藏底部输入区域，桌面保持原布局');
 await editor.fill('长提示词\n'.repeat(100));
 const editorLimit=viewport.width<=760?(await panel.locator('.play-feed').boundingBox()).height:420;
 assert.ok(await editor.evaluate((node,maxHeight)=>node.scrollHeight>node.clientHeight&&node.clientHeight<=maxHeight,editorLimit),'长消息只在编辑框内滚动');
 const draft='改成清晨。\n\n{{char}} 请听 {{user}} 说话。\n\n<char> 与 <user>；<CHAR> 与 <USER>。\n\n{{other}} 和 <character> 原样保留。';await editor.fill(draft);
 await closeSettings(await openSettings());
 assert.equal(await editor.inputValue(),draft,'设置返回不覆盖用户消息编辑草稿');
 await screenshot(page,`user-message-editor-${viewport.width}.png`);
 await editor.fill(' \n ');await action('保存').click();
 await edit.getByRole('alert').getByText('提示词不能为空。',{exact:true}).waitFor();
 await editor.fill(draft);await page.evaluate(()=>window.failSave=true);await action('保存').click();
 await edit.getByRole('alert').getByText('模拟保存失败',{exact:true}).waitFor();
 assert.equal(await editor.inputValue(),draft);
 assert.equal((await page.evaluate(id=>runtime.getRound(id),id)).prompt,original.prompt);
 await page.evaluate(()=>{window.failSave=false;window.holdSave=true;window.resumeSave=null;});await action('保存').click();
 await page.waitForFunction(()=>typeof window.resumeSave==='function');
 assert.equal(await action('保存').getAttribute('aria-busy'),'true');assert.equal(await editor.isDisabled(),true);
 await panel.getByRole('button',{name:'设置',exact:true}).click();
 assert.equal(await panel.getAttribute('data-mode'),'list','保存用户消息时也不能切走');
 await panel.getByRole('button',{name:'关闭面板',exact:true}).click();
 assert.equal(await panel.isVisible(),true,'保存用户消息时也不能关闭面板');
 await page.evaluate(()=>{window.holdSave=false;window.resumeSave();});
 await record.locator('.play-user-text').getByText('测试甲 请听 茶客 说话。',{exact:true}).waitFor();
 await record.locator('.play-user-text').getByText('测试甲 与 茶客；测试甲 与 茶客。',{exact:true}).waitFor();
 await record.locator('.play-user-text').getByText('{{other}} 和 <character> 原样保留。',{exact:true}).waitFor();
 await screenshot(page,`prompt-name-display-${viewport.width}.png`);
 assert.equal(await panel.locator('.play-compose').isVisible(),true,'保存用户消息后恢复底部输入区域');
 assert.deepEqual(await page.evaluate(id=>runtime.getRound(id),id),{...original,prompt:draft},'保存只修改提示词，所有回复、归属和时间均保留');
 assert.equal(await input.inputValue(),composer);
 await record.getByRole('button',{name:'修改提示词',exact:true}).click();
 assert.equal(await editor.inputValue(),draft,'编辑框保留原始宏，显示时才换成人名');
 await editor.fill('取消后不保存');await action('取消').click();
 assert.equal((await page.evaluate(id=>runtime.getRound(id),id)).prompt,draft);
 await record.getByRole('button',{name:'修改提示词',exact:true}).click();await editor.fill('本窗口的修改草稿');
 await page.evaluate(async({id,draft})=>{await testHistory.editPrompt(id,'另一窗口保存的新提示词',draft);ui.refresh();},{id,draft});
 await closeSettings(await openSettings());
 assert.equal(await editor.inputValue(),'本窗口的修改草稿','刷新历史不会覆盖正在编辑的文字');
 await action('保存').click();await edit.getByRole('alert').getByText(/已在其他窗口修改/).waitFor();
 assert.equal(await editor.inputValue(),'本窗口的修改草稿','冲突时保留草稿，不覆盖另一窗口的修改');
 await action('取消').click();await record.locator('.play-user-text').getByText('另一窗口保存的新提示词',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>captured.length),requests,'编辑、保存、取消和冲突处理都不调用模型');
 assert.deepEqual(await page.evaluate(()=>ctx.chat),mainChat,'编辑小剧场不改动酒馆主聊天');
 await page.reload();await page.waitForFunction(()=>window.ready);
 await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
 await panel.getByRole('button',{name:'剧场演出',exact:true}).click();
 const reopened=panel.locator(`[data-record="${id}"]`);
 await reopened.locator('.play-user-text').getByText('另一窗口保存的新提示词',{exact:true}).waitFor();
 assert.equal(await input.inputValue(),composer,'重开后底部原有草稿仍保留');
 await reopened.getByRole('button',{name:'重新生成',exact:true}).click();
 await page.waitForFunction(()=>runtime.getState().phase==='generating');
 assert.equal(await page.evaluate(()=>capturedPrompts.at(-1)),'另一窗口保存的新提示词','手动重新生成才使用保存后的用户消息');
 const generationCount=await page.evaluate(()=>captured.length);
 await reopened.getByRole('button',{name:'修改提示词',exact:true}).click();
 await reopened.getByRole('textbox',{name:'提示词原文',exact:true}).fill('生成中保存的新提示词');
 await page.evaluate(()=>window.emitGeneration('本次回复已经收到的片段'));
 await reopened.getByText('本次回复已经收到的片段',{exact:true}).waitFor();
 await reopened.locator('.play-user-meta').getByRole('button',{name:'保存',exact:true}).click();
 await reopened.locator('.play-user-text').getByText('生成中保存的新提示词',{exact:true}).waitFor();
 assert.equal(await reopened.getByText('本次回复已经收到的片段',{exact:true}).isVisible(),true,'保存用户消息不清空正在输出的回复');
 assert.equal(await page.evaluate(()=>runtime.getState().phase),'generating');
 assert.equal(await page.evaluate(()=>captured.length),generationCount,'生成中编辑用户消息不停止或重发本次请求');
 assert.equal(await page.evaluate(()=>capturedPrompts.at(-1)),'另一窗口保存的新提示词','本次请求继续使用发送时的内容');
 await page.evaluate(()=>window.finishGeneration('根据修改后的提示词生成的新回复'));
 await reopened.getByText('根据修改后的提示词生成的新回复',{exact:true}).waitFor();
 await page.waitForFunction(()=>runtime.getState().phase==='idle');
 assert.equal((await page.evaluate(id=>runtime.getRound(id),id)).prompt,'生成中保存的新提示词','本次回复保存完成后不覆盖用户刚改的提示词');
 assert.equal((await page.evaluate(id=>runtime.getRound(id),id)).results.length,original.results.length);
 await reopened.getByRole('button',{name:'重新生成',exact:true}).click();
 await page.waitForFunction(()=>runtime.getState().phase==='generating');
 assert.equal(await page.evaluate(()=>capturedPrompts.at(-1)),'生成中保存的新提示词','下次重新生成使用刚保存的内容');
 await page.evaluate(()=>window.finishGeneration('下一次使用新提示词的回复'));
 await page.waitForFunction(()=>runtime.getState().phase==='idle');
}

async function verifyUnsavedPromptEdit(page,viewport) {
 const panel=page.locator('#teahouse-panel');
 await panel.getByRole('textbox',{name:'小剧场提示词',exact:true}).fill('检查回复保存失败时修改用户消息');
 await panel.getByRole('button',{name:'发送小剧场',exact:true}).click();
 await page.waitForFunction(()=>runtime.getState().phase==='generating');
 await page.evaluate(()=>{window.failSave=true;window.finishGeneration('完整回复仍然保留在这里。');});
 await page.waitForFunction(()=>runtime.getState().phase==='save-failed');
 const id=await page.evaluate(()=>runtime.getState().roundId),requests=await page.evaluate(()=>captured.length);
 const record=panel.locator(`[data-record="${id}"]`);
 await record.getByText('完整回复仍然保留在这里。',{exact:true}).waitFor();
 await page.evaluate(()=>{
  window.failSave=false;window.savedListCharacters=runtime.listCharacters;
  runtime.listCharacters=async()=>{throw Error('模拟目录读取失败');};
 });
 await record.getByRole('button',{name:'修改提示词',exact:true}).click();
 await record.getByRole('textbox',{name:'提示词原文',exact:true}).fill('回复保存失败后修改的提示词');
 await record.locator('.play-user-meta').getByRole('button',{name:'保存',exact:true}).click();
 await record.locator('.play-user-text').getByText('回复保存失败后修改的提示词',{exact:true}).waitFor();
 await panel.getByText('模拟目录读取失败',{exact:true}).waitFor();
 assert.equal(await record.getByText('完整回复仍然保留在这里。',{exact:true}).isVisible(),true,'即使后续读取目录失败，保存用户消息也不清空尚未保存的回复');
 assert.equal(await record.getByText('模拟保存失败',{exact:true}).isVisible(),true,'回复保留原始保存错误');
 assert.equal(await page.evaluate(()=>runtime.getState().phase),'save-failed');
 assert.equal(await page.evaluate(()=>captured.length),requests);
 await screenshot(page,`unsaved-reply-after-prompt-edit-${viewport.width}.png`);
 await page.evaluate(()=>{runtime.listCharacters=window.savedListCharacters;ui.refresh();});
 await panel.locator('.play-load-error').waitFor({state:'hidden'});
 await record.getByRole('button',{name:'重试保存',exact:true}).click();
 await page.waitForFunction(()=>runtime.getState().phase==='idle');
 const saved=await page.evaluate(id=>runtime.getRound(id),id);
 assert.equal(saved.prompt,'回复保存失败后修改的提示词');
 assert.equal(saved.results[0].text,'完整回复仍然保留在这里。');
 assert.equal(saved.results[0].status,'complete');
 assert.equal(await page.evaluate(()=>captured.length),requests,'重试保存也不重新请求模型');
}

async function verifyFontSource(page,viewport,openSettings,closeSettings) {
 const panel=page.locator('#teahouse-panel');
 const typography=()=>panel.evaluate(node=>[
  node,node.querySelector('.play-user-text .play-prose'),node.querySelector('.play-results .play-prose'),
  node.querySelector('.play-speaker'),node.querySelector('.play-compose-input'),node.querySelector('.tea-settings-group>h3'),
 ].map(element=>{
  const style=getComputedStyle(element);
  return Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','textAlign']
   .map(property=>[property,style[property]]));
 }));
 const hostFont=()=>page.evaluate(()=>getComputedStyle(document.body).fontFamily);
 const original=await page.evaluate(async()=>({chat:ctx.chat,round:await runtime.getRound(seed.a)}));
 const dialog=await openSettings(),font=dialog.getByRole('combobox',{name:'字体',exact:true});
 assert.equal(await font.inputValue(),'default','已有用户保持默认字体');
 assert.deepEqual(await font.locator('option').allTextContents(),['默认字体','跟随酒馆字体']);
 const defaults=await typography();
 await page.evaluate(()=>{
  document.documentElement.style.setProperty('--mainFontFamily','"Unused Tavern Variable"');
  // Match the supplied themes' body-level font declarations without downloading font files.
  document.body.style.fontFamily='"GenWanMin2 TC R", serif';
 });
 await font.scrollIntoViewIfNeeded();
 const settingTop=await dialog.locator('.tea-settings').evaluate(node=>node.scrollTop);
 await font.selectOption('tavern');
 const followed=await typography();
 for(let index=0;index<followed.length;index++) {
  assert.equal(followed[index].fontFamily,await hostFont(),'正文、姓名、输入框和界面文字使用酒馆实际指定的字体');
  assert.deepEqual({...followed[index],fontFamily:defaults[index].fontFamily},defaults[index],'仅改变字体，字号、字重、行距和颜色保持原样');
 }
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('processingSettings')).fontSource),'tavern','字体选择自动保存');
 assert.ok(Math.abs(await dialog.locator('.tea-settings').evaluate(node=>node.scrollTop)-settingTop)<2,'切换字体不重新打开设置或跳回顶部');
 assert.ok(await font.evaluate(node=>{
  const field=node.getBoundingClientRect(),panel=node.closest('#teahouse-panel').getBoundingClientRect();
  return field.left>=panel.left&&field.right<=panel.right;
 }),'电脑和手机都能完整显示字体选项');
 await screenshot(page,`font-settings-${viewport.width}.png`);
 await closeSettings(dialog);
 await page.evaluate(()=>{
  fixture.community.clear();
  fixture.community.set('test:font',{id:'test:font',title:'字体检查',type:'standalone',body:'字体切换正文。'});
 });
 await panel.getByRole('button',{name:'茶会选集',exact:true}).filter({visible:true}).click();
 for(const selector of ['.tea-article-title','.tea-body']) {
  assert.equal(await panel.locator(selector).filter({visible:true}).first().evaluate(node=>getComputedStyle(node).fontFamily),await hostFont(),'剧场库标题和正文也跟随字体设置');
 }
 await panel.getByRole('button',{name:'剧场演出',exact:true}).filter({visible:true}).click();
 await panel.locator('.play-record').filter({visible:true}).first().waitFor();
 const record=panel.locator('.play-record').filter({visible:true}).last();
 for(const [role,button,label] of [['user','修改提示词','提示词原文'],['assistant','编辑回复原文','回复原文']]) {
  await record.getByRole('button',{name:button,exact:true}).click();
  assert.equal(await record.getByRole('textbox',{name:label,exact:true}).evaluate(node=>getComputedStyle(node).fontFamily),await hostFont(),'用户和 AI 的编辑框也使用所选字体');
  await record.locator(`.play-${role}-meta`).getByRole('button',{name:'取消',exact:true}).click();
 }
 await panel.getByRole('button',{name:'关闭面板',exact:true}).click();await panel.waitFor({state:'detached'});
 await page.evaluate(()=>{document.body.style.fontFamily='"Clear Han Serif", serif';});
 await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
 assert.equal(await panel.evaluate(node=>getComputedStyle(node).fontFamily),await hostFont(),'更换酒馆字体后重新打开，读取新字体');
 await page.reload();await page.waitForFunction(()=>window.ready);
 await page.evaluate(()=>{document.body.style.fontFamily='"Clear Han Serif", serif';});
 await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
 await panel.getByRole('button',{name:'剧场演出',exact:true}).filter({visible:true}).click();
 await panel.locator('.play-record').filter({visible:true}).first().waitFor();
 const reopened=await openSettings(),savedFont=reopened.getByRole('combobox',{name:'字体',exact:true});
 assert.equal(await savedFont.inputValue(),'tavern','刷新页面后保留字体选择');
 assert.equal(await panel.evaluate(node=>getComputedStyle(node).fontFamily),await hostFont());
 await savedFont.selectOption('default');
 assert.deepEqual(await typography(),defaults,'切回默认后恢复所有原有字体及排版');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('processingSettings')).fontSource),'default');
 await closeSettings(reopened);
 assert.deepEqual(await page.evaluate(async()=>({chat:ctx.chat,round:await runtime.getRound(seed.a)})),original,'切换字体只影响显示，不修改消息和酒馆主聊天');
}

if (require.main === module) (async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const rapid=await browser.newPage({viewport:{width:1332,height:896}}),rapidErrors=[];
  rapid.on('pageerror',error=>rapidErrors.push(error.message));
  await rapid.goto(`http://127.0.0.1:${server.address().port}/`);await rapid.waitForFunction(()=>window.ready);
  await rapid.evaluate(async()=>{
   document.getElementById('open').click();
   while(!document.querySelector('.tea-tabs button'))await new Promise(resolve=>requestAnimationFrame(resolve));
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   [...document.querySelectorAll('.tea-tabs button')].find(button=>button.textContent==='剧场演出').click();
  });
  await rapid.locator('.play-record').first().waitFor();await rapid.evaluate(()=>document.fonts.ready);
  assert.deepEqual(rapidErrors,[],'打开面板后立即切换到演出页，不执行上一页排队中的目录测量');
  await rapid.close();
  for(const viewport of [{width:1332,height:896},{width:390,height:844}]) {
   const context=await browser.newContext({viewport}), page=await context.newPage(), errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
   const url=`http://127.0.0.1:${server.address().port}/`;
   await page.goto(url); await page.waitForFunction(()=>window.ready);
   // Host themes may force borders even when the extension sets border:0.
   await page.addStyleTag({content:'textarea:not([type="search"]){border:1px solid #d7ded7!important;background-color:#d7ded7!important} textarea:not([type="search"]):focus{border:1px solid #68917b!important}'});
   assert.equal(await page.title(),'小剧场设置与原文编辑验证');assert.equal(page.url(),url);
   await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
   let panel=page.locator('#teahouse-panel');
   const shellMetrics=()=>panel.evaluate(root=>{
    const visible=nodes=>[...nodes].find(node=>node.getClientRects().length);
    const catalog=visible(root.querySelectorAll('.tea-catalog'));
    const brand=catalog.querySelector('.tea-brand'),tabs=visible(root.querySelectorAll('.tea-tabs'));
    const styles=node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return{x:r.x,y:r.y,height:r.height,font:s.font,padding:s.padding,gap:s.gap};};
    return{catalogWidth:catalog.getBoundingClientRect().width,catalogPadding:getComputedStyle(catalog).padding,
     brand:styles(brand),title:styles(brand.querySelector('h1')),subtitle:styles(brand.querySelector('p')),
     tabs:styles(tabs),activeTabFont:getComputedStyle(tabs.querySelector('[aria-pressed=true]')).font,
     settings:styles(visible(root.querySelectorAll('button[aria-label="设置"]')))};
   });
   const sharedShell=await shellMetrics();
   for(const name of ['我的收藏','亲笔手稿','茶会选集']){
    await panel.getByRole('button',{name,exact:true}).filter({visible:true}).click();
    assert.deepEqual(await shellMetrics(),sharedShell,`${name} 沿用相同的标题、导航和左栏布局`);
   }
   if(viewport.width>760){
    await panel.getByRole('button',{name:'收起左侧栏',exact:true}).click();
    for(const name of ['亲笔手稿','我的收藏','剧场演出','茶会选集']){
     await panel.getByRole('button',{name,exact:true}).filter({visible:true}).click();
     assert.equal(await panel.locator('.tea-catalog').filter({visible:true}).count(),0,`${name} 共用左侧栏的收起状态`);
     const toggle=panel.getByRole('button',{name:'展开左侧栏',exact:true});
     assert.equal(await toggle.getAttribute('aria-expanded'),'false');
     assert.equal(await panel.locator('.tea-topbar').filter({visible:true}).evaluate(node=>node.getBoundingClientRect().height),64,'各栏目保留原有顶栏高度');
    }
    await panel.getByRole('button',{name:'设置',exact:true}).click();
    assert.equal(await panel.locator('.tea-catalog').filter({visible:true}).count(),0,'设置页共用收起状态');
    await panel.getByRole('button',{name:'展开左侧栏',exact:true}).click();
    await panel.getByRole('button',{name:'设置',exact:true}).click();
    assert.deepEqual(await shellMetrics(),sharedShell,'展开后恢复原有外框尺寸与样式');
   }
   const editAction=name=>panel.locator('.play-edit-actions').getByRole('button',{name,exact:true});
   await panel.getByRole('button',{name:'剧场演出',exact:true}).click();
   const ids=await page.evaluate(()=>window.seed), a=panel.locator(`[data-record="${ids.a}"]`), hidden=panel.locator(`[data-record="${ids.hidden}"]`);
   await a.getByText('甲的规则',{exact:false}).waitFor();
   await a.locator('.play-count').scrollIntoViewIfNeeded();
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.evaluate(id=>{
    const feed=document.querySelector('.play-feed');
    feed.scrollTop+=feed.scrollTop>0?-1:1;
    // Open before the browser delivers the scroll event from the prior movement.
    document.querySelector(`[data-record="${id}"] .play-count`).click();
   },ids.a);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await panel.getByRole('listbox',{name:'生成结果',exact:true}).isVisible(),true,'此前排队的滚动通知不误关刚打开的历史列表');
   await panel.locator('.play-feed').evaluate(feed=>feed.scrollTop+=feed.scrollTop>0?-1:1);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await panel.locator('.play-result-menu').count(),0,'打开后继续滚动正文会关闭历史列表');
   await a.locator('.play-user-meta .play-speaker').getByText('茶客',{exact:true}).waitFor();
   assert.equal(await a.locator('.play-user-meta img').count(),1,'用户消息显示酒馆头像');
   const playShell=await shellMetrics();
   assert.deepEqual(playShell,sharedShell,'演出页共用原有标题、导航、顶栏与左栏外观');
   if(viewport.width>760) {
    const toggle=panel.getByRole('button',{name:'收起左侧栏',exact:true});
    assert.equal(await toggle.evaluate(node=>node.parentElement.classList.contains('tea-topbar')),true,'通用左侧栏开关位于顶部栏目栏');
    assert.ok(await toggle.evaluate(node=>{
     const icon=node.querySelector('svg').getBoundingClientRect(),bar=node.parentElement.getBoundingClientRect();
     return Math.abs(icon.top+icon.height/2-(bar.top+bar.height/2))<1;
    }),'通用折叠图标与顶部栏目栏垂直居中');
    await toggle.click();
    assert.equal(await panel.locator('.play-catalog').isVisible(),false,'收起后给正文让出宽度');
    await panel.getByRole('button',{name:'展开左侧栏',exact:true}).click();
    assert.equal(await panel.locator('.play-catalog').isVisible(),true,'再次点击恢复角色列表');
   }
   assert.equal(await panel.locator('.play-current-anchor').count(),0,'移除左下角的当前聊天行');
   await page.evaluate(()=>document.fonts.ready);
   const messageLayout=await a.evaluate(record=>{
    const box=selector=>record.querySelector(selector).getBoundingClientRect();
    const edit=box('.play-edit-prompt'),identity=box('.play-user-meta .play-message-identity');
    const avatar=box('.play-user-meta .play-message-avatar'),body=box('.play-user-text');
    const prose=selector=>{const s=getComputedStyle(record.querySelector(selector));return{font:s.fontFamily,size:s.fontSize,color:s.color,align:s.textAlign};};
    return{editAfterIdentity:edit.left>=identity.right,editBeforeIdentity:edit.right<=identity.left,
     avatarOnLeft:Math.abs(avatar.left-body.left)<1,
     avatarOnRight:Math.abs(avatar.right-body.right)<1,
     sameBodyLeft:Math.abs(body.left-box('.play-results').left)<1,
     user:prose('.play-user-text .play-prose'),reply:prose('.play-results .play-prose'),
     againText:record.querySelector('.play-again').textContent.trim()};
   });
   assert.equal(viewport.width<=760?messageLayout.editAfterIdentity:messageLayout.editBeforeIdentity,true,'用户消息的操作按钮在手机端位于身份信息右侧，电脑端位于左侧');
   assert.equal(viewport.width<=760?messageLayout.avatarOnLeft:messageLayout.avatarOnRight,true,'用户头像在手机端与正文左边缘对齐，电脑端与右边缘对齐');
   assert.equal(messageLayout.sameBodyLeft,true,'两类消息正文共用左边缘');
   assert.deepEqual(messageLayout.user,messageLayout.reply,'两类消息共用正文排版');
   assert.match(messageLayout.user.font,/Microsoft YaHei|PingFang SC|sans-serif/);
   assert.equal(messageLayout.user.align,'left');
   assert.equal(messageLayout.user.size,'18px','未设置字号时，演出正文默认使用 18 号');
   assert.equal(messageLayout.againText,'','重新生成只保留图标');
   assert.match(await a.locator('.play-result').innerText(),/全局已处理/);
   assert.doesNotMatch(await a.locator('.play-result').innerText(),/默认隐藏/);
   assert.doesNotMatch(await a.locator('.play-result').innerText(),/<\/?content>/,'阅读时不显示英文正文标签');
   assert.match(await a.locator('.play-result').innerText(),/<内容>/,'阅读时保留中文正文标签');
   assert.match(await a.locator('.play-result').innerText(),/<\/内容>/,'中文结束标签也保留');
   const assertUnframed=async field=>{
    const styles=await field.evaluate(node=>{const s=getComputedStyle(node);return {border:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],outline:s.outlineStyle,shadow:s.boxShadow,background:s.backgroundColor};});
    assert.deepEqual(styles,{border:['0px','0px','0px','0px'],outline:'none',shadow:'none',background:'rgb(215, 223, 212)'},'主题不能给输入区域重新加边框，手机和电脑都保留绿色底色');
   };
   const composeInput=panel.getByRole('textbox',{name:'小剧场提示词',exact:true});
   await assertUnframed(composeInput);await composeInput.click();await assertUnframed(composeInput);
   await a.getByRole('button',{name:'编辑回复原文'}).click();
   const originalA=(await page.evaluate(id=>runtime.getRound(id),ids.a)).results[0].text;
   assert.match(originalA,/<content>\n<内容>/);
   assert.equal(await a.getByRole('textbox',{name:'回复原文'}).inputValue(),originalA,'正文标签仍保存在原文和编辑框内');
   await editAction('取消').click();
   await hidden.getByRole('button',{name:'编辑回复原文'}).waitFor();
   assert.match(await hidden.locator('.play-result').innerText(),/内容已隐藏/);
   assert.equal(await hidden.locator('.play-result').innerText(),'内容已隐藏');
   assert.equal(await hidden.locator('.play-user-message .play-message-actions').isVisible(),false,'短提示词不占用一行返回顶部按钮');
   await a.locator('.play-assistant-message').getByRole('button',{name:'回到这条消息开头',exact:true}).waitFor({state:'visible'});

   const previewRequests=[];
   page.on('request',request=>{if(request.url().includes('preview-should-not-load'))previewRequests.push(request.url());});
   const previews=await page.evaluate(async()=>{
    const {playTextPreview}=await import('/play-render.js');
    return [
     playTextPreview('<!doctype html><html><head><title>雨后的咖啡店</title><style>body{color:red}</style></head><body><p>正文</p><script>window.previewRan=true</script><img src="/preview-should-not-load.png"></body></html>'),
     playTextPreview('```html\n<style>p{color:red}</style><section><h2>第二幕</h2><p>正文</p></section>\n```'),
     playTextPreview('**前言**：雨停了。\n\n<div>网页</div>'),
     playTextPreview('<!doctype html><html><body><script>window.previewRan=true</script></body></html>'),
     window.previewRan===undefined,
    ];
   });
   assert.deepEqual(previews,['雨后的咖啡店','第二幕','前言：雨停了。','网页结果',true]);
   assert.deepEqual(previewRequests,[],'结果摘要不执行网页代码或加载图片');

   const openSettings=async()=>{
    await panel.getByRole('button',{name:'设置',exact:true}).click();
    assert.equal(await panel.locator('.play-dialog').count(),0,'设置统一为整页');
    return panel.locator('.tea-workspace').filter({visible:true});
   };
   const closeSettings=async settingsPage=>{await settingsPage.getByRole('button',{name:viewport.width<=760?'返回剧场演出':'设置',exact:true}).click();};
   let dialog=await openSettings();
   assert.deepEqual(await dialog.locator('.tea-settings-group>h3').allTextContents(),['剧场库','小剧场生成','回复显示','阅读外观','自动重试','小剧场续写']);
   assert.equal(await dialog.locator('.tea-settings-note').count(),0);
   const noChat=dialog.getByRole('switch',{name:'不发送角色聊天，仅读取预设/人设/世界书',exact:true});
   assert.equal(await noChat.isChecked(),false,'首次默认关闭不发送角色聊天');
   await noChat.check();assert.equal(await page.evaluate(()=>fixture.settings.playNoChat),true);
   await noChat.uncheck();assert.equal(await page.evaluate(()=>fixture.settings.playNoChat),false);
   assert.equal(await dialog.getByRole('textbox',{name:'隐藏标签'}).inputValue(),'think,thinking,update,status');
   assert.ok(await dialog.getByRole('textbox',{name:'隐藏标签'}).evaluate(node=>node.clientHeight<60),'默认隐藏名单使用紧凑的一行');
   assert.deepEqual(await dialog.getByRole('combobox',{name:'正文字号'}).locator('option').allTextContents(),Array.from({length:11},(_,i)=>String(12+i*2)));
   assert.ok(await dialog.getByRole('combobox',{name:'正文字号'}).locator('..').locator('strong').evaluate(node=>Number(getComputedStyle(node).fontWeight)>=600),'正文字号名称与其他设置一样加粗');
   assert.equal(await dialog.getByRole('combobox',{name:'自定义小剧场提示词'}).inputValue(),'default');
   const defaultPrompt=await page.evaluate(async()=>(await import('/play-settings.js')).DEFAULT_PLAY_PROMPT);
   assert.equal(await dialog.getByRole('textbox',{name:'小剧场提示词内容',exact:true}).inputValue(),defaultPrompt);
   assert.equal(await dialog.locator('details').evaluate(node=>node.open),false);
   await screenshot(page,`processing-settings-defaults-${viewport.width}.png`);
   await dialog.getByRole('textbox',{name:'隐藏标签'}).fill('think，thinking,\n\nupdate');
   await dialog.locator('summary').click();
   await dialog.getByRole('checkbox',{name:'状态栏美化',exact:true}).waitFor();
   for(const name of ['全局','当前预设','当前角色'])await dialog.getByRole('heading',{name:new RegExp('^'+name)}).waitFor();
   assert.deepEqual(await dialog.locator('.play-regex-owner').allTextContents(),['预设甲','测试甲']);
   assert.equal(await dialog.getByRole('searchbox').count(),0,'正则设置没有搜索控件');
   assert.equal(await dialog.locator('.play-regex-list').evaluate(node=>getComputedStyle(node).borderTopWidth),'0px');
   assert.equal(await dialog.locator('.play-display-settings').evaluate(node=>getComputedStyle(node).borderBottomWidth),'1px','回复显示和下一板块之间保留分割线');
   assert.equal(await a.locator('iframe').count(),0,'关闭设置之前不重建已显示的回复');
   await screenshot(page,`processing-settings-${viewport.width}.png`);
   await closeSettings(dialog);
   await a.frameLocator('iframe').getByText('状态卡：默认隐藏状态',{exact:true}).waitFor();
   await a.frameLocator('iframe').locator('body').evaluate(node=>node.dataset.readingState='kept');
   dialog=await openSettings();await closeSettings(dialog);
   assert.equal(await a.frameLocator('iframe').locator('body').getAttribute('data-reading-state'),'kept','设置未影响显示时保留网页内部状态');
   dialog=await openSettings();await dialog.locator('summary').click();
   await dialog.getByRole('checkbox',{name:'状态栏美化',exact:true}).uncheck();
   assert.equal(await dialog.locator('.play-display-settings').getByRole('checkbox').count(),3,'直接显示三处可用规则');
   const settingTop=await dialog.locator('.tea-settings').evaluate(node=>{node.scrollTop=500;return node.scrollTop;});
   await page.evaluate(()=>ui.refresh());
   assert.equal(await dialog.locator('details').evaluate(node=>node.open),true,'重新显示设置时保留正则展开状态');
   assert.equal(await dialog.getByRole('searchbox').count(),0);
   assert.ok(Math.abs(await dialog.locator('.tea-settings').evaluate(node=>node.scrollTop)-settingTop)<2,'保留设置页滚动位置');
   for(const size of ['12','22','32']) {
    await dialog.getByRole('combobox',{name:'正文字号'}).selectOption(size);
    await page.evaluate(()=>ui.refresh());
    assert.equal(await dialog.getByRole('combobox',{name:'正文字号'}).inputValue(),size);
    assert.equal(await panel.evaluate(node=>getComputedStyle(node).getPropertyValue('--tea-body-size').trim()),`${size}px`);
   }
   assert.ok(Math.abs(await dialog.locator('.tea-settings').evaluate(node=>node.scrollTop)-settingTop)<2,'改字号不回到顶部');
   assert.equal(await dialog.locator('details').evaluate(node=>node.open),true);
   await dialog.getByRole('combobox',{name:'正文字号'}).selectOption('16');
   if(viewport.width>760){
    assert.equal(await dialog.getByRole('button',{name:'紧凑',exact:true}).getAttribute('aria-pressed'),'true','目录默认使用紧凑间距');
    await dialog.getByRole('button',{name:'舒展',exact:true}).click();
    const person=panel.locator('.play-person').first(),roomy=(await person.boundingBox()).height;
    await dialog.getByRole('button',{name:'紧凑',exact:true}).click();
    assert.ok((await person.boundingBox()).height<roomy,'目录间距同样调整角色列表');
    await dialog.getByRole('button',{name:'舒展',exact:true}).click();
    assert.equal((await person.boundingBox()).height,roomy);
   }
   await dialog.getByRole('button',{name:'刷新列表',exact:true}).click();
   assert.equal(await dialog.getByRole('checkbox',{name:'状态栏美化',exact:true}).isChecked(),false);
   await dialog.getByRole('switch',{name:'沿用酒馆正则'}).uncheck();
   await dialog.getByText('正则已停用，勾选项将在重新开启后生效。',{exact:true}).waitFor();
   assert.equal(await dialog.locator('.play-regex-list.is-paused').count(),1);
   await dialog.getByRole('switch',{name:'沿用酒馆正则'}).check();
   assert.equal(await dialog.getByRole('checkbox',{name:'状态栏美化',exact:true}).isChecked(),false);
   await closeSettings(dialog);assert.equal(await a.locator('iframe').count(),0);
   assert.match(await a.locator('.play-result').innerText(),/默认隐藏状态/);
   assert.doesNotMatch(await a.locator('.play-result').innerText(),/<\/?status>/,'排除状态栏正则后，保留正文但仍隐藏英文标签');
   // Let the mobile view finish reattaching before simulating a new scroll.
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const scrollTop=await panel.locator('.play-feed').evaluate(node=>{node.scrollTop=180;return node.scrollTop;});
   assert.ok(scrollTop>0);
   await page.waitForTimeout(50);
   dialog=await openSettings();await closeSettings(dialog);
   await page.waitForFunction(top=>Math.abs(document.querySelector('.play-feed').scrollTop-top)<2,scrollTop);
   if(viewport.width<=760) await panel.getByRole('button',{name:'选择角色',exact:true}).filter({visible:true}).click();
   assert.equal(await panel.locator('.play-people').getByRole('button',{name:'测试甲',exact:true}).getAttribute('aria-pressed'),'true','退出整页设置仍回到原角色记录');
   if(viewport.width<=760) await panel.getByRole('button',{name:'返回演出记录',exact:true}).click();

   await hidden.getByRole('button',{name:'编辑回复原文'}).click();
   let edit=hidden.getByRole('group',{name:'编辑回复原文',exact:true}), editor=edit.getByRole('textbox',{name:'回复原文'});
   assert.equal(await panel.locator('.play-dialog').count(),0,'小铅笔直接编辑原消息，不打开弹窗');
   assert.equal(await hidden.locator('.play-result .play-edit-form').count(),1);
   assert.equal(await hidden.getByRole('button',{name:'编辑回复原文'}).isVisible(),false);
   assert.equal(await hidden.locator('.play-again').isDisabled(),true);
   assert.equal(await hidden.locator('.play-assistant-message>.play-message-actions').isVisible(),false,'编辑时隐藏底部操作栏');
   assert.equal(await hidden.locator('.play-count').isDisabled(),true);
   assert.equal(await panel.locator('.play-compose').isVisible(),viewport.width>760,'手机编辑 AI 消息时隐藏底部输入区域，桌面保持原布局');
   assert.equal(await hidden.getByText('回复原文',{exact:true}).count(),0,'不显示多余的原文标题');
   for(const name of ['保存','取消']){
    const action=editAction(name);
    assert.equal(await action.textContent(),'','保存和取消只能显示图标');
    assert.equal(await action.locator('svg').count(),1);
    assert.equal(await hidden.locator('.play-assistant-meta').getByRole('button',{name,exact:true}).count(),1);
   }
   const saveBox=await editAction('保存').boundingBox(),editorBox=await editor.boundingBox();
   const messageBox=await hidden.locator('.play-user-message').boundingBox();
   assert.ok(Math.abs(editorBox.x-messageBox.x)<1,'编辑区底色与消息框左边对齐');
   assert.ok(Math.abs(editorBox.width-messageBox.width)<1,'编辑区底色与消息框宽度一致');
   const textStart=await editor.evaluate(node=>node.getBoundingClientRect().left+parseFloat(getComputedStyle(node).paddingLeft));
   assert.ok(Math.abs(textStart-(await hidden.locator('.play-user-text').boundingBox()).x)<1,'编辑文字与消息正文对齐');
   await assertUnframed(editor);
   if(viewport.width<=760)assert.ok(editorBox.height>400,'手机回复编辑框占据大部分可见区域');
   else assert.ok(editorBox.height<150,'桌面短回复的编辑框按内容显示，不撑满半屏');
   assert.ok(saveBox.y+saveBox.height<=editorBox.y,'保存图标位于编辑框上方');
   assert.ok(saveBox.x>editorBox.x+editorBox.width/2,'保存图标位于消息右侧');
   assert.equal(await editor.inputValue(),'<thinking>找回整段小剧场</thinking>');
   await editor.fill('<thinking>思考</thinking>\n修正后的正文');
   if(viewport.width<=760)assert.ok((await editor.boundingBox()).height>400,'手机输入两行正文后仍保留大编辑区域');
   else assert.ok((await editor.boundingBox()).height<150,'桌面输入两行正文后仍保持紧凑高度');
   dialog=await openSettings();await closeSettings(dialog);
   assert.equal(await editor.inputValue(),'<thinking>思考</thinking>\n修正后的正文','设置返回及显示刷新不覆盖编辑草稿');
   assert.ok(await editor.evaluate(node=>parseFloat(getComputedStyle(node).fontSize))>=(viewport.width<761?16:14));
   await screenshot(page,`processing-editor-${viewport.width}.png`);
   await page.evaluate(async id=>{
    const round=await runtime.getRound(id),resultId=crypto.randomUUID(),startedAt=new Date().toISOString();
    await testHistory.begin({roundId:id,character:ctx.characters[0],resultId,startedAt,context:round.results[0].context});
    await testHistory.saveResult(id,resultId,{text:'另一窗口新增的结果',status:'complete',finishedAt:startedAt});
    ui.refresh();
   },ids.hidden);
   await page.waitForFunction(id=>document.querySelector(`[data-record="${id}"] .play-count`)?.getAttribute('aria-label')==='第 1 / 2 个结果，选择历史结果',ids.hidden);
   assert.equal(await edit.isVisible(),true,'其他窗口新增结果后，原消息仍保持编辑状态');
   assert.equal(await editor.inputValue(),'<thinking>思考</thinking>\n修正后的正文');
   assert.equal(await hidden.getByRole('button',{name:'下一个结果',exact:true,includeHidden:true}).isDisabled(),true);
   await page.evaluate(()=>window.failSave=true);
   await editAction('保存').click();
   await edit.getByRole('alert').getByText('模拟保存失败',{exact:true}).waitFor();
   assert.equal(await editor.inputValue(),'<thinking>思考</thinking>\n修正后的正文');
   assert.equal((await page.evaluate(id=>runtime.getRound(id),ids.hidden)).results[0].text,'<thinking>找回整段小剧场</thinking>');
   await page.evaluate(()=>{window.failSave=false;window.holdSave=true;});await editAction('保存').click();
   await page.waitForFunction(()=>typeof window.resumeSave==='function');
   assert.equal(await editAction('保存').textContent(),'','保存过程中也只显示图标');
   assert.equal(await editAction('保存').getAttribute('aria-busy'),'true');
   await panel.getByRole('button',{name:'设置',exact:true}).click();
   assert.equal(await panel.getAttribute('data-mode'),'list','保存时不会切走原消息');
   await panel.getByRole('button',{name:'关闭面板',exact:true}).click();
   assert.equal(await panel.isVisible(),true,'保存时不能关闭面板');
   assert.equal(await editor.isDisabled(),true);
   await page.evaluate(()=>{window.holdSave=false;window.resumeSave();});
   await hidden.getByText('修正后的正文',{exact:true}).waitFor();
   assert.equal(await panel.locator('.play-compose').isVisible(),true,'保存 AI 消息后恢复底部输入区域');
   await hidden.getByRole('button',{name:'编辑回复原文'}).click();
   edit=hidden.getByRole('group',{name:'编辑回复原文',exact:true});
   await edit.getByRole('textbox',{name:'回复原文'}).fill('取消后不保存');
   await editAction('取消').click();
   assert.equal((await page.evaluate(id=>runtime.getRound(id),ids.hidden)).results[0].text,'<thinking>思考</thinking>\n修正后的正文');
   await hidden.getByRole('button',{name:'下一个结果',exact:true}).click();
   await hidden.getByText('另一窗口新增的结果',{exact:true}).waitFor();
   await hidden.getByRole('button',{name:'上一个结果',exact:true}).click();
   await hidden.getByText('修正后的正文',{exact:true}).waitFor();

   await panel.getByRole('textbox',{name:'小剧场提示词',exact:true}).fill('生成过程验证');
   await panel.getByRole('button',{name:'发送小剧场',exact:true}).click();
   await page.waitForFunction(()=>runtime.getState().phase==='generating');
   const job=await page.evaluate(()=>runtime.getState()), active=panel.locator(`[data-record="${job.roundId}"]`);
   await page.evaluate(()=>window.emitGeneration('<thinking>还没闭合的思考'));
   await active.getByText('还没闭合的思考',{exact:false}).waitFor();
   assert.equal(await active.getByRole('button',{name:'编辑回复原文'}).isVisible(),false);
   await hidden.getByRole('button',{name:'编辑回复原文'}).click();
   edit=hidden.getByRole('group',{name:'编辑回复原文',exact:true});
   await edit.getByRole('textbox',{name:'回复原文'}).fill('生成时保留的编辑草稿');
   await page.evaluate(()=>window.emitGeneration('<thinking>已闭合的思考</thinking>生成正文'));
   await active.getByText('生成正文',{exact:true}).waitFor();
   assert.doesNotMatch(await active.locator('.play-result').innerText(),/已闭合的思考/);
   await page.evaluate(()=>window.finishGeneration('<thinking>已闭合的思考</thinking>生成正文'));
   await active.getByRole('button',{name:'编辑回复原文'}).waitFor();
   assert.equal(await edit.getByRole('textbox',{name:'回复原文'}).inputValue(),'生成时保留的编辑草稿','其他消息生成和保存不覆盖当前编辑框');
   await editAction('取消').click();
   assert.equal((await page.evaluate(()=>window.captured[0])).playPrompt,defaultPrompt);

   await panel.getByRole('textbox',{name:'小剧场提示词',exact:true}).fill('停止时保留未闭合内容');
   await panel.getByRole('button',{name:'发送小剧场',exact:true}).click();
   await page.waitForFunction(()=>runtime.getState().phase==='generating');
   const stoppedId=await page.evaluate(()=>runtime.getState().roundId), stopped=panel.locator(`[data-record="${stoppedId}"]`);
   await page.evaluate(()=>window.emitGeneration('<thinking>停止后也保留'));
   await stopped.locator('.play-stop').waitFor({state:'hidden'});
   await panel.getByRole('button',{name:'停止所有生成',exact:true}).click();
   await stopped.getByRole('button',{name:'编辑回复原文'}).waitFor();
   assert.match(await stopped.locator('.play-result').innerText(),/停止后也保留/);

   if(viewport.width<=760)await panel.getByRole('button',{name:'选择角色',exact:true}).click();
   await panel.locator('.play-people').getByRole('button',{name:'测试乙',exact:true}).click();
   assert.equal(await panel.locator('.play-compose').isVisible(),true,'选择其他角色仍可输入并生成小剧场');
   const b=panel.locator(`[data-record="${ids.b}"]`);
   await b.locator('.play-assistant-meta .play-speaker').getByText('测试乙',{exact:true}).waitFor();
   await b.getByText('乙的规则',{exact:false}).waitFor();
   await b.getByRole('button',{name:'编辑回复原文'}).click();
   edit=b.getByRole('group',{name:'编辑回复原文',exact:true});
   await edit.getByRole('textbox',{name:'回复原文'}).fill('编辑乙的旧记录 角色标记');
   await editAction('保存').click();
   await b.getByText('编辑乙的旧记录 乙的规则',{exact:true}).waitFor();
   await page.evaluate(()=>{ctx.characterId=1;ctx.name2='测试乙';ctx.chatId='B-main';ctx.chatCompletionSettings.preset_settings='预设乙';ctx.eventSource.emit('chatChanged');});
   assert.match(await b.locator('.play-result').innerText(),/乙的规则/,'主聊天切换不改变内容所属角色的正则');
   await panel.getByRole('button',{name:'关闭面板',exact:true}).click();await panel.waitFor({state:'detached'});
   await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
   await panel.locator(`[data-record="${ids.b}"]`).getByText('编辑乙的旧记录 乙的规则',{exact:true}).waitFor();
   await page.evaluate(()=>window.failRegex=true);
   await panel.getByRole('button',{name:'关闭面板',exact:true}).click();await panel.waitFor({state:'detached'});
   await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
   await b.getByText('编辑乙的旧记录 角色标记',{exact:true}).waitFor();
   await panel.getByText('酒馆正则读取失败，请在设置中刷新正则列表后重试。',{exact:true}).waitFor();
   await page.evaluate(()=>window.failRegex=false);

   dialog=await openSettings();await dialog.getByRole('textbox',{name:'小剧场提示词内容',exact:true}).fill('');
   await dialog.getByRole('textbox',{name:'隐藏标签'}).fill('');await closeSettings(dialog);
   await page.reload();await page.waitForFunction(()=>window.ready);
   await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
   await panel.getByRole('button',{name:'剧场演出',exact:true}).click();
   dialog=await openSettings();assert.equal(await dialog.getByRole('textbox',{name:'隐藏标签'}).inputValue(),'');
   assert.equal(await dialog.getByRole('textbox',{name:'小剧场提示词内容',exact:true}).inputValue(),'');
   await closeSettings(dialog);
   await verifyEntryFill(page);
   await verifyPromptEdit(page,viewport,openSettings,closeSettings);
   await verifyUnsavedPromptEdit(page,viewport);
   await verifyFontSource(page,viewport,openSettings,closeSettings);
   const overflow=await panel.evaluate(node=>node.scrollWidth-node.clientWidth);assert.ok(overflow<=1,'手机和桌面面板均无横向溢出');
   assert.deepEqual(errors,[]);
   if(process.env.PLAY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PLAY_SCREENSHOT_DIR,'play-processing-'+viewport.width+'.png')});
   console.log(JSON.stringify({viewport,checks:'settings, regex, streaming, reply/user inline edit including during generation, unsaved reply preserved on prompt edit, save failure/conflict, history, reopen, regenerate edited prompt, repeated entry fill and focus, font source switch and persistence',errors}));
   await context.close();
  }
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
