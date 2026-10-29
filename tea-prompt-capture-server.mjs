import http from 'node:http';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readSentPrompt } from './play-sent-prompt.js';

export const info = {
    id: 'tea-prompt-capture', name: 'Tea Party Sent Prompt Capture',
    description: 'Stream actual outgoing theatre prompts to their originating browser without persistent storage.',
};

/** Observe bytes passed to Node's actual HTTP transport, after Tavern conversion. */
export function installPromptCapture(generateRouter, streamRouter, { transports = [http, https] } = {}) {
    const scope = new AsyncLocalStorage(), sessions = new Map(), restores = [];
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
    const user = request => request.user?.profile?.handle;
    const sessionKey = (handle, session) => JSON.stringify([handle, session]);
    const emit = (session, data) => {
        if (session.closed || session.response.destroyed) return;
        // Do not retain backlogged prompts for a browser that is no longer reading.
        if (session.response.writableLength > 8 * 1024 * 1024) {
            session.response.destroy(); return;
        }
        session.response.write(`data: ${JSON.stringify(data)}\n\n`);
        session.response.flush?.();
    };
    streamRouter.post('/stream', (request, response) => {
        const handle = user(request), sessionId = request.get('X-Tea-Prompt-Session');
        if (!handle) return response.sendStatus(401);
        if (!validId(sessionId)) return response.sendStatus(400);
        const key = sessionKey(handle, sessionId), previous = sessions.get(key);
        previous?.response.end();
        const session = { response, closed: false };
        sessions.set(key, session);
        response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        emit(session, { type: 'ready' });
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15000);
        heartbeat.unref();
        response.on('close', () => {
            clearInterval(heartbeat); session.closed = true;
            if (sessions.get(key) === session) sessions.delete(key);
        });
    });

    // Wrap only this host router's handling. No request bodies, headers or
    // credentials are retained in the async context, and other chats are ignored.
    const originalHandle = generateRouter.handle;
    const wrappedHandle = function (request, response, next) {
        const handle = user(request), sessionId = request.get('X-Tea-Prompt-Session');
        const id = request.get('X-Tea-Prompt-Request');
        const session = validId(sessionId) && sessions.get(sessionKey(handle, sessionId));
        if (!session || !validId(id) || request.method !== 'POST' || request.path !== '/generate') {
            return originalHandle.call(this, request, response, next);
        }
        // Strip our correlation headers before any host code can forward them.
        delete request.headers['x-tea-prompt-session']; delete request.headers['x-tea-prompt-request'];
        return scope.run({ session, id }, () => originalHandle.call(this, request, response, next));
    };
    generateRouter.handle = wrappedHandle;
    restores.push(() => { if (generateRouter.handle === wrappedHandle) generateRouter.handle = originalHandle; });

    for (const transport of transports) {
        const originalRequest = transport.request;
        const wrappedRequest = function (...args) {
            const outgoing = originalRequest.apply(this, args), context = scope.getStore();
            if (!context || context.session.closed || outgoing.method !== 'POST') return outgoing;
            const originalWrite = outgoing.write, originalEnd = outgoing.end;
            let chunks = [], sent = false;
            const remember = (chunk, encoding) => {
                if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
                else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
            };
            const release = () => { chunks = []; };
            outgoing.on('error', release); outgoing.on('close', release);
            outgoing.write = function (chunk, encoding, callback) {
                const result = originalWrite.call(this, chunk, encoding, callback);
                remember(chunk, encoding); return result;
            };
            outgoing.end = function (chunk, encoding, callback) {
                // Record only after end hands the bytes to the real transport.
                const result = originalEnd.call(this, chunk, encoding, callback);
                if (sent) return result;
                sent = true; remember(chunk, encoding);
                try {
                    const prompt = readSentPrompt(Buffer.concat(chunks).toString('utf8'));
                    if (Object.keys(prompt).length) emit(context.session, {
                        type: 'prompt', id: context.id, sentAt: new Date().toISOString(), prompt,
                    });
                } catch { /* Non-JSON auxiliary requests are not model prompts. */ }
                finally { release(); }
                return result;
            };
            return outgoing;
        };
        transport.request = wrappedRequest;
        restores.push(() => { if (transport.request === wrappedRequest) transport.request = originalRequest; });
    }
    return () => {
        for (const restore of restores.reverse()) restore();
        for (const session of sessions.values()) { session.closed = true; session.response.end(); }
        sessions.clear();
    };
}

let cleanup;
export async function init(router) {
    const modulePath = path.resolve(process.cwd(), 'src/endpoints/backends/chat-completions.js');
    const { router: generateRouter } = await import(pathToFileURL(modulePath).href);
    cleanup = installPromptCapture(generateRouter, router);
}
export function exit() { cleanup?.(); cleanup = null; }
