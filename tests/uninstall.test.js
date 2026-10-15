import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const entrySetName = '茶话会小剧场 · 插件入口';

async function withApp(run, api) {
    const hooks = registerHooks({ load(url, context, next) {
        if (new URL(url).pathname.endsWith('/panel.js')) return {
            format: 'module', shortCircuit: true, source: `
                export function element() { return {}; }
                export function textButton() { return {}; }
                export function createTheatrePanel() {
                    return { refresh() {}, refreshStatus() {}, open() {} };
                }
            `,
        };
        return next(url, context);
    } });
    const settings = { enabled: true, qrEnabled: true, favorites: {}, libraryUrl: '' };
    const handlers = new Map();
    const warnings = [], requests = [];
    const context = {
        extensionSettings: { teahouse: settings }, chat: [],
        getRequestHeaders: () => ({}), saveSettingsDebounced() {}, registerMacro() {},
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on(name, handler) { handlers.set(name, handler); } },
        SlashCommandParser: { addCommandObject() {} }, SlashCommand: { fromProps: value => value },
    };
    const previous = Object.fromEntries(['SillyTavern', 'document', 'fetch', 'quickReplyApi', 'toastr']
        .map(key => [key, globalThis[key]]));
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.document = { querySelector: () => null };
    globalThis.quickReplyApi = api;
    globalThis.toastr = { warning: (...args) => warnings.push(args) };
    globalThis.fetch = async url => {
        requests.push(String(url));
        return new Response('', { status: 404 });
    };
    try {
        const entryUrl = new URL(`../${manifest.js}`, import.meta.url);
        entryUrl.searchParams.set('uninstall-test', randomUUID());
        const app = await import(entryUrl);
        await run({ app, settings, handlers, warnings, requests });
    } finally {
        Object.assign(globalThis, previous);
        hooks.deregister();
    }
}

test('酒馆清单指定的卸载函数等待入口创建结束，并阻止待执行的同步重新创建入口', async () => {
    let releaseCreate;
    const creating = new Promise(resolve => { releaseCreate = resolve; });
    const sets = new Map(), active = new Set();
    const calls = [];
    const api = {
        getSetByName: name => sets.get(name),
        getQrByLabel: (name, label) => sets.get(name)?.qrList.find(qr => qr.label === label),
        async createSet(name) {
            calls.push('creating');
            await creating;
            const set = { qrList: [], async save() { calls.push('saved'); } };
            sets.set(name, set);
            return set;
        },
        createQuickReply(name, label, props) {
            const qr = { label, ...props };
            sets.get(name).qrList.push(qr);
            calls.push('created');
            return qr;
        },
        addGlobalSet: name => active.add(name),
        removeGlobalSet: name => active.delete(name),
        listQuickReplies: name => sets.get(name).qrList.map(qr => qr.label),
        deleteQuickReply(name, label) {
            sets.get(name).qrList = sets.get(name).qrList.filter(qr => qr.label !== label);
        },
        async deleteSet(name) { sets.delete(name); calls.push('deleted'); },
    };
    await withApp(async ({ app, settings, handlers, warnings, requests }) => {
        assert.equal(typeof app[manifest.hooks.delete], 'function');
        assert.deepEqual(calls, ['creating']);
        const originalSettings = structuredClone(settings);
        handlers.get('app_ready')();
        const uninstalling = app[manifest.hooks.delete]();
        handlers.get('app_ready')();
        assert.equal(calls.includes('deleted'), false);
        releaseCreate();
        await uninstalling;
        assert.deepEqual(calls, ['creating', 'created', 'saved', 'deleted']);
        assert.equal(sets.has(entrySetName), false);
        assert.equal(active.has(entrySetName), false);
        handlers.get('app_ready')();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sets.has(entrySetName), false);
        assert.deepEqual(settings, originalSettings, '卸载入口不重置插件设置或收藏');
        assert.deepEqual(warnings, []);
        assert.equal(requests.some(url => url.startsWith('/api/')), false, '不会请求删除插件文件或个人数据');
    }, api);
});

test('入口清理失败时保留原始错误，并提示用户手动清理', async () => {
    const failure = new Error('模拟快速回复读取失败');
    const api = { getSetByName() { throw failure; } };
    await withApp(async ({ app, warnings }) => {
        await assert.rejects(app[manifest.hooks.delete](), error => error === failure);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0][0], /手动删除/);
        assert.equal(warnings[0][1], '卸载清理未完成');
    }, api);
});
