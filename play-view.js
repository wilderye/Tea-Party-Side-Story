import { element, textButton, glyph, iconButton } from './ui.js';
import { readPlayTarget } from './play-runtime.js';
import { renderPlayText, playTextPreview } from './play-render.js';
import { recordViewEvent } from './view-diagnostics.js';
import { playRoundDepth, playMessageIdentity } from './play-message-context.js';
import { createPlayEditor } from './play-editor.js';
import { favoriteFirstLine, favoriteSourceKey } from './play-favorites-view.js';
import { createPlayCharacterPicker, createCharacterAvatar, mergePlayCharacters } from './play-character-picker.js';
import { setupPlayReplyHeaderActions, createPlayReplyActions, renderPlayReply, showPlayReplyStop, syncPlayReplyFooter, updatePlayReplyCount, createPlayInputSizer, playResultStatusText, createPlayResultMenu, createPlayMessageTop, playMessageNeedsTop, scrollPlayMessageToTop, revealPlayEditor, placePlayEditorActions } from './play-message-ui.js';
import { readPlayElementPosition, restorePlayElementPosition } from './play-reading-position.js';
import { createPlayReadingStorage } from './play-reading-storage.js';

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
    { getReadingInset = () => 0, onProgrammaticScroll = () => {}, onBranch, onInspectPrompt, onBrowsing,
        messageEditing } = {}) {
    const mobile = matchMedia('(max-width: 760px)');
    const characterPicker = createPlayCharacterPicker(ctx, {
        getCharacters: () => characters, getSelected: () => selected, onSelect: character => void chooseCharacter(character),
        onBack: () => setBrowsing(false), backLabel: '返回演出记录',
        isVisible: () => visible && (!mobile.matches || !!browsing) || !mobile.matches && suspended && root?.dataset.active === 'true',
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
    let refreshId = 0, saveTimer, layoutFrame, streamFrame = 0, activationFrame, activationTimer, startingRequest, latestRequest, pendingReveal, storageFailed = false;
    const resultMenu = createPlayResultMenu();
    let browsing = null, lastMobile = mobile.matches;
    let inputSizingFrame, inputComposing = false;
    let favoriteRows = new Map(), favoritesReady = false, favoritesRefreshId = 0;
    const requests = new Map(), changedJobs = new Map();
    let displayedCharacter = '', restoringPosition = false, cachedPosition = null;
    let displayLoad, batchNumber = 0, lastProgrammaticScroll;
    let suspended = false, resumeNeedsRefresh = false;
    const observe = (operation, values) => recordViewEvent(root, operation, values);
    const storageKey = 'teahouse-play-view-v1';
    let legacyPositions = [], readingReady = false, readingSettled = false, readingTimer;
    const readingStorage = createPlayReadingStorage(ctx().getCurrentUserHandle
        ? { getUserHandle: () => ctx().getCurrentUserHandle() } : undefined);

    try {
        const saved = JSON.parse(ctx().accountStorage?.getItem(storageKey) ?? 'null');
        if (saved?.format === 1) {
            legacyPositions = (saved.positions ?? []).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object');
            for (const [key, value] of legacyPositions) positions.set(key, value);
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
    const readingLoaded = readingStorage.read(legacyPositions).then(saved => {
        positions.clear();
        for (const [key, value] of saved) positions.set(key, value);
        readingReady = true;
    }).catch(error => { diagnostics?.error('读取剧场草稿和阅读位置', error); })
        .finally(() => { readingSettled = true; });

    function saveReadingPosition() {
        clearTimeout(readingTimer);
        if (!readingReady) return;
        try { readingStorage.save(positions); }
        catch (error) { diagnostics?.error('保存剧场阅读位置', error); }
    }

    function saveViewState() {
        clearTimeout(saveTimer);
        try {
            const text = sharedViewState();
            if (text === savedSharedState) return;
            const saved = JSON.parse(text);
            if (!readingReady && legacyPositions.length) saved.positions = legacyPositions;
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
    function roundBusy(roundId, jobs = playground.getStates()) {
        return jobs.some(job => (job.roundId ?? job.requestedRoundId) === roundId);
    }
    function syncCurrent() {
        try { current = readPlayTarget(ctx()).character; currentError = ''; }
        catch (error) { current = null; currentError = error.message; }
    }
    function updateUserMessage(round, view) {
        const userEditor = recordEditor(view, 'user'), userHidden = round.prompt === null && !userEditor;
        if (view.user.hidden !== userHidden) view.user.hidden = userHidden;
        const identity = playMessageIdentity(round);
        const context = { userName: identity.name };
        const signature = JSON.stringify(identity);
        if (view.userSignature !== signature) {
            view.userSignature = signature;
            view.userHeader.speaker.textContent = identity.name; view.userHeader.speaker.title = identity.name;
            view.userHead.querySelector('.play-message-avatar').replaceWith(createCharacterAvatar(ctx, identity, 'play-message-avatar', 'persona'));
            view.user.setAttribute('aria-label', `${identity.name} 发送的小剧场提示词`);
        }
        if (round.prompt === null) {
            if (!userEditor) { view.userText.replaceChildren(); view.promptText = null; view.promptSourceSignature = null; }
            return;
        }
        // Expand only display names; keep the saved prompt and other macros untouched.
        const names = { user: identity.name, char: roundCharacter(round).name };
        const original = round.prompt.replace(/\{\{(user|char)\}\}|<(user|char)>/gi, (_, macro, tag) => names[(macro ?? tag).toLowerCase()]);
        const depth = playRoundDepth(round, 'user');
        const sourceSignature = JSON.stringify([original, context?.userName, playground.display?.revision ?? 0, depth]);
        if (!userEditor && view.promptSourceSignature !== sourceSignature) {
            const text = playground.display?.process(original, roundCharacter(round), context, 'user', depth) ?? original;
            if (view.promptText !== text) renderPlayText(view.userText, text, `${round.id}/user/text`, false, false, { role: 'user', name: identity.name });
            view.promptText = text;
            view.promptSourceSignature = sourceSignature;
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
        view.favorite.hidden = !canEditResult(result) || !result.text.trim();
        view.favorite.disabled = !favoritesReady || !!view.favoriting || !!view.removing || isEditing(round.id, 'assistant');
    }
    function updatePromptFavoriteStar(round, view) {
        const favorite = promptFavorites?.isFavorite(round) ?? false;
        view.userFavorite.title = favorite ? '取消收藏' : '收藏用户消息';
        view.userFavorite.setAttribute('aria-label', view.userFavorite.title);
        view.userFavorite.setAttribute('aria-pressed', String(favorite));
        view.userFavorite.hidden = !promptFavorites || !canEditPrompt(round);
        view.userFavorite.disabled = !!view.favoriting || !!view.removing || isEditing(round.id, 'user');
    }
    async function togglePromptFavorite(id) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!promptFavorites || !canEditPrompt(round) || !view || view.favoriting || view.removing || isEditing(id, 'user')) return;
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
        } catch (error) { diagnostics?.error('收藏用户消息', error); if (!playground.session.isSaveError(error)) notify(error.message); }
        finally { view.favoriting = false; updateControls(); }
    }
    async function toggleFavorite(id) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!round || !view || !favoritesReady || view.favoriting || view.removing || isEditing(id, 'assistant')) return;
        const result = selectedResult(round);
        if (!canEditResult(result) || !result.text.trim()) return;
        const source = { roundId: id, resultId: result.id, startedAt: result.startedAt }, key = favoriteSourceKey(source);
        const existing = favoriteRows.get(key);
        view.favoriting = true; updateControls();
        try {
            if (existing) { await playground.removeFavorite(existing.id); favoriteRows.delete(key); }
            else {
                const cleanedText = playground.display?.process(result.text, roundCharacter(round), result.context, 'assistant', playRoundDepth(round)) ?? result.text;
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
        } catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
        finally { view.favoriting = false; if (records.get(id)?.round) updateFavoriteStar(records.get(id).round, view); updateControls(); }
    }
    const renderPeople = resetScroll => characterPicker.render(resetScroll);
    function updateBrowser() {
        if (!root) return;
        if (root.classList.contains('play-choosing-character') !== !!browsing) root.classList.toggle('play-choosing-character', !!browsing);
        chooseButton.setAttribute('aria-expanded', String(!!browsing));
        browserBack.hidden = !selected;
        onBrowsing?.(!!browsing);
    }
    function setBrowsing(value) {
        if (!value && !selected) return;
        closeResults(false); rememberPosition();
        browsing = value; updateBrowser();
        if (browsing) { renderPeople(); characterPicker.focus(); }
        else { chooseButton.focus({ preventScroll: true }); restorePosition(positions.get(characterKey(selected))); }
        if (!browsing) { if (resumeNeedsRefresh) { resumeNeedsRefresh = false; void refresh(); } layout(); }
    }
    function capturePosition(followBottom = true) {
        if (!visible || restoringPosition || !feed.clientHeight || !selected || displayedCharacter !== characterKey(selected)) return null;
        const key = characterKey(selected), saved = positions.get(key);
        const distanceToBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
        let res = null;
        const rows = rowsByCharacter.get(selected.id) ?? [];
        if (followBottom && historyRange(rows).end === rows.length && (!rows.length || records.get(rows.at(-1).id)?.round)
            && (distanceToBottom <= 24 || (saved?.bottom && distanceToBottom <= 32))) res = { bottom: true };
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
        if (!position || !readingSettled) return;
        const key = characterKey(selected), previous = positions.get(key);
        // scrollTop can round to whole pixels. Keep the intended offset so
        // rounding after every inserted batch does not accumulate as drift.
        if (position.anchor && position.anchor === previous?.anchor && Math.abs(position.offset - previous.offset) < 1) {
            position.offset = previous.offset;
        }
        cachedPosition = { scrollTop: feed.scrollTop, feedHeight: feed.clientHeight, inset: readingInset(), key };
        positions.set(key, position);
        clearTimeout(readingTimer); readingTimer = setTimeout(saveReadingPosition, 300);
    }
    function rememberPosition(followBottom = true, forceSync = false) {
        if (hasActiveEditor()) followBottom = false;
        if (!visible || restoringPosition || !feed.clientHeight || !selected || displayedCharacter !== characterKey(selected)) return;
        const key = characterKey(selected), saved = positions.get(key);
        const distanceToBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
        const rows = rowsByCharacter.get(selected.id) ?? [];
        if (followBottom && historyRange(rows).end === rows.length && (!rows.length || records.get(rows.at(-1).id)?.round)
            && (distanceToBottom <= 24 || (saved?.bottom && distanceToBottom <= 32))) {
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
        const hasLater = historyRange(rows).end < rows.length || !!rows.length && !records.get(rows.at(-1).id)?.round;
        jump.hidden = !visible || content.hidden || feed.clientHeight <= 0 || (!hasLater && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= feed.clientHeight);
        jump.disabled = jump.hidden;
    }
    function setFeedScroll(value) {
        const previous = feed.scrollTop;
        feed.scrollTop = value;
        if (feed.scrollTop !== previous) {
            lastProgrammaticScroll = feed.scrollTop;
            onProgrammaticScroll(feed);
            observe('恢复阅读位置', { programmatic: true, targetScroll: Math.round(value), scrollTop: feed.scrollTop,
                scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight });
        }
    }
    function restorePosition(position) {
        if (!visible || content.hidden || !feed.clientHeight) return;
        if (!position || position.bottom) {
            const target = feed.scrollHeight;
            if (Math.abs(feed.scrollTop - target) > 2) setFeedScroll(target);
        } else {
            const item = views.get(position.anchor?.split('/')[0])?.item;
            const anchor = item && !item.hidden && [...item.querySelectorAll('[data-read-anchor]')].find(node => node.dataset.readAnchor === position.anchor && !node.closest('[hidden]'));
            if (anchor) {
                restorePlayElementPosition(feed, anchor, -(Number(position.offset) || 0), readingInset(), setFeedScroll);
            } else {
                const target = Number(position.scrollTop) || 0;
                if (Math.abs(feed.scrollTop - target) > 2) setFeedScroll(target);
            }
        }
        cachedPosition = position ? { scrollTop: feed.scrollTop, feedHeight: feed.clientHeight, inset: readingInset(), key: characterKey(selected) } : null;
        updateJump();
    }
    function keepReading(change, followBottom = true, message) {
        // Editing keeps a visible anchor even when the feed was at the bottom.
        const position = message?.getClientRects().length
            ? { bottom: false, anchor: message.querySelector('[data-read-anchor]')?.dataset.readAnchor,
                offset: -readPlayElementPosition(feed, message, readingInset()), scrollTop: feed.scrollTop }
            : capturePosition(followBottom) ?? positions.get(characterKey(selected));
        change(); restorePosition(position); rememberPosition(followBottom, true);
    }
    function jumpToLatest() {
        if (!visible) return;
        // Cancel an in-flight older-page batch before moving the history window.
        // It must not append its old range after the user asks for the latest.
        if (historyLoad) { refreshId++; historyLoad = null; }
        positions.set(characterKey(selected), { bottom: true });
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        if (historyRange(rows).end < rows.length || rows.length && !records.get(rows.at(-1).id)?.round) {
            displayedCharacter = '';
            resetHistoryWindow(rows);
            renderHistory(); void refresh();
        }
        restorePosition({ bottom: true }); rememberPosition(); updateJump();
    }
    function jumpToMessage(id, role) {
        const view = views.get(id), message = view?.[role];
        if (!visible || !message?.getClientRects().length) return;
        scrollPlayMessageToTop(feed, message, readingInset(), setFeedScroll, recordEditor(view, role));
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
        if (!visible || mobile.matches && browsing) return;
        if (lastMobile !== mobile.matches) { lastMobile = mobile.matches; renderPeople(); updateBrowser(); updateControls(); }
        // ResizeObserver runs before paint; do not defer catalog pagination by a frame.
        characterPicker.layout();
        layoutFrame = requestAnimationFrame(() => {
            if (!visible || mobile.matches && browsing) return;
            // A user scroll can arrive before its scroll event. Never restore
            // an older anchor over a new position from the browser compositor.
            if (!restoringPosition && cachedPosition?.key === characterKey(selected)
                && (cachedPosition.inset !== readingInset() || Math.abs(cachedPosition.scrollTop - feed.scrollTop) >= 2)) {
                rememberPosition(true, true);
            }
            resizeInput();
            const feedHeight = feed.clientHeight - readingInset();
            updateMessageTops([...views.values()].filter(view => !view.item.hidden), feedHeight);
            if (!feedHeight || displayedCharacter !== characterKey(selected)) return;
            // Finish restoring a reopened panel during generation too, so later
            // user scrolls can replace the saved position before completion.
            if (jobsHere().some(job => activePhases.has(job.phase)) && !restoringPosition) {
                if (feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 24) setFeedScroll(feed.scrollHeight);
                updateJump();
                return;
            }
            if (hasActiveEditor() && !restoringPosition) { updateJump(); return; }
            restorePosition(positions.get(characterKey(selected)));
            restoringPosition = false;
            rememberPosition(true, false);
        });
    }
    function updateMessageTops(items, height = feed.clientHeight - readingInset()) {
        const updates = items.map(view => ({ view,
            userHidden: !playMessageNeedsTop(view.userText, view.userHead, height, recordEditor(view, 'user')),
            assistantHidden: !playMessageNeedsTop(view.results, view.aiHead, height, recordEditor(view, 'assistant')) }));
        for (const { view, userHidden, assistantHidden } of updates) {
            if (view.userTop.hidden !== userHidden) view.userTop.hidden = userHidden;
            if (view.assistantTop.hidden !== assistantHidden) view.assistantTop.hidden = assistantHidden;
            syncMessageActions(view);
        }
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
        const programmatic = lastProgrammaticScroll !== undefined && Math.abs(lastProgrammaticScroll - feed.scrollTop) < 2;
        lastProgrammaticScroll = undefined;
        // Native resizing can clamp/focus-scroll the feed before ResizeObserver
        // runs. Do not overwrite the saved paragraph/bottom with that movement.
        if (nativeInputSizing && cachedPosition?.key === characterKey(selected) && cachedPosition.feedHeight !== feed.clientHeight) return;
        const moved = cachedPosition?.key === characterKey(selected) && Math.abs(cachedPosition.scrollTop - feed.scrollTop) >= 2;
        if (moved && !programmatic && !restoringPosition) { pendingReveal = null; latestRequest = null; }
        rememberPosition(true, false); updateJump();
        if (moved && !programmatic && !restoringPosition && feed.scrollHeight > feed.clientHeight) {
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
        inputRow.hidden = !canWrite(); compose.classList.toggle('is-readonly', inputRow.hidden);
        compose.hidden = inputRow.hidden && contextLine.hidden;
        updateSendControl();
        const jobs = playground.getStates();
        const multipleActive = jobs.filter(job => activePhases.has(job.phase)).length > 1;
        for (const [id, view] of views) {
            const round = records.get(id)?.round, own = canWrite() && round?.characterId === selected?.id;
            const result = round && selectedResult(round), job = jobs.find(job => job.resultId === result?.id) ?? { phase: 'idle' };
            view.stop.hidden = !result || !showPlayReplyStop(job, multipleActive);
            view.stop.dataset.resultId = job.resultId ?? '';
            view.edit.hidden = !canEditPrompt(round) || isEditing(id, 'user');
            view.editReply.hidden = !canEditResult(result) || isEditing(id, 'assistant');
            view.edit.disabled = view.editReply.disabled = !!view.removing || !!view.favoriting || messageEditing.busy;
            view.removePrompt.hidden = view.removeReply.hidden = false;
            view.removePrompt.disabled = !canRemoveMessage(round, 'user', jobs);
            view.removeReply.disabled = !canRemoveMessage(round, 'assistant', jobs);
            view.generate.hidden = !own || !round?.prompt || !!round.results.length;
            view.generate.disabled = !canGenerate(round);
            view.again.hidden = !(own && round.prompt !== null) || round?.initialIsLast === false;
            view.again.disabled = !canRewrite(round, result);
            const currentSelected = round && selectedResult(round);
            const canCont = canContinue(round, currentSelected);
            view.continueBtn.hidden = !(own && round?.prompt !== null && currentSelected?.text?.trim());
            if (round?.initialIsLast === false || round?.initialAssistantHidden) view.continueBtn.hidden = true;
            view.branch.hidden = !onBranch;
            view.branch.disabled = !result || !canEditResult(result) || isEditing(id) || settings.enabled === false;
            view.continueBtn.disabled = !canCont;
            if (round) { updateResultNavigation(round, view); updateFavoriteStar(round, view); updatePromptFavoriteStar(round, view); }
            if (view.sourceMissing) {
                for (const tools of [view.userTools, view.replyTools, view.actions, view.userActions]) {
                    for (const button of tools.querySelectorAll('button')) if (!button.closest('.play-edit-actions')) button.disabled = true;
                }
            }
            syncMessageActions(view);
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
        return canRewrite(round, result) && !!result?.text?.trim() && !round.initialAssistantHidden;
    }
    function updateResultNavigation(round, view) {
        view.swipes.hidden = round.initialIsLast === false;
        const index = round.results.indexOf(selectedResult(round)), atEnd = index === round.results.length - 1;
        view.prev.disabled = isEditing(round.id) || !!view.removing || index <= 0;
        view.next.disabled = isEditing(round.id) || !!view.removing || (atEnd && !canGenerate(round));
        view.next.title = atEnd && canWrite() && round.prompt !== null ? '生成新剧场' : '下一个结果';
        view.next.setAttribute('aria-label', view.next.title);
    }
    function syncMessageActions(view) {
        view.userActions.hidden = view.userTop.hidden && view.generate.hidden;
        syncPlayReplyFooter(view);
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
    function canRemoveMessage(round, role, jobs = playground.getStates()) {
        if (!round || settings.enabled === false || isEditing(round.id, role)) return false;
        const view = views.get(round.id);
        return !view?.removing && !view?.favoriting && !roundBusy(round.id, jobs);
    }
    async function removeMessage(id, role) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!view || !canRemoveMessage(round, role)) return;
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
        } catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
        finally { view.removing = false; updateControls(); }
    }
    function editPrompt(id) {
        const round = records.get(id)?.round, view = views.get(id);
        if (!canEditPrompt(round) || !view || view.removing || view.favoriting || messageEditing.busy) return;
        openMessageEditor(id, 'user');
    }
    function notifyRequestError(error) { if (!playground.session.isSaveError(error)) notify(error.message); }
    async function runGeneration(run, { draft, prompt, role = 'assistant' } = {}) {
        const request = { key: characterKey(selected), draft, prompt, role, accepted: false, resultId: null };
        latestRequest = request; startingRequest = request;
        let task;
        try { task = run(); }
        finally { startingRequest = null; }
        try { await task; }
        catch (error) { notifyRequestError(error, request.resultId); }
        finally { if (request.resultId) requests.delete(request.resultId); }
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
        return result && settings.enabled !== false && !['preparing', 'generating', 'retry-wait', 'unfinished'].includes(result.status);
    }
    function isEditing(id, role) {
        return !!messageEditing.find('record', id, role);
    }
    function recordEditor(view, role, resultId) {
        return messageEditing.find('record', view.id, role, resultId)?.editor;
    }
    function hasActiveEditor() {
        return [...views].some(([id, view]) => !view.item.hidden && isEditing(id));
    }
    function captureRecordEditors(view) {
        const session = messageEditing.find('record', view.id);
        if (session?.editor.input.getClientRects().length) session.state = session.editor.capture();
    }
    function restoreRecordEditors(view) {
        const session = messageEditing.find('record', view.id);
        if (session?.state && session.editor.input.getClientRects().length) { session.editor.restore(session.state); session.state = null; }
    }
    const readingInset = getReadingInset;
    function editResult(id) {
        const round = records.get(id)?.round, result = round && selectedResult(round);
        const view = views.get(id), output = view?.outputs.get(result?.id);
        if (!canEditResult(result) || !output || view.removing || view.favoriting || messageEditing.busy) return;
        openMessageEditor(id, 'assistant', result.id);
    }
    function openMessageEditor(id, role, resultId) {
        void messageEditing.open({ key: `record/${id}/${role}/${resultId ?? ''}`, async create() {
            await playground.ensureChat(id, { selectedResultId: selections.get(id) });
            let round = playground.session.currentRound(id);
            if (role === 'user' ? round.prompt === undefined : round.results.find(result => result.id === resultId)?.text === undefined) {
                await playground.session.loadMessage(id, role === 'user' ? round.initialUserId : round.initialAssistantId, resultId);
                round = playground.session.currentRound(id);
            }
            const view = views.get(id);
            const result = role === 'assistant' ? round.results.find(item => item.id === resultId) : null;
            if (!view || view.removing || view.favoriting || (role === 'user' ? !canEditPrompt(round) : !canEditResult(result))) return null;
            records.set(id, { round });
            const original = role === 'user' ? round.prompt : result.text;
            const character = roundCharacter(round);
            const session = { page: 'record', id, role, resultId, character, view,
                activate() {
                    keepReading(() => {
                        if (resultId) selections.set(id, resultId);
                        renderRecord(round, view);
                        updateControls(); session.editor.resize();
                    }, false, view[role]);
                    session.editor.input.focus({ preventScroll: true });
                    revealPlayEditor(feed, session.editor, readingInset(), setFeedScroll); rememberPosition(false, true); layout();
                },
                async finish() {
                    if (role === 'user') { view.promptText = null; view.promptSourceSignature = null; }
                    else if (view.outputs.has(resultId)) view.outputs.get(resultId).signature = null;
                    if (!visible || characterKey(selected) !== characterKey(character)) {
                        session.editor.actions.remove(); session.editor.body.remove();
                        renderRecord(records.get(id)?.round ?? round, view);
                        resumeNeedsRefresh = true; return;
                    }
                    try {
                        const updated = playground.session.currentRound(id);
                        const message = view[role], area = feed.getBoundingClientRect(), box = message.getBoundingClientRect();
                        const position = box.bottom > area.top + readingInset() && box.top < area.bottom
                            ? { bottom: false, anchor: message.querySelector('[data-read-anchor]')?.dataset.readAnchor,
                                offset: -readPlayElementPosition(feed, message, readingInset()), scrollTop: feed.scrollTop }
                            : capturePosition(false);
                        session.editor.actions.remove();
                        records.set(id, { round: updated });
                        renderRecord(updated, view); restorePosition(position); rememberPosition(false, true);
                    } catch (error) { session.editor.actions.remove(); session.editor.body.remove(); view.item.remove(); views.delete(id); records.delete(id); showReadError(error.message); }
                },
                async reveal() {
                    setBrowsing(false);
                    await chooseCharacter(character, true);
                    view.item.hidden = false; content.hidden = false; empty.hidden = true;
                    if (!content.contains(view.item)) content.insertBefore(view.item, laterBar);
                    restoreRecordEditors(view);
                    const error = session.editor.error.getBoundingClientRect(), area = feed.getBoundingClientRect();
                    if (error.bottom > area.bottom) setFeedScroll(feed.scrollTop + error.bottom - area.bottom);
                    else if (error.top < area.top + readingInset()) setFeedScroll(feed.scrollTop + error.top - area.top - readingInset());
                },
            };
            session.editor = createPlayEditor({ text: original, label: role === 'user' ? '提示词原文' : '回复原文',
                onSubmit: () => messageEditing.save(session), onCancel: () => messageEditing.cancel(session),
                async onSave({ text }) {
                    const updated = role === 'user' ? await playground.editPrompt(id, text, original)
                        : await playground.editResult(id, resultId, text, original);
                    records.set(id, { round: updated });
                },
            });
            return session;
        } });
    }
    function header(character, time, anchor, role = 'assistant') {
        const head = element('header', undefined, `play-message-meta play-${role}-meta`);
        head.dataset.readAnchor = anchor;
        const identity = element('span', undefined, 'play-message-identity'), speaker = element('strong', character.name, 'play-speaker'); speaker.title = character.name;
        const date = element('time', messageTime(time), 'play-message-time'); date.dateTime = time;
        const portrait = createCharacterAvatar(ctx, character, 'play-message-avatar', role === 'user' ? 'persona' : 'avatar');
        identity.append(speaker, date);
        head.append(portrait, identity);
        return { head, date, speaker };
    }
    function roundCharacter(round) {
        return characters.find(character => character.id === round.characterId) ?? { name: round.results[0]?.context.characterName || '角色', avatar: null };
    }
    function createRecord(round) {
        const owner = roundCharacter(round);
        const user = playMessageIdentity(round);
        const item = element('article', undefined, 'play-record'); item.dataset.record = round.id;
        item.setAttribute('aria-label', `${messageTime(round.createdAt)} 的小剧场`);
        const userMessage = element('section', undefined, 'play-message play-user-message'); userMessage.setAttribute('aria-label', `${user.name} 发送的小剧场提示词`);
        const userHead = header(user, round.createdAt, `${round.id}/user/head`, 'user'), userText = element('div', undefined, 'play-user-text');
        const userActions = element('footer', undefined, 'play-message-actions');
        const userFavorite = iconButton('star', '收藏用户消息', () => void togglePromptFavorite(round.id)); userFavorite.classList.add('tea-star');
        const edit = iconButton('edit', '修改提示词', () => editPrompt(round.id)); edit.classList.add('play-edit-prompt');
        const removePrompt = iconButton('trash', '删除用户消息', () => void removeMessage(round.id, 'user')); removePrompt.classList.add('play-delete');
        const userTools = element('div', undefined, 'play-header-actions');
        const userMore = setupPlayReplyHeaderActions(userTools, { favorite: userFavorite, edit, remove: removePrompt, role: 'user' }); userHead.head.append(userTools);
        const userTop = createPlayMessageTop(() => jumpToMessage(round.id, 'user'));
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
            onAgain: () => void regenerate(records.get(round.id).round),
            onContinue: () => void continueReply(records.get(round.id).round),
            onStop: () => playground.stop(stop.dataset.resultId), onTop: () => jumpToMessage(round.id, 'assistant'),
        });
        assistant.append(aiHead.head, results, actions); item.append(userMessage, assistant);
        return { id: round.id, item, user: userMessage, assistant, userText, userHead: userHead.head, userHeader: userHead, userSignature: JSON.stringify(user), aiHead: aiHead.head, userActions, actions, userTop, assistantTop,
            userTools, userMore, replyTools, replyMore, prompt, userFavorite, favorite, branch, removePrompt, removeReply, generate, time: aiHead.date, speaker: aiHead.speaker, results, error, edit, editReply, again, continueBtn, stop, swipes, prev, count, next, outputs: new Map() };
    }
    function selectedResult(round) {
        const editingId = messageEditing.find('record', round.id, 'assistant')?.resultId;
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
        } catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
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
        const userEditor = recordEditor(view, 'user'), replyEditor = recordEditor(view, 'assistant');
        placePlayEditorActions(view.userTools, view.edit, userEditor);
        placePlayEditorActions(view.replyTools, view.editReply, replyEditor);
        if (userEditor && !view.userText.contains(userEditor.body)) view.userText.replaceChildren(userEditor.body);
        updateUserMessage(round, view);
        const ids = new Set(round.results.map(result => result.id));
        // Keep an open draft even if another window replaced its source result.
        // Cancelling then renders the new result; saving reports the missing source.
        if (replyEditor && !ids.has(messageEditing.find('record', round.id, 'assistant').resultId)) { restoreRecordEditors(view); return; }
        for (const [id, output] of view.outputs) {
            if (!ids.has(id)) { output.box.remove(); view.outputs.delete(id); }
        }
        const result = selectedResult(round), index = round.results.indexOf(result);
        if (view.assistant.hidden !== !result) view.assistant.hidden = !result;
        if (!result) { restoreRecordEditors(view); return; }
        view.time.textContent = messageTime(result.startedAt); view.time.dateTime = result.startedAt;
        const name = roundCharacter(round).name;
        if (name) { view.speaker.textContent = name; view.speaker.title = name; }
        if (!view.outputs.has(result.id)) {
            const output = createOutput(round, result); view.outputs.set(result.id, output); view.results.append(output.box);
        }
        for (const [id, output] of view.outputs) if (output.box.hidden !== (id !== result.id)) output.box.hidden = id !== result.id;
        const output = view.outputs.get(result.id);
        view.editReply.hidden = !canEditResult(result) || !!replyEditor;
        updateFavoriteStar(round, view);
        const job = playground.getState(result.id);
        const depth = playRoundDepth(round);
        const sourceSignature = JSON.stringify([result.text, result.context?.userName, playground.display?.revision ?? 0, depth]);
        if (output.sourceSignature !== sourceSignature) {
            output.displayText = playground.display?.process(result.text, roundCharacter(round), result.context, 'assistant', depth) ?? result.text;
            output.sourceSignature = sourceSignature;
        }
        if (replyEditor && !output.box.contains(replyEditor.body)) output.box.replaceChildren(replyEditor.body);
        renderPlayReply(output, result, { displayText: output.displayText, job, error: view.error,
            name: roundCharacter(round).name, anchor: `${round.id}/assistant/${result.id}`, editing: !!replyEditor });
        view.swipes.hidden = false;
        updateResultNavigation(round, view);
        view.count.disabled = isEditing(round.id) || !!view.removing;
        updatePlayReplyCount(view.count, index, round.results.length);
        restoreRecordEditors(view);
        syncMessageActions(view);
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
            bar.hidden = content.hidden || !selected || remaining <= 0;
            if (bar.hidden) continue;
            bar.textContent = historyLoad?.direction === direction ? '正在加载记录…' : `加载${label}记录（剩余 ${remaining} 条）`;
            bar.disabled = !!historyLoad;
        }
    }
    async function readHistoryRows(rows, isCurrent, show) {
        const read = rows.length ? await playground.createRoundReader?.() : null;
        let next = 0, frame = 0;
        const batch = ++batchNumber, started = performance.now();
        observe('开始读取一批记录', { batch, count: rows.length });
        const schedule = () => {
            if (!frame && visible) frame = requestAnimationFrame(() => { frame = 0; if (isCurrent()) show(); });
        };
        try {
            await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
                while (next < rows.length && isCurrent()) {
                    const row = rows[next++], cached = records.get(row.id);
                    const readStarted = performance.now();
                    const directory = rowsByCharacter.get(selected?.id) ?? [];
                    const details = { batch, record: row.id, ordinal: directory.findIndex(item => item.id === row.id) + 1, total: directory.length };
                    observe('开始读取记录', details);
                    try {
                        const round = read ? await read(row.id) : await playground.getRound(row.id);
                        observe('记录读取完成', { ...details, durationMs: Math.round(performance.now() - readStarted), reason: isCurrent() ? 'current' : 'stale' });
                        if (isCurrent()) records.set(row.id, { round, revision: row.revision });
                    } catch {
                        observe('记录读取失败', { ...details, durationMs: Math.round(performance.now() - readStarted), reason: isCurrent() ? 'current' : 'stale' });
                        if (!isCurrent()) return;
                        if (cached?.round) cached.error = true; else records.set(row.id, { error: true });
                    }
                    schedule();
                }
            }));
        } finally {
            observe('一批记录读取结束', { batch, durationMs: Math.round(performance.now() - started), reason: isCurrent() ? 'current' : 'stale' });
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
        if (!visible || mobile.matches && browsing) return;
        const ready = rowsByCharacter.has(selected?.id);
        const rows = rowsByCharacter.get(selected?.id) ?? [];
        const key = characterKey(selected);
        const { start, end } = historyRange(rows, key);
        const visibleRows = rows.slice(start, end);
        const visibleIds = new Set(visibleRows.map(row => row.id));
        for (const [id, view] of views) {
            view.sourceMissing = isEditing(id) && records.get(id)?.round.characterId === selected?.id && !rows.some(row => row.id === id);
            if (view.sourceMissing) visibleIds.add(id);
        }
        let retainedFrames = 0;
        for (const [id, view] of views) {
            const retainFrame = !visibleIds.has(id) && !!view.item.querySelector('iframe') && retainedFrames++ < historyPageSize;
            if (!visibleIds.has(id) && !isEditing(id) && !roundBusy(id) && !view.removing && !view.favoriting
                && !retainFrame) {
                view.item.remove(); views.delete(id);
            } else if (view.item.hidden !== !visibleIds.has(id)) {
                if (!view.item.hidden) captureRecordEditors(view);
                view.item.hidden = !visibleIds.has(id);
                if (!view.item.hidden) restoreRecordEditors(view);
            }
        }
        const recordSize = cached => (cached?.round?.prompt?.length ?? 0) + (cached?.round?.results ?? []).reduce((size, result) => size + (result.text?.length ?? 0), 0);
        let retainedCharacters = [...records.values()].reduce((size, cached) => size + recordSize(cached), 0);
        for (const [id, cached] of records) {
            if (records.size <= 160 && retainedCharacters <= 4 * 1024 * 1024) break;
            if (!visibleIds.has(id) && !views.has(id) && !roundBusy(id)) { records.delete(id); retainedCharacters -= recordSize(cached); }
        }
        const savedTarget = pendingReveal?.key === key ? pendingReveal.roundId : positions.get(key)?.anchor?.split('/')[0];
        const targetId = visibleIds.has(savedTarget) ? savedTarget : visibleRows.at(-1)?.id;
        const target = records.get(targetId), rulesReady = displayReady();
        // A directory containing the last row does not mean its body has arrived.
        // Keep one stable loading surface until the intended opening record can
        // be rendered with its display rules, then commit and position together.
        if (!ready || !rulesReady || displayedCharacter !== key && targetId && !target?.round) {
            content.hidden = true; displayedCharacter = '';
            empty.hidden = !readError.hidden || !!target?.error && rulesReady;
            empty.dataset.state = 'loading'; emptyArt.hidden = true;
            emptyTitle.textContent = '正在读取演出记录…';
            if (target?.error && rulesReady) showReadError('要显示的演出记录暂时无法读取。');
            feed.setAttribute('aria-busy', String(!empty.hidden));
            updateEarlierBar(); updateJump(); updateControls();
            observe('等待首次正文', { target: targetId, rulesReady, ready: !!target?.round, failed: !!target?.error, total: rows.length });
            return;
        }
        if (content.hidden) content.hidden = false;
        if (feed.getAttribute('aria-busy') !== 'false') feed.setAttribute('aria-busy', 'false');
        let shown = visibleIds.size - visibleRows.length, next = null;
        for (const row of [...visibleRows].reverse()) {
            const cached = records.get(row.id); if (!cached?.round) continue;
            let view = views.get(row.id);
            if (!view) {
                view = createRecord(cached.round); views.set(row.id, view);
                content.insertBefore(view.item, next ?? laterBar);
            }
            next = view.item;
            if (view.item.hidden) { view.item.hidden = false; restoreRecordEditors(view); }
            renderRecord(cached.round, view); shown++;
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
        observe('显示记录批次', { target: targetId, total: rows.length, start, end, shown, rulesReady,
            latestReady: !!records.get(rows.at(-1)?.id)?.round, rulesRevision: playground.display?.revision ?? 0 });
        updateControls();
    }
    async function changeResult(id, direction, resultId) {
        let round = records.get(id)?.round; if (!round || isEditing(id) || views.get(id)?.removing) return;
        if (round.initialIsLast === false) return;
        const index = round.results.indexOf(selectedResult(round));
        const result = resultId ? round.results.find(item => item.id === resultId) : round.results[index + direction];
        if (!result) return;
        if (round.initialAssistantId) {
            try { await playground.setMessageVersion(id, round.initialAssistantId, result.id, round.selectedResultId, { playSelection: true }); }
            catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); return; }
            round = playground.session.currentRound(id); records.set(id, { round });
        }
        latestRequest = null; pendingReveal = null;
        closeResults(); selections.set(id, result.id); renderRecord(round, views.get(id)); updateControls();
        jumpToMessage(id, 'assistant'); scheduleSave();
    }
    function showResults(id) {
        const round = records.get(id)?.round; if (!round || isEditing(id) || views.get(id)?.removing) return;
        resultMenu.toggle({ key: id, root, readingArea, feed, opener: views.get(id).count, alignment: views.get(id).results,
            selectedId: selectedResult(round).id,
            entries: round.results.map(result => {
                const preview = playground.display?.process(result.text, roundCharacter(round), result.context, 'assistant', playRoundDepth(round)) ?? result.text;
                return { id: result.id, text: playTextPreview(preview) || playResultStatusText[result.status] || '内容已隐藏', time: messageTime(result.startedAt) };
            }), onSelect: resultId => changeResult(id, 0, resultId) });
    }
    function closeResults(restore = true) { resultMenu.close(restore); }
    function showReadError(message) {
        readError.replaceChildren(element('span', message), textButton('重新读取', () => void refresh())); readError.hidden = false;
    }
    function displayReady() {
        const target = selected ?? current;
        return !playground.display || !!playground.display.isReady?.(target)
            || !!(displayLoad?.avatar === target?.avatar && displayLoad?.settled);
    }
    function refreshDisplay(character = selected ?? current) {
        if (!playground.display) return;
        if (displayLoad?.avatar === character?.avatar && !displayLoad.settled) return displayLoad.promise;
        const request = displayLoad = { avatar: character?.avatar, settled: false };
        const started = performance.now();
        observe('开始读取显示规则', { cached: !!playground.display.isReady?.(character), character: characterKey(character) });
        request.promise = playground.display.refresh(character).then(() => {
            observe('显示规则读取完成', { durationMs: Math.round(performance.now() - started), rulesRevision: playground.display.revision });
        }, () => {
            observe('显示规则读取失败', { durationMs: Math.round(performance.now() - started) });
            if (visible && displayLoad === request) notify('酒馆正则读取失败，请在设置中刷新正则列表后重试。');
        }).finally(() => {
            request.settled = true;
            if (visible && displayLoad === request && (selected ?? current)?.avatar === request.avatar) {
                keepReading(renderHistory); layout();
            }
        });
        return request.promise;
    }
    async function chooseCharacter(character, internal = false) {
        if (!internal && messageEditing.busy) return;
        if (characterKey(selected) === characterKey(character)) { if (mobile.matches) setBrowsing(false); return; }
        for (const view of views.values()) captureRecordEditors(view);
        latestRequest = null; pendingReveal = null;
        closeResults(false); rememberPosition(); selected = character;
        displayedCharacter = '';
        if (!visible) { renderPeople(); resumeNeedsRefresh = true; return; }
        displayLoad = null; void refreshDisplay(character);
        if (mobile.matches) setBrowsing(false);
        renderPeople(); renderHistory(); updateComposer(); restorePosition(positions.get(characterKey(selected)));
        await refresh();
    }
    async function refreshCharacters(isCurrent = () => true) {
        syncCurrent();
        const savedCharacters = await playground.listCharacters();
        if (!isCurrent()) return false;
        const previous = selected, previousKey = characterKey(previous);
        characters = mergePlayCharacters(savedCharacters, ctx().characters);
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
        return true;
    }
    async function refresh() {
        if (suspended || !visible) { resumeNeedsRefresh = true; return; }
        await readingLoaded;
        if (suspended || !visible) { resumeNeedsRefresh = true; return; }
        if (mobile.matches && browsing) {
            const saved = await playground.listCharacters();
            if (visible && browsing) {
                characters = mergePlayCharacters(saved, ctx().characters);
                selected = characters.find(character => character.id === selected?.id) ?? selected;
                renderPeople();
            }
            resumeNeedsRefresh = true; return;
        }
        const id = ++refreshId;
        historyLoad = null;
        readError.hidden = true;
        const isCurrent = () => id === refreshId && visible && !(mobile.matches && browsing);
        try {
            if (id !== refreshId) return;
            if (!await refreshCharacters(isCurrent)) return;
            const key = characterKey(selected);
            if (visible && !displayReady()) void refreshDisplay(selected ?? current);
            if (visible) { renderPeople(); updateBrowser(); updateComposer(); }
            const characterId = selected?.id;
            const rows = characterId ? await playground.listRounds(characterId) : []; if (!isCurrent()) return;
            const previousRows = rowsByCharacter.get(characterId) ?? [];
            const previousRange = historyRange(previousRows, key);
            rowsByCharacter.set(characterId, rows);
            observe('记录目录读取完成', { character: key, total: rows.length, batch: id });
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
            if (pending.length) await readHistoryRows(pending, isCurrent, showBatch);
        } catch (error) {
            if (id !== refreshId) return;
            loaded = true; showReadError(error.message || '演出记录暂时无法读取。');
            if (visible) { renderPeople(); renderHistory(); updateComposer(); }
        } finally {
            if (id === refreshId && visible && restoringPosition) layout();
        }
    }
    function applyJob(job) {
        if (!job.round) return;
        records.set(job.round.id, { round: job.round, revision: job.chat?.revision });
    }
    function renderChangedJobs() {
        streamFrame = 0;
        const updates = [...changedJobs.values()]; changedJobs.clear();
        const change = () => {
            for (const job of updates) {
                applyJob(job);
                const record = records.get(job.roundId)?.round, view = views.get(job.roundId);
                if (visible && record && view && !view.item.hidden) {
                    renderRecord(record, view);
                    updateMessageTops([view]);
                }
            }
            if (visible) updateControls();
        };
        if (visible) keepReading(change); else change();
    }
    playground.subscribe(job => {
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
        changedJobs.set(job.roundId ?? job.requestedRoundId ?? job.resultId, job);
        if (!streamFrame && visible && !(mobile.matches && browsing)) streamFrame = requestAnimationFrame(renderChangedJobs);
        if (job.round && (selected?.id === job.round.characterId || selected?.avatar === job.characterAvatar)) {
            if (selected.id !== job.round.characterId) {
                const previousKey = characterKey(selected);
                selected = { ...selected, id: job.round.characterId };
                const key = characterKey(selected);
                for (const map of [positions, drafts, historyWindows]) if (map.has(previousKey)) { map.set(key, map.get(previousKey)); map.delete(previousKey); }
                for (const request of requests.values()) if (request.key === previousKey) request.key = key;
                if (pendingReveal?.key === previousKey) pendingReveal.key = key;
                displayedCharacter = key;
            }
            const rows = rowsByCharacter.get(job.round.characterId) ?? [];
            if (!rows.some(row => row.id === job.roundId)) rows.push({ id: job.roundId, characterId: job.round.characterId,
                revision: job.chat?.revision, createdAt: job.round.createdAt });
            rowsByCharacter.set(job.round.characterId, rows);
            applyJob(job);
            if (request && pendingReveal?.roundId === job.roundId && visible) {
                resetHistoryWindow(rows, job.roundId, characterKey(selected));
                renderHistory(); updateComposer(); jumpToLatest(); pendingReveal = null;
            }
        }
    });
    const events = ctx().eventTypes ?? {};
    if (events.CHAT_CHANGED) ctx().eventSource.on(events.CHAT_CHANGED, () => {
        if (visible) rememberPosition();
        void refresh();
    });
    window.addEventListener('pagehide', () => { rememberPosition(true, true); saveReadingPosition(); void saveViewState(); });
    window.addEventListener('focus', () => {
        if (visible) { rememberPosition(); void refresh(); void refreshFavorites(); }
    });

    return {
        browser, chooseButton, page,
        get suspended() { return suspended; },
        prepareActivation() {
            if (visible) return;
            resetHistoryWindow(rowsByCharacter.get(selected?.id) ?? []);
            const rows = rowsByCharacter.get(selected?.id) ?? [], { start, end } = historyRange(rows);
            const ids = new Set(rows.slice(start, end).map(row => row.id));
            for (const [id, view] of views) if (view.item.hidden !== !ids.has(id)) {
                if (!view.item.hidden) captureRecordEditors(view);
                view.item.hidden = !ids.has(id);
                if (!view.item.hidden) restoreRecordEditors(view);
            }
        },
        activate(container) {
            suspended = false;
            if (visible) { root = container; return; }
            // Reattaching the panel can reset scrollTop before its first layout.
            // Keep the saved position authoritative until that layout restores it.
            root = container; visible = true; restoringPosition = true; displayedCharacter = '';
            syncCurrent(); browsing ??= !current; updateBrowser();
            resetHistoryWindow(rowsByCharacter.get(selected?.id) ?? []);
            renderHistory(); updateComposer();
            restorePosition(positions.get(characterKey(selected)));
            resizeObserver.observe(page); resizeObserver.observe(content); resizeObserver.observe(people); resizeObserver.observe(compose);
            // Paint the panel controls before measuring history or loading the
            // native helpers. A tab click must not wait for conversation layout.
            cancelAnimationFrame(activationFrame); clearTimeout(activationTimer);
            activationFrame = requestAnimationFrame(() => {
                activationTimer = setTimeout(() => {
                    if (!visible) return;
                    renderPeople(); layout(); void refreshFavorites();
                    void refreshDisplay(); void refresh();
                    if (playground.initialize) void playground.initialize().then(() => {
                        if (visible) updateControls();
                    }).catch(() => notify('生成接口载入失败，请关闭后再打开剧场演出重试。'));
                }, 0);
            });
        },
        deactivate() {
            suspended = false;
            for (const view of views.values()) if (!view.item.hidden) captureRecordEditors(view);
            const key = characterKey(selected);
            if (visible && (!cachedPosition || cachedPosition.key !== key || cachedPosition.inset !== readingInset()
                || Math.abs((cachedPosition.scrollTop ?? -999) - feed.scrollTop) >= 2)) {
                commitPosition(capturePosition(true));
            }
            visible = false; refreshId++; historyLoad = null; restoringPosition = false; closeResults(false); characterPicker.suspend(); scheduleSave();
            saveReadingPosition();
            cancelAnimationFrame(activationFrame); clearTimeout(activationTimer); cancelAnimationFrame(layoutFrame); cancelAnimationFrame(streamFrame); streamFrame = 0; resizeObserver.disconnect();
            cancelAnimationFrame(inputSizingFrame); inputSizingFrame = 0; inputComposing = false;
        },
        close() { this.deactivate(); root = null; page.remove(); browser.remove(); },
        suspend() {
            const rows = rowsByCharacter.get(selected?.id) ?? [], { start, end } = historyRange(rows);
            resumeNeedsRefresh ||= !!historyLoad || !loaded || !displayReady() || rows.slice(start, end).some(row => records.get(row.id)?.revision !== row.revision);
            this.deactivate(); suspended = true;
        },
        resume(container, { displayChanged = false, checkData = false } = {}) {
            root = container; visible = true; suspended = false;
            for (const view of views.values()) if (!view.item.hidden) restoreRecordEditors(view);
            const refreshNeeded = checkData || resumeNeedsRefresh || displayedCharacter !== characterKey(selected); resumeNeedsRefresh = false;
            restorePosition(positions.get(characterKey(selected)));
            if (displayChanged || changedJobs.size) keepReading(() => { renderChangedJobs(); renderHistory(); });
            if (refreshNeeded) void refresh();
            renderPeople(); updateBrowser();
            restorePosition(positions.get(characterKey(selected)));
            resizeObserver.observe(page); resizeObserver.observe(content); resizeObserver.observe(people); resizeObserver.observe(compose);
            updateControls(); updateComposer(); layout();
        },
        refresh, layout, updateEditing: updateControls,
        getSelectedCharacter: () => selected,
        prepareLayout() { if (visible) { closeResults(false); for (const view of views.values()) captureRecordEditors(view); rememberPosition(true, false); saveViewState(); } },
        focusInput() { if (visible && canWrite()) input.focus({ preventScroll: true }); },
        canLeave: ({ ignoreEditing = false } = {}) => (ignoreEditing || !messageEditing.busy) && ![...views.values()].some(view => view.removing),
        async fillFromEntry(entry) {
            await refreshCharacters(); if (!selected || !canWrite()) return false;
            browsing = false;
            replaceDraft({ text: entry.body, origin: { id: entry.id, title: entry.title }, mode: 'original' });
            return true;
        },
    };
}
