// The directory is committed after a complete round file. A failed upload
// therefore never replaces a readable round with half of a new version.
import { playMessageDepths, playMessageIsPending, playUserIdentity, playChatMessageIdentity } from './play-message-context.js';

export const PLAY_HISTORY_INDEX = 'teahouse-play-index.json';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const statuses = ['unfinished', 'complete', 'stopped', 'failed'];
const clone = value => structuredClone(value);
const isText = value => typeof value === 'string' && !!value.trim();
const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isId = value => typeof value === 'string' && idPattern.test(value);
const assert = (condition, message = '演出记录文件格式不正确，未覆盖原文件') => {
    if (!condition) throw new PlayHistoryError('invalid_history', message);
};

export class PlayHistoryError extends Error {
    constructor(code, message, options) { super(message, options); this.name = 'PlayHistoryError'; this.code = code; }
}

export function playRoundFile(id, revision) {
    assert(isId(id) && isId(revision));
    return `teahouse-play-${id}-${revision}.json`;
}

export function playFavoriteFile(id, revision) {
    assert(isId(id) && isId(revision));
    return `teahouse-play-favorite-${id}-${revision}.json`;
}

export function playBodyFile(id, revision) {
    assert(isId(id) && isId(revision));
    return `teahouse-play-body-${id}-${revision}.json`;
}

function readUserIdentity(value) {
    if (value == null) return null;
    assert(isText(value.name) && (value.avatar === null || typeof value.avatar === 'string'));
    return { name: value.name, avatar: value.avatar?.trim() ? value.avatar : null };
}

function legacyUserIdentity(results, createdAt) {
    const result = results?.find(result => result.startedAt === createdAt);
    return playUserIdentity(result?.context);
}

export function readPlayChat(value, { bodyStored = false } = {}) {
    assert(value?.format === 2 && isId(value.id) && isId(value.characterId)
        && isDate(value.createdAt) && typeof value.name === 'string' && value.name.length <= 100
        && Array.isArray(value.messages) && Array.isArray(value.startMessageIds));
    const ids = new Set();
    const messages = value.messages.map((message, index) => {
        assert(isId(message?.id) && !ids.has(message.id) && isDate(message.createdAt));
        ids.add(message.id);
        assert(message.hidden === undefined || typeof message.hidden === 'boolean');
        const visibility = message.hidden === true ? { hidden: true } : {};
        if (message.role === 'user') {
            assert((bodyStored || typeof message.text === 'string') && isId(message.bodyRevision));
            const following = value.messages[index + 1];
            const paired = following?.role === 'assistant' && (following.createdAt === message.createdAt
                || value.startMessageIds.includes(message.id) && value.startMessageIds.includes(following.id));
            const userIdentity = Object.hasOwn(message, 'userIdentity') ? readUserIdentity(message.userIdentity)
                : paired ? legacyUserIdentity(following.results, message.createdAt) : null;
            return { id: message.id, role: 'user', createdAt: message.createdAt, ...visibility,
                ...(message.text !== undefined ? { text: message.text } : {}), bodyRevision: message.bodyRevision, origin: readPlayOrigin(message.origin), userIdentity };
        }
        assert(message.role === 'assistant' && Array.isArray(message.results) && message.results.length > 0);
        const results = message.results.map(result => {
            assert(isId(result.bodyRevision) && !ids.has(result.id));
            ids.add(result.id);
            return { ...readResult(result, bodyStored), bodyRevision: result.bodyRevision };
        });
        assert(results.some(result => result.id === message.selectedResultId));
        return { id: message.id, role: 'assistant', createdAt: message.createdAt, ...visibility,
            selectedResultId: message.selectedResultId, results };
    });
    assert(value.startMessageIds.length <= 2 && value.startMessageIds.every(isId)
        && new Set(value.startMessageIds).size === value.startMessageIds.length);
    const source = value.source == null ? null : { chatId: value.source.chatId, messageId: value.source.messageId };
    if (source) assert(isId(source.chatId) && isId(source.messageId));
    return { format: 2, id: value.id, characterId: value.characterId, createdAt: value.createdAt,
        name: value.name, origin: readPlayOrigin(value.origin), source,
        startMessageIds: [...value.startMessageIds], messages };
}

export function playChatTitle(chat) {
    return chat.name || chat.origin?.title || [...(chat.messages.find(message => message.role === 'user')?.text ?? '')]
        .slice(0, 60).join('') || '未命名聊天';
}

export function playCurrentMessages(chat) {
    return chat.messages.map(message => message.role === 'user' ? { ...message }
        : { id: message.id, role: message.role, createdAt: message.createdAt,
            ...message.results.find(result => result.id === message.selectedResultId), messageId: message.id,
            ...(message.hidden ? { hidden: true } : {}) });
}

// Existing playground APIs expose only the original pair, derived from the
// same chat. This is a view of the data, never a second saved transcript.
export function playStartRound(chat) {
    const messages = chat.startMessageIds.map(id => chat.messages.find(message => message.id === id)).filter(Boolean);
    return { format: 1, id: chat.id, characterId: chat.characterId, createdAt: chat.createdAt,
        origin: chat.origin, prompt: messages.find(message => message.role === 'user')?.text ?? null,
        userIdentity: messages.find(message => message.role === 'user')?.userIdentity ?? null,
        results: (messages.find(message => message.role === 'assistant')?.results ?? []).map(({ bodyRevision, ...result }) => result),
        selectedResultId: messages.find(message => message.role === 'assistant')?.selectedResultId ?? null,
        initialAssistantId: messages.find(message => message.role === 'assistant')?.id ?? null,
        initialUserId: messages.find(message => message.role === 'user')?.id ?? null,
        initialUserHidden: !!messages.find(message => message.role === 'user')?.hidden,
        initialAssistantHidden: !!messages.find(message => message.role === 'assistant')?.hidden,
        initialIsLast: !messages.some(message => message.role === 'assistant') || chat.messages.at(-1)?.id === messages.find(message => message.role === 'assistant')?.id };
}

const startRound = playStartRound;

export function preparePlayGeneration(value, input) {
    const chat = clone(value);
    const context = readPlayContext(input.context);
    const result = { id: input.resultId, startedAt: input.startedAt, finishedAt: null,
        status: 'unfinished', text: '', context, bodyRevision: input.resultBodyRevision };
    const existing = chat.messages.find(message => message.results?.some(result => result.id === input.resultId));
    if (existing && !input.continueResultId) {
        const saved = existing.results.find(result => result.id === input.resultId);
        const user = chat.messages.find(message => message.id === input.userMessageId);
        if (saved.startedAt !== input.startedAt || JSON.stringify(saved.context) !== JSON.stringify(context)
            || input.operation === 'send' && (user?.text !== input.prompt || existing.id !== input.assistantMessageId)) {
            throw new PlayHistoryError('chat_conflict', '当前回复版本已改变，请重新读取后再操作。');
        }
        return chat;
    }
    let assistant;
    if (input.operation === 'send') {
        assert(isText(input.prompt), '请先输入消息');
        if (chat.messages.some(message => playMessageIsPending(message))) {
            throw new PlayHistoryError('chat_busy', '这条聊天正在生成或尚未保存，请结束并保存后再操作。');
        }
        const user = { id: input.userMessageId, role: 'user', text: input.prompt, origin: readPlayOrigin(input.origin),
            createdAt: input.startedAt, bodyRevision: input.userBodyRevision, userIdentity: playUserIdentity(context) };
        assistant = { id: input.assistantMessageId, role: 'assistant', createdAt: input.startedAt,
            results: [result], selectedResultId: result.id };
        chat.messages.push(user, assistant);
        if (!chat.startMessageIds.some(id => chat.messages.some(message => message.id === id))) {
            chat.startMessageIds = [user.id, assistant.id];
        }
    } else {
        assistant = input.chatMode ? chat.messages.at(-1)
            : chat.messages.find(message => chat.startMessageIds.includes(message.id) && message.role === 'assistant');
        if (assistant && (assistant !== chat.messages.at(-1) || input.messageId && assistant.id !== input.messageId)) {
            throw new PlayHistoryError('message_not_last', '只能对聊天末尾的 AI 楼层操作，请先从较早楼层创建分支。');
        }
        if (!chat.messages.some(message => chat.startMessageIds.includes(message.id) && message.role === 'user')) {
            throw new PlayHistoryError('prompt_missing', '这条用户消息已删除，无法使用原提示词生成。');
        }
        if (!assistant) {
            assistant = { id: input.assistantMessageId, role: 'assistant', createdAt: input.startedAt, results: [], selectedResultId: result.id };
            chat.messages.push(assistant);
            chat.startMessageIds = chat.startMessageIds.filter(id => chat.messages.some(message => message.id === id));
            chat.startMessageIds.push(assistant.id);
        }
        const targetId = input.continueResultId ?? input.replaceResultId;
        const target = assistant.results.find(result => result.id === (targetId ?? assistant.selectedResultId));
        if (input.chatMode && targetId && targetId !== assistant.selectedResultId) {
            throw new PlayHistoryError('chat_conflict', '当前回复版本已改变，请重新读取后再操作。');
        }
        if (input.operation === 'continue') {
            if (!target) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
            if (assistant.hidden) throw new PlayHistoryError('message_hidden', '请先显示此楼层再续写。');
            assert(isText(target.text), '这份回复没有正文，无法续写。');
            if (input.expectedText !== undefined && target.text !== input.expectedText) throw new PlayHistoryError('edit_conflict', '这条回复已在其他窗口修改，请重新读取后再续写。');
            Object.assign(target, { status: 'unfinished', finishedAt: null, context }); delete target.error;
        } else {
            if (input.operation === 'regenerate') replaceResult(assistant.results, input.replaceResultId, result);
            else { assert(input.operation === 'another'); assistant.results.push(result); }
            assistant.selectedResultId = result.id;
        }
    }
    return chat;
}

function readFavoriteSource(value) {
    if (value?.type === 'chat') {
        assert(isId(value.chatId));
        return { type: 'chat', chatId: value.chatId };
    }
    if (value?.type === 'manual') {
        assert(isText(value.characterAvatar));
        return { type: 'manual', characterAvatar: value.characterAvatar };
    }
    assert(value && isId(value.roundId) && isId(value.resultId) && isDate(value.startedAt));
    const source = { roundId: value.roundId, resultId: value.resultId, startedAt: value.startedAt };
    if (value.messageId !== undefined) { assert(isId(value.messageId)); source.messageId = value.messageId; }
    return source;
}

function readFavoriteInfo(value) {
    assert(value && isId(value.id) && typeof value.title === 'string' && value.title.length <= 100
        && typeof value.firstLine === 'string' && value.firstLine.length <= 320
        && isText(value.characterName) && isDate(value.savedAt));
    const info = { id: value.id, title: value.title, firstLine: value.firstLine,
        characterName: value.characterName, savedAt: value.savedAt, source: readFavoriteSource(value.source) };
    if (value.frozen !== undefined) { assert(typeof value.frozen === 'boolean'); info.frozen = value.frozen; }
    return info;
}

function readFavorite(value) {
    if (value?.format === 2) {
        assert(value.source?.type === 'chat' && Array.isArray(value.cache) && Array.isArray(value.messages)
            && isDate(value.updatedAt));
        const keys = new Set();
        const cache = value.cache.map(entry => {
            assert(isId(entry.messageId) && isId(entry.bodyRevision) && isId(entry.cacheId) && isId(entry.cacheRevision)
                && (entry.resultId === null || isId(entry.resultId)));
            const key = favoriteCacheKey(entry); assert(!keys.has(key)); keys.add(key);
            return { messageId: entry.messageId, resultId: entry.resultId, bodyRevision: entry.bodyRevision,
                cacheId: entry.cacheId, cacheRevision: entry.cacheRevision };
        });
        const messages = value.messages.map(message => {
            assert(['user', 'assistant'].includes(message.role) && isDate(message.createdAt) && keys.has(favoriteCacheKey(message)));
            return { messageId: message.messageId, resultId: message.resultId, bodyRevision: message.bodyRevision,
                role: message.role, createdAt: message.createdAt,
                ...(typeof message.speakerName === 'string' ? { speakerName: message.speakerName } : {}),
                ...(typeof message.speakerAvatar === 'string' ? { speakerAvatar: message.speakerAvatar } : {}) };
        });
        if (value.sourceRevision !== undefined) assert(isId(value.sourceRevision));
        return { format: 2, ...readFavoriteInfo(value), cache, messages, cleaned: true, updatedAt: value.updatedAt,
            ...(value.sourceRevision ? { sourceRevision: value.sourceRevision } : {}) };
    }
    assert(value?.format === 1 && isText(value.text) && isDate(value.updatedAt));
    const result = { format: 1, ...readFavoriteInfo(value), text: value.text, updatedAt: value.updatedAt };
    if (value.cleaned !== undefined) result.cleaned = Boolean(value.cleaned);
    return result;
}

export function favoriteCacheKey(entry) {
    return `${entry.messageId}/${entry.resultId ?? 'user'}/${entry.bodyRevision}`;
}

export function readPlayOrigin(value) {
    if (value == null) return null;
    assert(isText(value.id) && isText(value.title), '小剧场原文的编号或标题不完整');
    return { id: value.id, title: value.title };
}

// A request's full settings can contain API keys and proxy passwords. Only
// these explanatory fields are allowed into the history, including on retries.
export function readPlayContext(value) {
    assert(value && (isText(value.chatId) || (value.chatId === '' && ['initial', 'latest'].includes(value.chatMode))) && ['tavern', 'custom'].includes(value.apiMode), '本次生成的聊天或 API 信息不完整');
    const result = { chatId: value.chatId, apiMode: value.apiMode };
    if (value.chatMode !== undefined) { assert(['initial', 'latest'].includes(value.chatMode)); result.chatMode = value.chatMode; }
    for (const key of ['characterName', 'presetName', 'model', 'source', 'userName', 'userAvatar']) {
        if (value[key] !== undefined) {
            assert(typeof value[key] === 'string');
            result[key] = value[key];
        }
    }
    return result;
}

// Only native reasoning fields may accompany a result. Never persist response
// objects or the captured settings, which may contain credentials.
export function readPlayReasoning(value) {
    assert(value && typeof value === 'object' && !Array.isArray(value));
    const result = {};
    for (const key of ['reasoning', 'api', 'model']) {
        if (value[key] !== undefined) { assert(typeof value[key] === 'string'); result[key] = value[key]; }
    }
    if (value.reasoning_signature !== undefined) {
        assert(value.reasoning_signature === null || typeof value.reasoning_signature === 'string');
        result.reasoning_signature = value.reasoning_signature;
    }
    if (value.reasoning_duration !== undefined) {
        assert(value.reasoning_duration === null || (Number.isFinite(value.reasoning_duration) && value.reasoning_duration >= 0));
        result.reasoning_duration = value.reasoning_duration;
    }
    return result;
}

function readResult(value, bodyStored = false) {
    assert(value && isId(value.id) && isDate(value.startedAt) && statuses.includes(value.status)
        && (bodyStored || typeof value.text === 'string'));
    assert(value.status === 'unfinished' ? value.finishedAt === null : isDate(value.finishedAt));
    if (value.status === 'complete' && !bodyStored) assert(isText(value.text));
    const result = {
        id: value.id, startedAt: value.startedAt, finishedAt: value.finishedAt,
        status: value.status, ...(value.text !== undefined ? { text: value.text } : {}), context: readPlayContext(value.context),
    };
    if (value.extra !== undefined) result.extra = readPlayReasoning(value.extra);
    if (value.error !== undefined) {
        assert(value.error && isText(value.error.code) && isText(value.error.message));
        result.error = { code: value.error.code, message: value.error.message };
    }
    return result;
}

function replaceResult(results, resultId, replacement) {
    const index = results.findIndex(result => result.id === resultId);
    if (index < 0) throw new PlayHistoryError('result_missing', '这份结果已在其他窗口替换，请重新打开记录后再试。');
    results[index] = replacement;
}

export function readPlayRound(value) {
    assert(value?.format === 1 && isId(value.id) && isId(value.characterId)
        && (value.prompt === null || isText(value.prompt)) && isDate(value.createdAt) && Array.isArray(value.results)
        && (value.prompt !== null || value.results.length > 0));
    const results = value.results.map(result => readResult(result));
    assert(new Set(results.map(result => result.id)).size === results.length);
    return {
        format: 1, id: value.id, characterId: value.characterId, prompt: value.prompt,
        userIdentity: Object.hasOwn(value, 'userIdentity') ? readUserIdentity(value.userIdentity) : legacyUserIdentity(results, value.createdAt),
        origin: readPlayOrigin(value.origin), createdAt: value.createdAt, results,
    };
}

export function readPlayIndex(value) {
    assert(value?.format === 1 && Array.isArray(value.characters) && Array.isArray(value.rounds));
    const characterIds = new Set(), avatars = new Set(), roundIds = new Set();
    const characters = value.characters.map(character => {
        assert(character && isId(character.id) && isText(character.name)
            && (character.avatar === null || isText(character.avatar)) && !characterIds.has(character.id));
        assert(character.avatar === null || !avatars.has(character.avatar));
        characterIds.add(character.id);
        if (character.avatar !== null) avatars.add(character.avatar);
        return { id: character.id, name: character.name, avatar: character.avatar };
    });
    const rounds = value.rounds.map(round => {
        assert(round && isId(round.id) && isId(round.revision) && characterIds.has(round.characterId)
            && isDate(round.createdAt) && isDate(round.lastPlayedAt) && !roundIds.has(round.id));
        roundIds.add(round.id);
        const row = { id: round.id, revision: round.revision, characterId: round.characterId,
            createdAt: round.createdAt, lastPlayedAt: round.lastPlayedAt };
        if (round.kind !== undefined) {
            assert(round.kind === 'chat');
            assert(typeof round.name === 'string' && typeof round.branched === 'boolean');
            row.kind = 'chat'; row.name = round.name; row.branched = round.branched;
            if (round.hasStartPair !== undefined) {
                assert(typeof round.hasStartPair === 'boolean'); row.hasStartPair = round.hasStartPair;
            }
        }
        return row;
    });
    const favoriteIds = new Set();
    assert(value.favorites === undefined || Array.isArray(value.favorites));
    const favorites = (value.favorites ?? []).map(favorite => {
        const info = readFavoriteInfo(favorite);
        assert(isId(favorite.revision) && !favoriteIds.has(info.id));
        favoriteIds.add(info.id);
        return { ...info, revision: favorite.revision };
    });
    return { format: 1, characters, rounds, favorites };
}

function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** readFile returns null only for HTTP 404. Other read failures must throw. */
export function createPlayHistory({ readFile, writeFile, removeFile, enqueueCleanup, withLock = run => run(), uuid = randomId, onWarning = () => {} }) {
    let queue = Promise.resolve();
    let retired = [];
    function retire(names, operation) {
        if (enqueueCleanup) retired.push({ names, operation });
    }
    const bodyCache = new Map();
    let cachedBodyCharacters = 0;
    function dropCachedBody(name) {
        cachedBodyCharacters -= bodyCache.get(name)?.length ?? 0; bodyCache.delete(name);
    }
    function cacheBody(name, text) {
        dropCachedBody(name); bodyCache.set(name, text); cachedBodyCharacters += text.length;
        while (bodyCache.size > 160 || cachedBodyCharacters > 4 * 1024 * 1024) dropCachedBody(bodyCache.keys().next().value);
    }
    async function readBody(id, revision) {
        const name = playBodyFile(id, revision);
        if (bodyCache.has(name)) return bodyCache.get(name);
        const text = await readFile(name);
        if (text === null) throw new PlayHistoryError('body_missing', '这条消息的正文文件缺失，未覆盖原文件');
        let body;
        try { body = JSON.parse(text); }
        catch (cause) { throw new PlayHistoryError('invalid_history', '这条消息的正文文件无法解析，未覆盖原文件', { cause }); }
        assert(body?.format === 1 && body.id === id && body.revision === revision && typeof body.text === 'string');
        cacheBody(name, body.text);
        return body.text;
    }
    async function expandChat(value, startOnly = false) {
        const messages = [];
        for (const message of (value.messages ?? []).filter(message => !startOnly || value.startMessageIds.includes(message.id))) {
            if (message.role === 'user') messages.push({ ...message, text: await readBody(message.id, message.bodyRevision) });
            else {
                const results = [];
                for (const result of message.results ?? []) results.push({ ...result, text: await readBody(result.id, result.bodyRevision) });
                messages.push({ ...message, results });
            }
        }
        return readPlayChat({ ...value, messages });
    }
    function convertRound(round, selectedResultId) {
        const messages = [];
        if (round.prompt !== null) messages.push({ id: uuid(), role: 'user', text: round.prompt,
            origin: round.origin, createdAt: round.createdAt, bodyRevision: uuid(), userIdentity: round.userIdentity });
        if (round.results.length) messages.push({ id: uuid(), role: 'assistant', createdAt: round.createdAt,
            selectedResultId: round.results.some(result => result.id === selectedResultId) ? selectedResultId : round.results.at(-1).id,
            results: round.results.map(result => ({ ...result, bodyRevision: uuid() })) });
        return readPlayChat({ format: 2, id: round.id, characterId: round.characterId, createdAt: round.createdAt,
            name: '', origin: round.origin, source: null, startMessageIds: messages.map(message => message.id), messages });
    }
    const serialize = (run, signal) => {
        signal?.throwIfAborted();
        let stopWaiting = () => {};
        const next = queue.catch(() => {}).then(() => {
            signal?.throwIfAborted();
            return withLock(() => {
                // Cancelling a queued request also prevents its delayed callback
                // from writing. Once a commit starts, let it finish completely.
                signal?.throwIfAborted(); stopWaiting();
                return run();
            }, signal).finally(() => {
                const tasks = retired; retired = [];
                for (const task of tasks) enqueueCleanup(task.names, task.operation);
            });
        });
        queue = next;
        if (!signal) return next;
        return new Promise((resolve, reject) => {
            const abort = () => { stopWaiting(); reject(signal.reason); };
            stopWaiting = () => signal.removeEventListener('abort', abort);
            signal.addEventListener('abort', abort, { once: true });
            next.then(value => { stopWaiting(); resolve(value); }, error => { stopWaiting(); reject(error); });
        });
    };
    async function index() {
        const text = await readFile(PLAY_HISTORY_INDEX);
        if (text === null) return { format: 1, characters: [], rounds: [], favorites: [] };
        try { return readPlayIndex(JSON.parse(text)); }
        catch (error) {
            if (error instanceof PlayHistoryError) throw error;
            throw new PlayHistoryError('invalid_history', '演出记录目录无法解析，未覆盖原文件', { cause: error });
        }
    }
    async function readRoundFromRow(row, retry = true, withChat = false) {
        if (!row) throw new PlayHistoryError('round_missing', '这轮演出记录已不存在');
        const text = await readFile(playRoundFile(row.id, row.revision));
        // Another tab may have committed and cleaned up this revision since
        // our directory read. Retry only when its directory entry has changed.
        if (text === null && retry) {
            const current = (await index()).rounds.find(item => item.id === row.id);
            if (current && current.revision !== row.revision) return readRoundFromRow(current, false, withChat);
        }
        if (text === null) throw new PlayHistoryError('round_missing', '这轮演出记录的正文文件缺失，未覆盖原文件');
        let round;
        try {
            const value = JSON.parse(text);
            if (value.format === 2) {
                const metadata = readPlayChat(value, { bodyStored: true });
                const expanded = await expandChat(metadata, true);
                round = startRound(expanded);
                if (withChat) round.chat = { ...metadata, revision: row.revision, messages: metadata.messages.map(message =>
                    expanded.messages.find(loaded => loaded.id === message.id) ?? message) };
                const initial = value.messages.find(message => value.startMessageIds.includes(message.id) && message.role === 'assistant');
                round.initialIsLast = !initial || value.messages.at(-1)?.id === initial.id;
            } else round = readPlayRound(value);
        }
        catch (cause) {
            if (retry && cause.code === 'body_missing') {
                const current = (await index()).rounds.find(item => item.id === row.id);
                if (current && current.revision !== row.revision) return readRoundFromRow(current, false, withChat);
            }
            throw new PlayHistoryError('invalid_history', '这轮演出记录无法解析，未覆盖原文件', { cause });
        }
        assert(round.id === row.id && round.characterId === row.characterId && round.createdAt === row.createdAt);
        return round;
    }
    async function readChatFromRow(row, retry = true, { bodyStored = false, throughMessageId } = {}) {
        if (!row) throw new PlayHistoryError('chat_missing', '来源聊天已删除');
        const text = await readFile(playRoundFile(row.id, row.revision));
        try {
            if (text === null) throw new PlayHistoryError('body_missing', '聊天文件缺失，未覆盖原文件');
            const value = JSON.parse(text);
            let chat = value.format === 2 ? readPlayChat(value, { bodyStored: true }) : convertRound(readPlayRound(value));
            if (throughMessageId !== undefined) {
                const position = chat.messages.findIndex(message => message.id === throughMessageId && message.role === 'assistant');
                if (position < 0) throw new PlayHistoryError('message_missing', '这条 AI 消息已删除，请重新打开聊天。');
                chat.messages = chat.messages.slice(0, position + 1);
            }
            if (value.format === 2 && !bodyStored) chat = await expandChat(chat);
            assert(chat.id === row.id && chat.characterId === row.characterId && chat.createdAt === row.createdAt);
            return { ...chat, revision: row.revision };
        } catch (cause) {
            if (retry && (text === null || cause.code === 'body_missing')) {
                const current = (await index()).rounds.find(item => item.id === row.id);
                if (current && current.revision !== row.revision) return readChatFromRow(current, false, { bodyStored, throughMessageId });
            }
            if (cause instanceof PlayHistoryError) throw cause;
            throw new PlayHistoryError('invalid_history', '聊天文件无法解析，未覆盖原文件', { cause });
        }
    }
    async function readChatDirectoryContent(id, selectedResultId, search = false, directory) {
        const row = (directory ?? await index()).rounds.find(item => item.id === id);
        if (!row) throw new PlayHistoryError('chat_missing', '来源聊天已删除');
        const text = await readFile(playRoundFile(row.id, row.revision));
        if (text === null) {
            const current = (await index()).rounds.find(item => item.id === id);
            if (current?.revision !== row.revision && current) return readChatDirectoryContent(id, selectedResultId, search);
            throw new PlayHistoryError('body_missing', '聊天文件缺失，请重新读取。');
        }
        let value;
        try { value = JSON.parse(text); }
        catch (cause) { throw new PlayHistoryError('invalid_history', '聊天文件无法解析，未覆盖原文件', { cause }); }
        if (value.format === 1) {
            const round = readPlayRound(value), result = round.results.find(result => result.id === selectedResultId) ?? round.results.at(-1);
            return { id, revision: row.revision, name: round.origin?.title || [...(round.prompt ?? '')].slice(0, 60).join('') || '未命名聊天',
                messages: search ? [round.prompt !== null && { role: 'user', text: round.prompt, messageId: null, context: result?.context },
                    result && { role: 'assistant', text: result.text, messageId: null, context: result.context, depth: 0 }].filter(Boolean)
                    .map(message => ({ ...message, depth: message.role === 'user' ? (result ? 1 : 0) : 0 }))
                    : result ? [{ role: 'assistant', text: result.text, context: result.context, depth: 0 }] : [] };
        }
        const chat = readPlayChat(value, { bodyStored: true });
        const depths = playMessageDepths(chat.messages);
        const messages = search ? chat.messages : [chat.messages.findLast(message => message.role === 'assistant')].filter(Boolean);
        const readable = [];
        for (const message of messages) {
            const result = message.role === 'user' ? message : message.results.find(result => result.id === message.selectedResultId);
            assert(result && isId(result.id) && isId(result.bodyRevision));
            readable.push({ role: message.role, messageId: message.id, hidden: !!message.hidden, depth: depths.get(message), resultId: message.role === 'user' ? null : result.id,
                bodyRevision: result.bodyRevision, text: await readBody(result.id, result.bodyRevision), context: result.context });
        }
        return { id, revision: row.revision, name: row.name || '未命名聊天', messages: readable };
    }
    async function readChatWindow(id, options = {}, retry = true) {
        const row = (await index()).rounds.find(item => item.id === id);
        let chat;
        if (row?.kind === 'chat') chat = await readChatFromRow(row, true, { bodyStored: true });
        else chat = await api.getChat(id, options);
        const total = chat.messages.length, size = 24;
        const anchor = options.anchorId === 'initial-user' || options.anchorId === 'initial-assistant'
            ? chat.messages.find(message => chat.startMessageIds.includes(message.id)
                && message.role === (options.anchorId === 'initial-user' ? 'user' : 'assistant'))?.id : options.anchorId;
        const anchorIndex = chat.messages.findIndex(message => message.id === anchor);
        let end = options.latest ? total : Number.isInteger(options.end) ? Math.max(0, Math.min(total, options.end))
            : anchorIndex < 0 ? total : Math.min(total, anchorIndex + size);
        let start = options.latest ? Math.max(0, total - size) : Number.isInteger(options.start)
            ? Math.max(0, Math.min(end, options.start)) : anchorIndex < 0 ? Math.max(0, end - size) : Math.max(0, anchorIndex - size / 2);
        // Keep metadata for floor numbers, permissions and depth calculations.
        // Only the displayed message bodies cross the storage boundary.
        if (!options.latest && anchorIndex >= 0 && (anchorIndex < start || anchorIndex >= end)) {
            start = Math.max(0, anchorIndex - size / 2); end = Math.min(total, anchorIndex + size);
        }
        try {
            for (const message of chat.messages.slice(start, end)) {
                if (message.role === 'user') {
                    if (message.text === undefined) message.text = await readBody(message.id, message.bodyRevision);
                } else for (const result of message.results) {
                    if (result.id !== message.selectedResultId && message.id !== options.versionsFor) continue;
                    if (result.text === undefined) result.text = await readBody(result.id, result.bodyRevision);
                }
            }
        } catch (error) {
            if (retry && error.code === 'body_missing') {
                const current = (await index()).rounds.find(item => item.id === id);
                if (current && current.revision !== chat.revision) return readChatWindow(id, options, false);
            }
            throw error;
        }
        if (!chat.name && !chat.origin?.title) chat.name = row?.name || '未命名聊天';
        return { chat, start, end };
    }
    async function readFavoriteFromRow(row, retry = true, { start = 0, end = Infinity, metadata = false } = {}) {
        if (!row) throw new PlayHistoryError('favorite_missing', '这份演出记录收藏已不存在');
        const text = await readFile(playFavoriteFile(row.id, row.revision));
        if (text === null && retry) {
            const current = (await index()).favorites.find(item => item.id === row.id);
            if (current && current.revision !== row.revision) return readFavoriteFromRow(current, false, { start, end, metadata });
        }
        if (text === null) throw new PlayHistoryError('favorite_missing', '这份收藏的正文文件缺失，未覆盖原文件');
        let favorite;
        try { favorite = readFavorite(JSON.parse(text)); }
        catch (cause) { throw new PlayHistoryError('invalid_favorite', '这份收藏无法解析，未覆盖原文件', { cause }); }
        assert(JSON.stringify(readFavoriteInfo(favorite)) === JSON.stringify(readFavoriteInfo(row)));
        if (favorite.format === 2) {
            if (metadata) return { ...favorite, revision: row.revision };
            const cache = new Map(favorite.cache.map(entry => [favoriteCacheKey(entry), entry]));
            const messages = [];
            for (const [ordinal, message] of favorite.messages.entries()) {
                const entry = cache.get(favoriteCacheKey(message));
                try { messages.push(ordinal >= start && ordinal < end ? { ...message, text: await readBody(entry.cacheId, entry.cacheRevision) } : message); }
                catch (error) {
                    if (retry && error.code === 'body_missing') {
                        const current = (await index()).favorites.find(item => item.id === row.id);
                        if (current && current.revision !== row.revision) return readFavoriteFromRow(current, false, { start, end, metadata });
                    }
                    throw error;
                }
            }
            return { ...favorite, messages, revision: row.revision };
        }
        return { ...favorite, revision: row.revision };
    }
    async function writeIndex(next) {
        const text = JSON.stringify(readPlayIndex(next));
        try { await writeFile(PLAY_HISTORY_INDEX, text); }
        catch (error) {
            // A dropped response does not prove the server failed to save.
            // Confirm the exact directory before reporting an unsaved result.
            let saved;
            try { saved = await readFile(PLAY_HISTORY_INDEX); }
            catch (verificationError) {
                if (error && typeof error === 'object') error.verificationError = verificationError;
                else onWarning('核实演出目录是否保存', verificationError);
            }
            if (saved !== text) throw error;
            onWarning('保存演出目录时连接报错，已核实文件保存成功', error);
        }
    }
    async function commitDocument(directory, rows, document, fileName, info) {
        const previous = rows.find(item => item.id === document.id);
        const row = { ...info, revision: uuid() };
        await writeFile(fileName(document.id, row.revision), JSON.stringify(document));
        if (previous) rows[rows.indexOf(previous)] = row;
        else rows.push(row);
        await writeIndex(directory);
        // Cleanup is not part of the save transaction. Never remove a revision
        // whose directory commit was not acknowledged or verified.
        if (previous && enqueueCleanup) retire([fileName(previous.id, previous.revision)], '清理演出记录的旧文件');
        else if (previous && removeFile) {
            try { await removeFile(fileName(previous.id, previous.revision)); }
            catch (error) { onWarning('清理演出记录的旧文件', error); }
        }
        return row;
    }
    async function commitRound(directory, value) {
        if (!directory.rounds.some(item => item.id === value.id)) {
            const chat = convertRound(readPlayRound(value));
            await commitChat(directory, chat, value.createdAt);
            return startRound(chat);
        }
        if (directory.rounds.find(item => item.id === value.id)?.kind === 'chat') {
            const chat = await readChatFromRow(directory.rounds.find(item => item.id === value.id));
            const user = chat.messages.find(message => message.id === chat.startMessageIds[0] && message.role === 'user');
            const assistant = chat.messages.find(message => chat.startMessageIds.includes(message.id) && message.role === 'assistant');
            if (user && value.prompt === null) chat.messages = chat.messages.filter(message => message !== user);
            else if (user && user.text !== value.prompt) { user.text = value.prompt; user.bodyRevision = uuid(); }
            if (assistant) {
                const previous = assistant.results;
                if (!value.results.length) chat.messages = chat.messages.filter(message => message !== assistant);
                else {
                    assistant.results = value.results.map(result => ({ ...result,
                        bodyRevision: previous.find(item => item.id === result.id && item.text === result.text)?.bodyRevision ?? uuid() }));
                    if (assistant.results.length > previous.length) assistant.selectedResultId = assistant.results.at(-1).id;
                    if (!assistant.results.some(result => result.id === assistant.selectedResultId)) assistant.selectedResultId = assistant.results.at(-1).id;
                }
            } else if (value.results.length) {
                const message = { id: uuid(), role: 'assistant', createdAt: value.results[0].startedAt,
                    selectedResultId: value.results.at(-1).id, results: value.results.map(result => ({ ...result, bodyRevision: uuid() })) };
                chat.messages.push(message);
                chat.startMessageIds = chat.startMessageIds.filter(id => chat.messages.some(item => item.id === id));
                chat.startMessageIds.push(message.id);
            }
            await commitChat(directory, chat, value.results.reduce((latest, result) => Date.parse(result.startedAt) > Date.parse(latest) ? result.startedAt : latest, chat.createdAt));
            return startRound(chat);
        }
        const round = readPlayRound(value);
        const lastPlayedAt = directory.rounds.find(item => item.id === round.id)?.lastPlayedAt ?? round.createdAt;
        await commitDocument(directory, directory.rounds, round, playRoundFile,
            { id: round.id, characterId: round.characterId, createdAt: round.createdAt,
                lastPlayedAt: round.results.reduce((latest, result) => Date.parse(result.startedAt) > Date.parse(latest) ? result.startedAt : latest, lastPlayedAt) });
        return clone(round);
    }
    async function commitMessageRemoval(directory, round) {
        if (directory.rounds.find(item => item.id === round.id)?.kind === 'chat') return commitRound(directory, round);
        if (round.prompt !== null || round.results.length) return commitRound(directory, round);
        const previous = directory.rounds.find(item => item.id === round.id);
        directory.rounds = directory.rounds.filter(item => item !== previous);
        await writeIndex(directory);
        if (removeFile) {
            try { await removeFile(playRoundFile(previous.id, previous.revision)); }
            catch (error) { onWarning('清理已删除演出的旧文件', error); }
        }
        return null;
    }
    async function commitFavorite(directory, value) {
        const favorite = readFavorite(value);
        const row = await commitDocument(directory, directory.favorites, favorite, playFavoriteFile, readFavoriteInfo(favorite));
        return { ...clone(favorite), revision: row.revision };
    }

    async function updateChatFavorite(directory, chat, favorite, entries, frozen = false) {
        const next = readFavorite(favorite);
        next.sourceRevision = chat.revision;
        const supplied = new Map(entries.map(entry => [favoriteCacheKey(entry), entry]));
        const cached = new Map(next.cache.map(entry => [favoriteCacheKey(entry), entry]));
        const messages = [];
        const character = directory.characters.find(character => character.id === chat.characterId);
        for (const message of chat.messages) {
            const result = message.role === 'user' ? message : message.results.find(result => result.id === message.selectedResultId);
            if (result.status === 'unfinished') continue;
            const identity = { messageId: message.id, resultId: message.role === 'user' ? null : result.id, bodyRevision: result.bodyRevision };
            const key = favoriteCacheKey(identity);
            if (!cached.has(key)) {
                const suppliedEntry = supplied.get(key);
                if (!suppliedEntry || typeof suppliedEntry.text !== 'string') throw new PlayHistoryError('favorite_cache_missing', '收藏正文尚未处理完成，请重新打开后再试。');
                const entry = { ...identity, cacheId: uuid(), cacheRevision: uuid() };
                const file = playBodyFile(entry.cacheId, entry.cacheRevision);
                const text = JSON.stringify({ format: 1, id: entry.cacheId, revision: entry.cacheRevision, text: suppliedEntry.text });
                try { await writeFile(file, text); }
                catch (error) { if (await readFile(file) !== text) throw error; onWarning('保存收藏正文时连接报错，已核实保存成功', error); }
                cacheBody(file, suppliedEntry.text);
                cached.set(key, entry); next.cache.push(entry);
            }
            const userIdentity = playChatMessageIdentity(chat.messages, message);
            messages.push({ ...identity, role: message.role, createdAt: message.createdAt,
                speakerName: message.role === 'user' ? userIdentity.name : character?.name ?? favorite.characterName,
                speakerAvatar: message.role === 'user' ? userIdentity.avatar ?? '' : character?.avatar ?? '' });
        }
        next.messages = messages; next.title = playChatTitle(chat).slice(0, 100); next.frozen = frozen;
        const last = [...messages].reverse().find(message => message.role === 'assistant') ?? messages.at(-1);
        if (last) {
            const entry = cached.get(favoriteCacheKey(last));
            next.firstLine = [...(await readBody(entry.cacheId, entry.cacheRevision)).replace(/\s+/g, ' ')].slice(0, 160).join('');
        } else next.firstLine = '';
        if (JSON.stringify(readFavorite(next)) === JSON.stringify(readFavorite(favorite))) return { ...next, revision: favorite.revision };
        next.updatedAt = new Date().toISOString();
        return commitFavorite(directory, next);
    }

    async function commitChat(directory, value, playedAt) {
        const chat = readPlayChat(value, { bodyStored: true });
        const previous = directory.rounds.find(item => item.id === chat.id);
        let previousDocument;
        if (previous) {
            const text = await readFile(playRoundFile(previous.id, previous.revision));
            if (text === null) throw new PlayHistoryError('body_missing', '聊天文件缺失，未覆盖原文件');
            previousDocument = JSON.parse(text);
        }
        const bodyRefs = document => document?.format === 2 ? document.messages.flatMap(message =>
            message.role === 'user' ? [message] : message.results).map(item => playBodyFile(item.id, item.bodyRevision)) : [];
        const existing = new Set(bodyRefs(previousDocument));
        const document = { ...chat, messages: [] };
        async function saveBody(item) {
            const name = playBodyFile(item.id, item.bodyRevision);
            if (!existing.has(name)) {
                assert(typeof item.text === 'string' && (item.status !== 'complete' || isText(item.text)),
                    '新的消息正文尚未读取，未覆盖原文件');
                const text = JSON.stringify({ format: 1, id: item.id, revision: item.bodyRevision, text: item.text });
                try { await writeFile(name, text); }
                catch (error) { if (await readFile(name) !== text) throw error; onWarning('保存消息时连接报错，已核实正文保存成功', error); }
                cacheBody(name, item.text);
            }
            const { text, ...metadata } = item;
            return metadata;
        }
        for (const message of chat.messages) {
            if (message.role === 'user') document.messages.push(await saveBody(message));
            else {
                const results = [];
                for (const result of message.results) results.push(await saveBody(result));
                document.messages.push({ ...message, results });
            }
        }
        const titleMessage = chat.messages.find(message => message.role === 'user');
        const row = await commitDocument(directory, directory.rounds, document, playRoundFile,
            { id: chat.id, characterId: chat.characterId, createdAt: chat.createdAt, kind: 'chat',
                name: titleMessage && titleMessage.text === undefined
                    && !chat.name && !chat.origin?.title ? previous?.name ?? playChatTitle(chat) : playChatTitle(chat), branched: !!chat.source,
                hasStartPair: chat.messages.some(message => chat.startMessageIds.includes(message.id)),
                lastPlayedAt: playedAt && Date.parse(playedAt) > Date.parse(previous?.lastPlayedAt ?? '')
                    ? playedAt : previous?.lastPlayedAt ?? playedAt ?? chat.createdAt });
        const retained = new Set(bodyRefs(document));
        if (enqueueCleanup) retire([...existing].filter(name => !retained.has(name)), '清理聊天的旧正文文件');
        else if (removeFile) for (const name of existing) {
            if (retained.has(name)) continue;
            try { await removeFile(name); dropCachedBody(name); }
            catch (error) { onWarning('清理聊天的旧正文文件', error); }
        }
        return { ...clone(chat), revision: row.revision };
    }

    function cachedRound(chat) {
        const value = clone(chat);
        for (const message of value.messages) for (const target of message.role === 'user' ? [message] : message.results) {
            if (target.text === undefined) target.text = bodyCache.get(playBodyFile(target.id, target.bodyRevision));
        }
        return startRound(value);
    }

    function assertChatRevision(chat, revision) {
        if (revision !== undefined && chat.revision !== revision) throw new PlayHistoryError('chat_conflict', '这条聊天已在其他窗口改变，请保留草稿并重新读取。');
    }
    function assertChatIdle(chat) {
        assertMessagesIdle(chat.messages);
    }
    function assertMessagesIdle(messages) {
        if (messages.some(message => playMessageIsPending(message))) {
            throw new PlayHistoryError('chat_busy', '这条聊天正在生成或尚未保存，请结束并保存后再操作。');
        }
    }
    async function changeChat(id, expectedRevision, run, { playSelection = false, bodyStored = true, allowPending = false } = {}) {
        assert(isId(id));
        return serialize(async () => {
            const directory = await index();
            const chat = await readChatFromRow(directory.rounds.find(row => row.id === id), true, { bodyStored });
            assertChatRevision(chat, expectedRevision);
            if (!playSelection && !allowPending) assertChatIdle(chat);
            else if (playSelection && !chat.startMessageIds.includes(chat.messages.at(-1)?.id)) {
                throw new PlayHistoryError('message_not_last', '这层已有后续对话，请先创建分支再切换版本。');
            }
            const before = readPlayChat(chat, { bodyStored });
            await run(chat);
            const after = readPlayChat(chat, { bodyStored });
            for (const message of after.messages) for (const target of message.role === 'user' ? [message] : message.results) {
                const previous = before.messages.find(item => item.id === message.id);
                const source = message.role === 'user' ? previous : previous?.results.find(item => item.id === target.id);
                if (source?.text === undefined && source?.bodyRevision === target.bodyRevision) delete target.text;
            }
            if (JSON.stringify(after) === JSON.stringify(before)) return chat;
            return commitChat(directory, chat);
        });
    }

    function beginChat(input, signal) {
        return serialize(async () => {
            const directory = await index();
            let owner = directory.characters.find(character => character.avatar === input.character?.avatar);
            let chat;
            if (input.roundId) {
                chat = await readChatFromRow(directory.rounds.find(row => row.id === input.roundId));
                if (!owner || owner.id !== chat.characterId || input.characterId && owner.id !== input.characterId) {
                    throw new PlayHistoryError('other_character', '这条聊天不属于本次选择的角色，请重新选择角色。');
                }
                if (!chat.messages.some(message => message.results?.some(result => result.id === input.resultId)
                    && !input.continueResultId)) assertChatRevision(chat, input.expectedRevision);
            } else {
                if (input.characterId && owner?.id !== input.characterId) {
                    throw new PlayHistoryError('other_character', '这张角色卡与选择的演出记录不对应，请重新选择角色。');
                }
                if (!owner) {
                    owner = { id: input.ownerId, avatar: input.character.avatar, name: input.character.name };
                    directory.characters.push(owner);
                }
                const row = directory.rounds.find(row => row.id === input.newRoundId);
                chat = row ? await readChatFromRow(row) : { format: 2, id: input.newRoundId, characterId: owner.id,
                    createdAt: input.startedAt, name: '', origin: readPlayOrigin(input.origin), source: null, startMessageIds: [], messages: [] };
            }
            owner.name = input.character.name;
            const next = preparePlayGeneration(chat, input);
            if (JSON.stringify(next) === JSON.stringify(chat)) return chat;
            return commitChat(directory, next, input.startedAt);
        }, signal);
    }

    const api = {
        getChatPreview(id, { selectedResultId } = {}) { assert(isId(id)); return readChatDirectoryContent(id, selectedResultId); },
        getChatSearch(id, { selectedResultId } = {}) { assert(isId(id)); return readChatDirectoryContent(id, selectedResultId, true); },
        async createChatDirectoryReader() {
            const directory = await index();
            return (id, { selectedResultId, search = false } = {}) => readChatDirectoryContent(id, selectedResultId, search, directory);
        },
        getChatWindow(id, options) { assert(isId(id)); return readChatWindow(id, options); },
        async getChatMetadata(id) {
            assert(isId(id)); return readChatFromRow((await index()).rounds.find(row => row.id === id), true, { bodyStored: true });
        },
        getMessageBody(id, revision) { return readBody(id, revision); },
        async listChats(characterId) {
            assert(isId(characterId));
            return (await index()).rounds.filter(row => row.characterId === characterId)
                .sort((a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt));
        },
        async getChat(id, { selectedResultId } = {}) {
            assert(isId(id));
            const row = (await index()).rounds.find(item => item.id === id);
            const chat = await readChatFromRow(row);
            if (row.kind !== 'chat') {
                const assistant = chat.messages.find(message => message.role === 'assistant');
                if (assistant?.results.some(result => result.id === selectedResultId)) assistant.selectedResultId = selectedResultId;
                chat.legacy = true;
            }
            return chat;
        },
        ensureChat(id, { selectedResultId } = {}) {
            assert(isId(id));
            return serialize(async () => {
                const directory = await index(), row = directory.rounds.find(item => item.id === id);
                const chat = await readChatFromRow(row, true, { bodyStored: row?.kind === 'chat' });
                if (row.kind === 'chat') return chat;
                const assistant = chat.messages.find(message => message.role === 'assistant');
                if (assistant?.results.some(result => result.id === selectedResultId)) assistant.selectedResultId = selectedResultId;
                return commitChat(directory, chat);
            });
        },
        createBranch(id, messageId, expectedRevision) {
            assert(isId(id) && isId(messageId));
            return serialize(async () => {
                const directory = await index();
                const source = await readChatFromRow(directory.rounds.find(row => row.id === id), true, { throughMessageId: messageId });
                assertChatRevision(source, expectedRevision);
                const messages = clone(source.messages);
                if (messages.some(message => message.results?.some(result => result.status === 'unfinished'))) {
                    throw new PlayHistoryError('chat_busy', '请在这层回复结束并保存后创建分支。');
                }
                const ids = new Map();
                for (const message of messages) {
                    const original = message.id; message.id = uuid(); ids.set(original, message.id);
                    if (message.role === 'user') message.bodyRevision = uuid();
                    else {
                        for (const result of message.results) {
                            const selected = result.id === message.selectedResultId;
                            result.id = uuid(); result.bodyRevision = uuid();
                            if (selected) message.selectedResultId = result.id;
                        }
                    }
                }
                const now = new Date().toISOString();
                const baseName = playChatTitle(source).replace(/\s*·\s*分支#\d+$/, '');
                const names = new Set(directory.rounds.filter(row => row.characterId === source.characterId).map(row => row.name));
                let name;
                for (let number = 1; ; number++) {
                    const suffix = ` · 分支#${number}`;
                    name = baseName.slice(0, 100 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
                    if (!names.has(name)) break;
                }
                return commitChat(directory, { ...source, id: uuid(), name, createdAt: now,
                    source: { chatId: id, messageId }, startMessageIds: source.startMessageIds.map(id => ids.get(id)).filter(Boolean), messages }, now);
            });
        },
        async setUserIdentity(id, messageId, resultId, identity, { withChat = false } = {}) {
            assert(isId(messageId) && isId(resultId));
            const userIdentity = readUserIdentity(identity);
            assert(userIdentity);
            const chat = await changeChat(id, undefined, chat => {
                const message = chat.messages.find(message => message.id === messageId && message.role === 'user');
                if (!message || message.userIdentity) return;
                const index = chat.messages.indexOf(message), result = chat.messages[index + 1]?.results?.find(result => result.id === resultId);
                if (!result) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                assert(result.status === 'unfinished' && result.startedAt === message.createdAt);
                message.userIdentity = userIdentity;
            }, { allowPending: true });
            const confirmed = chat.messages.find(message => message.id === messageId)?.userIdentity ?? null;
            return withChat ? { identity: confirmed, chat } : confirmed;
        },
        setMessageVersion(id, messageId, resultId, expectedResultId, { playSelection = false } = {}) {
            assert(isId(messageId) && isId(resultId));
            return changeChat(id, undefined, chat => {
                const message = chat.messages.at(-1);
                if (message?.id !== messageId || message.role !== 'assistant') throw new PlayHistoryError('message_not_last', '较早楼层不能切换版本，请从该层创建分支。');
                assert(message.results.some(result => result.id === resultId));
                if (message.selectedResultId === resultId) return;
                if (expectedResultId !== undefined && message.selectedResultId !== expectedResultId) throw new PlayHistoryError('chat_conflict', '回复版本已在其他窗口改变，请重新读取。');
                message.selectedResultId = resultId;
            }, { playSelection });
        },
        renameChat(id, name, expectedRevision) {
            assert(typeof name === 'string' && name.trim().length <= 100, '聊天名称不能超过 100 个字。');
            return changeChat(id, expectedRevision, async chat => {
                chat.name = name.trim();
                const user = chat.messages.find(message => message.role === 'user');
                if (!chat.name && !chat.origin?.title && user && user.text === undefined) user.text = await readBody(user.id, user.bodyRevision);
            }, { bodyStored: true, allowPending: true });
        },
        editMessage(id, messageId, { text, resultId, expectedText }) {
            assert(isId(messageId) && isText(text) && typeof expectedText === 'string', '消息正文不能为空。');
            return changeChat(id, undefined, async chat => {
                const message = chat.messages.find(message => message.id === messageId);
                const target = message?.role === 'user' ? message : message?.results.find(result => result.id === resultId);
                if (!target) throw new PlayHistoryError('message_missing', '这条消息已删除，请保留草稿并重新读取。');
                assertMessagesIdle([message]);
                if (target.text === undefined) target.text = await readBody(target.id, target.bodyRevision);
                if (target.text === text) return;
                if (target.text !== expectedText) throw new PlayHistoryError('edit_conflict', '这条消息已在其他窗口修改，请保留草稿并重新读取。');
                target.text = text; target.bodyRevision = uuid();
            }, { allowPending: true });
        },
        setMessagesHidden(id, messageIds, hidden, expectedRevision) {
            assert(Array.isArray(messageIds) && messageIds.length > 0 && messageIds.every(isId)
                && typeof hidden === 'boolean', '请选择有效的楼层。');
            const targets = new Set(messageIds);
            return changeChat(id, expectedRevision, chat => {
                const messages = chat.messages.filter(message => targets.has(message.id));
                if (messages.length !== targets.size) throw new PlayHistoryError('message_missing', '所选楼层已删除，请重新读取后核对范围。');
                assertMessagesIdle(messages);
                for (const message of messages) {
                    if (hidden) message.hidden = true;
                    else delete message.hidden;
                }
            }, { bodyStored: true, allowPending: true });
        },
        removeMessage(id, messageId, expectedRevision) {
            assert(isId(messageId));
            return changeChat(id, expectedRevision, chat => {
                assertMessagesIdle(chat.messages.filter(message => message.id === messageId));
                chat.messages = chat.messages.filter(message => message.id !== messageId);
            }, { allowPending: true });
        },
        truncateChat(id, messageId, expectedRevision) {
            assert(isId(messageId));
            return changeChat(id, expectedRevision, chat => {
                const position = chat.messages.findIndex(message => message.id === messageId);
                if (position < 0) throw new PlayHistoryError('message_missing', '所选消息已删除，请重新读取。');
                chat.messages = chat.messages.slice(0, position);
            });
        },
        deleteChat(id, expectedRevision, { favoriteEntries = [] } = {}) {
            assert(isId(id));
            return serialize(async () => {
                const directory = await index(), row = directory.rounds.find(item => item.id === id);
                if (!row) return;
                const chat = await readChatFromRow(row);
                assertChatRevision(chat, expectedRevision); assertChatIdle(chat);
                const favoriteRow = directory.favorites.find(item => item.source.type === 'chat' && item.source.chatId === id);
                directory.rounds = directory.rounds.filter(item => item !== row);
                // Freeze and source removal share one acknowledged directory commit.
                if (favoriteRow) await updateChatFavorite(directory, chat, await readFavoriteFromRow(favoriteRow), favoriteEntries, true);
                await writeIndex(directory);
                if (removeFile) {
                    const names = [playRoundFile(row.id, row.revision), ...chat.messages.flatMap(message => message.role === 'user'
                        ? [playBodyFile(message.id, message.bodyRevision)] : message.results.map(result => playBodyFile(result.id, result.bodyRevision)))];
                    for (const name of names) {
                        try { await removeFile(name); dropCachedBody(name); }
                        catch (error) { onWarning('清理已删除聊天的正文文件', error); }
                    }
                }
            });
        },
        async listCharacters() {
            const directory = await index();
            const latest = new Map();
            for (const round of directory.rounds) {
                const previous = latest.get(round.characterId);
                if (!previous || Date.parse(round.lastPlayedAt) > Date.parse(previous)) latest.set(round.characterId, round.lastPlayedAt);
            }
            return directory.characters.map(character => ({ ...character,
                lastPlayedAt: latest.get(character.id) ?? null,
            })).sort((a, b) => (Date.parse(b.lastPlayedAt) || 0) - (Date.parse(a.lastPlayedAt) || 0) || a.id.localeCompare(b.id));
        },
        async listRounds(characterId) {
            assert(isId(characterId));
            const directory = await index();
            return directory.rounds.filter(round => round.characterId === characterId && !round.branched && round.hasStartPair !== false)
                .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        },
        async getRound(id, { withChat = false } = {}) {
            assert(isId(id));
            return readRoundFromRow((await index()).rounds.find(round => round.id === id), true, withChat);
        },
        async createRoundReader({ withChat = false } = {}) {
            const directory = await index();
            return id => readRoundFromRow(directory.rounds.find(row => row.id === id), true, withChat);
        },
        async listFavorites() {
            return (await index()).favorites.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || b.id.localeCompare(a.id));
        },
        async getFavorite(id) {
            assert(isId(id));
            return readFavoriteFromRow((await index()).favorites.find(item => item.id === id));
        },
        async getFavoriteWindow(id, options = {}) {
            assert(isId(id)); return readFavoriteFromRow((await index()).favorites.find(item => item.id === id), true, options);
        },
        addChatFavorite({ chatId, expectedRevision, entries = [] }) {
            assert(isId(chatId));
            return serialize(async () => {
                const directory = await index();
                const chat = await readChatFromRow(directory.rounds.find(row => row.id === chatId));
                assertChatRevision(chat, expectedRevision); assertChatIdle(chat);
                const previous = directory.favorites.find(row => row.source.type === 'chat' && row.source.chatId === chatId);
                if (previous) return readFavoriteFromRow(previous);
                const now = new Date().toISOString();
                const favorite = { format: 2, id: uuid(), source: { type: 'chat', chatId }, title: '', firstLine: '',
                    characterName: directory.characters.find(character => character.id === chat.characterId).name,
                    frozen: false, cache: [], messages: [], savedAt: now, updatedAt: now };
                const next = await updateChatFavorite(directory, chat, favorite, entries);
                if (!directory.favorites.some(row => row.id === next.id)) return commitFavorite(directory, next);
                return next;
            });
        },
        syncChatFavorite(id, { chatRevision, entries = [] }) {
            assert(isId(id));
            return serialize(async () => {
                const directory = await index();
                const favorite = await readFavoriteFromRow(directory.favorites.find(row => row.id === id), true, { metadata: true });
                assert(favorite.format === 2);
                if (favorite.frozen) return favorite;
                const chat = await readChatFromRow(directory.rounds.find(row => row.id === favorite.source.chatId), true, { bodyStored: true });
                assertChatRevision(chat, chatRevision);
                return updateChatFavorite(directory, chat, favorite, entries);
            });
        },
        addFavorite({ roundId, messageId, resultId, startedAt, expectedText, text, firstLine }) {
            const source = readFavoriteSource({ roundId, resultId, startedAt, ...(messageId ? { messageId } : {}) });
            assert(typeof expectedText === 'string' && typeof firstLine === 'string');
            if (text !== undefined) assert(isText(text), '收藏内容不能为空。');
            return serialize(async () => {
                const directory = await index();
                const row = directory.rounds.find(item => item.id === roundId);
                const chat = row?.kind === 'chat' ? await readChatFromRow(row) : null;
                const round = chat ? startRound(chat) : await readRoundFromRow(row);
                const result = chat ? chat.messages.flatMap(message => message.results ?? []).find(result => result.id === resultId)
                    : round.results.find(item => item.id === resultId);
                if (!result) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                assert(result.status !== 'unfinished' && isText(result.text), '请在这份回复结束并保存后收藏');
                if (result.startedAt !== startedAt || result.text !== expectedText) {
                    throw new PlayHistoryError('favorite_conflict', '这条回复已在其他窗口修改，请重新打开记录后收藏。');
                }
                const previous = directory.favorites.find(item => item.source.roundId === roundId && item.source.resultId === resultId && item.source.startedAt === startedAt);
                if (previous) return readFavoriteFromRow(previous);
                const now = new Date().toISOString();
                const favoriteText = text !== undefined ? text : result.text;
                return commitFavorite(directory, { format: 1, id: uuid(), source,
                    characterName: directory.characters.find(item => item.id === round.characterId).name,
                    title: round.origin?.title ?? '', firstLine, text: favoriteText,
                    cleaned: text !== undefined, savedAt: now, updatedAt: now });
            });
        },
        addManualFavorite({ character, title, text, firstLine }) {
            assert(isText(character?.avatar) && isText(character?.name), '请选择一张仍然存在的角色卡。');
            assert(typeof title === 'string' && title.trim().length <= 100, '收藏标题不能超过 100 个字。');
            assert(isText(text), '收藏内容不能为空。');
            const input = readFavorite({ format: 1, id: uuid(), title: title.trim(), text, firstLine,
                characterName: character.name, source: { type: 'manual', characterAvatar: character.avatar },
                cleaned: true, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            return serialize(async () => commitFavorite(await index(), input));
        },
        editFavorite(id, update, expectedRevision) {
            assert(isId(id) && isId(expectedRevision) && typeof update?.title === 'string' && typeof update?.firstLine === 'string');
            assert(isText(update.text), '收藏内容不能为空。');
            const patch = clone(update);
            return serialize(async () => {
                const directory = await index();
                const row = directory.favorites.find(item => item.id === id);
                const current = await readFavoriteFromRow(row);
                if (current.format === 2) throw new PlayHistoryError('favorite_readonly', '整条聊天收藏只供阅读，请前往分支修改消息。');
                const next = readFavorite({ ...current, title: patch.title.trim(), text: patch.text, firstLine: patch.firstLine, cleaned: true });
                if (next.title === current.title && next.text === current.text && next.firstLine === current.firstLine && next.cleaned === current.cleaned) return current;
                if (row.revision !== expectedRevision) {
                    throw new PlayHistoryError('favorite_edit_conflict', '这份收藏已在其他窗口修改。请保留当前草稿，重新打开后核对内容。');
                }
                next.updatedAt = new Date().toISOString();
                return commitFavorite(directory, next);
            });
        },
        removeFavorite(id) {
            assert(isId(id));
            return serialize(async () => {
                const directory = await index();
                const previous = directory.favorites.find(item => item.id === id);
                if (!previous) return;
                const favoriteCacheFiles = previous.source.type === 'chat'
                    ? (await readFavoriteFromRow(previous)).cache.map(entry => playBodyFile(entry.cacheId, entry.cacheRevision)) : [];
                directory.favorites = directory.favorites.filter(item => item !== previous);
                await writeIndex(directory);
                if (removeFile) {
                    try { await removeFile(playFavoriteFile(previous.id, previous.revision)); }
                    catch (error) { onWarning('清理已取消收藏的旧文件', error); }
                    if (previous.source.type === 'chat') {
                        // Read the immutable old document to clean only this favorite's cache.
                        // Its source chat bodies have separate IDs and are never removed here.
                        for (const name of favoriteCacheFiles) {
                            try { await removeFile(name); dropCachedBody(name); }
                            catch (error) { onWarning('清理已取消聊天收藏的正文', error); }
                        }
                    }
                }
            });
        },
        begin(input, { signal } = {}) {
            const value = clone(input);
            assert(isText(value.character?.avatar) && isText(value.character?.name));
            assert(isId(value.resultId) && isDate(value.startedAt));
            value.context = readPlayContext(value.context);
            value.operation ??= value.continueResultId ? 'continue' : value.replaceResultId ? 'regenerate' : value.roundId ? 'another' : 'send';
            value.newRoundId ??= uuid(); value.ownerId ??= uuid();
            value.userMessageId ??= uuid(); value.assistantMessageId ??= uuid();
            value.resultBodyRevision ??= uuid(); value.userBodyRevision ??= uuid();
            for (const key of ['newRoundId', 'ownerId', 'userMessageId', 'assistantMessageId', 'resultBodyRevision', 'userBodyRevision']) assert(isId(value[key]));
            if (value.roundId !== undefined) assert(isId(value.roundId));
            const begin = value.roundId ? api.ensureChat(value.roundId).then(() => beginChat(value, signal)) : beginChat(value, signal);
            return begin.then(chat => value.returnChat || value.chatMode ? chat : startRound(chat));
        },
        saveResult(roundId, resultId, update, { withChat = false } = {}) {
            assert(isId(roundId) && isId(resultId));
            const patch = clone(update);
            return serialize(async () => {
                const directory = await index();
                const row = directory.rounds.find(item => item.id === roundId);
                if (!row) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                if (row.kind === 'chat') {
                    // Checkpoints touch only the active body. Older bodies are
                    // referenced by their immutable revisions, not re-downloaded.
                    const documentText = await readFile(playRoundFile(row.id, row.revision));
                    if (documentText === null) throw new PlayHistoryError('body_missing', '聊天文件缺失，未覆盖原文件');
                    const document = JSON.parse(documentText);
                    const chat = readPlayChat(document, { bodyStored: true });
                    const message = chat.messages.find(message => message.results?.some(result => result.id === resultId));
                    const result = message?.results.find(result => result.id === resultId);
                    if (!result) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                    const savedView = saved => {
                        for (const message of chat.messages) for (const item of message.role === 'user' ? [message] : message.results) {
                            if (item.text === undefined) item.text = bodyCache.get(playBodyFile(item.id, item.bodyRevision));
                        }
                        const view = document.startMessageIds.includes(message.id) ? cachedRound(chat)
                            : { id: roundId, characterId: chat.characterId, savedResult: readResult(saved) };
                        return withChat ? { ...view, chat: clone(chat), revision: chat.revision ?? row.revision } : view;
                    };
                    result.text = await readBody(result.id, result.bodyRevision);
                    const next = { ...readResult({ ...result, ...patch, id: result.id, startedAt: result.startedAt,
                        context: patch.context ? { ...result.context, ...readPlayContext(patch.context) } : result.context }), bodyRevision: result.bodyRevision };
                    assert((next.context.chatId === result.context.chatId || (result.context.chatId === '' && result.context.chatMode === 'latest' && next.context.chatMode === 'latest'))
                        && next.context.apiMode === result.context.apiMode && next.context.characterName === result.context.characterName
                        && next.context.chatMode === result.context.chatMode, '保存结果时不能更换它所属的聊天或 API 选择');
                    if (result.status !== 'unfinished') {
                        if (next.status === 'unfinished' || JSON.stringify(readResult(next)) === JSON.stringify(readResult(result))) return savedView(result);
                        throw new PlayHistoryError('result_finished', '这份结果已结束，不能覆盖；请通过重新生成替换当前结果');
                    }
                    if (JSON.stringify(readResult(next)) === JSON.stringify(readResult(result))) return savedView(result);
                    if (next.text !== result.text) next.bodyRevision = uuid();
                    message.results[message.results.indexOf(result)] = next;
                    const committed = await commitChat(directory, chat);
                    chat.revision = committed.revision;
                    return savedView(next);
                }
                const round = await readRoundFromRow(row);
                const result = round.results.find(item => item.id === resultId);
                if (!result) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                const next = readResult({ ...result, ...patch, id: result.id, startedAt: result.startedAt,
                    context: patch.context ? { ...result.context, ...readPlayContext(patch.context) } : result.context });
                assert((next.context.chatId === result.context.chatId || (result.context.chatId === '' && result.context.chatMode === 'latest' && next.context.chatMode === 'latest')) && next.context.apiMode === result.context.apiMode
                    && next.context.characterName === result.context.characterName && next.context.chatMode === result.context.chatMode, '保存结果时不能更换它所属的聊天或 API 选择');
                // A delayed streaming checkpoint must never replace a finished
                // result. An identical terminal write is a harmless save retry.
                if (result.status !== 'unfinished') {
                    if (next.status === 'unfinished' || JSON.stringify(next) === JSON.stringify(result)) return clone(round);
                    throw new PlayHistoryError('result_finished', '这份结果已结束，不能覆盖；请通过重新生成替换当前结果');
                }
                if (JSON.stringify(next) === JSON.stringify(result)) return clone(round);
                round.results[round.results.indexOf(result)] = next;
                return commitRound(directory, round);
            });
        },
        async editPrompt(roundId, text, expectedText) {
            const chat = await api.ensureChat(roundId);
            const user = chat.messages.find(message => chat.startMessageIds.includes(message.id) && message.role === 'user');
            if (!user) throw new PlayHistoryError('prompt_missing', '这条用户消息已删除。请保留当前草稿，重新打开记录后核对。');
            return cachedRound(await api.editMessage(roundId, user.id, { text, expectedText }));
        },
        async editResult(roundId, resultId, text, expectedText) {
            const chat = await api.ensureChat(roundId);
            const assistant = chat.messages.find(message => chat.startMessageIds.includes(message.id) && message.results?.some(result => result.id === resultId));
            if (!assistant) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
            return cachedRound(await api.editMessage(roundId, assistant.id, { text, resultId, expectedText }));
        },
        removePrompt(roundId, expectedText) {
            assert(isId(roundId) && typeof expectedText === 'string');
            return serialize(async () => {
                const directory = await index(), row = directory.rounds.find(item => item.id === roundId);
                if (!row) return null;
                const round = await readRoundFromRow(row);
                if (round.prompt === null) return clone(round);
                if (round.prompt !== expectedText) throw new PlayHistoryError('delete_conflict', '这条用户消息已在其他窗口修改，请重新打开记录后再删除。');
                round.prompt = null;
                return commitMessageRemoval(directory, round);
            });
        },
        removeReply(roundId, expectedResults) {
            assert(isId(roundId) && Array.isArray(expectedResults)
                && expectedResults.every(result => isId(result?.id) && typeof result.text === 'string'));
            const expected = expectedResults.map(({ id, text }) => ({ id, text }));
            return serialize(async () => {
                const directory = await index(), row = directory.rounds.find(item => item.id === roundId);
                if (!row) return null;
                const round = await readRoundFromRow(row);
                if (!round.results.length) return clone(round);
                if (round.results.length !== expected.length || round.results.some((result, index) =>
                    result.id !== expected[index].id || result.text !== expected[index].text)) {
                    throw new PlayHistoryError('delete_conflict', '这条 AI 消息的内容或生成版本已在其他窗口改变，请重新打开记录后再删除。');
                }
                round.results = [];
                return commitMessageRemoval(directory, round);
            });
        },
        renameCharacter(oldAvatar, newAvatar, name) {
            assert(isText(oldAvatar) && (newAvatar === null || isText(newAvatar)));
            return serialize(async () => {
                const directory = await index();
                const character = directory.characters.find(item => item.avatar === oldAvatar);
                if (!character) return;
                if (newAvatar !== null && directory.characters.some(item => item !== character && item.avatar === newAvatar)) {
                    throw new PlayHistoryError('character_conflict', '改名后的角色头像标识已属于另一份游玩历史，未合并记录');
                }
                character.avatar = newAvatar;
                if (isText(name)) character.name = name;
                await writeIndex(directory);
            });
        },
    };
    return api;
}
