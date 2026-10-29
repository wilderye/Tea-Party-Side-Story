import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('酒馆清单指定的更新函数立即刷新，不增加提示、保存或等待条件', async t => {
    const hooks = registerHooks({ load(url, context, next) {
        if (new URL(url).pathname.endsWith('/panel.js')) return {
            format: 'module', shortCircuit: true, source: `
                export function element() { return {}; }
                export function textButton() { return {}; }
                export function createTheatrePanel(ctx, state) {
                    state.saving = state.updating = true;
                    return { refresh() {}, refreshStatus() {}, open() {} };
                }
            `,
        };
        return next(url, context);
    } });
    const context = {
        extensionSettings: { teahouse: { enabled: true, favorites: {}, libraryUrl: '' } }, chat: [],
        getRequestHeaders: () => ({}), saveSettingsDebounced() {}, registerMacro() {},
        eventTypes: {}, eventSource: { on() {} },
        SlashCommandParser: { addCommandObject() {} }, SlashCommand: { fromProps: value => value },
    };
    const previous = Object.fromEntries(['SillyTavern', 'document', 'fetch', 'location', 'toastr']
        .map(key => [key, globalThis[key]]));
    let reloads = 0;
    Object.assign(globalThis, {
        SillyTavern: { getContext: () => context }, document: { querySelector: () => null },
        fetch: async () => new Response('', { status: 404 }),
        location: { reload() { reloads++; } },
        toastr: { info() { assert.fail('不应增加刷新前提示'); } },
    });
    try {
        const app = await import(`../${manifest.js}?update-test=${randomUUID()}`);
        assert.equal(reloads, 0, '普通加载不会刷新');
        await app.updateLibrary();
        assert.equal(reloads, 0, '更新茶会选集不会刷新酒馆页面');
        t.mock.method(globalThis, 'setTimeout', () => assert.fail('不应延迟刷新'));
        t.mock.method(globalThis, 'fetch', () => assert.fail('不应额外请求保存'));
        t.mock.method(context, 'saveSettingsDebounced', () => assert.fail('不应额外保存设置'));
        t.mock.method(app.playground, 'getStates', () => assert.fail('不应检查生成状态'));
        assert.equal(typeof app[manifest.hooks.update], 'function');
        app[manifest.hooks.update]();
        assert.equal(reloads, 1, '更新回调在返回前刷新，即使手稿保存和选集更新状态为忙碌');
    } finally {
        t.mock.restoreAll();
        Object.assign(globalThis, previous);
        hooks.deregister();
    }
});
