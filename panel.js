import { findEntries, isManuscript, reconcileRandomOrder } from './library.js';
import { renderMarkdown } from './markdown.js';

export function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
export function textButton(text, action) {
    const node = element('button', text); node.type = 'button';
    node.addEventListener('click', action); return node;
}
const paths = {
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', plus: '<path d="M12 4v16M4 12h16"/>',
    left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m10 6 6 6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>', up: '<path d="m6 15 6-6 6 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    settings: '<path d="M5 4v16M12 4v16M19 4v16M2 8h6M9 16h6M16 9h6"/>',
    edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
    save: '<path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/>',
    insert: '<path d="M14 4h6v16H4v-6M3 8h11m-4-4 4 4-4 4"/>',
    refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
    sort: '<path d="M3 6h18M6 12h12M9 18h6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    cup: '<path d="M4 9h14v6a6 6 0 0 1-12 0V9M18 10h2a3 3 0 0 1 0 6h-2M3 22h18M9 6c-3-2 3-3 0-5M14 6c-3-2 3-3 0-5"/>',
    asterisk: '<path d="M12 4v16M4 12h16M6.35 6.35l11.3 11.3M6.35 17.65l11.3-11.3"/>',
};
function glyph(name) {
    const holder = element('span', undefined, 'tea-glyph');
    holder.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
    return holder;
}
function iconButton(name, label, action) {
    const node = textButton('', action); node.className = 'tea-icon'; node.title = label;
    node.setAttribute('aria-label', label); node.append(glyph(name)); return node;
}
function art() {
    const node = element('div', undefined, 'tea-art'); node.setAttribute('aria-hidden', 'true');
    const img = element('img'); img.src = new URL('./assets/tea-party.svg', import.meta.url).href; img.alt = '';
    const mark = glyph('asterisk'); mark.classList.add('tea-art-mark');
    node.append(img, mark); return node;
}
const typeLabel = type => type === 'preset' ? '随文剧场' : '独立剧场';
const scopeLabel = scope => ({ community: '茶会选集', favorites: '我的收藏', local: '亲笔手稿' })[scope];

export function createTheatrePanel(ctx, state, actions) {
    let panel, popup, opening = false, observer, measureFrame, resizeViewport, media;
    let scope = 'community', type = '', query = '', page = 0, mode = 'list', selectedId = null;
    let draft, originalDraft, busy = false, confirming = false, message = '', messageTimer, returnScroll = 0;
    let searchComposing = false, mobileSearchOpen = false;
    const expanded = new Set();
    const randomOrders = new Map();
    const sortMode = () => state.settings.sortMode === 'random' ? 'random' : 'time';
    const scopeEntries = value => findEntries(state.entries, { scope: value, favorites: state.settings.favorites, showGore: state.settings.showGore });
    function syncRandomOrders() {
        const scopes = new Set(randomOrders.keys());
        if (panel && sortMode() === 'random') scopes.add(scope);
        for (const value of scopes) randomOrders.set(value, reconcileRandomOrder(randomOrders.get(value), scopeEntries(value)));
    }
    const dirty = () => mode === 'editor' && JSON.stringify(draft) !== originalDraft;
    let desktopStarts = [0];
    const mobilePageSize = () => [5, 10, 20, 50].includes(state.settings.pageSize) ? state.settings.pageSize : 5;
    const bodyFontSize = () => media?.matches
        ? ([15, 16, 18].includes(state.settings.mobileFontSize) ? state.settings.mobileFontSize : 15)
        : (state.settings.fontSize === 18 ? 18 : 16);
    const pageStart = () => media?.matches ? page * mobilePageSize() : desktopStarts[page] ?? 0;
    const pageCount = total => media?.matches ? Math.max(1, Math.ceil(total / mobilePageSize())) : desktopStarts.length;
    const pageForIndex = index => media?.matches ? Math.max(0, Math.floor(index / mobilePageSize())) : Math.max(0, desktopStarts.findLastIndex(start => start <= index));
    const matches = () => findEntries(state.entries, { scope, type, query, favorites: state.settings.favorites, showGore: state.settings.showGore,
        order: sortMode() === 'random' ? randomOrders.get(scope) : undefined });
    async function confirm(text, actionLabel) {
        return await ctx().callGenericPopup(element('div', text, 'tea-confirm'), ctx().POPUP_TYPE.CONFIRM, '',
            { okButton: actionLabel, cancelButton: '取消' }) === ctx().POPUP_RESULT.AFFIRMATIVE;
    }
    async function canLeave() {
        if (busy || confirming) return false;
        if (!dirty()) return true;
        confirming = true;
        try { return await confirm('手稿有未保存的修改，确定放弃吗？', '放弃修改'); }
        finally { confirming = false; }
    }
    async function close() { if (popup) await popup.complete(ctx().POPUP_RESULT.CANCELLED); }
    async function back() {
        if (!await canLeave()) return;
        mode = mode === 'help' ? 'settings' : 'list'; message = ''; render();
        const list = panel.querySelector('.tea-list'); if (list) list.scrollTop = returnScroll;
    }
    function showMessage(text) {
        clearTimeout(messageTimer);
        message = text;
        const status = panel?.querySelector('.tea-status');
        if (status) { status.textContent = message || state.status; status.hidden = !status.textContent; }
        if (text) messageTimer = setTimeout(() => showMessage(''), 5000);
    }
    function measureBodies() {
        cancelAnimationFrame(measureFrame);
        measureFrame = requestAnimationFrame(() => {
            if (!panel) return;
            if (!media.matches) {
                const list = panel.querySelector('.tea-list');
                const height = list.clientHeight;
                if (!height) return;
                const result = matches();
                const probe = element('div', undefined, 'tea-catalog-measure');
                probe.style.width = `${list.clientWidth}px`;
                for (const item of result) probe.append(catalogItem(item));
                list.parentElement.append(probe);
                const starts = [0]; let used = 0;
                for (const [index, row] of [...probe.children].entries()) {
                    const rowHeight = row.getBoundingClientRect().height;
                    if (used > 0 && used + rowHeight > height + 0.5) { starts.push(index); used = 0; }
                    used += rowHeight;
                }
                probe.remove();
                if (JSON.stringify(starts) !== JSON.stringify(desktopStarts)) {
                    const anchor = result.findIndex(item => item.id === selectedId);
                    desktopStarts = starts;
                    page = anchor >= 0 ? pageForIndex(anchor) : Math.min(page, starts.length - 1);
                    render();
                }
                return;
            }
            for (const article of panel.querySelectorAll('.tea-feed-entry')) {
                const body = article.querySelector('.tea-body'), toggle = article.querySelector('.tea-fold');
                const long = body.scrollHeight > 320;
                article.classList.toggle('tea-long', long); toggle.hidden = !long;
                const clipped = long && !expanded.has(article.dataset.id);
                for (const node of body.querySelectorAll('a, [tabindex]')) {
                    if (clipped) node.setAttribute('tabindex', '-1');
                    else if (node.tagName === 'A') node.removeAttribute('tabindex');
                    else node.setAttribute('tabindex', '0');
                }
            }
        });
    }
    async function navigate(change) {
        if (!await canLeave()) return;
        change(); mode = 'list'; page = 0; selectedId = null; message = ''; returnScroll = 0;
        render(); panel.querySelector('.tea-list').scrollTop = 0;
    }
    function reshuffle() {
        return navigate(() => randomOrders.set(scope, reconcileRandomOrder(undefined, scopeEntries(scope))));
    }
    async function beginEdit(item) {
        if (!await canLeave() || state.personalError || !state.settings.enabled) return;
        returnScroll = panel.querySelector('.tea-list')?.scrollTop ?? 0;
        draft = item ? { id: item.id, title: item.title, type: item.type, body: item.body }
            : { title: '', type: type || 'standalone', body: '' };
        originalDraft = JSON.stringify(draft); mode = 'editor'; message = ''; render();
    }
    function openSettings() {
        returnScroll = panel.querySelector('.tea-list')?.scrollTop ?? 0;
        mode = 'settings'; message = ''; render();
    }
    async function select(item) {
        if (!state.settings.enabled || item.type !== 'standalone') return;
        const input = document.querySelector('#send_textarea');
        if (!input) { showMessage('当前没有可用的聊天输入框'); return; }
        input.value += `${input.value ? '\n' : ''}${item.body}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await close(); input.focus();
    }
    function tabs() {
        const nav = element('nav', undefined, 'tea-tabs'); nav.setAttribute('aria-label', '内容栏目');
        for (const value of ['community', 'favorites', 'local']) {
            const button = textButton(scopeLabel(value), () => navigate(() => { scope = value; }));
            button.setAttribute('aria-pressed', String(scope === value)); nav.append(button);
        }
        return nav;
    }
    function topActions() {
        const box = element('div', undefined, 'tea-actions');
        const add = iconButton('plus', '新建手稿', () => beginEdit()); add.disabled = !!state.personalError || !state.settings.enabled;
        box.append(add, iconButton('settings', '设置', openSettings), iconButton('close', '关闭面板', close));
        return box;
    }
    function render() {
        if (!panel || searchComposing) return;
        syncRandomOrders();
        const oldList = panel.querySelector('.tea-list'), scroll = oldList?.scrollTop ?? 0;
        const oldReading = panel.querySelector('.tea-reading');
        const readingScroll = oldReading?.scrollTop ?? 0;
        const oldSearch = panel.querySelector('input[type="search"]');
        const focused = oldSearch && document.activeElement === oldSearch;
        const selection = focused ? [oldSearch.selectionStart, oldSearch.selectionEnd, oldSearch.selectionDirection] : null;
        const focusedControl = panel.contains(document.activeElement) ? document.activeElement.closest('button, select, input[role="switch"]') : null;
        const focusKey = focusedControl?.getAttribute('aria-label');
        observer?.disconnect(); panel.replaceChildren(); panel.dataset.mode = mode;
        panel.style.setProperty('--tea-body-size', `${bodyFontSize()}px`);
        panel.classList.toggle('tea-compact', !!state.settings.compact);
        panel.classList.toggle('tea-searching', media.matches && (mobileSearchOpen || !!query));
        const result = matches();
        page = Math.max(0, Math.min(page, pageCount(result.length) - 1));
        const visible = result.slice(pageStart(), media.matches ? pageStart() + mobilePageSize() : desktopStarts[page + 1] ?? result.length);
        if (!visible.some(item => item.id === selectedId)) selectedId = visible[0]?.id ?? null;
        const catalog = renderCatalog(visible, result.length); panel.append(catalog);
        const workspace = element('section', undefined, 'tea-workspace'); workspace.setAttribute('aria-label', '阅读与编辑');
        if (mode === 'list') {
            const topbar = element('header', undefined, 'tea-topbar'); topbar.append(tabs(), topActions()); workspace.append(topbar);
            if (!state.settings.enabled) workspace.append(element('p', '插件已停用，请在酒馆扩展设置中重新启用。', 'tea-empty'));
            else if (selectedId) renderReader(workspace, visible.find(item => item.id === selectedId));
            else workspace.append(art(), element('h2', '下一场故事，等你入座', 'tea-empty-title'), element('p', emptyText(), 'tea-empty'));
        } else {
            const title = element('header', undefined, 'tea-view-title'), titleText = element('div');
            titleText.append(element('h2', mode === 'editor' ? draft.id ? '编辑手稿' : '新的一页' : mode === 'settings' ? '设置' : '随文剧场用法'));
            if (mode === 'editor') titleText.append(element('p', '把一个念头，写成一场小剧场。'));
            const exit = iconButton('close', mode === 'editor' ? '关闭编辑，返回列表' : mode === 'help' ? '返回设置' : '返回列表', back); exit.disabled = busy;
            title.append(titleText, exit); workspace.append(title);
            if (mode === 'editor') renderEditor(workspace);
            else if (mode === 'settings') renderSettings(workspace);
            else renderHelp(workspace);
        }
        panel.append(workspace);
        const status = element('div', message || (mode === 'settings' && state.statusKind === 'update' ? '' : state.status), 'tea-status'); status.setAttribute('role', 'status'); status.hidden = !status.textContent; panel.append(status);
        const list = panel.querySelector('.tea-list'); list.scrollTop = scroll;
        const reading = panel.querySelector('.tea-reading');
        if (reading && oldReading?.dataset.id === selectedId) reading.scrollTop = readingScroll;
        if (focused && panel.querySelector('input[type="search"]')?.getClientRects().length) {
            const search = panel.querySelector('input[type="search"]');
            search.focus({ preventScroll: true });
            search.setSelectionRange(...selection);
        }
        else if (focusKey) [...panel.querySelectorAll('button, select, input[role="switch"]')].find(b => b.getAttribute('aria-label') === focusKey && b.getClientRects().length)?.focus({ preventScroll: true });
        observer?.observe(list);
        for (const body of panel.querySelectorAll('.tea-feed-entry .tea-body')) observer?.observe(body);
        measureBodies();
    }
    function emptyText() {
        return query.trim() ? '没有找到符合条件的小剧场，换个词试试。' : scope === 'favorites' ? '这里还没有符合分类的收藏。'
            : scope === 'local' ? '点击上方加号，写下你的第一份手稿。\n亲笔手稿仅保存在本地，不会上传至茶会选集分享。' : '当前分类和内容偏好下没有可显示的剧场。';
    }
    function catalogItem(item, number = 1) {
        const row = element('button', undefined, 'tea-story'); row.type = 'button';
        const text = element('span');
        text.append(element('span', item.title, 'tea-story-title'), element('small', `${typeLabel(item.type)} · ${item.author || '我'}`));
        if (item.gore) text.firstChild.prepend(element('span', 'G向', 'tea-content-tag'));
        row.append(element('span', String(number).padStart(2, '0'), 'tea-number'), text);
        return row;
    }
    function sortControl() {
        const details = element('details', undefined, 'tea-sort');
        const summary = element('summary', undefined, 'tea-icon');
        summary.setAttribute('role', 'button'); summary.setAttribute('aria-label', '排序方式');
        summary.setAttribute('aria-haspopup', 'menu'); summary.setAttribute('aria-expanded', 'false');
        summary.setAttribute('aria-controls', 'tea-sort-menu');
        summary.title = `排序：${sortMode() === 'random' ? '随机顺序' : '时间顺序'}`;
        summary.append(glyph('sort'));
        const menu = element('div', undefined, 'tea-sort-menu'); menu.id = 'tea-sort-menu';
        menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '排序方式');
        for (const [value, label] of [['time', '时间顺序'], ['random', '随机顺序']]) {
            const button = textButton('', async () => {
                details.open = false;
                if (value !== sortMode()) await navigate(() => { state.settings.sortMode = value; actions.saveSettings(); });
                panel?.querySelector('.tea-sort summary')?.focus({ preventScroll: true });
            });
            button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(sortMode() === value));
            button.tabIndex = -1;
            button.append(element('span', label), glyph('check')); menu.append(button);
        }
        if (media.matches && sortMode() === 'random') {
            const shuffle = textButton('重新打乱', async () => {
                details.open = false; await reshuffle();
                panel?.querySelector('.tea-sort summary')?.focus({ preventScroll: true });
            });
            shuffle.className = 'tea-sort-reshuffle'; shuffle.setAttribute('role', 'menuitem'); shuffle.tabIndex = -1;
            shuffle.disabled = !state.settings.enabled; shuffle.append(glyph('refresh')); menu.append(shuffle);
        }
        const choices = [...menu.children];
        summary.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault(); details.open = true;
            choices[event.key === 'ArrowDown' ? 0 : choices.length - 1].focus();
        });
        details.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(details.open)));
        details.addEventListener('focusout', event => {
            if (!details.contains(event.relatedTarget)) details.open = false;
        });
        details.addEventListener('keydown', event => {
            if (!details.open) return;
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus();
            } else if (menu.contains(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const index = choices.indexOf(document.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
                choices[next].focus();
            }
        });
        details.append(summary, menu); return details;
    }
    function renderCatalog(visible, total) {
        const catalog = element('aside', undefined, 'tea-catalog'); catalog.setAttribute('aria-label', '小剧场目录');
        const brand = element('header', undefined, 'tea-brand'), name = element('div');
        name.append(element('h1', '茶话会'), element('p', '小 剧 场')); brand.append(glyph('cup'), name);
        const mobileActions = topActions(); mobileActions.classList.add('tea-mobile-actions'); brand.append(mobileActions); catalog.append(brand);
        const mobileTabs = tabs(); mobileTabs.classList.add('tea-mobile-tabs'); catalog.append(mobileTabs);
        const searchLine = element('div', undefined, 'tea-search-line'), label = element('label', undefined, 'tea-search-box');
        const input = element('input'); input.type = 'search'; input.placeholder = media.matches && type ? `搜索${typeLabel(type)}…` : '找一场故事…'; input.value = query;
        input.setAttribute('aria-label', '搜索标题、正文或署名'); input.disabled = !state.settings.enabled;
        const applySearch = (value = input.value) => { query = value; page = 0; selectedId = null; render(); panel.querySelector('.tea-list').scrollTop = 0; };
        input.addEventListener('compositionstart', () => { searchComposing = true; });
        input.addEventListener('compositionend', () => { searchComposing = false; applySearch(); });
        input.addEventListener('input', event => { if (!searchComposing && !event.isComposing) applySearch(); });
        label.append(glyph('search'), input); searchLine.append(label);
        if (media.matches) {
            searchLine.id = 'tea-mobile-search';
            input.addEventListener('focus', () => { mobileSearchOpen = true; });
            const clear = iconButton('close', '清空搜索', () => {
                mobileSearchOpen = true; searchComposing = false; applySearch('');
                panel.querySelector('input[type="search"]').focus({ preventScroll: true });
            });
            clear.classList.add('tea-search-clear'); clear.hidden = !query; label.append(clear);
            const cancelSearch = () => {
                mobileSearchOpen = false; searchComposing = false; input.blur(); applySearch('');
                panel.querySelector('.tea-search-toggle')?.focus({ preventScroll: true });
            };
            const cancel = textButton('取消', cancelSearch); cancel.className = 'tea-search-cancel'; cancel.setAttribute('aria-label', '取消搜索'); searchLine.append(cancel);
            input.addEventListener('keydown', event => {
                if (event.isComposing || searchComposing) return;
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelSearch(); }
                else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); input.blur(); }
            });
        } else {
            const reshuffleSlot = element('span', undefined, 'tea-reshuffle-slot');
            const shuffle = iconButton('refresh', '重新打乱', reshuffle);
            shuffle.hidden = sortMode() !== 'random'; shuffle.disabled = !state.settings.enabled;
            reshuffleSlot.append(shuffle); searchLine.append(reshuffleSlot); catalog.append(searchLine);
        }
        const kinds = element('nav', undefined, 'tea-kinds'); kinds.setAttribute('aria-label', '剧场分类');
        for (const [value, label] of [['', '全部'], ['standalone', '独立剧场'], ['preset', '随文剧场']]) {
            const button = textButton(label, () => navigate(() => { type = value; })); button.setAttribute('aria-pressed', String(type === value)); kinds.append(button);
        }
        const kindBar = element('div', undefined, 'tea-kind-bar'); kindBar.append(kinds);
        if (media.matches) {
            const search = iconButton('search', '搜索剧场', () => {
                mobileSearchOpen = true; panel.classList.add('tea-searching'); search.setAttribute('aria-expanded', 'true');
                input.focus({ preventScroll: true });
            });
            search.classList.add('tea-search-toggle'); search.disabled = !state.settings.enabled;
            search.setAttribute('aria-expanded', String(mobileSearchOpen || !!query)); search.setAttribute('aria-controls', searchLine.id); kindBar.append(search);
        }
        kindBar.append(sortControl());
        if (media.matches) {
            const tools = element('div', undefined, 'tea-mobile-tools'); tools.append(searchLine, kindBar); catalog.append(tools);
        } else catalog.append(kindBar);
        const heading = element('div', undefined, 'tea-list-heading'); heading.append(element('span', scopeLabel(scope)), element('span', `${total} 篇`)); catalog.append(heading);
        const list = element('div', undefined, 'tea-list tea-scroll');
        if (state.personalError && scope !== 'community') list.append(element('p', state.personalError, 'tea-error'));
        if (!state.settings.enabled) list.append(element('p', '插件已停用，请在酒馆扩展设置中重新启用。', 'tea-empty'));
        else for (const [i, item] of visible.entries()) {
            if (media.matches) list.append(renderFeedEntry(item, pageStart() + i + 1));
            else {
                const button = textButton('', async () => {
                    if (!await canLeave()) return;
                    selectedId = item.id; mode = 'list'; message = ''; render(); const reading = panel.querySelector('.tea-reading'); if (reading) reading.scrollTop = 0;
                });
                const row = catalogItem(item, pageStart() + i + 1);
                button.className = row.className; button.dataset.id = item.id;
                button.setAttribute('aria-current', String(selectedId === item.id)); button.setAttribute('aria-label', item.title);
                button.append(...row.childNodes); list.append(button);
            }
        }
        if (!total && state.settings.enabled) list.append(element('p', emptyText(), 'tea-empty')); catalog.append(list);
        catalog.append(renderPagination(total));
        return catalog;
    }
    function renderPagination(total) {
        const footer = element('nav', undefined, 'tea-pagination'); footer.setAttribute('aria-label', '剧场分页');
        const pages = pageCount(total);
        const turnTo = async target => {
            if (!await canLeave()) return;
            page = target; selectedId = null; mode = 'list'; render(); panel.querySelector('.tea-list').scrollTop = 0;
        };
        const prev = iconButton('left', '上一页', () => turnTo(page - 1)); prev.disabled = page === 0;
        const next = iconButton('right', '下一页', () => turnTo(page + 1)); next.disabled = page + 1 >= pages;
        const pageText = `${String(page + 1).padStart(2, '0')} / ${String(pages).padStart(2, '0')}`;
        if (!media.matches) {
            footer.append(prev, element('span', pageText, 'tea-page-display'), next);
            return footer;
        }
        const jump = element('details', undefined, 'tea-page-jump');
        const summary = element('summary', undefined, 'tea-page-display');
        summary.setAttribute('role', 'button'); summary.setAttribute('aria-label', '跳转到某页');
        summary.setAttribute('aria-expanded', 'false'); summary.setAttribute('aria-controls', 'tea-page-popover');
        summary.title = `第 ${page + 1} 页，共 ${pages} 页，点击跳转`;
        summary.append(element('span', String(page + 1).padStart(2, '0'), 'tea-page-current'),
            element('span', ' / ', 'tea-page-divider'), element('span', String(pages).padStart(2, '0'), 'tea-page-total'), glyph('down'));
        const form = element('form', undefined, 'tea-page-popover'); form.id = 'tea-page-popover'; form.noValidate = true;
        const label = element('label', '跳转'); label.htmlFor = 'tea-page-target';
        const controls = element('div', undefined, 'tea-page-controls'), input = element('input');
        input.id = 'tea-page-target'; input.type = 'text'; input.inputMode = 'numeric'; input.pattern = '[0-9]*';
        input.autocomplete = 'off'; input.value = String(page + 1); input.setAttribute('aria-label', '跳转页码'); input.setAttribute('aria-describedby', 'tea-page-hint');
        const go = element('button'); go.type = 'submit'; go.setAttribute('aria-label', '确认跳转'); go.title = '确认跳转'; go.append(glyph('check'));
        const hint = element('p', `共 ${pages} 页`, 'tea-page-hint'); hint.id = 'tea-page-hint'; hint.setAttribute('aria-live', 'polite');
        const resetHint = () => { hint.textContent = `共 ${pages} 页`; hint.classList.remove('tea-page-error'); input.removeAttribute('aria-invalid'); };
        controls.append(label, input, go); form.append(controls, hint); jump.append(summary, form);
        summary.addEventListener('click', event => {
            event.preventDefault(); jump.open = !jump.open;
            // Focus during the tap so mobile browsers may open the numeric keyboard.
            if (jump.open) { input.value = String(page + 1); resetHint(); input.focus({ preventScroll: true }); input.select(); }
        });
        jump.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(jump.open)));
        jump.addEventListener('focusout', event => { if (!jump.contains(event.relatedTarget)) jump.open = false; });
        jump.addEventListener('keydown', event => {
            if (jump.open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); jump.open = false; summary.focus({ preventScroll: true }); }
        });
        input.addEventListener('input', resetHint);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const value = input.value.trim(), target = Number(value);
            if (!/^\d+$/.test(value) || !Number.isInteger(target) || target < 1 || target > pages) {
                hint.textContent = `请输入 1～${pages}`; hint.classList.add('tea-page-error'); input.setAttribute('aria-invalid', 'true'); input.focus({ preventScroll: true }); return;
            }
            jump.open = false; input.blur();
            await turnTo(target - 1);
            panel?.querySelector('.tea-page-jump summary')?.focus({ preventScroll: true });
        });
        footer.append(prev, jump, next);
        return footer;
    }
    function articleHeader(item, number, illustration) {
        const head = element('header', undefined, 'tea-article-head'), title = element('div', undefined, 'tea-title-group');
        const kicker = element('div', undefined, 'tea-article-type');
        if (number) kicker.append(element('span', String(number).padStart(2, '0'), 'tea-number'));
        kicker.append(element('span', typeLabel(item.type)));
        if (item.gore) kicker.append(element('span', 'G向', 'tea-content-tag'));
        title.append(kicker, element('h2', item.title, 'tea-article-title'), element('p', isManuscript(item.id) ? '亲笔手稿 / 我' : `社区投稿 / ${item.author}`, 'tea-article-meta'));
        head.append(title); if (illustration) head.append(art()); return head;
    }
    function articleActions(item) {
        const buttons = element('div', undefined, 'tea-actions');
        if (isManuscript(item.id)) { const edit = iconButton('edit', '编辑手稿', () => beginEdit(item)); edit.disabled = !!state.personalError; buttons.append(edit); }
        const favorite = Object.hasOwn(state.settings.favorites, item.id);
        const star = iconButton('star', favorite ? '取消收藏' : '收藏剧场', () => { actions.toggleFavorite(item.id); render(); });
        star.classList.add('tea-star'); star.setAttribute('aria-pressed', String(favorite)); buttons.append(star);
        if (item.type === 'standalone') { const use = iconButton('insert', '填入输入框', () => select(item)); use.classList.add('tea-primary'); buttons.append(use); }
        return buttons;
    }
    function markdownBody(item) { const body = element('div', undefined, 'tea-body'); body.innerHTML = renderMarkdown(item.body); return body; }
    function renderReader(workspace, item) {
        const reading = element('div', undefined, 'tea-reading tea-scroll'); reading.dataset.id = item.id;
        reading.append(articleHeader(item, null, true), markdownBody(item)); workspace.append(reading);
        const footer = element('footer', undefined, 'tea-reader-footer');
        footer.append(element('p', item.type === 'standalone' ? '一场独立的番外\n选用后填入酒馆输入框' : '藏在日常里的小插曲\n由预设宏在回复时随机调用', 'tea-footer-note'), articleActions(item)); workspace.append(footer);
    }
    function renderFeedEntry(item, number) {
        const article = element('article', undefined, 'tea-feed-entry'); article.dataset.id = item.id; article.setAttribute('aria-label', item.title);
        article.classList.toggle('tea-expanded', expanded.has(item.id)); article.append(articleHeader(item, number, number === 1));
        const excerpt = element('div', undefined, 'tea-excerpt'); excerpt.id = `tea-body-${item.id.replaceAll(':', '-')}`; excerpt.append(markdownBody(item)); article.append(excerpt);
        const fold = iconButton(expanded.has(item.id) ? 'up' : 'down', `${expanded.has(item.id) ? '收起' : '展开全文'}：${item.title}`, () => {
            const list = panel.querySelector('.tea-list'), closing = expanded.has(item.id), above = article.getBoundingClientRect().top < list.getBoundingClientRect().top;
            if (closing) expanded.delete(item.id); else expanded.add(item.id);
            article.classList.toggle('tea-expanded', !closing); fold.replaceChildren(glyph(closing ? 'down' : 'up'));
            if (!closing) fold.append(element('span', '收起'));
            fold.title = `${closing ? '展开全文' : '收起'}：${item.title}`; fold.setAttribute('aria-label', fold.title); fold.setAttribute('aria-expanded', String(!closing));
            if (closing && above) list.scrollTop += article.getBoundingClientRect().top - list.getBoundingClientRect().top;
            measureBodies();
        });
        fold.classList.add('tea-fold'); fold.setAttribute('aria-controls', excerpt.id); fold.setAttribute('aria-expanded', String(expanded.has(item.id)));
        if (expanded.has(item.id)) fold.append(element('span', '收起')); article.append(fold);
        const footer = element('footer', undefined, 'tea-entry-footer'); footer.append(articleActions(item)); article.append(footer); return article;
    }
    function renderEditor(workspace) {
        const form = element('form', undefined, 'tea-form tea-scroll'); form.id = 'tea-draft-form';
        function field(text, tag, name) {
            const label = element('label', text, 'tea-field'), input = element(tag); input.name = name; input.value = draft[name] ?? ''; input.disabled = busy;
            input.addEventListener('input', () => { draft[name] = input.value; input.setCustomValidity(''); }); label.append(input); form.append(label); return input;
        }
        const title = field('标题', 'input', 'title'); title.required = true; title.maxLength = 100; title.placeholder = '给这场故事起个名字';
        const kind = field('剧场类型', 'select', 'type');
        for (const value of ['standalone', 'preset']) { const option = element('option', typeLabel(value)); option.value = value; kind.append(option); } kind.value = draft.type;
        const body = field('小剧场内容', 'textarea', 'body'); body.required = true; body.placeholder = '写下或粘贴你的剧场提示词…'; body.parentElement.classList.add('tea-grow');
        const footer = element('footer', undefined, 'tea-reader-footer'); footer.append(element('p', '保存在本地，不会发布到社区。', 'tea-footer-note'));
        const buttons = element('div', undefined, 'tea-actions');
        if (draft.id) {
            const remove = iconButton('trash', '删除手稿', async () => {
                if (busy || confirming) return; confirming = true; let approved;
                try { approved = await confirm(`确定删除手稿「${draft.title}」吗？对应收藏也会移除。`, '删除手稿'); } finally { confirming = false; }
                if (!approved) return;
                busy = true; render();
                try { await actions.deleteManuscript(draft.id); mode = 'list'; showMessage('手稿已删除'); }
                catch (error) { showMessage(error.message); }
                finally { busy = false; render(); }
            }); remove.disabled = busy; buttons.append(remove);
        }
        const save = iconButton('save', '保存手稿', () => {}); save.type = 'submit'; save.setAttribute('form', form.id); save.classList.add('tea-primary'); save.disabled = busy; buttons.append(save);
        footer.append(buttons);
        form.addEventListener('submit', async event => {
            event.preventDefault(); if (busy) return;
            if (!draft.title.trim() || !draft.body.trim()) { const empty = !draft.title.trim() ? title : body; empty.setCustomValidity('请填写内容'); empty.reportValidity(); return; }
            busy = true; render();
            try {
                const item = await actions.saveManuscript(draft);
                if (draft.id) selectedId = item.id;
                mode = 'list'; showMessage(draft.id ? '手稿已保存' : '手稿已保存到亲笔手稿');
            } catch (error) { showMessage(error.message); }
            finally {
                busy = false; render();
                if (mode === 'list') panel.querySelector('.tea-list').scrollTop = returnScroll;
            }
        }); workspace.append(form, footer);
    }
    function renderSettings(workspace) {
        const area = element('div', undefined, 'tea-scroll tea-settings');
        const update = element('section', undefined, 'tea-update-setting');
        const controls = element('div', undefined, 'tea-update-controls');
        const button = textButton('', actions.updateLibrary); button.className = 'tea-manual-update';
        button.setAttribute('aria-label', '手动更新'); button.setAttribute('aria-busy', String(!!state.updating));
        button.disabled = state.updating || !state.settings.enabled;
        button.append(glyph('refresh'), element('span', '手动更新'));
        const updateStatus = element('div', state.statusKind === 'update' ? state.status : '', 'tea-update-status');
        updateStatus.setAttribute('role', 'status'); updateStatus.setAttribute('aria-live', 'polite');
        controls.append(element('strong', '更新剧场库'), button, element('small', '启动酒馆时会自动更新。'), updateStatus);
        update.append(controls); area.append(update);
        const preference = element('section', undefined, 'tea-content-preference');
        const label = element('label', undefined, 'tea-setting-row');
        const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = state.settings.showGore === true;
        toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-describedby', 'tea-gore-description');
        toggle.setAttribute('aria-label', '显示 G 向内容');
        label.append(element('strong', '显示 G 向内容'), toggle);
        const description = element('p', '开启后，插件列表和随文剧场随机将会展示/抽选相关内容。', 'tea-setting-description');
        description.id = 'tea-gore-description';
        toggle.addEventListener('change', () => {
            state.settings.showGore = toggle.checked; actions.saveSettings();
            page = 0; selectedId = null; returnScroll = 0; expanded.clear(); render();
        });
        preference.append(label, element('p', '血腥、猎奇等内容', 'tea-setting-description'), description); area.append(preference);
        function choice(label, values, current, set, className = '') {
            const row = element('div', undefined, `tea-setting-row ${className}`), buttons = element('div', undefined, 'tea-choice'); buttons.setAttribute('aria-label', label);
            for (const [value, text] of values) { const button = textButton(text, () => { set(value); actions.saveSettings(); render(); }); button.setAttribute('aria-pressed', String(current === value)); buttons.append(button); }
            row.append(element('strong', label), buttons); area.append(row);
        }
        const fontRow = element('label', '正文字号', 'tea-setting-row'), font = element('select');
        font.setAttribute('aria-label', '正文字号');
        const fontChoices = media.matches ? [[15, '标准 · 15'], [16, '适中 · 16'], [18, '较大 · 18']] : [[16, '标准 · 16'], [18, '较大 · 18']];
        const fontKey = media.matches ? 'mobileFontSize' : 'fontSize';
        for (const [n, label] of fontChoices) {
            const option = element('option', label); option.value = String(n); font.append(option);
        }
        font.value = String(bodyFontSize());
        font.addEventListener('change', () => { state.settings[fontKey] = Number(font.value); actions.saveSettings(); render(); });
        fontRow.append(font); area.append(fontRow);
        choice('目录间距', [[false,'舒展'],[true,'紧凑']], !!state.settings.compact, value => { state.settings.compact = value; }, 'tea-desktop-setting');
        if (media.matches) {
            const row = element('label', '每页篇数', 'tea-setting-row'), size = element('select'); size.setAttribute('aria-label', '每页篇数');
            for (const n of [5,10,20,50]) { const option = element('option', `${n} 篇`); option.value = String(n); size.append(option); } size.value = String(mobilePageSize());
            size.addEventListener('change', () => { state.settings.pageSize = Number(size.value); actions.saveSettings(); page = 0; selectedId = null; returnScroll = 0; render(); }); row.append(size); area.append(row);
        }
        const help = textButton('随文剧场用法', () => { mode = 'help'; render(); }); help.className = 'tea-text-button'; area.append(help);
        workspace.append(area, element('p', '设置自动保存在本地。', 'tea-settings-note'));
    }
    function renderHelp(workspace) {
        const area = element('div', undefined, 'tea-scroll tea-help');
        for (const [title, macro, description] of [['所有随文剧场', '{{茶话会小剧场}}', '从所有随文剧场中随机抽取。'], ['收藏的随文剧场', '{{我收藏的小剧场}}', '从收藏的随文剧场中随机抽取，也包括收藏的亲笔手稿。']]) {
            area.append(element('h3', title)); const row = element('div', undefined, 'tea-macro'); row.append(element('code', macro));
            row.append(iconButton('copy', '复制宏', async () => { try { await navigator.clipboard.writeText(macro); showMessage('宏已复制，可粘贴到预设中'); } catch { showMessage('浏览器未允许复制，请选中宏文字手动复制。'); } }));
            area.append(row, element('p', description));
        }
        area.append(element('p', '把需要的宏放置在预设原先放小剧场的位置，宏会在向AI发送请求时被替换为随机的一个小剧场。通常仅放其中一个宏即可，两个不同种类宏同时被放入预设中时，会各自输出一条。'), element('p', '不要将一个宏多次放置，会输出多条同样内容。')); workspace.append(area);
    }
    function onBreakpoint() { if (panel) { page = 0; selectedId = null; returnScroll = 0; render(); } }
    return {
        async open() {
            if (popup || opening || !state.settings.enabled) return;
            opening = true;
            try {
                await actions.loaded; if (!state.settings.enabled) return;
                media = matchMedia('(max-width: 760px)'); media.addEventListener('change', onBreakpoint);
                observer = new ResizeObserver(measureBodies);
                mode = 'list'; message = ''; panel = element('div'); panel.id = 'teahouse-panel';
                panel.addEventListener('pointerdown', event => {
                    for (const menu of panel.querySelectorAll('.tea-sort[open], .tea-page-jump[open]')) {
                        if (!menu.contains(event.target)) menu.open = false;
                    }
                });
                render();
                const context = ctx();
                popup = new context.Popup(panel, context.POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: false, onClosing: canLeave,
                    onOpen: () => { measureBodies(); [...panel.querySelectorAll('button')].find(b => b.getClientRects().length && !b.disabled)?.focus({ preventScroll: true }); } });
                popup.dlg.classList.add('teahouse-dialog');
                resizeViewport = () => { const viewport = window.visualViewport; if (!viewport || !popup) return;
                    popup.dlg.style.setProperty('--tea-viewport-height', `${viewport.height}px`); popup.dlg.style.setProperty('--tea-viewport-top', `${viewport.offsetTop}px`); };
                window.visualViewport?.addEventListener('resize', resizeViewport); window.visualViewport?.addEventListener('scroll', resizeViewport); resizeViewport();
                await popup.show();
            } finally {
                clearTimeout(messageTimer);
                observer?.disconnect(); cancelAnimationFrame(measureFrame); media?.removeEventListener('change', onBreakpoint);
                window.visualViewport?.removeEventListener('resize', resizeViewport); window.visualViewport?.removeEventListener('scroll', resizeViewport);
                popup = null; panel = null; opening = false;
                searchComposing = false;
            }
        },
        refresh() {
            syncRandomOrders();
            if (!panel) return;
            if (mode === 'editor') {
                const status = panel.querySelector('.tea-status');
                status.textContent = message || state.status; status.hidden = !status.textContent;
            } else render();
        },
        close,
    };
}
