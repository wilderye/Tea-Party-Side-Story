import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { hash } from '../library.js';

// Only replace the view. Exercise the real update, request, validation and storage code.
const hooks = registerHooks({ load(url, context, next) {
    if (new URL(url).pathname.endsWith('/panel.js')) return {format:'module',shortCircuit:true,source:`
        export function element(tag,text,className) {
            const node={tag,textContent:text,className,children:[],listeners:{},classList:{add(){}},
                append(...items){this.children.push(...items)},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn}};
            globalThis.reviewNodes.push(node);return node;
        }
        export function textButton(text,action) {const node=element('button',text);node.addEventListener('click',action);return node;}
        export function createTheatrePanel(ctx,state,actions) { globalThis.captureReview(state,actions); return {refresh(){},open(){}}; }
    `};
    return next(url,context);
}});
async function pack(id, body='测试正文') {
    const text=JSON.stringify([{id,title:'测试',body,author:'测试茶友',type:'preset',publishedAt:'2026-10-01T00:00:00Z'}]);
    const digest=await hash(text);
    return {text,meta:{path:`packs/2026-10-1-${digest}.json`,sha256:digest,bytes:Buffer.byteLength(text),count:1}};
}
async function withApp(run, initial=[], settingsUI=false) {
    const files=new Map(), calls=[]; let state, remote={format:1,packs:[]}, remoteTexts=new Map(), failUpload=false, gate;
    if(initial.length) {
        files.set('teahouse-index.json',JSON.stringify({format:1,packs:initial.map(p=>p.meta)}));
        for(const p of initial)files.set(`teahouse-${p.meta.sha256}.json`,p.text);
    }
    const settings={favorites:{},enabled:true,libraryUrl:''};
    const context={extensionSettings:{teahouse:settings},chat:[],getRequestHeaders:()=>({}),saveSettingsDebounced(){},registerMacro(){},
        eventTypes:{},eventSource:{on(){}},SlashCommandParser:{addCommandObject(){}},SlashCommand:{fromProps:x=>x}};
    const previous={SillyTavern:globalThis.SillyTavern,document:globalThis.document,fetch:globalThis.fetch,captureReview:globalThis.captureReview,reviewNodes:globalThis.reviewNodes};
    globalThis.reviewNodes=[];
    globalThis.captureReview=s=>{state=s;};globalThis.SillyTavern={getContext:()=>context};globalThis.document={querySelector:selector=>settingsUI && selector.startsWith('#extensions_settings') ? {append(){}} : null};
    globalThis.fetch=async(url,options={})=>{
        const u=String(url);calls.push(u);
        if(u==='/api/files/upload') {
            if(failUpload)return new Response('',{status:503});
            const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString());return new Response('{}');
        }
        if(u.startsWith('https:')) {
            if(gate){await gate; if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');}
            if(u.endsWith('/access/challenge'))return Response.json({nonce:'0'.repeat(32),bits:14,challenge:'fake'});
            if(u.endsWith('/access/redeem'))return Response.json({token:'fake-token'});
            if(u.endsWith('/manifest.json'))return Response.json(remote);
            const p=new URL(u).pathname.replace(/^\//,'');return remoteTexts.has(p)?new Response(remoteTexts.get(p)):new Response('',{status:404});
        }
        if(u.endsWith('/config.json'))return Response.json({libraryUrl:''});
        const name=u.split('/').at(-1);return files.has(name)?new Response(files.get(name)):new Response('',{status:404});
    };
    try {
        const app=await import(`../index.js?review=${randomUUID()}`);
        await run({app,state,settings,files,calls,nodes:globalThis.reviewNodes,remote:p=>{remote={format:1,packs:p.map(x=>x.meta)};remoteTexts=new Map(p.map(x=>[x.meta.path,x.text]));},failWrites:()=>{failUpload=true;},block:p=>{gate=p;}});
    } finally {Object.assign(globalThis,previous);}
}
test('未填地址和无效地址给出中文提示；修改后清除旧错误并可成功重试',async()=>withApp(async({app,state,calls})=>{
    await app.updateLibrary();assert.match(state.status,/请先.*填写剧场库地址/);assert.doesNotMatch(state.status,/Invalid URL/);
    assert.doesNotMatch(state.status,/原有剧场保持可用/,'还没有旧库时不能声称旧库可用');
    assert.equal(calls.filter(x=>x.startsWith('https:')).length,0);assert.equal(state.updating,false);
    app.setLibraryUrl('not a url');assert.equal(state.status,'');await app.updateLibrary();assert.match(state.status,/地址格式不正确/);
    app.setLibraryUrl(' https://library.test/ ');assert.equal(state.status,'');await app.updateLibrary();assert.match(state.status,/更新完成/);
}));
test('修改地址不会清除其他功能的错误',async()=>withApp(async({app,state})=>{
    state.status='个人文件读取失败';state.statusKind='';app.setLibraryUrl('https://library.test/');assert.equal(state.status,'个人文件读取失败');
}));
test('重复点击只执行一次；更新中改地址取消旧请求且不留下旧错误',async()=>withApp(async({app,state,block,calls,files})=>{
    let release;block(new Promise(resolve=>{release=resolve;}));app.setLibraryUrl('https://library.test/');
    const pending=app.updateLibrary();await new Promise(resolve=>setImmediate(resolve));await app.updateLibrary();
    assert.equal(calls.filter(x=>x.endsWith('/access/challenge')).length,1);
    app.setLibraryUrl('https://new.test/');release();await pending;
    assert.equal(state.updating,false);assert.equal(state.status,'');assert.equal(files.has('teahouse-index.json'),false);
}));
test('更新时复用的缓存破损会重新下载，不让损坏缓存永久阻塞更新',async()=>{
    const a=await pack('123456789012345678'),b=await pack('223456789012345678');
    await withApp(async({app,state,files,remote})=>{
        files.set(`teahouse-${a.meta.sha256}.json`,'broken');remote([a,b]);app.setLibraryUrl('https://library.test/');await app.updateLibrary();
        assert.equal(state.community.size,2);assert.equal(files.get(`teahouse-${a.meta.sha256}.json`),a.text);assert.match(state.status,/更新完成/);
    },[a]);
});
test('新包保存失败时保留原清单和原有剧场',async()=>{
    const a=await pack('123456789012345678'),b=await pack('223456789012345678');
    await withApp(async({app,state,files,remote,failWrites})=>{
        const before=files.get('teahouse-index.json');remote([a,b]);failWrites();app.setLibraryUrl('https://library.test/');await app.updateLibrary();
        assert.equal(files.get('teahouse-index.json'),before);assert.equal(state.community.size,1);assert.match(state.status,/503/);assert.equal(state.updating,false);
        assert.match(state.status,/原有剧场保持可用/);
    },[a]);
});
test('扩展地址框的 input 事件立即保存并清除旧更新错误，无需先失焦',async()=>withApp(async({app,state,settings,nodes})=>{
    await app.updateLibrary();assert.match(state.status,/请先/);
    const address=nodes.find(node=>node.tag==='input' && node.type==='password');
    assert.equal(typeof address.listeners.input,'function');address.value='https://library.test/';address.listeners.input();
    assert.equal(settings.libraryUrl,'https://library.test/');assert.equal(state.status,'');
    const status=nodes.find(node=>node.tag==='small');assert.equal(status.hidden,true);
},[],true));
test('更新结果五秒后清除；重试取消旧计时，进行中的提示不自动消失',async t=>{
    const realTimeout=globalThis.setTimeout, realClear=globalThis.clearTimeout, timers=new Map();
    t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{
        if(ms!==5000)return realTimeout(fn,ms,...args);
        const handle={unref(){}};timers.set(handle,fn);return handle;
    });
    t.mock.method(globalThis,'clearTimeout',handle=>{if(!timers.delete(handle))realClear(handle);});
    await withApp(async({app,state,block})=>{
        app.setLibraryUrl('https://library.test/');await app.updateLibrary();
        await app.updateLibrary();assert.equal(state.status,'茶会选集已是最新');assert.equal(timers.size,1);
        const expire=[...timers.values()][0];expire();assert.equal(state.status,'');assert.equal(timers.size,0);
        await app.updateLibrary();assert.equal(timers.size,1);
        let release;block(new Promise(resolve=>{release=resolve;}));const pending=app.updateLibrary();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(state.status,'正在检查更新…');assert.equal(timers.size,0,'旧结果计时已取消，进度没有计时');
        release();await pending;assert.equal(timers.size,1);[...timers.values()][0]();assert.equal(state.status,'');
    });
});
test.after(()=>hooks.deregister());
