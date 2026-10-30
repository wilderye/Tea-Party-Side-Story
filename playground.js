import { PlayHistoryError, readPlayContext, readPlayOrigin, readPlayReasoning, playCurrentMessages } from './play-history.js';
import { playContinuationError, readPlayRetrySettings } from './play-settings.js';
import { playRequestMessages } from './play-message-context.js';

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
        : phase === 'saving'
            ? { code: 'history_save_failed', message: '回复尚未保存到酒馆文件，内容仍保留在当前页面；请重试保存。' }
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
    diagnostics, enabled = () => true, uuid = () => crypto.randomUUID(), now = () => new Date().toISOString() }) {
    const jobs = new Map();
    const listeners = new Set();
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
            roundId: job.round?.id ?? null, resultId: job.resultId, characterId: job.round?.characterId ?? null,
            requestedRoundId: job.requestedRoundId ?? null, replaceResultId: job.replaceResultId ?? null,
            chatMode: !!job.chatMode, messageId: job.messageId ?? null,
            ...(job.chatMode ? { operation: job.operation } : {}),
            characterName: job.characterName, characterAvatar: job.characterAvatar,
            text: job.text, error: clone(job.saveError ?? job.error ?? null),
            retry: clone(job.retry ?? null),
            context: clone(job.context),
            unsaved: !!job.pendingUpdate };
    }
    function getState(resultId) {
        return readJob(resultId ? findJob(resultId) : [...jobs.values()].at(-1));
    }
    function hasRoundJob(roundId) {
        return [...jobs.values()].some(job => (job.round?.id ?? job.requestedRoundId) === roundId);
    }
    // File contents can lag behind streamed or unsaved text. Returned rounds
    // use the same current result for reads and user-message edits.
    function withLiveResults(round) {
        for (const result of round.results) {
            const job = findJob(result.id);
            if (job) {
                result.text = job.text;
                if (job.extra) result.extra = clone(job.extra);
                result.status = job.phase;
                if (job.context) result.context = clone(job.context);
                if (job.saveError ?? job.error) result.error = clone(job.saveError ?? job.error);
            }
        }
        return round;
    }
    function withLiveChat(chat) {
        for (const message of chat.messages) for (const result of message.results ?? []) {
            const job = findJob(result.id);
            if (!job) continue;
            result.text = job.text; result.status = job.phase;
            if (job.extra) result.extra = clone(job.extra);
            if (job.context) result.context = clone(job.context);
            if (job.saveError ?? job.error) result.error = clone(job.saveError ?? job.error);
        }
        return chat;
    }
    function assertIdleChat(id) {
        if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
        if (hasRoundJob(id)) throw new PlaygroundError('busy', '这条聊天正在生成或尚未保存，请结束并保存后再操作。');
    }
    function notify(job) {
        for (const listener of listeners) {
            try { listener(readJob(job)); }
            catch (error) { diagnostics?.error('更新剧场演出界面', error); /* A view cannot interrupt a save or request. */ }
        }
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
        if (job?.phase === 'save-failed') return { available: false, code: 'unsaved_result', message: '这份回复尚未保存，请先重试保存' };
        if (job) return { available: false, code: 'busy', message: '这份回复正在生成或保存，请先等待或停止' };
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
        // Synchronous capture: later settings changes do not change this request.
        // Only the public context below is saved; environment may contain keys.
        let environment;
        try { environment = clone(captureEnvironment({ characterId, character, roundId })); }
        catch (error) { diagnostics?.error('读取小剧场生成环境', error); throw error; }
        const continuationError = continueResultId && playContinuationError(environment.continuation);
        if (continuationError) throw new PlaygroundError('invalid_continue_prompt', continuationError);
        const context = readPlayContext(environment.context);
        const retrySettings = readPlayRetrySettings({ playRetry: environment.retry });
        let retryCount = 0;
        const resultId = continueResultId || uuid();
        let baseText = '';
        let continueExtra;
        const job = { resultId, phase: 'preparing', controller: new AbortController(),
            requestedRoundId: roundId, replaceResultId, chatMode, messageId, operation,
            characterName: environment.character.name, characterAvatar: environment.character.avatar,
            text: '', context, closed: false };
        const privateValues = [environment.api?.key, environment.tavern?.settings?.proxy_password];
        const diagnostic = diagnostics?.start(continueResultId ? '小剧场续写' : '小剧场生成',
            { phase: 'preparing', apiMode: environment.api?.mode }, privateValues);
        let generationError;
        jobs.set(job.resultId, job);
        notify(job);
        let finalStatus = 'complete';
        let resultContext = context;
        try {
            if (continueResultId) {
                const currentRound = await abortable(() => chatMode ? history.getChat(roundId) : history.getRound(roundId), job.controller.signal);
                const results = chatMode ? currentRound.messages.at(-1)?.results : currentRound?.results;
                if (chatMode ? currentRound.messages.at(-1)?.hidden : currentRound.initialAssistantHidden) {
                    throw new PlaygroundError('message_hidden', '请先显示此楼层再续写。');
                }
                const target = results?.find(result => result.id === continueResultId);
                if (!target) throw new PlaygroundError('result_missing', '这份结果已在其他窗口删除或替换，请重新打开记录后再试。');
                if (!target.text.trim()) throw new PlaygroundError('empty_result', '这份结果没有正文，无法续写；请使用重新生成。');
                baseText = target.text;
                continueExtra = readPlayReasoning(target.extra ?? {});
                if (target.extra) job.extra = clone(continueExtra);
                job.text = baseText;
                assertCurrent(environment);
            }
            job.round = await history.begin({ roundId, replaceResultId, continueResultId, characterId, character: environment.character,
                prompt, origin: readPlayOrigin(origin), resultId: job.resultId, startedAt: now(), context,
                ...(chatMode ? { chatMode, operation, messageId, expectedRevision } : {}),
                ...(continueResultId ? { expectedText: baseText } : {}) }, { signal: job.controller.signal });
            let requestPrompt = job.round.prompt;
            if (chatMode) {
                const { history: messages, user, target } = playRequestMessages(playCurrentMessages(job.round));
                job.messageId = target.messageId;
                requestPrompt = user?.text;
                environment.branchHistory = messages;
                environment.requestUser = user;
                environment.branchMode = true;
            } else if (job.round.initialUserId) {
                environment.requestUser = { id: job.round.initialUserId, hidden: job.round.initialUserHidden };
            }
            notify(job);
            job.controller.signal.throwIfAborted();
            assertCurrent(environment);
            const request = await abortable(() => prepareRequest({
                generationId: job.resultId, prompt: requestPrompt, environment,
                continueMessage: continueResultId ? baseText : undefined,
                ...(continueResultId ? { continueExtra } : {}),
                signal: job.controller.signal,
            }), job.controller.signal);
            if (typeof request?.send !== 'function') throw new PlaygroundError('invalid_prepared_request', '提示词处理没有返回可发送的请求，本次没有发送到模型。');
            if (request.context) resultContext = readPlayContext({ ...context, ...request.context,
                ...(environment.independent ? {} : { chatId: context.chatId }), apiMode: context.apiMode, characterName: context.characterName });
            job.context = resultContext;
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
            if (!job.round) {
                if (job.controller.signal.aborted) return null;
                throw error;
            }
            if (finalStatus === 'failed') {
                job.error = publicError(error, job.phase);
                if (retryCount) job.error.message += `\n已自动重试 ${retryCount} 次。`;
            }
        } finally {
            job.closed = true;
            job.finishedAt = now();
            diagnostic?.finish(finalStatus, generationError, { phase: job.phase, receivedCharacters: job.text.length });
            if (job.round) { job.phase = 'saving'; notify(job); }
            if (!job.round) { jobs.delete(job.resultId); job.phase = 'idle'; notify(job); }
        }
        const update = { text: job.text, status: finalStatus, finishedAt: job.finishedAt, context: resultContext,
            ...(job.extra ? { extra: job.extra } : {}),
            ...(job.error ? { error: job.error } : {}) };
        try {
            const round = await history.saveResult(job.round.id, job.resultId, update);
            diagnostics?.info('小剧场回复已保存', { phase: 'saving', savedAt: now() });
            return { roundId: round.id, characterId: round.characterId,
                result: clone(round.savedResult ?? round.results.find(result => result.id === job.resultId)) };
        } catch (error) {
            diagnostics?.error('保存小剧场回复', error, { phase: 'saving' });
            // Deletion in another window is final; a late generation must not
            // recreate it or leave an impossible save retry blocking new sends.
            if (isRemovedResult(error)) return null;
            job.saveError = publicError(error, 'saving');
            job.pendingUpdate = update;
            job.phase = 'save-failed';
            throw new PlaygroundError('history_save_failed', job.saveError.message);
        } finally {
            if (!job.pendingUpdate) { jobs.delete(job.resultId); job.phase = 'idle'; }
            notify(job);
        }
    }

    return {
        availability,
        getState,
        getStates: () => [...jobs.values()].map(readJob),
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
        listChats: characterId => historyAction('读取聊天历史目录', () => history.listChats(characterId)),
        getChatPreview: (id, options) => historyAction('读取历史记录预览', () => history.getChatPreview(id, options)),
        getChatSearch: (id, options) => historyAction('搜索聊天内容', () => history.getChatSearch(id, options)),
        async getChat(id, options) { return withLiveChat(await historyAction('读取分支聊天', () => history.getChat(id, options))); },
        async finishUnfinishedChat(id) {
            assertIdleChat(id);
            const chat = await history.getChat(id);
            for (const message of chat.messages) for (const result of message.results ?? []) {
                if (result.status === 'unfinished') await historyAction('结束未完成回复', () => history.saveResult(id, result.id,
                    { status: 'stopped', finishedAt: now() }));
            }
        },
        createBranch(id, messageId, revision) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            return historyAction('创建分支', () => history.createBranch(id, messageId, revision), true);
        },
        setMessageVersion(id, messageId, resultId, expectedResultId, options = {}) {
            if (options.playSelection) {
                if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            } else assertIdleChat(id);
            return historyAction('切换回复版本', () => history.setMessageVersion(id, messageId, resultId, expectedResultId, options));
        },
        renameChat(id, name, revision) {
            assertIdleChat(id);
            return historyAction('修改聊天名称', () => history.renameChat(id, name, revision), true);
        },
        setMessagesHidden(id, messageIds, hidden, revision) {
            assertIdleChat(id);
            return historyAction('修改楼层显隐', () => history.setMessagesHidden(id, messageIds, hidden, revision), true);
        },
        editMessage(id, messageId, update) {
            assertIdleChat(id);
            return historyAction('保存聊天消息修改', () => history.editMessage(id, messageId, update), true);
        },
        removeMessage(id, messageId, revision) {
            assertIdleChat(id);
            return historyAction('删除聊天消息', () => history.removeMessage(id, messageId, revision), true);
        },
        truncateChat(id, messageId, revision) {
            assertIdleChat(id);
            return historyAction('删除所选消息及后续对话', () => history.truncateChat(id, messageId, revision), true);
        },
        deleteChat(id, revision, options) {
            assertIdleChat(id);
            return historyAction('删除该聊天', () => history.deleteChat(id, revision, options), true);
        },
        addChatFavorite(input) {
            assertIdleChat(input.chatId);
            return historyAction('收藏该聊天', () => history.addChatFavorite(input), true);
        },
        syncChatFavorite(id, input) { return historyAction('更新聊天收藏', () => history.syncChatFavorite(id, input)); },
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
        async retrySave(resultId) {
            const pending = [...jobs.values()].filter(job => job.pendingUpdate);
            if (!resultId && pending.length > 1) throw new PlaygroundError('save_target_required', '请选择要重新保存的回复');
            const job = resultId ? findJob(resultId) : pending[0];
            if (!job) return null;
            if (job.phase !== 'save-failed') throw new PlaygroundError('busy', '这份回复正在生成或保存，请稍后再试');
            job.phase = 'saving';
            notify(job);
            try {
                const round = await history.saveResult(job.round.id, job.resultId, job.pendingUpdate);
                jobs.delete(job.resultId); job.pendingUpdate = null;
                diagnostics?.info('小剧场回复重新保存成功');
                return round;
            } catch (error) {
                diagnostics?.error('重试保存小剧场回复', error, { phase: 'saving' });
                if (isRemovedResult(error)) { jobs.delete(job.resultId); job.pendingUpdate = null; return null; }
                job.saveError = publicError(error, 'saving');
                throw new PlaygroundError('history_save_failed', job.saveError.message);
            }
            finally { job.phase = job.pendingUpdate ? 'save-failed' : 'idle'; notify(job); }
        },
        listCharacters: () => historyAction('读取演出角色列表', () => history.listCharacters()),
        listRounds: characterId => historyAction('读取演出历史目录', () => history.listRounds(characterId)),
        listFavorites: () => historyAction('读取演出收藏列表', () => history.listFavorites()),
        getFavorite: id => historyAction('读取演出收藏', () => history.getFavorite(id)),
        async addFavorite(input) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (findJob(input.resultId)) {
                throw new PlaygroundError('busy', '请在这份回复结束并保存后收藏');
            }
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
            const round = await historyAction('保存提示词修改', () => history.editPrompt(roundId, text, expectedText), true);
            return withLiveResults(round);
        },
        async editResult(roundId, resultId, text, expectedText) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            const job = findJob(resultId);
            if (job && job.phase !== 'save-failed') throw new PlaygroundError('busy', '这条回复正在生成或保存，请结束后再编辑。');
            // A failed final save must be settled before replacing its text, so
            // retrying the generation save can never restore the pre-edit body.
            if (job?.pendingUpdate) await this.retrySave(job.resultId);
            return historyAction('保存回复修改', () => history.editResult(roundId, resultId, text, expectedText), true);
        },
        async removePrompt(roundId, expectedText) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (hasRoundJob(roundId)) {
                throw new PlaygroundError('busy', '这轮回复正在生成或尚未保存，请结束并保存后再删除。');
            }
            const round = await historyAction('删除用户消息', () => history.removePrompt(roundId, expectedText), true);
            return round && withLiveResults(round);
        },
        async removeReply(roundId, expectedResults) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (hasRoundJob(roundId)) {
                throw new PlaygroundError('busy', '这条回复正在生成或尚未保存，请结束并保存后再删除。');
            }
            return historyAction('删除 AI 消息及全部版本', () => history.removeReply(roundId, expectedResults), true);
        },
        async getRound(roundId) {
            const round = await historyAction('读取演出记录', () => history.getRound(roundId));
            return withLiveResults(round);
        },
    };
}
