import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../library.js';
test('实际扩展事件：一次固定、重新生成换条、续写恢复、无宏不抽取', async () => {
    const items = ['123456789012345678','223456789012345678'].map((id,index)=>({id,title:`剧场${index}`,body:`${index}:{{char}}和{{user}}`,type:'preset',author:'茶友',publishedAt:'2026-10-01T00:00:00Z'}));
    const text=JSON.stringify(items), sha256=await hash(text);
    const manifest={format:1,packs:[{path:`packs/2026-10-0-${sha256}.json`,sha256,bytes:Buffer.byteLength(text),count:2}]};
    const callbacks=new Map();let macro;
    const context={extensionSettings:{},chat:[],eventTypes:Object.fromEntries(['GENERATION_AFTER_COMMANDS','TOOL_CALLS_PERFORMED','GENERATION_ENDED','CHAT_CHANGED','MESSAGE_RECEIVED'].map(x=>[x,x])),
        eventSource:{on:(name,fn)=>{if(!callbacks.has(name))callbacks.set(name,[]);callbacks.get(name).push(fn)}},
        registerMacro:(_name,fn)=>{macro=fn},saveSettingsDebounced:()=>{},substituteParams:text=>text.replaceAll('{{char}}','角色').replaceAll('{{user}}','用户')};
    const previous={fetch:globalThis.fetch,document:globalThis.document,SillyTavern:globalThis.SillyTavern};
    globalThis.document={querySelector:()=>null};globalThis.SillyTavern={getContext:()=>context};
    let requests=0;
    globalThis.fetch=async url=>{requests++;return new Response(String(url).includes('index.json')?JSON.stringify(manifest):text)};
    const emit=async(name,...args)=>{for(const fn of callbacks.get(name)||[])await fn(...args)};
    try {
        await import(`../index.js?test=${Date.now()}`);
        const downloaded=requests;
        await emit('GENERATION_AFTER_COMMANDS','normal',{},true);macro();assert.equal(context.extensionSettings.teahouse.lastId,null);
        await emit('GENERATION_AFTER_COMMANDS','normal',{},false);
        const first=macro();assert.equal(macro(),first);assert.match(first,/角色和用户/);
        const firstId=context.extensionSettings.teahouse.lastId;
        context.chat=[{is_user:false,extra:{}}];await emit('MESSAGE_RECEIVED',0);
        assert.equal(context.chat[0].extra.teahouse.id,firstId);
        const original=structuredClone(context.chat[0]);
        await emit('GENERATION_ENDED');await emit('GENERATION_AFTER_COMMANDS','regenerate',{},false);
        assert.notEqual(macro(),first);
        await emit('TOOL_CALLS_PERFORMED');const toolText=macro();await emit('GENERATION_AFTER_COMMANDS','normal',{},false);assert.equal(macro(),toolText);
        await emit('CHAT_CHANGED');context.chat=[original];await emit('GENERATION_AFTER_COMMANDS','continue',{},false);assert.equal(macro(),first);
        await emit('GENERATION_ENDED');const last=context.extensionSettings.teahouse.lastId;
        await emit('GENERATION_AFTER_COMMANDS','normal',{},false);await emit('GENERATION_ENDED');assert.equal(context.extensionSettings.teahouse.lastId,last);
        context.chat=[{extra:{teahouse:{id:'deleted'}}}];await emit('GENERATION_AFTER_COMMANDS','continue',{},false);assert.notEqual(macro(),first);
        await emit('GENERATION_ENDED');await emit('GENERATION_AFTER_COMMANDS','normal',{},false);const memberA=macro();
        await emit('GENERATION_ENDED');await emit('GENERATION_AFTER_COMMANDS','normal',{},false);assert.notEqual(macro(),memberA);
        assert.equal(requests,downloaded,'使用剧场不发起正文下载请求');
    } finally {Object.assign(globalThis,previous)}
});
