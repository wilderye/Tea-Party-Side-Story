import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('空宏在真实生成准备完成后合并提示；预计算、停用和同轮重复不提示', async () => {
    const events = new Map(), macros = new Map(), warnings = [];
    const settings = { favorites: {}, enabled: true, libraryUrl: '' };
    const manuscript = { id: `local:${randomUUID()}`, title: '可用手稿', body: '可用正文', type: 'standalone', publishedAt: '2026-10-01T00:00:00Z' };
    const context = {
        extensionSettings: { teahouse: settings }, chat: [], saveSettingsDebounced() {}, substituteParams: x => x,
        eventTypes: Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_AFTER_DATA', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_RECEIVED', 'TOOL_CALLS_PERFORMED'].map(x => [x, x])),
        eventSource: { on: (name, fn) => events.set(name, fn) }, registerMacro: (name, fn) => macros.set(name, fn),
        SlashCommandParser: { addCommandObject() {} }, SlashCommand: { fromProps: x => x },
    };
    const previous = Object.fromEntries(['fetch', 'document', 'SillyTavern', 'toastr'].map(key => [key, globalThis[key]]));
    globalThis.fetch = async url => String(url).endsWith('manuscripts.json')
        ? Response.json({ format: 1, entries: [manuscript] }) : new Response('', { status: 404 });
    globalThis.document = { querySelector: () => null };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { warning: (...args) => warnings.push(args) };
    const emit = (name, ...args) => events.get(name)?.(...args);
    const community = () => macros.get('茶话会小剧场')();
    const favorite = () => macros.get('我收藏的小剧场')();
    try {
        const app = await import(`../index.js?empty=${randomUUID()}`);
        await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, true);
        assert.equal(community(), ''); assert.equal(favorite(), '');
        await emit('GENERATE_AFTER_DATA', {}, true);
        assert.equal(warnings.length, 0);
        await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        assert.equal(favorite(), ''); assert.equal(favorite(), '');
        assert.equal(warnings.length, 0, '等待所有宏处理完成');
        await emit('GENERATE_AFTER_DATA', {}, false);
        assert.equal(warnings[0][0], '{{我收藏的小剧场}}无可用小剧场，填写内容为空');
        assert.equal(warnings[0][2].timeOut, 5000);
        assert.equal(warnings[0][2].closeButton, true);
        await emit('GENERATE_AFTER_DATA', {}, false);
        assert.equal(warnings.length, 1);
        await emit('GENERATION_ENDED');
        await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        favorite(); community(); community();
        await emit('GENERATE_AFTER_DATA', {}, false);
        assert.equal(warnings[1][0], '{{茶话会小剧场}}/{{我收藏的小剧场}}无可用小剧场，填写内容为空');
        assert.equal(settings.lastId, undefined, '没有内容不推进抽取记录');
        await emit('GENERATION_ENDED');
        await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        await emit('GENERATE_AFTER_DATA', {}, false);
        assert.equal(warnings.length, 2, '未使用宏不提示');
        settings.enabled = false;
        await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        community(); favorite(); await emit('GENERATE_AFTER_DATA', {}, false);
        assert.equal(warnings.length, 2);
        settings.enabled = true;
        globalThis.fetch = async () => Response.json({});
        context.getRequestHeaders = () => ({});
        await app.saveManuscript({ ...manuscript, type: 'preset' });
        await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        assert.equal(favorite(), ''); assert.equal(community(), '可用正文');
        await emit('GENERATE_AFTER_DATA', {}, false);
        assert.equal(warnings[2][0], '{{我收藏的小剧场}}无可用小剧场，填写内容为空', '所有随文宏包含未收藏的亲笔手稿；有内容的宏不列入警告');
    } finally { Object.assign(globalThis, previous); }
});
