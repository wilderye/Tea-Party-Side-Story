import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePlayPreset } from '../play-preset.js';
import { DEFAULT_CONTINUE_PROMPTS } from '../play-settings.js';

test('分支请求在预设关闭聊天记录时明确拒绝，不发送缺少整段对话的请求', async () => {
    const f = fixture(); f.environment.branchMode = true; f.prompts.collection = [];
    await assert.rejects(f.prepare(), { code: 'branch_history_disabled' });
});

function fixture(settings = {}) {
    class MessageCollection {
        constructor(identifier) { this.identifier = identifier; this.messages = []; }
        add(message) { this.messages.push(message); }
    }
    class ChatCompletion {
        constructor() { this.groups = new Map(); }
        setTokenBudget() {} reserveBudget() {} freeBudget() {} setOverriddenPrompts() {}
        add(group) { this.groups.set(group.identifier, group); }
        has(id) { return this.groups.has(id); }
        canAfford() { return true; } canAffordAll() { return true; }
        insertAtStart(message, id) { this.groups.get(id).messages.unshift(message); }
        insert(message, id) { this.groups.get(id).messages.push(message); }
        getChat() { return [...this.groups.values()].flatMap(group => group.messages).filter(message => message.content); }
    }
    const prompts = {
        collection: [{ identifier: 'chatHistory' }], overriddenPrompts: [],
        get(id) { return this.collection.find(item => item.identifier === id); },
        index(id) { return this.collection.findIndex(item => item.identifier === id); },
        has(id) { return this.index(id) >= 0; },
        add(prompt) { this.collection.push(prompt); },
    };
    const modules = {
        openai: { MessageCollection, ChatCompletion,
            Message: { createAsync: async (role, _content, identifier) => ({ role, identifier, tokens: 1 }) },
            promptManager: { activeCharacter: {}, tokenHandler: { countAsync: async () => 1 },
                preparePrompt: prompt => ({ ...prompt }), getPromptCollection: () => prompts,
                isPromptDisabledForActiveCharacter: () => false, sanitizeName: name => name },
            getPromptPosition: () => undefined, getPromptRole: role => role },
        core: { substituteParams: text => text, extension_prompt_types: { IN_CHAT: 1 } },
        persona: { persona_description_positions: {} }, constants: { IGNORE_SYMBOL: 'ignore' },
    };
    const environment = { tavern: { settings: { openai_max_context: 8000, openai_max_tokens: 1000, names_behavior: 1, ...settings },
        power: {}, name1: 'User', name2: 'Character', model: 'test', canUseTools: false } };
    const options = {
        type: 'continue', cyclePrompt: '原回复，',
        extensionPrompts: { tail: { value: '插入的助手指令', position: 1, depth: 0, role: 'assistant' } },
        history: [{ name: 'User', is_user: true, mes: '提示词', extra: {} },
            { name: 'Character', is_user: false, mes: '原回复，', extra: {} }], messageExamples: [], toolsData: {},
    };
    return { environment, options, prompts, async prepare() {
        return (await preparePlayPreset({ eventSource: { emit: async () => {} }, eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'ready' } },
            modules, environment, options))[0];
    } };
}

test('普通续写跳过末尾插入的 assistant 指令，将原消息与续写提示放在末尾', async () => {
    const chat = await fixture({ continue_nudge_prompt: '接着写：{{lastChatMessage}}' }).prepare();
    assert.deepEqual(chat.map(message => message.content), ['提示词', '插入的助手指令', '原回复，', DEFAULT_CONTINUE_PROMPTS.history]);
    assert.equal(chat.at(-2).name, undefined, '普通续写沿用酒馆省略消息 name 的处理');
});

test('续写固定使用 nudge，不受酒馆预填开关影响', async () => {
    for (const source of ['claude', 'openai']) {
        const chat = await fixture({ continue_prefill: true, chat_completion_source: source,
            assistant_prefill: '预填前缀', continue_nudge_prompt: '接着写：{{lastChatMessage}}' }).prepare();
        assert.deepEqual(chat.map(message => message.content), ['提示词', '插入的助手指令', '原回复，', DEFAULT_CONTINUE_PROMPTS.history]);
        assert.equal(chat.at(-1).identifier, 'continueNudge');
    }
});

test('酒馆续写提示词的内容不覆盖小剧场默认值，设置副本保持原值', async () => {
    for (const continueNudge of [undefined, null, '', ' \n\t ']) {
        const f = fixture({ continue_prefill: true, continue_nudge_prompt: continueNudge });
        const originalSettings = structuredClone(f.environment.tavern.settings);
        const chat = await f.prepare();
        assert.equal(chat.at(-2).content, '原回复，');
        assert.equal(chat.at(-1).role, 'system');
        assert.equal(chat.at(-1).content, DEFAULT_CONTINUE_PROMPTS.history);
        assert.deepEqual(f.environment.tavern.settings, originalSettings);
    }
});

test('续写保留酒馆的空消息替代文字设置', async () => {
    const f = fixture({ send_if_empty: '继续', continue_nudge_prompt: '酒馆的续写指令' });
    f.environment.continuation = { mode: 'history', prompt: '接着写' };
    const chat = await f.prepare();
    assert.deepEqual(chat.map(message => message.content), ['提示词', '插入的助手指令', '继续', '原回复，', '接着写']);
});

test('第二种移除独立 AI 消息，在底部用户消息中先放续写提示词、思维链再放保存原正文', async () => {
    const f = fixture();
    f.environment.continuation = { mode: 'prompt', prompt: '接着下面写：\n{{lastChatMessage}}' };
    f.options.cyclePrompt = '原回复，【保存原文】$&';
    f.options.cycleReasoning = '<think>目标思维链</think>\n';
    f.options.history.at(-1).mes = '<think>目标思维链</think>\n正则处理后的正文';
    const before = structuredClone(f.options.history);
    const chat = await f.prepare();
    assert.deepEqual(chat.map(message => message.content), ['提示词', '插入的助手指令',
        '接着下面写：\n<think>目标思维链</think>\n原回复，【保存原文】$&']);
    assert.equal(chat.at(-1).role, 'user');
    assert.deepEqual(f.options.history, before, '只改变请求副本，不删除保存的消息');
});

test('第一种保留连在一起的思维链和处理后正文，系统指令不重复正文', async () => {
    const f = fixture();
    f.options.history.at(-1).mes = '<think>目标思维链</think>\n原回复，';
    const chat = await f.prepare();
    assert.equal(chat.at(-2).role, 'assistant');
    assert.equal(chat.at(-2).content, '<think>目标思维链</think>\n原回复，');
    assert.equal(chat.at(-1).content, DEFAULT_CONTINUE_PROMPTS.history);
    assert.equal(chat.filter(message => message.content.includes('原回复，')).length, 1);
});

for (const mode of ['history', 'prompt']) test(`关闭原生思维链发送时不带签名，正文 CoT 与占位符保留：方式=${mode}`, async () => {
    const f = fixture({ chat_completion_source: 'openrouter' });
    f.environment.continuation = { mode, prompt: '接着写：\n{{lastchatmessage}}', sendReasoning: false };
    f.environment.tavern.reasoningSignatureSupported = true;
    const body = '<thinking>正文 CoT</thinking>\n剧情';
    f.options.cyclePrompt = body;
    f.options.history.at(-1).mes = body;
    f.options.history.at(-1).extra = { reasoning: '原生思维链', reasoning_signature: 'synthetic-signature', api: 'openrouter', model: 'test' };
    const before = structuredClone(f.options.history);
    const chat = await f.prepare();
    assert.equal(chat.at(-1).content, '接着写：\n' + body);
    assert.equal(chat.at(-1).role, mode === 'prompt' ? 'user' : 'system');
    if (mode === 'history') assert.equal(chat.at(-2).content, body);
    else assert.equal(chat.filter(message => message.content.includes(body)).length, 1);
    assert.ok(chat.every(message => !message.signature));
    assert.doesNotMatch(JSON.stringify(chat), /原生思维链|synthetic-signature/);
    assert.deepEqual(f.options.history, before, '只控制发送，保留原文与原生思维链');
});

test('第二种拒绝缺少占位符的提示词，接受大小写不同的占位符', async () => {
    const f = fixture();
    f.environment.continuation = { mode: 'prompt', prompt: '接着写' };
    await assert.rejects(f.prepare(), error => error.code === 'invalid_continue_prompt');
    f.environment.continuation.prompt = '接着写：{{LASTCHATMESSAGE}}';
    assert.equal((await f.prepare()).at(-1).content, '接着写：原回复，');
});

test('第一种只向支持且 API 和模型相同的 AI 消息传递原生签名', async () => {
    for (const same of [true, false]) {
        const f = fixture({ chat_completion_source: 'openrouter' });
        f.environment.tavern.reasoningSignatureSupported = true;
        f.options.history.at(-1).extra = { api: 'openrouter', model: same ? 'test' : 'other', reasoning_signature: 'synthetic-signature' };
        assert.equal((await f.prepare()).at(-2).signature, same ? 'synthetic-signature' : undefined);
    }
});
