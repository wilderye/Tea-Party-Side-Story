import { PlayHistoryError } from './play-history.js';

export const HISTORY_FILE_TIMEOUT = 60_000;
const databaseName = 'teahouse-play-history-coordination';
const storeName = 'locks';
const lockKey = 'history';

function ownerId() {
    return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** IndexedDB works on LAN HTTP too. It stores only the current writer's ID and
 * expiry, never history, credentials or a second copy of the user's records.
 * Each file write checks and renews ownership before sending its request.
 * The lease outlasts a file request; a closed page cannot leave a permanent lock.
 */
export function createHistoryLock({ leaseMs = HISTORY_FILE_TIMEOUT * 2, pollMs = 120, now = Date.now } = {}) {
    let connection, queue = Promise.resolve();
    const unavailable = () => new PlayHistoryError('history_storage_unavailable',
        '浏览器未能打开保存所需的本地存储。请确认已允许此网站使用存储，然后重试；已有演出记录仍可查看。');
    function database() {
        if (!connection) {
            connection = new Promise((resolve, reject) => {
                let request, abandoned = false;
                const fail = () => { abandoned = true; reject(unavailable()); };
                try { request = globalThis.indexedDB.open(databaseName, 1); }
                catch { fail(); return; }
                request.onupgradeneeded = () => request.result.createObjectStore(storeName);
                request.onerror = request.onblocked = fail;
                request.onsuccess = () => {
                    const db = request.result;
                    if (abandoned) { db.close(); return; }
                    db.onversionchange = () => { db.close(); connection = null; };
                    resolve(db);
                };
            }).catch(error => { connection = null; throw error; });
        }
        return connection;
    }
    async function update(owner, action) {
        const db = await database();
        return new Promise((resolve, reject) => {
            let transaction, accepted = false;
            try { transaction = db.transaction(storeName, 'readwrite'); }
            catch { connection = null; reject(unavailable()); return; }
            transaction.oncomplete = () => resolve(accepted);
            transaction.onabort = transaction.onerror = () => reject(unavailable());
            const store = transaction.objectStore(storeName), request = store.get(lockKey);
            request.onsuccess = () => {
                const current = request.result, timestamp = now();
                if (action === 'release') {
                    if (current?.owner === owner) store.delete(lockKey);
                } else if (action === 'acquire' ? !current || current.expiresAt <= timestamp
                    : current?.owner === owner && current.expiresAt > timestamp) {
                    store.put({ owner, expiresAt: timestamp + leaseMs }, lockKey);
                    accepted = true;
                }
            };
        });
    }
    function waitForRetry(signal) {
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
            const timer = setTimeout(done, pollMs);
            const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async function locked(run, signal) {
        signal?.throwIfAborted();
        const owner = ownerId();
        let acquired = false;
        const check = async () => {
            if (!await update(owner, 'renew')) throw new PlayHistoryError('history_save_interrupted',
                '本次保存已中断，内容仍保留在当前页面，请重试保存。');
        };
        try {
            while (!acquired) {
                signal?.throwIfAborted();
                acquired = await update(owner, 'acquire');
                if (!acquired) await waitForRetry(signal);
            }
            signal?.throwIfAborted();
            return await run(check);
        }
        finally {
            // An old owner must never release a newer page's lock. A browser
            // storage failure here leaves a bounded lease, not a permanent lock.
            if (acquired) { try { await update(owner, 'release'); } catch { /* lease expires */ } }
        }
    }
    return (run, signal) => {
        const next = queue.catch(() => {}).then(() => locked(run, signal));
        queue = next;
        return next;
    };
}
