import { sha256 } from './sha256.js';
export const FORMAT = 1;
export const MAX_PACK_BYTES = 8 * 1024 * 1024;
const idPattern = /^\d{16,22}$/;
export function validateEntry(item) {
    if (!item || !idPattern.test(item.id) || !['standalone', 'preset'].includes(item.type)
        || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100
        || typeof item.body !== 'string' || !item.body.trim() || item.body.length > 4000
        || typeof item.author !== 'string' || !item.author.trim() || item.author.length > 100
        || typeof item.publishedAt !== 'string' || !Number.isFinite(Date.parse(item.publishedAt))) {
        throw new Error('剧场文件格式不正确');
    }
    return { id: item.id, title: item.title, type: item.type, body: item.body,
        author: item.author, publishedAt: item.publishedAt };
}
export async function hash(text) {
    const bytes = new TextEncoder().encode(text);
    return sha256(bytes);
}
export function validateManifest(value) {
    if (value?.format !== FORMAT || !Array.isArray(value.packs)) throw new Error('不支持的剧场库格式');
    const paths = new Set();
    for (const pack of value.packs) {
        if (!/^packs\/\d{4}-\d{2}-\d+-[a-f0-9]{64}\.json$/.test(pack.path)
            || !/^[a-f0-9]{64}$/.test(pack.sha256) || !pack.path.endsWith(`-${pack.sha256}.json`)
            || !Number.isSafeInteger(pack.bytes) || pack.bytes < 2 || pack.bytes > MAX_PACK_BYTES
            || !Number.isSafeInteger(pack.count) || pack.count < 1 || paths.has(pack.path)) {
            throw new Error('剧场清单不完整或格式错误');
        }
        paths.add(pack.path);
    }
    return value;
}
export async function readPack(text, pack) {
    if (new TextEncoder().encode(text).length !== pack.bytes || await hash(text) !== pack.sha256) {
        throw new Error('剧场包校验失败，保留原有版本');
    }
    const items = JSON.parse(text);
    if (!Array.isArray(items) || items.length !== pack.count) throw new Error('剧场数量不一致');
    return items.map(validateEntry);
}
export function collectPacks(packs) {
    const entries = new Map();
    for (const items of packs) for (const item of items) {
        if (entries.has(item.id)) throw new Error('剧场编号重复');
        entries.set(item.id, item);
    }
    return entries;
}
export function selectTheatre(entries, lastId, originalId, random = Math.random) {
    const pool = [...entries.values()].filter(x => x.type === 'preset');
    const original = pool.find(x => x.id === originalId);
    if (original) return original;
    const choices = pool.length > 1 ? pool.filter(x => x.id !== lastId) : pool;
    return choices.length ? choices[Math.floor(random() * choices.length)] : null;
}
export function findEntries(entries, { tab, query = '', favorites = {} }) {
    const term = query.trim().toLocaleLowerCase();
    return [...entries.values()].filter(x => (tab === 'favorites' ? Object.hasOwn(favorites, x.id) : x.type === tab)
        && (!term || [x.title, x.body, x.author].some(value => value.toLocaleLowerCase().includes(term))))
        .sort((a, b) => tab === 'favorites'
            ? favorites[b.id] - favorites[a.id] || b.id.localeCompare(a.id)
            : Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.id.localeCompare(a.id));
}
