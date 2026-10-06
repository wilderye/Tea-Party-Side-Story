import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readManuscripts, pruneCommunityFavorites, findEntries } from '../library.js';

async function withApp(run, unreadable=false) {
    const files=new Map(), macros=new Map(), events=new Map();let fail=false;
    const settings={favorites:{},enabled:true,pageSize:10,libraryUrl:''};
    const context={extensionSettings:{teahouse:settings},chat:[],getCurrentChatId:()=> 'test',getRequestHeaders:()=>({'Content-Type':'application/json'}),uuidv4:randomUUID,
        eventTypes:Object.fromEntries(['GENERATION_STARTED','GENERATION_AFTER_COMMANDS','GENERATE_AFTER_DATA','STREAM_TOKEN_RECEIVED','GENERATION_STOPPED','TOOL_CALLS_PERFORMED','GENERATION_ENDED','CHAT_CHANGED','MESSAGE_RECEIVED'].map(x=>[x,x])),
        eventSource:{on:(name,fn)=>events.set(name,fn)},registerMacro:(name,fn)=>macros.set(name,fn),saveSettingsDebounced(){},substituteParams:x=>x,
        SlashCommandParser:{addCommandObject(){}},SlashCommand:{fromProps:x=>x}};
    const before={SillyTavern:globalThis.SillyTavern,document:globalThis.document,fetch:globalThis.fetch};
    globalThis.SillyTavern={getContext:()=>context};globalThis.document={querySelector:()=>null};
    globalThis.fetch=async(url,options)=>{
        if(String(url)==='/api/files/upload'){
            if(fail)return new Response('write failed',{status:503});
            const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return new Response('{}');
        }
        if(unreadable && String(url).endsWith('manuscripts.json'))return new Response('denied',{status:403});
        const name=String(url).split('/').at(-1);
        return files.has(name)?new Response(files.get(name)):new Response('',{status:404});
    };
    try { const app=await import(`../index.js?personal=${randomUUID()}`);await run({app,files,settings,macros,context,
        failWrites:value=>{fail=value;},emit:(event,...args)=>events.get(event)?.(...args)}); }
    finally {Object.assign(globalThis,before);}
}
test('个人手稿保存、编辑、失败保护、收藏宏和删除共用同一份内容',async()=>withApp(async({app,files,settings,macros,emit,failWrites})=>{
    const saved=await app.saveManuscript({title:'我的手稿',type:'preset',body:'正文'.repeat(3000)});
    assert.equal(saved.body.length,6000);assert.equal(Object.hasOwn(saved,'author'),false);
    const firstFile=files.get('teahouse-manuscripts.json');assert.equal(readManuscripts(JSON.parse(firstFile)).size,1);
    settings.favorites[saved.id]=100;
    await emit('GENERATION_AFTER_COMMANDS','normal',{},false);
    assert.equal(macros.get('茶话会小剧场')(),saved.body,'所有随文宏包含亲笔手稿');
    assert.equal(macros.get('我收藏的小剧场')(),saved.body);
    failWrites(true);
    await assert.rejects(app.saveManuscript({...saved,body:'失败的改动'}),/503/);
    await assert.rejects(app.deleteManuscript(saved.id),/503/);
    assert.equal(files.get('teahouse-manuscripts.json'),firstFile);
    assert.equal(settings.favorites[saved.id],100);
    await emit('GENERATION_ENDED');await emit('GENERATION_AFTER_COMMANDS','normal',{},false);
    assert.equal(macros.get('我收藏的小剧场')(),saved.body,'失败不能修改内存中的已保存正文');
    failWrites(false);
    const edited=await app.saveManuscript({...saved,title:'新标题',body:'已修改'});
    assert.equal(edited.id,saved.id);assert.equal(edited.publishedAt,saved.publishedAt);assert.equal(settings.favorites[saved.id],100);
    app.setEnabled(false);assert.equal(macros.get('我收藏的小剧场')(),'');
    await assert.rejects(app.saveManuscript({...edited,body:'停用中'}),/停用/);
    app.setEnabled(true);await app.deleteManuscript(saved.id);
    assert.equal(JSON.parse(files.get('teahouse-manuscripts.json')).entries.length,0);assert.equal(settings.favorites[saved.id],undefined);
    await emit('GENERATION_ENDED');await emit('GENERATION_AFTER_COMMANDS','normal',{},false);
    assert.equal(macros.get('我收藏的小剧场')(),'');
}));
test('个人文件无法读取时不允许用空库覆盖它',async()=>withApp(async({app,files})=>{
    await assert.rejects(app.saveManuscript({title:'新手稿',type:'standalone',body:'文字'}),/读取失败/);
    await assert.rejects(app.deleteManuscript('local:'+randomUUID()),/读取失败/);
    assert.equal(files.size,0);
},true));

test('所有随文宏抽取未收藏手稿、排除独立剧场，同轮复用且续写保留原条',async()=>withApp(async({app,settings,macros,emit,context})=>{
    await app.saveManuscript({title:'独立稿',type:'standalone',body:'不应抽取'});
    const a=await app.saveManuscript({title:'随文甲',type:'preset',body:'甲正文'});
    const b=await app.saveManuscript({title:'随文乙',type:'preset',body:'乙正文'});
    const all=macros.get('茶话会小剧场'),favorites=macros.get('我收藏的小剧场');
    await emit('GENERATION_STARTED','normal',{},false);
    await emit('GENERATION_AFTER_COMMANDS','normal',{},false);
    const first=all();assert.ok([a.body,b.body].includes(first));assert.equal(all(),first);assert.equal(favorites(),'');
    await emit('GENERATE_AFTER_DATA',{},false);
    context.chat.push({is_user:false,mes:'测试回复'});await emit('MESSAGE_RECEIVED',0);
    const savedId=context.chat[0].extra.teahouse.id;assert.equal(savedId,settings.lastId);
    await emit('GENERATION_ENDED');await emit('GENERATION_AFTER_COMMANDS','continue',{},false);
    assert.equal(all(),first,'续写沿用抽中的个人手稿');
    await emit('GENERATION_ENDED');await emit('GENERATION_AFTER_COMMANDS','normal',{},false);
    assert.equal(all(),first===a.body?b.body:a.body,'两条可选时避开紧邻上次');
}));
test('并发保存不会相互覆盖',async()=>withApp(async({app,files})=>{
    const result=await Promise.allSettled([app.saveManuscript({title:'甲',type:'standalone',body:'甲'}),app.saveManuscript({title:'乙',type:'standalone',body:'乙'})]);
    assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
    assert.match(result.find(x=>x.status==='rejected').reason.message,/正在保存/);
    assert.equal(JSON.parse(files.get('teahouse-manuscripts.json')).entries.length,1);
}));
test('社区更新只清除社区收藏；收藏按类型筛选且搜索不要求个人署名',()=>{
    const local={id:'local:'+randomUUID(),title:'私稿',type:'preset',body:'小狗',publishedAt:'2026-10-03T00:00:00Z'};
    const community={id:'123456789012345678',title:'社区',type:'standalone',body:'小狗',author:'茶友',publishedAt:local.publishedAt};
    const favorites={[local.id]:20,[community.id]:10,'223456789012345678':5};
    pruneCommunityFavorites(favorites,new Map([[community.id,community]]));
    assert.deepEqual(Object.keys(favorites).sort(),[local.id,community.id].sort());
    const entries=new Map([[local.id,local],[community.id,community]]);
    assert.deepEqual(findEntries(entries,{scope:'favorites',type:'preset',query:'小狗',favorites}),[local]);
    assert.deepEqual(findEntries(entries,{scope:'local',type:'preset'}),[local]);
    assert.deepEqual(findEntries(entries,{scope:'community',type:'standalone'}),[community]);
});
