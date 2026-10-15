import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlayPromptFavorites } from '../play-prompt-favorites.js';
import { readManuscripts, truncateTitle } from '../library.js';

const story = { id: '123456789012345678', title: '雨夜重逢', type: 'standalone',
    body: '暂停当前剧情。\n让 {{char}} 与 {{user}} 在雨夜重逢。', author: '茶友', publishedAt: '2026-01-01T00:00:00Z' };
const from = entry => ({ prompt: entry.body, origin: { id: entry.id, title: entry.title } });

function fixture() {
    const state = { community: new Map([[story.id, { ...story }]]), manuscripts: new Map(), settings: { enabled: true, favorites: {} } };
    const writes = [];
    const actions = { loaded: Promise.resolve(),
        async saveManuscript(draft) {
            const item = { ...draft, id: `local:${randomUUID()}`, publishedAt: story.publishedAt };
            state.manuscripts = readManuscripts({ format: 1, entries: [...state.manuscripts.values(), item] });
            writes.push(item);
            return item;
        },
        toggleFavorite(id) {
            if (Object.hasOwn(state.settings.favorites, id)) delete state.settings.favorites[id];
            else state.settings.favorites[id] = Date.now();
        },
    };
    return { state, actions, writes, favorites: createPlayPromptFavorites(state, actions) };
}

test('未修改的选集消息直接收藏原篇目，星标与剧场库共用收藏状态', async () => {
    const { state, favorites, writes, actions } = fixture(), round = from(story);
    assert.equal(favorites.isFavorite(round), false);
    assert.deepEqual(await favorites.toggle(round), { id: story.id, favorite: true, created: false });
    assert.equal(favorites.isFavorite(round), true);
    assert.equal(writes.length, 0);
    assert.deepEqual(state.community.get(story.id), story);
    actions.toggleFavorite(story.id);
    assert.equal(favorites.isFavorite(round), false, '在收藏目录取消也改变用户消息的星标');
    await favorites.toggle({ ...round, prompt: round.prompt.replaceAll('\n', '\r\n') });
    assert.equal(favorites.isFavorite(round), true, '浏览器输入框的换行标准化不算改写');
    assert.equal(writes.length, 0);
});

test('修改选集内容另存带来源标题的手稿，后续编辑和取消收藏都保留旧手稿', async () => {
    const { state, favorites, writes } = fixture();
    const round = { ...from(story), prompt: `${story.body}\n改为清晨，并保留 <%= example %>。` };
    const originalRound = structuredClone(round);
    const saved = await favorites.toggle(round);
    assert.equal(saved.created, true);
    assert.deepEqual(writes[0], { id: saved.id, title: story.title, type: 'standalone', body: round.prompt, publishedAt: story.publishedAt });
    assert.equal(Object.hasOwn(state.settings.favorites, story.id), false);
    round.prompt += '\n再改为下雪。';
    assert.equal(favorites.isFavorite(round), false);
    const second = await favorites.toggle(round);
    assert.notEqual(second.id, saved.id);
    assert.equal(state.manuscripts.get(saved.id).body, originalRound.prompt);
    assert.equal(Object.hasOwn(state.settings.favorites, saved.id), true);
    assert.equal(favorites.isFavorite(round), true);
    assert.equal((await favorites.toggle(round)).favorite, false);
    assert.equal(state.manuscripts.size, 2, '取消收藏不会删除手稿');
    assert.equal((await favorites.toggle(round)).id, second.id, '重新收藏复用已有手稿');
    assert.equal(writes.length, 2);
    assert.deepEqual(state.community.get(story.id), story);
});

test('来自亲笔手稿时收藏原手稿；改写后保留标题另存，不覆盖原手稿', async () => {
    const { state, actions, favorites, writes } = fixture();
    const original = await actions.saveManuscript({ title: '我的雨夜', type: 'standalone', body: story.body });
    const round = from(original);
    assert.equal((await favorites.toggle(round)).id, original.id);
    assert.equal(writes.length, 1);
    const edited = { ...round, prompt: `${round.prompt}\n加入新的对白。` };
    const saved = await favorites.toggle(edited);
    assert.equal(saved.created, true);
    assert.equal(state.manuscripts.get(saved.id).title, original.title);
    assert.equal(state.manuscripts.get(original.id).body, original.body);
    assert.equal(favorites.isFavorite(round), true);
});

test('没有来源标题时取第一行，28 个字符后加三个点，正文及宏保持完整', async () => {
    const { state, favorites } = fixture();
    const firstLine = '茶🍵'.repeat(20), prompt = `\r\n  ${firstLine}  \r\n第二行保留 {{user}}、{{char}} 与 <%= example %>。\r\n`;
    const round = { origin: null, prompt };
    const saved = await favorites.toggle(round), entry = state.manuscripts.get(saved.id);
    assert.equal(entry.title, `${[...firstLine].slice(0, 28).join('')}...`);
    assert.equal(entry.body, prompt);
    assert.equal(entry.type, 'standalone');
    assert.equal(truncateTitle('字'.repeat(28)), '字'.repeat(28));
    assert.equal(truncateTitle('字'.repeat(29)), `${'字'.repeat(28)}...`);
    assert.deepEqual(round, { origin: null, prompt });
});

test('没有选集来源的同文消息存手稿；选集已删除或更新时也保留消息原文', async () => {
    for (const change of ['no-origin', 'removed', 'updated']) {
        const { state, favorites } = fixture();
        const round = change === 'no-origin' ? { origin: null, prompt: story.body } : from(story);
        if (change === 'removed') state.community.delete(story.id);
        if (change === 'updated') state.community.set(story.id, { ...story, body: '选集里的新版正文' });
        const saved = await favorites.toggle(round);
        assert.equal(saved.created, true);
        assert.equal(state.manuscripts.get(saved.id).body, story.body);
        assert.equal(state.manuscripts.get(saved.id).title, change === 'no-origin' ? '暂停当前剧情。' : story.title);
        assert.equal(Object.hasOwn(state.settings.favorites, story.id), false);
    }
});

test('重新读取后从现有手稿识别收藏，删除手稿后不会恢复旧副本', async () => {
    const f = fixture(), round = { origin: null, prompt: '一份手写提示词\n完整正文' };
    const first = await f.favorites.toggle(round);
    f.state.manuscripts = readManuscripts(JSON.parse(JSON.stringify({ format: 1, entries: [...f.state.manuscripts.values()] })));
    const reopened = createPlayPromptFavorites(f.state, f.actions);
    assert.equal(reopened.isFavorite(round), true);
    await reopened.toggle(round);
    assert.equal((await reopened.toggle(round)).id, first.id);
    assert.equal(f.writes.length, 1);
    f.state.manuscripts.delete(first.id); delete f.state.settings.favorites[first.id];
    assert.equal(reopened.isFavorite(round), false);
    assert.notEqual((await reopened.toggle(round)).id, first.id);
});

test('读取或保存失败、插件停用、用户消息删除时不添加收藏', async () => {
    const f = fixture(), round = { origin: null, prompt: '不能丢失的正文' };
    const failure = new Error('原始保存错误');
    const failed = createPlayPromptFavorites(f.state, { ...f.actions, saveManuscript: async () => { throw failure; } });
    await assert.rejects(failed.toggle(round), error => error === failure);
    f.state.settings.enabled = false;
    await assert.rejects(f.favorites.toggle(round), /停用/);
    f.state.settings.enabled = true;
    await assert.rejects(f.favorites.toggle({ prompt: null }), /已删除/);
    assert.deepEqual(f.state.settings.favorites, {});
    assert.equal(f.state.manuscripts.size, 0);
    let resolveLoaded;
    const delayed = createPlayPromptFavorites(f.state, { ...f.actions, loaded: new Promise(resolve => { resolveLoaded = resolve; }) });
    const pending = delayed.toggle(round);
    assert.equal(f.writes.length, 0);
    resolveLoaded(); await pending;
    assert.equal(f.writes.length, 1);
});
