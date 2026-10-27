import { PlaygroundError } from './playground.js';

function hasUpstream429(detail) {
    if (!detail || typeof detail !== 'object') return false;
    return ['status', 'status_code', 'statusCode', 'code'].some(key => detail[key] === 429 || detail[key] === '429')
        || ['error', 'detail', 'quota_error'].some(key => hasUpstream429(detail[key]));
}

function responseError(response, detail) {
    const original = detail?.error ?? detail?.detail ?? detail;
    const message = typeof original === 'string' ? original
        : original?.message || original?.error?.message || original?.code || original?.type;
    const fallback = response.ok ? '接口返回错误，但没有提供错误说明。' : `HTTP ${response.status} ${response.statusText}`.trim();
    const error = new Error(String(message || fallback));
    error.name = 'PlayApiError';
    error.status = response.status; error.statusText = response.statusText;
    if (hasUpstream429(detail)) error.upstreamStatus = 429;
    if (detail != null && typeof detail !== 'string') error.error = detail;
    return error;
}

function hasResponseError(data) {
    return !!(data?.error || data?.detail || data?.quota_error || typeof data?.message === 'string' || data?.type === 'error');
}

async function readJsonResponse(response) {
    const text = await response.text();
    if (response.ok && !text.trim()) throw new PlaygroundError('empty_response', '模型没有返回正文，已保留收到的内容。');
    let data;
    try { data = JSON.parse(text); }
    catch (error) {
        if (!response.ok) throw responseError(response, text);
        // A malformed successful body may contain reply text. Keep the parsing
        // error and HTTP status without attaching that body to diagnostics.
        error.status = response.status; error.statusText = response.statusText;
        throw error;
    }
    if (!response.ok || hasResponseError(data)) throw responseError(response, data);
    return data;
}

function isStreamComplete(data) {
    return data?.type === 'message_stop' || data?.type === 'message-end' || data?.event_type === 'stream-end'
        || data?.done === true || data?.choices?.some(choice => choice?.finish_reason != null)
        || data?.candidates?.some(candidate => candidate?.finishReason);
}

/** Read errors before native text extraction, whose error parser swallows them. */
async function sendCompletionRequest(context, payload, signal, { EventSourceStream, getStreamingReply } = {}, body = JSON.stringify(payload)) {
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST', headers: context.getRequestHeaders(), cache: 'no-cache',
        body, signal,
    });
    if (!response.ok || !payload.stream || /\bjson\b/i.test(response.headers.get('content-type') ?? '')) {
        const data = await readJsonResponse(response);
        if (payload.stream) throw new PlaygroundError('invalid_response', '接口没有返回流式回复。');
        return data;
    }
    if (!response.body) throw new PlaygroundError('invalid_response', '接口没有返回可读取的回复。');
    return async function* () {
        const reader = response.body.pipeThrough(new EventSourceStream()).getReader();
        const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
        let text = '', completed = false, readError;
        try {
            while (true) {
                const { done, value } = await reader.read();
                signal.throwIfAborted();
                if (done) {
                    if (!completed) throw new PlaygroundError('stream_interrupted', '流式连接已结束，但接口没有发送完成标记。');
                    return;
                }
                if (value.data.trim() === '[DONE]') return;
                if (!value.data.trim()) continue;
                let data;
                try { data = JSON.parse(value.data); }
                catch (error) {
                    if (value.type === 'error') throw responseError(response, value.data);
                    throw error;
                }
                if (value.type === 'error' || hasResponseError(data)) throw responseError(response, data);
                completed ||= !!isStreamComplete(data);
                const reply = getStreamingReply(data, state, {
                    chatCompletionSource: payload.chat_completion_source, overrideShowThoughts: true,
                });
                if (typeof reply !== 'string') throw new PlaygroundError('invalid_response', '模型返回的流式正文格式不正确');
                if (!(data?.choices?.[0]?.index > 0)) text += reply;
                yield { text, state };
            }
        } catch (error) { readError = error; throw error; }
        finally {
            // Cancellation must release the HTTP body without replacing the
            // original API/read error with a secondary cleanup error.
            try { await reader.cancel(); }
            catch (error) {
                if (readError && readError !== error && typeof readError === 'object') readError.cleanupError = error;
                else if (!readError && !signal.aborted) throw error;
            } finally { reader.releaseLock(); }
        }
    };
}

export function getCustomApiConnection(api) {
    let url;
    try { url = new URL(api.url); } catch { throw new PlaygroundError('invalid_api_url', '请填写独立 API 的完整地址。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new PlaygroundError('invalid_api_url', '独立 API 地址需要使用 HTTP 或 HTTPS。');
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
    return {
        chat_completion_source: 'custom', custom_url: url.toString().replace(/\/$/, ''),
        // Override Tavern's saved custom key, including for endpoints without a key.
        // JSON is also valid YAML, which is the native custom-header format.
        custom_include_headers: JSON.stringify({ Authorization: api.key ? 'Bearer ' + api.key : '' }),
    };
}

export async function fetchCustomApiModels(context, api, signal) {
    signal?.throwIfAborted();
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST', headers: context.getRequestHeaders(),
        body: JSON.stringify(getCustomApiConnection(api)), signal, cache: 'no-cache',
    });
    const data = await readJsonResponse(response);
    signal?.throwIfAborted();
    if (!Array.isArray(data?.data)) throw new PlaygroundError('invalid_model_list', '接口返回的模型列表格式不正确。');
    return [...new Set(data.data.map(model => model?.id)
        .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Sends an already assembled, processed Chat Completion payload. Sequential
 * retries reuse the same serialized payload; overlapping sends are rejected.
 * The caller must finish native prompt processing before constructing this
 * request. This transport deliberately does not call processRequest/generate:
 * those would assemble prompts again or notify third-party reply handlers.
 * HTTP credentials still come from Tavern. Native provider text/reasoning
 * readers stay responsible for decoding successful replies.
 */
export function createPreparedPlayRequest(context, data, { prefix = '', continueExtra,
    continuationReasoning = '', reasoning, streaming,
    showThoughts = true, processReasoning = text => text } = {}) {
    if (!Array.isArray(data?.messages) || !data.messages.length
        || typeof data.chat_completion_source !== 'string' || !data.chat_completion_source
        || typeof data.model !== 'string' || !data.model) {
        throw new PlaygroundError('invalid_prepared_request', '处理后的模型请求不完整，本次没有发送。');
    }
    const payload = structuredClone(data);
    // A play result stores one response. Do not pay for additional completions
    // that neither the streaming nor the non-streaming reader would retain.
    if (Number(payload.n) > 1) payload.n = 1;
    const extract = context.extractMessageFromData;
    if (typeof context.getRequestHeaders !== 'function' || typeof extract !== 'function'
        || (payload.stream && (typeof streaming?.EventSourceStream !== 'function' || typeof streaming?.getStreamingReply !== 'function'))) {
        throw new PlaygroundError('unsupported_tavern', '当前酒馆缺少独立发送请求所需的接口。');
    }
    const body = JSON.stringify(payload);
    let sending = false;
    return {
        context: { model: payload.model, source: payload.chat_completion_source, stream: !!payload.stream,
            ...(payload.custom_url ? { endpoint: payload.custom_url } : {}) },
        async send({ signal, onText = () => {}, onReasoning = () => {} }) {
            signal?.throwIfAborted();
            if (sending) throw new PlaygroundError('request_already_sending', '这份请求正在发送，请等待本次请求结束。');
            sending = true;
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            signal?.addEventListener('abort', abort, { once: true });
            let iterator;
            try {
                // Store the original model text without evaluating JSON schema
                // output or invoking Tavern's main-chat reply handlers.
                const result = await sendCompletionRequest(context, payload, controller.signal, streaming, body);
                controller.signal.throwIfAborted();
                if (!payload.stream) {
                    const text = extract(result, 'openai') ?? '';
                    if (typeof text !== 'string') throw new PlaygroundError('invalid_response', '模型返回的正文格式不正确');
                    const fullText = prefix + text;
                    const options = { mainApi: 'openai', chatCompletionSource: payload.chat_completion_source, ignoreShowThoughts: true };
                    const extracted = showThoughts ? reasoning?.extractReasoningFromData?.(result, options) ?? '' : '';
                    onReasoning({
                        reasoning: (prefix ? continueExtra?.reasoning || '' : '') + processReasoning(extracted),
                        reasoning_signature: reasoning?.extractReasoningSignatureFromData?.(result, options) ?? null,
                        reasoning_duration: prefix ? continueExtra?.reasoning_duration ?? null : null,
                        api: payload.chat_completion_source, model: payload.model,
                    });
                    onText(fullText);
                    return fullText;
                }
                if (typeof result !== 'function') throw new PlaygroundError('invalid_response', '酒馆没有返回可读取的流式回复');
                iterator = result();
                let text = '';
                let thought = continuationReasoning;
                for await (const chunk of iterator) {
                    controller.signal.throwIfAborted();
                    if (typeof chunk?.text !== 'string') throw new PlaygroundError('invalid_response', '模型返回的流式正文格式不正确');
                    text = chunk.text;
                    // Native streaming keeps the prefix reasoning if a chunk
                    // has no reasoning, and replaces it with new model reasoning.
                    thought = chunk.state?.reasoning || thought;
                    onReasoning({
                        reasoning: processReasoning(thought), reasoning_signature: chunk.state?.signature || null,
                        reasoning_duration: prefix ? continueExtra?.reasoning_duration ?? null : null,
                        api: payload.chat_completion_source, model: payload.model,
                    });
                    onText(prefix + text);
                }
                controller.signal.throwIfAborted();
                return prefix + text;
            } finally {
                controller.abort();
                signal?.removeEventListener('abort', abort);
                try { await iterator?.return?.(); }
                finally { sending = false; }
            }
        },
    };
}
