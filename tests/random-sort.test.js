import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntries, reconcileRandomOrder } from '../library.js';

const stories = [
    { id: 'a', title: '茶话甲', body: '正文', type: 'standalone', publishedAt: '2026-01-01' },
    { id: 'b', title: '乙', body: '正文', type: 'preset', publishedAt: '2026-01-03' },
    { id: 'c', title: '茶话丙', body: '正文', type: 'standalone', publishedAt: '2026-01-02' },
];
const entries = new Map(stories.map(item => [item.id, item]));
const ids = values => values.map(item => item.id);

test('随机排序不会重复或遗漏故事，生成新顺序不修改原始内容', () => {
    const before = structuredClone(stories);
    for (const random of [() => 0, () => 0.5, () => 0.999999]) {
        const order = reconcileRandomOrder(undefined, stories, random);
        assert.deepEqual([...order].sort(), ['a', 'b', 'c']);
        assert.equal(new Set(order).size, stories.length);
    }
    assert.deepEqual(stories, before);
    assert.deepEqual(reconcileRandomOrder(undefined, []), []);
    assert.deepEqual(reconcileRandomOrder(undefined, stories.slice(0, 1)), ['a']);
});

test('搜索和分类沿用整个栏目的随机顺序，时间排序仍按各自的时间规则', () => {
    const order = ['c', 'b', 'a'];
    const find = options => findEntries(entries, { scope: 'community', order, ...options });
    assert.deepEqual(ids(find({})), order);
    assert.deepEqual(ids(find({ type: 'standalone' })), ['c', 'a']);
    assert.deepEqual(ids(find({ query: '茶话' })), ['c', 'a']);
    assert.deepEqual(ids(find({})), order, '取消筛选不会改变原顺序');
    assert.deepEqual(ids(findEntries(entries, { scope: 'community' })), ['b', 'c', 'a']);
    assert.deepEqual(ids(findEntries(entries, { scope: 'favorites', favorites: { a: 30, b: 10, c: 20 } })), ['a', 'c', 'b']);
});

test('增删只移除失效故事并追加新故事，不重排已有故事；编辑读取最新正文', () => {
    const previous = ['c', 'a', 'b'];
    const changed = new Map(entries);
    changed.delete('a');
    changed.set('c', { ...entries.get('c'), body: '修改后的正文' });
    changed.set('d', { ...stories[0], id: 'd', title: '新故事', publishedAt: '2026-02-01' });
    const noShuffle = () => { throw new Error('增删故事时不应该重新随机'); };
    const order = reconcileRandomOrder(previous, [...changed.values()], noShuffle);
    assert.deepEqual(order, ['c', 'b', 'd']);
    assert.deepEqual(previous, ['c', 'a', 'b']);
    const result = findEntries(changed, { scope: 'community', order });
    assert.equal(result[0].body, '修改后的正文');
    assert.deepEqual(ids(result), order);
    assert.deepEqual(reconcileRandomOrder([], stories, noShuffle), ['a', 'b', 'c']);
});

test('各栏目独立：收藏取消后移除，重新收藏追加到末尾，不改变选集顺序', () => {
    const communityOrder = ['c', 'a', 'b'];
    const favorites = { a: 10, b: 20, c: 30 };
    const pool = () => findEntries(entries, { scope: 'favorites', favorites });
    let favoriteOrder = ['b', 'a', 'c'];
    delete favorites.a;
    favoriteOrder = reconcileRandomOrder(favoriteOrder, pool());
    assert.deepEqual(favoriteOrder, ['b', 'c']);
    favorites.a = 40;
    favoriteOrder = reconcileRandomOrder(favoriteOrder, pool());
    assert.deepEqual(favoriteOrder, ['b', 'c', 'a']);
    assert.deepEqual(ids(findEntries(entries, { scope: 'community', order: communityOrder })), communityOrder);
});
