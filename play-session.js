import { PlayHistoryError, playStartRound, playChatTitle, preparePlayGeneration } from './play-history.js';
import { playMessageDepths } from './play-message-context.js';

const clone = value => structuredClone(value);

export function createPlaySession(history, { onSaveError = () => {}, onChange = () => {} } = {}) {
    const chats = new Map(), owners = new Map();
    let sequence = 0;
    const saveErrors = new WeakSet();
    function prune(currentId) {
        let characters = 0;
        for (const item of chats.values()) for (const message of item.chat?.messages ?? []) {
            characters += (message.text?.length ?? 0) + (message.results ?? []).reduce((total, result) => total + (result.text?.length ?? 0), 0);
        }
        for (const [id, item] of chats) {
            if (chats.size <= 48 && characters <= 2_000_000) break;
            if (id === currentId || item.pending.length || item.running || item.active.size) continue;
            for (const message of item.chat?.messages ?? []) characters -= (message.text?.length ?? 0)
                + (message.results ?? []).reduce((total, result) => total + (result.text?.length ?? 0), 0);
            chats.delete(id);
        }
    }
    function entry(id) {
        if (!chats.has(id)) chats.set(id, { chat: null, sequence: 0, pending: [], running: null, revisions: new Set(), active: new Set() });
        return chats.get(id);
    }
    function changed(id, type, target = {}) {
        const item = entry(id); item.sequence = ++sequence;
        onChange({ type, roundId: id, ...target, sequence: item.sequence });
        prune(id);
    }
    function ingest(chat, started) {
        const item = entry(chat.id);
        const previous = item.chat;
        if (previous && previous.revision !== chat.revision && item.revisions.has(chat.revision)) return clone(previous);
        if (!previous || started === item.sequence && !item.pending.length && !item.active.size) {
            const next = clone(chat);
            if (previous?.revision !== chat.revision && !item.revisions.has(chat.revision)) item.revisions.clear();
            if (previous) for (const message of next.messages) {
                const old = previous.messages.find(old => old.id === message.id);
                for (const target of message.role === 'user' ? [message] : message.results) {
                    const source = message.role === 'user' ? old : old?.results.find(result => result.id === target.id);
                    if (target.text === undefined && target.bodyRevision === source?.bodyRevision) target.text = source.text;
                }
            }
            item.chat = next;
            if (chat.revision) item.revisions.add(chat.revision);
        } else for (const message of previous.messages) {
            const source = chat.messages.find(source => source.id === message.id);
            for (const target of message.role === 'user' ? [message] : message.results) {
                const body = message.role === 'user' ? source : source?.results.find(result => result.id === target.id);
                if (target.text === undefined && body?.bodyRevision === target.bodyRevision) target.text = body.text;
            }
        }
        prune(chat.id);
        return clone(item.chat);
    }
    async function read(id, method, options) {
        const item = entry(id), started = item.sequence;
        if (item.chat && (item.pending.length || item.active.size) && method === 'getChatMetadata') return clone(item.chat);
        if (item.chat && (item.pending.length || item.active.size) && method === 'getChat' && item.chat.messages.every(message => message.role === 'user'
            ? message.text !== undefined : message.results.every(result => result.text !== undefined))) return clone(item.chat);
        if (item.chat && item.pending.some(operation => operation.kind === 'begin') && !item.chat.revision) return clone(item.chat);
        try { return ingest(await history[method](id, options), started); }
        catch (error) { if (item.chat && item.pending.length) return clone(item.chat); throw error; }
    }
    function windowBounds(chat, options = {}) {
        const total = chat.messages.length, size = 24;
        const anchor = options.anchorId === 'initial-user' || options.anchorId === 'initial-assistant'
            ? chat.messages.find(message => chat.startMessageIds.includes(message.id)
                && message.role === (options.anchorId === 'initial-user' ? 'user' : 'assistant'))?.id : options.anchorId;
        const index = chat.messages.findIndex(message => message.id === anchor);
        let end = options.latest ? total : Number.isInteger(options.end) ? Math.min(total, options.end) : index < 0 ? total : Math.min(total, index + size);
        let start = options.latest ? Math.max(0, total - size) : Number.isInteger(options.start) ? Math.min(end, options.start)
            : index < 0 ? Math.max(0, end - size) : Math.max(0, index - size / 2);
        if (!options.latest && index >= 0 && (index < start || index >= end)) {
            start = Math.max(0, index - size / 2); end = Math.min(total, index + size);
        }
        return { chat: clone(chat), start, end };
    }
    async function getWindow(id, options) {
        const item = entry(id), started = item.sequence;
        if (item.chat && !item.chat.revision) return windowBounds(item.chat, options);
        try {
            const window = await history.getChatWindow(id, options);
            return windowBounds(ingest(window.chat, started), options);
        } catch (error) {
            if (item.chat && (item.pending.length || item.active.size)) return windowBounds(item.chat, options);
            throw error;
        }
    }
    function confirm(item, value) {
        const saved = value?.chat ?? (value?.format === 2 ? value : null);
        if (!saved || !item.chat || saved.id !== item.chat.id) return;
        if (saved.characterId !== item.chat.characterId) {
            const previous = item.chat.characterId;
            item.chat.characterId = saved.characterId;
            const owner = owners.get(previous);
            if (owner) { owners.delete(previous); owners.set(saved.characterId, { ...owner, id: saved.characterId }); }
            for (const other of chats.values()) if (other.chat?.characterId === previous) other.chat.characterId = saved.characterId;
        }
        if (saved.revision) {
            item.revisions.add(saved.revision); item.chat.revision = saved.revision;
            if (item.revisions.size > 64) item.revisions.delete(item.revisions.values().next().value);
        }
        for (const message of item.chat.messages) {
            const confirmed = saved.messages.find(source => source.id === message.id);
            for (const target of message.role === 'user' ? [message] : message.results) {
                const body = message.role === 'user' ? confirmed : confirmed?.results.find(result => result.id === target.id);
                if (body?.text !== undefined && body.text === target.text) target.bodyRevision = body.bodyRevision;
            }
        }
    }
    function revision(id, expected) {
        const item = entry(id);
        return expected && item.revisions.has(expected) ? item.chat?.revision : expected;
    }
    async function flush(id, boundary = Infinity) {
        const item = entry(id);
        if (item.running) { await item.running; return flush(id, boundary); }
        const work = async () => {
            let value;
            while (item.pending.length && item.pending[0].sequence <= boundary) {
                const operation = item.pending[0];
                try {
                    value = await operation.run();
                    operation.value = value; confirm(item, value); item.pending.shift(); changed(id, 'saved', operation.target);
                } catch (error) {
                    if (operation.kind === 'mutation') item.pending.shift();
                    else { if (error && typeof error === 'object') saveErrors.add(error); onSaveError(error); }
                    changed(id, 'save-error', operation.target); throw error;
                }
            }
            return value;
        };
        const task = work(); item.running = task;
        try { return await task; }
        finally { if (item.running === task) item.running = null; }
    }
    function enqueue(id, kind, run, target = {}, auto = true) {
        changed(id, 'content', target);
        const item = entry(id), operation = { kind, run, target, sequence: item.sequence };
        item.pending.push(operation);
        const completion = auto ? Promise.resolve().then(() => flush(id, operation.sequence)).then(() => operation.value) : null;
        completion?.catch(() => {});
        return { sequence: operation.sequence, completion };
    }
    function result(id, resultId) {
        return entry(id).chat?.messages.flatMap(message => message.results ?? []).find(result => result.id === resultId);
    }
    function edit(id, messageId, { text, resultId, expectedText }, { select = false } = {}) {
        const item = entry(id), chat = item.chat;
        const message = chat?.messages.find(message => message.id === messageId);
        const target = message?.role === 'user' ? message : message?.results.find(result => result.id === resultId);
        if (!target) throw new PlayHistoryError('message_missing', '这条消息已删除，请保留草稿并重新读取。');
        if (typeof text !== 'string' || !text.trim() || typeof expectedText !== 'string') throw new PlayHistoryError('invalid_history', '消息正文不能为空。');
        if (target.text !== expectedText) throw new PlayHistoryError('edit_conflict', '这条消息已在其他窗口修改，请保留草稿并重新读取。');
        const previous = target.text, selected = message.selectedResultId;
        target.text = text;
        const change = enqueue(id, 'edit', () => history.editMessage(id, messageId, { text, resultId, expectedText: previous }), { messageId, resultId });
        if (select && chat.messages.at(-1) === message && selected !== resultId) {
            message.selectedResultId = resultId;
            enqueue(id, 'selection', () => history.setMessageVersion(id, messageId, resultId, selected), { messageId, resultId });
        }
        return { chat: clone(chat), sequence: change.sequence };
    }
    function begin(input) {
        const id = input.roundId ?? input.newRoundId, item = entry(id);
        if (!item.chat) {
            const owner = [...owners.values()].find(owner => owner.avatar === input.character.avatar);
            owners.set(owner?.id ?? input.ownerId, owner ?? { ...input.character, id: input.ownerId });
            item.chat = { format: 2, id, characterId: owner?.id ?? input.characterId ?? input.ownerId,
                createdAt: input.startedAt, origin: input.origin, source: null, name: '', startMessageIds: [], messages: [] };
        }
        const owner = [...owners.values()].find(owner => owner.id === item.chat.characterId);
        if (owner?.avatar && owner.avatar !== input.character.avatar || input.characterId && input.characterId !== item.chat.characterId) {
            throw new PlayHistoryError('other_character', '这条聊天不属于本次选择的角色，请重新选择角色。');
        }
        item.chat = preparePlayGeneration(item.chat, input);
        item.active.add(input.resultId);
        const change = enqueue(id, 'begin', async () => {
            const value = await history.begin({ ...input, returnChat: true, expectedRevision: revision(id, input.expectedRevision) });
            return value.format === 2 ? value : await history.getChat(id);
        }, { resultId: input.resultId, messageId: input.messageId ?? input.assistantMessageId });
        return { id, ...change };
    }
    function updateResult(id, resultId, patch) {
        const target = result(id, resultId);
        if (!target) return;
        Object.assign(target, clone(patch));
        changed(id, 'content', { resultId });
    }
    function finish(id, resultId, update, auto = true) {
        updateResult(id, resultId, update);
        const operation = enqueue(id, 'result', () => history.saveResult(id, resultId, update, { withChat: true }), { resultId }, auto);
        entry(id).active.delete(resultId);
        return operation;
    }
    async function list(method, characterId) {
        const started = sequence;
        const values = await history[method](...(characterId ? [characterId] : []));
        if (method === 'listCharacters') {
            for (const owner of values) owners.set(owner.id, clone(owner));
            for (const owner of owners.values()) if ([...chats.values()].some(item => item.chat?.characterId === owner.id && (item.pending.length || item.active.size || item.sequence > started))
                && !values.some(value => value.id === owner.id || value.avatar === owner.avatar)) values.push(clone(owner));
        } else for (const item of chats.values()) {
            const chat = item.chat;
            if (!item.pending.length && !item.active.size && item.sequence <= started) continue;
            if (!chat || chat.characterId !== characterId || method === 'listRounds' && (chat.source || !chat.messages.some(message => chat.startMessageIds.includes(message.id)))) continue;
            if (!values.some(row => row.id === chat.id)) values.push({ id: chat.id, characterId, revision: chat.revision ?? null,
                kind: 'chat', name: playChatTitle(chat), branched: !!chat.source, createdAt: chat.createdAt,
                lastPlayedAt: chat.messages.at(-1)?.createdAt ?? chat.createdAt });
        }
        return values.sort((a, b) => method === 'listRounds' ? Date.parse(a.createdAt) - Date.parse(b.createdAt)
            : (Date.parse(b.lastPlayedAt) || 0) - (Date.parse(a.lastPlayedAt) || 0));
    }
    async function getRound(id, reader = id => history.getRound(id, { withChat: true })) {
        const item = entry(id), cached = item.chat, started = item.sequence;
        if (cached && (item.pending.length || item.active.size) && cached.messages.filter(message => cached.startMessageIds.includes(message.id)).every(message =>
            message.role === 'user' ? message.text !== undefined : message.results.every(result => result.text !== undefined))) return playStartRound(clone(cached));
        let round;
        try { round = await reader(id); }
        catch (error) { if (cached && (item.pending.length || item.active.size)) return playStartRound(clone(cached)); throw error; }
        if (!round.chat) return cached && (item.pending.length || item.active.size) ? playStartRound(clone(cached)) : round;
        return playStartRound(ingest(round.chat, started));
    }
    async function directory(id, options = {}, reader) {
        const item = entry(id), started = item.sequence;
        let saved;
        if (entry(id).chat && !entry(id).chat.revision) saved = { id, messages: [] };
        else try { saved = reader ? await reader(id, options) : await history[options.search ? 'getChatSearch' : 'getChatPreview'](id, options); }
        catch (error) { if (!item.chat || !item.pending.length && !item.active.size) throw error; saved = { id, messages: [] }; }
        const chat = entry(id).chat;
        if (!chat || !item.pending.length && !item.active.size && item.sequence === started
            && (!item.revisions.has(saved.revision) || saved.revision === chat.revision)) return saved;
        const depths = playMessageDepths(chat.messages);
        const messages = options.search ? chat.messages : [chat.messages.findLast(message => message.role === 'assistant')].filter(Boolean);
        return { ...saved, name: playChatTitle(chat), messages: messages.map(message => {
            const result = message.role === 'user' ? message : message.results.find(result => result.id === message.selectedResultId);
            return { role: message.role, messageId: message.id, resultId: message.role === 'user' ? null : result.id,
                text: result.text ?? saved.messages.find(source => source.messageId === message.id)?.text,
                context: result.context, depth: depths.get(message), hidden: !!message.hidden, bodyRevision: result.bodyRevision };
        }) };
    }
    return {
        currentChat: id => clone(entry(id).chat),
        currentRound: id => entry(id).chat ? playStartRound(clone(entry(id).chat)) : null,
        currentResult: (id, resultId) => clone(result(id, resultId)),
        async loadMessage(id, messageId, resultId) {
            const item = entry(id), message = item.chat?.messages.find(message => message.id === messageId);
            const target = resultId ? message?.results.find(result => result.id === resultId) : message;
            if (!target) throw new PlayHistoryError('message_missing', '这条消息已删除，请保留草稿并重新读取。');
            if (target.text === undefined) {
                const revision = target.bodyRevision, text = await history.getMessageBody(target.id, revision);
                if (target.bodyRevision === revision && target.text === undefined) target.text = text;
            }
            return clone(item.chat);
        },
        character: id => clone(owners.get(entry(id).chat?.characterId)),
        getChat: (id, options) => read(id, 'getChat', options),
        getChatMetadata: id => read(id, 'getChatMetadata'),
        getChatWindow: getWindow,
        getRound,
        async createRoundReader() {
            const reader = await history.createRoundReader({ withChat: true });
            return id => getRound(id, reader);
        },
        async ensureChat(id, options) {
            const item = entry(id), started = item.sequence;
            if (item.chat && item.pending.length && !item.chat.legacy) return clone(item.chat);
            if (item.chat?.revision && !item.chat.legacy) return clone(item.chat);
            const chat = await (history.ensureChat ? history.ensureChat(id, options) : history.getChat(id, options));
            return ingest(chat, started);
        },
        directory,
        async createChatDirectoryReader() {
            const reader = await history.createChatDirectoryReader();
            return (id, options) => directory(id, options, reader);
        },
        listCharacters: () => list('listCharacters'), listRounds: id => list('listRounds', id), listChats: id => list('listChats', id),
        edit, begin, updateResult, finish, flush, revision,
        isSaveError: error => error && typeof error === 'object' && saveErrors.has(error),
        hasUnsaved: () => [...chats.values()].some(item => item.pending.length),
        async setUserIdentity(id, messageId, resultId, identity) {
            const message = entry(id).chat?.messages.find(message => message.id === messageId);
            if (message) { message.userIdentity = clone(identity); changed(id, 'content', { messageId, resultId }); }
            const operation = enqueue(id, 'identity', () => history.setUserIdentity(id, messageId, resultId, identity, { withChat: true }), { messageId, resultId });
            const saved = await operation.completion;
            return clone(saved && Object.hasOwn(saved, 'identity') ? saved.identity : saved ?? identity);
        },
        async mutate(id, run, expectedRevision) {
            const item = entry(id), before = clone(item.chat);
            const operation = enqueue(id, 'mutation', async () => {
                const value = await run(revision(id, expectedRevision));
                const saved = value?.id === id && value.format === 2 ? value
                    : value?.format === 1 && value.id === id ? await history.getChat(id) : null;
                if (saved) {
                    const next = clone(saved), previous = item.chat;
                    for (const message of previous?.messages ?? []) {
                        const old = before?.messages.find(source => source.id === message.id);
                        let target = next.messages.find(source => source.id === message.id);
                        if (!old) { if (!target) next.messages.push(clone(message)); continue; }
                        if (!target) {
                            if (item.pending.some(task => task.kind === 'edit' && task.target.messageId === message.id)) next.messages.push(clone(message));
                            continue;
                        }
                        if (target.text === undefined && target.bodyRevision === message.bodyRevision) target.text = message.text;
                        for (const key of ['text', 'userIdentity', 'hidden', 'selectedResultId']) {
                            if (JSON.stringify(message[key]) !== JSON.stringify(old[key])) target[key] = clone(message[key]);
                        }
                        for (const result of message.results ?? []) {
                            const original = old.results?.find(source => source.id === result.id);
                            const confirmed = target.results?.find(source => source.id === result.id);
                            if (!original) { if (!confirmed) target.results.push(clone(result)); continue; }
                            if (!confirmed) {
                                if (item.pending.some(task => task.kind === 'edit' && task.target.resultId === result.id)) target.results.push(clone(result));
                                continue;
                            }
                            if (confirmed.text === undefined && confirmed.bodyRevision === result.bodyRevision) confirmed.text = result.text;
                            for (const key of ['text', 'extra', 'context', 'status', 'error', 'finishedAt']) {
                                if (item.active.has(result.id) || JSON.stringify(result[key]) !== JSON.stringify(original[key])) confirmed[key] = clone(result[key]);
                            }
                        }
                    }
                    item.chat = next;
                } else if (!value && !item.pending.some(operation => operation.kind !== 'mutation') && !item.active.size) item.chat = null;
                return value;
            });
            try { return await operation.completion; }
            catch (error) { item.pending = item.pending.filter(task => task.sequence !== operation.sequence); throw error; }
        },
    };
}
