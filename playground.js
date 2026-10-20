import { PlayHistoryError, readPlayContext, readPlayOrigin } from './play-history.js';

export class PlaygroundError extends Error {
    constructor(code, message) { super(message); this.name = 'PlaygroundError'; this.code = code; }
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

/**
 * prepareRequest uses the native prompt pipeline and returns
 * { send({ signal, onText }), context? }. onText receives the full text so far.
 * This module neither evaluates outputs nor broadcasts SillyTavern events.
 */
export function createPlayground({ history, captureEnvironment, isCurrent, prepareRequest,
    diagnostics, enabled = () => true, uuid = () => crypto.randomUUID(), now = () => new Date().toISOString(), checkpointMs = 2000 }) {
    let active = null, unsaved = null, retryingSave = false;
    const listeners = new Set();
    function getState() {
        const job = active ?? unsaved?.job;
        if (!job) return { phase: 'idle', unsaved: false };
        return { phase: retryingSave ? 'saving' : active?.phase ?? 'save-failed',
            roundId: job.round?.id ?? null, resultId: job.resultId, characterId: job.round?.characterId ?? null,
            characterName: job.characterName, text: job.text, error: clone(job.saveError ?? job.error ?? null),
            unsaved: !!unsaved || !!job.checkpointError };
    }
    // File contents can lag behind streamed or unsaved text. Returned rounds
    // use the same current result for reads and user-message edits.
    function withLiveResults(round) {
        for (const result of round.results) {
            const job = active?.resultId === result.id ? active : unsaved?.job.resultId === result.id ? unsaved.job : null;
            if (job) {
                result.text = job.text;
                result.status = active === job ? job.phase : 'save-failed';
                if (job.saveError ?? job.error) result.error = clone(job.saveError ?? job.error);
            }
        }
        return round;
    }
    function notify() {
        for (const listener of listeners) {
            try { listener(getState()); }
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
    function availability() {
        if (!enabled()) return { available: false, code: 'disabled', message: '插件已停用' };
        if (active || retryingSave) return { available: false, code: 'busy', message: '已有小剧场正在生成或保存，请先等待或停止' };
        if (unsaved) return { available: false, code: 'unsaved_result', message: '有一份回复尚未保存，请先重试保存' };
        if (typeof prepareRequest !== 'function') return { available: false, code: 'generation_unavailable', message: PLAY_GENERATION_UNAVAILABLE };
        if (prepareRequest.isReady && !prepareRequest.isReady()) return { available: false, code: 'generation_loading', message: '正在载入酒馆的生成接口…' };
        return { available: true };
    }
    function assertCurrent(environment) {
        if (!isCurrent(environment)) throw new PlaygroundError('chat_changed', '酒馆已切换聊天，本次尚未发送到模型；请在当前角色下重新发送。');
    }
    function scheduleCheckpoint(job) {
        if (job.timer || job.checkpointPending || job.closed || checkpointMs <= 0) return;
        job.timer = setTimeout(() => {
            job.timer = null;
            const text = job.text;
            job.checkpointPending = true;
            job.checkpoint = (async () => {
                try {
                    await history.saveResult(job.round.id, job.resultId, { text, status: 'unfinished', finishedAt: null });
                    job.checkpointError = null;
                } catch (error) {
                    if (!job.checkpointError) diagnostics?.error('保存生成中的小剧场', error, { phase: 'saving' });
                    job.checkpointError = true;
                    if (isRemovedResult(error)) job.controller.abort(new DOMException('这条消息已在其他窗口删除或替换', 'AbortError'));
                }
                finally { job.checkpointPending = false; }
                if (active === job && !job.closed) {
                    notify();
                    // Coalesce text received during a slow upload; never build
                    // a queue of obsolete full-text checkpoints behind it.
                    if (job.text !== text) scheduleCheckpoint(job);
                }
            })();
        }, checkpointMs);
        job.timer?.unref?.();
    }
    async function start({ roundId, replaceResultId, continueResultId, characterId, prompt, origin }) {
        const available = availability();
        if (!available.available) throw new PlaygroundError(available.code, available.message);
        if (!roundId && (typeof prompt !== 'string' || !prompt.trim())) throw new PlaygroundError('empty_prompt', '请先输入小剧场提示词');
        // Synchronous capture: later settings changes do not change this request.
        // Only the public context below is saved; environment may contain keys.
        let environment;
        try { environment = clone(captureEnvironment()); }
        catch (error) { diagnostics?.error('读取小剧场生成环境', error); throw error; }
        const context = readPlayContext(environment.context);
        const resultId = continueResultId || uuid();
        let baseText = '';
        const job = { resultId, phase: 'preparing', controller: new AbortController(),
            characterName: environment.character.name, text: '', closed: false, checkpoint: Promise.resolve() };
        const diagnostic = diagnostics?.start(continueResultId ? '小剧场续写' : '小剧场生成', { phase: 'preparing', apiMode: environment.api?.mode },
            [environment.api?.key, environment.tavern?.settings?.proxy_password]);
        let generationError;
        active = job;
        notify();
        let finalStatus = 'complete';
        let resultContext = context;
        try {
            if (continueResultId) {
                const currentRound = await abortable(() => history.getRound(roundId), job.controller.signal);
                const target = currentRound?.results?.find(result => result.id === continueResultId);
                if (!target) throw new PlaygroundError('result_missing', '这份结果已在其他窗口删除或替换，请重新打开记录后再试。');
                if (!target.text.trim()) throw new PlaygroundError('empty_result', '这份结果没有正文，无法续写；请使用重新生成。');
                baseText = target.text;
                job.text = baseText;
                assertCurrent(environment);
            }
            job.round = await history.begin({ roundId, replaceResultId, continueResultId, characterId, character: environment.character,
                prompt, origin: readPlayOrigin(origin), resultId: job.resultId, startedAt: now(), context,
                ...(continueResultId ? { expectedText: baseText } : {}) }, { signal: job.controller.signal });
            notify();
            job.controller.signal.throwIfAborted();
            assertCurrent(environment);
            const request = await abortable(() => prepareRequest({
                generationId: job.resultId, prompt: job.round.prompt, environment,
                continueMessage: continueResultId ? baseText : undefined,
                signal: job.controller.signal,
            }), job.controller.signal);
            if (typeof request?.send !== 'function') throw new PlaygroundError('invalid_prepared_request', '提示词处理没有返回可发送的请求，本次没有发送到模型。');
            if (request.context) resultContext = readPlayContext({ ...context, ...request.context,
                chatId: context.chatId, apiMode: context.apiMode, characterName: context.characterName });
            assertCurrent(environment);
            job.phase = 'generating';
            diagnostic?.update({ ...request.context, phase: 'generating', requestStartedAt: now() });
            notify();
            const result = await abortable(() => request.send({ signal: job.controller.signal,
                onText(text) {
                    if (active !== job || job.closed || job.controller.signal.aborted) return;
                    if (typeof text !== 'string') throw new PlaygroundError('invalid_response', '模型返回的内容格式不正确');
                    if (diagnostic && text && text !== job.text) {
                        const receivedAt = now(), first = !job.text;
                        diagnostic?.update({ ...(first ? { firstContentAt: receivedAt } : {}),
                            lastContentAt: receivedAt, receivedCharacters: text.length });
                    }
                    job.text = text;
                    scheduleCheckpoint(job);
                    notify();
                },
            }), job.controller.signal);
            const text = typeof result === 'string' ? result : result?.text;
            if (typeof text !== 'string' || !(continueResultId ? text.slice(baseText.length) : text).trim()) {
                throw new PlaygroundError('empty_response', '模型没有返回正文，已保留收到的内容。');
            }
            job.text = text;
        } catch (error) {
            generationError = error;
            finalStatus = job.controller.signal.aborted ? 'stopped' : 'failed';
            if (!job.round) {
                if (job.controller.signal.aborted) return null;
                throw error;
            }
            if (finalStatus === 'failed') job.error = publicError(error, job.phase);
        } finally {
            job.closed = true;
            job.finishedAt = now();
            diagnostic?.finish(finalStatus, generationError, { phase: job.phase, receivedCharacters: job.text.length });
            clearTimeout(job.timer);
            if (job.round) { job.phase = 'saving'; notify(); }
            await job.checkpoint;
            if (!job.round) { if (active === job) active = null; notify(); }
        }
        const update = { text: job.text, status: finalStatus, finishedAt: job.finishedAt, context: resultContext,
            ...(job.error ? { error: job.error } : {}) };
        try {
            const round = await history.saveResult(job.round.id, job.resultId, update);
            diagnostics?.info('小剧场回复已保存', { phase: 'saving', savedAt: now() });
            return { roundId: round.id, characterId: round.characterId, result: clone(round.results.find(result => result.id === job.resultId)) };
        } catch (error) {
            diagnostics?.error('保存小剧场回复', error, { phase: 'saving' });
            // Deletion in another window is final; a late generation must not
            // recreate it or leave an impossible save retry blocking new sends.
            if (isRemovedResult(error)) return null;
            job.saveError = publicError(error, 'saving');
            unsaved = { job, update };
            throw new PlaygroundError('history_save_failed', job.saveError.message);
        } finally {
            if (active === job) active = null;
            notify();
        }
    }

    return {
        availability,
        getState,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        send({ characterId, prompt, origin = null }) { return start({ characterId, prompt, origin }); },
        generateAnother(roundId) { return start({ roundId }); },
        regenerate(roundId, resultId) {
            if (!resultId) throw new PlaygroundError('result_missing', '请先选择要重新生成的结果');
            return start({ roundId, replaceResultId: resultId });
        },
        continueResult(roundId, resultId) {
            if (!resultId) throw new PlaygroundError('result_missing', '请先选择要续写的结果');
            return start({ roundId, continueResultId: resultId });
        },
        stop() {
            if (!active || active.closed) return false;
            active.controller.abort(new DOMException('用户停止了本次小剧场生成', 'AbortError'));
            return true;
        },
        async retrySave() {
            if (active || retryingSave) throw new PlaygroundError('busy', '正在保存，请稍后再试');
            if (!unsaved) return null;
            const pending = unsaved;
            retryingSave = true;
            notify();
            try {
                const round = await history.saveResult(pending.job.round.id, pending.job.resultId, pending.update);
                unsaved = null;
                diagnostics?.info('小剧场回复重新保存成功');
                return round;
            } catch (error) {
                diagnostics?.error('重试保存小剧场回复', error, { phase: 'saving' });
                if (isRemovedResult(error)) { unsaved = null; return null; }
                pending.job.saveError = publicError(error, 'saving');
                throw new PlaygroundError('history_save_failed', pending.job.saveError.message);
            }
            finally { retryingSave = false; notify(); }
        },
        listCharacters: () => historyAction('读取演出角色列表', () => history.listCharacters()),
        listRounds: characterId => historyAction('读取演出历史目录', () => history.listRounds(characterId)),
        listFavorites: () => historyAction('读取演出收藏列表', () => history.listFavorites()),
        getFavorite: id => historyAction('读取演出收藏', () => history.getFavorite(id)),
        async addFavorite(input) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (active?.resultId === input.resultId || unsaved?.job.resultId === input.resultId) {
                throw new PlaygroundError('busy', '请在这份回复结束并保存后收藏');
            }
            return historyAction('收藏演出记录', () => history.addFavorite(input), true);
        },
        editFavorite(id, update, revision) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            return historyAction('保存演出收藏修改', () => history.editFavorite(id, update, revision), true);
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
            if (active?.resultId === resultId) throw new PlaygroundError('busy', '这条回复正在生成或保存，请结束后再编辑。');
            // A failed final save must be settled before replacing its text, so
            // retrying the generation save can never restore the pre-edit body.
            if (unsaved?.job.resultId === resultId) await this.retrySave();
            return historyAction('保存回复修改', () => history.editResult(roundId, resultId, text, expectedText), true);
        },
        async removePrompt(roundId, expectedText) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (active?.round?.id === roundId || unsaved?.job.round.id === roundId) {
                throw new PlaygroundError('busy', '这轮回复正在生成或尚未保存，请结束并保存后再删除。');
            }
            const round = await historyAction('删除用户消息', () => history.removePrompt(roundId, expectedText), true);
            return round && withLiveResults(round);
        },
        async removeReply(roundId, expectedResults) {
            if (!enabled()) throw new PlaygroundError('disabled', '插件已停用');
            if (active?.round?.id === roundId || unsaved?.job.round.id === roundId) {
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
