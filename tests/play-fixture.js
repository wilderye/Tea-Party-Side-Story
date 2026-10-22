import { randomUUID } from 'node:crypto';
import { createPlayHistory, PLAY_HISTORY_INDEX } from '../play-history.js';

export const characterA = { avatar: 'A.png', name: '角色A' };
export const characterB = { avatar: 'B.png', name: '角色B' };
export const contextA = { chatId: 'A-main', apiMode: 'tavern', characterName: '角色A', presetName: '当前预设' };
export const time = offset => new Date(Date.UTC(2026, 9, 9, 10, 0, offset)).toISOString();
export const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// The browser integration uses Tavern's real SSE decoder. Unit tests supply
// only its event framing and provider text contract, with synthetic responses.
export const testStreaming = {
    EventSourceStream: class {
        constructor() {
            const decoder = new TextDecoder();
            let buffer = '';
            return new TransformStream({ transform(bytes, controller) {
                buffer += decoder.decode(bytes, { stream: true });
                const events = buffer.split(/\r\n\r\n|\n\n|\r\r/); buffer = events.pop();
                for (const event of events) {
                    const lines = event.split(/\r\n|\n|\r/);
                    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
                    const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
                    if (data) controller.enqueue({ data, type });
                }
            } });
        }
    },
    getStreamingReply(data, state) {
        state.reasoning += data.choices?.[0]?.delta?.reasoning_content || '';
        state.signature = data.signature || state.signature;
        return data.choices?.[0]?.delta?.content || '';
    },
};

export function streamResponse(frames, options = {}) {
    const body = frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' }, ...options });
}

export function mockPlayContext(t, respond, extract = data => data.choices[0].message.content) {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assertGenerateUrl(url);
        return respond(JSON.parse(options.body), options.signal, options);
    });
    return { getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-token' }),
        extractMessageFromData: extract };
}

function assertGenerateUrl(url) {
    if (url !== '/api/backends/chat-completions/generate') throw new Error('Unexpected test request URL');
}

export function memoryFiles() {
    const files = new Map(), writes = [], removals = [];
    let lock = Promise.resolve();
    const io = {
        async readFile(name) { await io.beforeRead?.(name); return files.get(name) ?? null; },
        async writeFile(name, text) {
            await io.beforeWrite?.(name, text);
            writes.push(name); files.set(name, text);
            await io.afterWrite?.(name, text);
        },
        async removeFile(name) { removals.push(name); files.delete(name); },
        withLock(run) {
            const next = lock.catch(() => {}).then(run);
            lock = next;
            return next;
        },
    };
    const createStore = () => createPlayHistory({ ...io, uuid: randomUUID });
    const store = createStore();
    return { files, writes, removals, io, store, createStore,
        directory: () => JSON.parse(files.get(PLAY_HISTORY_INDEX)),
        begin: overrides => store.begin({ character: characterA, prompt: '雨夜重逢的完整提示词',
            origin: { id: 'rain', title: '雨夜重逢' }, resultId: randomUUID(), startedAt: time(0), context: contextA, ...overrides }),
    };
}
