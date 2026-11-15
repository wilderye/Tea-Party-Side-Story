import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayFavoriteOperations } from '../play-favorite-operations.js';
import { deferred } from './play-fixture.js';

const source = { roundId: 'chat-a', resultId: 'result-a', startedAt: '2026-11-16T00:00:00.000Z' };

function fixture() {
    const operations = createPlayFavoriteOperations(), errors = [], commits = [];
    let value = null;
    operations.subscribe(event => {
        if (event.committed) { value = event.value; commits.push(event.value); }
    });
    const options = overrides => ({ value, add: async () => ({ id: 'favorite-a' }), remove: async () => {},
        onError: (error, desired) => errors.push({ error, desired }), ...overrides });
    return { operations, errors, commits, options, value: () => value };
}

test('点击立即改变星标，后台保存未开始和等待期间均可读取新状态', async () => {
    const f = fixture(), entered = deferred(), gate = deferred();
    const completion = f.operations.toggle(source, f.options({ add: async () => { entered.resolve(); await gate.promise; return { id: 'favorite-a' }; } }));
    assert.equal(f.operations.isFavorite(source, f.value()), true);
    assert.equal(f.operations.hasPending(), true);
    assert.deepEqual(f.commits, []);
    await entered.promise;
    assert.equal(f.operations.isFavorite({ ...source, messageId: 'message-a' }, null), true);
    gate.resolve(); await completion;
    assert.equal(f.operations.hasPending(), false);
    assert.equal(f.operations.isFavorite(source, f.value()), true);
    assert.deepEqual(f.errors, []);
});

test('收藏后立刻取消保持最新星标，成功保存后只取消刚保存的收藏', async () => {
    const f = fixture(), entered = deferred(), gate = deferred(), removed = [];
    const options = f.options({ add: async () => { entered.resolve(); await gate.promise; return { id: 'favorite-a' }; },
        remove: async value => removed.push(value.id) });
    const completion = f.operations.toggle(source, options);
    await entered.promise;
    assert.equal(f.operations.toggle(source, options), completion);
    assert.equal(f.operations.isFavorite(source, null), false);
    gate.resolve(); await completion;
    assert.deepEqual(removed, ['favorite-a']);
    assert.deepEqual(f.commits, [{ id: 'favorite-a' }, null]);
    assert.equal(f.operations.isFavorite(source, f.value()), false);
});

test('后台开始前连续收藏和取消不产生保存，连续三次只保存一次', async () => {
    const f = fixture(); let writes = 0;
    const options = f.options({ add: async () => { writes++; return { id: 'favorite-a' }; } });
    const first = f.operations.toggle(source, options);
    f.operations.toggle(source, options);
    await first;
    assert.equal(writes, 0);
    const second = f.operations.toggle(source, options);
    f.operations.toggle(source, options); f.operations.toggle(source, options);
    await second;
    assert.equal(writes, 1);
    assert.equal(f.operations.isFavorite(source, f.value()), true);
});

test('收藏失败恢复未收藏，原错误只通知一次；取消失败恢复已有收藏', async () => {
    const f = fixture(), failure = new Error('模拟保存失败');
    await f.operations.toggle(source, f.options({ add: async () => { throw failure; } }));
    assert.equal(f.operations.isFavorite(source, f.value()), false);
    assert.deepEqual(f.errors, [{ error: failure, desired: true }]);
    await f.operations.toggle(source, f.options());
    const removal = new Error('模拟取消失败');
    await f.operations.toggle(source, f.options({ remove: async () => { throw removal; } }));
    assert.equal(f.operations.isFavorite(source, f.value()), true);
    assert.deepEqual(f.errors[1], { error: removal, desired: false });
});

test('旧收藏请求失败不撤销后来已选择的取消，也不重复提示过期操作', async () => {
    const f = fixture(), entered = deferred(), gate = deferred();
    const options = f.options({ add: async () => { entered.resolve(); await gate.promise; throw new Error('旧请求失败'); } });
    const completion = f.operations.toggle(source, options);
    await entered.promise; f.operations.toggle(source, options);
    gate.resolve(); await completion;
    assert.equal(f.operations.isFavorite(source, f.value()), false);
    assert.deepEqual(f.errors, []);
});

test('回复版本分别保存，用户消息统一换行，整条聊天与单条收藏互不改变', async () => {
    const f = fixture(), entered = deferred(), gate = deferred();
    const first = f.operations.toggle(source, f.options({ add: async () => { entered.resolve(); await gate.promise; return { id: 'favorite-a' }; } }));
    await entered.promise;
    const other = { ...source, resultId: 'result-b' };
    assert.equal(f.operations.isFavorite(other, null), false);
    const prompt = { type: 'prompt', origin: null, prompt: '第一行\r\n第二行' };
    const pendingPrompt = f.operations.toggle(prompt, f.options());
    assert.equal(f.operations.isFavorite({ ...prompt, prompt: '第一行\n第二行' }, null), true);
    assert.equal(f.operations.isFavorite({ type: 'chat', chatId: source.roundId }, null), false);
    gate.resolve(); await Promise.all([first, pendingPrompt]);
    assert.equal(f.operations.isFavorite({ type: 'prompt', prompt: null }, false), false);
});
