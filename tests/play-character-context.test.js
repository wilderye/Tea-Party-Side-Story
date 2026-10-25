import test from 'node:test';
import assert from 'node:assert/strict';
import { readLatestPlayVariables, readPlayCharacterChat, selectPlayPersona, resolvePlayCharacterContext } from '../play-character-context.js';

const context = { getRequestHeaders: () => ({}) };
const signal = () => new AbortController().signal;
const environment = (noChat = false) => ({ noChat, character: { avatar: 'A.png', name: '测试甲' },
    tavern: { name1: '当前人设', userAvatar: 'current', power: { personas: { current: '当前人设', bound: '角色人设', chat: '聊天人设', default: '默认人设' },
        persona_description: '当前描述', persona_descriptions: {
            bound: { description: '角色描述', lorebook: '角色人设世界书', connections: [{ id: 'A.png' }] },
            chat: { description: '聊天描述' }, default: { description: '默认描述' },
        }, default_persona: 'default' } } });

test('不发聊天时不查询聊天列表、不读首楼和聊天变量，只处理初值并跳过聊天人设', async () => {
    let initialCalls = 0;
    const result = await resolvePlayCharacterContext(context, environment(true), signal(), {
        fetchJson: () => { throw Error('不应读取任何聊天'); },
        choosePersona: () => { throw Error('只有一个角色人设，不应弹窗'); },
        initializeVariables: async () => { initialCalls++; return { stat_data: { year: 750 } }; },
    });
    assert.equal(initialCalls, 1); assert.equal(result.chatId, ''); assert.deepEqual(result.messages, []);
    assert.equal(result.persona.id, 'bound'); assert.equal(result.persona.power.persona_description_lorebook, '角色人设世界书');
    assert.equal(result.variables.stat_data.year, 750); assert.equal(result.variableSource, 'initial');
});

test('按聊天列表时间选最新聊天，13楼当前版本变量优先，聊天绑定人设优先', async () => {
    const messages = Array.from({ length: 13 }, (_, index) => ({ mes: `模拟第${index + 1}楼`, variables: [{ stat_data: { year: 750 + index } }] }));
    messages[12].swipe_id = 1; messages[12].variables[1] = { stat_data: { year: 749 } };
    const calls = [];
    const result = await resolvePlayCharacterContext(context, environment(), signal(), {
        fetchJson: async (url, body) => {
            calls.push([url, body]);
            return url.endsWith('/chats') ? [{ file_name: 'old.jsonl', last_mes: '2026-01-01' }, { file_name: 'latest.jsonl', last_mes: '2026-10-25' }]
                : [{ chat_metadata: { persona: 'chat', scenario: '聊天情景' } }, ...messages];
        }, choosePersona: () => { throw Error('聊天已有绑定，不应弹窗'); },
        initializeVariables: () => { throw Error('已有有效变量，不应初始化'); },
    });
    assert.deepEqual(calls[1], ['/api/chats/get', { avatar_url: 'A.png', file_name: 'latest' }]);
    assert.equal(result.variables.stat_data.year, 749); assert.equal(result.persona.id, 'chat'); assert.equal(result.messages.length, 13);
    assert.equal(result.variableSource, 'latest');
    result.variables.stat_data.year = 1; assert.equal(messages[12].variables[1].stat_data.year, 749);
});

test('只有首楼也读取当前版本变量，后续楼层未存变量时往前找，不借其他版本', () => {
    const first = { mes: '非开场白1', swipe_id: 2, variables: [{ year: 750 }, { year: 751 }, { year: 748 }] };
    assert.deepEqual(readLatestPlayVariables([first]), { year: 748 });
    assert.deepEqual(readLatestPlayVariables([first, { mes: '后续无变量' }]), { year: 748 });
    assert.equal(readLatestPlayVariables([{ ...first, swipe_id: 9 }]), null);
    assert.throws(() => readLatestPlayVariables([{ mes: '格式有误', variables: ['broken'] }]), /格式不正确/);
});

test('没有聊天、没有首楼或聊天没有有效变量才回退初值，初始化失败保留错误', async () => {
    for (const saved of [null, [{ chat_metadata: { persona: 'chat' } }], [{ mes: '首楼无变量' }]]) {
        let count = 0;
        const result = await resolvePlayCharacterContext(context, environment(), signal(), {
            fetchJson: async url => url.endsWith('/chats') ? saved === null ? [] : [{ file_name: 'empty.jsonl' }] : saved,
            initializeVariables: async () => { count++; return {}; },
        });
        assert.equal(count, 1); assert.deepEqual(result.variables, {}); assert.equal(result.variableSource, 'initial');
        if (!saved?.some(message => typeof message.mes === 'string')) assert.deepEqual(result.metadata, {});
    }
    await assert.rejects(resolvePlayCharacterContext(context, environment(true), signal(), { initializeVariables: async () => { throw Error('初始值语法有误'); } }), /初始值语法有误/);
    await assert.rejects(readPlayCharacterChat(context, environment(), signal(), { fetchJson: async () => { throw Error('读取错误'); } }), /读取错误/);
});

test('多人设设置关时取第一个；开时选择仅用于本次任务，取消不回退别的人设', async () => {
    const env = environment(true), power = env.tavern.power;
    power.persona_descriptions.chat.connections = [{ id: 'A.png' }];
    const original = structuredClone(power);
    const current = { avatar: 'current', name: '当前人设' };
    let calls = 0;
    const choose = async ids => { calls++; assert.deepEqual(ids, ['bound', 'chat']); return 'chat'; };
    assert.equal((await selectPlayPersona(power, env.character, {}, current, choose)).id, 'bound');
    assert.equal(calls, 0); power.persona_allow_multi_connections = true;
    assert.equal((await selectPlayPersona(power, env.character, {}, current, choose)).id, 'chat');
    assert.equal(calls, 1);
    await assert.rejects(selectPlayPersona(power, env.character, {}, current, async () => null), { name: 'AbortError' });
    delete power.persona_allow_multi_connections; assert.deepEqual(power, original);
});

test('只停止某份任务的资料读取，迟到读取不会进入初始化', async () => {
    const controller = new AbortController(); let finish, initialized = false;
    const pending = resolvePlayCharacterContext(context, environment(), controller.signal, {
        fetchJson: () => new Promise(resolve => { finish = resolve; }),
        initializeVariables: () => { initialized = true; return {}; },
    });
    controller.abort(new DOMException('停止测试', 'AbortError')); finish([]);
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(initialized, false);
});

test('最新聊天正是已打开的当前聊天时保留未保存内容，不额外读聊天文件', async () => {
    const env = environment();
    env.nativeChat = { chatId: 'current', messages: [{ mes: '当前未保存的正文', variables: [{ year: 749 }] }], metadata: { persona: 'chat' } };
    let reads = 0;
    const result = await resolvePlayCharacterContext(context, env, signal(), {
        fetchJson: async url => { reads++; assert.equal(url, '/api/characters/chats'); return [{ file_name: 'current.jsonl' }]; },
        initializeVariables: async () => ({}),
    });
    assert.equal(reads, 1); assert.equal(result.messages[0].mes, '当前未保存的正文'); assert.equal(result.variables.year, 749);
    assert.equal(result.persona.id, 'chat');
});

test('损坏的可选消息变量不阻止读取正常聊天正文', async () => {
    const result = await resolvePlayCharacterContext(context, environment(), signal(), {
        fetchJson: async url => url.endsWith('/chats') ? [{ file_name: 'current.jsonl' }] : [{ mes: '正常正文', variables: ['broken'] }],
        initializeVariables: async () => ({}),
    });
    assert.equal(result.messages[0].mes, '正常正文'); assert.deepEqual(result.variables, {});
});
