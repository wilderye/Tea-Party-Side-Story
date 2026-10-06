import { registerTheatreGeneration } from './generation.js';
import { createLibraryRequest } from './download-access.js';
import { validateManifest, readPack, collectPacks, readManuscripts, pruneCommunityFavorites } from './library.js';
import { createTheatrePanel, element, textButton } from './panel.js';
import { syncQrEntry } from './qr-entry.js';

const ctx = () => SillyTavern.getContext();
const settings = ctx().extensionSettings.teahouse ??= { favorites: {}, pageSize: 5, lastId: null, libraryUrl: '' };
settings.favorites ??= {};
settings.enabled ??= true;
settings.qrEnabled ??= false;
settings.edgeEnabled ??= false;
if (!['left', 'right'].includes(settings.edgeSide)) settings.edgeSide = 'left';
settings.lastFavoriteId ??= null;
if (!['time', 'random'].includes(settings.sortMode)) settings.sortMode = 'time';
const saveSettings = () => ctx().saveSettingsDebounced();
const state = {
    settings, community: new Map(), manuscripts: new Map(), personalError: '', saving: false,
    updating: false, status: '', statusKind: '',
    get entries() { return new Map([...this.community, ...this.manuscripts]); },
};
let manifest = null, ui, updateController, settingsSection, qrTask = Promise.resolve();
const packName = pack => `teahouse-${pack.sha256}.json`;
const personalFile = 'teahouse-manuscripts.json';
let statusTimer;
function notify(message, kind = '', duration = kind === 'update' ? 5000 : 0) {
    clearTimeout(statusTimer);
    state.status = message; state.statusKind = kind; refreshSettings(); ui?.refresh();
    if (message && duration > 0) {
        statusTimer = setTimeout(() => notify(''), duration);
        statusTimer?.unref?.();
    }
}
export function setLibraryUrl(value) {
    const next = value.trim();
    if (next === settings.libraryUrl) return;
    settings.libraryUrl = next;
    updateController?.abort();
    saveSettings();
    if (state.statusKind === 'update') notify('');
}
function libraryBase(value) {
    if (!value?.trim()) throw new Error('请先在酒馆扩展设置中填写剧场库地址');
    let base;
    try { base = new URL(value.trim()); }
    catch { throw new Error('剧场库地址格式不正确，请填写完整的 HTTPS 地址'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
        throw new Error('请填写不含账号、密码、查询参数或片段的 HTTPS 剧场库地址');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return base;
}
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
    refreshSettings();
    const controller = updateController = new AbortController();
    try {
        await loaded;
        if (controller.signal.aborted) return;
        const base = libraryBase(settings.libraryUrl);
        notify('正在检查更新…', 'update', 0);
        const download = await createLibraryRequest(base, (url, options) => request(url, { ...options, signal: controller.signal }));
        const next = validateManifest(await (await download('manifest.json')).json());
        if (manifest && JSON.stringify(next) === JSON.stringify(manifest)) { notify('茶会选集已是最新', 'update'); return; }
        const oldPaths = new Set(manifest?.packs.map(x => x.path) ?? []);
        const packs = [], downloaded = [];
        for (const [index, pack] of next.packs.entries()) {
            if (controller.signal.aborted) return;
            notify(`正在更新 ${index + 1} / ${next.packs.length}`, 'update', 0);
            let text, items, downloadedPack = false;
            if (oldPaths.has(pack.path)) {
                try {
                    text = await (await request(`/user/files/${packName(pack)}`, { signal: controller.signal })).text();
                    items = await readPack(text, pack);
                } catch (error) { if (controller.signal.aborted) throw error; }
            }
            if (!items) {
                text = await (await download(new URL(pack.path, base))).text();
                items = await readPack(text, pack); downloadedPack = true;
            }
            packs.push(items);
            if (downloadedPack) downloaded.push({ pack, text });
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
        notify(`茶会选集更新完成，共 ${state.community.size} 条`, 'update');
    } catch (error) {
        if (!controller.signal.aborted) notify(`更新未完成：${error.message}。${manifest ? '原有剧场保持可用。' : '请检查地址和网络后重试。'}`, 'update');
    } finally { state.updating = false; updateController = null; refreshSettings(); ui?.refresh(); }
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

const events = ctx().eventTypes;
const generation = await registerTheatreGeneration(ctx, state, loaded, saveSettings);

export function setEnabled(value) {
    settings.enabled = value;
    if (!value) { updateController?.abort(); generation.reset(); notify('插件已停用'); }
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
        edge.dataset.side = settings.edgeSide;
        const icon = element('i', undefined, `fa-solid fa-chevron-${settings.edgeSide === 'right' ? 'left' : 'right'}`); icon.setAttribute('aria-hidden', 'true'); edge.append(icon);
        document.body.append(edge);
    }
    qrTask = qrTask.catch(() => {}).then(() => syncQrEntry(globalThis.quickReplyApi, settings.enabled && settings.qrEnabled))
        .catch(error => notify(error.message));
}
ui = createTheatrePanel(ctx, state, {
    loaded, updateLibrary, saveManuscript, deleteManuscript, toggleFavorite, saveSettings,
});
ctx().SlashCommandParser.addCommandObject(ctx().SlashCommand.fromProps({
    name: 'teahouse', helpString: '打开茶话会小剧场', callback: async () => { if (settings.enabled) await ui.open(); return ''; },
}));
if (events.APP_READY) ctx().eventSource.on(events.APP_READY, syncEntrances);


function refreshSettings() {
    if (!settingsSection) return;
    for (const [name, input] of Object.entries(settingsSection.controls)) {
        input.checked = settings[name]; input.disabled = name !== 'enabled' && !settings.enabled;
    }
    settingsSection.edgeSides.hidden = !settings.edgeEnabled;
    for (const input of settingsSection.edgeSideInputs) {
        input.checked = settings.edgeSide === input.value;
        input.disabled = !settings.enabled || !settings.edgeEnabled;
    }
    settingsSection.open.disabled = !settings.enabled;
    settingsSection.update.disabled = !settings.enabled || state.updating;
    settingsSection.status.textContent = state.statusKind === 'update' ? state.status : '';
    settingsSection.status.hidden = !settingsSection.status.textContent;
}
const settingsHost = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
if (settingsHost) {
    const section = element('div', undefined, 'teahouse-settings');
    const drawer = element('div', undefined, 'inline-drawer');
    const header = element('div', undefined, 'inline-drawer-toggle inline-drawer-header');
    header.append(element('b', '茶话会小剧场'), element('div', undefined, 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const content = element('div', undefined, 'inline-drawer-content');
    const controls = element('div', undefined, 'teahouse-settings-controls');
    content.append(controls); drawer.append(header, content); section.append(drawer);
    settingsSection = { controls: {} };
    for (const [name, label] of [['enabled','启用插件'], ['qrEnabled','快捷回复入口'], ['edgeEnabled','侧边入口']]) {
        const row = element('label', undefined, 'checkbox_label'); const input = element('input'); input.type = 'checkbox';
        input.addEventListener('change', () => name === 'enabled' ? setEnabled(input.checked) : setEntrance(name, input.checked));
        row.append(input, element('span', label)); controls.append(row); settingsSection.controls[name] = input;
    }
    settingsSection.edgeSides = element('div', undefined, 'teahouse-edge-sides');
    settingsSection.edgeSides.setAttribute('role', 'group');
    settingsSection.edgeSides.setAttribute('aria-label', '侧边入口位置');
    settingsSection.edgeSideInputs = [];
    for (const [value, label] of [['left', '左侧边'], ['right', '右侧边']]) {
        const row = element('label', undefined, 'checkbox_label'), input = element('input');
        input.type = 'radio'; input.name = 'teahouse-edge-side'; input.value = value;
        input.addEventListener('change', () => { if (input.checked) setEntrance('edgeSide', value); });
        row.append(input, element('span', label)); settingsSection.edgeSides.append(row);
        settingsSection.edgeSideInputs.push(input);
    }
    controls.append(settingsSection.edgeSides);
    settingsSection.open = textButton('打开剧场', () => ui.open()); settingsSection.open.id = 'teahouse-open';
    settingsSection.open.classList.add('menu_button'); controls.append(settingsSection.open);
    settingsSection.update = textButton('更新茶会选集', updateLibrary);
    settingsSection.update.classList.add('menu_button'); controls.append(settingsSection.update);
    settingsSection.status = element('small'); settingsSection.status.setAttribute('role', 'status'); settingsSection.status.hidden = true; controls.append(settingsSection.status);
    const label = element('label', '剧场库地址'); const address = element('input');
    address.type = 'password'; address.autocomplete = 'off'; address.className = 'text_pole'; address.placeholder = 'HTTPS 剧场库地址'; address.value = settings.libraryUrl;
    address.addEventListener('input', () => setLibraryUrl(address.value));
    address.addEventListener('change', () => { address.value = settings.libraryUrl; });
    label.append(address); controls.append(label); settingsHost.append(section); refreshSettings();
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
