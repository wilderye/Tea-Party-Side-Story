import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePlayPreset } from '../play-preset.js';

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
    return { async prepare() {
        return (await preparePlayPreset({ eventSource: { emit: async () => {} }, eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'ready' } },
            modules, environment, options))[0];
    } };
}

test('普通续写跳过末尾插入的 assistant 指令，将原消息与续写提示放在末尾', async () => {
    const chat = await fixture({ continue_nudge_prompt: '接着写：{{lastChatMessage}}' }).prepare();
    assert.deepEqual(chat.map(message => message.content), ['提示词', '插入的助手指令', '原回复，', '接着写：原回复，']);
    assert.equal(chat.at(-2).name, undefined, '普通续写沿用酒馆省略消息 name 的处理');
});

test('续写预填在插入深度指令前取出原消息，Claude 前缀只拼接一次且不附加续写提示', async () => {
    for (const source of ['claude', 'openai']) {
        const chat = await fixture({ continue_prefill: true, chat_completion_source: source, assistant_prefill: '预填前缀' }).prepare();
        assert.deepEqual(chat.map(message => message.content), ['提示词', '插入的助手指令',
            source === 'claude' ? '预填前缀\n\n原回复，' : '原回复，']);
        assert.equal(chat.at(-1).identifier, 'continuePrefill');
    }
});

test('续写保留酒馆的空消息替代文字设置', async () => {
    const chat = await fixture({ send_if_empty: '继续', continue_nudge_prompt: '接着写' }).prepare();
    assert.deepEqual(chat.map(message => message.content), ['提示词', '插入的助手指令', '继续', '原回复，', '接着写']);
});
