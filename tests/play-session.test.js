import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlaySession } from '../play-session.js';
import { createPlayground } from '../playground.js';
import { createPlayCleanup } from '../play-storage.js';
import { memoryFiles, characterA, contextA, time, deferred } from './play-fixture.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    for (let index = 0; index < 200; index++) { if (predicate()) return; await turn(); }
    assert.fail('等待测试状态超时');
}
async function fixture() {
    const f = memoryFiles(), round = await f.begin();
    await f.store.saveResult(round.id, round.results[0].id, { text: '原回复', status: 'complete', finishedAt: time(1) });
    const errors = [], events = [];
    const session = createPlaySession(f.store, { onSaveError: error => errors.push(error.message), onChange: event => events.push(event) });
    await session.getRound(round.id);
    return { ...f, session, errors, events, chat: session.currentChat(round.id) };
}

test('四种消息编辑立即显示，保存确认不覆盖后续修改，跨页使用同一正文', async () => {
    for (const page of ['round', 'chat']) for (const role of ['user', 'assistant']) {
        const f = await fixture(), message = f.chat.messages.find(message => message.role === role);
        const resultId = message.results?.[0].id, original = role === 'user' ? message.text : message.results[0].text;
        const gate = deferred(), entered = deferred(), edit = f.store.editMessage.bind(f.store);
        f.store.editMessage = async (...args) => { entered.resolve(); await gate.promise; return edit(...args); };
        f.session.edit(f.chat.id, message.id, { resultId, text: '第一份修改', expectedText: original });
        await entered.promise;
        assert.equal(role === 'user' ? f.session.currentRound(f.chat.id).prompt : f.session.currentRound(f.chat.id).results[0].text, '第一份修改', page);
        f.session.edit(f.chat.id, message.id, { resultId, text: '第二份修改', expectedText: '第一份修改' });
        assert.equal(role === 'user' ? (await f.session.getChat(f.chat.id)).messages[0].text
            : (await f.session.getRound(f.chat.id)).results[0].text, '第二份修改');
        gate.resolve(); await f.session.flush(f.chat.id);
        const saved = await f.createStore().getRound(f.chat.id);
        assert.equal(role === 'user' ? saved.prompt : saved.results[0].text, '第二份修改');
        assert.equal(f.session.hasUnsaved(), false);
    }
});

test('编辑保存失败只报告一次，正文保留，相同正文再次保存可以补存', async () => {
    const f = await fixture(), message = f.chat.messages[1], resultId = message.results[0].id;
    const edit = f.store.editMessage.bind(f.store);
    f.store.editMessage = () => { throw Error('模拟保存失败'); };
    f.session.edit(f.chat.id, message.id, { resultId, text: '保留的新正文', expectedText: '原回复' });
    await until(() => f.errors.length === 1);
    assert.equal(f.session.currentRound(f.chat.id).results[0].text, '保留的新正文');
    assert.equal(f.session.currentRound(f.chat.id).results[0].status, 'complete');
    assert.equal(f.session.hasUnsaved(), true);
    f.store.editMessage = edit;
    f.session.edit(f.chat.id, message.id, { resultId, text: '保留的新正文', expectedText: '保留的新正文' });
    await f.session.flush(f.chat.id);
    assert.equal((await f.createStore().getRound(f.chat.id)).results[0].text, '保留的新正文');
    assert.deepEqual(f.errors, ['模拟保存失败']);
});

test('旧读取晚于本地编辑返回时不能覆盖新正文，也不能清除未保存状态', async () => {
    const f = await fixture(), captured = deferred(), gate = deferred(), read = f.store.getChatWindow.bind(f.store);
    f.store.getChatWindow = async (...args) => { const window = await read(...args); captured.resolve(); await gate.promise; return window; };
    const reading = f.session.getChatWindow(f.chat.id, { latest: true }); await captured.promise;
    const save = deferred(), edit = f.store.editMessage.bind(f.store);
    f.store.editMessage = async (...args) => { await save.promise; return edit(...args); };
    f.session.edit(f.chat.id, f.chat.messages[0].id, { text: '读取期间修改', expectedText: f.chat.messages[0].text });
    gate.resolve();
    assert.equal((await reading).chat.messages[0].text, '读取期间修改');
    assert.equal(f.session.hasUnsaved(), true);
    save.resolve(); await f.session.flush(f.chat.id);
});

test('后台保存中的下一条先显示，模型请求等前序终稿及本次消息保存完成', async () => {
    const f = await fixture(), saveGate = deferred(), saving = deferred(), requests = [], events = [];
    const save = f.store.saveResult.bind(f.store);
    let hold = true;
    f.store.saveResult = async (...args) => { if (hold) { saving.resolve(); await saveGate.promise; } return save(...args); };
    const service = createPlayground({ history: f.store, captureEnvironment: () => ({ character: characterA, context: contextA, independent: true }),
        isCurrent: () => true, prepareRequest: async request => { requests.push(request); return { send: async () => `回复${requests.length}` }; } });
    service.subscribe(event => events.push(event));
    await service.getChat(f.chat.id);
    const first = service.sendChat(f.chat.id, { prompt: '第一条', character: characterA }); await saving.promise;
    assert.equal(service.getStates().length, 0);
    assert.equal(service.availability({ chatId: f.chat.id }).available, true);
    const second = service.sendChat(f.chat.id, { prompt: '第二条', character: characterA });
    await until(() => service.session.currentChat(f.chat.id).messages.length === 6);
    assert.equal(service.session.currentChat(f.chat.id).messages.at(-2).text, '第二条');
    assert.equal(requests.length, 1);
    assert.ok(events.some(event => event.chat?.messages.at(-2)?.text === '第二条'));
    hold = false; saveGate.resolve(); await Promise.all([first, second]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].environment.branchHistory.map(message => message.text), [f.chat.messages[0].text, '原回复', '第一条', '回复1']);
});

test('等待前序保存时停止立即结束准备，迟到保存不会请求 AI', async () => {
    const f = await fixture(), gate = deferred(), entered = deferred(), requests = [];
    const edit = f.store.editMessage.bind(f.store);
    f.store.editMessage = async (...args) => { entered.resolve(); await gate.promise; return edit(...args); };
    const service = createPlayground({ history: f.store, captureEnvironment: () => ({ character: characterA, context: contextA }), isCurrent: () => true,
        prepareRequest: async request => { requests.push(request); return { send: async () => '不应请求' }; } });
    await service.getChat(f.chat.id);
    await service.editPrompt(f.chat.id, '后台修改', f.chat.messages[0].text); await entered.promise;
    const task = service.sendChat(f.chat.id, { prompt: '停止的发送', character: characterA });
    await until(() => service.session.currentChat(f.chat.id).messages.length === 4);
    assert.equal(service.stop(), true); assert.equal(await task, null);
    assert.equal(service.getStates().length, 0);
    assert.equal(service.session.currentChat(f.chat.id).messages.at(-1).results[0].status, 'stopped');
    gate.resolve(); await service.session.flush(f.chat.id);
    assert.equal(requests.length, 0);
    assert.equal((await f.createStore().getChat(f.chat.id)).messages.at(-2).text, '停止的发送');
});

test('发送前保存失败保留用户文字，再次发送只请求这次新消息且不重复旧楼层', async () => {
    const f = await fixture(), errors = [], requests = [];
    const begin = f.store.begin.bind(f.store);
    f.store.begin = () => { throw Error('模拟开始保存失败'); };
    const service = createPlayground({ history: f.store, onSaveError: error => errors.push(error.message),
        captureEnvironment: () => ({ character: characterA, context: contextA }), isCurrent: () => true,
        prepareRequest: async request => { requests.push(request); return { send: async () => '新的回复' }; } });
    await service.getChat(f.chat.id);
    assert.equal(await service.sendChat(f.chat.id, { prompt: '保留这条', character: characterA }), null);
    assert.equal(service.session.currentChat(f.chat.id).messages.length, 4);
    assert.equal(service.session.currentChat(f.chat.id).messages.at(-1).results[0].status, 'stopped');
    assert.deepEqual(errors, ['模拟开始保存失败']); assert.equal(requests.length, 0);
    f.store.begin = begin;
    await service.sendChat(f.chat.id, { prompt: '这次才请求', character: characterA });
    assert.equal(requests.length, 1); assert.equal(requests[0].prompt, '这次才请求');
    assert.equal((await f.createStore().getChat(f.chat.id)).messages.length, 6);
});

test('新发送的消息编号在显示与保存之间保持一致，目录读取包含尚未保存的新演出', async () => {
    const f = memoryFiles(), gate = deferred(), entered = deferred();
    const begin = f.store.begin.bind(f.store);
    f.store.begin = async (...args) => { entered.resolve(); await gate.promise; return begin(...args); };
    const service = createPlayground({ history: f.store, captureEnvironment: () => ({ character: characterA, context: contextA }), isCurrent: () => true,
        prepareRequest: async () => ({ send: async () => '回复' }) });
    const task = service.send({ prompt: '新演出' }); await entered.promise;
    const state = service.getState(), chat = service.session.currentChat(state.roundId);
    const characters = await service.listCharacters(); assert.equal(characters.length, 1);
    assert.equal((await service.listRounds(characters[0].id))[0].id, state.roundId);
    assert.equal((await service.getChatPreview(state.roundId)).messages.length, 1);
    gate.resolve(); await task;
    const saved = await f.store.getChat(state.roundId);
    assert.deepEqual(saved.messages.map(message => message.id), chat.messages.map(message => message.id));
    assert.equal(saved.messages[1].results[0].id, state.resultId);
});

test('两窗口冲突保留本页新文字且不覆盖另一窗口文件', async () => {
    const f = await fixture(), edit = f.store.editMessage.bind(f.store), gate = deferred(), entered = deferred();
    f.store.editMessage = async (...args) => { entered.resolve(); await gate.promise; return edit(...args); };
    f.session.edit(f.chat.id, f.chat.messages[0].id, { text: '本页修改', expectedText: f.chat.messages[0].text });
    await entered.promise;
    await f.createStore().editMessage(f.chat.id, f.chat.messages[0].id, { text: '他窗修改', expectedText: f.chat.messages[0].text });
    gate.resolve(); await until(() => f.errors.length === 1);
    assert.equal(f.session.currentRound(f.chat.id).prompt, '本页修改');
    assert.equal((await f.createStore().getRound(f.chat.id)).prompt, '他窗修改');
    assert.equal(f.session.hasUnsaved(), true);
});

test('演出记录局部编辑不读取无关后续正文，正常结果保存不重读起始正文', async () => {
    const f = await fixture(), resultId = randomUUID();
    await f.store.begin({ roundId: f.chat.id, chatMode: true, operation: 'send', character: characterA, context: contextA,
        prompt: '后续', resultId, startedAt: time(2) });
    await f.store.saveResult(f.chat.id, resultId, { text: '后续回复', status: 'complete', finishedAt: time(3) });
    const reads = [], store = f.createStore();
    f.io.beforeRead = name => { reads.push(name); if (name.startsWith(`teahouse-play-body-${resultId}`)) throw Error('无关正文损坏'); };
    await store.editPrompt(f.chat.id, '只改起始用户', f.chat.messages[0].text);
    await store.editResult(f.chat.id, f.chat.messages[1].results[0].id, '只改起始回复', '原回复');
    assert.ok(reads.every(name => !name.startsWith(`teahouse-play-body-${resultId}`)));
});

test('独立清理慢或失败不阻止保存成功和下一次提交，删除只接收淘汰文件', async () => {
    const f = memoryFiles(), gate = deferred(), cleanup = createPlayCleanup(), retired = [];
    const { createPlayHistory } = await import('../play-history.js');
    const store = createPlayHistory({ ...f.io, uuid: randomUUID, enqueueCleanup: (names, operation) => cleanup(names,
        async name => { retired.push(name); await gate.promise; throw Error('清理失败'); }, () => {}, operation) });
    const round = await store.begin({ character: characterA, context: contextA, prompt: '清理测试', resultId: randomUUID(), startedAt: time(0) });
    await store.saveResult(round.id, round.results[0].id, { text: '完成正文', status: 'complete', finishedAt: time(1) });
    await store.editPrompt(round.id, '清理期间继续保存', round.prompt);
    assert.ok(retired.length > 0);
    assert.equal((await store.getRound(round.id)).prompt, '清理期间继续保存');
    gate.resolve(); await turn();
    assert.ok(retired.every(name => /^teahouse-play-(?:body-)?[a-f0-9-]+\.json$/.test(name)));
});

test('聊天命令按顺序保存，迟到返回不覆盖稍后编辑，新发送使用固定历史', async () => {
    const f = await fixture(), gate = deferred(), entered = deferred();
    const rename = f.store.renameChat.bind(f.store);
    const renaming = f.session.mutate(f.chat.id, async revision => {
        entered.resolve(); await gate.promise; return rename(f.chat.id, '修改名称', revision);
    }, f.chat.revision);
    await entered.promise;
    f.session.edit(f.chat.id, f.chat.messages[0].id, { text: '改名期间的修改', expectedText: f.chat.messages[0].text });
    assert.equal(f.session.currentRound(f.chat.id).prompt, '改名期间的修改');
    gate.resolve(); await renaming; await f.session.flush(f.chat.id);
    assert.equal(f.session.currentRound(f.chat.id).prompt, '改名期间的修改');
    assert.equal((await f.createStore().getChat(f.chat.id)).name, '修改名称');
    assert.equal((await f.createStore().getRound(f.chat.id)).prompt, '改名期间的修改');
});

test('未确认保存阻止关联命令，恢复后不会自动重放失败的删除', async () => {
    const f = await fixture(), edit = f.store.editMessage.bind(f.store);
    f.store.editMessage = () => { throw Error('保存失败'); };
    f.session.edit(f.chat.id, f.chat.messages[0].id, { text: '待保存修改', expectedText: f.chat.messages[0].text });
    await until(() => f.errors.length === 1);
    let commands = 0;
    await assert.rejects(f.session.mutate(f.chat.id, () => { commands++; return f.store.deleteChat(f.chat.id); }), /保存失败/);
    f.store.editMessage = edit; await f.session.flush(f.chat.id);
    assert.equal(commands, 0); assert.equal((await f.store.getRound(f.chat.id)).prompt, '待保存修改');
});

test('目录旧读取在保存成功后返回仍显示新正文，删除后的清洁缓存不重加目录', async () => {
    const f = await fixture(), gate = deferred(), entered = deferred();
    const read = f.store.getChatPreview.bind(f.store);
    f.store.getChatPreview = async (...args) => { const preview = await read(...args); entered.resolve(); await gate.promise; return preview; };
    const reading = f.session.directory(f.chat.id); await entered.promise;
    f.session.edit(f.chat.id, f.chat.messages[1].id, { text: '目录读取后的修改', resultId: f.chat.messages[1].results[0].id, expectedText: '原回复' });
    await f.session.flush(f.chat.id); gate.resolve();
    assert.equal((await reading).messages[0].text, '目录读取后的修改');
    await f.store.deleteChat(f.chat.id);
    assert.deepEqual(await f.session.listRounds(f.chat.characterId), []);
});

test('读取窗口失败时保留未保存内容，编辑只加载目标版本', async () => {
    const f = await fixture(), save = deferred(), edit = f.store.editMessage.bind(f.store);
    f.store.editMessage = async (...args) => { await save.promise; return edit(...args); };
    f.session.edit(f.chat.id, f.chat.messages[0].id, { text: '窗口失败也保留', expectedText: f.chat.messages[0].text });
    f.store.getChatWindow = () => { throw Error('读取失败'); };
    assert.equal((await f.session.getChatWindow(f.chat.id, { latest: true })).chat.messages[0].text, '窗口失败也保留');
    save.resolve(); await f.session.flush(f.chat.id);
});

test('查询缓存有数量与正文限制，尚未保存内容不被淘汰', async () => {
    const chat = { format: 2, revision: 'revision', characterId: 'character', messages: [{ id: 'user', role: 'user', bodyRevision: 'body', text: '正文' }], startMessageIds: ['user'] };
    const session = createPlaySession({ getChat: id => ({ ...chat, id }), editMessage: () => new Promise(() => {}) });
    await session.getChat('dirty'); session.edit('dirty', 'user', { text: '不能淘汰', expectedText: '正文' });
    for (let index = 0; index < 60; index++) await session.getChat(`clean${index}`);
    assert.equal(session.currentChat('clean0'), null);
    assert.equal(session.currentChat('dirty').messages[0].text, '不能淘汰');
});

test('同聊天生成时修改名称仍保存，保留实时正文', async () => {
    const f = await fixture(), ready = deferred(), finish = deferred();
    const service = createPlayground({ history: f.store, captureEnvironment: () => ({ character: characterA, context: contextA }), isCurrent: () => true,
        prepareRequest: async () => ({ send: async ({ onText }) => { onText('生成中的正文'); ready.resolve(); return finish.promise; } }) });
    await service.getChat(f.chat.id);
    const task = service.sendChat(f.chat.id, { prompt: '下一条', character: characterA }); await ready.promise;
    const current = service.session.currentChat(f.chat.id);
    await service.renameChat(f.chat.id, '生成时修改名称', current.revision);
    assert.equal(service.session.currentChat(f.chat.id).name, '生成时修改名称');
    assert.equal(service.session.currentChat(f.chat.id).messages.at(-1).results[0].text, '生成中的正文');
    assert.equal((await f.store.getChat(f.chat.id)).name, '生成时修改名称');
    finish.resolve('最后正文'); await task;
});

test('编辑旧版本后的选择失败只报告一次，正文已保存，下一操作补齐选择', async () => {
    const f = await fixture(), oldId = f.chat.messages[1].results[0].id, newId = randomUUID();
    await f.store.begin({ roundId: f.chat.id, character: characterA, resultId: newId, context: contextA, startedAt: time(2) });
    await f.store.saveResult(f.chat.id, newId, { text: '第二个版本', status: 'complete', finishedAt: time(3) });
    const chat = await f.session.getChat(f.chat.id), select = f.store.setMessageVersion.bind(f.store);
    f.store.setMessageVersion = () => { throw Error('版本选择保存失败'); };
    f.session.edit(chat.id, chat.messages[1].id, { resultId: oldId, text: '旧版本的新正文', expectedText: '原回复' }, { select: true });
    await until(() => f.errors.length === 1);
    const saved = await f.store.getChat(chat.id);
    assert.equal(saved.messages[1].results[0].text, '旧版本的新正文');
    assert.equal(saved.messages[1].selectedResultId, newId);
    assert.equal(f.session.currentChat(chat.id).messages[1].selectedResultId, oldId);
    assert.equal(f.session.hasUnsaved(), true);
    f.store.setMessageVersion = select; await f.session.flush(chat.id);
    assert.equal((await f.store.getChat(chat.id)).messages[1].selectedResultId, oldId);
    assert.deepEqual(f.errors, ['版本选择保存失败']);
});

test('开始保存已完成但回包丢失时，重试沿用消息编号且不会重复发送', async () => {
    const f = await fixture(), begin = f.store.begin.bind(f.store), requests = [], errors = [];
    let lose = true;
    f.store.begin = async (...args) => { const saved = await begin(...args); if (lose) throw Error('开始保存回包丢失'); return saved; };
    const service = createPlayground({ history: f.store, onSaveError: error => errors.push(error.message),
        captureEnvironment: () => ({ character: characterA, context: contextA }), isCurrent: () => true,
        prepareRequest: async request => { requests.push(request.prompt); return { send: async () => '新回复' }; } });
    await service.getChat(f.chat.id);
    await service.sendChat(f.chat.id, { character: characterA, prompt: '第一次的正文' });
    assert.equal(requests.length, 0);
    const ids = service.session.currentChat(f.chat.id).messages.map(message => message.id);
    lose = false; await service.sendChat(f.chat.id, { character: characterA, prompt: '第二次的正文' });
    const saved = await f.store.getChat(f.chat.id);
    assert.deepEqual(saved.messages.slice(0, 4).map(message => message.id), ids);
    assert.equal(saved.messages.length, 6); assert.deepEqual(requests, ['第二次的正文']);
});

test('发送接收后继续编辑旧消息，本次请求使用接收时的历史，后续编辑仍保存', async () => {
    const f = await fixture(), gate = deferred(), entered = deferred(), begin = f.store.begin.bind(f.store), requests = [];
    f.store.begin = async (...args) => { entered.resolve(); await gate.promise; return begin(...args); };
    const service = createPlayground({ history: f.store, captureEnvironment: () => ({ character: characterA, context: contextA }), isCurrent: () => true,
        prepareRequest: async request => { requests.push(request); return { send: async () => '当前回复' }; } });
    await service.getChat(f.chat.id);
    const sending = service.sendChat(f.chat.id, { character: characterA, prompt: '本次发送' }); await entered.promise;
    await service.editPrompt(f.chat.id, '接收之后又编辑', f.chat.messages[0].text);
    gate.resolve(); await sending; await service.session.flush(f.chat.id);
    assert.equal(requests[0].environment.branchHistory[0].text, f.chat.messages[0].text);
    assert.equal((await f.store.getRound(f.chat.id)).prompt, '接收之后又编辑');
});
