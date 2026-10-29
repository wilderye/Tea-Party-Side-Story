import { PlaygroundError } from './playground.js';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

/** Read the selected swipe, walking backwards past messages without variables. */
export function readLatestPlayVariables(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.is_system || message.variables === undefined) continue;
        const value = message.variables?.[message.swipe_id ?? 0];
        if (value === undefined || value === null) continue;
        if (!isRecord(value)) throw new PlaygroundError('invalid_message_variables', '目标聊天保存的消息变量格式不正确，本次没有发送。');
        if (Object.keys(value).length) return clone(value);
    }
    return null;
}

/** Same most-recent-first ordering as Tavern's chat list. */
export function selectLatestPlayChat(rows, timestamp = value => Date.parse(value)) {
    return Object.values(rows ?? {}).filter(row => typeof row?.file_name === 'string')
        .sort((left, right) => (Number(timestamp(right.last_mes)) || 0) - (Number(timestamp(left.last_mes)) || 0))[0] ?? null;
}

export async function readPlayCharacterChat(context, environment, signal, { fetchJson, timestamp } = {}) {
    if (environment.noChat) return { chatId: '', messages: [], metadata: {} };
    const post = fetchJson ?? (async (url, body) => {
        const response = await fetch(url, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body), signal });
        if (!response.ok) throw new PlaygroundError('target_chat_read_failed', '目标角色的聊天读取失败，请重试。');
        const result = await response.json();
        if (result?.error) throw new PlaygroundError('target_chat_read_failed', '目标角色的聊天读取失败，请重试。');
        return result;
    });
    signal.throwIfAborted();
    const rows = await post('/api/characters/chats', { avatar_url: environment.character.avatar });
    signal.throwIfAborted();
    const latest = selectLatestPlayChat(rows, timestamp);
    if (!latest) return { chatId: '', messages: [], metadata: {} };
    const chatId = latest.file_name.replace(/\.jsonl$/i, '');
    if (environment.nativeChat?.chatId === chatId) {
        return { chatId, messages: clone(environment.nativeChat.messages), metadata: clone(environment.nativeChat.metadata) };
    }
    const saved = await post('/api/chats/get', { avatar_url: environment.character.avatar, file_name: chatId });
    signal.throwIfAborted();
    if (!Array.isArray(saved)) throw new PlaygroundError('target_chat_read_failed', '目标角色的聊天返回格式不正确，本次没有发送。');
    const messages = saved.filter(message => typeof message?.mes === 'string');
    if (!messages.length) return { chatId: '', messages: [], metadata: {} };
    const header = saved.find(message => typeof message?.mes !== 'string');
    return { chatId, messages: clone(messages), metadata: clone(header?.chat_metadata ?? {}) };
}

export async function selectPlayPersona(power, character, metadata, current, choose) {
    const descriptions = power.persona_descriptions ?? {}, names = power.personas ?? {};
    const valid = id => id && Object.hasOwn(names, id);
    let id = valid(metadata.persona) ? metadata.persona : null;
    if (!id) {
        const connections = Object.entries(descriptions).filter(([, value]) => value?.connections?.some(connection => connection.id === character.avatar)).map(([key]) => key).filter(valid);
        if (connections.length > 1 && power.persona_allow_multi_connections) {
            id = await choose(connections, character);
            if (!id) throw new DOMException('已取消本次用户设定选择', 'AbortError');
            if (!connections.includes(id)) throw new PlaygroundError('invalid_persona_selection', '选择的用户设定已不属于目标角色，请重试。');
        } else id = connections[0] ?? null;
    }
    id ??= valid(power.default_persona) ? power.default_persona : current.avatar;
    const descriptor = descriptions[id];
    // The currently selected persona may have unsaved description edits.
    const own = id === current.avatar;
    return { id, name: names[id] ?? current.name ?? 'User', power: {
        ...power,
        persona_description: own ? power.persona_description ?? '' : descriptor?.description ?? '',
        persona_description_position: own ? power.persona_description_position : descriptor?.position ?? 0,
        persona_description_depth: own ? power.persona_description_depth : descriptor?.depth ?? 2,
        persona_description_role: own ? power.persona_description_role : descriptor?.role ?? 0,
        persona_description_lorebook: own ? power.persona_description_lorebook : descriptor?.lorebook ?? '',
    } };
}

/** Resolve only this task's card/chat/persona. No host state is changed. */
export async function resolvePlayCharacterContext(context, environment, signal, dependencies) {
    const chat = await readPlayCharacterChat(context, environment, signal, dependencies);
    const persona = await (dependencies.selectPersona ?? selectPlayPersona)(environment.tavern.power, environment.character, chat.metadata,
        { avatar: environment.tavern.userAvatar, name: environment.tavern.name1 }, dependencies.choosePersona);
    signal.throwIfAborted();
    let saved = null;
    try { saved = readLatestPlayVariables(chat.messages); }
    catch { /* Unreadable optional variables leave macros intact; chat text is still valid. */ }
    const variables = saved ?? await dependencies.initializeVariables(environment, persona, signal, chat);
    signal.throwIfAborted();
    if (!isRecord(variables)) throw new PlaygroundError('invalid_initial_variables', '目标角色的初始变量处理结果不正确，本次没有发送。');
    return { ...chat, persona, variables: clone(variables), variableSource: saved ? 'latest' : 'initial' };
}
