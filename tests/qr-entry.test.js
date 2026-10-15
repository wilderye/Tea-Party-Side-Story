import test from 'node:test';
import assert from 'node:assert/strict';
import { syncQrEntry, removeQrEntry } from '../qr-entry.js';
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

const entrySetName = '茶话会小剧场 · 插件入口';
const entryLabel = '茶话会小剧场';
const originalEntry = { label: entryLabel, message: '/teahouse' };

function cleanupFixture(replies = [originalEntry]) {
    const other = { label: '用户按钮', message: '/echo 保留', isHidden: true };
    const stored = new Map([[entrySetName, structuredClone(replies)], ['其他集合', [other]]]);
    const active = new Set([entrySetName, '其他集合']);
    const calls = [];
    let pendingSave;
    const set = {
        qrList: structuredClone(replies),
        save() {
            pendingSave ??= Promise.resolve().then(async () => {
                await fixture.beforeSave?.();
                stored.set(entrySetName, structuredClone(set.qrList));
                calls.push('saved');
                pendingSave = undefined;
            });
            return pendingSave;
        },
    };
    const sets = new Map([[entrySetName, set], ['其他集合', { qrList: [other] }]]);
    const fixture = { stored, active, calls, sets, set, api: {
        settings: { isEnabled: false, chatSets: ['其他集合'] },
        getSetByName: name => sets.get(name),
        getQrByLabel: (name, label) => sets.get(name)?.qrList.find(qr => qr.label === label),
        listQuickReplies: name => sets.get(name).qrList.map(qr => qr.label),
        deleteQuickReply(name, label) {
            assert.equal(name, entrySetName);
            set.qrList = set.qrList.filter(qr => qr.label !== label);
            // Like the host, deleting a reply schedules a save without returning it.
            void set.save();
        },
        removeGlobalSet(name) { active.delete(name); },
        async deleteSet(name) {
            calls.push('deleted');
            stored.delete(name);
            sets.delete(name);
        },
    } };
    return fixture;
}

test('卸载等待延迟保存完成，再删除空集合，避免保存操作重新创建集合', async () => {
    const fixture = cleanupFixture();
    let release;
    fixture.beforeSave = () => new Promise(resolve => { release = resolve; });
    const pending = removeQrEntry(fixture.api);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.calls.includes('deleted'), false);
    release();
    await pending;
    assert.deepEqual(fixture.calls, ['saved', 'deleted']);
    assert.equal(fixture.stored.has(entrySetName), false);
    assert.deepEqual([...fixture.active], ['其他集合']);
    assert.equal(fixture.api.settings.isEnabled, false);
    assert.deepEqual(fixture.api.settings.chatSets, ['其他集合']);
    assert.deepEqual(fixture.stored.get('其他集合'), [{ label: '用户按钮', message: '/echo 保留', isHidden: true }]);
    await removeQrEntry(fixture.api);
    assert.deepEqual(fixture.calls, ['saved', 'deleted'], '再次卸载不重复删除');
});

test('集合内还有用户按钮时，只删除插件入口并保存，保留集合及启用状态', async () => {
    const userReply = { label: '自定义按钮', message: '/echo 保留我', executeOnStartup: true };
    const fixture = cleanupFixture([originalEntry, userReply]);
    await removeQrEntry(fixture.api);
    assert.deepEqual(fixture.stored.get(entrySetName), [userReply]);
    assert.equal(fixture.active.has(entrySetName), true);
    assert.deepEqual(fixture.calls, ['saved']);
});

test('同名入口的命令已经修改时，卸载保留该按钮及集合', async () => {
    const changedReply = { ...originalEntry, message: '/echo 自己的命令' };
    const fixture = cleanupFixture([changedReply]);
    await removeQrEntry(fixture.api);
    assert.deepEqual(fixture.stored.get(entrySetName), [changedReply]);
    assert.equal(fixture.active.has(entrySetName), true);
    assert.deepEqual(fixture.calls, []);
});

test('入口已经移除时，清理空集合；仍有其他按钮的集合保持原样', async () => {
    const empty = cleanupFixture([]);
    await removeQrEntry(empty.api);
    assert.equal(empty.stored.has(entrySetName), false);
    const otherOnly = cleanupFixture([{ label: '自己改的名字', message: '/teahouse' }]);
    await removeQrEntry(otherOnly.api);
    assert.deepEqual(otherOnly.calls, []);
    assert.equal(otherOnly.active.has(entrySetName), true);
});

test('卸载也会清理已经隐藏或未启用的插件入口', async () => {
    const fixture = cleanupFixture([{ ...originalEntry, isHidden: true }]);
    fixture.active.delete(entrySetName);
    await removeQrEntry(fixture.api);
    assert.equal(fixture.stored.has(entrySetName), false);
});

test('快速回复未就绪或酒馆未实际删除集合时，返回清理失败', async () => {
    await assert.rejects(removeQrEntry(undefined), /尚未就绪/);
    const fixture = cleanupFixture();
    fixture.api.deleteSet = async () => {};
    await assert.rejects(removeQrEntry(fixture.api), /未能删除/);
    assert.equal(fixture.stored.has(entrySetName), true);
});
