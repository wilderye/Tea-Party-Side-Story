import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryFiles, characterA, contextA, time } from './play-fixture.js';
import { PLAY_HISTORY_INDEX, playRoundFile, playBodyFile, playChatTitle, readPlayRound } from '../play-history.js';
import { createPlayground } from '../playground.js';
import { createPlayChatFavorites } from '../play-chat-favorites.js';
import { deferred } from './play-fixture.js';

async function seed(f) {
    const round = await f.begin();
    await f.store.saveResult(round.id, round.results[0].id, { text: '开头一', status: 'complete', finishedAt: time(1) });
    const second = await f.begin({ roundId: round.id, startedAt: time(2) });
    await f.store.saveResult(round.id, second.results[1].id, { text: '开头二', status: 'complete', finishedAt: time(3) });
    const chat = await f.store.getChat(round.id);
    return f.store.setMessageVersion(chat.id, chat.messages[1].id, round.results[0].id);
}

function useLegacyRound(f, round) {
    const directory = f.directory(), row = directory.rounds.find(row => row.id === round.id);
    delete row.kind; delete row.name; delete row.branched;
    f.files.set(playRoundFile(row.id, row.revision), JSON.stringify(readPlayRound(round)));
    f.files.set(PLAY_HISTORY_INDEX, JSON.stringify(directory));
}

async function append(f, chat, prompt, text = '后续回复') {
    const resultId = randomUUID();
    const started = await f.store.begin({ roundId: chat.id, chatMode: true, operation: 'send', prompt,
        character: characterA, context: contextA, resultId, startedAt: time(10), expectedRevision: chat.revision });
    await f.store.saveResult(chat.id, resultId, { text, status: 'complete', finishedAt: time(11) });
    return { chat: await f.store.getChat(chat.id), started };
}

test('旧对子在存储入口转换，保留编号、时间、全部版本和原选择；目录不拆版本', async () => {
    const f = memoryFiles(), seeded = await seed(f), round = await f.store.getRound(seeded.id);
    useLegacyRound(f, round);
    const chat = await f.store.getChat(round.id, { selectedResultId: round.results[0].id });
    assert.equal(chat.format, 2); assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[1].results.length, 2);
    assert.equal(chat.messages[1].selectedResultId, chat.messages[1].results[0].id);
    assert.equal((await f.store.listChats(chat.characterId)).length, 1);
    assert.deepEqual(await f.createStore().getChat(chat.id), chat);
    assert.equal((await f.store.getRound(chat.id)).results.length, 2);
    const writes = f.writes.length;
    await f.store.getChat(chat.id);
    assert.equal(f.writes.length, writes, '重复读取不重复迁移');
    const disk = JSON.parse(f.files.get(playRoundFile(chat.id, chat.revision)));
    assert.equal('text' in disk.messages[0], false);
    assert.equal('text' in disk.messages[1].results[0], false);
});

test('完整聊天追加后游玩只读起始对子；从早期层分支保留全部版本、截掉后续并独立修改', async () => {
    const f = memoryFiles(), initial = await seed(f);
    const { chat } = await append(f, initial, '往后接着玩');
    assert.equal(chat.messages.length, 4);
    const pair = await f.store.getRound(chat.id);
    assert.equal(pair.prompt, initial.messages[0].text); assert.equal(pair.results.length, 2);
    const branch = await f.store.createBranch(chat.id, chat.messages[1].id, chat.revision);
    assert.equal(branch.messages.length, 2); assert.equal(branch.messages[1].results.length, 2);
    assert.notEqual(branch.messages[0].id, chat.messages[0].id);
    assert.equal(branch.messages[1].selectedResultId, branch.messages[1].results[0].id);
    await f.store.editMessage(chat.id, chat.messages[0].id, { text: '修改来源', expectedText: chat.messages[0].text });
    await f.store.editMessage(branch.id, branch.messages[1].id, { text: '修改新分支', expectedText: '开头一', resultId: branch.messages[1].results[0].id });
    assert.equal((await f.store.getChat(branch.id)).messages[0].text, initial.messages[0].text);
    assert.equal((await f.store.getChat(chat.id)).messages[1].results[0].text, '开头一');
    assert.equal((await f.store.listChats(chat.characterId)).length, 2);
    assert.equal((await f.store.listRounds(chat.characterId)).length, 1, '新分支不混入游玩对子');
    const another = await f.store.createBranch(branch.id, branch.messages[1].id);
    assert.notEqual(another.id, branch.id, '每次点击都新建');
});

test('新分支名称避免重名，连续分支不叠加后缀，改名和删除不改变来源关系', async () => {
    const f = memoryFiles(), initial = await seed(f);
    const original = await f.store.renameChat(initial.id, '测试剧情', initial.revision);
    const [first, second] = await Promise.all([
        f.store.createBranch(original.id, original.messages[1].id),
        f.store.createBranch(original.id, original.messages[1].id),
    ]);
    assert.equal(first.name, '测试剧情 · 分支#1');
    assert.equal(second.name, '测试剧情 · 分支#2');
    const third = await f.store.createBranch(first.id, first.messages[1].id);
    assert.equal(third.name, '测试剧情 · 分支#3');
    assert.deepEqual(third.source, { chatId: first.id, messageId: first.messages[1].id });
    await f.store.renameChat(first.id, '独立改名');
    await f.store.deleteChat(second.id);
    assert.deepEqual((await f.store.getChat(third.id)).source, third.source);
    const longName = '长'.repeat(100);
    const renamed = await f.store.renameChat(original.id, longName);
    const longBranch = await f.store.createBranch(renamed.id, renamed.messages[1].id);
    assert.equal(longBranch.name.length, 100);
    assert.match(longBranch.name, / · 分支#1$/);
});

test('版本选择只写元数据；编辑后只写改变的正文，消息删除和清空不删除聊天', async () => {
    const f = memoryFiles(), chat = await seed(f), ai = chat.messages[1];
    const before = f.writes.length, oldTime = (await f.store.listChats(chat.characterId))[0].lastPlayedAt;
    await f.store.setMessageVersion(chat.id, ai.id, ai.results[1].id, ai.selectedResultId);
    assert.equal(f.writes.slice(before).filter(name => name.startsWith('teahouse-play-body-')).length, 0);
    assert.equal((await f.store.listChats(chat.characterId))[0].lastPlayedAt, oldTime);
    let current = await f.store.getChat(chat.id);
    const editStart = f.writes.length;
    current = await f.store.editMessage(chat.id, current.messages[0].id, { text: '改了开头', expectedText: current.messages[0].text });
    assert.equal(f.writes.slice(editStart).filter(name => name.startsWith('teahouse-play-body-')).length, 1);
    current = await f.store.renameChat(chat.id, '重新命名', current.revision);
    assert.equal(playChatTitle(current), '重新命名');
    current = await f.store.truncateChat(chat.id, current.messages[0].id, current.revision);
    assert.deepEqual(current.messages, []);
    assert.equal((await f.store.listChats(chat.characterId)).length, 1);
    const { chat: restarted } = await append(f, current, '新的开头');
    assert.equal((await f.store.getRound(chat.id)).prompt, '新的开头');
    assert.deepEqual(restarted.startMessageIds, restarted.messages.map(message => message.id));
});

test('同一聊天生成期间拒绝发送编辑删除；仍可从前面已保存层创建分支', async () => {
    const f = memoryFiles(), initial = await seed(f), resultId = randomUUID();
    const chat = await f.store.begin({ roundId: initial.id, chatMode: true, operation: 'send', prompt: '新消息',
        character: characterA, context: contextA, resultId, startedAt: time(10) });
    await assert.rejects(f.store.editMessage(chat.id, chat.messages[0].id, { text: '禁止修改', expectedText: chat.messages[0].text }), { code: 'chat_busy' });
    await assert.rejects(f.store.truncateChat(chat.id, chat.messages[0].id), { code: 'chat_busy' });
    await assert.rejects(f.store.begin({ roundId: chat.id, chatMode: true, operation: 'send', prompt: '重复发送',
        character: characterA, context: contextA, resultId: randomUUID(), startedAt: time(11) }), { code: 'chat_busy' });
    assert.equal((await f.store.createBranch(chat.id, chat.messages[1].id)).messages.length, 2);
    await assert.rejects(f.store.createBranch(chat.id, chat.messages[3].id), { code: 'chat_busy' });
});

test('游玩起始对子生成多个版本时可切换查看；分支生成和已有后续的起始楼层仍不可切换', async () => {
    const f = memoryFiles(), initial = await seed(f), ai = initial.messages[1];
    const round = await f.store.begin({ roundId: initial.id, character: characterA, context: contextA,
        resultId: randomUUID(), startedAt: time(8) });
    await assert.rejects(f.store.setMessageVersion(initial.id, ai.id, ai.results[0].id), { code: 'chat_busy' });
    const selected = await f.store.setMessageVersion(initial.id, ai.id, ai.results[0].id, undefined, { playSelection: true });
    assert.equal(selected.messages[1].selectedResultId, ai.results[0].id);
    await f.store.saveResult(round.id, round.results.at(-1).id, { text: '生成完成', status: 'complete', finishedAt: time(9) });
    const next = await f.store.begin({ roundId: initial.id, chatMode: true, operation: 'send', prompt: '后续',
        character: characterA, context: contextA, resultId: randomUUID(), startedAt: time(10) });
    await assert.rejects(f.store.setMessageVersion(next.id, ai.id, ai.results[1].id, undefined, { playSelection: true }), { code: 'message_not_last' });
});

test('迁移和编辑提交失败保留旧指向；另一窗口的变化不会被过期范围删除覆盖', async () => {
    const f = memoryFiles(), round = await f.begin();
    const saved = await f.store.saveResult(round.id, round.results[0].id, { text: '原文', status: 'complete', finishedAt: time(1) });
    useLegacyRound(f, saved);
    const oldIndex = f.files.get(PLAY_HISTORY_INDEX);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟保存失败'); };
    await assert.rejects(f.store.getChat(round.id), /模拟保存失败/);
    assert.equal(f.files.get(PLAY_HISTORY_INDEX), oldIndex);
    assert.equal((await f.store.getRound(round.id)).results[0].text, '原文');
    f.io.beforeWrite = null;
    const chat = await f.store.getChat(round.id);
    await f.createStore().renameChat(chat.id, '另一窗口', chat.revision);
    const current = await f.store.getChat(chat.id);
    await assert.rejects(f.store.truncateChat(chat.id, chat.messages[0].id, chat.revision), { code: 'chat_conflict' });
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟保存失败'); };
    await assert.rejects(f.store.editMessage(chat.id, chat.messages[0].id, { text: '没保存的修改', expectedText: chat.messages[0].text }), /模拟保存失败/);
    assert.deepEqual(await f.createStore().getChat(chat.id), current);
});

test('分支请求追加当前历史、同分支锁定、不同分支并发和独立停止；续写不重复末尾回复', async () => {
    const f = memoryFiles(), chat = await seed(f), branch = await f.store.createBranch(chat.id, chat.messages[1].id);
    const requests = [], gates = new Map(), prepared = deferred();
    const service = createPlayground({ history: f.store, isCurrent: () => true,
        captureEnvironment: () => ({ character: characterA, context: contextA, independent: true }),
        prepareRequest: async options => {
            requests.push(options);
            const gate = deferred(); gates.set(options.prompt, gate); prepared.resolve();
            return { send: async ({ onText }) => { onText('逐字片段'); return gate.promise; } };
        },
    });
    const target = { character: characterA, characterId: chat.characterId };
    const a = service.sendChat(chat.id, { ...target, prompt: '分支A下一轮' });
    await prepared.promise;
    assert.equal(service.availability({ chatId: chat.id }).available, false);
    await assert.rejects(service.sendChat(chat.id, { ...target, prompt: '禁止重复' }), { code: 'busy' });
    await assert.rejects(service.finishUnfinishedChat(chat.id), { code: 'busy' });
    const b = service.sendChat(branch.id, { ...target, prompt: '分支B下一轮' });
    while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(requests[0].environment.branchHistory.map(message => message.text), ['雨夜重逢的完整提示词', '开头一']);
    assert.equal(service.getStates().length, 2);
    const aJob = service.getStates().find(job => job.requestedRoundId === chat.id);
    service.stop(aJob.resultId); await a;
    gates.get('分支B下一轮').resolve('B完整回复'); await b;
    assert.equal((await f.store.getChat(chat.id)).messages.at(-1).results[0].status, 'stopped');
    assert.equal((await f.store.getChat(branch.id)).messages.at(-1).results[0].text, 'B完整回复');
    let options;
    const continuation = createPlayground({ history: f.store, isCurrent: () => true,
        captureEnvironment: () => ({ character: characterA, context: contextA, independent: true }),
        prepareRequest: async request => { options = request; return { send: async () => request.continueMessage + '接续' }; } });
    const current = await f.store.getChat(branch.id), ai = current.messages.at(-1);
    await continuation.continueChat(branch.id, ai.id, ai.selectedResultId, target);
    assert.equal(options.prompt, '分支B下一轮');
    assert.equal(options.continueMessage, 'B完整回复');
    assert.equal(options.environment.branchHistory.length, 2);
    assert.equal((await f.store.getChat(branch.id)).messages.at(-1).results[0].text, 'B完整回复接续');
});

test('整条收藏明确同步缺少的内容；版本复用、编辑单条和删除来源冻结', async () => {
    const f = memoryFiles(), chat = await seed(f), processed = [];
    let rule = '旧规则';
    const coordinator = createPlayChatFavorites(f.store, { ensure: async () => {}, process: text => { processed.push(text); return rule + text; } });
    const favorite = await coordinator.add(chat.id);
    assert.equal(processed.length, 2);
    rule = '新规则';
    let read = await coordinator.sync(favorite.id);
    assert.equal(processed.length, 2); assert.equal(read.messages[1].text, '旧规则开头一');
    await f.store.setMessageVersion(chat.id, chat.messages[1].id, chat.messages[1].results[1].id);
    read = await coordinator.sync(favorite.id);
    assert.equal(processed.length, 3); assert.equal(read.messages[1].text, '新规则开头二');
    await f.store.setMessageVersion(chat.id, chat.messages[1].id, chat.messages[1].results[0].id);
    await coordinator.sync(favorite.id); assert.equal(processed.length, 3);
    let current = await f.store.editMessage(chat.id, chat.messages[0].id, { text: '改过的提示词', expectedText: chat.messages[0].text });
    read = await coordinator.sync(favorite.id); assert.equal(processed.length, 4);
    assert.equal(read.messages[0].text, '新规则改过的提示词'); assert.equal(read.messages[1].text, '旧规则开头一');
    current = (await append(f, current, '还没阅读的新消息', '还没阅读的新回复')).chat;
    assert.equal(processed.length, 4, '游玩期间不更新整条收藏');
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('冻结保存失败'); };
    await assert.rejects(coordinator.removeChat(chat.id, current.revision), /冻结保存失败/);
    assert.equal((await f.store.getChat(chat.id)).messages.length, 4, '冻结失败不删除来源');
    f.io.beforeWrite = null;
    await coordinator.removeChat(chat.id, current.revision);
    await assert.rejects(f.store.getChat(chat.id), { code: 'chat_missing' });
    read = await coordinator.sync(favorite.id); assert.equal(read.frozen, true); assert.equal(read.messages.length, 4);
    assert.equal(read.messages[1].text, '旧规则开头一');
    const count = processed.length; await coordinator.sync(favorite.id); assert.equal(processed.length, count);
});

test('历史预览只读末层选中正文，全文搜索只读各层选中版本；迟到检查点不改其它正文', async () => {
    const f = memoryFiles(), initial = await seed(f), { chat } = await append(f, initial, '第二条用户消息', '最新AI正文');
    const reads = []; f.io.beforeRead = name => reads.push(name);
    const preview = await f.createStore().getChatPreview(chat.id);
    assert.equal(preview.messages.length, 1); assert.equal(preview.messages[0].text, '最新AI正文');
    assert.equal(reads.filter(name => name.startsWith('teahouse-play-body-')).length, 1);
    reads.length = 0;
    const search = await f.createStore().getChatSearch(chat.id);
    assert.deepEqual(search.messages.map(message => message.text), ['雨夜重逢的完整提示词', '开头一', '第二条用户消息', '最新AI正文']);
    assert.equal(reads.filter(name => name.startsWith('teahouse-play-body-')).length, 4, '不读取未选中的开头二');
    const resultId = randomUUID();
    await f.store.begin({ roundId: chat.id, chatMode: true, operation: 'send', prompt: '第三轮', character: characterA,
        context: contextA, resultId, startedAt: time(12) });
    reads.length = 0;
    const other = f.createStore(), writeStart = f.writes.length;
    await other.saveResult(chat.id, resultId, { text: '流式保存', status: 'unfinished', finishedAt: null });
    assert.equal(reads.filter(name => name.startsWith('teahouse-play-body-')).length, 1, '分支检查点只读活跃正文');
    assert.equal(f.writes.slice(writeStart).filter(name => name.startsWith('teahouse-play-body-')).length, 1);
    const saved = await f.store.getChat(chat.id);
    assert.deepEqual(saved.messages.slice(0, 4), chat.messages, '轻量检查点不会写入占位正文');
});

test('刷新后的未完成分支可明确结束并保留文字', async () => {
    const f = memoryFiles(), initial = await seed(f), resultId = randomUUID();
    await f.store.begin({ roundId: initial.id, chatMode: true, operation: 'send', prompt: '中断的请求',
        character: characterA, context: contextA, resultId, startedAt: time(10) });
    await f.store.saveResult(initial.id, resultId, { text: '已保存的部分正文', status: 'unfinished', finishedAt: null });
    const service = createPlayground({ history: f.createStore(), prepareRequest: async () => ({ send: async () => '新的回复' }),
        captureEnvironment: () => ({ character: characterA, context: contextA, independent: true }), isCurrent: () => true });
    await service.finishUnfinishedChat(initial.id);
    const stopped = await f.store.getChat(initial.id);
    assert.equal(stopped.messages.at(-1).results[0].text, '已保存的部分正文');
    assert.equal(stopped.messages.at(-1).results[0].status, 'stopped');
    assert.equal((await service.sendChat(initial.id, { character: characterA, characterId: initial.characterId, prompt: '继续聊' })).result.text, '新的回复');
});

test('长对话末尾保存只读写活跃正文，未改名的提示词节选标题不变', async () => {
    const f = memoryFiles(), round = await f.begin({ origin: null });
    await f.store.saveResult(round.id, round.results[0].id, { text: '开头', status: 'complete', finishedAt: time(1) });
    let chat = await f.store.getChat(round.id);
    for (let i = 0; i < 35; i++) chat = (await append(f, chat, `用户${i}`, '长正文'.repeat(500))).chat;
    const resultId = randomUUID();
    await f.store.begin({ roundId: chat.id, chatMode: true, operation: 'send', prompt: '最后一轮', character: characterA,
        context: contextA, resultId, startedAt: time(20) });
    const reads = [], bytes = []; f.io.beforeRead = name => reads.push(name);
    f.io.beforeWrite = (name, text) => bytes.push({ name, length: Buffer.byteLength(text) });
    await f.createStore().saveResult(chat.id, resultId, { text: '小段最终正文', status: 'complete', finishedAt: time(21) });
    assert.equal(reads.filter(name => name.startsWith('teahouse-play-body-')).length, 1);
    assert.equal(bytes.filter(entry => entry.name.startsWith('teahouse-play-body-')).length, 1);
    assert.ok(bytes.filter(entry => entry.name.startsWith('teahouse-play-body-')).reduce((size, entry) => size + entry.length, 0) < 300);
    assert.equal((await f.store.listChats(chat.characterId))[0].name, round.prompt);
});

test('删除消息跟随整条收藏，取消整条不动单条，删除来源不影响已创建分支', async () => {
    const f = memoryFiles(), initial = await seed(f), { chat } = await append(f, initial, '第二轮用户', '第二轮AI');
    const branch = await f.store.createBranch(chat.id, chat.messages[1].id);
    const coordinator = createPlayChatFavorites(f.store, { ensure: async () => {}, process: text => text });
    const whole = await coordinator.add(chat.id), first = chat.messages[1].results[0];
    const single = await f.store.addFavorite({ roundId: chat.id, messageId: chat.messages[1].id, resultId: first.id,
        startedAt: first.startedAt, expectedText: first.text, text: first.text, firstLine: first.text });
    await f.store.removeMessage(chat.id, chat.messages[1].id);
    const read = await coordinator.sync(whole.id);
    assert.equal(read.messages.length, 3);
    assert.equal(read.messages.some(message => message.messageId === chat.messages[1].id), false);
    assert.equal((await f.store.getFavorite(single.id)).text, first.text);
    await f.store.removeFavorite(whole.id);
    assert.equal((await f.store.listFavorites()).length, 1);
    await coordinator.removeChat(chat.id);
    assert.deepEqual((await f.store.getChat(branch.id)).messages.map(message => message.role), ['user', 'assistant']);
});

test('分支重新生成只替换选中版本；停止后其他版本仍可读取', async () => {
    const f = memoryFiles(), source = await seed(f);
    const branch = await f.store.createBranch(source.id, source.messages[1].id);
    const assistant = branch.messages[1], previous = structuredClone(assistant.results);
    const resultId = randomUUID();
    const started = await f.store.begin({ roundId: branch.id, chatMode: true, operation: 'regenerate',
        messageId: assistant.id, replaceResultId: assistant.selectedResultId, resultId,
        character: characterA, context: contextA, startedAt: time(10), expectedRevision: branch.revision });
    assert.equal(started.messages[1].results.length, 2);
    assert.equal(started.messages[1].results[0].id, resultId);
    assert.deepEqual(started.messages[1].results[1], previous[1]);
    await f.store.saveResult(branch.id, resultId, { text: '', status: 'stopped', finishedAt: time(11) });
    const saved = await f.createStore().getChat(branch.id);
    assert.deepEqual(saved.messages[1].results[1], previous[1]);
    assert.equal((await f.store.getChat(source.id)).messages[1].results.length, 2);
});

test('修改聊天名称只读元数据；缺失正文不影响改名，也不删除正文引用', async () => {
    const f = memoryFiles(), initial = await seed(f), { chat } = await append(f, initial, '第二条消息');
    const missing = chat.messages.at(-1).results[0];
    f.files.delete(playBodyFile(missing.id, missing.bodyRevision));
    const before = JSON.parse(f.files.get(playRoundFile(chat.id, chat.revision))), reads = [], writes = f.writes.length;
    f.io.beforeRead = name => reads.push(name);
    const renamed = await f.createStore().renameChat(chat.id, '修改后的名称', chat.revision);
    assert.equal(renamed.name, '修改后的名称');
    assert.equal(reads.filter(name => name.startsWith('teahouse-play-body-')).length, 0);
    assert.equal(f.writes.slice(writes).filter(name => name.startsWith('teahouse-play-body-')).length, 0);
    const after = JSON.parse(f.files.get(playRoundFile(chat.id, renamed.revision)));
    assert.deepEqual(after.messages, before.messages);
    assert.equal((await f.store.listChats(chat.characterId))[0].name, '修改后的名称');
});

test('清空聊天名称只读取用于标题的首条用户消息，恢复最新提示词节选', async () => {
    const f = memoryFiles(), round = await f.begin({ origin: null });
    await f.store.saveResult(round.id, round.results[0].id, { text: '开头回复', status: 'complete', finishedAt: time(1) });
    let chat = await f.store.getChat(round.id);
    chat = await f.store.editMessage(chat.id, chat.messages[0].id, { text: '新的开头提示词', expectedText: chat.messages[0].text });
    chat = (await append(f, chat, '后续用户')).chat;
    const named = await f.store.renameChat(chat.id, '手动名称', chat.revision), reads = [];
    f.io.beforeRead = name => reads.push(name);
    await f.createStore().renameChat(chat.id, '', named.revision);
    assert.equal((await f.store.listChats(chat.characterId))[0].name, '新的开头提示词');
    assert.equal(reads.filter(name => name.startsWith('teahouse-play-body-')).length, 1);
});

test('从早期回复创建分支不读取被截掉的后续正文', async () => {
    const f = memoryFiles(), initial = await seed(f), { chat } = await append(f, initial, '后续用户');
    const tail = chat.messages.at(-1).results[0];
    f.files.delete(playBodyFile(tail.id, tail.bodyRevision));
    const reads = []; f.io.beforeRead = name => reads.push(name);
    const branch = await f.createStore().createBranch(chat.id, chat.messages[1].id, chat.revision);
    assert.equal(branch.messages.length, 2);
    assert.deepEqual(branch.messages[1].results.map(result => result.text), ['开头一', '开头二']);
    assert.equal(reads.includes(playBodyFile(tail.id, tail.bodyRevision)), false);
    assert.deepEqual(branch.source, { chatId: chat.id, messageId: chat.messages[1].id });
});

test('读取已保存收藏不读取来源或上传；同步失败后仍可读取并重试更新', async () => {
    const f = memoryFiles(), chat = await seed(f);
    const coordinator = createPlayChatFavorites(f.store, { ensure: async () => {}, process: text => text });
    const favorite = await coordinator.add(chat.id);
    await f.store.editMessage(chat.id, chat.messages[0].id, { text: '更新的用户消息', expectedText: chat.messages[0].text });
    const reads = [], writes = f.writes.length; f.io.beforeRead = name => reads.push(name);
    assert.equal((await coordinator.read(favorite.id)).messages[0].text, chat.messages[0].text);
    assert.equal(f.writes.length, writes);
    assert.equal(reads.some(name => name.startsWith('teahouse-play-round-')), false);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟上传失败'); };
    await assert.rejects(coordinator.sync(favorite.id), /模拟上传失败/);
    assert.equal((await coordinator.read(favorite.id)).messages[0].text, chat.messages[0].text);
    f.io.beforeWrite = null;
    assert.equal((await coordinator.sync(favorite.id)).messages[0].text, '更新的用户消息');
});
