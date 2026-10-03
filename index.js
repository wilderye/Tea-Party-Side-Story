import { registerTheatreMacros } from './macro-registration.js';
import { createLibraryRequest } from './download-access.js';
import { validateManifest, readPack, collectPacks, selectTheatre, readManuscripts, pruneCommunityFavorites, favoritePool } from './library.js';
import { createTheatrePanel, element, textButton } from './panel.js';
import { syncQrEntry } from './qr-entry.js';

const ctx = () => SillyTavern.getContext();
const settings = ctx().extensionSettings.teahouse ??= { favorites: {}, pageSize: 10, lastId: null, libraryUrl: '' };
settings.favorites ??= {};
settings.enabled ??= true;
settings.qrEnabled ??= false;
settings.edgeEnabled ??= false;
settings.lastFavoriteId ??= null;
const saveSettings = () => ctx().saveSettingsDebounced();
const state = {
    settings, community: new Map(), manuscripts: new Map(), personalError: '', saving: false,
    updating: false, status: '',
    get entries() { return new Map([...this.community, ...this.manuscripts]); },
};
let manifest = null, ui, updateController, qrTask = Promise.resolve();
const packName = pack => `teahouse-${pack.sha256}.json`;
const personalFile = 'teahouse-manuscripts.json';
function notify(message) { state.status = message; ui?.refresh(); }
async function request(url, options = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 60_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}`);
        // Consume the body under the same timeout and cancellation as its headers.
        const bytes = await response.arrayBuffer();
        return new Response(bytes, { status: response.status, headers: response.headers });
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
async function upload(name, value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    await request('/api/files/upload', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name, data: btoa(binary) }) });
}
async function loadCommunity() {
    try {
        const response = await fetch('/user/files/teahouse-index.json', { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
        if (response.status === 404) return;
        if (!response.ok) throw new Error(`读取茶会选集失败 HTTP ${response.status}`);
        const current = validateManifest(await response.json()), packs = [];
        for (const pack of current.packs) {
            const text = await (await request(`/user/files/${packName(pack)}`, { cache: 'no-store' })).text();
            packs.push(await readPack(text, pack));
        }
        state.community = collectPacks(packs); manifest = current;
    } catch (error) { notify(error.message); }
}
async function loadManuscripts() {
    try {
        const response = await fetch(`/user/files/${personalFile}`, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
        if (response.status === 404) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.manuscripts = readManuscripts(await response.json());
    } catch (error) {
        state.personalError = `亲笔手稿读取失败：${error.message}。为保护原文件，暂不能保存或删除手稿，请刷新后重试。`;
    }
}
const loaded = Promise.all([loadCommunity(), loadManuscripts()]);

export async function updateLibrary() {
    if (!settings.enabled || state.updating) return;
    state.updating = true;
    const controller = updateController = new AbortController();
    try {
        await loaded;
        if (controller.signal.aborted) return;
        const base = new URL(settings.libraryUrl);
        if (base.protocol !== 'https:' || base.username || base.password) throw new Error('请在扩展设置中填写 HTTPS 剧场库地址');
        if (!base.pathname.endsWith('/')) base.pathname += '/';
        notify('正在检查更新…');
        const download = await createLibraryRequest(base, (url, options) => request(url, { ...options, signal: controller.signal }));
        const next = validateManifest(await (await download('manifest.json')).json());
        if (manifest && JSON.stringify(next) === JSON.stringify(manifest)) { notify('茶会选集已是最新'); return; }
        const oldPaths = new Set(manifest?.packs.map(x => x.path) ?? []);
        const packs = [], downloaded = [];
        for (const [index, pack] of next.packs.entries()) {
            if (controller.signal.aborted) return;
            notify(`正在更新 ${index + 1} / ${next.packs.length}`);
            const existing = oldPaths.has(pack.path);
            const text = await (existing
                ? await request(`/user/files/${packName(pack)}`, { signal: controller.signal })
                : await download(new URL(pack.path, base))).text();
            packs.push(await readPack(text, pack));
            if (!existing) downloaded.push({ pack, text });
        }
        const nextEntries = collectPacks(packs);
        for (const { pack, text } of downloaded) {
            if (controller.signal.aborted) return;
            await upload(packName(pack), text);
        }
        if (controller.signal.aborted) return;
        // Commit the index last. A failed write leaves the entire old library usable.
        await upload('teahouse-index.json', JSON.stringify(next));
        state.community = nextEntries; manifest = next;
        pruneCommunityFavorites(settings.favorites, state.community);
        saveSettings();
        notify(`茶会选集更新完成，共 ${state.community.size} 条`);
    } catch (error) {
        if (!controller.signal.aborted) notify(`更新未完成：${error.message}。原有剧场保持可用。`);
    } finally { state.updating = false; updateController = null; ui?.refresh(); }
}

async function writeManuscripts(next) {
    await upload(personalFile, JSON.stringify({ format: 1, entries: [...next.values()] }));
    state.manuscripts = next;
}
export async function saveManuscript(draft) {
    await loaded;
    if (!settings.enabled) throw new Error('插件已停用');
    if (state.personalError) throw new Error(state.personalError);
    if (state.saving) throw new Error('手稿正在保存，请稍后再试');
    const previous = draft.id ? state.manuscripts.get(draft.id) : null;
    if (draft.id && !previous) throw new Error('这份手稿已不存在，请返回列表');
    const item = { id: previous?.id ?? `local:${ctx().uuidv4()}`, title: draft.title.trim(), type: draft.type,
        body: draft.body, publishedAt: previous?.publishedAt ?? new Date().toISOString() };
    const next = readManuscripts({ format: 1, entries: [...state.manuscripts.values()].filter(x => x.id !== item.id).concat(item) });
    state.saving = true;
    try { await writeManuscripts(next); return item; }
    finally { state.saving = false; }
}
export async function deleteManuscript(id) {
    await loaded;
    if (!settings.enabled) throw new Error('插件已停用');
    if (state.personalError) throw new Error(state.personalError);
    if (state.saving) throw new Error('手稿正在保存，请稍后再试');
    if (!state.manuscripts.has(id)) return;
    const next = new Map(state.manuscripts); next.delete(id);
    state.saving = true;
    try {
        await writeManuscripts(next);
        delete settings.favorites[id]; saveSettings();
    } finally { state.saving = false; }
}
function toggleFavorite(id) {
    if (!settings.enabled) return;
    if (Object.hasOwn(settings.favorites, id)) delete settings.favorites[id];
    else settings.favorites[id] = Date.now();
    saveSettings();
}

// A generation frame belongs to one character reply, with one independent draw per macro.
let frame = null, preview = false, toolResume = false, resolving = false;
const events = ctx().eventTypes;
ctx().eventSource.on(events.GENERATION_AFTER_COMMANDS, async (type, _options, dryRun) => {
    preview = !!dryRun;
    if (dryRun) return;
    await loaded;
    if (!settings.enabled) { frame = null; return; }
    if (toolResume && frame) { toolResume = false; return; }
    toolResume = false;
    frame = { choices: {}, texts: {}, used: new Set(), original: type === 'continue' ? ctx().chat.at(-1)?.extra?.teahouse ?? {} : {} };
});
ctx().eventSource.on(events.TOOL_CALLS_PERFORMED, () => { if (frame?.used.size) toolResume = true; });
ctx().eventSource.on(events.GENERATION_ENDED, () => {
    const streaming = ctx().streamingProcessor;
    if (streaming && streaming.type !== 'impersonate') recordTheatre(streaming.messageId);
    if (!toolResume) frame = null;
    preview = false;
});
ctx().eventSource.on(events.CHAT_CHANGED, () => { frame = null; preview = false; toolResume = false; });
function theatreMacro(kind) {
    if (!settings.enabled || resolving) return '';
    const active = !preview && frame;
    if (active && Object.hasOwn(frame.texts, kind)) return frame.texts[kind];
    const all = kind === 'community' ? state.community : state.entries;
    const pool = kind === 'community' ? all : favoritePool(all, settings.favorites);
    const lastKey = kind === 'community' ? 'lastId' : 'lastFavoriteId';
    const originalKey = kind === 'community' ? 'id' : 'favoriteId';
    const original = active ? all.get(frame.original[originalKey]) : null;
    // Continuing an existing reply survives unfavoriting, but not deletion or a type change.
    const selected = active
        ? (original?.type === 'preset' ? original : selectTheatre(pool, settings[lastKey]))
        : [...pool.values()].find(x => x.type === 'preset');
    if (!selected) { if (active) frame.texts[kind] = ''; return ''; }
    resolving = true;
    let text;
    try { text = ctx().substituteParams(selected.body); } finally { resolving = false; }
    if (active) {
        frame.choices[kind] = selected.id; frame.texts[kind] = text; frame.used.add(kind);
        settings[lastKey] = selected.id; saveSettings();
    }
    return text;
}
await registerTheatreMacros(ctx(), { community: () => theatreMacro('community'), favorites: () => theatreMacro('favorites') });
function recordTheatre(messageId) {
    if (!settings.enabled || !frame?.used.size || preview) return;
    const message = ctx().chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    const record = {};
    if (frame.used.has('community')) record.id = frame.choices.community;
    if (frame.used.has('favorites')) record.favoriteId = frame.choices.favorites;
    message.extra ??= {}; message.extra.teahouse = record;
    const swipe = message.swipe_info?.[message.swipe_id];
    if (swipe) { swipe.extra ??= {}; swipe.extra.teahouse = { ...record }; }
}
ctx().eventSource.on(events.MESSAGE_RECEIVED, recordTheatre);

export function setEnabled(value) {
    settings.enabled = value;
    if (!value) { updateController?.abort(); frame = null; toolResume = false; notify('插件已停用'); }
    else notify('');
    saveSettings(); syncEntrances(); refreshSettings(); ui?.refresh();
}
function setEntrance(key, value) {
    settings[key] = value; saveSettings(); syncEntrances(); refreshSettings();
}
function syncEntrances() {
    document.querySelector('#teahouse-edge')?.remove();
    if (settings.enabled && settings.edgeEnabled) {
        const edge = textButton('', () => ui.open()); edge.id = 'teahouse-edge'; edge.title = '茶话会小剧场';
        edge.setAttribute('aria-label', '打开茶话会小剧场');
        const icon = element('i', undefined, 'fa-solid fa-chevron-right'); icon.setAttribute('aria-hidden', 'true'); edge.append(icon);
        document.body.append(edge);
    }
    qrTask = qrTask.catch(() => {}).then(() => syncQrEntry(globalThis.quickReplyApi, settings.enabled && settings.qrEnabled))
        .catch(error => notify(error.message));
}
ui = createTheatrePanel(ctx, state, {
    loaded, updateLibrary, saveManuscript, deleteManuscript, toggleFavorite, saveSettings,
    setEnabled, setEntrance,
});
ctx().SlashCommandParser.addCommandObject(ctx().SlashCommand.fromProps({
    name: 'teahouse', helpString: '打开茶话会小剧场', callback: async () => { if (settings.enabled) await ui.open(); return ''; },
}));
if (events.APP_READY) ctx().eventSource.on(events.APP_READY, syncEntrances);

let settingsSection;
function refreshSettings() {
    if (!settingsSection) return;
    for (const [name, input] of Object.entries(settingsSection.controls)) {
        input.checked = settings[name]; input.disabled = name !== 'enabled' && !settings.enabled;
    }
    settingsSection.open.disabled = !settings.enabled;
}
const settingsHost = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
if (settingsHost) {
    const section = element('div', undefined, 'extension_container teahouse-settings');
    section.append(element('h3', '茶话会小剧场'));
    settingsSection = { controls: {} };
    for (const [name, label] of [['enabled','启用插件'], ['qrEnabled','启用 QR 入口'], ['edgeEnabled','启用侧边折叠']]) {
        const row = element('label', undefined, 'checkbox_label'); const input = element('input'); input.type = 'checkbox';
        input.addEventListener('change', () => name === 'enabled' ? setEnabled(input.checked) : setEntrance(name, input.checked));
        row.append(input, element('span', label)); section.append(row); settingsSection.controls[name] = input;
    }
    settingsSection.open = textButton('打开小剧场', () => ui.open()); settingsSection.open.id = 'teahouse-open';
    settingsSection.open.classList.add('menu_button'); section.append(settingsSection.open);
    const label = element('label', '剧场库地址'); const address = element('input');
    address.type = 'password'; address.autocomplete = 'off'; address.className = 'text_pole'; address.placeholder = 'HTTPS 剧场库地址'; address.value = settings.libraryUrl;
    address.addEventListener('change', () => { settings.libraryUrl = address.value.trim(); saveSettings(); });
    label.append(address); section.append(label); settingsHost.append(section); refreshSettings();
    if (!settings.libraryUrl) {
        try {
            const config = await (await request(new URL('config.json', import.meta.url))).json();
            if (config.libraryUrl) { settings.libraryUrl = config.libraryUrl; address.value = config.libraryUrl; saveSettings(); }
        } catch { notify('读取插件配置失败，请在扩展设置中填写剧场库地址。'); }
    }
}
await loaded;
syncEntrances();
if (settings.enabled && settings.libraryUrl) void updateLibrary();
