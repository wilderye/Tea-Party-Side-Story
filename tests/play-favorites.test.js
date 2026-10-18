import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLAY_HISTORY_INDEX, playFavoriteFile } from '../play-history.js';
import { memoryFiles, time } from './play-fixture.js';

async function seed(f, overrides = {}) {
    const round = await f.begin(overrides), result = round.results[0];
    const text = '<thinking>原始思考</thinking>\n第一行正文\n第二行正文';
    await f.store.saveResult(round.id, result.id, { status: 'complete', text, finishedAt: time(1) });
    return { round, input: { roundId: round.id, resultId: result.id, startedAt: result.startedAt, expectedText: text, firstLine: '第一行正文' } };
}

test('收藏保留完整原文、来源标题和角色名；替换原结果不改变收藏副本', async () => {
    const f = memoryFiles(), { round, input } = await seed(f);
    const favorite = await f.store.addFavorite(input);
    assert.equal(favorite.title, '雨夜重逢'); assert.equal(favorite.characterName, '角色A');
    assert.equal(favorite.text, input.expectedText);
    const replacementId = randomUUID();
    await f.begin({ roundId: round.id, replaceResultId: input.resultId, resultId: replacementId, startedAt: time(2) });
    await f.store.saveResult(round.id, replacementId, { status: 'complete', text: '重新生成的正文', finishedAt: time(3) });
    assert.equal((await f.store.getRound(round.id)).results.length, 1);
    assert.equal((await f.createStore().getFavorite(favorite.id)).text, input.expectedText);
    await assert.rejects(f.store.saveResult(round.id, input.resultId, { text: '旧请求迟到的保存' }), /已不存在/);
    assert.equal((await f.store.getRound(round.id)).results[0].text, '重新生成的正文');
});

test('收藏标题可以清空，编辑正文不修改来源；列表不读取正文文件', async () => {
    const f = memoryFiles(), { round, input } = await seed(f, { origin: null });
    const original = await f.store.addFavorite(input);
    const edited = await f.store.editFavorite(original.id, { title: '', text: '<content>改后的正文</content>', firstLine: '改后的正文' }, original.revision);
    assert.equal(edited.title, ''); assert.equal(edited.firstLine, '改后的正文');
    assert.equal(edited.savedAt, original.savedAt); assert.deepEqual(edited.source, original.source);
    assert.equal((await f.store.getRound(round.id)).results[0].text, input.expectedText);
    const reads = []; f.io.beforeRead = name => reads.push(name);
    const rows = await f.createStore().listFavorites();
    assert.deepEqual(reads, [PLAY_HISTORY_INDEX]);
    assert.equal(rows.length, 1); assert.equal(rows[0].firstLine, '改后的正文'); assert.equal('text' in rows[0], false);
    assert.equal((await f.createStore().getFavorite(edited.id)).text, edited.text);
});

test('旧目录可直接读取；收藏保存失败不覆盖原文，重试和重复收藏不新增副本', async () => {
    const f = memoryFiles(), { input } = await seed(f);
    const legacy = f.directory(); delete legacy.favorites; f.files.set(PLAY_HISTORY_INDEX, JSON.stringify(legacy));
    assert.deepEqual(await f.store.listFavorites(), []);
    const favorite = await f.store.addFavorite(input);
    assert.equal((await f.createStore().addFavorite(input)).id, favorite.id);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟保存失败'); };
    const patch = { title: '修改后的标题', text: '修改后的内容', firstLine: '修改后的内容' };
    await assert.rejects(f.store.editFavorite(favorite.id, patch, favorite.revision), /模拟保存失败/);
    assert.equal((await f.store.getFavorite(favorite.id)).text, input.expectedText);
    f.io.beforeWrite = null;
    const saved = await f.store.editFavorite(favorite.id, patch, favorite.revision);
    assert.equal((await f.store.editFavorite(favorite.id, patch, favorite.revision)).revision, saved.revision);
    assert.equal((await f.store.listFavorites()).length, 1);
});

test('两个窗口同时收藏只保存一份，过期编辑不覆盖新内容，取消收藏不改原记录', async () => {
    const f = memoryFiles(), { round, input } = await seed(f), other = f.createStore();
    const [a, b] = await Promise.all([f.store.addFavorite(input), other.addFavorite(input)]);
    assert.equal(a.id, b.id);
    await f.store.editFavorite(a.id, { title: '甲改标题', text: '甲改正文', firstLine: '甲改正文' }, a.revision);
    await assert.rejects(other.editFavorite(b.id, { title: '乙改标题', text: '乙改正文', firstLine: '乙改正文' }, b.revision), /其他窗口修改/);
    assert.equal((await other.getFavorite(a.id)).text, '甲改正文');
    const row = (await f.store.listFavorites())[0];
    await other.removeFavorite(a.id);
    assert.deepEqual(await f.store.listFavorites(), []);
    assert.equal(f.files.has(playFavoriteFile(row.id, row.revision)), false);
    assert.equal((await f.store.getRound(round.id)).results[0].text, input.expectedText);
});

test('过期来源不会被悄悄收藏，损坏的收藏也不被空内容覆盖', async () => {
    const f = memoryFiles(), { round, input } = await seed(f);
    await f.store.editResult(round.id, input.resultId, '另一窗口改过的正文', input.expectedText);
    await assert.rejects(f.store.addFavorite(input), /其他窗口修改/);
    const favorite = await f.store.addFavorite({ ...input, expectedText: '另一窗口改过的正文' });
    f.files.set(playFavoriteFile(favorite.id, favorite.revision), '{');
    const writes = f.writes.length;
    await assert.rejects(f.store.editFavorite(favorite.id, { title: '', text: '不能覆盖', firstLine: '不能覆盖' }, favorite.revision), /无法解析/);
    assert.equal(f.writes.length, writes);
});

test('收藏支持保存清洗后的内容并标记 cleaned，未提供时兼容回退原文；编辑后保留 cleaned 标记', async () => {
    const f = memoryFiles(), { round, input } = await seed(f);
    const cleanedText = '第一行正文\n第二行正文';
    const favorite = await f.store.addFavorite({ ...input, text: cleanedText });
    assert.equal(favorite.text, cleanedText);
    assert.equal(favorite.cleaned, true);
    const fileContent = JSON.parse(f.files.get(playFavoriteFile(favorite.id, favorite.revision)));
    assert.equal(fileContent.text, cleanedText);
    assert.equal(fileContent.cleaned, true);

    // Editing maintains cleaned: true
    const edited = await f.store.editFavorite(favorite.id, { title: '新标题', text: '修改后的干净正文', firstLine: '修改后的干净正文' }, favorite.revision);
    assert.equal(edited.cleaned, true);
    assert.equal(edited.text, '修改后的干净正文');

    // Default without text retains original uncleaned text and cleaned: false
    const round2 = await f.begin(), result2 = round2.results[0];
    const raw = '<thinking>思考</thinking>正文';
    await f.store.saveResult(round2.id, result2.id, { status: 'complete', text: raw, finishedAt: time(2) });
    const legacy = await f.store.addFavorite({ roundId: round2.id, resultId: result2.id, startedAt: result2.startedAt, expectedText: raw, firstLine: '正文' });
    assert.equal(legacy.text, raw);
    assert.equal(legacy.cleaned, false);
});

