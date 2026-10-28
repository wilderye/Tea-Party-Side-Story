import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLAY_HISTORY_INDEX, playRoundFile, readPlayRound } from '../play-history.js';
import { memoryFiles, time } from './play-fixture.js';

async function completedRound(f) {
    const round = await f.begin();
    return f.store.saveResult(round.id, round.results[0].id, { status: 'complete', text: '第一份回复', finishedAt: time(1) });
}

test('删除 AI 消息移除全部版本，保留用户消息、收藏副本及历史顺序', async () => {
    const f = memoryFiles(), first = await completedRound(f);
    const next = await f.begin({ roundId: first.id, startedAt: time(2) });
    const round = await f.store.saveResult(next.id, next.results[1].id, { status: 'complete', text: '第二份回复', finishedAt: time(3) });
    const favorite = await f.store.addFavorite({ roundId: round.id, resultId: round.results[1].id,
        startedAt: round.results[1].startedAt, expectedText: '第二份回复', firstLine: '第二份回复' });
    const people = await f.store.listCharacters();
    const removed = await f.store.removeReply(round.id, round.results);
    assert.deepEqual(removed, { ...round, results: [], selectedResultId: null, initialAssistantId: null });
    assert.deepEqual(await f.createStore().getRound(round.id), removed);
    assert.equal((await f.createStore().getFavorite(favorite.id)).text, favorite.text);
    assert.deepEqual(await f.store.listCharacters(), people);
    const writes = f.writes.length;
    await f.store.removeReply(round.id, round.results);
    assert.equal(f.writes.length, writes, '重复删除不新增版本或写文件');
    const regenerated = await f.begin({ roundId: round.id, startedAt: time(4) });
    assert.equal(regenerated.prompt, round.prompt);
    assert.equal(regenerated.results.length, 1, '再次生成只产生新回复，不恢复已删除的旧版本');
});

test('删除用户消息保留 AI 回复；不能编辑恢复原提示词或用它再次生成', async () => {
    const f = memoryFiles(), round = await completedRound(f);
    const removed = await f.store.removePrompt(round.id, round.prompt);
    assert.deepEqual(removed, { ...round, prompt: null });
    assert.deepEqual(await f.createStore().getRound(round.id), removed);
    await assert.rejects(f.store.editPrompt(round.id, '试图恢复旧草稿', round.prompt), error => error.code === 'prompt_missing');
    await assert.rejects(f.begin({ roundId: round.id }), error => error.code === 'prompt_missing');
    assert.deepEqual((await f.store.getRound(round.id)).results, round.results);
});

test('两个消息都删掉后保留空历史，游玩不显示；迟到保存和收藏读取不会恢复消息', async () => {
    for (const firstRole of ['user', 'assistant']) {
        const f = memoryFiles(), round = await completedRound(f);
        const favorite = await f.store.addFavorite({ roundId: round.id, resultId: round.results[0].id,
            startedAt: round.results[0].startedAt, expectedText: '第一份回复', firstLine: '第一份回复' });
        const removePrompt = () => f.store.removePrompt(round.id, round.prompt);
        const removeReply = () => f.store.removeReply(round.id, round.results);
        await (firstRole === 'user' ? removePrompt() : removeReply());
        const empty = await (firstRole === 'user' ? removeReply() : removePrompt());
        assert.equal(empty.prompt, null); assert.deepEqual(empty.results, []);
        assert.deepEqual(await f.store.listRounds(round.characterId), []);
        assert.deepEqual(await f.store.getRound(round.id), empty);
        assert.equal((await f.store.listChats(round.characterId)).length, 1);
        assert.equal((await f.store.getFavorite(favorite.id)).text, '第一份回复');
        assert.deepEqual(await removeReply(), empty); assert.deepEqual(await removePrompt(), empty);
        await assert.rejects(f.store.saveResult(round.id, round.results[0].id,
            { status: 'complete', text: '迟到的回复', finishedAt: time(3) }), error => error.code === 'result_missing');
        assert.deepEqual(await f.store.listRounds(round.characterId), []);
    }
});

test('删除保存失败保留原记录；目录确认成功后才清理旧正文', async () => {
    const f = memoryFiles(), round = await completedRound(f);
    const row = f.directory().rounds[0], file = playRoundFile(row.id, row.revision);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟删除保存失败'); };
    await assert.rejects(f.store.removeReply(round.id, round.results), /模拟删除保存失败/);
    assert.deepEqual(await f.createStore().getRound(round.id), round);
    assert.equal(f.files.has(file), true);
    f.io.beforeWrite = null;
    const removed = await f.store.removeReply(round.id, round.results);
    const promptRow = f.directory().rounds[0], promptFile = playRoundFile(promptRow.id, promptRow.revision);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟删除保存失败'); };
    await assert.rejects(f.store.removePrompt(round.id, round.prompt), /模拟删除保存失败/);
    assert.deepEqual(await f.store.getRound(round.id), removed);
    assert.equal(f.files.has(promptFile), true);
    f.io.beforeWrite = null;
    const empty = await f.store.removePrompt(round.id, round.prompt);
    assert.equal(empty.prompt, null); assert.deepEqual(empty.results, []);
    assert.equal(f.files.has(promptFile), false);
});

test('过期窗口不能删除修改过的用户消息、回复或未见过的新生成版本', async () => {
    const f = memoryFiles(), round = await completedRound(f);
    await f.store.editPrompt(round.id, '新的用户消息', round.prompt);
    await assert.rejects(f.store.removePrompt(round.id, round.prompt), error => error.code === 'delete_conflict');
    await f.store.editResult(round.id, round.results[0].id, '修改过的回复', round.results[0].text);
    await assert.rejects(f.store.removeReply(round.id, round.results), error => error.code === 'delete_conflict');
    const edited = await f.store.getRound(round.id);
    await f.begin({ roundId: round.id, startedAt: time(3) });
    await assert.rejects(f.store.removeReply(round.id, edited.results), error => error.code === 'delete_conflict');
    const current = await f.store.getRound(round.id);
    assert.equal(current.results.length, 2);
    assert.equal(current.prompt, '新的用户消息');
    await f.store.removeReply(round.id, current.results);
    assert.equal((await f.store.getRound(round.id)).results.length, 0, '也可以清理已中断、未完成的旧版本');
});

test('只剩一方的记录可读取，但缺失提示词、无效版本和全空记录仍被拒绝', async () => {
    const f = memoryFiles(), round = await completedRound(f);
    assert.deepEqual(readPlayRound({ ...round, prompt: null }).results, round.results);
    assert.equal(readPlayRound({ ...round, results: [] }).prompt, round.prompt);
    assert.throws(() => readPlayRound({ ...round, prompt: undefined }));
    assert.throws(() => readPlayRound({ ...round, prompt: null, results: [] }));
    assert.throws(() => readPlayRound({ ...round, results: [{ id: randomUUID() }] }));
});
