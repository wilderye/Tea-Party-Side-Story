import { createPlaySession } from './play-session.js';
import { PlayHistoryError, readPlayContext, readPlayOrigin, readPlayReasoning, playCurrentMessages, playStartRound } from './play-history.js';
import { playContinuationError, readPlayRetrySettings } from './play-settings.js';
import { playRequestMessages, playMessageIsPending, playUserIdentity } from './play-message-context.js';

export class PlaygroundError extends Error {
    constructor(code, message, options) { super(message, options); this.name = 'PlaygroundError'; this.code = code; }
}

export const PLAY_GENERATION_UNAVAILABLE = '剧场演出的发送接口尚未连接。';
const clone = value => structuredClone(value);
const isRemovedResult = error => error instanceof PlayHistoryError && error.code === 'result_missing';

function abortable(run, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return run(); })
            .then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

function publicError(error, phase) {
    if (error instanceof PlaygroundError || error instanceof PlayHistoryError) {
        return { code: error.code, message: error.message };
    }
    // Preserve the actual error text, without serializing attached request
    // objects, headers or settings into the history.
    const message = typeof error === 'string' ? error : error?.message;
    const fallback = phase === 'preparing'
        ? { code: 'prompt_preparation_failed', message: '本次提示词处理失败，没有发送到模型。' }
        : { code: 'generation_failed', message: '本次生成失败，已保留收到的内容。' };
    return { code: fallback.code, message: typeof message === 'string' && message.trim() ? message : fallback.message };
}

function retryReason(error) {
    if (error?.status === 429 || error?.upstreamStatus === 429) return 'rateLimit';
    return error?.code === 'empty_response' ? 'empty' : null;
}

/**
 * prepareRequest uses the native prompt pipeline and returns
 * { send({ signal, onText, onReasoning }), context? }. Callbacks receive the
 * full text or native reasoning metadata so far, stored independently.
 * Like Tavern's chat flow, streamed content stays in this page's memory.
 * History is saved before sending and after completion, stopping or failure.
 * This module neither evaluates outputs nor broadcasts SillyTavern events.
 */
export function createPlayground({ history, captureEnvironment, isCurrent, prepareRequest,
    diagnostics, session, onSaveError = () => {}, enabled = () => true, uuid = () => crypto.randomUUID(), now = () => new Date().toISOString() }) {
    const jobs = new Map();
    const listeners = new Set();
    session ??= createPlaySession(history, { onSaveError, onChange: publish });
    function publish(event) {
        const job = findJob(event.resultId) ?? [...jobs.values()].find(job => job.requestedRoundId === event.roundId);
        const state = { ...readJob(job), ...event, roundId: event.roundId,
            characterAvatar: job?.characterAvatar ?? session.character(event.roundId)?.avatar,
            characterName: job?.characterName ?? session.character(event.roundId)?.name,
            round: session.currentRound(event.roundId), chat: session.currentChat(event.roundId) };
        for (const listener of listeners) {
            try { listener(state); }
            catch (error) { diagnostics?.error('更新剧场演出界面', error); }
        }
    }
    function findJob(resultId) {
        return jobs.get(resultId) ?? [...jobs.values()].find(job => job.replaceResultId === resultId);
    }
    function stopJob(job) {
        if (!job || job.closed) return false;
        job.controller.abort(new DOMException('用户停止了本次小剧场生成', 'AbortError'));
        return true;
    }
    function readJob(job) {
        if (!job) return { phase: 'idle', unsaved: false };
        return { phase: job.phase,
            roundId: job.round?.id ?? job.acceptedId ?? null, resultId: job.resultId, characterId: session.currentChat(job.acceptedId)?.characterId ?? job.round?.characterId ?? null,
            requestedRoundId: job.requestedRoundId ?? null, replaceResultId: job.replaceResultId ?? null,
            chatMode: !!job.chatMode, messageId: job.messageId ?? null,
            ...(job.chatMode ? { operation: job.operation } : {}),
            characterName: job.characterName, characterAvatar: job.characterAvatar,
            text: job.text, error: clone(job.error ?? null),
            retry: clone(job.retry ?? null),
            context: clone(job.context),
            userMessageId: job.userMessageId ?? null, userIdentity: clone(job.userIdentity ?? null),
            unsaved: false };
    }
    function getState(resultId) {
        return readJob(resultId ? findJob(resultId) : [...jobs.values()].at(-1));
    }
    function hasRoundJob(roundId) {
        return [...jobs.values()].some(job => !job.closed && (job.acceptedId ?? job.requestedRoundId) === roundId);
    }
    function assertIdleChat(id) {
        if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
        if (hasRoundJob(id)) throw new PlaygroundError('busy', '这条聊天正在生成或尚未保存，请结束并保存后再操作。');
    }
    async function changeChatMessages(id, messageIds, operation, run) {
        if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
        const ownJobs = [...jobs.values()].filter(job => !job.closed && (job.acceptedId ?? job.requestedRoundId) === id)
            .map(job => ({ phase: job.phase, messageId: job.messageId ?? job.round?.initialAssistantId, resultId: job.resultId, replaceResultId: job.replaceResultId }));
        if (messageIds.some(messageId => playMessageIsPending({ id: messageId }, ownJobs))) {
            throw new PlaygroundError('busy', '所选消息正在生成或尚未保存，请结束并保存后再操作。');
        }
        return session.mutate(id, revision => historyAction(operation, () => run(revision), true));
    }
    function notify(job) {
        if (job.acceptedId) {
            session.updateResult(job.acceptedId, job.resultId, { status: job.closed ? job.finalStatus : job.phase,
                context: job.context, ...(job.error ? { error: job.error } : {}) });
        } else for (const listener of listeners) listener(readJob(job));
    }
    async function historyAction(operation, run, logSuccess = false) {
        try {
            const result = await run();
            if (logSuccess) diagnostics?.info(`${operation}完成`);
            return result;
        } catch (error) { diagnostics?.error(operation, error); throw error; }
    }
    function availability({ resultId, chatId } = {}) {
        if (!enabled()) return { available: false, code: 'disabled', message: '插件已停用' };
        const job = resultId && findJob(resultId);
        if (job && !job.closed) return { available: false, code: 'busy', message: '这份回复正在生成或保存，请先等待或停止' };
        if (chatId && hasRoundJob(chatId)) return { available: false, code: 'busy', message: '这条聊天正在生成或尚未保存，请结束并保存后再发送' };
        if (typeof prepareRequest !== 'function') return { available: false, code: 'generation_unavailable', message: PLAY_GENERATION_UNAVAILABLE };
        if (prepareRequest.isReady && !prepareRequest.isReady()) return { available: false, code: 'generation_loading', message: '正在载入酒馆的生成接口…' };
        return { available: true };
    }
    function assertCurrent(environment) {
        if (!isCurrent(environment)) throw new PlaygroundError('chat_changed', '酒馆已切换聊天，本次尚未发送到模型；请在当前角色下重新发送。');
    }
    async function waitForRetry(job, seconds) {
        const deadline = Date.now() + seconds * 1000;
        while (true) {
            job.controller.signal.throwIfAborted();
            const remaining = Math.max(0, deadline - Date.now());
            job.retry.remainingSeconds = Math.ceil(remaining / 1000);
            notify(job);
            if (!remaining) return;
            let timer;
            try {
                await abortable(() => new Promise(resolve => { timer = setTimeout(resolve, Math.min(1000, remaining)); }), job.controller.signal);
            } finally { clearTimeout(timer); }
        }
    }
    async function start({ roundId, replaceResultId, continueResultId, characterId, character, prompt, origin,
        chatMode = false, operation, messageId, expectedRevision }) {
        const available = availability({ resultId: replaceResultId || continueResultId, ...(chatMode ? { chatId: roundId } : {}) });
        if (!available.available) throw new PlaygroundError(available.code, available.message);
        if (!roundId && (typeof prompt !== 'string' || !prompt.trim())) throw new PlaygroundError('empty_prompt', '请先输入小剧场提示词');
        operation ??= continueResultId ? 'continue' : replaceResultId ? 'regenerate' : roundId ? 'another' : 'send';
        // Synchronous capture: later settings changes do not change this request.
        // Only the public context below is saved; environment may contain keys.
        let environment;
        try { environment = clone(captureEnvironment({ characterId, character, roundId })); }
        catch (error) { diagnostics?.error('读取小剧场生成环境', error); throw error; }
        const continuationError = continueResultId && playContinuationError(environment.continuation);
        if (continuationError) throw new PlaygroundError('invalid_continue_prompt', continuationError);
        let context = readPlayContext(environment.context);
        const retrySettings = readPlayRetrySettings({ playRetry: environment.retry });
        let retryCount = 0;
        const resultId = continueResultId || uuid();
        let baseText = '';
        let continueExtra;
        let resolvedContext;
        const job = { resultId, phase: 'preparing', controller: new AbortController(),
            requestedRoundId: roundId, replaceResultId, chatMode, messageId, operation,
            characterName: environment.character.name, characterAvatar: environment.character.avatar,
            context, closed: false };
        Object.defineProperties(job, {
            text: { get: () => session.currentResult(job.acceptedId, job.resultId)?.text ?? '',
                set: text => session.updateResult(job.acceptedId, job.resultId, { text }) },
            extra: { get: () => session.currentResult(job.acceptedId, job.resultId)?.extra,
                set: extra => session.updateResult(job.acceptedId, job.resultId, { extra }) },
        });
        const privateValues = [environment.api?.key, environment.tavern?.settings?.proxy_password];
        const diagnostic = diagnostics?.start(continueResultId ? '小剧场续写' : '小剧场生成',
            { phase: 'preparing', apiMode: environment.api?.mode }, privateValues);
        let generationError;
        jobs.set(job.resultId, job);
        notify(job);
        let finalStatus = 'complete';
        let resultContext = context;
        try {
            if (roundId) {
                await abortable(() => session.ensureChat(roundId), job.controller.signal);
                let current = session.currentChat(roundId);
                if (continueResultId && !current?.messages.flatMap(message => message.results ?? []).some(result => result.id === continueResultId && result.text !== undefined)) {
                    current = await abortable(() => session.getChat(roundId), job.controller.signal);
                }
                if (continueResultId) {
                    const assistant = current.messages.find(message => message.results?.some(result => result.id === continueResultId));
                    if (assistant?.hidden) throw new PlaygroundError('message_hidden', '请先显示此楼层再续写。');
                    const target = current.messages.flatMap(message => message.results ?? []).find(result => result.id === continueResultId);
                    if (!target?.text?.trim()) throw new PlaygroundError('empty_result', '这份结果没有正文，无法续写；请使用重新生成。');
                    baseText = target.text; continueExtra = readPlayReasoning(target.extra ?? {});
                }
            }
            if (operation === 'send' && typeof prepareRequest.resolveContext === 'function') {
                resolvedContext = await abortable(() => prepareRequest.resolveContext({ environment, signal: job.controller.signal }), job.controller.signal);
                context = readPlayContext({ ...context, ...resolvedContext.context });
                job.context = resultContext = context;
            }
            job.controller.signal.throwIfAborted(); assertCurrent(environment);
            const input = { roundId, newRoundId: uuid(), ownerId: uuid(), userMessageId: uuid(), assistantMessageId: uuid(),
                userBodyRevision: uuid(), resultBodyRevision: uuid(), replaceResultId, continueResultId, characterId,
                character: environment.character, prompt, origin: readPlayOrigin(origin), resultId: job.resultId, startedAt: now(), context,
                chatMode, operation,
                messageId, expectedRevision, ...(continueResultId ? { expectedText: baseText } : {}) };
            job.acceptedId = roundId ?? input.newRoundId;
            job.messageId = messageId ?? input.assistantMessageId;
            job.userMessageId = input.operation === 'send' ? input.userMessageId : null;
            job.userIdentity = job.userMessageId ? playUserIdentity(context) : null;
            let acceptance;
            try { acceptance = session.begin(input); }
            catch (error) { job.acceptedId = null; throw error; }
            job.initialSave = acceptance.completion;
            if (continueExtra) job.extra = clone(continueExtra);
            notify(job);
            job.round = await abortable(() => acceptance.completion, job.controller.signal);
            let requestPrompt = chatMode ? undefined : playStartRound(job.round).prompt;
            if (chatMode) {
                const { history: messages, user, target } = playRequestMessages(playCurrentMessages(job.round));
                job.messageId = target.messageId;
                requestPrompt = user?.text;
                environment.branchHistory = messages;
                environment.requestUser = user;
                environment.branchMode = true;
            } else {
                const round = playStartRound(job.round);
                if (round.initialUserId) environment.requestUser = { id: round.initialUserId, hidden: round.initialUserHidden };
            }
            if (!roundId || chatMode && operation === 'send') job.userMessageId = environment.requestUser?.id;
            notify(job);
            job.controller.signal.throwIfAborted();
            assertCurrent(environment);
            const recordUserIdentity = async context => {
                if (!job.userMessageId || job.userIdentity) return;
                const identity = playUserIdentity(context);
                if (!identity) return;
                job.controller.signal.throwIfAborted();
                job.userIdentity = await session.setUserIdentity(job.round.id, job.userMessageId, job.resultId, identity);
                if (!job.closed) notify(job);
            };
            const request = await abortable(() => prepareRequest({
                generationId: job.resultId, prompt: requestPrompt, environment,
                continueMessage: continueResultId ? baseText : undefined,
                ...(continueResultId ? { continueExtra } : {}),
                signal: job.controller.signal,
                ...(resolvedContext ? { resolvedContext } : {}),
                onPersonaResolved: recordUserIdentity,
            }), job.controller.signal);
            if (typeof request?.send !== 'function') throw new PlaygroundError('invalid_prepared_request', '提示词处理没有返回可发送的请求，本次没有发送到模型。');
            if (request.context) resultContext = readPlayContext({ ...context, ...request.context,
                ...(environment.independent ? {} : { chatId: context.chatId }), apiMode: context.apiMode, characterName: context.characterName });
            job.context = resultContext;
            await recordUserIdentity(resultContext);
            assertCurrent(environment);
            while (true) {
                job.controller.signal.throwIfAborted();
                job.phase = 'generating';
                diagnostic?.update({ ...request.context, phase: 'generating', requestStartedAt: now() });
                notify(job);
                let receivedBody = false, attemptActive = true, attemptError;
                try {
                    const result = await abortable(() => request.send({ signal: job.controller.signal, resultId: job.resultId,
                        onReasoning(extra) {
                            if (!attemptActive || jobs.get(job.resultId) !== job || job.closed || job.controller.signal.aborted) return;
                            job.extra = readPlayReasoning(extra);
                        },
                        onText(text) {
                            if (!attemptActive || jobs.get(job.resultId) !== job || job.closed || job.controller.signal.aborted) return;
                            if (typeof text !== 'string') throw new PlaygroundError('invalid_response', '模型返回的内容格式不正确');
                            receivedBody ||= !!text.slice(baseText.length).trim();
                            if (receivedBody) job.retry = null;
                            if (diagnostic && text && text !== job.text) {
                                const receivedAt = now(), first = !job.text;
                                diagnostic?.update({ ...(first ? { firstContentAt: receivedAt } : {}),
                                    lastContentAt: receivedAt, receivedCharacters: text.length });
                            }
                            job.text = text;
                            notify(job);
                        },
                    }), job.controller.signal);
                    const text = typeof result === 'string' ? result : result?.text;
                    if (typeof text !== 'string' || !text.slice(baseText.length).trim()) {
                        throw new PlaygroundError('empty_response', '模型没有返回正文，已保留收到的内容。');
                    }
                    job.text = text;
                    break;
                } catch (error) { attemptError = error; }
                finally { attemptActive = false; }
                const reason = retryReason(attemptError);
                if (job.controller.signal.aborted || attemptError?.name === 'AbortError'
                    || receivedBody || !reason || !retrySettings[reason] || retryCount >= retrySettings.maxRetries) throw attemptError;
                diagnostics?.warn('小剧场请求失败', attemptError, { phase: 'generating' }, privateValues);
                diagnostics?.info(`将在 ${retrySettings.intervalSeconds} 秒后进行第 ${retryCount + 1}/${retrySettings.maxRetries} 次自动重试`);
                job.phase = 'retry-wait';
                job.retry = { reason, attempt: retryCount + 1, maxRetries: retrySettings.maxRetries, remainingSeconds: 0 };
                diagnostic?.update({ phase: job.phase });
                await waitForRetry(job, retrySettings.intervalSeconds);
                job.controller.signal.throwIfAborted();
                job.text = baseText;
                job.extra = continueExtra ? clone(continueExtra) : {};
                retryCount++;
                diagnostics?.info(`开始第 ${retryCount}/${retrySettings.maxRetries} 次自动重试`);
            }
        } catch (error) {
            generationError = error;
            finalStatus = job.controller.signal.aborted || error?.name === 'AbortError' ? 'stopped' : 'failed';
            if (session.isSaveError(error)) {
                finalStatus = 'stopped'; job.beforeRequestFailure = true;
            } else if (!job.round) {
                if (!job.acceptedId) {
                    jobs.delete(job.resultId); job.phase = 'idle';
                    for (const listener of listeners) listener(readJob(job));
                    if (job.controller.signal.aborted || error?.name === 'AbortError') return null;
                    throw error;
                }
                finalStatus = 'stopped';
                job.beforeRequestFailure = !job.controller.signal.aborted;
            } else if (finalStatus === 'failed') {
                job.error = publicError(error, job.phase);
                if (retryCount) job.error.message += `\n已自动重试 ${retryCount} 次。`;
            }
        } finally {
            job.closed = true; job.finalStatus = finalStatus; job.finishedAt = now();
            diagnostic?.finish(finalStatus, session.isSaveError(generationError) ? undefined : generationError,
                { phase: job.phase, receivedCharacters: job.text.length });
        }
        if (!job.acceptedId || !session.currentResult(job.acceptedId, job.resultId)) {
            jobs.delete(job.resultId); job.phase = 'idle';
            for (const listener of listeners) listener(readJob(job));
            return null;
        }
        const update = { text: job.text, status: finalStatus, finishedAt: job.finishedAt, context: resultContext,
            ...(job.extra ? { extra: job.extra } : {}), ...(job.error ? { error: job.error } : {}) };
        job.phase = 'idle';
        const saving = session.finish(job.acceptedId, job.resultId, update, !job.beforeRequestFailure);
        jobs.delete(job.resultId);
        publish({ roundId: job.acceptedId, resultId: job.resultId, phase: 'idle', type: 'content' });
        if (job.beforeRequestFailure) return null;
        if (job.controller.signal.aborted && !job.round) return null;
        try {
            await saving.completion;
            diagnostics?.info('小剧场回复已保存', { phase: 'saving', savedAt: now() });
        } catch (error) {
            if (isRemovedResult(error)) return null;
        }
        const { bodyRevision, ...result } = session.currentResult(job.acceptedId, job.resultId);
        return { roundId: job.acceptedId, characterId: session.currentChat(job.acceptedId).characterId, result };
    }

    return {
        availability, session, publish,
        getState,
        getStates: () => [...jobs.values()].filter(job => !job.closed).map(readJob),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        send({ characterId, character, prompt, origin = null }) { return start({ characterId, character, prompt, origin }); },
        sendChat(chatId, { characterId, character, prompt, origin = null, expectedRevision }) {
            return start({ roundId: chatId, chatMode: true, operation: 'send', characterId, character, prompt, origin, expectedRevision });
        },
        generateChatVersion(chatId, messageId, target = {}) {
            return start({ ...target, roundId: chatId, messageId, chatMode: true, operation: 'another' });
        },
        regenerateChat(chatId, messageId, resultId, target = {}) {
            return start({ ...target, roundId: chatId, messageId, replaceResultId: resultId, chatMode: true, operation: 'regenerate' });
        },
        continueChat(chatId, messageId, resultId, target = {}) {
            return start({ ...target, roundId: chatId, messageId, continueResultId: resultId, chatMode: true, operation: 'continue' });
        },
        listChats: characterId => historyAction('读取聊天历史目录', () => session.listChats(characterId)),
        getChatPreview: (id, options) => historyAction('读取历史记录预览', () => session.directory(id, options)),
        getChatSearch: (id, options) => historyAction('搜索聊天内容', () => session.directory(id, { ...options, search: true })),
        getChat: (id, options) => historyAction('读取分支聊天', () => session.getChat(id, options)),
        getChatWindow: (id, options) => historyAction('读取分支聊天显示范围', () => session.getChatWindow(id, options)),
        ensureChat: (id, options) => session.ensureChat(id, options),
        async finishUnfinishedChat(id) {
            assertIdleChat(id);
            await session.mutate(id, async () => {
                const chat = await history.getChat(id);
                for (const message of chat.messages) for (const result of message.results ?? []) {
                    if (result.status === 'unfinished') await historyAction('结束未完成回复', () => history.saveResult(id, result.id,
                        { status: 'stopped', finishedAt: now() }));
                }
                return history.getChat(id);
            });
        },
        createBranch(id, messageId, revision) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            return session.mutate(id, revision => historyAction('创建分支', () => history.createBranch(id, messageId, revision), true), revision);
        },
        setMessageVersion(id, messageId, resultId, expectedResultId, options = {}) {
            if (options.playSelection) {
                if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            } else assertIdleChat(id);
            return session.mutate(id, () => historyAction('切换回复版本', () => history.setMessageVersion(id, messageId, resultId, expectedResultId, options)));
        },
        renameChat(id, name, revision) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            return session.mutate(id, revision => historyAction('修改聊天名称', () => history.renameChat(id, name, revision), true), revision);
        },
        setMessagesHidden(id, messageIds, hidden, revision) {
            return changeChatMessages(id, messageIds, '修改楼层显隐', () => history.setMessagesHidden(id, messageIds, hidden, session.revision(id, revision)));
        },
        async editMessage(id, messageId, update) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (playMessageIsPending(session.currentChat(id)?.messages.find(message => message.id === messageId), [...jobs.values()])) throw new PlaygroundError('busy', '所选消息正在生成或尚未保存，请结束并保存后再操作。');
            return session.edit(id, messageId, update).chat;
        },
        removeMessage(id, messageId, revision) {
            return changeChatMessages(id, [messageId], '删除聊天消息', () => history.removeMessage(id, messageId, session.revision(id, revision)));
        },
        truncateChat(id, messageId, revision) {
            assertIdleChat(id);
            return session.mutate(id, revision => historyAction('删除所选消息及后续对话', () => history.truncateChat(id, messageId, revision), true), revision);
        },
        deleteChat(id, revision, options) {
            assertIdleChat(id);
            return session.mutate(id, revision => historyAction('删除该聊天', () => history.deleteChat(id, revision, options), true), revision);
        },
        addChatFavorite(input) {
            assertIdleChat(input.chatId);
            return session.mutate(input.chatId, revision => historyAction('收藏该聊天', () => history.addChatFavorite({ ...input, expectedRevision: revision }), true), input.expectedRevision);
        },
        async syncChatFavorite(id, input) {
            const favorite = await history.getFavoriteWindow(id, { metadata: true });
            if (favorite.source.type === 'chat') await session.flush(favorite.source.chatId);
            return historyAction('更新聊天收藏', () => history.syncChatFavorite(id, input));
        },
        generateAnother(roundId, target = {}) { return start({ ...target, roundId }); },
        regenerate(roundId, resultId, target = {}) {
            if (!resultId) throw new PlaygroundError('result_missing', '请先选择要重新生成的结果');
            return start({ ...target, roundId, replaceResultId: resultId });
        },
        continueResult(roundId, resultId, target = {}) {
            if (!resultId) throw new PlaygroundError('result_missing', '请先选择要续写的结果');
            return start({ ...target, roundId, continueResultId: resultId });
        },
        stop(resultId) {
            const active = [...jobs.values()].filter(job => !job.closed);
            const job = resultId ? findJob(resultId) : active.length === 1 ? active[0] : null;
            return stopJob(job);
        },
        stopAll() {
            const active = [...jobs.values()].filter(job => !job.closed);
            for (const job of active) stopJob(job);
            return active.length;
        },
        listCharacters: () => historyAction('读取演出角色列表', () => session.listCharacters()),
        listRounds: characterId => historyAction('读取演出历史目录', () => session.listRounds(characterId)),
        listFavorites: () => historyAction('读取演出收藏列表', () => history.listFavorites()),
        getFavorite: id => historyAction('读取演出收藏', () => history.getFavorite(id)),
        async addFavorite(input) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (findJob(input.resultId)) {
                throw new PlaygroundError('busy', '请在这份回复结束并保存后收藏');
            }
            await session.flush(input.roundId);
            return historyAction('收藏演出记录', () => history.addFavorite(input), true);
        },
        editFavorite(id, update, revision) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            return historyAction('保存演出收藏修改', () => history.editFavorite(id, update, revision), true);
        },
        addManualFavorite(input) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            return historyAction('手动添加演出收藏', () => history.addManualFavorite(input), true);
        },
        removeFavorite(id) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            return historyAction('取消演出收藏', () => history.removeFavorite(id), true);
        },
        async editPrompt(roundId, text, expectedText) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (typeof text !== 'string' || !text.trim()) throw new PlayHistoryError('invalid_history', '提示词不能为空。');
            const round = session.currentRound(roundId);
            session.edit(roundId, round?.initialUserId, { text, expectedText });
            return session.currentRound(roundId);
        },
        async editResult(roundId, resultId, text, expectedText) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (typeof text !== 'string' || !text.trim()) throw new PlayHistoryError('invalid_history', '回复正文不能为空。');
            if (findJob(resultId) && !findJob(resultId).closed) throw new PlaygroundError('busy', '这条回复正在生成或保存，请结束后再编辑。');
            const round = session.currentRound(roundId);
            session.edit(roundId, round?.initialAssistantId, { text, resultId, expectedText }, { select: round?.initialIsLast });
            return session.currentRound(roundId);
        },
        async removePrompt(roundId, expectedText) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (hasRoundJob(roundId)) {
                throw new PlaygroundError('busy', '这轮回复正在生成或尚未保存，请结束并保存后再删除。');
            }
            const round = await session.mutate(roundId, () => historyAction('删除用户消息', () => history.removePrompt(roundId, expectedText), true));
            return round;
        },
        async removeReply(roundId, expectedResults) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (hasRoundJob(roundId)) {
                throw new PlaygroundError('busy', '这条回复正在生成或尚未保存，请结束并保存后再删除。');
            }
            return session.mutate(roundId, () => historyAction('删除 AI 消息及全部版本', () => history.removeReply(roundId, expectedResults), true));
        },
        getRound: id => historyAction('读取演出记录', () => session.getRound(id)),
        async createRoundReader() {
            const read = await session.createRoundReader();
            return id => historyAction('读取演出记录', () => read(id));
        },
    };
}
