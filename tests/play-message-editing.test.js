import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayMessageEditing } from '../play-message-editing.js';

function session(events, name, save = async () => true) {
    return { page: 'record', id: name, role: 'user', editor: {
        saving: false, save: async () => { events.push(`save ${name}`); return save(); },
        capture: () => ({ start: 4, end: 8, scroll: 90 }), restore: state => events.push(['restore', state]),
        actions: { remove() {} }, dispose() {},
    }, activate: () => events.push(`activate ${name}`), finish: () => events.push(`finish ${name}`),
        reveal: () => events.push(`reveal ${name}`) };
}

test('先等待旧保存结束，再读取新消息；处理中拒绝第二次切换', async () => {
    const events = [], editing = createPlayMessageEditing();
    let resolve;
    const a = session(events, 'A', () => new Promise(done => { resolve = done; }));
    await editing.open({ key: 'A', create: () => a });
    const opening = editing.open({ key: 'B', create: () => { events.push('read B'); return session(events, 'B'); } });
    await Promise.resolve();
    assert.equal(editing.busy, true);
    assert.equal(await editing.open({ key: 'C', create: () => { throw Error('不能开启 C'); } }), false);
    assert.deepEqual(events, ['activate A', 'save A']);
    resolve(true); assert.equal(await opening, true);
    assert.deepEqual(events, ['activate A', 'save A', 'finish A', 'read B', 'activate B']);
    assert.equal(editing.current.id, 'B'); assert.equal(editing.busy, false);
});

test('跨页保存失败保留旧会话和选区；错误定位期间仍禁止重入', async () => {
    const events = [];
    const editing = createPlayMessageEditing({ async onReveal(current) {
        assert.equal(editing.busy, true);
        assert.equal(await editing.open({ key: 'C', create: () => null }), false);
        current.reveal();
    } });
    const a = session(events, 'A', async () => false);
    await editing.open({ key: 'A', create: () => a });
    assert.equal(await editing.open({ key: 'chat/B', create: () => { throw Error('不能读取 B'); } }), false);
    assert.equal(editing.current, a);
    assert.equal(editing.find('record', 'A', 'user'), a);
    assert.equal(editing.find('chat', 'A'), null);
    assert.deepEqual(events, ['activate A', 'save A', 'reveal A', ['restore', { start: 4, end: 8, scroll: 90 }]]);
});

test('同目标不重新保存；取消不写入；新目标读取失败保留已经完成的保存', async () => {
    const events = [], errors = [], editing = createPlayMessageEditing({ onError: error => errors.push(error.message) });
    const a = session(events, 'A');
    await editing.open({ key: 'A', create: () => a });
    assert.equal(await editing.open({ key: 'A', create: () => { throw Error('不重新创建'); } }), true);
    await editing.cancel(); assert.deepEqual(events, ['activate A', 'finish A']);
    await editing.open({ key: 'A', create: () => a });
    assert.equal(await editing.open({ key: 'B', create: () => { throw Error('新消息已删除'); } }), false);
    assert.equal(editing.current, null);
    assert.deepEqual(errors, ['新消息已删除']);
    assert.deepEqual(events.slice(-3), ['activate A', 'save A', 'finish A']);
});

test('保存后的显示更新失败不重复写入，并继续开启新消息', async () => {
    const events = [], errors = [], editing = createPlayMessageEditing({ onError: error => errors.push(error.message) });
    const a = session(events, 'A'); a.finish = () => { throw Error('页面读取失败'); };
    await editing.open({ key: 'A', create: () => a });
    assert.equal(await editing.open({ key: 'B', create: () => session(events, 'B') }), true);
    assert.deepEqual(errors, ['页面读取失败']);
    assert.deepEqual(events, ['activate A', 'save A', 'activate B']);
});
