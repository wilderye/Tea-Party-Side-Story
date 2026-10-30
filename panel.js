import { findEntries, isManuscript, reconcileRandomOrder } from './library.js';
import { renderMarkdown } from './markdown.js';
import { createAppearance } from './appearance.js';
import { createViewDiagnostics } from './view-diagnostics.js';
import { element, textButton, glyph, iconButton, copyText, createPageJump } from './ui.js';
import { renderDiagnostics } from './diagnostics-view.js';
import { showSentPromptViewer } from './play-sent-prompt-view.js';
import { createPlayView } from './play-view.js';
import { createPlayChatView } from './play-chat-view.js';
import { createPlayFavoriteReader, favoriteTitle } from './play-favorites-view.js';
import { createPlayFavoriteComposer } from './play-favorite-composer.js';
import { createPlayApiSettings, renderPlayChatSetting, renderPlayRetrySettings, renderPlayPromptSetting, renderPlayContinuationSettings, renderPlayProcessingSettings } from './play-settings-view.js';
export { element, textButton } from './ui.js';
function art() {
    const node = element('div', undefined, 'tea-art'); node.setAttribute('aria-hidden', 'true');
    const img = element('img'); img.src = new URL('./assets/tea-party.svg', import.meta.url).href; img.alt = '';
    const mark = glyph('asterisk'); mark.classList.add('tea-art-mark');
    node.append(img, mark); return node;
}
const typeLabel = type => ({ preset: '随文剧场', standalone: '独立剧场', record: '演出记录' })[type] ?? '独立剧场';
const scopeLabel = scope => ({ community: '茶会选集', favorites: '我的收藏', local: '亲笔手稿', play: '剧场演出' })[scope];
const bodyFontSizes = Array.from({ length: 11 }, (_, index) => 12 + index * 2);

// Follow native reading scroll, using transforms only. The scroll viewport
// stays fixed so header movement cannot trigger pagination or history layout.
function createMobileNavigation(panel, media) {
    const listeners = new AbortController();
    const options = { passive: true, signal: listeners.signal };
    const scrollTops = new WeakMap();
    let slot, nav, tools, heading, scope, readingScroll, endTimer, paintFrame = 0;
    let height = 44, tabsHeight = 44, offset = 0, paintedOffset = 0;
    const headingResize = new ResizeObserver(() => { if (heading?.getClientRects().length) sync(scope); });
    const isReading = () => media.matches && scope !== 'community' && panel.dataset.mode === 'list' && slot?.isConnected;
    function paint() {
        paintFrame = 0;
        if (!slot) return;
        paintedOffset = offset;
        const transform = 'translateY(' + -offset + 'px)';
        nav.style.transform = transform;
        if (tools) tools.style.transform = transform;
        if (heading) heading.style.transform = transform;
        const hidden = offset >= tabsHeight;
        if (slot.inert !== hidden) slot.inert = hidden;
        const ariaHidden = String(hidden);
        if (slot.getAttribute('aria-hidden') !== ariaHidden) slot.setAttribute('aria-hidden', ariaHidden);
        panel.classList.toggle('tea-mobile-navigation-collapsed', hidden);
    }
    function setOffset(value) {
        const next = Math.max(0, Math.min(height, value));
        if (next === offset) return;
        offset = next;
        if (!paintFrame) paintFrame = requestAnimationFrame(paint);
    }
    function readingArea(target) {
        if (!isReading() || !(target instanceof Element)) return null;
        if (scope === 'play' && panel.querySelector('.play-page.is-message-editing')) return null;
        if (target.closest('input, textarea, select, iframe, .tea-table-scroll, .tea-sort-menu, .tea-page-popover, .play-result-menu, .play-edit-form')) return null;
        const area = target.closest('.tea-list, .play-feed, .play-people');
        return area && panel.contains(area) && area.getClientRects().length
            && (offset > 0 || area.scrollHeight > area.clientHeight + 1) ? area : null;
    }
    const scrollPosition = area => Math.max(0, Math.min(area.scrollTop, Math.max(0, area.scrollHeight - area.clientHeight)));
    function cancelScroll() { clearTimeout(endTimer); readingScroll = null; }
    function startScroll(area, touching) {
        clearTimeout(endTimer);
        // Passive wheel notifications can arrive after the compositor moved.
        if (touching || !scrollTops.has(area)) scrollTops.set(area, scrollPosition(area));
        readingScroll = { area, touching, moved: false };
    }
    function followScroll(top = scrollPosition(readingScroll.area)) {
        const delta = top - scrollTops.get(readingScroll.area);
        scrollTops.set(readingScroll.area, top);
        if (delta) { readingScroll.moved = true; setOffset(top === 0 ? 0 : offset + delta); }
    }
    panel.addEventListener('pointerdown', cancelScroll, options);
    panel.addEventListener('touchstart', event => {
        cancelScroll();
        const area = event.touches.length === 1 && readingArea(event.target);
        if (!area) return;
        startScroll(area, true);
    }, options);
    panel.addEventListener('touchend', event => {
        if (!readingScroll || event.touches.length) return;
        followScroll();
        readingScroll.touching = false;
        // A tap must not arm navigation for a later automatic scroll.
        if (!readingScroll.moved) cancelScroll();
        else if (!('onscrollend' in readingScroll.area)) endTimer = setTimeout(cancelScroll, 160);
    }, options);
    panel.addEventListener('touchcancel', cancelScroll, options);
    panel.addEventListener('wheel', event => {
        if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        const area = readingArea(event.target);
        if (!area) return;
        if (readingScroll?.area !== area) startScroll(area, false);
    }, options);
    panel.addEventListener('scroll', event => {
        const area = event.target;
        if (!(area instanceof Element) || !area.matches('.tea-list, .play-feed, .play-people')) return;
        const top = scrollPosition(area);
        if (isReading() && readingScroll?.area === area) {
            followScroll(top);
            // Older browsers have no native notification that inertia ended.
            if (!('onscrollend' in area) && !readingScroll.touching) {
                clearTimeout(endTimer); endTimer = setTimeout(cancelScroll, 160);
            }
        } else {
            scrollTops.set(area, top);
            if (isReading() && offset && top === 0 && area.getClientRects().length) setOffset(0);
        }
    }, { ...options, capture: true });
    panel.addEventListener('scrollend', event => {
        if (readingScroll?.area === event.target && !readingScroll.touching) cancelScroll();
    }, { ...options, capture: true });
    panel.addEventListener('keydown', cancelScroll, { signal: listeners.signal });
    panel.addEventListener('focusin', event => {
        if (event.target.matches('input, textarea, select') || slot?.contains(event.target)) {
            cancelScroll(); setOffset(0);
        }
    }, { signal: listeners.signal });
    window.visualViewport?.addEventListener('resize', cancelScroll, options);
    function sync(value, resetPosition = false) {
        cancelScroll(); cancelAnimationFrame(paintFrame); paintFrame = 0;
        slot = panel.querySelector('.tea-catalog:not([hidden]) .tea-mobile-tab-slot');
        nav = slot?.firstElementChild;
        tools = slot?.parentElement.querySelector('.tea-mobile-tools');
        const nextHeading = media.matches && value === 'play' && panel.dataset.mode === 'list'
            ? [...panel.querySelectorAll('.play-chat-heading')].find(node => node.getClientRects().length) : null;
        if (heading !== nextHeading) {
            if (heading) heading.style.transform = '';
            headingResize.disconnect(); heading = nextHeading;
            if (heading) headingResize.observe(heading);
        }
        tabsHeight = nav && media.matches ? nav.offsetHeight || 44 : 44;
        height = tabsHeight + (heading?.offsetHeight ?? 0);
        if (heading) heading.parentElement.style.setProperty('--play-chat-heading-height', heading.offsetHeight + 'px');
        const area = slot?.parentElement.querySelector('.tea-list');
        const shortCatalog = media.matches && area && area.scrollHeight <= area.clientHeight + 1;
        if (scope !== value || value === 'community' || resetPosition || !isReading() || shortCatalog) offset = 0;
        else offset = Math.min(offset, height);
        scope = value; paint();
    }
    return {
        sync,
        // The history view asks how much of its fixed viewport is covered.
        // It still owns paragraph capture/restoration and history persistence.
        getReadingInset() {
            return isReading() && scope === 'play' ? height - paintedOffset : 0;
        },
        ignoreScroll(area) {
            scrollTops.set(area, scrollPosition(area));
        },
        dispose() { listeners.abort(); headingResize.disconnect(); cancelAnimationFrame(paintFrame); cancelScroll(); },
    };
}

export function createTheatrePanel(ctx, state, actions) {
    let panel, popup, opening = false, observer, measureFrame, resizeViewport, media, appearance;
    let mobileNavigation, viewDiagnostics;
    let scope = 'community', mode = 'list';
    let draft, originalDraft, busy = false, confirming = false, message = '', messageTimer;
    let searchComposing = false, catalogCollapsed = false, restoringCatalog = false;
    let playView, playCatalog, playWorkspace, settingsView, diagnosticsView, apiSettings, playActive = false;
    let chatView, chatCatalog, chatWorkspace, playRoute = 'play', chatActive = false;
    const chatReturns = [];
    let favoriteRows = new Map(), favoriteLoaded = false, favoriteLoadError = '', favoriteLoadId = 0;
    let favoriteWorkspace, favoriteEmpty, settingsReturnMode = 'list';
    let favoriteComposer, sentPromptViewer;
    const favoriteReaders = new Map();
    const catalogs = new Map();
    let catalog = catalogFor(scope);
    function catalogFor(value) {
        if (!catalogs.has(value)) catalogs.set(value, {
            type: value === 'favorites' ? 'standalone' : '', query: '', page: 0, selectedId: null,
            desktopStarts: [0], expanded: new Set(), mobileSearchOpen: false,
            listScroll: 0, readingId: null, readingScroll: 0, recordOpen: false,
        });
        return catalogs.get(value);
    }
    const currentType = () => catalog.type;
    const isRecordFavorites = () => scope === 'favorites' && catalog.type === 'record';
    const orderKey = () => isRecordFavorites() ? 'record-favorites' : scope;
    const recordEntries = () => new Map([...favoriteRows.values()].map(favorite => [favorite.id, {
        id: favorite.id, type: 'record', title: favorite.title.trim() || favorite.firstLine || '内容已隐藏', author: favorite.characterName,
        body: favorite.firstLine, publishedAt: favorite.savedAt, favorite,
    }]));
    const recordFavoriteTimes = () => Object.fromEntries([...favoriteRows.values()].map(item => [item.id, Date.parse(item.savedAt)]));
    const catalogSearch = () => [...(panel?.querySelectorAll('.tea-catalog input[type="search"]') ?? [])].find(input => input.getClientRects().length);
    const getPlayView = () => playView ??= createPlayView(ctx, state.settings, actions.playground, showMessage, actions.diagnostics, actions.promptFavorites,
        { getReadingInset: () => mobileNavigation?.getReadingInset() ?? 0,
            onProgrammaticScroll: area => mobileNavigation?.ignoreScroll(area), onBranch: branch => void enterBranch(branch.id), onInspectPrompt: inspectPrompt });
    const getChatView = () => chatView ??= createPlayChatView(ctx, state.settings, actions.playground, actions.promptFavorites, {
        onInspectPrompt: inspectPrompt,
        notify: showMessage, onOpen: (id, messageId) => void enterBranch(id, messageId),
        getReadingInset: () => mobileNavigation?.getReadingInset() ?? 0,
        onProgrammaticScroll: area => mobileNavigation?.ignoreScroll(area),
        onBranch: branch => void enterBranch(branch.id),
        onCharacter: () => { playRoute = 'history'; render(); },
        onClose: () => void closeChatPage(), onDelete: () => void closeChatPage(),
    });
    async function enterBranch(id, messageId) {
        if (!await canLeave()) return;
        captureCatalogPosition();
        if (playRoute !== 'chat' || scope !== 'play') chatReturns.length = 0;
        chatReturns.push({ scope, mode, route: playRoute, catalog,
            chatId: scope === 'play' && playRoute === 'chat' ? getChatView().chatId : null,
            character: scope === 'play' && playRoute === 'history' ? getChatView().selected : null });
        playView?.prepareLayout();
        scope = 'play'; mode = 'list'; playRoute = 'chat'; render();
        await getChatView().open(id, messageId);
        mobileNavigation?.sync(scope);
    }
    async function closeChatPage() {
        if (!await canLeave()) return;
        chatView?.deactivate(); chatActive = false;
        const destination = chatReturns.pop() ?? { scope: 'play', mode: 'list', route: 'history' };
        scope = destination.scope; mode = destination.mode; playRoute = destination.route;
        if (destination.catalog) catalog = destination.catalog;
        if (scope === 'play' && playRoute === 'history') await getChatView().showDirectory(destination.character, false);
        if (scope === 'play' && playRoute === 'chat') await getChatView().open(destination.chatId);
        render();
        mobileNavigation?.sync(scope);
        if (scope !== 'play') restoreCatalogPosition();
    }
    async function toggleHistory() {
        if (mode === 'settings') return back();
        if (!await canLeave()) return;
        if (playRoute === 'history') { chatView?.deactivate(); chatActive = false; playRoute = 'play'; render(); }
        else {
            const character = playRoute === 'chat' ? getChatView().selected : getPlayView().getSelectedCharacter();
            chatReturns.length = 0;
            playView?.prepareLayout(); playRoute = 'history'; render();
            await getChatView().showDirectory(character);
        }
    }
    const randomOrders = new Map();
    const sortMode = () => state.settings.sortMode === 'random' ? 'random' : 'time';
    const scopeEntries = value => value === 'record-favorites'
        ? findEntries(recordEntries(), { scope: 'favorites', favorites: recordFavoriteTimes() })
        : findEntries(state.entries, { scope: value, favorites: state.settings.favorites, showGore: state.settings.showGore });
    function syncRandomOrders() {
        const scopes = new Set(randomOrders.keys());
        if (panel && scope !== 'play' && sortMode() === 'random') scopes.add(orderKey());
        for (const value of scopes) randomOrders.set(value, reconcileRandomOrder(randomOrders.get(value), scopeEntries(value)));
    }
    const dirty = () => mode === 'editor' && JSON.stringify(draft) !== originalDraft;
    const mobilePageSize = () => [5, 10, 20, 50].includes(state.settings.pageSize) ? state.settings.pageSize : 5;
    const bodyFontSize = () => {
        const value = media?.matches ? state.settings.mobileFontSize : state.settings.fontSize;
        const defaultSize = scope === 'play' ? 18 : 16;
        const rounded = Number.isInteger(value) ? Math.round(value / 2) * 2 : defaultSize;
        return bodyFontSizes.includes(rounded) ? rounded : defaultSize;
    };
    function applyFontSource() {
        // Themes can set body.fontFamily without changing Tavern's font variable.
        const family = state.settings.fontSource === 'tavern' ? getComputedStyle(document.body).fontFamily : '';
        for (const property of ['--tea-ui', '--tea-display']) {
            if (family) {
                if (panel.style.getPropertyValue(property) !== family) panel.style.setProperty(property, family);
            } else if (panel.style.getPropertyValue(property)) {
                panel.style.removeProperty(property);
            }
        }
    }
    const pageStart = () => media?.matches ? catalog.page * mobilePageSize() : catalog.desktopStarts[catalog.page] ?? 0;
    const pageCount = total => media?.matches ? Math.max(1, Math.ceil(total / mobilePageSize())) : catalog.desktopStarts.length;
    const pageForIndex = index => media?.matches ? Math.max(0, Math.floor(index / mobilePageSize())) : Math.max(0, catalog.desktopStarts.findLastIndex(start => start <= index));
    const matches = () => findEntries(isRecordFavorites() ? recordEntries() : state.entries, { scope, type: currentType(), query: catalog.query,
        favorites: isRecordFavorites() ? recordFavoriteTimes() : state.settings.favorites, showGore: state.settings.showGore,
        order: sortMode() === 'random' ? randomOrders.get(orderKey()) : undefined });
    function catalogReader() {
        return isRecordFavorites()
            ? !favoriteWorkspace?.hidden && favoriteWorkspace?.querySelector('.play-favorite-reading:not([hidden])')
            : panel?.querySelector('.tea-reading');
    }
    function captureCatalogPosition() {
        // Reading two scroll offsets is enough; never inspect the conversation
        // or persist data as part of closing the panel.
        if (scope === 'play' || restoringCatalog) return;
        const list = panel?.querySelector('.tea-list');
        if (list?.dataset.scope !== scope) return;
        const renderedMode = panel.dataset.mode;
        if (!media.matches || renderedMode === 'list') catalog.listScroll = list.scrollTop;
        const reading = catalogReader();
        if (reading) {
            catalog.readingId = reading.dataset.id;
            catalog.readingScroll = reading.scrollTop;
        }
        if (['list', 'record'].includes(renderedMode)) catalog.recordOpen = renderedMode === 'record';
    }
    function restoreCatalogPosition() {
        if (!restoringCatalog || !panel?.isConnected || scope === 'play') return;
        const list = panel.querySelector('.tea-list');
        if (list) { list.scrollTop = catalog.listScroll; mobileNavigation?.ignoreScroll(list); }
        const reading = catalogReader();
        if (reading && reading.dataset.id === catalog.readingId) reading.scrollTop = catalog.readingScroll;
    }
    function resetCatalogPosition() {
        catalog.listScroll = 0; catalog.readingId = null; catalog.readingScroll = 0; catalog.recordOpen = false;
    }
    function showScope(value) {
        captureCatalogPosition();
        disposeFavoriteComposer();
        scope = value;
        if (scope !== 'play') catalog = catalogFor(scope);
        mode = media.matches && isRecordFavorites() && catalog.recordOpen ? 'record' : 'list';
        message = ''; render();
        if (isRecordFavorites()) void refreshFavoriteCatalog();
    }
    async function navigateToScope(value) {
        if (!await canLeave()) return;
        if (mode === 'settings' && isRecordFavorites()) actions.playground?.display?.updateSettings();
        showScope(value);
        actions.diagnostics?.info(`打开${scopeLabel(scope)}`);
    }
    async function confirm(text, actionLabel) {
        return await ctx().callGenericPopup(element('div', text, 'tea-confirm'), ctx().POPUP_TYPE.CONFIRM, '',
            { okButton: actionLabel, cancelButton: '取消' }) === ctx().POPUP_RESULT.AFFIRMATIVE;
    }
    async function canLeave() {
        if (busy || confirming || favoriteComposer?.canLeave() === false || playView?.canLeave() === false || chatView?.canLeave() === false || [...favoriteReaders.values()].some(reader => !reader.canLeave())) return false;
        if (favoriteComposer?.dirty()) {
            confirming = true;
            try { return await confirm('收藏有未保存的内容，确定放弃吗？', '放弃添加'); }
            finally { confirming = false; }
        }
        if (!dirty()) return true;
        confirming = true;
        try { return await confirm('手稿有未保存的修改，确定放弃吗？', '放弃修改'); }
        finally { confirming = false; }
    }
    async function close() { if (popup) await popup.complete(ctx().POPUP_RESULT.CANCELLED); }
    async function back() {
        if (!await canLeave()) return;
        disposeFavoriteComposer();
        const leavingSettings = mode === 'settings';
        mode = mode === 'help' ? 'settings' : leavingSettings ? settingsReturnMode : 'list';
        if (leavingSettings && isRecordFavorites()) actions.playground?.display?.updateSettings();
        message = ''; render();
        if (leavingSettings && scope === 'play' && playRoute !== 'play') {
            actions.playground?.display?.updateSettings();
            void chatView?.refresh();
        }
    }
    function showMessage(text) {
        clearTimeout(messageTimer);
        message = text;
        updateStatus();
        if (text) messageTimer = setTimeout(() => showMessage(''), 5000);
    }
    function updateStatus() {
        const status = panel?.querySelector('.tea-status');
        if (status) {
            status.textContent = message || (mode === 'settings' && state.statusKind === 'update' ? '' : state.status);
            status.hidden = !status.textContent;
        }
        const update = panel?.querySelector('.tea-manual-update');
        if (update) {
            update.disabled = state.updating || !state.settings.enabled;
            update.setAttribute('aria-busy', String(!!state.updating));
        }
        const progress = panel?.querySelector('.tea-update-status');
        if (progress) progress.textContent = state.statusKind === 'update' ? state.status : '';
    }
    function measureBodies() {
        settingsView?.layout();
        cancelAnimationFrame(measureFrame);
        if (scope === 'play') { if (mode === 'list') playView?.layout(); return; }
        measureFrame = requestAnimationFrame(() => {
            if (!panel) return;
            if (!media.matches) {
                const list = panel.querySelector('.tea-list');
                const height = list.clientHeight;
                if (!height || !list.clientWidth) {
                    restoreCatalogPosition(); restoringCatalog = false; return;
                }
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
                if (JSON.stringify(starts) !== JSON.stringify(catalog.desktopStarts)) {
                    const anchor = result.findIndex(item => item.id === catalog.selectedId);
                    catalog.desktopStarts = starts;
                    catalog.page = anchor >= 0 ? pageForIndex(anchor) : Math.min(catalog.page, starts.length - 1);
                    render({ preserveSettings: true });
                }
                restoreCatalogPosition(); restoringCatalog = false;
                return;
            }
            for (const article of panel.querySelectorAll('.tea-feed-entry')) {
                const body = article.querySelector('.tea-body'), toggle = article.querySelector('.tea-fold');
                const long = body.scrollHeight > 320;
                article.classList.toggle('tea-long', long); toggle.hidden = !long;
                const clipped = long && !catalog.expanded.has(article.dataset.id);
                for (const node of body.querySelectorAll('a, [tabindex]')) {
                    if (clipped) node.setAttribute('tabindex', '-1');
                    else if (node.tagName === 'A') node.removeAttribute('tabindex');
                    else node.setAttribute('tabindex', '0');
                }
            }
            restoreCatalogPosition(); restoringCatalog = false;
        });
    }
    function showCatalog(nextMode = 'list') {
        if (mode === 'settings' && !media.matches) settingsReturnMode = nextMode;
        else mode = nextMode;
    }
    async function navigate(change, catalogOnly = false) {
        if (!await canLeave()) return;
        disposeFavoriteComposer();
        if (mode === 'settings' && !catalogOnly && isRecordFavorites()) actions.playground?.display?.updateSettings();
        change();
        if (catalogOnly) showCatalog(); else mode = 'list';
        catalog.page = 0; catalog.selectedId = null; message = '';
        actions.diagnostics?.info(`打开${scopeLabel(scope)}`);
        render({ resetPosition: true });
        if (isRecordFavorites()) void refreshFavoriteCatalog();
    }
    function reshuffle() {
        return navigate(() => randomOrders.set(orderKey(), reconcileRandomOrder(undefined, scopeEntries(orderKey()))), true);
    }
    async function beginEdit(item) {
        if (!item && scope !== 'local') return;
        if (!await canLeave() || state.personalError || !state.settings.enabled) return;
        draft = item ? { id: item.id, title: item.title, type: item.type, body: item.body }
            : { title: '', type: currentType() === 'preset' ? 'preset' : 'standalone', body: '' };
        originalDraft = JSON.stringify(draft); mode = 'editor'; message = ''; render();
    }
    function disposeFavoriteComposer() {
        favoriteComposer?.dispose(); favoriteComposer?.node.remove(); favoriteComposer = null;
    }
    async function beginFavorite() {
        if (!isRecordFavorites() || !state.settings.enabled || !await canLeave()) return;
        favoriteComposer = createPlayFavoriteComposer(ctx, actions.playground, {
            onCancel: () => void back(),
            onSave(favorite) {
                favoriteLoadId++; favoriteRows.set(favorite.id, favorite); favoriteLoaded = true;
                catalog.query = ''; catalog.mobileSearchOpen = false; catalog.selectedId = favorite.id;
                resetCatalogPosition();
                syncRandomOrders(); catalog.page = pageForIndex(matches().findIndex(item => item.id === favorite.id));
                disposeFavoriteComposer(); mode = media.matches ? 'record' : 'list';
                render(); showMessage('已添加演出记录收藏');
            },
        });
        mode = 'favorite-editor'; message = ''; render(); favoriteComposer.focus();
    }
    async function toggleSettings() {
        if (mode === 'settings') return back();
        if (!await canLeave()) return;
        if (favoriteComposer) { disposeFavoriteComposer(); mode = 'list'; }
        settingsReturnMode = mode;
        actions.diagnostics?.info('打开插件设置');
        mode = 'settings'; message = ''; render();
    }
    async function refreshFavoriteCatalog() {
        const id = ++favoriteLoadId;
        const [records, display] = await Promise.allSettled([
            actions.playground?.listFavorites?.() ?? [], actions.playground?.display?.refresh(),
        ]);
        if (id !== favoriteLoadId) return;
        favoriteLoaded = true;
        if (records.status === 'fulfilled') {
            favoriteRows = new Map(records.value.map(row => [row.id, row])); favoriteLoadError = '';
        } else favoriteLoadError = records.reason.message || '演出记录收藏暂时无法读取';
        if (isRecordFavorites() && ['list', 'record', 'settings'].includes(mode)) {
            render({ preserveSettings: true });
            if (display.status === 'rejected') showMessage('酒馆正则读取失败，请在设置中刷新正则列表后重试。');
        }
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
        for (const value of ['community', 'local', 'favorites', ...(actions.playground ? ['play'] : [])]) {
            const button = textButton(scopeLabel(value), () => { if (scope !== value || mode !== 'list') void navigateToScope(value); });
            button.setAttribute('aria-pressed', String(scope === value)); nav.append(button);
        }
        return nav;
    }
    function updateCatalogVisibility() {
        panel.classList.toggle('tea-catalog-collapsed', catalogCollapsed);
        for (const button of panel.querySelectorAll('.tea-catalog-toggle')) {
            button.setAttribute('aria-expanded', String(!catalogCollapsed));
            button.title = catalogCollapsed ? '展开左侧栏' : '收起左侧栏';
            button.setAttribute('aria-label', button.title);
        }
    }
    function topbar() {
        const header = element('header', undefined, 'tea-topbar');
        const toggle = iconButton('panel', catalogCollapsed ? '展开左侧栏' : '收起左侧栏', () => {
            playView?.prepareLayout();
            catalogCollapsed = !catalogCollapsed; updateCatalogVisibility(); measureBodies();
        });
        toggle.classList.add('tea-catalog-toggle');
        toggle.setAttribute('aria-expanded', String(!catalogCollapsed));
        toggle.setAttribute('aria-controls', scope === 'play' ? 'play-catalog' : 'tea-catalog');
        header.append(toggle, tabs(), topActions()); return header;
    }
    function topActions(mobileHeader = false) {
        const box = element('div', undefined, 'tea-actions');
        if (['list', 'record'].includes(mode) && (scope === 'local' || isRecordFavorites())) {
            const add = iconButton('plus', isRecordFavorites() ? '添加演出记录收藏' : '新建手稿',
                () => isRecordFavorites() ? beginFavorite() : beginEdit());
            add.classList.add('tea-add');
            add.disabled = !state.settings.enabled || scope === 'local' && !!state.personalError;
            box.append(add);
        }
        if (scope === 'play' && mobileHeader) box.append(playRoute === 'play' ? getPlayView().chooseButton : getChatView().chooseButton);
        if (scope === 'play') {
            const history = iconButton('history', '历史记录', () => void toggleHistory()); history.classList.add('tea-history-toggle');
            history.setAttribute('aria-pressed', String(mode === 'list' && playRoute === 'history')); box.append(history);
        }
        box.append(settingsButton(), iconButton('close', '关闭面板', close));
        return box;
    }
    function inspectPrompt(resultId) {
        sentPromptViewer?.dispose(); sentPromptViewer = showSentPromptViewer(panel, resultId);
    }
    function settingsButton() {
        const button = iconButton('settings', '设置', toggleSettings);
        button.classList.add('tea-settings-toggle'); button.setAttribute('aria-pressed', String(mode === 'settings'));
        return button;
    }
    async function selectInPlugin(item) {
        if (!state.settings.enabled || !actions.playground || !await canLeave()) return;
        const view = getPlayView();
        if (!await view.fillFromEntry(item)) return;
        showScope('play');
        view.focusInput();
    }
    function brandHeader() {
        const brand = element('header', undefined, 'tea-brand'), name = element('div');
        name.append(element('h1', '茶话会'), element('p', '小 剧 场')); brand.append(glyph('cup'), name);
        const mobileActions = topActions(true); mobileActions.classList.add('tea-mobile-actions'); brand.append(mobileActions);
        return brand;
    }
    function mobileTabs() {
        const slot = element('div', undefined, 'tea-mobile-tab-slot');
        const nav = tabs(); nav.classList.add('tea-mobile-tabs'); slot.append(nav);
        return slot;
    }
    function ensurePlayShell() {
        if (playCatalog) {
            const header = topbar(); header.classList.add('play-topbar');
            playWorkspace.querySelector('.tea-topbar')?.replaceWith(header);
            playCatalog.querySelector('.tea-mobile-actions')?.replaceWith(Object.assign(topActions(true), { className: 'tea-actions tea-mobile-actions' }));
            return;
        }
        const view = getPlayView();
        playCatalog = element('aside', undefined, 'tea-catalog play-catalog'); playCatalog.id = 'play-catalog'; playCatalog.setAttribute('aria-label', '角色列表');
        playCatalog.append(brandHeader(), mobileTabs(), view.browser);
        playWorkspace = element('section', undefined, 'tea-workspace play-workspace'); playWorkspace.setAttribute('aria-label', '剧场演出');
        const header = topbar(); header.classList.add('play-topbar');
        playWorkspace.append(header, view.page); panel.append(playCatalog, playWorkspace);
    }
    function ensureChatShell() {
        const view = getChatView();
        if (!chatCatalog) {
            chatCatalog = element('aside', undefined, 'tea-catalog play-catalog play-chat-catalog');
            chatCatalog.append(brandHeader(), mobileTabs(), view.browser);
            chatWorkspace = element('section', undefined, 'tea-workspace play-workspace');
            const header = topbar(); header.classList.add('play-topbar');
            chatWorkspace.append(header, view.page); panel.append(chatCatalog, chatWorkspace);
        } else {
            const header = topbar(); header.classList.add('play-topbar');
            chatWorkspace.querySelector('.tea-topbar')?.replaceWith(header);
            chatCatalog.querySelector('.tea-mobile-actions')?.replaceWith(Object.assign(topActions(true), { className: 'tea-actions tea-mobile-actions' }));
        }
    }
    async function openRecordFavorite(id, direction) {
        const current = favoriteReaders.get(catalog.selectedId);
        if (!isRecordFavorites() || (direction && current?.canNavigate() === false) || !await canLeave()) return;
        const result = matches();
        const anchor = result.findIndex(item => item.id === id);
        if (anchor < 0) return;
        const index = anchor + (direction ?? 0);
        const item = result[index];
        if (!item || (direction && id !== catalog.selectedId)) return;
        captureCatalogPosition();
        const nextPage = pageForIndex(index);
        if (nextPage !== catalog.page) catalog.listScroll = 0;
        catalog.page = nextPage; catalog.selectedId = item.id;
        catalog.readingId = item.id; catalog.readingScroll = 0;
        showCatalog(media.matches ? 'record' : 'list'); message = '';
        const reader = favoriteReaders.get(item.id);
        if (reader) reader.node.scrollTop = 0;
        restoringCatalog = true; render();
    }
    function renderFavoriteWorkspace(visible, result) {
        if (!favoriteWorkspace) {
            favoriteWorkspace = element('section', undefined, 'tea-workspace play-favorite-workspace');
            favoriteWorkspace.setAttribute('aria-label', '演出记录收藏');
            const mobileHead = element('header', undefined, 'tea-view-title tea-back-title play-favorite-mobile-head');
            const name = element('div'); name.append(element('h2', '演出记录'));
            mobileHead.append(iconButton('left', '返回收藏目录', back), name, topActions());
            favoriteEmpty = element('p', '', 'tea-empty'); favoriteWorkspace.append(topbar(), mobileHead, favoriteEmpty);
        }
        favoriteWorkspace.hidden = false;
        favoriteWorkspace.querySelector('.tea-topbar').replaceWith(topbar());
        favoriteWorkspace.querySelector('.play-favorite-mobile-head .tea-actions').replaceWith(topActions());
        for (const reader of favoriteReaders.values()) reader.node.hidden = true;
        const item = visible.find(item => item.id === catalog.selectedId);
        const show = item && (!media.matches || mode === 'record');
        if (show) {
            let reader = favoriteReaders.get(item.id);
            if (!reader) {
                reader = createPlayFavoriteReader(actions.playground, { notify: showMessage, onInspectPrompt: inspectPrompt,
                    onGoToBranch: (id, messageId) => void enterBranch(id, messageId),
                    onNavigate: direction => void openRecordFavorite(item.id, direction),
                    onChange(favorite) { favoriteLoadId++; favoriteRows.set(favorite.id, favorite); render(); },
                    onRemove(id) {
                        favoriteLoadId++;
                        favoriteRows.delete(id); favoriteReaders.get(id)?.node.remove(); favoriteReaders.delete(id);
                        catalog.selectedId = null; mode = 'list'; render();
                    },
                });
                favoriteReaders.set(item.id, reader);
            }
            reader.node.dataset.id = item.id;
            const index = result.findIndex(entry => entry.id === item.id);
            reader.setNavigation({ previous: index > 0, next: index >= 0 && index + 1 < result.length });
            if (reader.node.parentElement !== favoriteWorkspace) favoriteWorkspace.append(reader.node);
            reader.node.hidden = false; void reader.load(item.favorite);
        }
        favoriteEmpty.hidden = !!show; favoriteEmpty.textContent = emptyText();
        return favoriteWorkspace;
    }
    function appendStatus() {
        const status = element('div', undefined, 'tea-status');
        status.setAttribute('role', 'status'); panel.append(status); updateStatus();
    }
    function render({ preserveSettings = false, resetPosition = false } = {}) {
        if (!panel || searchComposing) return;
        viewDiagnostics?.activate('render');
        sentPromptViewer?.dispose(); sentPromptViewer = null;
        if (mode !== 'favorite-editor') disposeFavoriteComposer();
        if (resetPosition) resetCatalogPosition(); else captureCatalogPosition();
        restoringCatalog = scope !== 'play';
        if (mode !== 'settings') apiSettings?.cancel();
        const keptSettings = preserveSettings && mode === 'settings' ? panel.querySelector('.tea-settings')?.parentElement : null;
        const settingsPosition = mode === 'settings' ? settingsView?.capture() : null;
        if (!keptSettings) {
            diagnosticsView?.dispose(); diagnosticsView = null;
            settingsView = null;
        }
        const enteringPlay = scope === 'play' && mode === 'list' && playRoute === 'play';
        if (playActive && !enteringPlay) {
            playView?.deactivate();
            playActive = false;
        }
        if (chatActive && !(scope === 'play' && mode === 'list' && playRoute !== 'play')) { chatView?.deactivate(); chatActive = false; }
        syncRandomOrders();
        const oldSearch = catalogSearch();
        const focused = oldSearch && document.activeElement === oldSearch;
        const selection = focused ? [oldSearch.selectionStart, oldSearch.selectionEnd, oldSearch.selectionDirection] : null;
        const focusedControl = panel.contains(document.activeElement) ? document.activeElement.closest('button, select, input[role="switch"]') : null;
        const focusKey = focusedControl?.getAttribute('aria-label');
        observer?.disconnect(); cancelAnimationFrame(measureFrame);
        // Keep the conversation connected while another tab is open. Detaching
        // it would reset rendered webpages and replace the user's input element.
        for (const child of [...panel.children]) {
            if (child !== playCatalog && child !== playWorkspace && child !== chatCatalog && child !== chatWorkspace && child !== favoriteWorkspace && child !== favoriteComposer?.node && child !== keptSettings) child.remove();
        }
        if (playCatalog) { playCatalog.hidden = true; playWorkspace.hidden = true; }
        if (favoriteWorkspace) favoriteWorkspace.hidden = true;
        if (chatCatalog) { chatCatalog.hidden = true; chatWorkspace.hidden = true; }
        if (panel.dataset.mode !== mode) panel.dataset.mode = mode;
        applyFontSource();
        const bodySize = `${bodyFontSize()}px`;
        if (panel.style.getPropertyValue('--tea-body-size') !== bodySize) panel.style.setProperty('--tea-body-size', bodySize);
        panel.classList.toggle('tea-compact', state.settings.compact !== false);
        panel.classList.toggle('tea-searching', scope !== 'play' && media.matches && (catalog.mobileSearchOpen || !!catalog.query));
        panel.classList.toggle('tea-play-mode', scope === 'play');
        panel.classList.toggle('tea-record-favorites', isRecordFavorites());
        panel.classList.toggle('tea-has-play', !!actions.playground);
        updateCatalogVisibility();
        if (scope === 'play') {
            if (playRoute === 'play') { ensurePlayShell(); playCatalog.hidden = false; }
            else { ensureChatShell(); chatCatalog.hidden = false; }
            if (mode === 'list') {
                if (playRoute !== 'play') {
                    chatWorkspace.hidden = false; appendStatus(); getChatView().activate(panel); chatActive = true;
                    mobileNavigation?.sync(scope, resetPosition); return;
                }
                playWorkspace.hidden = false; appendStatus();
                mobileNavigation?.sync(scope, resetPosition);
                getPlayView().activate(panel); playActive = true; return;
            }
        }
        const result = scope === 'play' ? [] : matches();
        let visible = [];
        if (scope !== 'play') {
            catalog.page = Math.max(0, Math.min(catalog.page, pageCount(result.length) - 1));
            visible = result.slice(pageStart(), media.matches ? pageStart() + mobilePageSize() : catalog.desktopStarts[catalog.page + 1] ?? result.length);
            if (!visible.some(item => item.id === catalog.selectedId)) catalog.selectedId = visible[0]?.id ?? null;
            panel.insertBefore(renderCatalog(visible, result.length), favoriteWorkspace ?? keptSettings ?? null);
        }
        let workspace = keptSettings;
        if (mode === 'favorite-editor' && favoriteComposer) workspace = favoriteComposer.node;
        else if (isRecordFavorites() && ['list', 'record'].includes(mode)) workspace = renderFavoriteWorkspace(visible, result);
        else if (!workspace) {
            workspace = element('section', undefined, 'tea-workspace'); workspace.setAttribute('aria-label', '阅读与编辑');
            if (mode === 'list' || mode === 'settings' && !media.matches) {
                workspace.append(topbar());
            }
            if (mode === 'list') {
                if (!state.settings.enabled) workspace.append(element('p', '插件已停用，请在酒馆扩展设置中重新启用。', 'tea-empty'));
                else if (catalog.selectedId) renderReader(workspace, visible.find(item => item.id === catalog.selectedId));
                else workspace.append(art(), element('h2', '下一场故事，等你入座', 'tea-empty-title'), element('p', emptyText(), 'tea-empty'));
            } else {
                if (mode !== 'settings' || media.matches) {
                    const title = element('header', undefined, 'tea-view-title'), titleText = element('div');
                    titleText.append(element('h2', mode === 'editor' ? draft.id ? '编辑手稿' : '新的一页' : mode === 'settings' ? '设置' : '随文剧场用法'));
                    if (mode === 'editor') titleText.append(element('p', '把一个念头，写成一场小剧场。'));
                    const exit = iconButton(mode === 'editor' ? 'close' : 'left', mode === 'editor' ? '关闭编辑，返回列表' : mode === 'help' ? '返回设置' : scope === 'play' ? '返回剧场演出' : '返回列表', back); exit.disabled = busy;
                    if (mode === 'editor') title.append(titleText, exit);
                    else {
                        title.classList.add('tea-back-title'); title.append(exit, titleText);
                        if (mode === 'settings') title.append(element('small', '自动保存', 'tea-auto-save'));
                    }
                    workspace.append(title);
                }
                if (mode === 'editor') renderEditor(workspace);
                else if (mode === 'settings') renderSettings(workspace, settingsPosition);
                else renderHelp(workspace);
            }
        }
        if (workspace.parentElement !== panel) panel.append(workspace);
        if (!keptSettings) diagnosticsView?.restore();
        if (settingsPosition && !keptSettings) workspace.querySelector('.tea-settings').scrollTop = settingsPosition.scrollTop;
        appendStatus();
        mobileNavigation?.sync(scope, resetPosition);
        restoreCatalogPosition();
        const list = panel.querySelector('.tea-list');
        const search = catalogSearch();
        if (focused && search) {
            search.focus({ preventScroll: true });
            search.setSelectionRange(...selection);
        }
        else if (focusKey) [...panel.querySelectorAll('button, select, input[role="switch"]')].find(b => b.getAttribute('aria-label') === focusKey && b.getClientRects().length)?.focus({ preventScroll: true });
        if (list) observer?.observe(list);
        const settingsArea = panel.querySelector('.tea-settings');
        if (settingsArea) observer?.observe(settingsArea);
        for (const body of panel.querySelectorAll('.tea-feed-entry .tea-body')) observer?.observe(body);
        measureBodies();
    }
    function emptyText() {
        if (isRecordFavorites()) return favoriteLoadError || (!favoriteLoaded ? '正在读取收藏…'
            : catalog.query.trim() ? '没有找到符合条件的演出记录。' : '还没有收藏演出记录。');
        return catalog.query.trim() ? '没有找到符合条件的小剧场，换个词试试。' : scope === 'favorites' ? '这里还没有符合分类的收藏。'
            : scope === 'local' ? '点击上方加号，写下你的第一份手稿。\n亲笔手稿仅保存在本地，不会上传至茶会选集分享。' : '当前分类和内容偏好下没有可显示的剧场。';
    }
    function catalogItem(item, number = 1) {
        const row = element('button', undefined, 'tea-story'); row.type = 'button';
        const text = element('span');
        text.append(element('span', scope === 'favorites' ? favoriteTitle(item.favorite ?? item) : item.title, 'tea-story-title'),
            element('small', item.favorite ? item.favorite.characterName : `${typeLabel(item.type)} · ${item.author || '我'}`));
        if (item.favorite?.source.type === 'chat') text.firstChild.prepend(glyph('conversation'));
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
                if (value !== sortMode()) await navigate(() => { state.settings.sortMode = value; actions.saveSettings(); }, true);
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
        const catalogNode = element('aside', undefined, 'tea-catalog'); catalogNode.id = 'tea-catalog'; catalogNode.setAttribute('aria-label', '小剧场目录');
        catalogNode.dataset.scope = scope;
        catalogNode.append(brandHeader());
        catalogNode.append(mobileTabs());
        const searchLine = element('div', undefined, 'tea-search-line'), label = element('label', undefined, 'tea-search-box');
        const input = element('input'); input.type = 'search'; input.placeholder = isRecordFavorites() ? '搜索标题或角色…'
            : media.matches && currentType() ? `搜索${typeLabel(currentType())}…` : '找一场故事…'; input.value = catalog.query;
        input.setAttribute('aria-label', isRecordFavorites() ? '搜索标题或角色名字' : '搜索标题、正文或署名'); input.disabled = !state.settings.enabled;
        const applySearch = (value = input.value) => { catalog.query = value; catalog.page = 0; catalog.selectedId = null; render({ resetPosition: true }); };
        input.addEventListener('compositionstart', () => { searchComposing = true; });
        input.addEventListener('compositionend', () => { searchComposing = false; applySearch(); });
        input.addEventListener('input', event => { if (!searchComposing && !event.isComposing) applySearch(); });
        label.append(glyph('search'), input); searchLine.append(label);
        if (media.matches) {
            searchLine.id = 'tea-mobile-search';
            input.addEventListener('focus', () => { catalog.mobileSearchOpen = true; });
            const clear = iconButton('close', '清空搜索', () => {
                catalog.mobileSearchOpen = true; searchComposing = false; applySearch('');
                catalogSearch()?.focus({ preventScroll: true });
            });
            clear.classList.add('tea-search-clear'); clear.hidden = !catalog.query; label.append(clear);
            const cancelSearch = () => {
                catalog.mobileSearchOpen = false; searchComposing = false; input.blur(); applySearch('');
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
            reshuffleSlot.append(shuffle); searchLine.append(reshuffleSlot); catalogNode.append(searchLine);
        }
        const kinds = element('nav', undefined, 'tea-kinds'); kinds.setAttribute('aria-label', scope === 'favorites' ? '收藏分类' : '剧场分类');
        kinds.classList.toggle('tea-favorite-kinds', scope === 'favorites');
        const types = scope === 'favorites' ? [['standalone', '独立剧场'], ['preset', '随文剧场'], ['record', '演出记录']]
            : [['', '全部'], ['standalone', '独立剧场'], ['preset', '随文剧场']];
        for (const [value, label] of types) {
            const button = textButton(label, () => navigate(() => { catalog.type = value; }, true));
            button.setAttribute('aria-pressed', String(currentType() === value)); kinds.append(button);
        }
        const kindBar = element('div', undefined, 'tea-kind-bar'); kindBar.append(kinds);
        if (media.matches) {
            const search = iconButton('search', '搜索剧场', () => {
                catalog.mobileSearchOpen = true; panel.classList.add('tea-searching'); search.setAttribute('aria-expanded', 'true');
                input.focus({ preventScroll: true });
            });
            search.classList.add('tea-search-toggle'); search.disabled = !state.settings.enabled;
            search.setAttribute('aria-expanded', String(catalog.mobileSearchOpen || !!catalog.query)); search.setAttribute('aria-controls', searchLine.id); kindBar.append(search);
        }
        kindBar.append(sortControl());
        if (media.matches) {
            const tools = element('div', undefined, 'tea-mobile-tools'); tools.append(searchLine, kindBar); catalogNode.append(tools);
        } else catalogNode.append(kindBar);
        const list = element('div', undefined, 'tea-list tea-scroll'); list.dataset.scope = scope;
        const showCatalogEmpty = scope === 'local' || media.matches || mode !== 'list';
        if (state.personalError && scope !== 'community' && !isRecordFavorites()) list.append(element('p', state.personalError, 'tea-error'));
        if (isRecordFavorites() && favoriteLoadError) list.append(iconButton('refresh', '重新读取收藏列表', () => void refreshFavoriteCatalog()));
        if (!state.settings.enabled) {
            if (showCatalogEmpty) list.append(element('p', '插件已停用，请在酒馆扩展设置中重新启用。', 'tea-empty'));
        }
        else for (const [i, item] of visible.entries()) {
            if (media.matches && !isRecordFavorites()) list.append(renderFeedEntry(item, pageStart() + i + 1));
            else {
                const button = textButton('', async () => {
                    if (isRecordFavorites()) { await openRecordFavorite(item.id); return; }
                    if (!await canLeave()) return;
                    captureCatalogPosition();
                    catalog.selectedId = item.id; catalog.readingId = null; catalog.readingScroll = 0;
                    showCatalog(); message = '';
                    restoringCatalog = true; render();
                });
                const row = catalogItem(item, pageStart() + i + 1);
                button.className = row.className; button.dataset.id = item.id;
                button.setAttribute('aria-current', String(catalog.selectedId === item.id)); button.setAttribute('aria-label', item.title); button.title = item.title;
                button.append(...row.childNodes); list.append(button);
            }
        }
        if (!total && state.settings.enabled && showCatalogEmpty) list.append(element('p', emptyText(), 'tea-empty')); catalogNode.append(list);
        catalogNode.append(renderPagination(total));
        return catalogNode;
    }
    function renderPagination(total) {
        const footer = element('nav', undefined, 'tea-pagination'); footer.setAttribute('aria-label', '剧场分页');
        const pages = pageCount(total);
        const turnTo = async target => {
            if (!await canLeave()) return;
            catalog.page = target; catalog.selectedId = null; showCatalog(); render({ resetPosition: true });
        };
        const prev = iconButton('left', '上一页', () => turnTo(catalog.page - 1)); prev.disabled = catalog.page === 0;
        const next = iconButton('right', '下一页', () => turnTo(catalog.page + 1)); next.disabled = catalog.page + 1 >= pages;
        const jump = createPageJump({ getPage: () => catalog.page, getPages: () => pages, onSelect: async target => {
            await turnTo(target); panel?.querySelector('.tea-page-jump summary')?.focus({ preventScroll: true });
        } });
        jump.update();
        footer.append(prev, jump.node, next);
        return footer;
    }
    function articleHeader(item, number, illustration) {
        const head = element('header', undefined, 'tea-article-head'), title = element('div', undefined, 'tea-title-group');
        const kicker = element('div', undefined, 'tea-article-type');
        if (number) kicker.append(element('span', String(number).padStart(2, '0'), 'tea-number'));
        kicker.append(element('span', typeLabel(item.type)));
        if (item.gore) kicker.append(element('span', 'G向', 'tea-content-tag'));
        title.append(kicker, element('h2', scope === 'favorites' && number ? favoriteTitle(item) : item.title, 'tea-article-title'),
            element('p', isManuscript(item.id) ? '亲笔手稿 / 我' : `社区投稿 / ${item.author}`, 'tea-article-meta'));
        head.append(title); if (illustration) head.append(art()); return head;
    }
    function articleActions(item) {
        const buttons = element('div', undefined, 'tea-actions');
        if (isManuscript(item.id)) { const edit = iconButton('edit', '编辑手稿', () => beginEdit(item)); edit.disabled = !!state.personalError; buttons.append(edit); }
        const favorite = Object.hasOwn(state.settings.favorites, item.id);
        const star = iconButton('star', favorite ? '取消收藏' : '收藏剧场', () => { actions.toggleFavorite(item.id); render(); });
        star.classList.add('tea-star'); star.setAttribute('aria-pressed', String(favorite)); buttons.append(star);
        if (item.type === 'standalone') {
            const use = iconButton('insert', '在酒馆中游玩', () => select(item)); buttons.append(use);
            if (actions.playground) {
                const play = iconButton('cup', '在插件中游玩', () => selectInPlugin(item)); play.classList.add('tea-primary', 'play-in-plugin'); buttons.append(play);
            } else use.classList.add('tea-primary');
        }
        return buttons;
    }
    function markdownBody(item) { const body = element('div', undefined, 'tea-body'); body.innerHTML = renderMarkdown(item.body); return body; }
    function renderReader(workspace, item) {
        const reading = element('div', undefined, 'tea-reading tea-scroll'); reading.dataset.id = item.id;
        reading.append(articleHeader(item, null, true), markdownBody(item)); workspace.append(reading);
        const footer = element('footer', undefined, 'tea-reader-footer');
        footer.append(element('p', item.type === 'standalone' ? '一场独立的番外' : '藏在日常里的小插曲\n由预设宏在回复时随机调用', 'tea-footer-note'), articleActions(item)); workspace.append(footer);
    }
    function renderFeedEntry(item, number) {
        const article = element('article', undefined, 'tea-feed-entry'); article.dataset.id = item.id; article.setAttribute('aria-label', item.title);
        article.classList.toggle('tea-expanded', catalog.expanded.has(item.id)); article.append(articleHeader(item, number, number === 1));
        const excerpt = element('div', undefined, 'tea-excerpt'); excerpt.id = `tea-body-${item.id.replaceAll(':', '-')}`; excerpt.append(markdownBody(item)); article.append(excerpt);
        const fold = iconButton(catalog.expanded.has(item.id) ? 'up' : 'down', `${catalog.expanded.has(item.id) ? '收起' : '展开全文'}：${item.title}`, () => {
            const list = panel.querySelector('.tea-list'), closing = catalog.expanded.has(item.id), above = article.getBoundingClientRect().top < list.getBoundingClientRect().top;
            if (closing) catalog.expanded.delete(item.id); else catalog.expanded.add(item.id);
            article.classList.toggle('tea-expanded', !closing); fold.replaceChildren(glyph(closing ? 'down' : 'up'));
            if (!closing) fold.append(element('span', '收起'));
            fold.title = `${closing ? '展开全文' : '收起'}：${item.title}`; fold.setAttribute('aria-label', fold.title); fold.setAttribute('aria-expanded', String(!closing));
            if (closing && above) {
                list.scrollTop += article.getBoundingClientRect().top - list.getBoundingClientRect().top;
                mobileNavigation?.ignoreScroll(list);
            }
            measureBodies();
        });
        fold.classList.add('tea-fold'); fold.setAttribute('aria-controls', excerpt.id); fold.setAttribute('aria-expanded', String(catalog.expanded.has(item.id)));
        if (catalog.expanded.has(item.id)) fold.append(element('span', '收起')); article.append(fold);
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
                try { await actions.deleteManuscript(draft.id); actions.diagnostics?.info('手稿已删除'); mode = 'list'; showMessage('手稿已删除'); }
                catch (error) { actions.diagnostics?.error('删除亲笔手稿', error); showMessage(error.message); }
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
                actions.diagnostics?.info('手稿已保存');
                if (draft.id) catalog.selectedId = item.id;
                mode = 'list'; showMessage(draft.id ? '手稿已保存' : '手稿已保存到亲笔手稿');
            } catch (error) { actions.diagnostics?.error('保存亲笔手稿', error); showMessage(error.message); }
            finally {
                busy = false; render();
            }
        }); workspace.append(form, footer);
    }
    function renderSettings(workspace, viewState) {
        const area = element('div', undefined, 'tea-scroll tea-settings');
        function group(name) {
            const section = element('section', undefined, 'tea-settings-group');
            section.append(element('h3', name)); area.append(section); return section;
        }
        const library = group('剧场库');
        library.classList.add('tea-library-settings');
        const update = element('section', undefined, 'tea-update-setting');
        const controls = element('div', undefined, 'tea-update-controls');
        const button = iconButton('refresh', '手动更新', actions.updateLibrary); button.classList.add('tea-manual-update');
        const updateStatus = element('div', '', 'tea-update-status');
        updateStatus.setAttribute('role', 'status'); updateStatus.setAttribute('aria-live', 'polite');
        controls.append(element('strong', '更新剧场库'), button, element('small', '启动酒馆时会自动更新。'), updateStatus);
        update.append(controls); library.append(update);
        const preference = element('section', undefined, 'tea-content-preference');
        const label = element('label', undefined, 'tea-setting-row');
        const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = state.settings.showGore === true;
        toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-describedby', 'tea-gore-description');
        toggle.setAttribute('aria-label', '显示 G 向内容');
        label.append(element('strong', '显示 G 向内容'), toggle);
        const description = element('p', '在列表和随文剧场中包含血腥、猎奇等内容。', 'tea-setting-description');
        description.id = 'tea-gore-description';
        toggle.addEventListener('change', () => {
            state.settings.showGore = toggle.checked; actions.saveSettings();
            if (scope !== 'play') { catalog.page = 0; catalog.selectedId = null; catalog.expanded.clear(); }
            render({ resetPosition: scope !== 'play' });
        });
        preference.append(label, description); library.append(preference);
        const help = textButton('随文剧场用法', () => { mode = 'help'; render(); }); help.className = 'tea-text-button'; library.append(help);
        let processingSettings;
        if (actions.playground) {
            const generation = group('小剧场生成');
            apiSettings ??= createPlayApiSettings(ctx, state.settings, actions.saveSettings, actions.diagnostics);
            generation.append(apiSettings.node);
            renderPlayChatSetting(generation, state.settings, actions.saveSettings);
            renderPlayPromptSetting(generation, state.settings, actions.saveSettings);
            const display = group('正则与隐藏标签');
            display.classList.add('play-display-settings');
            display.append(element('p', '仅用于插件内的小剧场。', 'tea-setting-description'));
            processingSettings = renderPlayProcessingSettings(display, state.settings, actions.saveSettings, actions.playground.display, viewState?.rules);
        }
        const reading = group('阅读外观');
        renderAppearanceSetting(reading);
        renderFontSourceSetting(reading);
        renderFontSizeSetting(reading, () => panel.style.setProperty('--tea-body-size', `${bodyFontSize()}px`));
        const spacing = element('div', undefined, 'tea-setting-row tea-desktop-setting');
        const choices = element('div', undefined, 'tea-choice'); choices.setAttribute('aria-label', '目录间距');
        for (const [value, name] of [[false, '舒展'], [true, '紧凑']]) {
            const button = textButton(name, () => { state.settings.compact = value; actions.saveSettings(); render(); });
            button.setAttribute('aria-pressed', String((state.settings.compact !== false) === value)); choices.append(button);
        }
        spacing.append(element('strong', '目录间距'), choices); reading.append(spacing);
        if (media.matches) {
            const row = element('label', undefined, 'tea-setting-row'), size = element('select'); size.setAttribute('aria-label', '每页篇数');
            for (const n of [5,10,20,50]) { const option = element('option', `${n} 篇`); option.value = String(n); size.append(option); } size.value = String(mobilePageSize());
            size.addEventListener('change', () => {
                state.settings.pageSize = Number(size.value); actions.saveSettings();
                if (scope !== 'play') { catalog.page = 0; catalog.selectedId = null; }
                render({ resetPosition: scope !== 'play' });
            }); row.append(element('strong', '每页篇数'), size); reading.append(row);
        }
        if (actions.playground) renderPlayRetrySettings(group('自动重试'), state.settings, actions.saveSettings);
        if (actions.diagnostics) diagnosticsView = renderDiagnostics(area, actions.diagnostics, viewState?.logs);
        if (actions.playground) renderPlayContinuationSettings(group('小剧场续写'), state.settings, actions.saveSettings);
        workspace.append(area);
        settingsView = {
            capture: () => ({ scrollTop: area.scrollTop, rules: processingSettings?.capture(), logs: diagnosticsView?.capture() }),
            layout: () => processingSettings?.layout(),
        };
    }
    function renderAppearanceSetting(area) {
        const row = element('label', undefined, 'tea-setting-row'), select = element('select');
        select.setAttribute('aria-label', '外观');
        for (const [value, name] of [['default', '默认'], ['tavern', '跟随酒馆主题']]) {
            const option = element('option', name); option.value = value; select.append(option);
        }
        select.value = state.settings.appearance === 'tavern' ? 'tavern' : 'default';
        select.addEventListener('change', () => {
            state.settings.appearance = select.value; actions.saveSettings();
            appearance.apply(select.value); measureBodies();
        });
        row.append(element('strong', '外观'), select); area.append(row);
    }
    function renderFontSourceSetting(area) {
        const row = element('label', undefined, 'tea-setting-row'), font = element('select');
        font.setAttribute('aria-label', '字体');
        const label = element('span'); label.append(element('strong', '字体'), element('small', '应用于正文和界面文字'));
        for (const [value, name] of [['default', '默认字体'], ['tavern', '跟随酒馆字体']]) {
            const option = element('option', name); option.value = value; font.append(option);
        }
        font.value = state.settings.fontSource === 'tavern' ? 'tavern' : 'default';
        font.addEventListener('change', () => {
            const settingsArea = font.closest('.tea-settings'), scrollTop = settingsArea?.scrollTop;
            state.settings.fontSource = font.value; actions.saveSettings(); applyFontSource(); measureBodies();
            if (settingsArea && Number.isFinite(scrollTop)) {
                settingsArea.scrollTop = scrollTop;
                requestAnimationFrame(() => { if (settingsArea.isConnected) settingsArea.scrollTop = scrollTop; });
            }
        });
        row.append(label, font); area.append(row);
    }
    function renderFontSizeSetting(area, onChange = render) {
        const row = element('label', undefined, 'tea-setting-row'), font = element('select');
        font.setAttribute('aria-label', '正文字号');
        const key = media.matches ? 'mobileFontSize' : 'fontSize';
        for (const value of bodyFontSizes) { const option = element('option', String(value)); option.value = String(value); font.append(option); }
        font.value = String(bodyFontSize());
        font.addEventListener('change', () => { state.settings[key] = Number(font.value); actions.saveSettings(); onChange(); });
        row.append(element('strong', '正文字号'), font); area.append(row);
    }
    function renderHelp(workspace) {
        const area = element('div', undefined, 'tea-scroll tea-help');
        for (const [title, macro, description] of [['所有随文剧场', '{{茶话会小剧场}}', '从所有随文剧场中随机抽取。'], ['收藏的随文剧场', '{{我收藏的小剧场}}', '从收藏的随文剧场中随机抽取，也包括收藏的亲笔手稿。']]) {
            area.append(element('h3', title)); const row = element('div', undefined, 'tea-macro'); row.append(element('code', macro));
            row.append(iconButton('copy', '复制宏', async () => { try { await copyText(macro); showMessage('宏已复制，可粘贴到预设中'); } catch { showMessage('复制未成功，请选中宏文字手动复制。'); } }));
            area.append(row, element('p', description));
        }
        area.append(element('p', '把需要的宏放置在预设原先放小剧场的位置，宏会在向AI发送请求时被替换为随机的一个小剧场。通常仅放其中一个宏即可，两个不同种类宏同时被放入预设中时，会各自输出一条。'), element('p', '不要将一个宏多次放置，会输出多条同样内容。')); workspace.append(area);
    }
    function onBreakpoint() {
        if (!panel) return;
        mobileNavigation?.sync(scope);
        if (scope === 'play' && mode === 'list') { panel.style.setProperty('--tea-body-size', `${bodyFontSize()}px`); playView?.layout(); return; }
        if (isRecordFavorites()) { if (!media.matches && mode === 'record') mode = 'list'; render(); return; }
        catalog.page = 0; catalog.selectedId = null; render({ resetPosition: true });
    }
    return {
        async open() {
            if (popup || opening || !state.settings.enabled) return;
            opening = true;
            try {
                await actions.loaded; if (!state.settings.enabled) return;
                media = matchMedia('(max-width: 760px)'); media.addEventListener('change', onBreakpoint);
                observer = new ResizeObserver(measureBodies);
                mode = media.matches && isRecordFavorites() && catalog.recordOpen ? 'record' : 'list';
                message = ''; panel = element('div'); panel.id = 'teahouse-panel';
                viewDiagnostics = createViewDiagnostics(panel, actions.diagnostics, () => ({ scope, mode, route: playRoute,
                    appearance: state.settings.appearance === 'tavern' ? 'tavern' : 'default',
                    fontSource: state.settings.fontSource === 'tavern' ? 'tavern' : 'default' }));
                mobileNavigation = createMobileNavigation(panel, media);
                appearance = createAppearance(panel, actions.diagnostics); appearance.apply(state.settings.appearance);
                panel.addEventListener('pointerdown', event => {
                    for (const menu of panel.querySelectorAll('.tea-sort[open], .tea-page-jump[open], .play-chat-menu[open]')) {
                        if (!menu.contains(event.target)) menu.open = false;
                    }
                });
                render();
                if (isRecordFavorites()) void refreshFavoriteCatalog();
                const context = ctx();
                popup = new context.Popup(panel, context.POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: false,
                    onClosing: async () => {
                        if (!await canLeave()) return false;
                        if (scope === 'play') playView?.prepareLayout();
                        chatView?.prepareLayout();
                        captureCatalogPosition(); return true;
                    },
                    onOpen: () => {
                        viewDiagnostics?.event('弹窗开启动画结束');
                        mobileNavigation?.sync(scope);
                        restoreCatalogPosition();
                        measureBodies();
                        const candidate = panel.querySelector('.tea-topbar button:not([disabled]), .tea-mobile-actions button:not([disabled]), .tea-brand button:not([disabled])');
                        const target = (candidate && candidate.getClientRects().length) ? candidate : [...panel.querySelectorAll('button')].find(b => !b.disabled && b.getClientRects().length);
                        target?.focus({ preventScroll: true });
                    } });
                popup.dlg.classList.add('teahouse-dialog');
                resizeViewport = () => { const viewport = window.visualViewport; if (!viewport || !popup) return;
                    popup.dlg.style.setProperty('--tea-viewport-height', `${viewport.height}px`); popup.dlg.style.setProperty('--tea-viewport-top', `${viewport.offsetTop}px`); };
                window.visualViewport?.addEventListener('resize', resizeViewport); window.visualViewport?.addEventListener('scroll', resizeViewport); resizeViewport();
                actions.diagnostics?.info('打开剧场面板');
                await popup.show();
                actions.diagnostics?.info('关闭剧场面板');
            } finally {
                sentPromptViewer?.dispose(); sentPromptViewer = null;
                disposeFavoriteComposer();
                apiSettings?.cancel();
                diagnosticsView?.dispose(); diagnosticsView = null; settingsView = null;
                clearTimeout(messageTimer);
                if (playActive) {
                    playView?.deactivate();
                    playActive = false;
                }
                if (chatActive) { chatView?.deactivate(); chatActive = false; }
                playCatalog = null; playWorkspace = null; favoriteWorkspace = null;
                chatCatalog = null; chatWorkspace = null;
                mobileNavigation?.dispose(); mobileNavigation = null;
                observer?.disconnect(); cancelAnimationFrame(measureFrame); media?.removeEventListener('change', onBreakpoint);
                window.visualViewport?.removeEventListener('resize', resizeViewport); window.visualViewport?.removeEventListener('scroll', resizeViewport);
                appearance?.dispose(); appearance = null; popup = null; panel = null; opening = false;
                viewDiagnostics?.dispose(); viewDiagnostics = null;
                searchComposing = false;
                restoringCatalog = false;
            }
        },
        refresh() {
            syncRandomOrders();
            if (!panel) return;
            if (scope === 'play' && mode === 'list') {
                updateStatus();
                if (playRoute === 'play') void playView?.refresh();
                else void chatView?.refresh();
            } else if (isRecordFavorites() && ['list', 'record'].includes(mode)) void refreshFavoriteCatalog();
            else if (mode === 'editor') {
                updateStatus();
            } else render({ preserveSettings: true });
        },
        refreshStatus: updateStatus,
        close,
    };
}
