import { element, textButton, glyph, iconButton } from './ui.js';
import { readPlayTarget } from './play-runtime.js';
import { renderPlayText, playTextPreview } from './play-render.js';
import { createPlayEditor } from './play-editor.js';
import { favoriteFirstLine, favoriteSourceKey } from './play-favorites-view.js';
import { createPlayCharacterPicker } from './play-character-picker.js';
import { setupPlayReplyHeaderActions, createPlayReplyActions, renderPlayReply, showPlayReplyStop, syncPlayReplyFooter, updatePlayReplyCount, createPlayInputSizer, playResultStatusText } from './play-message-ui.js';

const pad = value => String(value).padStart(2, '0');
const characterKey = character => character?.id ?? (character?.avatar ? `avatar:${character.avatar}` : '');
const activePhases = new Set(['preparing', 'generating', 'retry-wait']);
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
export function createPlayView(ctx, settings, playground, notify, diagnostics, promptFavorites,
    { getReadingInset = () => 0, onProgrammaticScroll = () => {}, onBranch, onInspectPrompt } = {}) {
    const mobile = matchMedia('(max-width: 760px)');
    const characterPicker = createPlayCharacterPicker(ctx, {
        getCharacters: () => characters, getSelected: () => selected, onSelect: character => void chooseCharacter(character),
        onBack: () => setBrowsing(false), backLabel: '返回演出记录', isVisible: () => !mobile.matches || !!browsing,
        emptyText: () => loaded ? '酒馆里还没有角色' : '正在读取角色…',
        renderMeta(character) {
            const time = element('time', undefined, 'play-person-time');
            if (character.lastPlayedAt) {
                const recent = recentTime(character.lastPlayedAt); time.dateTime = character.lastPlayedAt;
                time.append(element('span', recent.day, 'play-person-date'), element('small', recent.time, 'play-person-clock'));
            }
            return time;
        },
        signatureExtra: character => [character.lastPlayedAt, character.lastPlayedAt ? recentTime(character.lastPlayedAt) : null],
    });
    const { node: browser, people, back: browserBack } = characterPicker; browser.id = 'play-character-browser';
    people.setAttribute('aria-label', '按角色查看演出记录');
    const chooseButton = iconButton('people', '选择角色', () => setBrowsing(true));
    chooseButton.setAttribute('aria-controls', browser.id);
    const page = element('div', undefined, 'play-page');
    const readingArea = element('div', undefined, 'play-reading-area');
    const feed = element('div', undefined, 'tea-scroll play-feed'); feed.setAttribute('aria-label', '小剧场对话历史');
    const content = element('div', undefined, 'play-feed-content');
    const earlierBar = textButton('', () => void loadEarlierHistory()); earlierBar.className = 'play-earlier-bar'; earlierBar.hidden = true;
    const laterBar = textButton('', () => void loadHistory('later')); laterBar.className = 'play-later-bar'; laterBar.hidden = true;
    content.append(earlierBar, laterBar);
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
    const inputSizer = createPlayInputSizer({ input, compose, page, isVisible: () => visible && !inputRow.hidden,
        isComposing: () => inputComposing, getContextHeight: () => contextLine.offsetHeight });
    const nativeInputSizing = inputSizer.nativeSizing;
    input.setAttribute('aria-label', '小剧场提示词'); input.placeholder = '写下小剧场提示词…';
    const send = iconButton('send', '发送小剧场', () => {
        if (composerStopsGeneration()) playground.stopAll();
        else void sendDraft();
    }); send.classList.add('play-send');
    inputRow.append(input, send); inner.append(contextLine, inputRow); compose.append(inner); page.append(readingArea, compose);

    const records = new Map(), views = new Map(), rowsByCharacter = new Map(), historyWindows = new Map();
    const positions = new Map(), selections = new Map(), drafts = new Map();
    let characters = [], selected = null, current = null, currentError = '', root, visible = false, loaded = false, historyLoad = null;
    let refreshId = 0, saveTimer, layoutFrame, streamFrame = 0, activationFrame, activationTimer, resultMenu, startingRequest, latestRequest, pendingReveal, storageFailed = false;
    let browsing = null, lastMobile = mobile.matches;
    let inputSizingFrame, inputComposing = false;
    let user = { name: ctx().name1 || 'User', avatar: null }, userRefreshId = 0;
    let favoriteRows = new Map(), favoritesReady = false, favoritesRefreshId = 0;
    const requests = new Map(), changedJobs = new Map(), previousJobs = new Map();
    let displayedCharacter = '', restoringPosition = false, cachedPosition = null;
    const storageKey = 'teahouse-play-view-v1';

    try {
        const saved = JSON.parse(ctx().accountStorage?.getItem(storageKey) ?? 'null');
        if (saved?.format === 1) {
            for (const [key, value] of saved.selections ?? []) if (typeof key === 'string' && typeof value === 'string') selections.set(key, value);
            for (const [key, value] of saved.drafts ?? []) {
                if (typeof key !== 'string' || !value || typeof value.text !== 'string') continue;
                drafts.set(key, value);
            }
        }
    } catch (error) { diagnostics?.error('读取剧场草稿和阅读位置', error); storageFailed = true; }

    const sharedViewState = () => JSON.stringify({ format: 1, selections: [...selections],
        drafts: [...drafts].filter(([, draft]) => draft.text || draft.origin || draft.previous || draft.mode) });
    let savedSharedState = sharedViewState();

    function saveViewState() {
        clearTimeout(saveTimer);
        try {
            const text = sharedViewState();
            if (text === savedSharedState) return;
            const saved = JSON.parse(text);
            ctx().accountStorage?.setItem(storageKey, JSON.stringify(saved));
            savedSharedState = text;
        } catch (error) {
            diagnostics?.error('保存剧场草稿和生成版本选择', error);
            storageFailed = true;
        }
    }
    function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveViewState, 300); }
    function draftFor(key = characterKey(selected)) {
        if (!drafts.has(key)) drafts.set(key, { text: '', origin: null });
        return drafts.get(key);
    }
    function canWrite() { return !!selected?.avatar && settings.enabled !== false; }
    function composerStopsGeneration() {
        return !input.value.trim() && playground.getStates().some(job => activePhases.has(job.phase));
    }
    function readTarget() {
        return { characterId: selected?.id, character: { avatar: selected?.avatar, name: selected?.name } };
    }
    function jobsHere() {
        return playground.getStates().filter(job => job.characterAvatar === selected?.avatar || (job.characterId && job.characterId === selected?.id));
    }
    function roundBusy(roundId) {
        return playground.getStates().some(job => (job.roundId ?? job.requestedRoundId) === roundId);
    }
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
        const context = selectedResult(round)?.context;
        const identity = context?.userName ? { name: context.userName, avatar: context.userAvatar || null } : user;
        const signature = JSON.stringify(identity);
        if (view.userSignature !== signature) {
            view.userSignature = signature;
            view.userHeader.speaker.textContent = identity.name; view.userHeader.speaker.title = identity.name;
            view.userHead.querySelector('.play-message-avatar').replaceWith(avatar(identity, 'play-message-avatar', 'persona'));
            view.user.setAttribute('aria-label', `${identity.name} 发送的小剧场提示词`);
        }
        const tools = view.userEditor ? [view.userEditor.actions] : [view.userFavorite, view.edit, view.removePrompt];
        if (view.userTools.firstChild !== tools[0]) view.userTools.replaceChildren(...tools);
        if (round.prompt === null) {
            if (!view.userEditor) { view.userText.replaceChildren(); view.promptText = null; }
            return;
        }
        // Expand only display names; keep the saved prompt and other macros untouched.
        const names = { user: identity.name, char: roundCharacter(round).name };
        const text = round.prompt.replace(/\{\{(user|char)\}\}|<(user|char)>/gi, (_, macro, tag) => names[(macro ?? tag).toLowerCase()]);
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
            favoriteRows = new Map(rows.filter(row => row.source.type !== 'manual').map(row => [favoriteSourceKey(row.source), row])); favoritesReady = true;
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
                const cleanedText = playground.display?.process(result.text, roundCharacter(round), result.context) ?? result.text;
                if (!cleanedText.trim()) throw new Error('演出内容清洗后为空，无法收藏');
                const favorite = await playground.addFavorite({ ...source, expectedText: result.text,
                    text: cleanedText,
                    firstLine: favoriteFirstLine(cleanedText) });
                favoriteRows.set(key, favorite);
            }
            // A read started before this completed write must not put the
            // previous star state back, even if that read returns later.
            favoritesRefreshId++;
            notify(existing ? '已取消收藏' : '已收藏演出记录');
        } catch (error) { notify(error.message); }
        finally { view.favoriting = false; if (records.get(id)?.round) updateFavoriteStar(records.get(id).round, view); updateControls(); }
    }
    const renderPeople = resetScroll => characterPicker.render(resetScroll);
    function updateBrowser() {
        if (!root) return;
        root.classList.toggle('play-choosing-character', !!browsing);
        chooseButton.setAttribute('aria-expanded', String(!!browsing));
        browserBack.hidden = !selected;
    }
    function setBrowsing(value) {
        if (!value && !selected) return;
        closeResults(false); rememberPosition();
        browsing = value; updateBrowser();
        if (browsing) { renderPeople(); characterPicker.focus(); }
        else { chooseButton.focus({ preventScroll: true }); restorePosition(positions.get(characterKey(selected))); }
        layout();
    }
    function capturePosition(followBottom = true) {
        if (!visible || restoringPosition || !feed.clientHeight || !selected || displayedCharacter !== characterKey(selected)) return null;
        const key = characterKey(selected), saved = positions.get(key);
        const distanceToBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
        let res = null;
        const rows = rowsByCharacter.get(selected.id) ?? [];
        if (followBottom && historyRange(rows).end === rows.length && (distanceToBottom <= 24 || (saved?.bottom && distanceToBottom <= 32))) res = { bottom: true };
        else {
            const top = feed.getBoundingClientRect().top + readingInset();
            const items = [...content.querySelectorAll(':scope > .play-record:not([hidden])')];
            let low = 0, high = items.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (items[middle].getBoundingClientRect().bottom > top + 1) high = middle;
                else low = middle + 1;
            }
            for (const item of items.slice(low, low + 2)) {
                const anchors = [...item.querySelectorAll('[data-read-anchor]')].filter(node => !node.closest('[hidden]'));
                let start = 0, end = anchors.length;
                while (start < end) {
                    const middle = (start + end) >>> 1;
                    if (anchors[middle].getBoundingClientRect().bottom > top + 1) end = middle;
                    else start = middle + 1;
                }
                for (const anchor of anchors.slice(start)) {
                    const box = anchor.getBoundingClientRect();
                    if (box.height && box.bottom > top + 1) {
                        res = { bottom: false, anchor: anchor.dataset.readAnchor, offset: top - box.top, scrollTop: feed.scrollTop };
                        break;
                    }
                }
                if (res) break;
            }
            if (!res) res = { bottom: false, scrollTop: feed.scrollTop };
        }
        return res;
    }
    function commitPosition(position) {
        if (!position) return;
        const key = characterKey(selected), previous = positions.get(key);
        // scrollTop can round to whole pixels. Keep the intended offset so
        // rounding after every inserted batch does not accumulate as drift.
        if (position.anchor && position.anchor === previous?.anchor && Math.abs(position.offset - previous.offset) < 1) {
            position.offset = previous.offset;
        }
        cachedPosition = { scrollTop: feed.scrollTop, feedHeight: feed.clientHeight, inset: readingInset(), key };
        positions.set(key, position);
    }
    function rememberPosition(followBottom = true, forceSync = false) {
        if (hasActiveEditor()) followBottom = false;
        if (!visible || restoringPosition || !feed.clientHeight || !selected || displayedCharacter !== characterKey(selected)) return;
        const key = characterKey(selected), saved = positions.get(key);
        const distanceToBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
        const rows = rowsByCharacter.get(selected.id) ?? [];
        if (followBottom && historyRange(rows).end === rows.length && (distanceToBottom <= 24 || (saved?.bottom && distanceToBottom <= 32))) {
            commitPosition({ bottom: true });
            return;
        }
        if (!forceSync && cachedPosition && cachedPosition.key === key && cachedPosition.inset === readingInset()
            && Math.abs((cachedPosition.scrollTop ?? -999) - feed.scrollTop) < 2) {
            return;
        }
        commitPosition(capturePosition(followBottom));
    }
    function updateJump() {
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        const hasLater = historyRange(rows).end < rows.length;
        jump.hidden = !visible || feed.clientHeight <= 0 || (!hasLater && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= feed.clientHeight);
        jump.disabled = jump.hidden;
    }
    function setFeedScroll(value) {
        const previous = feed.scrollTop;
        feed.scrollTop = value;
        if (feed.scrollTop !== previous) onProgrammaticScroll(feed);
    }
    function restorePosition(position) {
        if (!visible || !feed.clientHeight) return;
        if (!position || position.bottom) {
            const target = feed.scrollHeight;
            if (Math.abs(feed.scrollTop - target) > 2) setFeedScroll(target);
        } else {
            const item = views.get(position.anchor?.split('/')[0])?.item;
            const anchor = item && !item.hidden && [...item.querySelectorAll('[data-read-anchor]')].find(node => node.dataset.readAnchor === position.anchor && !node.closest('[hidden]'));
            if (anchor) {
                const target = feed.scrollTop + (anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top - readingInset()) + (Number(position.offset) || 0);
                if (Math.abs(feed.scrollTop - target) > 0.5) setFeedScroll(target);
            } else {
                const target = Number(position.scrollTop) || 0;
                if (Math.abs(feed.scrollTop - target) > 2) setFeedScroll(target);
            }
        }
        cachedPosition = position ? { scrollTop: feed.scrollTop, feedHeight: feed.clientHeight, inset: readingInset(), key: characterKey(selected) } : null;
        updateJump();
    }
    function keepReading(change, followBottom = true) {
        // Editing keeps a visible anchor even when the feed was at the bottom.
        const position = capturePosition(followBottom) ?? positions.get(characterKey(selected));
        change(); restorePosition(position); rememberPosition(followBottom, true);
    }
    function jumpToLatest() {
        if (!visible) return;
        positions.set(characterKey(selected), { bottom: true });
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        if (historyRange(rows).end < rows.length) {
            resetHistoryWindow(rows);
            renderHistory(); void refresh();
        }
        restorePosition({ bottom: true }); rememberPosition(); updateJump();
    }
    function jumpToMessage(id, role) {
        const view = views.get(id), message = view?.[role];
        if (!visible || !message?.getClientRects().length) return;
        setFeedScroll(feed.scrollTop + message.getBoundingClientRect().top - feed.getBoundingClientRect().top - readingInset() - 10);
        rememberPosition(true, true); updateJump();
    }
    function resizeInput(force = false) {
        inputSizer.resize(force);
    }
    function scheduleInputSizing() {
        if (nativeInputSizing || inputComposing || inputSizingFrame) return;
        inputSizingFrame = requestAnimationFrame(() => {
            inputSizingFrame = 0;
            if (visible && !inputComposing) keepReading(() => resizeInput(true));
        });
    }
    function layout() {
        cancelAnimationFrame(layoutFrame);
        if (!visible) return;
        if (lastMobile !== mobile.matches) { lastMobile = mobile.matches; renderPeople(); updateBrowser(); updateControls(); }
        // ResizeObserver runs before paint; do not defer catalog pagination by a frame.
        characterPicker.layout();
        layoutFrame = requestAnimationFrame(() => {
            if (!visible) return;
            // A user scroll can arrive before its scroll event. Never restore
            // an older anchor over a new position from the browser compositor.
            if (!restoringPosition && cachedPosition?.key === characterKey(selected)
                && (cachedPosition.inset !== readingInset() || Math.abs(cachedPosition.scrollTop - feed.scrollTop) >= 2)) {
                rememberPosition(true, true);
            }
            resizeInput();
            const feedHeight = feed.clientHeight - readingInset();
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
            // Finish restoring a reopened panel during generation too, so later
            // user scrolls can replace the saved position before completion.
            if (jobsHere().some(job => activePhases.has(job.phase)) && !restoringPosition) {
                if (feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 24) setFeedScroll(feed.scrollHeight);
                updateJump();
                return;
            }
            restorePosition(positions.get(characterKey(selected)));
            restoringPosition = false;
            rememberPosition(true, false);
        });
    }
    const resizeObserver = new ResizeObserver(entries => {
        // Preserve the saved paragraph/bottom before painting a native composer
        // height change. Typing within a line or at the cap does not run this.
        if (visible && nativeInputSizing && entries.some(entry => entry.target === compose)) {
            restorePosition(positions.get(characterKey(selected))); rememberPosition(true, false);
        }
        layout();
    });
    resizeObserver.observe(page); resizeObserver.observe(content); resizeObserver.observe(people); resizeObserver.observe(compose);
    feed.addEventListener('scroll', () => {
        if (!visible) return;
        // Native resizing can clamp/focus-scroll the feed before ResizeObserver
        // runs. Do not overwrite the saved paragraph/bottom with that movement.
        if (nativeInputSizing && cachedPosition?.key === characterKey(selected) && cachedPosition.feedHeight !== feed.clientHeight) return;
        const moved = cachedPosition?.key === characterKey(selected) && Math.abs(cachedPosition.scrollTop - feed.scrollTop) >= 2;
        if (moved && !restoringPosition) { pendingReveal = null; latestRequest = null; }
        // A scroll event queued before opening the menu may arrive afterwards.
        // Only dismiss it if the content has moved since the menu was positioned.
        if (resultMenu && feed.scrollTop !== resultMenu.scrollTop) closeResults(false);
        rememberPosition(true, false); updateJump();
        if (moved && !restoringPosition && feed.scrollHeight > feed.clientHeight) {
            if (feed.scrollTop < 120) void loadEarlierHistory();
            else if (feed.scrollHeight - feed.clientHeight - feed.scrollTop < 120) void loadHistory('later');
        }
    }, { passive: true });
    input.addEventListener('input', event => {
        draftFor().text = input.value;
        updateSendControl();
        if (!event.isComposing) scheduleInputSizing();
        scheduleSave();
    });
    input.addEventListener('compositionstart', () => {
        inputComposing = true; cancelAnimationFrame(inputSizingFrame); inputSizingFrame = 0;
    });
    input.addEventListener('compositionend', () => { inputComposing = false; scheduleInputSizing(); });
    input.addEventListener('keydown', event => {
        const shortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
        const plainEnter = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
            && ctx().shouldSendOnEnter?.();
        if (event.key === 'Enter' && !event.isComposing && (shortcut || plainEnter)) {
            event.preventDefault(); event.stopPropagation(); if (playground.availability().available) void sendDraft();
        }
    });

    function updateComposer() {
        const draft = draftFor();
        if (input.value !== draft.text) {
            input.value = draft.text;
            // Textareas normalize CRLF. Keep the draft equal to what will be
            // sent so accepting it can restore/clear the draft and its origin.
            draft.text = input.value;
        }
        contextLine.replaceChildren();
        if (storageFailed) contextLine.append(element('span', '草稿和阅读位置暂未保存', 'play-storage-notice'));
        contextLine.hidden = !contextLine.childElementCount;
        updateControls();
    }
    function updateSendControl() {
        const available = playground.availability(), stopping = composerStopsGeneration();
        const icon = stopping ? 'stop' : 'send', label = stopping ? '停止所有生成' : '发送小剧场';
        if (send.dataset.icon !== icon) { send.replaceChildren(glyph(icon)); send.dataset.icon = icon; }
        const title = !stopping && !available.available ? available.message : label;
        const disabled = !canWrite() || (!stopping && (!input.value.trim() || !available.available));
        if (send.title !== title) send.title = title;
        if (send.getAttribute('aria-label') !== label) send.setAttribute('aria-label', label);
        if (send.disabled !== disabled) send.disabled = disabled;
    }
    function updateControls() {
        const editing = mobile.matches && hasActiveEditor();
        inputRow.hidden = editing || !canWrite(); compose.classList.toggle('is-readonly', inputRow.hidden);
        page.classList.toggle('is-message-editing', editing);
        compose.hidden = editing || (inputRow.hidden && contextLine.hidden);
        updateSendControl();
        const multipleActive = playground.getStates().filter(job => activePhases.has(job.phase)).length > 1;
        for (const [id, view] of views) {
            const round = records.get(id)?.round, own = canWrite() && round?.characterId === selected?.id;
            const result = round && selectedResult(round), job = playground.getState(result?.id);
            const retry = round && pendingSaveFor(result, job);
            view.stop.hidden = !result || !showPlayReplyStop(job, multipleActive);
            view.stop.dataset.resultId = job.resultId ?? '';
            view.edit.hidden = !canEditPrompt(round) || isEditing(id);
            view.edit.disabled = view.editReply.disabled = !!view.removing || !!view.favoriting;
            view.removePrompt.hidden = view.removeReply.hidden = isEditing(id);
            view.removePrompt.disabled = view.removeReply.disabled = !canRemoveMessage(round);
            view.generate.hidden = !own || !round?.prompt || !!round.results.length;
            view.generate.disabled = !canGenerate(round);
            view.again.hidden = !(own && round.prompt !== null) && !retry;
            if (round?.initialIsLast === false && !retry) view.again.hidden = true;
            view.again.disabled = retry ? job.phase === 'saving' : !canRewrite(round, result);
            view.again.title = retry ? '重试保存' : '重新生成';
            view.again.setAttribute('aria-label', view.again.title);
            view.again.setAttribute('aria-busy', String(!!retry && job.phase === 'saving'));
            const currentSelected = round && selectedResult(round);
            const canCont = canContinue(round, currentSelected);
            view.continueBtn.hidden = !(own && round?.prompt !== null && currentSelected?.text?.trim());
            if (round?.initialIsLast === false) view.continueBtn.hidden = true;
            view.branch.hidden = !onBranch;
            view.branch.disabled = !result || !canEditResult(result) || isEditing(id) || settings.enabled === false;
            view.continueBtn.disabled = !canCont;
            if (round) { updateResultNavigation(round, view); updateFavoriteStar(round, view); updatePromptFavoriteStar(round, view); }
            syncMessageActions(id, view);
        }
    }
    function canGenerate(round) {
        return !!round && round.initialIsLast !== false && round.prompt !== null && canWrite() && round.characterId === selected?.id
            && playground.availability().available && !isEditing(round.id) && !views.get(round.id)?.removing;
    }
    function canRewrite(round, result) {
        return canGenerate(round) && !!result && playground.availability({ resultId: result.id }).available;
    }
    function canContinue(round, result) {
        return canRewrite(round, result) && !!result?.text?.trim() && !pendingSaveFor(result);
    }
    function updateResultNavigation(round, view) {
        view.swipes.hidden = round.initialIsLast === false;
        const index = round.results.indexOf(selectedResult(round)), atEnd = index === round.results.length - 1;
        view.prev.disabled = isEditing(round.id) || !!view.removing || index <= 0;
        view.next.disabled = isEditing(round.id) || !!view.removing || (atEnd && !canGenerate(round));
        view.next.title = atEnd && canWrite() && round.prompt !== null ? '生成新剧场' : '下一个结果';
        view.next.setAttribute('aria-label', view.next.title);
    }
    function syncMessageActions(id, view) {
        view.userActions.hidden = !!view.userEditor || (view.userTop.hidden && view.generate.hidden);
        syncPlayReplyFooter(view, isEditing(id));
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
        const view = views.get(round.id);
        return !view?.removing && !view?.favoriting && !roundBusy(round.id);
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
        const original = round.prompt, position = mobile.matches ? capturePosition(false) : null;
        function finish() {
            view.userEditor?.dispose();
            view.userEditor = null; view.promptText = null;
            keepReading(() => { renderRecord(records.get(id).round, view); updateControls(); }, false);
            if (mobile.matches && position) { restorePosition(position); rememberPosition(false, true); }
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
        if (mobile.matches) jumpToMessage(id, 'user');
    }
    function hasPendingSave(job) {
        return job.phase === 'save-failed' || (job.unsaved && job.phase === 'saving');
    }
    function pendingSaveFor(result, job = playground.getState(result?.id)) {
        return !!result && job.resultId === result.id && hasPendingSave(job);
    }
    function notifyRequestError(error, resultId) {
        // Failed saves show their explanation and retry control in the reply.
        if (error.code !== 'history_save_failed' || !hasPendingSave(playground.getState(resultId))) notify(error.message);
    }
    async function runGeneration(run, { draft, prompt, role = 'assistant' } = {}) {
        const request = { key: characterKey(selected), draft, prompt, role, accepted: false, resultId: null };
        latestRequest = request; startingRequest = request;
        let task;
        try { task = run(); }
        finally { startingRequest = null; }
        try { await task; }
        catch (error) { notifyRequestError(error, request.resultId); }
        finally { if (request.resultId) requests.delete(request.resultId); await refresh(); }
    }
    async function sendDraft() {
        if (!canWrite() || !playground.availability().available || !input.value.trim()) return;
        const draft = draftFor(), prompt = input.value, target = readTarget();
        await runGeneration(() => playground.send({ ...target, prompt, origin: draft.origin }), { draft, prompt, role: 'latest' });
    }
    async function regenerate(round) {
        const result = selectedResult(round);
        if (!canRewrite(round, result)) return;
        const target = readTarget();
        await runGeneration(() => playground.regenerate(round.id, result.id, target));
    }
    async function continueReply(round) {
        const result = selectedResult(round);
        if (!canContinue(round, result)) return;
        pendingReveal = null;
        if (feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 32) {
            positions.set(characterKey(selected), { bottom: true });
        }
        const target = readTarget();
        await runGeneration(() => playground.continueResult(round.id, result.id, target), { role: null });
    }
    async function advanceResult(id) {
        const round = records.get(id)?.round;
        if (!round || isEditing(id) || views.get(id)?.removing) return;
        if (selectedResult(round) !== round.results.at(-1)) { changeResult(id, 1); return; }
        if (!canGenerate(round)) return;
        const target = readTarget();
        await runGeneration(() => playground.generateAnother(id, target));
    }
    function canEditResult(result) {
        return result && settings.enabled !== false && !['preparing', 'generating', 'retry-wait', 'saving', 'unfinished'].includes(result.status);
    }
    function isEditing(id) {
        const view = views.get(id);
        return !!view?.userEditor || [...(view?.outputs.values() ?? [])].some(output => output.editor);
    }
    function hasActiveEditor() {
        return [...views].some(([id, view]) => !view.item.hidden && isEditing(id));
    }
    const readingInset = () => page.classList.contains('is-message-editing') ? 0 : getReadingInset();
    function editResult(id) {
        const round = records.get(id)?.round, result = round && selectedResult(round);
        const view = views.get(id), output = view?.outputs.get(result?.id);
        if (!canEditResult(result) || !output || view.removing || view.favoriting || isEditing(id)) return;
        const original = result.text, position = mobile.matches ? capturePosition(false) : null;
        function finish() {
            output.editor?.dispose();
            output.editor = null; output.signature = null;
            keepReading(() => { renderRecord(records.get(id).round, view); updateControls(); }, false);
            if (mobile.matches && position) { restorePosition(position); rememberPosition(false, true); }
            if (visible && !view.item.hidden) view.editReply.focus({ preventScroll: true });
        }
        const editing = createPlayEditor({ text: original, onCancel: finish,
            async onSave({ text }) {
                const updated = await playground.editResult(id, result.id, text, original);
                if (updated.initialIsLast && updated.initialAssistantId && updated.selectedResultId !== result.id) {
                    await playground.setMessageVersion(id, updated.initialAssistantId, result.id, updated.selectedResultId);
                    updated.selectedResultId = result.id;
                }
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
        if (mobile.matches) jumpToMessage(id, 'assistant');
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
        const branch = iconButton('branch', '创建分支', () => void branchFromRound(round.id));
        const prompt = iconButton('prompt', '查看实际提示词', () => {
            const currentRound = records.get(round.id)?.round;
            const result = currentRound && selectedResult(currentRound);
            if (result) onInspectPrompt?.(result.id);
        });
        prompt.classList.add('play-sent-prompt-action'); prompt.hidden = !onInspectPrompt;
        const replyTools = element('div', undefined, 'play-header-actions');
        const replyMore = setupPlayReplyHeaderActions(replyTools, { branch, prompt, remove: removeReply, favorite, edit: editReply });
        aiHead.head.append(replyTools);
        const results = element('div', undefined, 'play-results');
        const error = element('p', undefined, 'play-result-error'); error.hidden = true;
        const { actions, again, continueBtn, assistantTop, stop, swipes, prev, count, next } = createPlayReplyActions({
            onPrevious: () => changeResult(round.id, -1), onNext: () => void advanceResult(round.id), onChoose: () => showResults(round.id),
            onAgain: () => {
                const currentRound = records.get(round.id).round, result = selectedResult(currentRound);
                if (pendingSaveFor(result)) void playground.retrySave(result.id).catch(error => notifyRequestError(error, result.id));
                else void regenerate(currentRound);
            },
            onContinue: () => void continueReply(records.get(round.id).round),
            onStop: () => playground.stop(stop.dataset.resultId), onTop: () => jumpToMessage(round.id, 'assistant'),
        });
        assistant.append(aiHead.head, results, actions); item.append(userMessage, assistant);
        return { item, user: userMessage, assistant, userText, userHead: userHead.head, userHeader: userHead, userSignature: JSON.stringify(user), aiHead: aiHead.head, userActions, actions, userTop, assistantTop,
            userTools, replyTools, replyMore, prompt, userFavorite, favorite, branch, removePrompt, removeReply, generate, time: aiHead.date, speaker: aiHead.speaker, results, error, edit, editReply, again, continueBtn, stop, swipes, prev, count, next, outputs: new Map() };
    }
    function selectedResult(round) {
        const editingId = [...(views.get(round.id)?.outputs ?? [])].find(([, output]) => output.editor)?.[0];
        return round.results.find(result => result.id === (editingId ?? round.selectedResultId ?? selections.get(round.id))) ?? round.results.at(-1);
    }
    async function branchFromRound(id) {
        const round = records.get(id)?.round;
        if (!round || !onBranch || isEditing(id) || !canEditResult(selectedResult(round))) return;
        try {
            rememberPosition();
            const chat = await playground.getChat(id, { selectedResultId: selectedResult(round)?.id });
            const ai = chat.messages.find(message => chat.startMessageIds.includes(message.id) && message.role === 'assistant');
            const branch = await playground.createBranch(id, ai.id, chat.revision);
            onBranch(branch); await refresh();
        } catch (error) { notify(error.message); }
    }
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
        const output = view.outputs.get(result.id);
        view.editReply.hidden = !canEditResult(result) || isEditing(round.id);
        updateFavoriteStar(round, view);
        const tools = output.editor ? [output.editor.actions] : [view.replyMore, view.branch, view.prompt, view.removeReply, view.favorite, view.editReply];
        if (view.replyTools.firstChild !== tools[0]) view.replyTools.replaceChildren(...tools);
        const job = playground.getState(result.id);
        const sourceSignature = JSON.stringify([result.text, result.context?.userName, playground.display?.revision ?? 0]);
        if (output.sourceSignature !== sourceSignature) {
            output.displayText = playground.display?.process(result.text, roundCharacter(round), result.context) ?? result.text;
            output.sourceSignature = sourceSignature;
        }
        renderPlayReply(output, result, { displayText: output.displayText, job, error: view.error,
            anchor: `${round.id}/assistant/${result.id}`, editing: !!output.editor });
        view.swipes.hidden = false;
        updateResultNavigation(round, view);
        view.count.disabled = isEditing(round.id) || !!view.removing;
        updatePlayReplyCount(view.count, index, round.results.length);
        syncMessageActions(round.id, view);
    }
    function historyRange(rows, key = characterKey(selected)) {
        const saved = historyWindows.get(key);
        const first = saved ? rows.findIndex(row => row.id === saved.first) : -1;
        const last = saved ? rows.findIndex(row => row.id === saved.last) : -1;
        return first >= 0 && last >= first ? { start: first, end: last + 1 }
            : { start: Math.max(0, rows.length - historyPageSize), end: rows.length };
    }
    function setHistoryRange(rows, start, end, key = characterKey(selected)) {
        historyWindows.set(key, { first: rows[start]?.id, last: rows[end - 1]?.id });
    }
    function resetHistoryWindow(rows, targetId, key = characterKey(selected)) {
        const target = targetId ?? (positions.get(key)?.bottom ? null : positions.get(key)?.anchor?.split('/')[0]);
        const index = rows.findIndex(row => row.id === target);
        const start = index < 0 ? Math.max(0, rows.length - historyPageSize)
            : Math.max(0, Math.min(index - Math.floor(historyPageSize / 2), rows.length - historyPageSize));
        setHistoryRange(rows, start, Math.min(rows.length, start + historyPageSize), key);
    }
    function updateEarlierBar() {
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        const { start, end } = historyRange(rows);
        for (const [bar, direction, remaining, label] of [
            [earlierBar, 'earlier', start, '更早'], [laterBar, 'later', rows.length - end, '后续'],
        ]) {
            bar.hidden = !selected || remaining <= 0;
            if (bar.hidden) continue;
            bar.textContent = historyLoad?.direction === direction ? '正在加载记录…' : `加载${label}记录（剩余 ${remaining} 条）`;
            bar.disabled = !!historyLoad;
        }
    }
    async function readHistoryRows(rows, isCurrent, show) {
        let next = 0, frame = 0;
        const schedule = () => {
            if (!frame && visible) frame = requestAnimationFrame(() => { frame = 0; if (isCurrent()) show(); });
        };
        try {
            await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
                while (next < rows.length && isCurrent()) {
                    const row = rows[next++], cached = records.get(row.id);
                    try {
                        const round = await playground.getRound(row.id);
                        if (isCurrent()) records.set(row.id, { round, revision: row.revision });
                    } catch {
                        if (!isCurrent()) return;
                        if (cached?.round) cached.error = true; else records.set(row.id, { error: true });
                    }
                    schedule();
                }
            }));
        } finally {
            cancelAnimationFrame(frame);
            if (isCurrent()) show();
        }
    }
    function loadEarlierHistory() { return loadHistory('earlier'); }
    async function loadHistory(direction) {
        if (!visible || historyLoad || !selected || restoringPosition) return;
        const key = characterKey(selected), id = refreshId;
        const rows = rowsByCharacter.get(selected.id) ?? [];
        const { start, end } = historyRange(rows, key);
        const nextStart = direction === 'earlier' ? Math.max(0, start - historyPageSize) : start;
        const nextEnd = direction === 'later' ? Math.min(rows.length, end + historyPageSize) : end;
        if (nextStart === start && nextEnd === end) return;
        const request = historyLoad = { direction };
        const isCurrent = () => visible && id === refreshId && characterKey(selected) === key && historyLoad === request;
        const batch = direction === 'earlier' ? rows.slice(nextStart, start) : rows.slice(end, nextEnd);
        const pending = batch.filter(row => records.get(row.id)?.revision !== row.revision || records.get(row.id)?.error);
        const show = () => {
            keepReading(() => { setHistoryRange(rows, nextStart, nextEnd, key); renderHistory(); }, false);
            layout(); updateJump();
        };
        updateEarlierBar();
        try { await readHistoryRows(pending, isCurrent, show); }
        finally {
            if (historyLoad === request) { historyLoad = null; if (visible) updateEarlierBar(); }
        }
    }
    function renderHistory() {
        if (!visible) return;
        const ready = rowsByCharacter.has(selected?.id);
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        const key = characterKey(selected);
        const { start, end } = historyRange(rows, key);
        const visibleRows = rows.slice(start, end);
        const visibleIds = new Set(visibleRows.map(row => row.id));
        for (const [id, view] of views) view.item.hidden = !visibleIds.has(id);
        let shown = 0, next = null;
        for (const row of [...visibleRows].reverse()) {
            const cached = records.get(row.id); if (!cached?.round) continue;
            let view = views.get(row.id);
            if (!view) {
                view = createRecord(cached.round); views.set(row.id, view);
                content.insertBefore(view.item, next ?? laterBar);
            }
            next = view.item;
            view.item.hidden = false; renderRecord(cached.round, view); shown++;
        }
        content.prepend(earlierBar); content.append(laterBar);
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
    async function changeResult(id, direction, resultId) {
        const round = records.get(id)?.round; if (!round || isEditing(id) || views.get(id)?.removing) return;
        if (round.initialIsLast === false) return;
        const index = round.results.indexOf(selectedResult(round));
        const result = resultId ? round.results.find(item => item.id === resultId) : round.results[index + direction];
        if (!result) return;
        if (round.initialAssistantId) {
            try { await playground.setMessageVersion(id, round.initialAssistantId, result.id, round.selectedResultId, { playSelection: true }); }
            catch (error) { notify(error.message); return; }
            round.selectedResultId = result.id;
        }
        latestRequest = null; pendingReveal = null;
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
            const preview = playground.display?.process(result.text, roundCharacter(round), result.context) ?? result.text;
            copy.append(element('span', playTextPreview(preview) || playResultStatusText[result.status] || '内容已隐藏', 'play-result-opening'),
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
        latestRequest = null; pendingReveal = null;
        closeResults(false); rememberPosition(); selected = character;
        if (mobile.matches) setBrowsing(false);
        renderPeople(); renderHistory(); updateComposer(); restorePosition(positions.get(characterKey(selected)));
        if (playground.display) {
            try { await playground.display.refresh(character); if (visible) keepReading(renderHistory); }
            catch { notify('酒馆正则读取失败，请在设置中刷新正则列表后重试。'); }
        }
        await refresh();
    }
    async function refresh() {
        const id = ++refreshId;
        historyLoad = null;
        syncCurrent();
        try {
            if (id !== refreshId) return;
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
            selected = !selected ? currentRow ?? (mobile.matches ? null : characters[0]) ?? null
                : characters.find(item => item.id && item.id === previous.id) ?? characters.find(item => item.avatar && item.avatar === previous.avatar) ?? currentRow ?? characters[0] ?? null;
            if (!selected) browsing = true;
            const key = characterKey(selected);
            if (previous && !previous.id && selected?.id && previous.avatar === selected.avatar) {
                for (const map of [positions, drafts, historyWindows]) if (map.has(previousKey)) { map.set(key, map.get(previousKey)); map.delete(previousKey); }
                for (const request of requests.values()) if (request.key === previousKey) request.key = key;
                if (pendingReveal?.key === previousKey) pendingReveal.key = key;
            }
            if (visible) { renderPeople(); updateBrowser(); updateComposer(); }
            const characterId = selected?.id;
            const rows = characterId ? await playground.listRounds(characterId) : []; if (id !== refreshId) return;
            const previousRows = rowsByCharacter.get(characterId) ?? [];
            const previousRange = historyRange(previousRows, key);
            rowsByCharacter.set(characterId, rows);
            loaded = true;
            const reveal = pendingReveal?.key === key ? pendingReveal : null;
            const targetId = reveal?.roundId ?? positions.get(key)?.anchor?.split('/')[0];
            const savedWindow = historyWindows.get(key);
            if (!savedWindow?.first || !rows.some(row => row.id === savedWindow.first)
                || (reveal && !rows.slice(historyRange(rows, key).start, historyRange(rows, key).end).some(row => row.id === targetId))) {
                resetHistoryWindow(rows, targetId, key);
            } else if (positions.get(key)?.bottom && previousRange.end === previousRows.length) {
                setHistoryRange(rows, Math.max(0, rows.length - Math.max(historyPageSize, previousRange.end - previousRange.start)), rows.length, key);
            }
            function showBatch() {
                readError.hidden = true;
                for (const job of playground.getStates()) applyJob(job);
                if (visible) {
                    const position = positions.get(key);
                    renderHistory(); updateComposer(); restorePosition(position);
                    if (pendingReveal?.key === key && views.get(pendingReveal.roundId)?.item.getClientRects().length) {
                        if (pendingReveal.role === 'latest') jumpToLatest(); else jumpToMessage(pendingReveal.roundId, pendingReveal.role);
                        pendingReveal = null;
                    }
                    rememberPosition(); layout();
                }
            }
            const { start, end } = historyRange(rows, key);
            const visibleRows = rows.slice(start, end);
            const liveRounds = new Set(playground.getStates().map(job => job.roundId));
            const pending = visibleRows.filter(row => {
                const cached = records.get(row.id);
                return cached?.revision !== row.revision || cached?.error || liveRounds.has(row.id);
            }).sort((a, b) => {
                if (a.id === targetId) return -1;
                if (b.id === targetId) return 1;
                return positions.get(key)?.bottom !== false ? rows.indexOf(b) - rows.indexOf(a) : rows.indexOf(a) - rows.indexOf(b);
            });
            showBatch();
            if (pending.length) await readHistoryRows(pending, () => id === refreshId, showBatch);
        } catch (error) {
            if (id !== refreshId) return;
            loaded = true; showReadError(error.message || '演出记录暂时无法读取。');
            if (visible) { renderPeople(); renderHistory(); updateComposer(); }
        } finally {
            if (id === refreshId && visible && restoringPosition) layout();
        }
    }
    function applyJob(job) {
        const round = records.get(job.roundId)?.round;
        const result = round?.results.find(item => item.id === job.resultId);
        if (result && job.phase !== 'idle') { result.text = job.text; result.status = job.phase; result.error = job.error ?? undefined; if (job.context) result.context = job.context; }
    }
    function renderChangedJobs() {
        streamFrame = 0;
        const updates = [...changedJobs.values()]; changedJobs.clear();
        const change = () => {
            const rendered = new Set();
            for (const job of updates) {
                applyJob(job);
                const record = records.get(job.roundId)?.round, view = views.get(job.roundId);
                if (visible && record && view && !view.item.hidden && selectedResult(record)?.id === job.resultId && !rendered.has(job.roundId)) {
                    rendered.add(job.roundId); renderRecord(record, view);
                    view.assistantTop.hidden = view.results.scrollHeight + view.aiHead.offsetHeight <= feed.clientHeight;
                }
            }
            if (visible) updateControls();
        };
        if (visible) keepReading(change); else change();
    }
    playground.subscribe(job => {
        const previous = previousJobs.get(job.resultId);
        if (job.phase === 'idle') previousJobs.delete(job.resultId); else previousJobs.set(job.resultId, job);
        if (startingRequest && !requests.has(job.resultId)) {
            startingRequest.resultId = job.resultId; requests.set(job.resultId, startingRequest);
            const existing = records.get(job.requestedRoundId)?.round;
            if (existing && !selections.has(existing.id)) selections.set(existing.id, selectedResult(existing)?.id);
        }
        const request = requests.get(job.resultId);
        if (request && job.roundId && !request.accepted) {
            request.accepted = true;
            const draft = drafts.get(request.key);
            if (request.draft && draft === request.draft && draft.text === request.prompt) drafts.set(request.key, draft.previous ?? { text: '', origin: null });
            if (request === latestRequest && request.key === characterKey(selected) && visible) {
                selections.set(job.roundId, job.resultId);
                if (request.role) pendingReveal = { key: request.key, roundId: job.roundId, role: request.role };
            } else if (job.replaceResultId && selections.get(job.roundId) === job.replaceResultId) {
                selections.set(job.roundId, job.resultId);
            }
            scheduleSave();
        }
        changedJobs.set(job.resultId, job);
        if (!streamFrame) streamFrame = requestAnimationFrame(renderChangedJobs);
        if (job.roundId && (!previous?.roundId || job.phase === 'idle' || job.phase === 'save-failed')) void refresh();
    });
    const events = ctx().eventTypes ?? {};
    if (events.CHAT_CHANGED) ctx().eventSource.on(events.CHAT_CHANGED, () => {
        if (visible) rememberPosition();
        void refresh();
        if (visible) void refreshUser();
    });
    if (events.PERSONA_CHANGED) ctx().eventSource.on(events.PERSONA_CHANGED, () => { if (visible) void refreshUser(); });
    window.addEventListener('pagehide', () => { rememberPosition(true, true); void saveViewState(); });
    window.addEventListener('focus', () => {
        if (visible) { rememberPosition(); void refresh(); void refreshUser(); void refreshFavorites(); }
    });

    return {
        browser, chooseButton, page,
        activate(container) {
            if (visible) { root = container; return; }
            // Reattaching the panel can reset scrollTop before its first layout.
            // Keep the saved position authoritative until that layout restores it.
            root = container; visible = true; restoringPosition = true;
            syncCurrent(); browsing ??= !current; updateBrowser();
            resetHistoryWindow(rowsByCharacter.get(selected?.id) ?? []);
            renderHistory(); updateComposer();
            resizeObserver.observe(page); resizeObserver.observe(content); resizeObserver.observe(people); resizeObserver.observe(compose);
            // Paint the panel controls before measuring history or loading the
            // native helpers. A tab click must not wait for conversation layout.
            cancelAnimationFrame(activationFrame); clearTimeout(activationTimer);
            activationFrame = requestAnimationFrame(() => {
                activationTimer = setTimeout(() => {
                    if (!visible) return;
                    renderPeople(); layout(); void refreshUser(); void refreshFavorites(); void refresh();
                    if (playground.display) void playground.display.refresh(selected).finally(() => {
                        if (visible) keepReading(renderHistory);
                    }).catch(() => notify('酒馆正则读取失败，请在设置中刷新正则列表后重试。'));
                    if (playground.initialize) void playground.initialize().then(() => {
                        if (visible) updateControls();
                    }).catch(() => notify('生成接口载入失败，请关闭后再打开剧场演出重试。'));
                }, 0);
            });
        },
        deactivate() {
            const key = characterKey(selected);
            if (visible && (!cachedPosition || cachedPosition.key !== key || cachedPosition.inset !== readingInset()
                || Math.abs((cachedPosition.scrollTop ?? -999) - feed.scrollTop) >= 2)) {
                commitPosition(capturePosition(true));
            }
            visible = false; refreshId++; historyLoad = null; restoringPosition = false; closeResults(false); characterPicker.suspend(); scheduleSave();
            cancelAnimationFrame(activationFrame); clearTimeout(activationTimer); cancelAnimationFrame(layoutFrame); cancelAnimationFrame(streamFrame); streamFrame = 0; resizeObserver.disconnect();
            cancelAnimationFrame(inputSizingFrame); inputSizingFrame = 0; inputComposing = false;
        },
        refresh, layout,
        getSelectedCharacter: () => selected,
        prepareLayout() { if (visible) { closeResults(false); rememberPosition(true, false); saveViewState(); } },
        focusInput() { if (visible && canWrite()) input.focus({ preventScroll: true }); },
        canLeave: () => ![...views.values()].some(view => view.removing || view.userEditor?.saving || [...view.outputs.values()].some(output => output.editor?.saving)),
        async fillFromEntry(entry) {
            await refresh(); if (!selected || !canWrite()) return false;
            browsing = false;
            replaceDraft({ text: entry.body, origin: { id: entry.id, title: entry.title }, mode: 'original' });
            return true;
        },
    };
}
