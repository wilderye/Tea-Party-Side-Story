import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLAY_HISTORY_INDEX, playRoundFile, readPlayRound } from '../play-history.js';
import { memoryFiles, characterA, characterB, contextA, time } from './play-fixture.js';

test('编辑用户消息只更新提示词，保留回复、归属、时间和历史顺序', async () => {
    const f = memoryFiles(), round = await f.begin();
    const saved = await f.store.saveResult(round.id, round.results[0].id, { status: 'complete', text: '原回复', finishedAt: time(1) });
    await f.begin({ startedAt: time(2) });
    const characters = await f.store.listCharacters(), order = (await f.store.listRounds(round.characterId)).map(row => row.id);
    const prompt = '  改成清晨\n\n保留 {{char}} 和 {{user}}。\n';
    const edited = await f.store.editPrompt(round.id, prompt, round.prompt);
    assert.deepEqual(edited, { ...saved, prompt });
    assert.deepEqual(await f.createStore().getRound(round.id), edited);
    assert.deepEqual(await f.store.listCharacters(), characters);
    assert.deepEqual((await f.store.listRounds(round.characterId)).map(row => row.id), order);
    const writes = f.writes.length;
    await f.store.editPrompt(round.id, prompt, round.prompt);
    assert.equal(f.writes.length, writes, '重复保存同一份文字不新增文件');
});

test('提示词编辑冲突和保存失败保留原消息，重试不会增加轮次或回复', async () => {
    const f = memoryFiles(), round = await f.begin();
    await f.store.editPrompt(round.id, '窗口一修改', round.prompt);
    await assert.rejects(f.createStore().editPrompt(round.id, '窗口二修改', round.prompt), /其他窗口修改/);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('保存失败'); };
    await assert.rejects(f.store.editPrompt(round.id, '重试的修改', '窗口一修改'), /保存失败/);
    assert.equal((await f.store.getRound(round.id)).prompt, '窗口一修改');
    f.io.beforeWrite = null;
    const edited = await f.store.editPrompt(round.id, '重试的修改', '窗口一修改');
    assert.equal(edited.prompt, '重试的修改');
    assert.deepEqual(edited.results, round.results);
    assert.equal((await f.store.listRounds(round.characterId)).length, 1);
    assert.throws(() => f.store.editPrompt(round.id, ' \n ', edited.prompt), /不能为空/);
});

test('提示词修改与迟到的回复保存、回复编辑不会互相覆盖', async () => {
    const f = memoryFiles(), round = await f.begin(), id = round.results[0].id;
    await Promise.all([
        f.store.editPrompt(round.id, '更新后的用户消息', round.prompt),
        f.createStore().saveResult(round.id, id, { status: 'complete', text: '迟到的完整回复', finishedAt: time(1) }),
    ]);
    await Promise.all([
        f.createStore().editPrompt(round.id, '再次更新用户消息', '更新后的用户消息'),
        f.store.editResult(round.id, id, '手动修改的回复', '迟到的完整回复'),
    ]);
    const saved = await f.createStore().getRound(round.id);
    assert.equal(saved.prompt, '再次更新用户消息');
    assert.equal(saved.results[0].text, '手动修改的回复');
    assert.equal(saved.results.length, 1);
});

test('用户编辑只更新选中回复的原文，保留归属与时间，迟到生成保存仍不得覆盖', async () => {
    const f = memoryFiles(), round = await f.begin(), id = round.results[0].id;
    const saved = await f.store.saveResult(round.id, id, { status: 'complete', text: '<thinking>错位的正文</thinking>', finishedAt: time(1) });
    const edited = await f.store.editResult(round.id, id, '<thinking>思考</thinking>修好的正文', saved.results[0].text);
    assert.deepEqual({ ...edited.results[0], text: saved.results[0].text }, saved.results[0]);
    assert.equal(edited.characterId, round.characterId); assert.equal(edited.results.length, 1);
    await f.store.saveResult(round.id, id, { status: 'unfinished', text: '迟到片段', finishedAt: null });
    await assert.rejects(f.store.saveResult(round.id, id, { status: 'complete', text: '旧的最终回复', finishedAt: time(1) }), /已结束/);
    assert.equal((await f.store.getRound(round.id)).results[0].text, '<thinking>思考</thinking>修好的正文');
});

test('编辑冲突和保存失败都保留已保存的正文，重试不新增生成版本', async () => {
    const f = memoryFiles(), round = await f.begin(), id = round.results[0].id;
    await assert.rejects(f.store.editResult(round.id, id, '提前修改', ''), /尚未完成保存/);
    await f.store.saveResult(round.id, id, { status: 'complete', text: '原文', finishedAt: time(1) });
    await f.store.editResult(round.id, id, '窗口一修改', '原文');
    await assert.rejects(f.createStore().editResult(round.id, id, '窗口二修改', '原文'), /其他窗口修改/);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw new Error('保存失败'); };
    await assert.rejects(f.store.editResult(round.id, id, '重试的修改', '窗口一修改'), /保存失败/);
    assert.equal((await f.store.getRound(round.id)).results[0].text, '窗口一修改');
    f.io.beforeWrite = null;
    const edited = await f.store.editResult(round.id, id, '重试的修改', '窗口一修改');
    assert.equal(edited.results.length, 1); assert.equal(edited.results[0].text, '重试的修改');
    assert.throws(() => f.store.editResult(round.id, id, '  ', '重试的修改'), /不能为空/);
});

test('新发送始终另起一轮；微调保留原文关联，再生成只给旧轮新增版本', async () => {
    const f = memoryFiles();
    const first = await f.begin();
    const second = await f.begin({ startedAt: time(1) });
    const edited = await f.begin({ prompt: '雨夜重逢的完整提示词，改成清晨', startedAt: time(2) });
    const repeated = await f.begin({ roundId: first.id, startedAt: time(10), prompt: '不得覆盖原输入' });
    assert.notEqual(first.id, second.id, '同文新发送不自动合并');
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.prompt, first.prompt);
    assert.equal(repeated.results.length, 2);
    assert.deepEqual(edited.origin, first.origin);
    assert.deepEqual((await f.store.listRounds(first.characterId)).map(round => round.id), [first.id, second.id, edited.id]);
    assert.equal((await f.store.listCharacters())[0].lastPlayedAt, time(10));
    assert.equal(f.removals.length, 1, '提交新版本后清理旧正文文件');
});

test('相同毫秒内发送也保持先后顺序；角色按最近一次游玩而非查看时间排序', async () => {
    const f = memoryFiles();
    const a = await f.begin();
    const aa = await f.begin();
    const b = await f.begin({ character: characterB, context: { ...contextA, chatId: 'B-main', characterName: '角色B' }, startedAt: time(1) });
    assert.deepEqual((await f.store.listRounds(a.characterId)).map(round => round.id), [a.id, aa.id]);
    await f.store.getRound(a.id);
    assert.deepEqual((await f.store.listCharacters()).map(character => character.id), [b.characterId, a.characterId]);
    await f.begin({ roundId: a.id, startedAt: time(2) });
    assert.deepEqual((await f.store.listCharacters()).map(character => character.id), [a.characterId, b.characterId]);
});

test('同名角色靠头像文件标识区分；查看其他角色不能替他新发或再生成', async () => {
    const f = memoryFiles();
    const a = await f.begin();
    const b = { avatar: 'other-A.png', name: characterA.name };
    const before = f.writes.length;
    await assert.rejects(f.begin({ character: b, characterId: a.characterId }), /只能查看历史/);
    await assert.rejects(f.begin({ character: b, roundId: a.id }), /只能查看历史/);
    assert.equal(f.writes.length, before);
});

test('整份请求和凭据不进入历史，EJS、MVU、HTML 输出保持原文字节', async () => {
    const f = memoryFiles();
    const prompt = '  原始提示词\r\n<%= getvar("stat_data") %>\n';
    const round = await f.begin({ prompt, context: { ...contextA, key: 'secret-key', proxy_password: 'proxy-secret', messages: ['主聊天正文'] } });
    const text = '<% globalThis.__shouldNotRun = 1 %>\r\n<UpdateVariable>_.set("好感度", 80);</UpdateVariable>\n<script>parent.shouldNotRun()</script>';
    await f.store.saveResult(round.id, round.results[0].id, { text, status: 'complete', finishedAt: time(1) });
    const read = await f.createStore().getRound(round.id);
    assert.equal(read.prompt, prompt);
    assert.equal(read.results[0].text, text);
    assert.equal(globalThis.__shouldNotRun, undefined);
    const disk = [...f.files.values()].join('\n');
    for (const secret of ['secret-key', 'proxy-secret', '主聊天正文']) assert.equal(disk.includes(secret), false);
});

test('目录提交失败仍能读原版本；保存重试不增加结果数量', async () => {
    const f = memoryFiles();
    const round = await f.begin();
    const before = f.files.get(PLAY_HISTORY_INDEX);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw new Error('disk full'); };
    const update = { status: 'complete', text: '完整回复', finishedAt: time(1) };
    await assert.rejects(f.store.saveResult(round.id, round.results[0].id, update), /disk full/);
    assert.equal(f.files.get(PLAY_HISTORY_INDEX), before);
    assert.equal((await f.store.getRound(round.id)).results[0].status, 'unfinished');
    assert.equal(f.removals.length, 0);
    f.io.beforeWrite = null;
    await f.store.saveResult(round.id, round.results[0].id, update);
    const writes = f.writes.length;
    await f.store.saveResult(round.id, round.results[0].id, update);
    assert.equal(f.writes.length, writes, '确认已经保存的结果不再写一个副本');
    assert.equal((await f.store.getRound(round.id)).results.length, 1);
});

test('保存响应丢失时读取目录确认，不把已经保存的结果误报为丢失', async () => {
    const f = memoryFiles();
    f.io.afterWrite = name => { if (name === PLAY_HISTORY_INDEX) throw new Error('response lost'); };
    const round = await f.begin();
    assert.equal((await f.createStore().getRound(round.id)).prompt, round.prompt);
});

test('目录、正文损坏或读取被拒绝时均不以空记录覆盖', async () => {
    for (const failure of ['directory', 'body', 'missing', 'denied']) {
        const f = memoryFiles();
        const round = await f.begin();
        const row = f.directory().rounds[0], file = playRoundFile(row.id, row.revision);
        if (failure === 'directory') f.files.set(PLAY_HISTORY_INDEX, '{');
        if (failure === 'body') f.files.set(file, '{');
        if (failure === 'missing') f.files.delete(file);
        if (failure === 'denied') f.io.beforeRead = () => { throw new Error('403'); };
        const writes = f.writes.length;
        await assert.rejects(f.store.saveResult(round.id, round.results[0].id, { text: '不能覆盖', status: 'complete', finishedAt: time(1) }));
        assert.equal(f.writes.length, writes, failure);
    }
});

test('两个存储实例共用写入锁，新增与同轮结果更新不会相互覆盖', async () => {
    const f = memoryFiles();
    const secondStore = f.createStore();
    const first = await f.begin();
    const resultId = randomUUID();
    await Promise.all([
        secondStore.begin({ roundId: first.id, character: characterA, resultId, startedAt: time(1), context: contextA }),
        f.store.saveResult(first.id, first.results[0].id, { text: '第一个结果', status: 'complete', finishedAt: time(2) }),
        f.begin({ startedAt: time(3) }),
    ]);
    const restored = await secondStore.getRound(first.id);
    assert.equal(restored.results.length, 2);
    assert.equal(restored.results[0].text, '第一个结果');
    assert.equal(restored.results[1].id, resultId);
    assert.equal((await f.store.listRounds(first.characterId)).length, 2);
});

test('已完成结果不会被迟到片段覆盖，也不能在保存时偷换聊天归属', async () => {
    const f = memoryFiles(), round = await f.begin();
    const id = round.results[0].id;
    await assert.rejects(f.store.saveResult(round.id, id, { context: { ...contextA, chatId: 'B-main' } }), /不能更换/);
    await f.store.saveResult(round.id, id, { text: '完整结果', status: 'complete', finishedAt: time(1) });
    await f.store.saveResult(round.id, id, { text: '迟到片段', status: 'unfinished', finishedAt: null });
    await assert.rejects(f.store.saveResult(round.id, id, { text: '另一篇', status: 'complete', finishedAt: time(2) }), /不能覆盖/);
    assert.equal((await f.store.getRound(round.id)).results[0].text, '完整结果');
});

test('改名保留历史身份，删卡保留历史，但同文件名的新卡不会继承旧记录', async () => {
    const f = memoryFiles(), round = await f.begin();
    await f.store.renameCharacter('A.png', 'A-new.png', '新名字');
    const renamed = { avatar: 'A-new.png', name: '新名字' };
    await f.begin({ roundId: round.id, character: renamed, startedAt: time(1) });
    assert.equal((await f.store.listCharacters())[0].id, round.characterId);
    await f.store.renameCharacter('A-new.png', null);
    await assert.rejects(f.begin({ roundId: round.id, character: renamed }), /只能查看历史/);
    const newCard = await f.begin({ character: renamed, startedAt: time(2) });
    assert.notEqual(newCard.characterId, round.characterId);
    assert.equal((await f.store.getRound(round.id)).results.length, 2);
});

test('读取期间旧正文被另一标签页清理，会依据新目录重读一次', async () => {
    const f = memoryFiles(), round = await f.begin();
    const oldRow = f.directory().rounds[0], oldFile = playRoundFile(oldRow.id, oldRow.revision);
    const reader = f.createStore();
    let changed = false;
    f.io.beforeRead = async name => {
        if (name !== oldFile || changed) return;
        changed = true;
        await f.store.saveResult(round.id, round.results[0].id, { text: '新正文', status: 'complete', finishedAt: time(1) });
    };
    assert.equal((await reader.getRound(round.id)).results[0].text, '新正文');
});

test('文件名只从内部编号生成；拒绝路径注入和重复结果编号', async () => {
    assert.throws(() => playRoundFile('../settings', randomUUID()));
    const f = memoryFiles(), round = await f.begin();
    assert.throws(() => readPlayRound({ ...round, results: [round.results[0], round.results[0]] }));
});
