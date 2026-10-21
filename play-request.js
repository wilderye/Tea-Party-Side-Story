import { PlaygroundError } from './playground.js';

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
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        error.status = response.status; error.statusText = response.statusText;
        throw error;
    }
    const data = await response.json();
    signal?.throwIfAborted();
    if (data?.error) {
        const message = typeof data.error === 'string' ? data.error : data.error.message;
        throw new PlaygroundError('model_list_failed', message || '接口未能返回模型列表。');
    }
    if (!Array.isArray(data?.data)) throw new PlaygroundError('invalid_model_list', '接口返回的模型列表格式不正确。');
    return [...new Set(data.data.map(model => model?.id)
        .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Sends an already assembled, processed Chat Completion payload exactly once.
 * The caller must finish native prompt processing before constructing this
 * request. This transport deliberately does not call processRequest/generate:
 * those would assemble prompts again or notify third-party reply handlers.
 * Both ST 1.14 and 1.19 expose ChatCompletionService.sendRequest.
 */
export function createPreparedPlayRequest(context, data, { prefix = '', continueExtra,
    continuationReasoning = '', reasoning, showThoughts = true, processReasoning = text => text } = {}) {
    if (!Array.isArray(data?.messages) || !data.messages.length
        || typeof data.chat_completion_source !== 'string' || !data.chat_completion_source
        || typeof data.model !== 'string' || !data.model) {
        throw new PlaygroundError('invalid_prepared_request', '处理后的模型请求不完整，本次没有发送。');
    }
    const payload = structuredClone(data);
    // A play result stores one response. Do not pay for additional completions
    // that neither the streaming nor the non-streaming reader would retain.
    if (Number(payload.n) > 1) payload.n = 1;
    const service = context.ChatCompletionService;
    const extract = context.extractMessageFromData;
    if (typeof service?.sendRequest !== 'function' || typeof extract !== 'function') {
        throw new PlaygroundError('unsupported_tavern', '当前酒馆缺少独立发送请求所需的接口。');
    }
    let sent = false;
    return {
        context: { model: payload.model, source: payload.chat_completion_source, stream: !!payload.stream,
            ...(payload.custom_url ? { endpoint: payload.custom_url } : {}) },
        async send({ signal, onText = () => {}, onReasoning = () => {} }) {
            signal?.throwIfAborted();
            if (sent) throw new PlaygroundError('request_already_sent', '这份请求已经发送；再次生成必须重新处理当前预设和聊天。');
            sent = true;
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            signal?.addEventListener('abort', abort, { once: true });
            let iterator;
            try {
                // extractData=false also avoids JSON-schema postprocessing:
                // store the model's original text, not an evaluated object.
                const result = await service.sendRequest(payload, false, controller.signal);
                controller.signal.throwIfAborted();
                if (!payload.stream) {
                    const text = extract(result, 'openai');
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
                        reasoning: processReasoning(thought), reasoning_signature: chunk.state?.signature ?? null,
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
                await iterator?.return?.();
            }
        },
    };
}
