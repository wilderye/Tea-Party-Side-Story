import { createLibraryRequest } from './download-access.js';
import { validateManifest, readPack, collectPacks, selectTheatre, findEntries } from './library.js';
const ctx = () => SillyTavern.getContext();
const key = 'teahouse';
const settings = ctx().extensionSettings[key] ??= { favorites: {}, pageSize: 10, lastId: null, libraryUrl: '' };
settings.favorites ??= {};
const saveSettings = () => ctx().saveSettingsDebounced();
const rootUrl = new URL('.', import.meta.url);
let entries = new Map(), manifest = null, updating = false, status = '', panel = null;
let tab = 'standalone', query = '', page = 0;
const packName = pack => `teahouse-${pack.sha256}.json`;
async function request(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}`);
    return response;
}
async function upload(name, value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return request('/api/files/upload', { method: 'POST', headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name, data: btoa(binary) }) });
}
function notify(text) { status = text; if (panel) render(); }
async function loadLibrary() {
    try {
        const response = await fetch('/user/files/teahouse-index.json', { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
        if (response.status === 404) { notify('尚无剧场，请更新剧场库。'); return; }
        if (!response.ok) throw new Error(`读取剧场库失败 HTTP ${response.status}`);
        const current = validateManifest(await response.json()), packs = [];
        for (const pack of current.packs) {
            const text = await (await request(`/user/files/${packName(pack)}`, { cache: 'no-store' })).text();
            packs.push(await readPack(text, pack));
        }
        entries = collectPacks(packs); manifest = current;
        notify(`共有 ${entries.size} 条剧场`);
    } catch (error) { notify(error.message); }
}
const loaded = loadLibrary();
async function updateLibrary() {
    if (updating) return;
    updating = true;
    try {
        await loaded;
        const base = new URL(settings.libraryUrl);
        if (base.protocol !== 'https:' || base.username || base.password) throw new Error('请填写 HTTPS 剧场库地址');
        if (!base.pathname.endsWith('/')) base.pathname += '/';
        notify('正在检查更新…');
        const download = await createLibraryRequest(base, request);
        const next = validateManifest(await (await download('manifest.json')).json());
        const oldPaths = new Set(manifest?.packs.map(x => x.path) ?? []);
        if (manifest && JSON.stringify(next) === JSON.stringify(manifest)) { notify('已是最新剧场库'); return; }
        const packs = [], downloaded = [];
        for (const [index, pack] of next.packs.entries()) {
            notify(`正在更新 ${index + 1} / ${next.packs.length}`);
            const existing = oldPaths.has(pack.path);
            const url = existing ? `/user/files/${packName(pack)}` : new URL(pack.path, base);
            const text = await (existing ? await request(url) : await download(url)).text();
            packs.push(await readPack(text, pack));
            if (!existing) downloaded.push({ pack, text });
        }
        const nextEntries = collectPacks(packs);
        // The small index is written last; until then all old files remain usable.
        for (const { pack, text } of downloaded) await upload(packName(pack), text);
        await upload('teahouse-index.json', JSON.stringify(next));
        entries = nextEntries; manifest = next;
        for (const id of Object.keys(settings.favorites)) if (!entries.has(id)) delete settings.favorites[id];
        saveSettings();
        notify(`更新完成，共 ${entries.size} 条剧场`);
    } catch (error) { notify(`更新未完成：${error.message}。原有剧场保持可用。`); }
    finally { updating = false; if (panel) render(); }
}
function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function button(text, action) {
    const node = el('button', text, 'menu_button'); node.type = 'button';
    node.addEventListener('click', action); return node;
}
function render() {
    if (!panel) return;
    const search = panel.querySelector('input[type="search"]');
    const focused = document.activeElement === search, cursor = search?.selectionStart;
    panel.replaceChildren();
    const tabs = el('div', undefined, 'tea-toolbar');
    for (const [value, label] of [['standalone','单独剧场'], ['preset','预设剧场'], ['favorites','我的收藏']]) {
        const node = button(label, () => { tab = value; page = 0; render(); });
        node.setAttribute('aria-pressed', String(tab === value)); tabs.append(node);
    }
    const refresh = button('更新剧场库', updateLibrary); refresh.disabled = updating; tabs.append(refresh);
    const controls = el('div', undefined, 'tea-toolbar');
    const input = el('input'); input.type = 'search'; input.className = 'text_pole'; input.placeholder = '搜索标题、正文或署名'; input.value = query;
    input.setAttribute('aria-label', '搜索剧场');
    input.addEventListener('input', () => { query = input.value; page = 0; render(); });
    const size = el('select'); size.className = 'text_pole'; size.setAttribute('aria-label', '每页条数');
    for (const value of [5, 10, 20, 50]) { const option = el('option', `每页 ${value} 条`); option.value = value; size.append(option); }
    size.value = [5,10,20,50].includes(settings.pageSize) ? settings.pageSize : 10;
    size.addEventListener('change', () => { settings.pageSize = Number(size.value); saveSettings(); page = 0; render(); });
    controls.append(input, size);
    const matches = findEntries(entries, { tab, query, favorites: settings.favorites });
    const pageSize = Number(size.value), pages = Math.max(1, Math.ceil(matches.length / pageSize));
    page = Math.min(page, pages - 1);
    const list = el('div', undefined, 'tea-list');
    for (const item of matches.slice(page * pageSize, (page + 1) * pageSize)) {
        const article = el('article'), heading = el('div', undefined, 'tea-toolbar');
        const favorite = Object.hasOwn(settings.favorites, item.id);
        const star = button(favorite ? '★' : '☆', () => {
            if (favorite) delete settings.favorites[item.id]; else settings.favorites[item.id] = Date.now();
            saveSettings(); render();
        });
        star.setAttribute('aria-label', favorite ? '取消收藏' : '收藏'); star.setAttribute('aria-pressed', String(favorite));
        heading.append(el('strong', item.title), star);
        if (item.type === 'standalone') heading.append(button('填入输入框', () => {
            const textarea = document.querySelector('#send_textarea');
            if (!textarea) { notify('当前没有可用的聊天输入框'); return; }
            textarea.value += `${textarea.value ? '\n' : ''}${item.body}`;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            notify('已填入输入框，请自行发送');
        }));
        article.append(heading, el('div', `${item.author} · ${item.type === 'preset' ? '预设剧场' : '单独剧场'}`, 'tea-meta'), el('div', item.body, 'tea-body'));
        list.append(article);
    }
    if (!matches.length) list.append(el('p', '没有符合条件的剧场'));
    const nav = el('div', undefined, 'tea-toolbar');
    const prev = button('上一页', () => { page--; render(); }); prev.disabled = page === 0;
    const next = button('下一页', () => { page++; render(); }); next.disabled = page + 1 >= pages;
    nav.append(prev, el('span', `${page + 1} / ${pages} · ${matches.length} 条`), next);
    const message = el('div', status, 'tea-status'); message.setAttribute('role', 'status');
    panel.append(tabs, controls, message, list, nav);
    if (focused) { input.focus(); if (cursor !== null) input.setSelectionRange(cursor, cursor); }
}
async function openPanel() {
    await loaded;
    panel = el('div'); panel.id = 'teahouse-panel'; render();
    try { await ctx().callGenericPopup(panel, ctx().POPUP_TYPE.TEXT, '', { wide: true, okButton: '关闭' }); }
    finally { panel = null; }
}
// A generation frame is initialized by ST, but selection is lazy: no macro, no draw.
let frame = null, preview = false, toolResume = false, resolving = false;
const events = ctx().eventTypes;
ctx().eventSource.on(events.GENERATION_AFTER_COMMANDS, async (type, _options, dryRun) => {
    preview = !!dryRun;
    if (dryRun) return;
    await loaded;
    if (toolResume && frame) { toolResume = false; return; }
    toolResume = false;
    const last = ctx().chat.at(-1);
    frame = { selected: undefined, text: undefined, used: false,
        originalId: type === 'continue' ? last?.extra?.teahouse?.id : undefined };
});
ctx().eventSource.on(events.TOOL_CALLS_PERFORMED, () => { if (frame?.used) toolResume = true; });
ctx().eventSource.on(events.GENERATION_ENDED, () => { if (!toolResume) frame = null; preview = false; });
ctx().eventSource.on(events.CHAT_CHANGED, () => { frame = null; preview = false; toolResume = false; });
const theatreMacro = () => {
    if (resolving) return '';
    const active = !preview && frame;
    if (active && frame.text !== undefined) return frame.text;
    const selected = active
        ? (frame.selected ??= selectTheatre(entries, settings.lastId, frame.originalId))
        : [...entries.values()].find(x => x.type === 'preset');
    if (!selected) return '';
    resolving = true;
    let text;
    try { text = ctx().substituteParams(selected.body); } finally { resolving = false; }
    if (active) {
        frame.text = text; frame.used = true; settings.lastId = selected.id; saveSettings();
    }
    return text;
};
const power = ctx().powerUserSettings;
if (!power?.experimental_macro_engine) ctx().registerMacro('茶话会小剧场', theatreMacro, '本次生成的茶话会预设剧场');
if (power && 'experimental_macro_engine' in power) {
    // ST 1.19's lexer rejects Chinese identifiers. Its public processor API keeps
    // the user's Chinese macro while delegating execution to one registered handler.
    const { macros } = await import('/scripts/macros/macro-system.js');
    macros.registry.registerMacro('teaPartyTheatreInternal', { category: 'extension',
        description: '茶话会小剧场', handler: theatreMacro });
    macros.engine.addPreProcessor(text => text.replaceAll('{{茶话会小剧场}}', '{{teaPartyTheatreInternal}}'), { source: 'teahouse' });
}
ctx().eventSource.on(events.MESSAGE_RECEIVED, (messageId) => {
    if (!frame?.used || preview) return;
    const message = ctx().chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    message.extra ??= {}; message.extra.teahouse = { id: frame.selected.id };
    // ST copies extra into swipe_info immediately after MESSAGE_RECEIVED.
});
const settingsHost = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
if (settingsHost) {
    const section = el('div', undefined, 'extension_container');
    section.append(el('h3', '茶话会小剧场'), button('打开小剧场', openPanel));
    const address = el('input'); address.type = 'url'; address.className = 'text_pole'; address.placeholder = '剧场库 HTTPS 地址';
    address.value = settings.libraryUrl;
    address.addEventListener('change', () => { settings.libraryUrl = address.value.trim(); saveSettings(); });
    section.append(address); settingsHost.append(section);
    if (!settings.libraryUrl) {
        try {
            const config = await (await request(new URL('config.json', rootUrl))).json();
            if (config.libraryUrl) { settings.libraryUrl = config.libraryUrl; address.value = config.libraryUrl; saveSettings(); }
        } catch (error) { notify(`读取插件配置失败：${error.message}`); }
    }
}
await loaded;
if (settings.libraryUrl) void updateLibrary();
