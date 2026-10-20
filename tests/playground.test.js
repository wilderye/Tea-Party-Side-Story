import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { createPlayground } from '../playground.js';
import { PLAY_HISTORY_INDEX } from '../play-history.js';
import { createDiagnostics } from '../diagnostics.js';
import { memoryFiles, characterA, characterB, contextA, deferred, time } from './play-fixture.js';

test('编辑用户消息不请求模型，其他角色也能修改，后续生成使用保存后的提示词', async () => {
    const f = fixture(), first = await f.service.send({ prompt: '原来的用户消息' });
    f.current.character = { ...characterB }; f.current.chatId = 'B-main';
    const edited = await f.service.editPrompt(first.roundId, '修改后的用户消息', '原来的用户消息');
    assert.equal(edited.prompt, '修改后的用户消息');
    assert.deepEqual(edited.results, [first.result]);
    assert.equal(f.sent.length, 1);
    f.current.character = { ...characterA }; f.current.chatId = contextA.chatId;
    await f.service.generateAnother(first.roundId);
    await f.service.regenerate(first.roundId, first.result.id);
    assert.deepEqual(f.prepared.map(request => request.prompt), ['原来的用户消息', '修改后的用户消息', '修改后的用户消息']);
    assert.equal((await f.restart().getRound(first.roundId)).results.length, 2);
});

test('生成中也能修改用户消息，保留本次回复，下一次生成使用新提示词', async () => {
    const f = fixture(), first = await f.service.send({ prompt: '已结束的用户消息' }), started = deferred(), finish = deferred();
    f.control.response = async ({ onText }) => { onText('已经收到的片段'); started.resolve(); return finish.promise; };
    const task = f.service.send({ prompt: '生成中的用户消息' });
    await started.promise;
    const active = f.service.getState();
    const edited = await f.service.editPrompt(active.roundId, '生成时修改的用户消息', '生成中的用户消息');
    assert.equal(edited.prompt, '生成时修改的用户消息');
    assert.equal(edited.results[0].text, '已经收到的片段');
    assert.equal(edited.results[0].status, 'generating');
    assert.deepEqual(f.service.getState(), active, '保存用户消息不停止或重发正在生成的回复');
    assert.equal(f.sent.length, 2);
    assert.equal(f.prepared.at(-1).prompt, '生成中的用户消息');
    await f.service.editPrompt(first.roundId, '修正旧消息', '已结束的用户消息');
    assert.equal((await f.service.getRound(first.roundId)).prompt, '修正旧消息');
    finish.resolve('本次的完整回复'); await task;
    const saved = await f.restart().getRound(active.roundId);
    assert.equal(saved.prompt, '生成时修改的用户消息');
    assert.equal(saved.results[0].text, '本次的完整回复');
    f.control.response = async () => '下一次回复';
    await f.service.generateAnother(active.roundId);
    assert.equal(f.prepared.at(-1).prompt, '生成时修改的用户消息');
    f.control.enabled = false;
    await assert.rejects(f.service.editPrompt(first.roundId, '停用后不修改', '修正旧消息'), error => error.code === 'disabled');
});

test('修改用户消息后重试保存回复，不恢复旧提示词也不丢失尚未保存的回复', async () => {
    const f = fixture();
    f.control.response = async () => { f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('磁盘错误'); }; return '尚未保存的回复'; };
    await assert.rejects(f.service.send({ prompt: '原提示词' }), /磁盘错误/);
    const job = f.service.getState(); f.io.beforeWrite = null;
    const edited = await f.service.editPrompt(job.roundId, '修改后的提示词', '原提示词');
    assert.equal(edited.results[0].text, job.text, '保存后的返回值也保留尚未保存的完整回复');
    assert.equal(edited.results[0].status, 'save-failed');
    assert.deepEqual(edited.results[0].error, job.error, '原始保存错误不被通用提示替换');
    assert.equal(f.service.getState().phase, 'save-failed');
    await f.service.retrySave();
    const saved = await f.restart().getRound(job.roundId);
    assert.equal(saved.prompt, '修改后的提示词');
    assert.equal(saved.results[0].text, '尚未保存的回复');
    assert.equal(f.sent.length, 1);
});

test('其他角色历史可以编辑原文，编辑不再次请求模型', async () => {
    const f = fixture(), first = await f.service.send({ prompt: '角色甲的小剧场' });
    f.current.character = { ...characterB }; f.current.chatId = 'B-main';
    const edited = await f.service.editResult(first.roundId, first.result.id, '手动修正正文', first.result.text);
    assert.equal(edited.characterId, first.characterId);
    assert.equal(edited.results[0].text, '手动修正正文'); assert.equal(f.sent.length, 1);
});

test('编辑尚未保存的终稿先完成保存，后续重试不能覆盖用户的修改', async () => {
    const f = fixture();
    f.control.response = async () => { f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('磁盘错误'); }; return '保存失败的原文'; };
    await assert.rejects(f.service.send({ prompt: '测试' }), /磁盘错误/);
    const job = f.service.getState(); f.io.beforeWrite = null;
    await f.service.editResult(job.roundId, job.resultId, '用户修正的正文', job.text);
    assert.equal(f.service.getState().phase, 'idle'); assert.equal(await f.service.retrySave(), null);
    assert.equal((await f.service.getRound(job.roundId)).results[0].text, '用户修正的正文');
    assert.equal(f.sent.length, 1);
});

function fixture(overrides = {}) {
    const f = memoryFiles();
    let tick = 0;
    const current = { character: { ...characterA }, chatId: contextA.chatId, context: { ...contextA },
        chat: [{ is_user: false, mes: '主聊天内容', variables: [{ stat_data: { 好感度: 20 } }] }],
        api: { mode: 'tavern', key: 'secret-key' } };
    const prepared = [], sent = [];
    const control = { enabled: true,
        prepare: async request => ({ context: { model: 'test-model' }, send: async options => {
            sent.push({ request, options }); return control.response(options);
        } }),
        response: async () => '固定的测试回复',
    };
    const options = { history: f.store, uuid: randomUUID, now: () => time(tick++), checkpointMs: 0,
        captureEnvironment: () => current,
        isCurrent: environment => current.character.avatar === environment.character.avatar && current.chatId === environment.chatId,
        enabled: () => control.enabled,
        prepareRequest: async request => { prepared.push(request); return control.prepare(request); },
        ...overrides,
    };
    const service = createPlayground(options);
    return { ...f, service, current, control, prepared, sent, restart: () => createPlayground({ ...options, history: f.createStore() }) };
}

test('删除消息不请求模型或改主聊天；全部回复删除后可重新生成，用户消息删除后不可生成', async () => {
    const f = fixture(), chat = structuredClone(f.current.chat);
    const first = await f.service.send({ prompt: '待删除的消息' });
    await f.service.generateAnother(first.roundId);
    const round = await f.service.getRound(first.roundId);
    f.current.character = { ...characterB }; f.current.chatId = 'B-main';
    const removed = await f.service.removeReply(first.roundId, round.results);
    assert.deepEqual(removed.results, []);
    assert.equal(f.sent.length, 2);
    f.current.character = { ...characterA }; f.current.chatId = contextA.chatId;
    await f.service.generateAnother(first.roundId);
    assert.equal(f.prepared.at(-1).prompt, '待删除的消息');
    await f.service.removePrompt(first.roundId, round.prompt);
    await assert.rejects(f.service.generateAnother(first.roundId), error => error.code === 'prompt_missing');
    assert.equal(f.sent.length, 3);
    assert.deepEqual(f.current.chat, chat);
    f.control.enabled = false;
    await assert.rejects(f.service.removeReply(first.roundId, removed.results), error => error.code === 'disabled');
});

test('本页生成中及尚未保存时禁止删除；旧消息仍然可以删除', async () => {
    const f = fixture(), old = await f.service.send({ prompt: '旧消息' });
    const started = deferred(), finish = deferred();
    f.control.response = async () => { started.resolve(); return finish.promise; };
    const task = f.service.send({ prompt: '正在生成' }); await started.promise;
    const job = f.service.getState(), current = await f.service.getRound(job.roundId);
    await assert.rejects(f.service.removePrompt(job.roundId, current.prompt), error => error.code === 'busy');
    await assert.rejects(f.service.removeReply(job.roundId, current.results), error => error.code === 'busy');
    await f.service.removeReply(old.roundId, [old.result]);
    f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟保存失败'); };
    finish.resolve('完整回复'); await assert.rejects(task, /模拟保存失败/);
    await assert.rejects(f.service.removeReply(job.roundId, current.results), error => error.code === 'busy');
    f.io.beforeWrite = null; await f.service.retrySave();
    await f.service.removeReply(job.roundId, (await f.service.getRound(job.roundId)).results);
    assert.equal(f.service.getState().phase, 'idle');
});

test('其他窗口删除正在生成的消息后，迟到回复不重建消息或阻塞后续发送', async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    f.control.response = async () => { started.resolve(); return finish.promise; };
    const task = f.service.send({ prompt: '另一窗口将删除' }); await started.promise;
    const job = f.service.getState(), saved = await f.store.getRound(job.roundId);
    await f.createStore().removeReply(saved.id, saved.results);
    await f.createStore().removePrompt(saved.id, saved.prompt);
    finish.resolve('迟到的正文');
    assert.equal(await task, null);
    assert.equal(f.service.getState().phase, 'idle');
    assert.equal(f.service.availability().available, true);
    assert.deepEqual(await f.store.listRounds(saved.characterId), []);
    f.control.response = async () => '新回复';
    assert.equal((await f.service.send({ prompt: '新消息' })).result.text, '新回复');
});

test('插件日志记录请求阶段和完整错误，不附带提示词、回复或配置', async () => {
    const storage = { getItem: () => null, setItem() {} }, diagnostics = createDiagnostics({ storage });
    const f = fixture({ diagnostics });
    f.control.response = async ({ onText }) => {
        onText('不应进入诊断的回复');
        const error = new Error('socket hang up', { cause: new Error('连接重置') });
        error.request = { key: 'secret-key', messages: ['不应进入诊断的提示词'] }; throw error;
    };
    await f.service.send({ prompt: '不应进入诊断的提示词' });
    const log = diagnostics.read().entries.find(entry => entry.level === 'error');
    assert.equal(log.message, '失败'); assert.equal(log.phase, 'generating');
    assert.ok(log.requestStartedAt); assert.ok(log.firstContentAt); assert.ok(log.lastContentAt);
    assert.equal(log.error.message, 'socket hang up'); assert.equal(log.error.cause.message, '连接重置');
    assert.doesNotMatch(diagnostics.export(), /secret-key|不应进入诊断的回复|不应进入诊断的提示词/);
});

test('读取和保存演出记录失败留下完整日志，并继续把原错误交给界面处理', async () => {
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    const f = fixture({ diagnostics });
    const first = await f.service.send({ prompt: '不会写进日志的提示词' });
    diagnostics.clear();
    const error = new Error('HTTP 507: history unavailable', { cause: new Error('disk full') });
    f.io.beforeRead = () => { throw error; };
    await assert.rejects(f.service.getRound(first.roundId), candidate => candidate === error);
    f.io.beforeRead = null;
    f.io.beforeWrite = () => { throw error; };
    await assert.rejects(f.service.editResult(first.roundId, first.result.id, '不会写进日志的编辑原文', first.result.text), candidate => candidate === error);
    const entries = diagnostics.read().entries;
    assert.deepEqual(entries.map(entry => entry.operation), ['读取演出记录', '保存回复修改']);
    assert.ok(entries.every(entry => entry.error.cause.message === 'disk full'));
    assert.doesNotMatch(diagnostics.export(), /不会写进日志/);
});

test('重新生成只替换选中的结果，保持位置、总数和本轮提示词', async () => {
    const f = fixture(), first = await f.service.send({ prompt: '第一轮提示词', origin: { id: 'rain', title: '雨夜重逢' } });
    f.control.response = async () => '第二份';
    const second = await f.service.generateAnother(first.roundId);
    f.control.response = async () => '第三份';
    const third = await f.service.generateAnother(first.roundId);
    f.control.response = async () => '替换第二份';
    const replacement = await f.service.regenerate(first.roundId, second.result.id);
    const round = await f.restart().getRound(first.roundId);
    assert.deepEqual(round.results.map(result => result.text), ['固定的测试回复', '替换第二份', '第三份']);
    assert.deepEqual(round.results.map(result => result.id), [first.result.id, replacement.result.id, third.result.id]);
    assert.equal(round.prompt, '第一轮提示词'); assert.equal(round.origin.title, '雨夜重逢');
    assert.equal(f.prepared.at(-1).prompt, '第一轮提示词');
    await assert.rejects(f.service.regenerate(first.roundId, second.result.id), /其他窗口替换/);
    assert.equal(f.sent.length, 4, '过期结果不再发起请求');
});

test('重新生成失败或停止也替换原结果；没有正文时保留这次的失败状态', async () => {
    for (const mode of ['failed-partial', 'failed-empty', 'stopped']) {
        const f = fixture(), first = await f.service.send({ prompt: '测试替换' });
        const started = deferred();
        f.control.response = async ({ onText }) => {
            if (mode !== 'failed-empty') onText('这次的片段');
            started.resolve();
            if (mode === 'stopped') return new Promise(() => {});
            throw Error('这次的接口错误');
        };
        const task = f.service.regenerate(first.roundId, first.result.id);
        await started.promise;
        if (mode === 'stopped') f.service.stop();
        const latest = await task;
        const round = await f.restart().getRound(first.roundId);
        assert.equal(round.results.length, 1);
        assert.notEqual(round.results[0].id, first.result.id);
        assert.equal(round.results[0].id, latest.result.id);
        assert.equal(round.results[0].text, mode === 'failed-empty' ? '' : '这次的片段');
        assert.equal(round.results[0].status, mode === 'stopped' ? 'stopped' : 'failed');
    }
});

test('重新生成保存失败后可以重试保存，不重复请求或增加结果数量', async () => {
    const f = fixture(), first = await f.service.send({ prompt: '保存替换结果' });
    f.control.response = async () => {
        f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw Error('模拟保存失败'); };
        return '替换后尚未保存的内容';
    };
    await assert.rejects(f.service.regenerate(first.roundId, first.result.id), /模拟保存失败/);
    assert.equal(f.service.getState().phase, 'save-failed');
    assert.equal((await f.service.getRound(first.roundId)).results.length, 1);
    f.io.beforeWrite = null;
    await f.service.retrySave();
    const round = await f.restart().getRound(first.roundId);
    assert.equal(round.results.length, 1); assert.equal(round.results[0].text, '替换后尚未保存的内容');
    assert.equal(f.sent.length, 2);
});

test('新发与追加结果只提交本轮文字和当前主聊天，不累加插件旧输入或回复', async () => {
    const f = fixture();
    const first = await f.service.send({ prompt: '第一篇提示词', origin: { id: 'rain', title: '雨夜重逢' } });
    await f.service.send({ prompt: '第二篇提示词' });
    f.current.context.presetName = '修改后的当前预设';
    const again = await f.service.generateAnother(first.roundId);
    assert.equal(again.roundId, first.roundId);
    assert.deepEqual(f.prepared.map(request => request.prompt), ['第一篇提示词', '第二篇提示词', '第一篇提示词']);
    for (const request of f.prepared) assert.deepEqual(request.environment.chat.map(message => message.mes), ['主聊天内容']);
    assert.equal(f.prepared[2].environment.context.presetName, '修改后的当前预设');
    assert.equal((await f.service.getRound(first.roundId)).results.length, 2);
});

test('发送当刻复制设置；生成中切主聊天，结果仍属于原角色，变量原值不变', async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    f.control.response = async ({ onText }) => { started.resolve(); onText('已收到'); await finish.promise; return '原角色的完整回复'; };
    const originalChat = structuredClone(f.current.chat);
    const task = f.service.send({ prompt: '第一篇提示词' });
    await started.promise;
    f.current.character = { ...characterB };
    f.current.chatId = 'B-main';
    f.current.context.apiMode = 'custom';
    f.current.api.key = 'changed-key';
    assert.equal(f.prepared[0].environment.api.key, 'secret-key');
    finish.resolve();
    const result = await task;
    assert.equal(result.result.context.chatId, 'A-main');
    assert.equal(result.result.context.apiMode, 'tavern');
    assert.equal((await f.service.listCharacters())[0].name, '角色A');
    assert.deepEqual(f.current.chat, originalChat);
    assert.equal(result.result.text, '原角色的完整回复');
});

test('准备提示词期间切聊天，会停止发送；处理未成功也不会调用模型', async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    let sends = 0;
    f.control.prepare = async () => { started.resolve(); await finish.promise; return { send: async () => { sends++; return '不应发送'; } }; };
    const task = f.service.send({ prompt: '测试' });
    await started.promise;
    f.current.chatId = '另一个主聊天';
    finish.resolve();
    const result = await task;
    assert.equal(result.result.status, 'failed');
    assert.equal(result.result.error.code, 'chat_changed');
    assert.equal(sends, 0);
    const preparationError = 'EJS ReferenceError: scene is not defined\n    at prompt-template.ejs:18';
    f.control.prepare = async () => { throw new Error(preparationError); };
    const failed = await f.service.send({ prompt: '再次测试' });
    assert.equal(failed.result.error.code, 'prompt_preparation_failed');
    assert.equal(failed.result.error.message, preparationError);
    assert.equal((await f.restart().getRound(failed.roundId)).results[0].error.message, preparationError);
});

test('其他角色只能阅读；重复点击不会生成第二份请求', async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    f.control.response = async () => { started.resolve(); await finish.promise; return '回复'; };
    const task = f.service.send({ prompt: '测试' });
    await started.promise;
    await assert.rejects(f.service.send({ prompt: '重复点击' }), error => error.code === 'busy');
    finish.resolve();
    const first = await task;
    f.current.character = { ...characterB };
    assert.equal((await f.service.getRound(first.roundId)).prompt, '测试');
    await assert.rejects(f.service.regenerate(first.roundId, first.result.id), /只能查看历史/);
    assert.equal(f.sent.length, 1);
    assert.equal(f.service.getState().phase, 'idle');
});

test('停止只取消本次请求，保留片段；忽略不配合停止的接口的迟到回复', async () => {
    const f = fixture(), started = deferred(), late = deferred();
    let callback;
    f.control.response = async ({ onText, signal }) => {
        callback = onText; onText('已经收到的片段'); started.resolve(signal); return late.promise;
    };
    const task = f.service.send({ prompt: '测试' });
    const signal = await started.promise;
    assert.equal(f.service.stop(), true);
    const stopped = await task;
    assert.equal(signal.aborted, true);
    assert.equal(stopped.result.status, 'stopped');
    assert.equal(stopped.result.text, '已经收到的片段');
    f.control.response = async () => '下一篇的回复';
    const next = await f.service.send({ prompt: '另一篇' });
    callback('迟到文字'); late.resolve('迟到最终结果');
    await Promise.resolve();
    assert.equal((await f.service.getRound(stopped.roundId)).results[0].text, '已经收到的片段');
    assert.equal(next.result.text, '下一篇的回复');
});

test('追加结果失败保留此前成功版本、已收正文和原始错误，不保存错误对象中的请求配置', async () => {
    const f = fixture();
    const first = await f.service.send({ prompt: '第一篇' });
    const message = 'HTTP 429\nRESOURCE_EXHAUSTED: Quota exceeded. Retry after 30 seconds.';
    f.control.response = async ({ onText }) => {
        onText('失败前的片段');
        throw Object.assign(new Error(message), { request: { headers: { Authorization: 'secret-key' }, body: '主聊天内容' } });
    };
    const failure = await f.service.generateAnother(first.roundId);
    assert.equal(failure.result.status, 'failed');
    const round = await f.restart().getRound(first.roundId);
    assert.deepEqual(round.results.map(result => result.status), ['complete', 'failed']);
    assert.equal(round.results[0].text, '固定的测试回复');
    assert.equal(round.results[1].text, '失败前的片段');
    assert.equal(round.results[1].error.message, message);
    assert.equal([...f.files.values()].join('').includes('secret-key'), false);
});

test('未收到正文时也保存接口原始错误，支持直接抛出的文字', async () => {
    const f = fixture();
    const message = 'HTTP 404: Requested entity was not found.';
    f.control.response = async () => { throw message; };
    const failed = await f.service.send({ prompt: '检查不可用模型' });
    const result = (await f.restart().getRound(failed.roundId)).results[0];
    assert.equal(result.status, 'failed');
    assert.equal(result.text, '');
    assert.equal(result.error.message, message);
});

test('提示词保存失败不请求模型；回复保存失败可独立重试，不再花一次生成', async () => {
    const f = fixture();
    f.io.beforeWrite = () => { throw new Error('disk full'); };
    await assert.rejects(f.service.send({ prompt: '先保存输入' }));
    assert.equal(f.sent.length, 0);
    assert.equal(f.service.getState().phase, 'idle');
    f.io.beforeWrite = null;
    f.control.response = async () => {
        f.io.beforeWrite = name => { if (name === PLAY_HISTORY_INDEX) throw new Error('disk full'); };
        return '需要保留的完整回复';
    };
    await assert.rejects(f.service.send({ prompt: '第二次尝试' }), error => error.code === 'history_save_failed');
    assert.equal(f.service.getState().phase, 'save-failed');
    assert.equal(f.service.getState().text, '需要保留的完整回复');
    assert.equal(f.service.getState().error.message, 'disk full');
    await assert.rejects(f.service.send({ prompt: '不能丢掉未保存回复' }), error => error.code === 'unsaved_result');
    await assert.rejects(f.service.retrySave(), /disk full/);
    assert.equal(f.service.getState().text, '需要保留的完整回复');
    f.io.beforeWrite = null;
    const saved = await f.service.retrySave();
    assert.equal(saved.results[0].text, '需要保留的完整回复');
    assert.equal(f.sent.length, 1);
    assert.equal(f.service.getState().phase, 'idle');
});

test('流式片段定期保存，重开能看见已保存片段，但不冒充已完成或本页正在生成', async () => {
    const f = fixture({ checkpointMs: 5 }), started = deferred(), finish = deferred();
    f.control.response = async ({ onText }) => { onText('可恢复片段'); started.resolve(); await finish.promise; return '最终正文'; };
    const task = f.service.send({ prompt: '测试恢复' });
    await started.promise;
    await delay(25);
    const id = f.service.getState().roundId;
    const reopened = await f.restart().getRound(id);
    assert.equal(reopened.results[0].status, 'unfinished');
    assert.equal(reopened.results[0].text, '可恢复片段');
    assert.equal((await f.service.getRound(id)).results[0].status, 'generating');
    finish.resolve(); await task;
    assert.equal((await f.restart().getRound(id)).results[0].text, '最终正文');
});

test('无已验证的提示词处理器、插件停用、空输入均不伪造生成或写空历史', async () => {
    const unavailable = fixture({ prepareRequest: undefined });
    await assert.rejects(unavailable.service.send({ prompt: '测试' }), error => error.code === 'generation_unavailable');
    assert.equal(unavailable.files.size, 0);
    const f = fixture();
    f.control.enabled = false;
    await assert.rejects(f.service.send({ prompt: '停用中' }), /停用/);
    f.control.enabled = true;
    await assert.rejects(f.service.send({ prompt: ' \n ' }), /输入/);
    assert.equal(f.files.size, 0);
});

test('保存缓慢时合并流式片段，最终结果不会等待一长串过时快照', async () => {
    const f = fixture({ checkpointMs: 1 });
    const started = deferred(), saving = deferred(), releaseSave = deferred(), finish = deferred();
    let delayed = false;
    f.control.response = async ({ onText }) => {
        f.io.beforeWrite = async name => {
            if (name !== PLAY_HISTORY_INDEX && !delayed) {
                delayed = true; saving.resolve(); await releaseSave.promise;
            }
        };
        onText('片段一'); started.resolve(onText);
        await finish.promise;
        return '完整的最终正文';
    };
    const task = f.service.send({ prompt: '测试慢保存' });
    const onText = await started.promise;
    await saving.promise;
    const before = f.writes.length;
    for (let i = 0; i < 4; i++) { onText(`收到更多文字${i}`); await delay(3); }
    finish.resolve();
    await nextTurn();
    assert.equal(f.service.getState().phase, 'saving');
    assert.equal(f.service.getState().text, '完整的最终正文');
    releaseSave.resolve();
    const result = await task;
    assert.equal(f.writes.length - before, 4, '只保存进行中的一次片段，以及最终正文；每次各写正文和目录');
    assert.equal(result.result.text, '完整的最终正文');
});

test('准备阶段停止，迟到的准备结果不会继续发送，也不影响下一次生成', async () => {
    const f = fixture(), started = deferred(), late = deferred();
    let sent = 0;
    f.control.prepare = async () => { started.resolve(); await late.promise; return { send: async () => { sent++; return '不应出现'; } }; };
    const task = f.service.send({ prompt: '准备阶段停止' });
    await started.promise;
    f.service.stop();
    const stopped = await task;
    assert.equal(stopped.result.status, 'stopped');
    late.resolve(); await nextTurn();
    assert.equal(sent, 0);
    assert.equal(f.service.getState().phase, 'idle');
});

test('等待另一窗口保存时可以停止，释放队列后也不会偷偷新建记录', { timeout: 2000 }, async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    const holder = f.io.withLock(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const pending = f.service.send({ prompt: '这次等待应当取消' });
    await nextTurn();
    assert.equal(f.service.getState().phase, 'preparing');
    assert.equal(f.service.stop(), true);
    assert.equal(await pending, null, '无需等另一窗口保存结束');
    assert.equal(f.service.getState().phase, 'idle');
    assert.equal(f.writes.length, 0); assert.equal(f.sent.length, 0);
    release.resolve(); await holder;
    const next = await f.service.send({ prompt: '停止后的正常发送' });
    assert.equal(f.directory().rounds.length, 1);
    assert.equal((await f.store.getRound(next.roundId)).prompt, '停止后的正常发送');
    assert.equal(f.sent.length, 1);
});

test('开始写文件后再停止，会完成这次保存并记录停止，不留下缺少正文的目录', { timeout: 2000 }, async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.io.beforeWrite = async () => { entered.resolve(); await release.promise; };
    const pending = f.service.send({ prompt: '保存已开始' });
    await entered.promise;
    assert.equal(f.service.stop(), true);
    release.resolve();
    const result = await pending;
    assert.equal(result.result.status, 'stopped'); assert.equal(f.sent.length, 0);
    const saved = await f.store.getRound(result.roundId);
    assert.equal(saved.results[0].status, 'stopped');
    assert.equal(f.service.getState().phase, 'idle');
});

test('续写在原有结果上原地更新，不增加新结果，流式增量无缝追加', async () => {
    const f = fixture();
    f.control.response = async () => '初始剧场正文';
    const first = await f.service.send({ prompt: '用户提示词' });
    assert.equal(first.result.text, '初始剧场正文');
    assert.equal((await f.service.getRound(first.roundId)).results.length, 1);

    f.control.prepare = async request => {
        const prefix = request.continueMessage || '';
        return {
            context: { model: 'test-model' },
            send: async ({ onText }) => {
                onText(prefix + '，续写的精彩段落');
                return prefix + '，续写的精彩段落';
            },
        };
    };

    const continued = await f.service.continueResult(first.roundId, first.result.id);
    assert.equal(continued.roundId, first.roundId);
    assert.equal(continued.result.id, first.result.id, '保持原有结果编号');
    assert.equal(continued.result.text, '初始剧场正文，续写的精彩段落');
    assert.equal(continued.result.status, 'complete');
    assert.equal(f.prepared.at(-1).continueMessage, '初始剧场正文');

    const savedRound = await f.service.getRound(first.roundId);
    assert.equal(savedRound.results.length, 1, '不生成新分支');
    assert.equal(savedRound.results[0].text, '初始剧场正文，续写的精彩段落');
});

test('续写中途停止保留已收到增量并标记 stopped', async () => {
    const f = fixture();
    f.control.response = async () => '初始正文';
    const first = await f.service.send({ prompt: '提示词' });
    const started = deferred();
    f.control.prepare = async request => {
        const prefix = request.continueMessage || '';
        return {
            context: { model: 'test-model' },
            send: async ({ onText, signal }) => {
                onText(prefix + '，已收到的半截片段');
                started.resolve();
                return new Promise((_, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            },
        };
    };
    const task = f.service.continueResult(first.roundId, first.result.id);
    await started.promise;
    assert.equal(f.service.getState().text, '初始正文，已收到的半截片段');
    assert.equal(f.service.stop(), true);
    await task;
    const saved = await f.service.getRound(first.roundId);
    assert.equal(saved.results.length, 1);
    assert.equal(saved.results[0].text, '初始正文，已收到的半截片段');
    assert.equal(saved.results[0].status, 'stopped');
});

test('续写返回空增量时报错 empty_response 并保留原正文', async () => {
    const f = fixture();
    f.control.response = async () => '完整前文';
    const first = await f.service.send({ prompt: '提示词' });
    f.control.prepare = async request => {
        const prefix = request.continueMessage || '';
        return {
            context: { model: 'test-model' },
            send: async () => prefix, // delta 为空
        };
    };
    const outcome = await f.service.continueResult(first.roundId, first.result.id);
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.result.error.code, 'empty_response');
    const saved = await f.service.getRound(first.roundId);
    assert.equal(saved.results[0].text, '完整前文');
});

test('生成、追加结果、重新生成和续写在准备阶段均先通知 roundId=null，落库后才通知 roundId', async () => {
    const f = fixture();
    const roundIdTransitions = [];
    f.service.subscribe(job => {
        roundIdTransitions.push({ phase: job.phase, roundId: job.roundId });
    });
    // 1. send
    const first = await f.service.send({ prompt: '第一条' });
    // 2. generateAnother
    const second = await f.service.generateAnother(first.roundId);
    // 3. regenerate
    const replaced = await f.service.regenerate(first.roundId, second.result.id);
    // 4. continueResult
    await f.service.continueResult(first.roundId, replaced.result.id);

    // 每次操作开始时处于 preparing 且 roundId 必须为 null，等 history.begin 落库后才转为真实的 roundId
    const preparingEvents = roundIdTransitions.filter(e => e.phase === 'preparing');
    // 每个操作都有 2 个 preparing 事件：第一个 roundId 为 null，第二个 roundId 为有效 ID
    assert.equal(preparingEvents.length, 8);
    for (let i = 0; i < 4; i++) {
        assert.equal(preparingEvents[i * 2].roundId, null, `第 ${i + 1} 个操作在落库前 roundId 必须为 null`);
        assert.equal(preparingEvents[i * 2 + 1].roundId, first.roundId, `第 ${i + 1} 个操作在落库后 roundId 必须为真实 ID`);
    }
});

test('续写读取前文期间立即阻止重复请求，停止后不发送也不改变原结果', async () => {
    const f = fixture(), first = await f.service.send({ prompt: '提示词' });
    const before = await f.store.getRound(first.roundId), entered = deferred(), gate = deferred();
    f.io.beforeRead = async () => { entered.resolve(); await gate.promise; };
    const task = f.service.continueResult(first.roundId, first.result.id);
    await entered.promise;
    assert.equal(f.service.getState().phase, 'preparing');
    assert.equal(f.service.availability().available, false);
    await assert.rejects(f.service.continueResult(first.roundId, first.result.id), error => error.code === 'busy');
    await assert.rejects(f.service.send({ prompt: '重复发送' }), error => error.code === 'busy');
    assert.equal(f.service.stop(), true);
    assert.equal(await task, null);
    f.io.beforeRead = null; gate.resolve(); await nextTurn();
    assert.equal(f.sent.length, 1, '只有最初的生成请求');
    assert.deepEqual(await f.store.getRound(first.roundId), before);
    assert.equal(f.service.getState().phase, 'idle');
});

test('续写等待读取时切换聊天或另一窗口编辑，均不会发送过期前文', async () => {
    for (const change of ['chat', 'text']) {
        const f = fixture(), first = await f.service.send({ prompt: '提示词' });
        if (change === 'chat') {
            const read = f.store.getRound.bind(f.store);
            f.store.getRound = async id => {
                const round = await read(id);
                f.current.chatId = 'changed-main-chat'; return round;
            };
            await assert.rejects(f.service.continueResult(first.roundId, first.result.id), error => error.code === 'chat_changed');
        } else {
            const begin = f.store.begin.bind(f.store);
            f.store.begin = async (input, options) => {
                await f.store.editResult(first.roundId, first.result.id, '另一窗口的新正文', first.result.text);
                return begin(input, options);
            };
            await assert.rejects(f.service.continueResult(first.roundId, first.result.id), error => error.code === 'edit_conflict');
            assert.equal((await f.store.getRound(first.roundId)).results[0].text, '另一窗口的新正文');
        }
        assert.equal(f.sent.length, 1);
        assert.equal(f.service.getState().phase, 'idle');
    }
});
