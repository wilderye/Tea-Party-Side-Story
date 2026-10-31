const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = harness.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace('import {createTheatrePanel}', `
        window.fileReads=[]; window.watchedBodies=[]; window.hiddenWrites=[]; window.classWrites=[];
        const hiddenProperty=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'hidden');
        Object.defineProperty(HTMLElement.prototype,'hidden',{...hiddenProperty,set(value){
            if(window.watchedBodies.some(node=>this===node||this.contains(node)))window.hiddenWrites.push(value);
            hiddenProperty.set.call(this,value);
        }});
        new MutationObserver(changes=>{
            for(const change of changes)if(change.target.matches('.tea-panel-surface')&&change.oldValue===change.target.getAttribute('class'))window.classWrites.push(change.oldValue);
        }).observe(document.body,{subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['class']});
        import {createPlayChatFavorites} from '/play-chat-favorites.js';
        import {createTheatrePanel}`)
    .replace('const files=new Map', 'const files=window.syntheticFiles=new Map')
    .replace('readFile:async name=>files.get(name)??null', 'readFile:async name=>{window.fileReads.push(name);return files.get(name)??null}')
    .replace('const ui=window.ui', 'window.createColdHistory=()=>createPlayHistory({readFile:async name=>{fileReads.push(name);return files.get(name)??null},writeFile:async(name,text)=>files.set(name,text),removeFile:async name=>files.delete(name),uuid:()=>crypto.randomUUID()});window.createFavoriteService=history=>createPlayChatFavorites(history,runtime.display);\nconst ui=window.ui');
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://test').pathname.slice(1));
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        const file = path.resolve(root, name);
        if (!file.startsWith(root + path.sep) || !/\.(js|css|svg|woff2)$/.test(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(file));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const active = '.tea-panel-surface[data-active=true]';
const panel = page => page.locator(active);
const button = (page, name) => panel(page).getByRole('button', { name, exact: true }).filter({ visible: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function open(page, url) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
}
async function watch(page, selector) {
    await settle(page);
    await page.evaluate(selector => {
        watchedBodies=[...document.querySelectorAll('.tea-panel-surface[data-active=true] '+selector)];
        window.watchedParents=watchedBodies.map(node=>node.parentElement);
        hiddenWrites=[]; classWrites=[]; fileReads=[];
    }, selector);
    assert.ok(await page.evaluate(() => watchedBodies.length > 0));
}
async function preserved(page, label) {
    await settle(page);
    assert.equal(await page.evaluate(() => watchedBodies.every((node,index)=>node.isConnected && node.parentElement===watchedParents[index])), true, label);
    assert.deepEqual(await page.evaluate(() => hiddenWrites), [], label+'没有隐藏旧正文');
    assert.deepEqual(await page.evaluate(() => classWrites), [], label+'没有重复写入面板样式');
}
async function seedChat(page, pairs = 16) {
    await page.evaluate(async pairs => {
        const round=await testHistory.getRound(seed.a);
        window.longBody=Array.from({length:120},(_,index)=>'合成段落'+index+'：窗外风轻轻吹过，桌上茶水泛起涟漪。'.repeat(3)).join('\n\n');
        await testHistory.editResult(round.id,round.results[0].id,longBody,round.results[0].text);
        for(let index=0;index<pairs;index++){
            const resultId=crypto.randomUUID();
            await testHistory.begin({roundId:round.id,chatMode:true,operation:'send',prompt:'合成用户消息'+index,
                character:ctx.characters[0],context:round.results[0].context,resultId,startedAt:new Date(Date.UTC(2026,0,2,0,0,index)).toISOString()});
            await testHistory.saveResult(round.id,resultId,{text:longBody,status:'complete',finishedAt:new Date().toISOString()});
        }
    }, pairs);
}
async function playPaths(page, url, viewport) {
    await open(page, url);
    await page.evaluate(async () => {
        const original=await runtime.getRound(seed.a), rounds=new Map();
        const text=Array.from({length:120},(_,i)=>'合成长正文'+i+'。'.repeat(12)).join('\n\n');
        for(let index=0;index<180;index++){
            const round=structuredClone(original);round.id=crypto.randomUUID();round.createdAt=new Date(Date.UTC(2026,0,2,0,0,index)).toISOString();
            round.prompt='合成提示词'+index;round.results[0].id=crypto.randomUUID();round.results[0].text=text;rounds.set(round.id,round);
        }
        const list=runtime.listRounds.bind(runtime),read=runtime.getRound.bind(runtime);
        runtime.createRoundReader=undefined;
        runtime.listRounds=id=>id===original.characterId?Promise.resolve([...rounds.values()].map(round=>({id:round.id,revision:round.id,characterId:round.characterId,createdAt:round.createdAt}))):list(id);
        window.roundReads=0;runtime.getRound=id=>{if(rounds.has(id)){roundReads++;return Promise.resolve(structuredClone(rounds.get(id)));}return read(id);};
    });
    await page.locator('#open').click(); await button(page,'剧场演出').click();
    await page.waitForFunction(() => document.querySelectorAll('.tea-panel-surface[data-active=true] .play-record:not([hidden])').length===10);
    assert.equal(await page.evaluate(() => roundReads), 10, '首次演出范围10条');
    const paths = [
        ['设置', async()=>{await button(page,'设置').click();await button(page,viewport.width>760?'设置':'返回剧场演出').click();}],
        ['帮助', async()=>{await button(page,'设置').click();await button(page,'随文剧场用法').click();await button(page,'返回设置').click();await button(page,viewport.width>760?'设置':'返回剧场演出').click();}],
        ['历史', async()=>{await button(page,'历史记录').click();await panel(page).locator('.play-history-row').first().waitFor();await button(page,'历史记录').click();}],
        ...['茶会选集','亲笔手稿','我的收藏'].map(name=>[name,async()=>{await button(page,name).click();await button(page,'剧场演出').click();}]),
        ...(viewport.width<=760?[['角色选择',async()=>{await button(page,'选择角色').click();await button(page,'返回演出记录').click();}]]:[]),
    ];
    for(const [name,action] of paths){await watch(page,'.play-prose');const reads=await page.evaluate(()=>roundReads);await action();await preserved(page,'演出往返'+name);assert.equal(await page.evaluate(()=>roundReads),reads);}
    await button(page,'关闭面板').click();await page.locator('#open').click();
    await page.waitForFunction(() => document.querySelectorAll('.tea-panel-surface[data-active=true] .play-record:not([hidden])').length===10);
    await button(page,'历史记录').click();
    if(viewport.width<=760){
        const bounds=await panel(page).locator('.tea-mobile-actions .tea-history-toggle').evaluate(node=>{const r=node.getBoundingClientRect();return [r.width,r.height];});
        assert.equal(bounds[0],bounds[1]);
        assert.equal(await panel(page).locator('.tea-mobile-tabs').evaluate(node=>new DOMMatrixReadOnly(getComputedStyle(node).transform).m42),0);
    }
}
async function branchPaths(page, url, viewport) {
    await open(page,url);await seedChat(page);
    await page.evaluate(()=>{
        const factory=runtime.createChatDirectoryReader.bind(runtime);
        runtime.createChatDirectoryReader=async()=>{const read=await factory();return async(...args)=>{await new Promise(resolve=>{(window.previewReleases??=[]).push(resolve)});return read(...args);};};
    });
    await page.locator('#open').click();await button(page,'剧场演出').click();await panel(page).locator('.play-prose').first().waitFor();
    await button(page,'历史记录').click();await panel(page).locator('.play-history-open').first().waitFor();
    assert.ok(await page.evaluate(()=>previewReleases.length>0),'历史目录不等预览全部读完');
    await page.evaluate(()=>previewReleases.forEach(resolve=>resolve()));
    await panel(page).locator(`[data-chat-id="${await page.evaluate(()=>seed.a)}"] .play-history-open`).click();
    await page.waitForFunction(()=>document.querySelectorAll('.tea-panel-surface[data-active=true] .play-branch-page [data-message-id]').length===24);
    for(const [name,action] of [
        ['设置',async()=>{await button(page,'设置').click();await button(page,viewport.width>760?'设置':'返回剧场演出').click();}],
        ['历史',async()=>{await button(page,'历史记录').click();await panel(page).locator(`[data-chat-id="${await page.evaluate(()=>seed.a)}"] .play-history-open`).click();}],
        ['其他栏目',async()=>{await button(page,'茶会选集').click();await button(page,'剧场演出').click();}],
        ...(viewport.width<=760?[['角色选择',async()=>{await button(page,'选择角色').click();await button(page,'返回历史记录').click();}]]:[]),
    ]){await watch(page,'.play-branch-page .play-prose');await action();await preserved(page,'分支往返'+name);assert.equal(await page.evaluate(()=>fileReads.filter(name=>name.startsWith('teahouse-play-body-')).length),0);}
    await button(page,'历史记录').click();
    for(let index=0;index<8;index++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[aria-hidden=true]')),false);}
    await page.evaluate(()=>window.watchedBodies=[]);
}
async function favoriteAndCatalog(page,url,viewport){
    await open(page,url);await seedChat(page,28);
    await page.evaluate(async()=>{
        const service=createFavoriteService(testHistory);window.savedFavorite=await service.add(seed.a);
        const cold=createColdHistory(),favorites=createFavoriteService(cold);
        runtime.getFavoriteWindow=(id,options)=>favorites.read(id,options);runtime.syncFavorite=(id,options)=>favorites.sync(id,options);
        runtime.listFavorites=()=>cold.listFavorites();
        for(let index=0;index<5;index++)fixture.community.set('synthetic-'+index,{id:'synthetic-'+index,title:'合成目录'+index,type:'standalone',body:longBody,author:'合成作者',publishedAt:'2026-01-01'});
        fileReads=[];
    });
    await page.locator('#open').click();await button(page,'我的收藏').click();await button(page,'演出记录').click();
    if(viewport.width<=760)await panel(page).locator(`[data-id="${await page.evaluate(()=>savedFavorite.id)}"].tea-story`).click();
    const reader=panel(page).locator('.play-favorite-reading[data-active=true]');
    await reader.locator('.play-message').nth(23).waitFor();await settle(page);
    assert.equal(await reader.locator('.play-favorite-content > .play-message').count(),24);
    assert.equal(await page.evaluate(()=>fileReads.filter(name=>name.startsWith('teahouse-play-body-')).length),24);
    await watch(page,'.play-favorite-reading[data-active=true] .play-prose');await page.evaluate(()=>ui.refresh());await settle(page);await preserved(page,'收藏未变刷新');
    assert.equal(await page.evaluate(()=>fileReads.filter(name=>name.startsWith('teahouse-play-body-')).length),0);
    await button(page,'设置').click();await button(page,viewport.width>760?'设置':'返回列表').click();await preserved(page,'收藏设置往返');
    await page.evaluate(async()=>{const chat=await testHistory.getChat(seed.a);await testHistory.editMessage(chat.id,chat.messages[0].id,{text:'来源更新后的消息',expectedText:chat.messages[0].text});ui.refresh();});
    await reader.getByText('来源更新后的消息',{exact:true}).waitFor();
    await page.evaluate(()=>{
        const sync=runtime.syncFavorite;
        runtime.syncFavorite=async(...args)=>{await new Promise(resolve=>window.releaseFavoriteSync=resolve);return sync(...args);};ui.refresh();
    });
    await page.waitForFunction(()=>typeof releaseFavoriteSync==='function');
    if(viewport.width<=760)await button(page,'返回收藏目录').click();
    await button(page,'茶会选集').click();
    await page.evaluate(()=>{
        window.hiddenFavorite= document.querySelector('.play-favorite-reading');window.hiddenFavoriteMutations=0;
        window.favoriteObserver=new MutationObserver(changes=>hiddenFavoriteMutations+=changes.length);
        favoriteObserver.observe(hiddenFavorite,{subtree:true,childList:true,attributes:true,characterData:true});releaseFavoriteSync();
    });
    await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>hiddenFavoriteMutations),0);
    await page.evaluate(()=>{favoriteObserver.disconnect();delete releaseFavoriteSync;});
    await button(page,'我的收藏').click();
    if(viewport.width<=760)await panel(page).locator(`[data-id="${await page.evaluate(()=>savedFavorite.id)}"].tea-story`).click();
    await page.waitForFunction(()=>typeof releaseFavoriteSync==='function');await page.evaluate(()=>releaseFavoriteSync());
    await page.evaluate(()=>{watchedBodies=[];fileReads=[];});
    await reader.getByRole('button',{name:'显示更多聊天内容',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.tea-panel-surface[data-active=true] .play-favorite-content > .play-message').length===48);
    assert.equal(await page.evaluate(()=>fileReads.filter(name=>name.startsWith('teahouse-play-body-')).length),24);
    if(viewport.width<=760)await button(page,'返回收藏目录').click();
    await button(page,'茶会选集').click();await panel(page).locator('.tea-body').first().waitFor();
    if(viewport.width<=760){assert.ok(await panel(page).locator('.tea-body p').count()<600);assert.equal(await panel(page).locator('.tea-reading').count(),0);}
    await watch(page,'.tea-body');await page.evaluate(()=>ui.refresh());await preserved(page,'目录未变刷新');
    await button(page,'设置').click();await button(page,viewport.width>760?'设置':'返回列表').click();await preserved(page,'目录设置往返');
}
(async()=>{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({channel:'msedge',headless:true});
    const url='http://127.0.0.1:'+server.address().port+'/';
    try{
        for(const viewport of [{width:1332,height:896},{width:390,height:844},{width:320,height:640}]){
            for(const [name,run] of [['play',playPaths],['branch',branchPaths],['favorite-catalog',favoriteAndCatalog]]){
                const context=await browser.newContext({viewport,isMobile:viewport.width<=760,hasTouch:viewport.width<=760});
                const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
                try{await run(page,url,viewport);assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(),0);assert.deepEqual(errors,[]);
                    if(process.env.TEA_QA_DIR){await fs.mkdir(process.env.TEA_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEA_QA_DIR,'surfaces-'+name+'-'+viewport.width+'.png')});}
                    console.log(JSON.stringify({viewport,name,url,passed:true,errors}));
                }finally{await context.close();}
            }
        }
    }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
