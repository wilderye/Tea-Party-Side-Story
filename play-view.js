import { element, textButton, glyph, iconButton, createPageJump } from './ui.js';
import { readPlayTarget } from './play-runtime.js';
import { renderPlayText, playTextPreview } from './play-render.js';
import { createPlayEditor } from './play-editor.js';
import { favoriteFirstLine, favoriteSourceKey } from './play-favorites-view.js';

const pad = value => String(value).padStart(2, '0');
const characterKey = character => character?.id ?? (character?.avatar ? `avatar:${character.avatar}` : '');
const activePhases = new Set(['preparing', 'generating']);
const statusText = { preparing: '正在准备', generating: '正在生成', saving: '正在保存',
    stopped: '已停止', failed: '生成失败', unfinished: '未完成', 'save-failed': '尚未保存' };
const characterBatchSize = 24;
const historyPageSize = 10;

function dateParts(value, now = new Date()) {
    const date = new Date(value);
    const day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
    return { date, day: date.getFullYear() === now.getFullYear() ? day : `${pad(date.getFullYear() % 100)}/${day}`,
        time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
}
function messageTime(value) { const { day, time } = dateParts(value); return `${day} · ${time}`; }
function recentTime(value) {
    const now = new Date(), parts = dateParts(value, now), yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return { day: parts.date.toDateString() === now.toDateString() ? '今天'
        : parts.date.toDateString() === yesterday.toDateString() ? '昨天' : parts.day, time: parts.time };
}

/** A persistent conversation view. History and generation stay in playground. */
export function createPlayView(ctx, settings, playground, notify, diagnostics, promptFavorites) {
    const mobile = matchMedia('(max-width: 760px)');
    const browser = element('div', undefined, 'play-character-browser'); browser.id = 'play-character-browser';
    const browserHead = element('header', undefined, 'play-character-heading');
    const browserBack = iconButton('left', '返回演出记录', () => setBrowsing(false));
    browserHead.append(browserBack, element('h2', '选择角色'));
    const searchLine = element('div', undefined, 'tea-search-line play-character-search');
    const searchLabel = element('label', undefined, 'tea-search-box');
    const search = element('input'); search.type = 'search'; search.placeholder = '搜索角色…'; search.setAttribute('aria-label', '搜索角色');
    searchLabel.append(glyph('search'), search); searchLine.append(searchLabel);
    const people = element('nav', undefined, 'play-people'); people.setAttribute('aria-label', '按角色查看演出记录');
    const pagination = element('nav', undefined, 'tea-pagination play-people-pagination'); pagination.setAttribute('aria-label', '角色列表翻页');
    const previousPage = iconButton('left', '上一页角色', () => turnCharacters(-1));
    const nextPage = iconButton('right', '下一页角色', () => turnCharacters(1));
    const pageJump = createPageJump({ label: '跳转角色页码', getPage: () => characterPage,
        getPages: () => Math.max(1, Math.ceil(matchingCharacters().length / charactersPerPage)),
        onSelect: target => { characterPage = target; renderPeople(true); } });
    pagination.append(previousPage, pageJump.node, nextPage);
    browser.append(browserHead, searchLine, people, pagination);
    const chooseButton = iconButton('people', '选择角色', () => setBrowsing(true));
    chooseButton.setAttribute('aria-controls', browser.id);
    const page = element('div', undefined, 'play-page');
    const readingArea = element('div', undefined, 'play-reading-area');
    const feed = element('div', undefined, 'tea-scroll play-feed'); feed.setAttribute('aria-label', '小剧场对话历史');
    const content = element('div', undefined, 'play-feed-content');
    const earlierBar = textButton('', () => void loadEarlierHistory()); earlierBar.className = 'play-earlier-bar'; earlierBar.hidden = true;
    content.append(earlierBar);
    const empty = element('div', undefined, 'play-empty'); empty.setAttribute('role', 'status');
    const emptyArt = element('img', undefined, 'play-empty-art'); emptyArt.src = new URL('./assets/tea-party.svg', import.meta.url).href; emptyArt.alt = ''; emptyArt.hidden = true;
    const emptyTitle = element('p', '正在读取演出记录…', 'play-empty-title'); empty.append(emptyArt, emptyTitle);
    const readError = element('div', undefined, 'play-load-error'); readError.hidden = true;
    feed.append(content, empty, readError);
    const jump = iconButton('bottom', '跳到最新消息', jumpToLatest); jump.classList.add('play-jump-latest'); jump.hidden = true;
    readingArea.append(feed, jump);
    const compose = element('footer', undefined, 'play-compose'), inner = element('div', undefined, 'play-compose-inner');
    const contextLine = element('div', undefined, 'play-compose-context'); contextLine.hidden = true;
    const inputRow = element('div', undefined, 'play-input-row');
    const input = element('textarea', undefined, 'play-compose-input'); input.rows = 1; input.spellcheck = false;
    input.setAttribute('aria-label', '小剧场提示词'); input.placeholder = '写下小剧场提示词…';
    const send = iconButton('send', '发送小剧场', () => {
        if (activePhases.has(playground.getState().phase)) playground.stop();
        else void sendDraft();
    }); send.classList.add('play-send');
    inputRow.append(input, send); inner.append(contextLine, inputRow); compose.append(inner); page.append(readingArea, compose);

    const records = new Map(), views = new Map(), rowsByCharacter = new Map(), visibleCounts = new Map();
    const positions = new Map(), selections = new Map(), drafts = new Map();
    let characters = [], selected = null, current = null, currentError = '', root, visible = false, loaded = false, loadingEarlier = false;
    let refreshId = 0, saveTimer, layoutFrame, streamFrame = 0, resultMenu, pendingSend, pendingReveal, storageFailed = false;
    let characterPage = 0, charactersPerPage = 8, mobileLimit = characterBatchSize, peopleScroll = 0;
    let characterQuery = '', searchComposing = false, searchTimer, browsing = null, lastMobile = mobile.matches;
    let cachedRowHeight = 0, lastInputVal = null, lastInputClientWidth = 0, lastPageHeight = 0;
    let user = { name: ctx().name1 || 'User', avatar: null }, userRefreshId = 0;
    let favoriteRows = new Map(), favoritesReady = false, favoritesRefreshId = 0;
    let lastJob = playground.getState();
    let displayedCharacter = '', restoringPosition = false, cachedPosition = null, positionTimer = 0;
    const storageKey = 'teahouse-play-view-v1';

    try {
        const saved = JSON.parse(ctx().accountStorage?.getItem(storageKey) ?? 'null');
        if (saved?.format === 1) {
            for (const [key, value] of saved.positions ?? []) if (typeof key === 'string' && value && typeof value === 'object') positions.set(key, value);
            for (const [key, value] of saved.selections ?? []) if (typeof key === 'string' && typeof value === 'string') selections.set(key, value);
            for (const [key, value] of saved.drafts ?? []) {
                if (typeof key !== 'string' || !value || typeof value.text !== 'string') continue;
                drafts.set(key, value);
            }
        }
    } catch (error) { diagnostics?.error('读取剧场草稿和阅读位置', error); storageFailed = true; }

    function saveViewState() {
        clearTimeout(saveTimer);
        try {
            ctx().accountStorage?.setItem(storageKey, JSON.stringify({ format: 1,
                positions: [...positions], selections: [...selections], drafts: [...drafts] }));
        } catch (error) {
            if (!storageFailed) diagnostics?.error('保存剧场草稿和阅读位置', error);
            storageFailed = true;
        }
    }
    function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveViewState, 300); }
    function draftFor(key = characterKey(selected)) {
        if (!drafts.has(key)) drafts.set(key, { text: '', origin: null });
        return drafts.get(key);
    }
    function canWrite() { return !!current && selected?.avatar === current.avatar && settings.enabled !== false; }
    function syncCurrent() {
        try { current = readPlayTarget(ctx()).character; currentError = ''; }
        catch (error) { current = null; currentError = error.message; }
    }
    function avatar(character, className, type = 'avatar') {
        const fallback = element('span', character.name.slice(0, 1), `${className} play-avatar-fallback`);
        fallback.setAttribute('aria-hidden', 'true');
        if (!character.avatar) return fallback;
        const image = element('img', undefined, className); image.alt = ''; image.draggable = false;
        image.loading = 'lazy'; image.decoding = 'async';
        image.src = ctx().getThumbnailUrl?.(type, character.avatar) ?? `/thumbnail?type=${type}&file=${encodeURIComponent(character.avatar)}`;
        image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
        return image;
    }
    async function refreshUser() {
        const id = ++userRefreshId;
        let identity;
        try { identity = await playground.getUserIdentity?.(); } catch { /* Keep the name and initials if the host avatar cannot be read. */ }
        if (id !== userRefreshId) return;
        user = identity ?? { name: ctx().name1 || 'User', avatar: null };
        keepReading(() => {
            for (const [roundId, view] of views) {
                const round = records.get(roundId)?.round;
                if (round) updateUserMessage(round, view);
            }
        });
    }
    function updateUserMessage(round, view) {
        view.user.hidden = round.prompt === null && !view.userEditor;
        const signature = JSON.stringify(user);
        if (view.userSignature !== signature) {
            view.userSignature = signature;
            view.userHeader.speaker.textContent = user.name; view.userHeader.speaker.title = user.name;
            view.userHead.querySelector('.play-message-avatar').replaceWith(avatar(user, 'play-message-avatar', 'persona'));
            view.user.setAttribute('aria-label', `${user.name} 发送的小剧场提示词`);
        }
        const tools = view.userEditor ? [view.userEditor.actions] : [view.userFavorite, view.edit, view.removePrompt];
        if (view.userTools.firstChild !== tools[0]) view.userTools.replaceChildren(...tools);
        if (round.prompt === null) {
            if (!view.userEditor) { view.userText.replaceChildren(); view.promptText = null; }
            return;
        }
        // Expand only display names; keep the saved prompt and other macros untouched.
        const names = { user: user.name, char: roundCharacter(round).name };
        const text = round.prompt.replace(/\{\{(user|char)\}\}/gi, (_, macro) => names[macro.toLowerCase()]);
        if (!view.userEditor && view.promptText !== text) {
            renderPlayText(view.userText, text, `${round.id}/user/text`);
            view.promptText = text;
        }
    }
    async function refreshFavorites() {
        if (!playground.listFavorites) return;
        const id = ++favoritesRefreshId;
        try {
            const rows = await playground.listFavorites();
            if (id !== favoritesRefreshId) return;
            favoriteRows = new Map(rows.map(row => [favoriteSourceKey(row.source), row])); favoritesReady = true;
        } catch { if (id === favoritesRefreshId) favoritesReady = false; }
        for (const [roundId, view] of views) {
            const round = records.get(roundId)?.round;
            if (round) updateFavoriteStar(round, view);
        }
    }
    function updateFavoriteStar(round, view) {
        const result = selectedResult(round);
        if (!result) { view.favorite.hidden = true; return; }
        const favorite = favoriteRows.has(favoriteSourceKey({ roundId: round.id, resultId: result.id, startedAt: result.startedAt }));
        view.favorite.title = favorite ? '取消收藏' : '收藏演出记录';
        view.favorite.setAttribute('aria-label', view.favorite.title); view.favorite.setAttribute('aria-pressed', String(favorite));
        view.favorite.hidden = !canEditResult(result) || result.status === 'save-failed' || !result.text.trim() || isEditing(round.id);
        view.favorite.disabled = !favoritesReady || !!view.favoriting || !!view.removing;
    }
    function updatePromptFavoriteStar(round, view) {
        const favorite = promptFavorites?.isFavorite(round) ?? false;
        view.userFavorite.title = favorite ? '取消收藏' : '收藏用户消息';
        view.userFavorite.setAttribute('aria-label', view.userFavorite.title);
        view.userFavorite.setAttribute('aria-pressed', String(favorite));
        view.userFavorite.hidden = !promptFavorites || !canEditPrompt(round) || isEditing(round.id);
        view.userFavorite.disabled = !!view.favoriting || !!view.removing;
    }
    async function togglePromptFavorite(id) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!promptFavorites || !canEditPrompt(round) || !view || view.favoriting || view.removing || isEditing(id)) return;
        view.favoriting = true; updateControls();
        try {
            const current = await playground.getRound(id);
            if (current.prompt !== round.prompt) {
                records.set(id, { round: current });
                keepReading(() => renderRecord(current, view));
                throw new Error('这条用户消息已在其他窗口修改，已更新显示，请核对后再收藏。');
            }
            const result = await promptFavorites.toggle(current);
            diagnostics?.info(result.favorite ? '用户消息收藏完成' : '用户消息取消收藏完成');
            notify(result.favorite ? result.created ? '已存入亲笔手稿并收藏' : '已收藏剧场' : '已取消收藏');
        } catch (error) { diagnostics?.error('收藏用户消息', error); notify(error.message); }
        finally { view.favoriting = false; updateControls(); }
    }
    async function toggleFavorite(id) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!round || !view || !favoritesReady || view.favoriting || view.removing || isEditing(id)) return;
        const result = selectedResult(round);
        if (!canEditResult(result) || result.status === 'save-failed' || !result.text.trim()) return;
        const source = { roundId: id, resultId: result.id, startedAt: result.startedAt }, key = favoriteSourceKey(source);
        const existing = favoriteRows.get(key);
        view.favoriting = true; updateControls();
        try {
            if (existing) { await playground.removeFavorite(existing.id); favoriteRows.delete(key); }
            else {
                const cleanedText = playground.display?.process(result.text) ?? result.text;
                if (!cleanedText.trim()) throw new Error('演出内容清洗后为空，无法收藏');
                const favorite = await playground.addFavorite({ ...source, expectedText: result.text,
                    text: cleanedText,
                    firstLine: favoriteFirstLine(cleanedText, playground.display) });
                favoriteRows.set(key, favorite);
            }
            // A read started before this completed write must not put the
            // previous star state back, even if that read returns later.
            favoritesRefreshId++;
            notify(existing ? '已取消收藏' : '已收藏演出记录');
        } catch (error) { notify(error.message); }
        finally { view.favoriting = false; if (records.get(id)?.round) updateFavoriteStar(records.get(id).round, view); updateControls(); }
    }
    function matchingCharacters() {
        const query = characterQuery.trim().toLocaleLowerCase();
        return query ? characters.filter(character => character.name.toLocaleLowerCase().includes(query)) : characters;
    }
    function characterButton(character) {
        const button = textButton('', () => void chooseCharacter(character)); button.className = 'play-person';
        button.dataset.character = characterKey(character); button.setAttribute('aria-label', character.name); button.title = character.name;
        button.setAttribute('aria-pressed', String(characterKey(selected) === characterKey(character)));
        const copy = element('span', undefined, 'play-person-copy'); copy.append(element('span', character.name, 'play-person-name'));
        const time = element('time', undefined, 'play-person-time');
        if (character.lastPlayedAt) {
            const recent = recentTime(character.lastPlayedAt); time.dateTime = character.lastPlayedAt;
            time.append(element('span', recent.day, 'play-person-date'), element('small', recent.time, 'play-person-clock'));
        }
        button.append(avatar(character, 'play-avatar'), copy, time); return button;
    }
    function measureCharactersPerPage() {
        if (mobile.matches || !people.clientHeight || !people.clientWidth) return charactersPerPage;
        if (!cachedRowHeight) {
            const row = people.querySelector('.play-person');
            const probe = !row && characters.length ? characterButton(characters[0]) : null;
            // The first catalog read can finish after the empty view was measured.
            // Measure a real row now, before exposing a page with the default count.
            if (probe) people.append(probe);
            cachedRowHeight = (row ?? probe)?.getBoundingClientRect().height || 0;
            probe?.remove();
        }
        return cachedRowHeight ? Math.max(1, Math.floor(people.clientHeight / cachedRowHeight)) : charactersPerPage;
    }
    function renderPeople(resetScroll = false) {
        if (mobile.matches && !browsing) return;
        const position = resetScroll ? 0 : peopleScroll;
        const count = measureCharactersPerPage();
        if (count !== charactersPerPage) {
            characterPage = Math.floor(characterPage * charactersPerPage / count); charactersPerPage = count;
        }
        const matches = matchingCharacters(), pages = Math.max(1, Math.ceil(matches.length / charactersPerPage));
        characterPage = Math.min(characterPage, pages - 1);
        const start = mobile.matches ? 0 : characterPage * charactersPerPage;
        const shown = matches.slice(start, mobile.matches ? mobileLimit : start + charactersPerPage);
        const selectedKey = characterKey(selected);
        const currentButtons = [...people.querySelectorAll('.play-person')];
        if (shown.length && currentButtons.length === shown.length && shown.every((c, i) => characterKey(c) === currentButtons[i].dataset.character)) {
            for (const button of currentButtons) {
                button.setAttribute('aria-pressed', String(button.dataset.character === selectedKey));
            }
            pageJump.update();
            previousPage.disabled = characterPage === 0; nextPage.disabled = characterPage >= pages - 1;
            if (position > 0 && people.scrollTop !== position) people.scrollTop = position;
            return;
        }
        people.replaceChildren();
        people.append(...shown.map(characterButton));
        if (!shown.length) people.append(element('p', characterQuery.trim() ? '没有找到这个角色' : loaded ? '酒馆里还没有角色' : '正在读取角色…', 'play-people-empty'));
        pageJump.update();
        previousPage.disabled = characterPage === 0; nextPage.disabled = characterPage >= pages - 1;
        if (position > 0 && people.scrollTop !== position) people.scrollTop = position;
    }
    function turnCharacters(direction) {
        characterPage += direction; renderPeople(true);
    }
    function loadMoreCharacters() {
        if (!mobile.matches || !browsing || !people.clientHeight || people.scrollHeight - people.scrollTop - people.clientHeight > 200) return;
        const matches = matchingCharacters();
        if (mobileLimit >= matches.length) return;
        const next = mobileLimit + characterBatchSize;
        people.append(...matches.slice(mobileLimit, next).map(characterButton)); mobileLimit = next;
    }
    function updateBrowser() {
        if (!root) return;
        root.classList.toggle('play-choosing-character', !!browsing);
        chooseButton.setAttribute('aria-expanded', String(!!browsing));
        browserBack.hidden = !selected;
    }
    function setBrowsing(value) {
        if (!value && !selected) return;
        closeResults(false); rememberPosition();
        if (browsing) peopleScroll = people.scrollTop;
        browsing = value; updateBrowser();
        if (browsing) { renderPeople(); people.scrollTop = peopleScroll; browserBack.focus({ preventScroll: true }); }
        else { chooseButton.focus({ preventScroll: true }); restorePosition(positions.get(characterKey(selected))); }
        layout();
    }
    function applyCharacterSearch() {
        clearTimeout(searchTimer); characterQuery = search.value; characterPage = 0; mobileLimit = characterBatchSize; peopleScroll = 0;
        renderPeople(true); layout();
    }
    search.addEventListener('compositionstart', () => { searchComposing = true; clearTimeout(searchTimer); });
    search.addEventListener('compositionend', () => { searchComposing = false; applyCharacterSearch(); });
    search.addEventListener('input', event => {
        if (!searchComposing && !event.isComposing) { clearTimeout(searchTimer); searchTimer = setTimeout(applyCharacterSearch, 120); }
    });
    search.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); applyCharacterSearch(); search.blur(); }
    });
    people.addEventListener('scroll', () => { peopleScroll = people.scrollTop; loadMoreCharacters(); }, { passive: true });
    function capturePosition(followBottom = true) {
        if (!visible || restoringPosition || !feed.clientHeight || !selected || displayedCharacter !== characterKey(selected)) return null;
        if (followBottom && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 12) return { bottom: true };
        const top = feed.getBoundingClientRect().top;
        for (const anchor of content.querySelectorAll('[data-read-anchor]')) {
            if (!anchor.getClientRects().length) continue;
            const box = anchor.getBoundingClientRect();
            if (box.height && box.bottom > top + 1) return { bottom: false, anchor: anchor.dataset.readAnchor, offset: top - box.top, scrollTop: feed.scrollTop };
        }
        return { bottom: false, scrollTop: feed.scrollTop };
    }
    function commitPosition(position) {
        if (!position) return;
        const key = characterKey(selected), previous = positions.get(key);
        // scrollTop can round to whole pixels. Keep the intended offset so
        // rounding after every inserted batch does not accumulate as drift.
        if (position.anchor && position.anchor === previous?.anchor && Math.abs(position.offset - previous.offset) < 1) {
            position.offset = previous.offset;
        }
        cachedPosition = { ...position, scrollTop: feed.scrollTop, key };
        positions.set(key, position); scheduleSave();
    }
    function rememberPosition(followBottom = true, forceSync = false) {
        if (!visible || restoringPosition || !feed.clientHeight || !selected || displayedCharacter !== characterKey(selected)) return;
        const key = characterKey(selected);
        if (followBottom && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 12) {
            clearTimeout(positionTimer);
            commitPosition({ bottom: true });
            return;
        }
        if (!forceSync && cachedPosition && cachedPosition.key === key && Math.abs((cachedPosition.scrollTop ?? -999) - feed.scrollTop) < 2) {
            return;
        }
        clearTimeout(positionTimer);
        if (forceSync) {
            commitPosition(capturePosition(followBottom));
        } else {
            positionTimer = setTimeout(() => {
                if (!visible || restoringPosition) return;
                commitPosition(capturePosition(followBottom));
            }, 80);
        }
    }
    function updateJump() {
        jump.hidden = !visible || feed.clientHeight <= 0 || feed.scrollHeight - feed.clientHeight - feed.scrollTop <= feed.clientHeight;
        jump.disabled = jump.hidden;
    }
    function restorePosition(position) {
        if (!visible || !feed.clientHeight) return;
        if (!position || position.bottom) {
            const target = feed.scrollHeight;
            if (Math.abs(feed.scrollTop - target) > 2) feed.scrollTop = target;
        } else {
            const anchor = [...content.querySelectorAll('[data-read-anchor]')].find(node => node.dataset.readAnchor === position.anchor && node.getClientRects().length);
            if (anchor) {
                const target = feed.scrollTop + (anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top) + (Number(position.offset) || 0);
                if (Math.abs(feed.scrollTop - target) > 2) feed.scrollTop = target;
            } else {
                const target = Number(position.scrollTop) || 0;
                if (Math.abs(feed.scrollTop - target) > 2) feed.scrollTop = target;
            }
        }
        cachedPosition = position ? { ...position, scrollTop: feed.scrollTop, key: characterKey(selected) } : null;
        updateJump();
    }
    function keepReading(change, followBottom = true) {
        // Editing keeps a visible anchor even when the feed was at the bottom.
        const position = capturePosition(followBottom) ?? positions.get(characterKey(selected));
        change(); restorePosition(position); rememberPosition(followBottom, true);
    }
    function jumpToLatest() {
        if (!visible) return;
        feed.scrollTop = feed.scrollHeight;
        clearTimeout(positionTimer);
        commitPosition({ bottom: true });
        updateJump();
    }
    function jumpToMessage(id, role) {
        const view = views.get(id), message = view?.[role];
        if (!visible || !message?.getClientRects().length) return;
        feed.scrollTop += message.getBoundingClientRect().top - feed.getBoundingClientRect().top - 10;
        rememberPosition(true, true); updateJump();
    }
    function resizeInput(force = false) {
        if (!visible || inputRow.hidden || !page.clientHeight) return;
        const currentVal = input.value;
        const currentWidth = input.clientWidth;
        const currentPageHeight = page.clientHeight;
        if (!force && currentVal === lastInputVal && currentWidth === lastInputClientWidth && currentPageHeight === lastPageHeight) {
            return;
        }
        lastInputVal = currentVal;
        lastInputClientWidth = currentWidth;
        lastPageHeight = currentPageHeight;

        const previousScroll = input.scrollTop, style = getComputedStyle(input);
        const line = parseFloat(style.lineHeight) || 20, padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const maxLines = matchMedia('(max-width: 760px)').matches ? 8 : 20;
        const footerStyle = getComputedStyle(compose);
        const available = page.clientHeight - contextLine.offsetHeight - (parseFloat(footerStyle.paddingTop) || 0) - (parseFloat(footerStyle.paddingBottom) || 0) - 32;
        const maximum = Math.max(line + padding, Math.min(maxLines * line + padding, available));
        input.style.height = 'auto';
        const nextHeight = `${Math.max(line + padding, Math.min(input.scrollHeight, maximum))}px`;
        if (input.style.height !== nextHeight) input.style.height = nextHeight;
        input.dataset.maxLines = String(maxLines); input.scrollTop = previousScroll;
    }
    function layout() {
        cancelAnimationFrame(layoutFrame);
        if (!visible) return;
        if (lastMobile !== mobile.matches) { lastMobile = mobile.matches; cachedRowHeight = 0; renderPeople(); updateBrowser(); }
        // ResizeObserver runs before paint; do not defer catalog pagination by a frame.
        if (measureCharactersPerPage() !== charactersPerPage) renderPeople(true);
        layoutFrame = requestAnimationFrame(() => {
            if (!visible) return;
            loadMoreCharacters();
            resizeInput();
            const feedHeight = feed.clientHeight;
            const updates = [];
            for (const [id, view] of views) {
                if (view.item.hidden) continue;
                const uHead = view.uHead ??= (view.userHead.offsetHeight || 44);
                const aHead = view.aHead ??= (view.aiHead.offsetHeight || 44);
                const userTopHidden = view.userText.scrollHeight + uHead <= feedHeight;
                const assistantTopHidden = view.results.scrollHeight + aHead <= feedHeight;
                if (view.userTop.hidden !== userTopHidden || view.assistantTop.hidden !== assistantTopHidden) {
                    updates.push({ view, id, userTopHidden, assistantTopHidden });
                }
            }
            for (const { view, id, userTopHidden, assistantTopHidden } of updates) {
                if (view.userTop.hidden !== userTopHidden) view.userTop.hidden = userTopHidden;
                if (view.assistantTop.hidden !== assistantTopHidden) view.assistantTop.hidden = assistantTopHidden;
                syncMessageActions(id, view);
            }
            if (!feedHeight || displayedCharacter !== characterKey(selected)) return;
            const activeJob = playground.getState();
            if (activePhases.has(activeJob.phase)) {
                if (feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 24) feed.scrollTop = feed.scrollHeight;
                updateJump();
                return;
            }
            restorePosition(positions.get(characterKey(selected)));
            restoringPosition = false;
            rememberPosition(true, false);
        });
    }
    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(page); resizeObserver.observe(content); resizeObserver.observe(people);
    feed.addEventListener('scroll', () => {
        if (!visible) return;
        // A scroll event queued before opening the menu may arrive afterwards.
        // Only dismiss it if the content has moved since the menu was positioned.
        if (resultMenu && feed.scrollTop !== resultMenu.scrollTop) closeResults(false);
        updateJump(); rememberPosition(true, false);
        if (!restoringPosition && feed.scrollTop < 120 && feed.scrollHeight > feed.clientHeight) void loadEarlierHistory();
    }, { passive: true });
    input.addEventListener('input', () => {
        draftFor().text = input.value;
        keepReading(() => { resizeInput(true); updateControls(); }); scheduleSave();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
            event.preventDefault(); event.stopPropagation(); if (playground.availability().available) void sendDraft();
        }
    });

    function updateComposer() {
        const draft = draftFor();
        inputRow.hidden = !canWrite(); compose.classList.toggle('is-readonly', inputRow.hidden);
        if (input.value !== draft.text) {
            input.value = draft.text;
            // Textareas normalize CRLF. Keep the draft equal to what will be
            // sent so accepting it can restore/clear the draft and its origin.
            draft.text = input.value;
        }
        contextLine.replaceChildren();
        if (storageFailed) contextLine.append(element('span', '草稿和阅读位置暂未保存', 'play-storage-notice'));
        contextLine.hidden = !contextLine.childElementCount;
        compose.hidden = inputRow.hidden && contextLine.hidden;
        updateControls();
    }
    function updateControls() {
        const job = playground.getState(), active = activePhases.has(job.phase), available = playground.availability();
        const belongsHere = job.characterId ? job.characterId === selected?.id : pendingSend?.key === characterKey(selected);
        const stopping = active && belongsHere;
        const icon = stopping ? 'stop' : 'send';
        if (send.dataset.icon !== icon) { send.replaceChildren(glyph(icon)); send.dataset.icon = icon; }
        send.title = stopping ? '停止生成' : !available.available ? available.message : '发送小剧场';
        send.setAttribute('aria-label', stopping ? '停止生成' : '发送小剧场');
        send.disabled = !canWrite() || (!stopping && (!input.value.trim() || !available.available));
        for (const [id, view] of views) {
            const round = records.get(id)?.round, own = canWrite() && round?.characterId === selected?.id;
            const retry = round && pendingSaveFor(selectedResult(round), job);
            view.edit.hidden = !canEditPrompt(round) || isEditing(id);
            view.edit.disabled = view.editReply.disabled = !!view.removing || !!view.favoriting;
            view.removePrompt.hidden = view.removeReply.hidden = isEditing(id);
            view.removePrompt.disabled = view.removeReply.disabled = !canRemoveMessage(round);
            view.generate.hidden = !own || !round?.prompt || !!round.results.length;
            view.generate.disabled = !canGenerate(round);
            view.again.hidden = !(own && round.prompt !== null) && !retry;
            view.again.disabled = retry ? job.phase === 'saving' : !canGenerate(round);
            view.again.title = retry ? '重试保存' : '重新生成';
            view.again.setAttribute('aria-label', view.again.title);
            view.again.setAttribute('aria-busy', String(!!retry && job.phase === 'saving'));
            if (round) { updateResultNavigation(round, view); updateFavoriteStar(round, view); updatePromptFavoriteStar(round, view); }
            syncMessageActions(id, view);
        }
    }
    function canGenerate(round) {
        return !!round && round.prompt !== null && canWrite() && round.characterId === selected?.id
            && playground.availability().available && !isEditing(round.id) && !views.get(round.id)?.removing;
    }
    function updateResultNavigation(round, view) {
        const index = round.results.indexOf(selectedResult(round)), atEnd = index === round.results.length - 1;
        view.prev.disabled = isEditing(round.id) || !!view.removing || index <= 0;
        view.next.disabled = isEditing(round.id) || !!view.removing || (atEnd && !canGenerate(round));
        view.next.title = atEnd && canWrite() && round.prompt !== null ? '生成新剧场' : '下一个结果';
        view.next.setAttribute('aria-label', view.next.title);
    }
    function syncMessageActions(id, view) {
        view.userActions.hidden = !!view.userEditor || (view.userTop.hidden && view.generate.hidden);
        view.actions.hidden = isEditing(id) || [view.swipes, view.again, view.assistantTop].every(node => node.hidden);
    }
    function replaceDraft(next) {
        const key = characterKey(selected), previous = draftFor();
        // Keep one suspended draft when filling an entry without growing a stack.
        drafts.set(key, { ...next, previous: previous.mode ? previous.previous : previous });
        keepReading(updateComposer); scheduleSave();
    }
    function canEditPrompt(round) {
        return !!round && round.prompt !== null && settings.enabled !== false;
    }
    function canRemoveMessage(round) {
        if (!round || settings.enabled === false || isEditing(round.id)) return false;
        const view = views.get(round.id), job = playground.getState();
        return !view?.removing && !view?.favoriting && job.roundId !== round.id;
    }
    async function removeMessage(id, role) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!view || !canRemoveMessage(round)) return;
        const prompt = round.prompt, results = structuredClone(round.results);
        const question = role === 'user'
            ? '删除这条用户消息？AI 回复和已有收藏会保留；删除后无法再使用这条提示词生成。'
            : `删除这条 AI 消息及其全部 ${results.length} 个生成版本？用户消息和已有收藏会保留。`;
        closeResults(false); view.removing = true; updateControls();
        try {
            const confirmed = await ctx().callGenericPopup(element('div', question, 'tea-confirm'), ctx().POPUP_TYPE.CONFIRM, '',
                { okButton: '删除消息', cancelButton: '取消' });
            if (confirmed !== ctx().POPUP_RESULT.AFFIRMATIVE) return;
            const updated = role === 'user' ? await playground.removePrompt(id, prompt) : await playground.removeReply(id, results);
            keepReading(() => {
                if (role === 'assistant') selections.delete(id);
                if (updated) { records.set(id, { round: updated }); renderRecord(updated, view); }
                else {
                    records.delete(id); views.delete(id); selections.delete(id); view.item.remove();
                    const rows = rowsByCharacter.get(round.characterId);
                    if (rows) rowsByCharacter.set(round.characterId, rows.filter(row => row.id !== id));
                }
                updateControls();
            });
            scheduleSave(); await refresh(); notify(role === 'user' ? '已删除用户消息' : '已删除 AI 消息及全部生成版本');
        } catch (error) { notify(error.message); }
        finally { view.removing = false; updateControls(); }
    }
    function editPrompt(id) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!canEditPrompt(round) || !view || view.removing || view.favoriting || isEditing(id)) return;
        const original = round.prompt;
        function finish() {
            view.userEditor?.dispose();
            view.userEditor = null; view.promptText = null;
            keepReading(() => { renderRecord(records.get(id).round, view); updateControls(); }, false);
            if (visible && !view.item.hidden) view.edit.focus({ preventScroll: true });
        }
        const editing = createPlayEditor({ text: original, label: '提示词原文', onCancel: finish,
            async onSave({ text }) {
                const updated = await playground.editPrompt(id, text, original);
                records.set(id, { round: updated });
                finish();
                await refresh();
            },
        });
        keepReading(() => {
            view.userEditor = editing; view.userText.replaceChildren(editing.body);
            renderRecord(round, view); updateControls();
        }, false);
        editing.input.focus({ preventScroll: true });
    }
    function hasPendingSave(job) {
        return job.phase === 'save-failed' || (job.unsaved && job.phase === 'saving');
    }
    function pendingSaveFor(result, job = playground.getState()) {
        return !!result && job.resultId === result.id && hasPendingSave(job);
    }
    function notifyRequestError(error) {
        // Failed saves show their explanation and retry control in the reply.
        if (error.code !== 'history_save_failed' || !hasPendingSave(playground.getState())) notify(error.message);
    }
    async function sendDraft() {
        if (!canWrite() || !playground.availability().available || !input.value.trim()) return;
        const draft = draftFor(), key = characterKey(selected);
        pendingSend = { key, draft, prompt: input.value, accepted: false };
        try { await playground.send({ characterId: selected.id, prompt: input.value, origin: draft.origin }); }
        catch (error) { notifyRequestError(error); }
        finally { pendingSend = null; await refresh(); }
    }
    async function regenerate(round) {
        if (!canGenerate(round)) return;
        pendingReveal = { roundId: round.id, role: 'assistant' };
        try { await playground.regenerate(round.id, selectedResult(round).id); }
        catch (error) { notifyRequestError(error); }
        finally { await refresh(); }
    }
    async function advanceResult(id) {
        const round = records.get(id)?.round;
        if (!round || isEditing(id) || views.get(id)?.removing) return;
        if (selectedResult(round) !== round.results.at(-1)) { changeResult(id, 1); return; }
        if (!canGenerate(round)) return;
        pendingReveal = { roundId: id, role: 'assistant' };
        try { await playground.generateAnother(id); }
        catch (error) { notifyRequestError(error); }
        finally { await refresh(); }
    }
    function canEditResult(result) {
        return result && settings.enabled !== false && !['preparing', 'generating', 'saving', 'unfinished'].includes(result.status);
    }
    function isEditing(id) {
        const view = views.get(id);
        return !!view?.userEditor || [...(view?.outputs.values() ?? [])].some(output => output.editor);
    }
    function editResult(id) {
        const round = records.get(id)?.round, result = round && selectedResult(round);
        const view = views.get(id), output = view?.outputs.get(result?.id);
        if (!canEditResult(result) || !output || view.removing || view.favoriting || isEditing(id)) return;
        const original = result.text;
        function finish() {
            output.editor?.dispose();
            output.editor = null; output.signature = null;
            keepReading(() => { renderRecord(records.get(id).round, view); updateControls(); }, false);
            if (visible && !view.item.hidden) view.editReply.focus({ preventScroll: true });
        }
        const editing = createPlayEditor({ text: original, onCancel: finish,
            async onSave({ text }) {
                const updated = await playground.editResult(id, result.id, text, original);
                records.set(id, { round: updated });
                finish();
                await refresh();
            },
        });
        keepReading(() => {
            // A new result from another window must not replace the editor.
            selections.set(id, result.id);
            output.editor = editing; output.box.replaceChildren(editing.body);
            renderRecord(round, view); updateControls();
        }, false);
        editing.input.focus({ preventScroll: true });
    }
    function header(character, time, anchor, role = 'assistant') {
        const head = element('header', undefined, `play-message-meta play-${role}-meta`);
        head.dataset.readAnchor = anchor;
        const identity = element('span', undefined, 'play-message-identity'), speaker = element('strong', character.name, 'play-speaker'); speaker.title = character.name;
        const date = element('time', messageTime(time), 'play-message-time'); date.dateTime = time;
        const portrait = avatar(character, 'play-message-avatar', role === 'user' ? 'persona' : 'avatar');
        identity.append(speaker, date);
        head.append(portrait, identity);
        return { head, date, speaker };
    }
    function roundCharacter(round) {
        return characters.find(character => character.id === round.characterId) ?? { name: round.results[0]?.context.characterName || '角色', avatar: null };
    }
    function createRecord(round) {
        const owner = roundCharacter(round);
        const item = element('article', undefined, 'play-record'); item.dataset.record = round.id;
        item.setAttribute('aria-label', `${messageTime(round.createdAt)} 的小剧场`);
        const userMessage = element('section', undefined, 'play-message play-user-message'); userMessage.setAttribute('aria-label', `${user.name} 发送的小剧场提示词`);
        const userHead = header(user, round.createdAt, `${round.id}/user/head`, 'user'), userText = element('div', undefined, 'play-user-text');
        const userActions = element('footer', undefined, 'play-message-actions');
        const userFavorite = iconButton('star', '收藏用户消息', () => void togglePromptFavorite(round.id)); userFavorite.classList.add('tea-star');
        const edit = iconButton('edit', '修改提示词', () => editPrompt(round.id)); edit.classList.add('play-edit-prompt');
        const removePrompt = iconButton('trash', '删除用户消息', () => void removeMessage(round.id, 'user')); removePrompt.classList.add('play-delete');
        const userTools = element('div', undefined, 'play-header-actions'); userTools.append(userFavorite, edit, removePrompt); userHead.head.append(userTools);
        const userTop = iconButton('top', '回到这条消息开头', () => jumpToMessage(round.id, 'user')); userTop.hidden = true;
        const generate = iconButton('refresh', '生成回复', () => void advanceResult(round.id)); generate.classList.add('play-generate'); generate.hidden = true;
        userActions.append(generate, userTop); userActions.hidden = true;
        userMessage.append(userHead.head, userText, userActions);
        const assistant = element('section', undefined, 'play-message play-assistant-message'); assistant.setAttribute('aria-label', `${owner.name} 的回复`);
        const aiHead = header(owner, round.results.at(-1)?.startedAt ?? round.createdAt, `${round.id}/assistant/head`);
        const editReply = iconButton('edit', '编辑回复原文', () => editResult(round.id));
        const favorite = iconButton('star', '收藏演出记录', () => void toggleFavorite(round.id)); favorite.classList.add('tea-star');
        const removeReply = iconButton('trash', '删除 AI 消息', () => void removeMessage(round.id, 'assistant')); removeReply.classList.add('play-delete');
        const replyTools = element('div', undefined, 'play-header-actions'); replyTools.append(favorite, editReply, removeReply); aiHead.head.append(replyTools);
        const results = element('div', undefined, 'play-results'), actions = element('footer', undefined, 'play-message-actions');
        const error = element('p', undefined, 'play-result-error'); error.hidden = true;
        const swipes = element('div', undefined, 'play-swipes'); swipes.setAttribute('role', 'group'); swipes.setAttribute('aria-label', '切换这条回复的生成结果');
        const prev = iconButton('left', '上一个结果', () => changeResult(round.id, -1));
        const next = iconButton('right', '下一个结果', () => void advanceResult(round.id));
        const count = textButton('', () => showResults(round.id)); count.className = 'play-count'; swipes.append(prev, count, next);
        count.setAttribute('aria-haspopup', 'listbox'); count.setAttribute('aria-expanded', 'false');
        const again = iconButton('refresh', '重新生成', () => {
            const currentRound = records.get(round.id).round;
            if (pendingSaveFor(selectedResult(currentRound))) void playground.retrySave().catch(notifyRequestError);
            else void regenerate(currentRound);
        }); again.classList.add('play-again');
        const assistantTop = iconButton('top', '回到这条消息开头', () => jumpToMessage(round.id, 'assistant')); assistantTop.hidden = true;
        actions.append(again, swipes, assistantTop);
        assistant.append(aiHead.head, results, actions); item.append(userMessage, assistant);
        return { item, user: userMessage, assistant, userText, userHead: userHead.head, userHeader: userHead, userSignature: JSON.stringify(user), aiHead: aiHead.head, userActions, actions, userTop, assistantTop,
            userTools, replyTools, userFavorite, favorite, removePrompt, removeReply, generate, time: aiHead.date, speaker: aiHead.speaker, results, error, edit, editReply, again, swipes, prev, count, next, outputs: new Map() };
    }
    function selectedResult(round) { return round.results.find(result => result.id === selections.get(round.id)) ?? round.results.at(-1); }
    function createOutput(round, result) {
        // SillyTavern Popup reserves data-result for numeric dialog buttons.
        const box = element('div', undefined, 'play-result'); box.dataset.playResult = result.id;
        let touch = null;
        box.addEventListener('pointerdown', event => {
            if (event.pointerType === 'touch' && !event.target.closest('pre,button,a,input,textarea,iframe,.tea-table-scroll')) touch = { x: event.clientX, y: event.clientY };
        });
        box.addEventListener('pointercancel', () => { touch = null; });
        box.addEventListener('pointerup', event => {
            if (!touch) return;
            const dx = event.clientX - touch.x, dy = event.clientY - touch.y; touch = null;
            if (Math.abs(dx) > 70 && Math.abs(dy) < 35 && !getSelection()?.toString()) changeResult(round.id, dx < 0 ? 1 : -1);
        });
        return { box, signature: null };
    }
    function renderRecord(round, view) {
        updateUserMessage(round, view);
        const ids = new Set(round.results.map(result => result.id));
        // Keep an open draft even if another window replaced its source result.
        // Cancelling then renders the new result; saving reports the missing source.
        if ([...view.outputs].some(([id, output]) => output.editor && !ids.has(id))) return;
        for (const [id, output] of view.outputs) {
            if (!ids.has(id)) { output.box.remove(); view.outputs.delete(id); }
        }
        const result = selectedResult(round), index = round.results.indexOf(result);
        view.assistant.hidden = !result;
        if (!result) return;
        view.time.textContent = messageTime(result.startedAt); view.time.dateTime = result.startedAt;
        const name = roundCharacter(round).name;
        if (name) { view.speaker.textContent = name; view.speaker.title = name; }
        if (!view.outputs.has(result.id)) {
            const output = createOutput(round, result); view.outputs.set(result.id, output); view.results.append(output.box);
        }
        for (const [id, output] of view.outputs) output.box.hidden = id !== result.id;
        const output = view.outputs.get(result.id), renderHtml = ['saving', 'complete', 'stopped', 'failed', 'save-failed'].includes(result.status);
        view.editReply.hidden = !canEditResult(result) || isEditing(round.id);
        updateFavoriteStar(round, view);
        const tools = output.editor ? [output.editor.actions] : [view.favorite, view.editReply, view.removeReply];
        if (view.replyTools.firstChild !== tools[0]) view.replyTools.replaceChildren(...tools);
        const job = playground.getState(), pendingSave = pendingSaveFor(result, job);
        const retryingSave = pendingSave && job.phase === 'saving';
        const errorMessage = retryingSave ? '正在保存…' : pendingSave ? result.error?.message || '回复尚未保存，请重试。'
            : ['failed', 'save-failed'].includes(result.status) ? result.error?.message || '' : '';
        const sourceSignature = JSON.stringify([result.text, playground.display?.revision ?? 0]);
        if (output.sourceSignature !== sourceSignature) {
            output.displayText = playground.display?.process(result.text) ?? result.text;
            output.sourceSignature = sourceSignature;
        }
        const signature = result.text ? `${renderHtml}:${output.displayText}` : `${result.status}:${!!errorMessage}`;
        if (!output.editor && output.signature !== signature) {
            if (result.text) {
                if (output.displayText.trim()) renderPlayText(output.box, output.displayText, `${round.id}/assistant/${result.id}`, renderHtml);
                else output.box.replaceChildren(element('p', '内容已隐藏', 'play-result-empty'));
            } else if (errorMessage) output.box.replaceChildren();
            else {
                const waiting = activePhases.has(result.status);
                const message = waiting ? statusText[result.status] : result.status === 'failed' ? '这次没有收到回复。'
                    : result.status === 'stopped' ? '这次生成已停止。' : result.status === 'unfinished' ? '这次生成未完成，没有已保存的正文。' : statusText[result.status] || '';
                const text = element('p', message, waiting ? 'play-waiting' : 'play-result-empty');
                text.setAttribute('role', 'status');
                text.dataset.readAnchor = `${round.id}/assistant/${result.id}/0`; output.box.replaceChildren(text);
            }
            output.signature = signature;
        }
        output.box.dataset.status = result.status;
        view.swipes.hidden = false;
        updateResultNavigation(round, view);
        view.count.disabled = isEditing(round.id) || !!view.removing;
        const countLabel = `第 ${index + 1} / ${round.results.length} 个结果，选择历史结果`;
        if (view.count.getAttribute('aria-label') !== countLabel) {
            view.count.replaceChildren(element('span', String(index + 1)), element('small', `/ ${round.results.length}`), glyph('down'));
            view.count.setAttribute('aria-label', countLabel); view.count.title = '选择历史结果';
        }
        view.error.textContent = errorMessage;
        view.error.hidden = !errorMessage || !!output.editor;
        view.error.setAttribute('role', retryingSave ? 'status' : 'alert');
        view.error.classList.toggle('is-saving', retryingSave);
        view.error.dataset.readAnchor = `${round.id}/assistant/${result.id}/error`;
        output.box.append(view.error);
        syncMessageActions(round.id, view);
    }
    function updateEarlierBar() {
        if (!selected) { earlierBar.hidden = true; return; }
        const ready = rowsByCharacter.has(selected?.id);
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        const count = visibleCounts.get(characterKey(selected)) ?? historyPageSize;
        const remaining = Math.max(0, rows.length - count);
        const visibleRows = rows.slice(Math.max(0, rows.length - count));
        const initialLoading = !loaded || (selected && !ready) || visibleRows.some(row => !records.has(row.id));
        earlierBar.hidden = remaining <= 0 || initialLoading;
        if (!earlierBar.hidden) {
            earlierBar.textContent = loadingEarlier ? '正在加载更早记录…' : `加载更早记录（剩余 ${remaining} 条）`;
            earlierBar.disabled = loadingEarlier;
        }
    }
    async function loadEarlierHistory() {
        if (!visible || loadingEarlier || !selected || restoringPosition) return;
        const key = characterKey(selected);
        const ready = rowsByCharacter.has(selected?.id);
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        if (!rows.length) return;
        const currentCount = visibleCounts.get(key) ?? historyPageSize;
        if (currentCount >= rows.length) return;
        const currentVisible = rows.slice(Math.max(0, rows.length - currentCount));
        if (!loaded || !ready || currentVisible.some(row => !records.has(row.id))) return;
        loadingEarlier = true;
        updateEarlierBar();
        const nextCount = Math.min(rows.length, currentCount + historyPageSize);
        visibleCounts.set(key, nextCount);
        const startIndex = Math.max(0, rows.length - nextCount);
        const endIndex = rows.length - currentCount;
        const batch = rows.slice(startIndex, endIndex);
        const pending = batch.filter(row => {
            const cached = records.get(row.id);
            return cached?.revision !== row.revision || cached?.error;
        });
        try {
            await Promise.all(pending.map(async row => {
                try {
                    const round = await playground.getRound(row.id);
                    records.set(row.id, { round, revision: row.revision });
                } catch {
                    const cached = records.get(row.id);
                    if (cached?.round) cached.error = true; else records.set(row.id, { error: true });
                }
            }));
        } finally {
            loadingEarlier = false;
        }
        if (!visible || characterKey(selected) !== key) return;
        const oldScrollHeight = feed.scrollHeight;
        const oldScrollTop = feed.scrollTop;
        keepReading(renderHistory, false);
        if (feed.scrollHeight > oldScrollHeight && feed.scrollTop === oldScrollTop) {
            feed.scrollTop = oldScrollTop + (feed.scrollHeight - oldScrollHeight);
        }
        layout();
        updateJump();
    }
    function renderHistory() {
        if (!visible) return;
        const ready = rowsByCharacter.has(selected?.id);
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        const key = characterKey(selected);
        const count = visibleCounts.get(key) ?? historyPageSize;
        const startIndex = Math.max(0, rows.length - count);
        const visibleRows = rows.slice(startIndex);
        const visibleIds = new Set(visibleRows.map(row => row.id));
        for (const [id, view] of views) view.item.hidden = !visibleIds.has(id);
        let shown = 0, next = null;
        for (const row of [...visibleRows].reverse()) {
            const cached = records.get(row.id); if (!cached?.round) continue;
            let view = views.get(row.id);
            if (!view) {
                view = createRecord(cached.round); views.set(row.id, view);
                content.insertBefore(view.item, next);
            }
            next = view.item;
            view.item.hidden = false; renderRecord(cached.round, view); shown++;
        }
        content.prepend(earlierBar);
        updateEarlierBar();
        const failed = visibleRows.filter(row => records.get(row.id)?.error);
        empty.hidden = shown > 0 || (rows.length > 0 && failed.length === visibleRows.length);
        const loading = !loaded || (selected && !ready) || visibleRows.some(row => !records.has(row.id));
        empty.dataset.state = loading ? 'loading' : 'empty'; emptyArt.hidden = loading;
        emptyTitle.textContent = loading ? '正在读取演出记录…' : !selected ? '选择一个角色，查看演出记录。' : '没有演出记录';
        if (failed.length) showReadError(`${failed.length} 条演出记录暂时无法读取。`);
        const anchorId = positions.get(key)?.anchor?.split('/')[0];
        const awaitingAnchor = anchorId && visibleIds.has(anchorId) && !records.has(anchorId);
        displayedCharacter = ready && !awaitingAnchor && (shown || !rows.length) ? key : '';
        updateControls();
    }
    function changeResult(id, direction, resultId) {
        const round = records.get(id)?.round; if (!round || isEditing(id) || views.get(id)?.removing) return;
        const index = round.results.indexOf(selectedResult(round));
        const result = resultId ? round.results.find(item => item.id === resultId) : round.results[index + direction];
        if (!result) return;
        closeResults(); selections.set(id, result.id); renderRecord(round, views.get(id)); updateControls();
        jumpToMessage(id, 'assistant'); scheduleSave();
    }
    function showResults(id) {
        const round = records.get(id)?.round; if (!round || isEditing(id) || views.get(id)?.removing) return;
        if (resultMenu?.roundId === id) { closeResults(); return; }
        closeResults(false);
        const opener = views.get(id).count, menu = element('div', undefined, 'play-result-menu');
        menu.id = 'play-result-menu'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', '生成结果');
        round.results.forEach((result, index) => {
            const option = textButton('', () => changeResult(id, 0, result.id)); option.className = 'play-result-option';
            const selected = selectedResult(round).id === result.id;
            option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(selected)); option.tabIndex = selected ? 0 : -1;
            const copy = element('span', undefined, 'play-result-option-copy');
            const preview = playground.display?.process(result.text) ?? result.text;
            copy.append(element('span', playTextPreview(preview) || statusText[result.status] || '内容已隐藏', 'play-result-opening'),
                element('time', messageTime(result.startedAt), 'play-result-time'));
            const check = glyph('check'); check.classList.add('play-result-check');
            option.append(element('span', pad(index + 1), 'play-result-number'), copy, check); menu.append(option);
        });
        const dismiss = event => { if (!menu.contains(event.target) && !opener.contains(event.target)) closeResults(false); };
        const resize = () => closeResults(false);
        resultMenu = { menu, opener, roundId: id, dismiss, resize, scrollTop: feed.scrollTop };
        root.append(menu); root.addEventListener('pointerdown', dismiss); window.addEventListener('resize', resize);
        opener.setAttribute('aria-controls', menu.id); opener.setAttribute('aria-expanded', 'true');
        // Phones align both menu edges with the reply, rather than shifting a
        // desktop-width popup from the page number until it fits the screen.
        const bounds = root.getBoundingClientRect(), area = readingArea.getBoundingClientRect(), anchor = opener.getBoundingClientRect();
        const inset = 12, gap = 8, alignment = mobile.matches ? views.get(id).results.getBoundingClientRect() : anchor;
        if (mobile.matches) menu.style.width = `${Math.min(alignment.width, bounds.width - inset * 2)}px`;
        const above = Math.max(0, anchor.top - area.top - gap - inset), below = Math.max(0, area.bottom - anchor.bottom - gap - inset);
        const upwards = below < Math.min(menu.scrollHeight, 340) && above > below;
        const room = Math.min(340, upwards ? above : below), rowHeight = menu.firstElementChild.getBoundingClientRect().height;
        const style = getComputedStyle(menu), paddingTop = parseFloat(style.paddingTop), paddingBottom = parseFloat(style.paddingBottom);
        // Start with complete rows, including equal padding at both ends.
        const rows = Math.max(1, Math.floor((room - paddingTop - paddingBottom) / rowHeight));
        menu.style.maxHeight = `${Math.min(room, rows * rowHeight + paddingTop + paddingBottom)}px`;
        menu.style.left = `${Math.max(inset, Math.min(alignment.left - bounds.left, bounds.width - menu.offsetWidth - inset))}px`;
        menu.style.top = `${upwards ? anchor.top - bounds.top - gap - menu.offsetHeight : anchor.bottom - bounds.top + gap}px`;
        const options = [...menu.children], chosen = menu.querySelector('[aria-selected=true]');
        const focusOption = option => {
            for (const node of options) node.tabIndex = node === option ? 0 : -1;
            option.focus({ preventScroll: true });
            if (option.offsetTop - paddingTop < menu.scrollTop) menu.scrollTop = option.offsetTop - paddingTop;
            else if (option.offsetTop + option.offsetHeight + paddingBottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight + paddingBottom - menu.clientHeight;
        };
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeResults(); }
            else if (event.key === 'Tab') closeResults();
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const index = options.indexOf(document.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
                focusOption(options[Math.max(0, Math.min(options.length - 1, next))]);
            }
        });
        focusOption(chosen);
    }
    function closeResults(restore = true) {
        if (!resultMenu) return;
        const { menu, opener, dismiss, resize } = resultMenu; resultMenu = null;
        menu.remove(); root.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', resize);
        opener.setAttribute('aria-expanded', 'false'); opener.removeAttribute('aria-controls');
        if (restore && opener.isConnected) opener.focus({ preventScroll: true });
    }
    function showReadError(message) {
        readError.replaceChildren(element('span', message), textButton('重新读取', () => void refresh())); readError.hidden = false;
    }
    async function chooseCharacter(character) {
        if (characterKey(selected) === characterKey(character)) { if (mobile.matches) setBrowsing(false); return; }
        closeResults(false); rememberPosition(); selected = character;
        if (mobile.matches) setBrowsing(false);
        renderPeople(); renderHistory(); updateComposer(); restorePosition(positions.get(characterKey(selected)));
        await refresh();
    }
    async function chooseCurrent() {
        syncCurrent(); if (!current) { notify(currentError); return; }
        search.value = ''; characterQuery = ''; characterPage = 0; mobileLimit = characterBatchSize;
        await refresh(true);
    }
    async function refresh(preferCurrent = false) {
        const id = ++refreshId;
        syncCurrent();
        try {
            const savedCharacters = await playground.listCharacters(); if (id !== refreshId) return;
            const previous = selected, previousKey = characterKey(previous);
            // SillyTavern already holds the character catalog. Merge its light
            // identity fields with history metadata, without reading every role's records.
            const available = new Map((ctx().characters ?? []).filter(item => item?.avatar && item.name)
                .map(item => [item.avatar, { avatar: item.avatar, name: item.name }]));
            characters = savedCharacters.map(item => ({ ...item, name: available.get(item.avatar)?.name ?? item.name }));
            const savedAvatars = new Set(savedCharacters.map(item => item.avatar));
            for (const character of available.values()) if (!savedAvatars.has(character.avatar)) characters.push(character);
            const currentRow = current && (characters.find(item => item.avatar === current.avatar) ?? { ...current, lastPlayedAt: null });
            if (currentRow) characters = [currentRow, ...characters.filter(item => item !== currentRow)];
            selected = preferCurrent || !selected ? currentRow ?? (mobile.matches ? null : characters[0]) ?? null
                : characters.find(item => item.id && item.id === previous.id) ?? characters.find(item => item.avatar && item.avatar === previous.avatar) ?? currentRow ?? characters[0] ?? null;
            if (!selected) browsing = true;
            const key = characterKey(selected);
            if (previous && !previous.id && selected?.id && previous.avatar === selected.avatar) {
                for (const map of [positions, drafts]) if (map.has(previousKey)) { map.set(key, map.get(previousKey)); map.delete(previousKey); }
                if (pendingSend?.key === previousKey) pendingSend.key = key;
            }
            if (visible) { renderPeople(); updateBrowser(); updateComposer(); }
            const characterId = selected?.id;
            const rows = characterId ? await playground.listRounds(characterId) : []; if (id !== refreshId) return;
            rowsByCharacter.set(characterId, rows);
            loaded = true;
            function showBatch() {
                readError.hidden = true; applyJob(playground.getState());
                if (visible) {
                    const position = positions.get(key);
                    renderHistory(); updateComposer(); restorePosition(position);
                    if (pendingReveal && views.get(pendingReveal.roundId)?.item.getClientRects().length) {
                        if (pendingReveal.role === 'latest') jumpToLatest(); else jumpToMessage(pendingReveal.roundId, pendingReveal.role);
                        pendingReveal = null;
                    }
                    rememberPosition(); layout();
                }
            }
            const targetId = pendingReveal?.roundId ?? positions.get(key)?.anchor?.split('/')[0];
            const targetIndex = rows.findIndex(row => row.id === targetId);
            const needed = targetIndex >= 0 ? rows.length - targetIndex : historyPageSize;
            const initialCount = Math.min(rows.length, Math.max(visibleCounts.get(key) ?? historyPageSize, needed, historyPageSize));
            visibleCounts.set(key, initialCount);

            const visibleRows = rows.slice(Math.max(0, rows.length - initialCount));
            const job = playground.getState();
            const pending = visibleRows.filter(row => {
                const cached = records.get(row.id);
                return cached?.revision !== row.revision || cached?.error || row.id === job.roundId;
            });
            showBatch();
            if (pending.length) {
                await Promise.all(pending.map(async row => {
                    const cached = records.get(row.id);
                    try {
                        const round = await playground.getRound(row.id);
                        if (id === refreshId) records.set(row.id, { round, revision: row.revision });
                    } catch {
                        if (id !== refreshId) return;
                        if (cached?.round) cached.error = true; else records.set(row.id, { error: true });
                    }
                }));
                if (id !== refreshId) return;
                showBatch();
            }
        } catch (error) {
            if (id !== refreshId) return;
            loaded = true; showReadError(error.message || '演出记录暂时无法读取。');
            if (visible) { renderPeople(); renderHistory(); updateComposer(); }
        }
    }
    function applyJob(job) {
        const round = records.get(job.roundId)?.round;
        const result = round?.results.find(item => item.id === job.resultId);
        if (result && job.phase !== 'idle') { result.text = job.text; result.status = job.phase; result.error = job.error ?? undefined; }
    }
    function renderStreamingJob(job) {
        streamFrame = 0;
        if (!visible) return;
        applyJob(job);
        const record = records.get(job.roundId)?.round, view = views.get(job.roundId);
        if (record && view && !view.item.hidden) {
            renderRecord(record, view);
            view.assistantTop.hidden = view.results.scrollHeight + view.aiHead.offsetHeight <= feed.clientHeight;
            syncMessageActions(job.roundId, view);
        }
        updateComposer();
        const atBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 24;
        if (atBottom) {
            feed.scrollTop = feed.scrollHeight;
            positions.set(characterKey(selected), { bottom: true });
        }
        updateJump();
    }
    playground.subscribe(job => {
        const previous = lastJob; lastJob = job;
        if (pendingSend && job.roundId && !pendingSend.accepted) {
            pendingSend.accepted = true;
            const draft = drafts.get(pendingSend.key);
            if (draft === pendingSend.draft && draft.text === pendingSend.prompt) drafts.set(pendingSend.key, draft.previous ?? { text: '', origin: null });
            pendingReveal = { roundId: job.roundId, role: 'latest' }; scheduleSave();
        }
        if (job.roundId && job.resultId !== previous.resultId) selections.set(job.roundId, job.resultId);
        if (job.roundId && !records.get(job.roundId)?.round?.results.some(result => result.id === job.resultId)) selections.set(job.roundId, job.resultId);
        if (job.phase === 'generating' && visible) {
            applyJob(job);
            if (!streamFrame) streamFrame = requestAnimationFrame(() => renderStreamingJob(lastJob));
        } else {
            if (streamFrame) { cancelAnimationFrame(streamFrame); streamFrame = 0; }
            if (visible) keepReading(() => {
                applyJob(job);
                const record = records.get(job.roundId)?.round, view = views.get(job.roundId);
                if (record && view && !view.item.hidden) renderRecord(record, view);
                updateComposer();
            });
            else applyJob(job);
        }
        if (job.roundId !== previous.roundId || job.phase === 'idle' || job.phase === 'save-failed') void refresh();
    });
    const events = ctx().eventTypes ?? {};
    if (events.CHAT_CHANGED) ctx().eventSource.on(events.CHAT_CHANGED, () => {
        const wasCurrent = !selected || selected.avatar === current?.avatar;
        if (visible) rememberPosition();
        void refresh(wasCurrent);
        if (visible) void refreshUser();
    });
    if (events.PERSONA_CHANGED) ctx().eventSource.on(events.PERSONA_CHANGED, () => { if (visible) void refreshUser(); });
    window.addEventListener('pagehide', () => { rememberPosition(true, true); saveViewState(); });
    window.addEventListener('focus', () => {
        if (visible) { rememberPosition(); void refresh(); void refreshUser(); void refreshFavorites(); }
    });

    return {
        browser, chooseButton, page,
        activate(container) {
            // Reattaching the panel can reset scrollTop before its first layout.
            // Keep the saved position authoritative until that layout restores it.
            root = container; visible = true; restoringPosition = true;
            syncCurrent(); browsing ??= !current; updateBrowser(); void refreshUser(); void refreshFavorites();
            if (playground.display) void playground.display.refresh().finally(() => {
                if (visible) keepReading(renderHistory);
            }).catch(() => notify('酒馆正则读取失败，请在设置中刷新正则列表后重试。'));
            // Loading native generation helpers does not block history reads.
            // The send button is enabled once their snapshot readers are ready.
            if (playground.initialize) void playground.initialize().then(() => {
                if (visible) updateControls();
            }).catch(() => notify('生成接口载入失败，请关闭后再打开剧场演出重试。'));
            resizeObserver.observe(page); resizeObserver.observe(content); resizeObserver.observe(people);
            renderPeople(); renderHistory(); updateComposer(); layout(); void refresh();
        },
        deactivate() {
            clearTimeout(positionTimer);
            const key = characterKey(selected);
            if (visible && (!cachedPosition || cachedPosition.key !== key || Math.abs((cachedPosition.scrollTop ?? -999) - feed.scrollTop) >= 2)) {
                commitPosition(capturePosition(true));
            }
            visible = false; refreshId++; closeResults(false); pageJump.node.open = false; scheduleSave(); cancelAnimationFrame(layoutFrame); cancelAnimationFrame(streamFrame); streamFrame = 0; resizeObserver.disconnect();
        },
        refresh, layout,
        prepareLayout() { if (visible) { closeResults(false); rememberPosition(true, false); } },
        focusInput() { if (visible && canWrite()) input.focus({ preventScroll: true }); },
        canLeave: () => ![...views.values()].some(view => view.removing || view.userEditor?.saving || [...view.outputs.values()].some(output => output.editor?.saving)),
        async fillFromEntry(entry) {
            await chooseCurrent(); if (!current || !selected || !canWrite()) return false;
            browsing = false;
            replaceDraft({ text: entry.body, origin: { id: entry.id, title: entry.title }, mode: 'original' });
            return true;
        },
    };
}
