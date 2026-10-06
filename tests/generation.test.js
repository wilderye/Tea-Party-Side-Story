import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTheatreGeneration } from '../generation.js';

async function fixture(loaded = Promise.resolve(), beforeRegister = () => {}) {
    const listeners = new Map(), macros = new Map();
    let saves = 0;
    const source = {
        on(name, fn) {
            assert.ok(name, 'only native event names are registered');
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        },
        async emit(name, ...args) {
            for (const fn of [...listeners.get(name) ?? []]) await fn(...args);
        },
    };
    const settings = { enabled: true, favorites: { A: 1, B: 2 }, lastId: 'B', lastFavoriteId: 'B' };
    const entries = new Map(['A', 'B'].map(id => [id, { id, type: 'preset', body: `theatre ${id}` }]));
    const context = {
        chat: [], chatId: 'chat-a', getCurrentChatId() { return this.chatId; },
        substituteParams: text => text, registerMacro: (name, fn) => macros.set(name, fn),
        eventSource: source,
        eventTypes: Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_AFTER_DATA',
            'MESSAGE_RECEIVED', 'STREAM_TOKEN_RECEIVED', 'GENERATION_STOPPED', 'GENERATION_ENDED',
            'TOOL_CALLS_PERFORMED', 'CHAT_CHANGED'].map(x => [x, x])),
    };
    beforeRegister(source, context);
    const generation = await registerTheatreGeneration(() => context, { settings, entries }, loaded, () => { saves++; });
    return {
        context, settings, entries, source, generation, emit: source.emit.bind(source),
        get saves() { return saves; },
        macro: (name = '茶话会小剧场') => macros.get(name)(),
        async begin(type = 'normal', { native = true, preview = false } = {}) {
            if (native) await source.emit('GENERATION_STARTED', type, {}, preview);
            await source.emit('GENERATION_AFTER_COMMANDS', type, {}, preview);
        },
        ready: () => source.emit('GENERATE_AFTER_DATA', {}, false),
    };
}

const message = (text = '正文') => ({ mes: text, is_user: false, extra: { other: 'preserved' }, swipe_id: 0,
    swipes: [text], swipe_info: [{ extra: { other: 'preserved' } }] });

for (const previewFirst of [false, true]) {
    for (const previewFinishesFirst of [false, true]) {
        test(`正文与预计算重叠仍逐条换剧场：预计算先展开宏=${previewFirst}，先完成=${previewFinishesFirst}`, async () => {
            const f = await fixture();
            f.settings.lastId = f.settings.lastFavoriteId = 'A';
            for (const expected of ['B', 'A', 'B']) {
                const saves = f.saves;
                await f.begin();
                if (!previewFirst) {
                    assert.equal(f.macro(), `theatre ${expected}`);
                    assert.equal(f.macro('我收藏的小剧场'), `theatre ${expected}`);
                }
                await f.begin('normal', { preview: true });
                assert.equal(f.macro(), `theatre ${expected}`, '重叠的预计算共用正文选择');
                assert.equal(f.macro('我收藏的小剧场'), `theatre ${expected}`);
                if (previewFinishesFirst) await f.emit('GENERATE_AFTER_DATA', {}, true);
                const sent = [f.macro(), f.macro('我收藏的小剧场')];
                await f.ready();
                if (!previewFinishesFirst) await f.emit('GENERATE_AFTER_DATA', {}, true);
                assert.deepEqual(sent, [`theatre ${expected}`, `theatre ${expected}`]);
                assert.equal(f.saves - saves, 2, '两个宏各记录一次，不因预计算多抽取');
                const messageId = f.context.chat.length;
                f.context.chat.push(message());
                await f.emit('MESSAGE_RECEIVED', messageId, 'normal');
                assert.deepEqual(f.context.chat[messageId].extra.teahouse, { id: expected, favoriteId: expected });
                await f.emit('GENERATION_ENDED');
                await f.begin('normal', { native: false });
                f.macro(); f.macro('我收藏的小剧场');
                await f.ready(); await f.emit('GENERATION_ENDED');
                assert.equal(f.settings.lastId, expected, '随后额外请求不推进正文历史');
                assert.equal(f.settings.lastFavoriteId, expected);
            }
        });
    }
}

test('正文开始通知与命令处理之间的预计算不能消耗正文身份', async () => {
    const f = await fixture();
    await f.emit('GENERATION_STARTED', 'normal', {}, false);
    await f.begin('normal', { preview: true });
    f.macro(); f.macro('我收藏的小剧场');
    await f.emit('GENERATE_AFTER_DATA', {}, true);
    assert.equal(f.saves, 0, '尚无正文组装时，预计算不抽取');
    await f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    f.macro(); f.macro('我收藏的小剧场'); await f.ready();
    assert.equal(f.settings.lastId, 'A');
    assert.equal(f.settings.lastFavoriteId, 'A');
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    assert.deepEqual(f.context.chat[0].extra.teahouse, { id: 'A', favoriteId: 'A' });
});

test('预计算单独运行及正文结束后运行都不推进历史；继续生成仍沿用原剧场', async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
        await f.begin('normal', { preview: true }); f.macro(); f.macro('我收藏的小剧场');
        await f.emit('GENERATE_AFTER_DATA', {}, true);
    }
    assert.equal(f.saves, 0);
    f.context.chat.push(message());
    f.context.chat[0].extra.teahouse = { id: 'B', favoriteId: 'B' };
    await f.begin('continue');
    await f.begin('normal', { preview: true });
    assert.equal(f.macro(), 'theatre B'); assert.equal(f.macro('我收藏的小剧场'), 'theatre B');
    await f.ready(); await f.emit('GENERATE_AFTER_DATA', {}, true);
    await f.emit('MESSAGE_RECEIVED', 0, 'appendFinal'); await f.emit('GENERATION_ENDED');
    const saves = f.saves;
    await f.begin('normal', { preview: true }); f.macro(); f.macro('我收藏的小剧场');
    await f.emit('GENERATE_AFTER_DATA', {}, true);
    assert.equal(f.saves, saves);
    assert.deepEqual(f.context.chat[0].extra.teahouse, { id: 'B', favoriteId: 'B' });
});

test('正文等待剧场库加载时插入预计算，加载完成后仍按正文抽取', async () => {
    let finish;
    const f = await fixture(new Promise(resolve => { finish = resolve; }));
    f.settings.lastId = 'A';
    await f.emit('GENERATION_STARTED', 'normal', {}, false);
    const waiting = f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await f.begin('normal', { preview: true }); f.macro();
    finish(); await waiting;
    assert.equal(f.macro(), 'theatre B');
    await f.ready(); await f.emit('GENERATE_AFTER_DATA', {}, true);
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    assert.equal(f.context.chat[0].extra.teahouse.id, 'B');
});

for (const streaming of [false, true]) {
    for (const extensionFirst of [false, true]) {
        for (const extraMacro of [false, true]) {
            test(`额外请求不能改写正文记录：流式=${streaming}，脚本先处理=${extensionFirst}，额外宏=${extraMacro}`, async () => {
                let f;
                const extension = async () => {
                    await f.begin('normal', { native: false });
                    if (extraMacro) {
                        assert.equal(f.macro(), 'theatre B');
                        assert.equal(f.macro('我收藏的小剧场'), 'theatre B');
                    }
                    await f.ready();
                    await f.emit('GENERATION_ENDED');
                    f.context.chat[0].mes += '\n<StatusPlaceHolderImpl/>';
                    f.context.chat[0].variables = [{ stat_data: { value: 1 } }];
                };
                f = await fixture(Promise.resolve(), source => {
                    if (extensionFirst) source.on('MESSAGE_RECEIVED', extension);
                });
                if (!extensionFirst) f.source.on('MESSAGE_RECEIVED', extension);
                await f.begin();
                assert.equal(f.macro(), 'theatre A');
                assert.equal(f.macro('我收藏的小剧场'), 'theatre A');
                await f.ready();
                f.context.chat.push(message());
                if (streaming) {
                    f.context.streamingProcessor = { type: 'normal', messageId: 0, result: '正文' };
                    // Deliberately omit the early token binding: final delivery must also be safe.
                    await f.emit('GENERATION_ENDED');
                    assert.equal(f.context.chat[0].extra.teahouse, undefined, '结束通知不写记录');
                }
                await f.emit('MESSAGE_RECEIVED', 0, 'normal');
                await f.emit('GENERATION_ENDED');
                assert.deepEqual(f.context.chat[0].extra.teahouse, { id: 'A', favoriteId: 'A' });
                assert.deepEqual(f.context.chat[0].swipe_info[0].extra.teahouse, { id: 'A', favoriteId: 'A' });
                assert.equal(f.context.chat[0].extra.other, 'preserved');
                assert.equal(f.settings.lastId, 'A', '额外请求不推进正文的抽取记录');
                assert.equal(f.settings.lastFavoriteId, 'A', '收藏宏的正文抽取记录也保持不变');
                await f.begin('continue');
                assert.equal(f.macro(), 'theatre A');
            });
        }
    }
}

for (const extraCount of [1, 2, 3]) {
    test(`每轮 ${extraCount} 次额外请求后，两个宏的正文分别保持 A/B 轮换`, async () => {
        const f = await fixture();
        f.settings.lastFavoriteId = 'A';
        for (const [community, favorite] of [['A', 'B'], ['B', 'A'], ['A', 'B'], ['B', 'A']]) {
            await f.begin();
            assert.equal(f.macro(), `theatre ${community}`);
            assert.equal(f.macro('我收藏的小剧场'), `theatre ${favorite}`);
            await f.ready();
            const messageId = f.context.chat.length;
            f.context.chat.push(message());
            // Model post-processing that runs before our MESSAGE_RECEIVED listener.
            for (let i = 0; i < extraCount; i++) {
                await f.begin('normal', { native: false });
                for (const name of ['茶话会小剧场', '我收藏的小剧场']) {
                    const text = f.macro(name);
                    assert.match(text, /^theatre [AB]$/);
                    assert.equal(f.macro(name), text, '同一次额外请求重复使用宏仍得到同一条');
                }
                await f.ready();
                await f.emit('GENERATION_ENDED');
                assert.equal(f.settings.lastId, community);
                assert.equal(f.settings.lastFavoriteId, favorite);
            }
            await f.emit('MESSAGE_RECEIVED', messageId, 'normal');
            await f.emit('GENERATION_ENDED');
            assert.deepEqual(f.context.chat[messageId].extra.teahouse, { id: community, favoriteId: favorite });
        }
    });
}

test('普通回复、重生成、续写、群聊逐条记录；同轮多次宏一致', async () => {
    const f = await fixture();
    for (const expected of ['A', 'B']) {
        await f.begin();
        assert.equal(f.macro(), `theatre ${expected}`);
        assert.equal(f.macro(), `theatre ${expected}`);
        await f.ready();
        f.context.chat.push(message());
        await f.emit('MESSAGE_RECEIVED', f.context.chat.length - 1, 'normal');
        await f.emit('GENERATION_ENDED');
    }
    assert.deepEqual(f.context.chat.map(x => x.extra.teahouse.id), ['A', 'B']);
    const current = f.context.chat.at(-1);
    current.swipe_id = 1;
    await f.begin('swipe'); assert.equal(f.macro(), 'theatre A'); await f.ready();
    current.swipe_info.push({ extra: {} });
    await f.emit('MESSAGE_RECEIVED', 1, 'swipe');
    assert.equal(current.swipe_info[0].extra.teahouse.id, 'B');
    assert.equal(current.swipe_info[1].extra.teahouse.id, 'A');
    await f.begin('continue'); assert.equal(f.macro(), 'theatre A'); await f.ready();
    await f.emit('MESSAGE_RECEIVED', 1, 'appendFinal');
    await f.begin('regenerate');
    f.context.chat.pop(); // ST removes the old reply after GENERATION_AFTER_COMMANDS.
    assert.equal(f.macro(), 'theatre B'); await f.ready();
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(f.context.chat[1].extra.teahouse.id, 'B');
});

test('预计算和原生 quiet 请求都不能夺走已准备好的正文记录', async () => {
    const f = await fixture();
    await f.begin(); assert.equal(f.macro(), 'theatre A'); await f.ready();
    await f.begin('normal', { preview: true }); f.macro();
    await f.emit('GENERATE_AFTER_DATA', {}, true);
    assert.equal(f.settings.lastId, 'A');
    await f.begin('quiet'); assert.equal(f.macro(), 'theatre B'); await f.ready();
    await f.emit('GENERATION_ENDED');
    assert.equal(f.settings.lastId, 'A', '原生后台请求也不推进正文抽取记录');
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    assert.equal(f.context.chat[0].extra.teahouse.id, 'A');
    await f.begin(); assert.equal(f.macro(), 'theatre B');
});

test('工具调用后继续使用正文原选择，后处理额外抽取不能抢走工具续接', async () => {
    const f = await fixture();
    await f.begin(); assert.equal(f.macro(), 'theatre A'); await f.ready();
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    await f.begin('normal', { native: false }); assert.equal(f.macro(), 'theatre B'); await f.ready();
    await f.emit('GENERATION_ENDED');
    await f.emit('TOOL_CALLS_PERFORMED');
    await f.begin('normal', { native: false }); f.macro(); await f.ready();
    await f.begin(); assert.equal(f.macro(), 'theatre A'); await f.ready();
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(f.context.chat[1].extra.teahouse.id, 'A');
});

test('中断流式续写或重生成，即使不再发收到回复通知，已生成片段保留对应剧场', async () => {
    for (const type of ['continue', 'swipe']) {
        const f = await fixture();
        const current = message(); current.extra.teahouse = { id: 'B' };
        f.context.chat.push(current);
        if (type === 'swipe') { current.swipe_id = 1; current.swipe_info.push({ extra: {} }); }
        await f.begin(type); f.macro(); const selected = f.settings.lastId; await f.ready();
        f.context.streamingProcessor = { type, messageId: 0, result: '片段' };
        await f.emit('STREAM_TOKEN_RECEIVED', '片段');
        await f.emit('GENERATION_STOPPED'); await f.emit('GENERATION_ENDED');
        assert.equal(current.extra.teahouse.id, selected);
        assert.equal(current.swipe_info[current.swipe_id].extra.teahouse.id, selected);
    }
});

test('切换聊天、回复版本、删除消息或停用后，迟到事件不能改写别的回复', async () => {
    for (const action of ['chat', 'swipe', 'delete', 'disable', 'stop']) {
        const f = await fixture();
        f.context.chat.push(message());
        await f.begin('continue'); f.macro(); await f.ready();
        if (action === 'chat') { f.context.chatId = 'chat-b'; await f.emit('CHAT_CHANGED'); }
        if (action === 'swipe') f.context.chat[0].swipe_id = 1;
        if (action === 'delete') f.context.chat[0] = message('另一个回复');
        if (action === 'disable') { f.settings.enabled = false; f.generation.reset(); }
        if (action === 'stop') await f.emit('GENERATION_STOPPED');
        await f.emit('MESSAGE_RECEIVED', 0, 'normal');
        assert.equal(f.context.chat[0].extra.teahouse, undefined, action);
    }
});

test('空请求、代写、纯脚本请求不把记录写入已有正文；失败后新回复不继承旧记录', async () => {
    const f = await fixture();
    await f.begin(); f.macro(); await f.ready(); // no response: failed request
    await f.emit('GENERATION_ENDED');
    await f.begin(); await f.ready(); // no macro
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    assert.equal(f.context.chat[0].extra.teahouse, undefined);
    const last = f.settings.lastId;
    for (const options of [{ native: false }, { native: true, type: 'impersonate' }]) {
        await f.begin(options.type, options); f.macro(); await f.ready();
        await f.emit('MESSAGE_RECEIVED', 0, 'normal');
        assert.equal(f.context.chat[0].extra.teahouse, undefined);
        assert.equal(f.settings.lastId, last, '每次非正文请求都不推进正文抽取记录');
    }
});

test('同一收到回复通知重复触发或结束通知重复触发，记录只属于原请求', async () => {
    const f = await fixture();
    await f.begin(); f.macro(); await f.ready();
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    await f.begin('normal', { native: false }); f.macro(); await f.ready();
    await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    await f.emit('GENERATION_ENDED'); await f.emit('GENERATION_ENDED');
    assert.equal(f.context.chat[0].extra.teahouse.id, 'A');
});

test('收到回复的脚本先调用原生生成追加另一条回复，两条消息仍各自对应', async () => {
    let f, nested = false;
    f = await fixture(Promise.resolve(), source => source.on('MESSAGE_RECEIVED', async () => {
        if (nested) return;
        nested = true;
        await f.begin(); assert.equal(f.macro(), 'theatre B'); await f.ready();
        f.context.chat.push(message('脚本追加的回复'));
        await f.emit('MESSAGE_RECEIVED', 1, 'normal');
        await f.emit('GENERATION_ENDED');
    }));
    await f.begin(); assert.equal(f.macro(), 'theatre A'); await f.ready();
    f.context.chat.push(message()); await f.emit('MESSAGE_RECEIVED', 0, 'normal');
    assert.deepEqual(f.context.chat.map(x => x.extra.teahouse.id), ['A', 'B']);
});

test('等待剧场库期间切换聊天，旧生成准备不能重新激活', async () => {
    let finish;
    const f = await fixture(new Promise(resolve => { finish = resolve; }));
    const starting = f.begin();
    await Promise.resolve(); await Promise.resolve();
    f.context.chatId = 'chat-b'; await f.emit('CHAT_CHANGED');
    finish(); await starting;
    f.macro(); assert.equal(f.settings.lastId, 'B');
});
