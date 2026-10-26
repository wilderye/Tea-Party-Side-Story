import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserPlayHistory, createPlayFiles } from '../play-storage.js';
import { memoryFiles, time } from './play-fixture.js';
import { randomUUID } from 'node:crypto';
import { createDiagnostics, serializeDiagnosticError } from '../diagnostics.js';

const context = () => ({ uuidv4: randomUUID, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) });
function browser(t, SharedWorker, indexedDB) {
    for (const [name, value] of Object.entries({ navigator: {}, SharedWorker, indexedDB })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, value });
        t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
    }
}

test('读取五类历史信息不启动后台保存任务，也不依赖浏览器本地存储', async t => {
    const f = memoryFiles(), round = await f.begin(), resultId = round.results[0].id;
    await f.store.saveResult(round.id, resultId, { text: '已保存正文', status: 'complete', finishedAt: time(1) });
    const favorite = await f.store.addFavorite({ roundId: round.id, resultId, startedAt: round.results[0].startedAt,
        expectedText: '已保存正文', firstLine: '已保存正文' });
    let workerStarts = 0, databaseOpens = 0;
    browser(t, class { constructor() { workerStarts++; throw Error('unsupported'); } },
        { open() { databaseOpens++; throw Error('storage denied'); } });
    t.mock.method(globalThis, 'fetch', async url => {
        const text = f.files.get(url.slice('/user/files/'.length));
        return new Response(text ?? '', { status: text === undefined ? 404 : 200 });
    });
    const history = createBrowserPlayHistory(context);
    assert.equal((await history.listCharacters()).length, 1);
    assert.equal((await history.listRounds(round.characterId)).length, 1);
    assert.equal((await history.getRound(round.id)).results[0].text, '已保存正文');
    assert.equal((await history.listFavorites()).length, 1);
    assert.equal((await history.getFavorite(favorite.id)).text, '已保存正文');
    assert.equal(workerStarts, 0); assert.equal(databaseOpens, 0);
});

test('浏览器禁止本地存储时只阻止写入，不覆盖记录，也不要求改为 HTTPS', async t => {
    const f = memoryFiles(), round = await f.begin(), resultId = round.results[0].id;
    await f.store.saveResult(round.id, resultId, { text: '原文', status: 'complete', finishedAt: time(1) });
    browser(t, undefined, { open() { throw Error('storage denied'); } });
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (options?.method === 'POST') posts++;
        return new Response(f.files.get(url.slice('/user/files/'.length)) ?? '');
    });
    const history = createBrowserPlayHistory(context);
    await assert.rejects(history.editResult(round.id, resultId, '草稿', '原文'), error =>
        error.code === 'history_storage_unavailable' && !error.message.includes('HTTPS'));
    assert.equal(posts, 0);
    assert.equal((await history.getRound(round.id)).results[0].text, '原文');
});

test('保存资格失效后不发送上传或删除请求，读取已有文件仍正常', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return new Response('已有正文'); });
    const files = createPlayFiles(() => ({}), async () => { throw Error('保存已中断'); });
    await assert.rejects(files.writeFile('test.json', '不应写入'), /保存已中断/);
    await assert.rejects(files.removeFile('test.json'), /保存已中断/);
    assert.equal(requests.length, 0);
    assert.equal(await files.readFile('test.json'), '已有正文');
    assert.equal(requests.length, 1);
});

test('后台任务接收保存后断开，不自动换通道重复提交这次操作', async t => {
    let sent = 0, localAttempts = 0;
    const original = new Error('worker original failure', { cause: new Error('connection reset') });
    browser(t, class {
        constructor() {
            this.port = { close() {}, postMessage: () => {
                sent++;
                queueMicrotask(() => this.onerror({ preventDefault() {}, error: original }));
            } };
            queueMicrotask(() => this.port.onmessage({ data: { ready: true } }));
        }
    }, { open() { localAttempts++; throw Error('must not retry here'); } });
    const history = createBrowserPlayHistory(context);
    await assert.rejects(history.renameCharacter('A.png', 'B.png', '改名'), error =>
        error.code === 'history_worker_unavailable' && error.cause === original);
    assert.equal(sent, 1); assert.equal(localAttempts, 0);
});

test('等待后台连接时取消，迟到的初始化完成不会补发已停止的任务', async t => {
    let worker, sent = 0;
    browser(t, class {
        constructor() { worker = this; this.port = { close() {}, postMessage() { sent++; } }; }
    });
    const history = createBrowserPlayHistory(context), controller = new AbortController();
    const pending = history.begin({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    worker.port.onmessage({ data: { ready: true } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(sent, 0);
});

test('手动收藏通过后台保存通道传递角色和正文', async t => {
    const messages = [];
    browser(t, class {
        constructor() {
            this.port = { close() {}, postMessage: data => {
                messages.push(data);
                queueMicrotask(() => this.port.onmessage({ data: { id: data.id, value: { id: 'saved-manual' } } }));
            } };
            queueMicrotask(() => this.port.onmessage({ data: { ready: true } }));
        }
    });
    const input = { character: { avatar: 'A.png', name: '角色A' }, title: '', text: '手动正文', firstLine: '手动正文' };
    assert.deepEqual(await createBrowserPlayHistory(context).addManualFavorite(input), { id: 'saved-manual' });
    assert.equal(messages[0].method, 'addManualFavorite'); assert.deepEqual(messages[0].args, [input]);
});

test('取消通过编号通知后台，尚未收到后台确认前不丢弃可能已保存的记录', async t => {
    let worker;
    const messages = [];
    browser(t, class {
        constructor() {
            worker = this; this.port = { close() {}, postMessage: data => messages.push(data) };
            queueMicrotask(() => this.port.onmessage({ data: { ready: true } }));
        }
    });
    const history = createBrowserPlayHistory(context), controller = new AbortController();
    let settled = false;
    const pending = history.begin({ prompt: '测试' }, { signal: controller.signal }).then(value => { settled = true; return value; });
    for (let i = 0; i < 10 && !messages.length; i++) await Promise.resolve();
    assert.equal(messages[0].method, 'begin');
    assert.deepEqual(messages[0].args, [{ prompt: '测试' }]);
    controller.abort(); await Promise.resolve();
    assert.deepEqual(messages[1], { id: messages[0].id, cancel: true });
    assert.equal(settled, false);
    worker.port.onmessage({ data: { id: messages[0].id, value: { id: 'already-saved' } } });
    assert.deepEqual(await pending, { id: 'already-saved' });
});

test('后台保存错误完整传回调用页面，保留原堆栈、原因和网络错误字段', async t => {
    const original = new Error('upload failed', { cause: new Error('connection reset') });
    original.status = 507; original.errno = -1;
    original.request = { messages: ['private prompt'], key: 'private-key' };
    const detail = serializeDiagnosticError(original);
    browser(t, class {
        constructor() {
            this.port = { close() {}, postMessage: ({ id }) => queueMicrotask(() => this.port.onmessage({ data: { id, error: detail } })) };
            queueMicrotask(() => this.port.onmessage({ data: { ready: true } }));
        }
    });
    const history = createBrowserPlayHistory(context);
    await assert.rejects(history.renameCharacter('A.png', 'B.png', '改名'), error => {
        assert.equal(error.message, original.message); assert.equal(error.stack, original.stack);
        assert.equal(error.status, 507); assert.equal(error.errno, -1);
        assert.equal(error.cause.message, 'connection reset'); assert.equal(error.request, undefined);
        return true;
    });
});

test('后台清理失败仍记录完整警告，不把已成功的保存改成失败', async t => {
    const diagnostics = createDiagnostics({ storage: { getItem: () => null, setItem() {} } });
    browser(t, class {
        constructor() {
            this.port = { close() {}, postMessage: ({ id }) => queueMicrotask(() => {
                this.port.onmessage({ data: { warning: { operation: '清理旧文件', error: serializeDiagnosticError(new Error('unlink failed')) } } });
                this.port.onmessage({ data: { id, value: 'saved' } });
            }) };
            queueMicrotask(() => this.port.onmessage({ data: { ready: true } }));
        }
    });
    assert.equal(await createBrowserPlayHistory(context, diagnostics).renameCharacter('A.png', 'B.png', '改名'), 'saved');
    assert.match(diagnostics.export(), /unlink failed/);
    assert.equal(diagnostics.read().entries[0].level, 'warn');
});
