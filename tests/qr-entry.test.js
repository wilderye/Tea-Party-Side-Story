import test from 'node:test';
import assert from 'node:assert/strict';
import { syncQrEntry } from '../qr-entry.js';
for (const masterEnabled of [false, true]) test(`QR 总开关为 ${masterEnabled} 时只管理插件入口`,async()=>{
    const otherQr={message:'/echo 用户按钮',isHidden:true,executeOnStartup:true};
    const otherSet={qrs:new Map([['用户按钮',otherQr]])};
    const sets=new Map([['用户已有的按钮',otherSet]]),active=new Set(['用户已有的按钮']);let created=0,saves=0;
    const chatSets=['当前聊天的按钮'],inactiveSets=['用户未启用的按钮'];
    const api={settings:{isEnabled:masterEnabled,chatSets,inactiveSets,save(){saves++;}},getSetByName:name=>sets.get(name),
        createSet:async(name,options)=>{created++;const set={options,qrs:new Map()};sets.set(name,set);return set;},
        getQrByLabel:(name,label)=>sets.get(name)?.qrs.get(label),
        createQuickReply:(name,label,props)=>{const qr={...props};sets.get(name).qrs.set(label,qr);return qr;},
        updateQuickReply:(name,label,props)=>Object.assign(sets.get(name).qrs.get(label),props),
        addGlobalSet:name=>active.add(name),removeGlobalSet:name=>active.delete(name)};
    await syncQrEntry(api,false);assert.equal(created,0);
    await syncQrEntry(api,true);await syncQrEntry(api,true);
    assert.equal(created,1);assert.deepEqual([...active],['用户已有的按钮','茶话会小剧场 · 插件入口']);assert.equal(api.settings.isEnabled,masterEnabled);assert.equal(saves,0);
    const set=sets.get('茶话会小剧场 · 插件入口'),qr=[...set.qrs.values()][0];
    assert.equal(set.qrs.size,1);assert.equal(qr.icon,'fa-mug-hot');assert.equal(qr.showLabel,false);assert.equal(qr.message,'/teahouse');
    assert.equal(set.options.injectInput,false,'打开入口不会把草稿当作脚本参数');
    await syncQrEntry(api,false);assert.deepEqual([...active],['用户已有的按钮']);assert.equal(qr.isHidden,true);assert.equal(api.settings.isEnabled,masterEnabled);
    await syncQrEntry(api,true);assert.equal(qr.isHidden,false);assert.equal(created,1);
    assert.deepEqual(otherQr,{message:'/echo 用户按钮',isHidden:true,executeOnStartup:true});
    assert.equal(sets.get('用户已有的按钮'),otherSet);
    assert.deepEqual(chatSets,['当前聊天的按钮']);assert.deepEqual(inactiveSets,['用户未启用的按钮']);
    assert.equal(saves,0);
});
test('QR 尚未就绪只在尝试启用时提示',async()=>{
    await syncQrEntry(undefined,false);await assert.rejects(syncQrEntry(undefined,true),/尚未就绪/);
});
