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
