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

/** Keep only the latest actual send for each reply version, in this page's memory. */
export function createSentPromptCapture() {
    const prompts = new Map(), listeners = new Set();
    let disposed = false;
    return {
        read(resultId) { return structuredClone(prompts.get(resultId) ?? null); },
        record(resultId, body) {
            if (disposed || !resultId) return;
            prompts.set(resultId, readSentPrompt(body));
            for (const listener of listeners) {
                try { listener(); } catch { /* Viewing must not interrupt a model request. */ }
            }
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        dispose() { disposed = true; prompts.clear(); listeners.clear(); },
    };
}

export const sentPromptCapture = typeof window === 'undefined' ? null : createSentPromptCapture();
if (sentPromptCapture) window.addEventListener('pagehide', () => sentPromptCapture.dispose());
