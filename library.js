import { sha256 } from './sha256.js';
export const FORMAT = 1;
export const MAX_PACK_BYTES = 8 * 1024 * 1024;
const idPattern = /^\d{16,22}$/;
export function validateEntry(item) {
    if (!item || !idPattern.test(item.id) || !['standalone', 'preset'].includes(item.type)
        || (item.gore !== undefined && typeof item.gore !== 'boolean')
        || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100
        || typeof item.body !== 'string' || !item.body.trim() || item.body.length > 4000
        || typeof item.author !== 'string' || !item.author.trim() || item.author.length > 100
        || typeof item.publishedAt !== 'string' || !Number.isFinite(Date.parse(item.publishedAt))) {
        throw new Error('剧场文件格式不正确');
    }
    return { id: item.id, title: item.title, type: item.type, body: item.body,
        author: item.author, publishedAt: item.publishedAt, ...(item.gore !== undefined ? { gore: item.gore } : {}) };
}
export const allowsContent = (item, showGore = false) => !!item && (showGore === true || item.gore !== true);
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
export const isManuscript = id => typeof id === 'string' && id.startsWith('local:');
export function readManuscripts(value) {
    if (value?.format !== 1 || !Array.isArray(value.entries)) throw new Error('亲笔手稿文件格式不正确');
    const result = new Map();
    for (const item of value.entries) {
        if (!/^local:[a-f0-9-]{32,36}$/.test(item?.id) || !['standalone', 'preset'].includes(item.type)
            || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100
            || typeof item.body !== 'string' || !item.body.trim()
            || typeof item.publishedAt !== 'string' || !Number.isFinite(Date.parse(item.publishedAt)) || result.has(item.id)) {
            throw new Error('亲笔手稿文件格式不正确');
        }
        result.set(item.id, { id: item.id, title: item.title, type: item.type, body: item.body, publishedAt: item.publishedAt });
    }
    return result;
}
export function pruneCommunityFavorites(favorites, community) {
    for (const id of Object.keys(favorites)) if (!isManuscript(id) && !community.has(id)) delete favorites[id];
}
export function favoritePool(entries, favorites) {
    return new Map([...entries].filter(([id, item]) => item.type === 'preset' && Object.hasOwn(favorites, id)));
}
// Keep only IDs here so edits always read the current story from the library.
// An absent order starts a new shuffle; an existing order keeps its survivors
// and appends new stories, including when the previous list was empty.
export function reconcileRandomOrder(previous, entries, random = Math.random) {
    const ids = entries.map(item => item.id);
    if (previous === undefined) {
        for (let i = ids.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        return ids;
    }
    const current = new Set(ids), known = new Set(previous);
    return previous.filter(id => current.has(id)).concat(ids.filter(id => !known.has(id)));
}
export function findEntries(entries, { tab, scope, type, query = '', favorites = {}, order, showGore = false }) {
    scope ??= tab === 'favorites' ? 'favorites' : 'community';
    type ??= tab === 'favorites' ? undefined : tab;
    const term = query.trim().toLocaleLowerCase();
    const positions = order && new Map(order.map((id, index) => [id, index]));
    return [...entries.values()].filter(x => allowsContent(x, showGore) && (!type || x.type === type)
        && (scope === 'favorites' ? Object.hasOwn(favorites, x.id) : isManuscript(x.id) === (scope === 'local'))
        && (!term || [x.title, x.body, x.author ?? ''].some(value => value.toLocaleLowerCase().includes(term))))
        .sort((a, b) => positions
            ? (positions.get(a.id) ?? positions.size) - (positions.get(b.id) ?? positions.size)
            : scope === 'favorites'
            ? favorites[b.id] - favorites[a.id] || b.id.localeCompare(a.id)
            : Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.id.localeCompare(a.id));
}
