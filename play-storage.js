import { createPlayHistory, PlayHistoryError } from './play-history.js';
import { createHistoryLock, HISTORY_FILE_TIMEOUT } from './play-storage-lock.js';

const readMethods = ['listCharacters', 'listRounds', 'getRound', 'listFavorites', 'getFavorite'];
export const playHistoryMethods = [...readMethods, 'begin', 'saveResult', 'editPrompt', 'editResult', 'renameCharacter',
    'addFavorite', 'editFavorite', 'removeFavorite', 'removePrompt', 'removeReply'];
const workerVersion = 6;

// Shared by the page and the HTTP worker. A timeout includes reading the body.
export function createPlayFiles(getHeaders, beforeWrite = async () => {}) {
    async function checkResponse(response) {
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${text ? `\n${text}` : ''}`);
        }
    }
    async function mutate(url, body) {
        await beforeWrite();
        const response = await fetch(url, { method: 'POST', headers: getHeaders(),
            body: JSON.stringify(body), signal: AbortSignal.timeout(HISTORY_FILE_TIMEOUT) });
        await checkResponse(response);
        await response.text();
    }
    return {
        async readFile(name) {
            const response = await fetch(`/user/files/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(HISTORY_FILE_TIMEOUT) });
            if (response.status === 404) return null;
            await checkResponse(response);
            return response.text();
        },
        async writeFile(name, text) {
            const bytes = new TextEncoder().encode(text);
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            await mutate('/api/files/upload', { name, data: btoa(binary) });
        },
        removeFile: name => mutate('/api/files/delete', { path: `user/files/${name}` }),
    };
}

// The page fallback and the shared worker use the same HTTP lock and history
// rules. Reading files never opens the lock database or requires a worker.
export function createHttpPlayHistory(getHeaders, uuid, withLock = createHistoryLock()) {
    let check;
    return createPlayHistory({ ...createPlayFiles(getHeaders, () => check()), uuid,
        withLock: (run, signal) => withLock(async assertOwner => {
            check = assertOwner;
            try { return await run(); }
            finally { check = null; }
        }, signal) });
}

export function createBrowserPlayHistory(ctx) {
    if (globalThis.navigator?.locks?.request) {
        return createPlayHistory({ ...createPlayFiles(() => ctx().getRequestHeaders()), uuid: () => ctx().uuidv4(),
            withLock: (run, signal) => navigator.locks.request('teahouse-play-history', { signal }, run) });
    }
    const local = createHttpPlayHistory(() => ctx().getRequestHeaders(), () => ctx().uuidv4());
    let worker, connecting, ready, timer, workerUnavailable = typeof SharedWorker !== 'function';
    const pending = new Map();
    function fail() {
        workerUnavailable = true;
        clearTimeout(timer);
        worker?.port.close(); worker = null;
        ready?.(null); ready = null;
        for (const { reject } of pending.values()) reject(new PlayHistoryError('history_worker_unavailable',
            '演出记录保存连接已中断，请重试保存。'));
        pending.clear();
    }
    function connect() {
        if (workerUnavailable) return null;
        if (connecting) return connecting;
        connecting = new Promise(resolve => { ready = resolve; });
        // Wait for module support/loading before dispatching any write. Only
        // initialization failure may fall back automatically; an unacknowledged
        // write is left for the existing save-retry flow, never replayed here.
        try {
            worker = new SharedWorker(new URL(`./play-storage-worker.js?v=${workerVersion}`, import.meta.url),
                { type: 'module', name: `teahouse-play-history-v${workerVersion}` });
        } catch { fail(); return connecting; }
        timer = setTimeout(fail, 5000);
        worker.onerror = event => { event.preventDefault(); fail(); };
        worker.port.onmessageerror = fail;
        worker.port.onmessage = ({ data }) => {
            if (workerUnavailable) return;
            if (data?.ready === true) {
                clearTimeout(timer); ready?.(worker.port); ready = null;
                return;
            }
            const task = pending.get(data?.id);
            if (!task) return;
            pending.delete(data.id);
            if (data.error) task.reject(new PlayHistoryError(data.error.code, data.error.message));
            else task.resolve(data.value);
        };
        return connecting;
    }
    async function waitForConnection(signal) {
        signal?.throwIfAborted();
        const connection = connect();
        if (!signal || !connection) return connection;
        return new Promise((resolve, reject) => {
            const cleanup = () => signal.removeEventListener('abort', abort);
            const abort = () => { cleanup(); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            connection.then(port => { cleanup(); resolve(port); }, error => { cleanup(); reject(error); });
        });
    }
    return Object.fromEntries(playHistoryMethods.map(method => [method, async (...args) => {
        if (readMethods.includes(method)) return local[method](...args);
        const signal = method === 'begin' ? args[1]?.signal : undefined;
        const port = await waitForConnection(signal);
        signal?.throwIfAborted();
        if (!port || workerUnavailable) return local[method](...args);
        const id = ctx().uuidv4();
        const headers = Object.fromEntries(new Headers(ctx().getRequestHeaders()));
        return new Promise((resolve, reject) => {
            // The worker acknowledges cancellation only before its commit starts.
            // A commit already in progress returns normally and is saved as stopped.
            const abort = () => { try { port.postMessage({ id, cancel: true }); } catch { fail(); } };
            const cleanup = () => signal?.removeEventListener('abort', abort);
            pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
            signal?.addEventListener('abort', abort, { once: true });
            try { port.postMessage({ id, method, args: method === 'begin' ? [args[0]] : args, headers }); }
            catch (error) { pending.delete(id); cleanup(); reject(error); }
        });
    }]));
}
