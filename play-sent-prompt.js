// Only prompt-bearing fields are retained. Never keep request headers, API
// credentials, connection settings or the complete serialized request body.
export function readSentPrompt(body) {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    const fields = ['messages', 'prompt', 'system', 'systemInstruction', 'contents', 'preamble',
        'chat_history', 'message', 'documents', 'tools', 'tool_choice', 'toolConfig',
        'response_format', 'json_schema', 'responseSchema'];
    const prompt = {};
    for (const key of fields) {
        if (data?.[key] !== undefined) prompt[key] = structuredClone(data[key]);
    }
    if (data?.generationConfig?.responseSchema) prompt.responseSchema = structuredClone(data.generationConfig.responseSchema);
    return prompt;
}

const roleNames = { system: '系统', developer: '开发者', user: '用户', assistant: '助手', model: '助手', tool: '工具' };

function contentText(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    if (Array.isArray(content)) return content.map(contentText).join('\n');
    if (typeof content.text === 'string') return content.text;
    if (typeof content.thinking === 'string') return content.thinking;
    if (content.type === 'image_url' || content.type === 'image' || content.inlineData || content.fileData) return '[图片或文件内容，无法作为文字显示]';
    if (content.type === 'input_audio' || content.type === 'audio') return '[音频内容，无法作为文字显示]';
    return JSON.stringify(content, null, 2);
}

/** Remove transport JSON, keeping message order and every text character. */
export function formatSentPrompt(prompt) {
    const sections = [];
    const add = (label, text) => sections.push(`【${label}】\n${text}`);
    if (prompt.system !== undefined) add('系统提示词', contentText(prompt.system));
    if (prompt.systemInstruction !== undefined) add('系统提示词', contentText(prompt.systemInstruction.parts ?? prompt.systemInstruction));
    if (prompt.preamble !== undefined) add('系统提示词', contentText(prompt.preamble));
    const messages = prompt.messages ?? prompt.contents ?? prompt.chat_history;
    if (Array.isArray(messages)) messages.forEach((message, index) => {
        const role = message.role ?? '未标注角色', name = message.name ? ` · ${message.name}` : '';
        add(`${index + 1} · ${role}${roleNames[role] ? ` / ${roleNames[role]}` : ''}${name}`,
            contentText(message.content ?? message.parts ?? message.message));
        if (message.reasoning_content !== undefined) add('随消息发送的思考内容', contentText(message.reasoning_content));
        if (message.tool_calls?.length) add('工具调用', JSON.stringify(message.tool_calls, null, 2));
    });
    else if (messages !== undefined) add('提示词', contentText(messages));
    if (prompt.prompt !== undefined) add('提示词', contentText(prompt.prompt));
    if (prompt.message !== undefined) add('当前用户消息', contentText(prompt.message));
    if (prompt.system === undefined && prompt.systemInstruction === undefined && prompt.preamble === undefined
        && messages === undefined && prompt.prompt === undefined && prompt.message === undefined) {
        add('提示词正文', '这个实际发送的请求没有消息正文或系统提示词字段。');
    }
    for (const [key, label] of Object.entries({ documents: '参考文档', tools: '工具定义', tool_choice: '工具选择',
        toolConfig: '工具设置', response_format: '回复格式要求', json_schema: '回复结构要求', responseSchema: '回复结构要求' })) {
        if (prompt[key] !== undefined) add(label, JSON.stringify(prompt[key], null, 2));
    }
    return sections.join('\n\n');
}

/** The server streams each outgoing prompt immediately; neither side writes it to disk. */
export function createSentPromptCapture({ fetchRequest = (...args) => fetch(...args), uuid = () =>
    crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('') } = {}) {
    const session = uuid(), records = [], listeners = new Set();
    let connection, connecting, openingController, disposed = false, unavailable = false, serverStatus = '服务器记录组件尚未连接。';
    const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* Viewing must not interrupt a model request. */ } } };
    const read = () => ({ records: structuredClone(records), serverStatus });
    const receive = data => {
        if (data.type !== 'prompt') return;
        const record = records.find(record => record.id === data.id);
        if (!record) return;
        record.server.push({ prompt: readSentPrompt(data.prompt), sentAt: data.sentAt });
        notify();
    };
    async function connect(context) {
        if (connection || unavailable || disposed) return;
        if (connecting) return connecting;
        connecting = (async () => {
            const controller = new AbortController();
            openingController = controller;
            const timer = setTimeout(() => controller.abort(), 2000);
            let reader;
            try {
                const response = await fetchRequest('/api/plugins/tea-prompt-capture/stream', {
                    method: 'POST', headers: { ...context.getRequestHeaders(), 'X-Tea-Prompt-Session': session },
                    body: '{}', cache: 'no-store', signal: controller.signal,
                });
                if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
                    unavailable = true;
                    serverStatus = '服务器记录组件未安装或未启用，无法取得酒馆发给模型的原文。';
                    await response.body?.cancel(); return;
                }
                reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                const consume = chunk => {
                    buffer += decoder.decode(chunk, { stream: true });
                    const frames = buffer.split('\n\n'); buffer = frames.pop();
                    let ready = false;
                    for (const frame of frames) {
                        const line = frame.split('\n').find(line => line.startsWith('data: '));
                        if (!line) continue;
                        const data = JSON.parse(line.slice(6));
                        ready ||= data.type === 'ready'; receive(data);
                    }
                    return ready;
                };
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) throw new Error('服务器记录连接已结束');
                    if (consume(chunk.value)) break;
                }
                clearTimeout(timer);
                connection = controller; serverStatus = '服务器记录组件已连接。'; notify();
                // Keep reading while a model reply is streaming. Prompt snapshots
                // are sent independently of the model response and never rebuilt.
                void (async () => {
                    try {
                        while (true) {
                            const chunk = await reader.read();
                            if (chunk.done) break;
                            consume(chunk.value);
                        }
                    } catch { /* A restart/disconnect is shown in the viewer. */ }
                    finally {
                        reader.releaseLock();
                        if (connection === controller) {
                            connection = null; records.length = 0;
                            serverStatus = '服务器连接已断开，记录已清空；下次发送时会重新连接。'; notify();
                        }
                    }
                })();
            } catch {
                controller.abort(); await reader?.cancel().catch(() => {}); reader?.releaseLock();
                serverStatus = '服务器记录连接失败；本次仍正常生成，下次发送时会重新连接。';
            } finally { clearTimeout(timer); openingController = null; notify(); }
        })().finally(() => { connecting = null; });
        return connecting;
    }
    return {
        read,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async begin(context, signal, resultId) {
            await connect(context); signal?.throwIfAborted();
            const id = uuid();
            return {
                headers: { 'X-Tea-Prompt-Session': session, 'X-Tea-Prompt-Request': id },
                sent(body) {
                    if (disposed) return;
                    records.push({ id, resultId, sentAt: new Date().toISOString(), browser: readSentPrompt(body), server: [],
                        serverExpected: !!connection, serverStatus });
                    // Bound browser memory; no prompt is written to a storage API.
                    if (records.length > 20) records.shift();
                    notify();
                },
            };
        },
        clear(resultId) {
            for (let index = records.length - 1; index >= 0; index--) {
                if (resultId === undefined || records[index].resultId === resultId) records.splice(index, 1);
            }
            notify();
        },
        dispose() { disposed = true; openingController?.abort(); connection?.abort(); connection = null; records.length = 0; listeners.clear(); },
    };
}

export const sentPromptCapture = typeof window === 'undefined' ? null : createSentPromptCapture();
if (sentPromptCapture) window.addEventListener('pagehide', () => sentPromptCapture.dispose());
