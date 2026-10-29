import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { capturePlayEnvironment, createPlayRuntime, readPlayTarget } from '../play-runtime.js';
import { createPlayHistory } from '../play-history.js';
import { createPlayFiles } from '../play-storage.js';
import { memoryFiles, characterA, contextA } from './play-fixture.js';

test('酒馆文件接口失败保留 HTTP 状态和服务器原文，读取不存在文件仍返回空', async t => {
    const message = '{"error":"ENOSPC: no space left on device"}';
    t.mock.method(globalThis, 'fetch', async () => new Response(message, { status: 507, statusText: 'Insufficient Storage' }));
    const files = createPlayFiles(() => ({ 'Content-Type': 'application/json' }));
    const matches = error => error.message === `HTTP 507 Insufficient Storage\n${message}`;
    await assert.rejects(files.writeFile('teahouse-play-test.json', '正文'), matches);
    await assert.rejects(files.readFile('teahouse-play-test.json'), matches);
    globalThis.fetch = async () => new Response('missing', { status: 404 });
    assert.equal(await files.readFile('teahouse-play-test.json'), null);
});

function context() {
    return { characters: [{ ...characterA, data: { description: '原始角色说明' } }], characterId: 0, groupId: null,
        mainApi: 'openai', chatId: 'A-main', name1: '你',
        chat: [{ mes: '主聊天正文', variables: [{ stat_data: { 好感度: 20 } }] }],
        chatMetadata: { variables: { foo: '原值' } }, chatCompletionSettings: { preset_settings: '当前预设', proxy_password: 'secret' },
        powerUserSettings: { persona_description: '用户人设' }, extensionPrompts: { note: { value: '注释' } },
        extensionSettings: { variables: { global: { globalFoo: '原值' } } }, uuidv4: randomUUID,
        getCharacterCardFields: () => { throw new Error('不能在复制阶段运行宏'); },
        substituteParams: () => { throw new Error('不能在复制阶段运行宏'); },
        eventTypes: {}, eventSource: { on() {} },
    };
}

test('自动重试规则在开始生成时复制，等待期间修改设置只影响下一次任务', () => {
    const settings = { playRetry: { rateLimit: true, empty: true, maxRetries: 3, intervalSeconds: 2 } };
    const env = capturePlayEnvironment(context(), settings);
    settings.playRetry.rateLimit = false; settings.playRetry.maxRetries = 0;
    assert.deepEqual(env.retry, { rateLimit: true, empty: true, maxRetries: 3, intervalSeconds: 2 });
    assert.deepEqual(capturePlayEnvironment(context(), settings).retry, settings.playRetry);
});

test('每次生成捕获小剧场正则选择，后续改设置不会改变已开始的任务', () => {
    const settings = { playRegexExclusions: ['old'], playRegexOverrides: { local: true } };
    const env = capturePlayEnvironment(context(), settings);
    settings.playRegexEnabled = false; settings.playRegexOverrides.local = false; settings.playRegexExclusions.push('next');
    assert.deepEqual(env.playRegex, { enabled: true, overrides: { old: false, local: true } });
    assert.deepEqual(capturePlayEnvironment(context(), settings).playRegex, { enabled: false, overrides: { old: false, next: false, local: false } });
});
test('手动收藏按头像标识读取角色名称，不读取卡片内容或生成设置，不改主聊天', async () => {
    const f = memoryFiles(), ctx = context();
    ctx.characters.push({ avatar: 'B.png', name: ctx.characters[0].name });
    Object.defineProperty(ctx.characters[1], 'data', { get() { throw new Error('不能读取角色卡正文'); } });
    ctx.mainApi = 'textgenerationwebui';
    const runtime = createPlayRuntime(() => ctx, { enabled: true }, f.store);
    const original = structuredClone(ctx.chat);
    const added = await runtime.addManualFavorite({ characterAvatar: 'B.png', title: '手动标题', text: '手动正文', firstLine: '手动正文' });
    assert.equal(added.source.characterAvatar, 'B.png'); assert.equal(added.characterName, '角色A');
    ctx.characters[1].name = '后来改名';
    assert.equal((await runtime.getFavorite(added.id)).characterName, '角色A');
    assert.equal((await runtime.addManualFavorite({ characterAvatar: 'B.png', title: '', text: '下一份', firstLine: '下一份' })).characterName, '后来改名');
    ctx.characters.pop();
    assert.throws(() => runtime.addManualFavorite({ characterAvatar: 'B.png', title: '', text: '不能保存', firstLine: '' }), /已不存在/);
    assert.deepEqual(ctx.chat, original); assert.deepEqual(f.directory().rounds, []);
    const disabled = createPlayRuntime(() => ctx, { enabled: false }, f.store);
    assert.throws(() => disabled.addManualFavorite({ characterAvatar: 'A.png', title: '', text: '正文', firstLine: '正文' }), /停用/);
});

test('捕获目标角色和 API 选择，默认复制当前聊天供后续处理、不计算宏、不修改主聊天', () => {
    const ctx = context(), original = structuredClone({ chat: ctx.chat, metadata: ctx.chatMetadata, settings: ctx.extensionSettings });
    const env = capturePlayEnvironment(ctx, { playApi: { mode: 'custom', key: 'custom-secret' } });
    assert.deepEqual(env.chat, []); assert.equal(env.noChat, false); assert.equal(env.context.chatId, '');
    assert.equal(env.context.chatMode, 'latest');
    assert.deepEqual(env.nativeChat, { chatId: 'A-main', messages: ctx.chat, metadata: ctx.chatMetadata });
    env.nativeChat.messages[0].mes = '修改聊天副本';
    env.characterCard.data.description = '修改副本';
    env.api.key = '修改';
    assert.deepEqual({ chat: ctx.chat, metadata: ctx.chatMetadata, settings: ctx.extensionSettings }, original);
    assert.equal(ctx.chatCompletionSettings.proxy_password, 'secret');
    assert.equal(env.context.apiMode, 'custom');
    assert.equal(env.character.avatar, 'A.png');
    assert.equal(ctx.characters[0].data.description, '原始角色说明');
    ctx.chatCompletionSettings.preset_settings = '后来切换的预设';
    ctx.powerUserSettings.persona_description = '后来修改的人设';
    assert.equal(env.tavern.settings.preset_settings, '当前预设');
    assert.equal(env.tavern.power.persona_description, '用户人设');
});

test('续写方式、提示词和原生思维链开关随请求捕获，切换设置只影响下一次续写', () => {
    const ctx = context(), settings = { playContinueMode: 'prompt', playContinuePrompts: { history: '第一种', prompt: '第二种：{{lastChatMessage}}' } };
    const env = capturePlayEnvironment(ctx, settings);
    settings.playContinueMode = 'history'; settings.playContinuePrompts.prompt = '后来修改'; settings.playContinueSendReasoning = false;
    assert.deepEqual(env.continuation, { mode: 'prompt', prompt: '第二种：{{lastChatMessage}}', sendReasoning: true });
    const disabled = capturePlayEnvironment(ctx, settings);
    assert.deepEqual(disabled.continuation, { mode: 'history', prompt: '第一种', sendReasoning: false });
    settings.playContinueSendReasoning = true;
    assert.equal(disabled.continuation.sendReasoning, false);
    assert.equal(capturePlayEnvironment(ctx, settings).continuation.sendReasoning, true);
});

test('选中的小剧场提示词及位置随请求捕获，后来编辑只影响下一次发送', () => {
    const settings = { playPromptConfig: { presets: [
        { id: 'default', name: '默认提示词', content: '旧默认' },
        { id: 'recommended', name: '强调完整性', content: '旧推荐' },
    ], selectedId: 'recommended', position: 'user-before' } };
    const ctx = context(), environment = capturePlayEnvironment(ctx, settings);
    settings.playPromptConfig.presets[1].content = '新推荐';
    settings.playPromptConfig.selectedId = 'default'; settings.playPromptConfig.position = 'user-after';
    assert.equal(environment.playPrompt, '旧推荐'); assert.equal(environment.playPromptPosition, 'user-before');
    const next = capturePlayEnvironment(ctx, settings);
    assert.equal(next.playPrompt, '旧默认'); assert.equal(next.playPromptPosition, 'user-after');
});

test('当前角色和接口范围明确；无关的扩展回调不会阻止生成', () => {
    assert.throws(() => readPlayTarget({ ...context(), characters: [] }), error => error.code === 'no_current_character');
    assert.equal(readPlayTarget({ ...context(), chatId: '' }).character.avatar, 'A.png');
    assert.throws(() => readPlayTarget({ ...context(), groupId: 'group-a' }), /群聊尚未接入/);
    assert.throws(() => capturePlayEnvironment({ ...context(), mainApi: 'textgenerationwebui' }, {}), /聊天补全预设/);
    const ctx = context(); ctx.extensionPrompts.note.filter = () => true;
    assert.equal(capturePlayEnvironment(ctx, {}).character.avatar, 'A.png');
});

test('用户名字和头像读取当前酒馆人设，不写入历史或修改聊天', async () => {
    const ctx = context(), f = memoryFiles(), persona = { user_avatar: '茶客.png' };
    ctx.name1 = '茶客';
    const runtime = createPlayRuntime(() => ctx, {}, f.store, { loadPersona: async () => persona });
    assert.deepEqual(await runtime.getUserIdentity(), { name: '茶客', avatar: '茶客.png' });
    ctx.name1 = '旅人'; persona.user_avatar = '旅人.png';
    assert.deepEqual(await runtime.getUserIdentity(), { name: '旅人', avatar: '旅人.png' });
    assert.equal(f.files.size, 0);
    assert.equal(ctx.chat[0].mes, '主聊天正文');
});

test('运行入口默认接入原生准备函数；加载插件不读历史、不发模型请求', async () => {
    const f = memoryFiles(), ctx = context();
    let reads = 0;
    const runtime = createPlayRuntime(() => ctx, { enabled: true }, createPlayHistory({ ...f.io, readFile: async name => { reads++; return f.io.readFile(name); } }));
    assert.equal(reads, 0);
    assert.equal(runtime.availability().code, 'generation_loading');
    assert.equal(reads, 0);
    assert.equal(f.files.size, 0);
});

test('酒馆改名和删卡通知只更新游玩目录，不修改主聊天', async () => {
    const f = memoryFiles(), ctx = context(), callbacks = new Map();
    const seeded = await f.begin({ context: contextA });
    const before = structuredClone(ctx.chat);
    ctx.eventTypes = { CHARACTER_RENAMED: 'rename', CHARACTER_DELETED: 'delete' };
    ctx.eventSource.on = (event, callback) => callbacks.set(event, callback);
    const runtime = createPlayRuntime(() => ctx, { enabled: true }, f.store);
    ctx.characters[0].avatar = 'new.png'; ctx.characters[0].name = '新名字';
    assert.equal(callbacks.get('rename')('A.png', 'new.png'), undefined, '不阻塞酒馆的改名事件');
    await nextTurn();
    const character = (await runtime.listCharacters())[0];
    assert.equal(character.id, seeded.characterId);
    assert.equal(character.name, '新名字');
    assert.equal(callbacks.get('delete')({ character: ctx.characters[0] }), undefined, '不阻塞酒馆的删卡事件');
    await nextTurn();
    assert.equal((await runtime.listCharacters())[0].avatar, null);
    assert.deepEqual(ctx.chat, before);
});
