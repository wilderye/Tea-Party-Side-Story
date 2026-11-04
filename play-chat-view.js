import { element, textButton, iconButton, glyph } from './ui.js';
import { playMessageDepths, playHiddenRanges, playMessageIsPending, playChatMessageIdentity } from './play-message-context.js';
import { createPlayCharacterPicker, createCharacterAvatar, mergePlayCharacters, playCharacterKey } from './play-character-picker.js';
import { createPlayEditor } from './play-editor.js';
import { renderPlayText, playSearchText, playTextPreview } from './play-render.js';
import { playChatTitle } from './play-history.js';
import { favoriteFirstLine, favoriteSourceKey } from './play-favorites-view.js';
import { setupPlayReplyHeaderActions, createPlayFloorIcon, createPlayReplyActions, renderPlayReply, showPlayReplyStop, syncPlayReplyFooter, updatePlayReplyCount, createPlayInputSizer, createPlayResultMenu, createPlayMessageTop, playMessageNeedsTop, scrollPlayMessageToTop, revealPlayEditor, placePlayEditorActions } from './play-message-ui.js';
import { readPlayElementPosition, restorePlayElementPosition } from './play-reading-position.js';

const activePhases = new Set(['preparing', 'generating', 'retry-wait']);
const pad = value => String(value).padStart(2, '0');
export function playRecentTime(value) {
    const date = new Date(value), now = new Date(), yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const day = date.toDateString() === now.toDateString() ? '今天' : date.toDateString() === yesterday.toDateString() ? '昨天'
        : `${date.getFullYear() === now.getFullYear() ? '' : pad(date.getFullYear() % 100) + '/'}${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
    return { day, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
}

/** Directory owns its list; only one branch transcript is mounted at a time. */
export function createPlayChatView(ctx, settings, playground, promptFavorites, {
    notify, onOpen, onBranch, onCharacter, onClose, onDelete, onInspectPrompt, onBrowsing, getReadingInset = () => 0, onProgrammaticScroll = () => {},
    messageEditing,
}) {
    const mobile = matchMedia('(max-width: 760px)');
    const page = element('div', undefined, 'play-page play-history-page');
    const directory = element('div', undefined, 'play-history-directory');
    const searchLine = element('div', undefined, 'play-history-search');
    const search = element('input'); search.type = 'search'; search.placeholder = '搜索此角色的聊天…'; search.setAttribute('aria-label', '搜索历史记录');
    const searchToggle = iconButton('search', '搜索历史记录', () => {
        searchOpen = !searchOpen; updateSearch(); if (searchOpen) search.focus({ preventScroll: true });
    });
    const searchBox = element('label', undefined, 'tea-search-box'); searchBox.append(glyph('search'), search);
    searchLine.append(element('h2', '历史记录'), searchToggle, searchBox);
    const list = element('div', undefined, 'tea-scroll play-history-list'); list.setAttribute('aria-label', '聊天历史目录');
    directory.append(searchLine, list);
    const branchPage = element('div', undefined, 'play-page play-branch-page'); branchPage.hidden = true;
    const heading = element('header', undefined, 'play-chat-heading');
    const headingInner = element('div', undefined, 'play-chat-heading-inner');
    const title = element('h2', '', 'play-chat-name'), titleName = element('span', '', 'play-chat-title-text');
    const titleBranch = element('span', '', 'play-chat-title-branch');
    title.append(titleName, titleBranch);
    const close = iconButton('close', '关闭聊天页面', () => onClose()); close.classList.add('play-chat-close');
    headingInner.append(title, close); heading.append(headingInner);
    const readingArea = element('div', undefined, 'play-reading-area');
    const feed = element('div', undefined, 'tea-scroll play-feed play-chat-feed'); feed.setAttribute('aria-label', '分支对话');
    const content = element('div', undefined, 'play-feed-content'); feed.append(content);
    const jump = iconButton('bottom', '跳到最新消息', jumpToLatest); jump.classList.add('play-jump-latest'); jump.hidden = true;
    readingArea.append(feed, jump);
    const compose = element('div', undefined, 'play-compose'), inner = element('div', undefined, 'play-compose-inner');
    const menu = element('details', undefined, 'play-chat-menu');
    const summary = element('summary', undefined, 'tea-icon'); summary.append(glyph('menu')); summary.setAttribute('aria-label', '聊天操作'); summary.setAttribute('role', 'button');
    const menuItems = element('div', undefined, 'tea-sort-menu'); menu.append(summary, menuItems);
    const inputRow = element('div', undefined, 'play-input-row');
    const input = element('textarea', undefined, 'play-compose-input'); input.rows = 1; input.placeholder = '接着剧情继续聊…'; input.setAttribute('aria-label', '分支聊天输入');
    const send = iconButton('send', '发送消息', () => void sendDraft()); send.classList.add('play-send'); send.dataset.icon = 'send';
    inputRow.append(menu, input, send); inner.append(inputRow); compose.append(inner);
    const deleteControls = element('div', undefined, 'play-delete-controls'); deleteControls.hidden = true;
    const deleteDescription = element('span'), confirmDelete = textButton('确认删除', () => void confirmMessageDeletion());
    deleteControls.append(deleteDescription, confirmDelete, textButton('取消', () => setDeletionMode(null)));
    branchPage.append(heading, readingArea, compose, deleteControls); page.append(directory, branchPage);
    let characters = [], selected, chat, visible = false, route = 'history', browsing = false;
    let searchOpen = false, queryTimer, queryId = 0, directoryId = 0, openId = 0, reloadId = 0, loading = false, mutating = false, panel;
    let deletingFrom = null, restoring = false, renderFrame, inputFrame, inputComposing = false, restoreFrame = 0;
    let suspended = false, resumeNeedsRender = false, chatUnavailable = false;
    const versionMenu = createPlayResultMenu();
    const inputSizer = createPlayInputSizer({ input, compose, page: branchPage, isVisible: () => visible && route === 'chat' && !compose.hidden,
        isComposing: () => inputComposing });
    let rows = [], limit = 24, start = 0, end = 0, favorites = new Map(), chatFavorite;
    const rowViews = new Map(), directoryRecords = new Map(), displayCache = new Map(), positions = new Map(), directories = new Map(), drafts = new Map();
    const pendingDrafts = new Map();
    const editingSession = (id = chat?.id) => messageEditing.find('chat', id);
    const messageViews = new Map();
    const replyViews = new WeakMap();
    const cacheWeight = new WeakMap();
    function canLeave({ ignoreEditing = false } = {}) { return !mutating && (ignoreEditing || !messageEditing.busy); }
    menu.addEventListener('focusout', event => { if (!menu.contains(event.relatedTarget)) menu.open = false; });
    function cacheEntry(cache, key, value) {
        const weight = entry => entry?.messages ? entry.messages.reduce((size, message) => size + (message.text?.length ?? 0), 0)
            : (entry?.raw?.length ?? 0) + (entry?.text?.length ?? 0);
        let size = (cacheWeight.get(cache) ?? 0) - weight(cache.get(key));
        cache.delete(key); cache.set(key, value); size += weight(value);
        while (cache.size > (cache === directoryRecords ? 32 : 240) || size > 2 * 1024 * 1024) {
            const first = cache.keys().next().value; size -= weight(cache.get(first)); cache.delete(first);
        }
        cacheWeight.set(cache, size);
    }
    const picker = createPlayCharacterPicker(ctx, {
        getCharacters: () => characters, getSelected: () => selected, isVisible: () => visible && (!mobile.matches || browsing),
        onSelect: character => void chooseCharacter(character), onBack: () => setBrowsing(false), backLabel: '返回历史记录',
        renderMeta(character) {
            if (!character.lastPlayedAt) return null;
            const recent = playRecentTime(character.lastPlayedAt), time = element('time', undefined, 'play-person-time'); time.dateTime = character.lastPlayedAt;
            time.append(element('span', recent.day, 'play-person-date'), element('small', recent.time, 'play-person-clock')); return time;
        }, signatureExtra: character => character.lastPlayedAt,
    });
    const chooseButton = iconButton('people', '选择角色', () => setBrowsing(true));
    try {
        const saved = JSON.parse(ctx().accountStorage?.getItem('teahouse-play-chat-drafts-v1') ?? 'null');
        for (const [id, text] of saved?.drafts ?? []) if (typeof id === 'string' && typeof text === 'string') drafts.set(id, text);
    } catch (error) { notify(error.message); }
    let draftTimer;
    function saveDrafts() {
        clearTimeout(draftTimer);
        try { ctx().accountStorage?.setItem('teahouse-play-chat-drafts-v1', JSON.stringify({ drafts: [...drafts].filter(([, text]) => text) })); }
        catch (error) { notify(`草稿暂未保存：${error.message}`); }
    }
    const owner = () => characters.find(character => character.id === chat?.characterId) ?? selected;
    const target = () => ({ characterId: chat.characterId, character: { avatar: owner()?.avatar, name: owner()?.name } });
    const ownJobs = (jobs = playground.getStates()) => jobs.filter(job => (job.roundId ?? job.requestedRoundId) === chat?.id);
    const writeBlocked = () => !chat || chatUnavailable || mutating || loading || settings.enabled === false || messageEditing.busy;
    const busy = (jobs = ownJobs()) => writeBlocked() || !!editingSession() || jobs.length > 0 || chat.messages.some(message => playMessageIsPending(message));
    const canWrite = () => settings.enabled !== false && !!ctx().characters?.some(character => character.avatar === owner()?.avatar);
    const currentResult = message => message.results?.find(result => result.id === message.selectedResultId);
    function messagePermissions(message, jobs = ownJobs()) {
        const result = currentResult(message), session = editingSession(), editing = session?.messageId === message.id;
        const idle = deletingFrom === null && !writeBlocked() && !editing && !playMessageIsPending(message, jobs);
        const index = message.results?.indexOf(result), last = chat.messages.at(-1)?.id === message.id, chatIdle = deletingFrom === null && !busy(jobs);
        const copiesEditor = !!session && chat.messages.findIndex(item => item.id === session.messageId) <= chat.messages.indexOf(message);
        return { inspect: deletingFrom === null && !chatUnavailable, more: deletingFrom === null && !chatUnavailable, edit: idle, remove: idle, visibility: idle, branch: idle && !copiesEditor,
            favorite: idle && !!(result?.text ?? message.text)?.trim(),
            previous: chatIdle && index > 0, choose: chatIdle,
            next: chatIdle && (index < (message.results?.length ?? 0) - 1 || canWrite()),
            again: !writeBlocked() && !editing && chatIdle && canWrite(),
            continue: chatIdle && canWrite() && !!result?.text?.trim() && !message.hidden && last };
    }
    function menuPermission(action, jobs = ownJobs()) {
        if (action === 'rename') return !writeBlocked();
        if (action === 'hidden') return !writeBlocked() && !editingSession();
        return !busy(jobs);
    }
    function syncPermissions(jobs = playground.getStates()) {
        if (!chat) return;
        const active = ownJobs(jobs);
        for (const message of chat.messages) {
            const view = messageViews.get(message.id);
            if (!view) continue;
            const permissions = messagePermissions(message, active);
            for (const button of view.node.querySelectorAll('[data-chat-action]')) button.disabled = !permissions[button.dataset.chatAction];
            if (view.reply) view.reply.stop.disabled = deletingFrom !== null;
            if (view.finish) view.finish.disabled = deletingFrom !== null || mutating || settings.enabled === false;
        }
        for (const button of menuItems.children) button.disabled = !menuPermission(button.dataset.chatAction, active);
    }
    function processed(message, result = currentResult(message)) {
        const text = result?.text ?? message.text;
        const depth = messageDepths.get(message);
        const key = `${message.id}/${result?.id ?? ''}/${result?.bodyRevision ?? message.bodyRevision}/${playground.display?.revision ?? 0}/${depth}`;
        const cached = displayCache.get(key);
        if (cached?.raw === text) return cached.text;
        const rendered = playground.display?.process(text, owner(), result?.context, message.role, depth) ?? text;
        cacheEntry(displayCache, key, { raw: text, text: rendered });
        return rendered;
    }
    function setBrowsing(value) {
        browsing = value; page.classList.toggle('is-browsing-characters', mobile.matches && browsing);
        if (panel && panel.classList.contains('play-choosing-character') !== (mobile.matches && browsing)) panel.classList.toggle('play-choosing-character', mobile.matches && browsing);
        picker.node.classList.toggle('is-mobile-open', browsing); chooseButton.setAttribute('aria-pressed', String(browsing));
        picker.render();
        onBrowsing?.(browsing);
        if (!browsing && resumeNeedsRender && visible) { resumeNeedsRender = false; void (route === 'history' ? refreshDirectory(false) : reload()); }
    }
    function updateSearch() {
        searchBox.hidden = mobile.matches && !searchOpen && !search.value;
        searchToggle.hidden = !mobile.matches;
        searchToggle.setAttribute('aria-expanded', String(!searchBox.hidden));
    }
    function saveDirectory() {
        if (selected && route === 'history' && visible) directories.set(playCharacterKey(selected), { rows, query: search.value, searchOpen, scroll: list.scrollTop, limit });
    }
    async function chooseCharacter(character) {
        if (!canLeave()) return;
        saveDirectory(); remember(); captureEditor(); openId++; queryId++; directoryId++; loading = false; closeVersions(); selected = character; chat = null;
        deletingFrom = null;
        route = 'history'; showRoute(); setBrowsing(false);
        const saved = directories.get(playCharacterKey(character));
        rows = saved?.rows ?? []; search.value = saved?.query ?? ''; searchOpen = saved?.searchOpen ?? false; limit = saved?.limit ?? 24;
        updateSearch(); picker.render(); onCharacter?.(character);
        await refreshDirectory(false); list.scrollTop = saved?.scroll ?? 0;
    }
    async function refreshCharacters(sort = true, isCurrent = () => true) {
        const saved = await playground.listCharacters();
        if (!isCurrent()) return false;
        const next = mergePlayCharacters(saved, ctx().characters);
        if (!sort) {
            const order = new Map(characters.map((character, index) => [playCharacterKey(character), index]));
            next.sort((a, b) => (order.get(playCharacterKey(a)) ?? Infinity) - (order.get(playCharacterKey(b)) ?? Infinity));
        }
        characters = next;
        if (!selected) {
            const current = ctx().characters?.[ctx().characterId];
            selected = characters.find(character => character.avatar === current?.avatar) ?? characters[0];
        } else selected = characters.find(character => selected.id && character.id === selected.id)
            ?? characters.find(character => selected.avatar && character.avatar === selected.avatar) ?? selected;
        picker.render();
        return true;
    }
    async function refreshDirectory(sort = true) {
        if (!visible) { resumeNeedsRender = true; return; }
        const id = ++directoryId;
        try {
            if (!await refreshCharacters(sort, () => id === directoryId && route === 'history')) return;
            const next = selected?.id ? await playground.listChats(selected.id) : [];
            if (id !== directoryId) return;
            if (sort) rows = next;
            else {
                const order = new Map(rows.map((row, index) => [row.id, index]));
                rows = next.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
            }
            await playground.display?.ensure(selected);
            if (id !== directoryId || route !== 'history' || !visible) return;
            await renderDirectory();
        } catch (error) { if (id === directoryId && visible && route === 'history') showError(list, error, () => refreshDirectory(sort)); else resumeNeedsRender = true; }
    }
    function showError(container, error, retry) {
        container.replaceChildren(element('p', error.message, 'play-result-error'), textButton('重新读取', () => void retry()));
    }
    async function renderDirectory() {
        const id = ++queryId, term = search.value.trim().toLocaleLowerCase(), matching = [];
        updateSearch();
        const count = term ? rows.length : Math.min(rows.length, limit);
        if (!visible || mobile.matches && browsing) { resumeNeedsRender = true; return; }
        const placeholders = rows.slice(0, count).map(row => ({ ...row, name: row.name || '未命名聊天', preview: rowViews.get(row.id)?.row.preview ?? '' }));
        if (!term) publishDirectory(placeholders, term, count);
        const read = await playground.createChatDirectoryReader?.();
        const pending = new Map();
        let requested = 0;
        const prepare = () => {
            if (id !== queryId || !visible || route !== 'history' || mobile.matches && browsing) return;
            while (requested < count && pending.size < 4) {
                const index = requested++, row = rows[index], key = `${row.id}/${!!term}`, cached = directoryRecords.get(key);
                const result = cached?.revision === row.revision ? Promise.resolve(cached)
                    : read ? read(row.id, { search: !!term }) : term ? playground.getChatSearch(row.id) : playground.getChatPreview(row.id);
                pending.set(index, result.then(record => ({ record }), error => ({ error })));
            }
        };
        prepare();
        for (let index = 0; index < count; index++) {
            if (id !== queryId || route !== 'history' || !visible || mobile.matches && browsing) return;
            const row = rows[index];
            try {
                const recordKey = `${row.id}/${!!term}`;
                const result = await pending.get(index); pending.delete(index); prepare();
                if (result.error) throw result.error;
                const record = result.record; cacheEntry(directoryRecords, recordKey, record);
                if (id !== queryId) return;
                const name = record.name, ai = [...record.messages].reverse().find(message => message.role === 'assistant');
                const character = selected;
                const displayText = (message, result) => playground.display?.process(result?.text ?? message.text, character, result?.context, message.role, message.depth) ?? result?.text ?? message.text;
                const preview = ai ? favoriteFirstLine(displayText(ai)) : '暂无消息';
                let matchMessageId;
                if (term) {
                    let checked = 0;
                    for (const message of record.messages) {
                        if (id !== queryId || route !== 'history') return;
                        const result = null, key = `${record.id}/${message.messageId}/${message.resultId ?? ''}/${message.bodyRevision}/${playground.display?.revision ?? 0}/${message.depth}`;
                        let cached = displayCache.get(key);
                        if (!cached || cached.raw !== (result?.text ?? message.text)) {
                            cached = { raw: result?.text ?? message.text, text: playSearchText(displayText(message, result)).toLocaleLowerCase() };
                            cacheEntry(displayCache, key, cached);
                        }
                        if (cached.text.includes(term)) { matchMessageId = message.messageId ?? (message.role === 'user' ? 'initial-user' : 'initial-assistant'); break; }
                        if (++checked % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
                    }
                    if (!name.toLocaleLowerCase().includes(term) && !matchMessageId) continue;
                }
                matching.push({ ...row, name, preview, matchMessageId });
            } catch (error) { matching.push({ ...row, name: row.name || '聊天读取失败', preview: error.message }); }
            if (id !== queryId || !visible || route !== 'history') return;
            if (!term || index % 4 === 3) publishDirectory(term ? matching : [...matching, ...placeholders.slice(index + 1)], term, count);
            if (index % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (id !== queryId) return;
        publishDirectory(matching, term, count);
    }
    function publishDirectory(matching, term, count) {
        const nodes = matching.map(row => {
            let view = rowViews.get(row.id);
            if (!view) {
                const node = element('div', undefined, 'play-history-row'); node.dataset.chatId = row.id;
                const button = textButton('', () => onOpen(view.row.id, view.row.matchMessageId)); button.className = 'play-history-open';
                const text = element('span', undefined, 'play-history-copy'), name = element('strong'), preview = element('span', undefined, 'play-history-preview');
                const time = element('time', undefined, 'play-person-time'); text.append(name, preview); button.append(text, time);
                const tools = element('div', undefined, 'play-history-actions');
                const rename = iconButton('edit', '修改聊天名称', () => void renameChat(view.row));
                const remove = iconButton('trash', '删除该聊天', () => void deleteChat(view.row)); tools.append(rename, remove);
                node.append(button, tools);
                view = { node, button, name, preview, time, rename, remove }; rowViews.set(row.id, view);
            }
            view.row = row; view.name.textContent = row.name; view.preview.textContent = row.preview;
            view.button.disabled = mutating;
            view.rename.disabled = view.remove.disabled = mutating || settings.enabled === false;
            const recent = playRecentTime(row.lastPlayedAt); view.time.dateTime = row.lastPlayedAt;
            view.time.replaceChildren(element('span', recent.day, 'play-person-date'), element('small', recent.time, 'play-person-clock'));
            return view.node;
        });
        if (!nodes.length) nodes.push(element('p', term ? '没有找到符合条件的聊天。' : '这个角色还没有演出记录。', 'play-empty-title'));
        if (!term && count < rows.length) nodes.push(textButton('显示更多历史记录', () => { limit += 24; void renderDirectory(); }));
        const scroll = list.scrollTop; list.replaceChildren(...nodes); list.scrollTop = scroll;
        const currentIds = new Set(rows.map(row => row.id));
        for (const [key, view] of rowViews) if (!currentIds.has(key)) { view.node.remove(); rowViews.delete(key); }
    }
    search.addEventListener('input', event => {
        queryId++; clearTimeout(queryTimer);
        if (!event.isComposing) queryTimer = setTimeout(() => void renderDirectory(), 150);
    });
    search.addEventListener('compositionend', () => { clearTimeout(queryTimer); void renderDirectory(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void renderDirectory(); } });
    function position(followBottom = !editingSession()) {
        const bottom = followBottom && feed.scrollHeight - feed.clientHeight - feed.scrollTop < 32;
        if (bottom) return { bottom: true };
        const top = feed.getBoundingClientRect().top + getReadingInset();
        const messages = [...content.querySelectorAll(':scope > [data-message-id]')];
        let low = 0, high = messages.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (messages[middle].getBoundingClientRect().bottom > top + 1) high = middle;
            else low = middle + 1;
        }
        const message = messages[low], anchors = message ? [...message.querySelectorAll('[data-read-anchor]')] : [];
        low = 0; high = anchors.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (anchors[middle].getBoundingClientRect().bottom > top + 1) high = middle;
            else low = middle + 1;
        }
        const anchor = anchors[low] ?? message;
        return { bottom, anchor: anchor?.dataset.readAnchor ?? anchor?.dataset.messageId,
            messageId: anchor?.closest('[data-message-id]')?.dataset.messageId,
            offset: anchor ? anchor.getBoundingClientRect().top - top : 0, scrollTop: feed.scrollTop };
    }
    function remember() { if (chat && route === 'chat' && visible && feed.clientHeight && !restoring) positions.set(chat.id, position()); }
    function captureEditor() {
        const session = editingSession();
        if (session?.editor.input.getClientRects().length) session.state = session.editor.capture();
    }
    function setFeedScroll(value) {
        feed.scrollTop = value; onProgrammaticScroll(feed);
    }
    function updateReadingControls() {
        const height = feed.clientHeight - getReadingInset();
        const hidden = !visible || route !== 'chat' || !chat || deletingFrom !== null || height <= 0
            || (end >= chat.messages.length && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= height);
        const updates = [];
        for (const node of content.querySelectorAll('[data-message-id]')) {
            const top = node.querySelector('.play-message-top');
            if (!top) continue;
            const session = editingSession(), editor = session?.messageId === node.dataset.messageId ? session.editor : null;
            const hidden = !playMessageNeedsTop(node.querySelector('.play-results,.play-user-text'), node.querySelector('.play-message-meta'), height, editor);
            top.disabled = deletingFrom !== null;
            if (top.hidden !== hidden) updates.push({ top, hidden });
        }
        if (jump.hidden !== hidden) jump.hidden = hidden;
        for (const { top, hidden } of updates) top.hidden = hidden;
        for (const node of content.querySelectorAll('.play-assistant-message')) {
            const view = replyViews.get(node);
            if (view && !view.actions.querySelector('button:not(.tea-icon):not(.play-count)')) {
                syncPlayReplyFooter(view);
            }
        }
        for (const view of messageViews.values()) if (view.userTop) view.userActions.hidden = view.userTop.hidden;
    }
    function jumpToMessage(node) {
        if (deletingFrom !== null) return;
        const session = editingSession();
        scrollPlayMessageToTop(feed, node, getReadingInset(), setFeedScroll, session?.messageId === node.dataset.messageId ? session.editor : null);
        remember(); updateReadingControls();
    }
    async function loadRange(nextStart, nextEnd, saved, latest = false) {
        if (!chat || loading) return;
        const id = chat.id, request = openId, refresh = ++reloadId;
        loading = true; updateInput();
        try {
            const result = await playground.getChatWindow(id, { start: nextStart, end: nextEnd, latest });
            if (request !== openId || refresh !== reloadId || chat?.id !== id) return;
            chat = result.chat; start = result.start; end = result.end;
            if (visible && route === 'chat') renderChat(saved);
            else if (suspended) resumeNeedsRender = true;
        } catch (error) { if (request === openId) notify(error.message); }
        finally { if (request === openId) { loading = false; updateInput(); syncPermissions(); } }
    }
    function jumpToLatest() {
        if (!chat) return;
        positions.set(chat.id, { bottom: true });
        void loadRange(0, 0, { bottom: true }, true);
    }
    function restore(saved, targetId, immediate = false) {
        cancelAnimationFrame(restoreFrame);
        restoring = true;
        const apply = () => {
            if (!visible || route !== 'chat') { restoring = false; return; }
            if (targetId) {
                const target = content.querySelector(`[data-message-id="${CSS.escape(targetId)}"]`);
                if (target) restorePlayElementPosition(feed, target, 0, getReadingInset(), setFeedScroll);
            }
            else if (!saved || saved.bottom) setFeedScroll(feed.scrollHeight);
            else {
                const anchor = [...content.querySelectorAll('[data-read-anchor], [data-message-id]')]
                    .find(node => node.dataset.readAnchor === saved.anchor || node.dataset.messageId === saved.anchor);
                if (anchor) restorePlayElementPosition(feed, anchor, saved.offset, getReadingInset(), setFeedScroll);
                else if (saved.scrollTop !== undefined) setFeedScroll(saved.scrollTop);
            }
            restoring = false; remember(); updateReadingControls();
        };
        // Opening a page waits for its layout; streaming and observed size
        // changes already have a measurable layout and must restore before paint.
        if (immediate) apply(); else restoreFrame = requestAnimationFrame(apply);
    }
    function messageHeader(message) {
        const index = chat.messages.findIndex(item => item.id === message.id);
        const identity = message.role === 'user' ? playChatMessageIdentity(chat.messages, message) : owner();
        const head = element('header', undefined, `play-message-meta play-${message.role === 'user' ? 'user' : 'assistant'}-meta`);
        head.append(createCharacterAvatar(ctx, identity ?? { name: '角色', avatar: null }, 'play-message-avatar', message.role === 'user' ? 'persona' : 'avatar'));
        const heading = element('div', undefined, 'play-message-identity');
        const details = element('span', undefined, 'play-message-detail-row');
        const recent = playRecentTime(message.createdAt);
        details.append(element('small', `#${index}`, 'play-floor-number'), element('time', `${recent.day} · ${recent.time}`, 'play-message-time'));
        if (message.hidden) {
            const mark = createPlayFloorIcon('ghost'); mark.classList.add('play-hidden-mark');
            mark.title = '已隐藏，不发送给模型'; mark.removeAttribute('aria-hidden'); mark.setAttribute('aria-label', mark.title); mark.setAttribute('role', 'img');
            details.append(mark);
        }
        heading.append(element('strong', identity?.name ?? '角色', 'play-speaker'), details);
        head.append(heading); return head;
    }
    function renderMessage(message) {
        const session = editingSession(), editing = session?.messageId === message.id;
        let view = messageViews.get(message.id) ?? (editing ? session.view : null);
        if (!view) {
            const node = element('section', undefined, `play-message play-${message.role}-message`);
            node.dataset.messageId = message.id;
            const body = element('div', undefined, message.role === 'user' ? 'play-user-text' : 'play-results');
            const head = messageHeader(message), tools = element('div', undefined, 'play-header-actions');
            const error = element('p', undefined, 'play-result-error'); error.hidden = true;
            view = { node, body, head, tools, error, output: { box: body }, message };
            const edit = iconButton('edit', message.role === 'user' ? '修改用户消息' : '编辑回复原文', () => editMessage(view.message, body));
            const remove = iconButton('trash', message.role === 'user' ? '删除用户消息' : '删除 AI 消息', () => void removeMessage(view.message));
            const visibility = iconButton('eye', '隐藏楼层', () => void run(() => playground.setMessagesHidden(chat.id, [view.message.id], !view.message.hidden, chat.revision)));
            visibility.classList.add('play-floor-visibility');
            const favorite = iconButton('star', message.role === 'user' ? '收藏用户消息' : '收藏演出记录', () => void toggleMessageFavorite(view.message));
            favorite.classList.add('tea-star');
            for (const [button, action] of [[edit, 'edit'], [remove, 'remove'], [visibility, 'visibility'], [favorite, 'favorite']]) button.dataset.chatAction = action;
            Object.assign(view, { edit, remove, visibility, favorite });
            head.append(tools); node.append(head, body);
            if (message.role === 'user') {
                setupPlayReplyHeaderActions(tools, { remove, favorite, edit, visibility, role: 'user' }).dataset.chatAction = 'more';
                view.userTop = createPlayMessageTop(() => jumpToMessage(node));
                view.userActions = element('footer', undefined, 'play-message-actions'); view.userActions.hidden = true;
                view.userActions.append(view.userTop); node.append(view.userActions);
            } else {
                const prompt = iconButton('prompt', '查看实际提示词', () => onInspectPrompt?.(currentResult(view.message).id));
                prompt.classList.add('play-sent-prompt-action'); prompt.hidden = !onInspectPrompt; prompt.dataset.chatAction = 'inspect';
                const branch = iconButton('branch', '创建分支', () => void branchAt(view.message));
                branch.classList.add('play-branch-action'); branch.dataset.chatAction = 'branch';
                setupPlayReplyHeaderActions(tools, { branch, prompt, remove, favorite, edit, visibility }).dataset.chatAction = 'more';
                const reply = createPlayReplyActions({
                    onPrevious: () => void selectVersion(view.message, view.message.results.indexOf(currentResult(view.message)) - 1),
                    onChoose: () => void showVersions(view.message),
                    onNext: () => {
                        const index = view.message.results.indexOf(currentResult(view.message));
                        if (index === view.message.results.length - 1) void generate('another', view.message); else void selectVersion(view.message, index + 1);
                    },
                    onAgain: () => void generate('regenerate', view.message),
                    onContinue: () => void generate('continue', view.message), onStop: () => playground.stop(currentResult(view.message).id), onTop: () => jumpToMessage(node),
                });
                Object.assign(reply, { output: view.output, error }); view.reply = reply; replyViews.set(node, reply);
                for (const [button, action] of [[reply.prev, 'previous'], [reply.count, 'choose'], [reply.next, 'next'], [reply.again, 'again'], [reply.continueBtn, 'continue']]) button.dataset.chatAction = action;
                node.append(reply.actions);
            }
        }
        messageViews.set(message.id, view); view.message = message;
        const { node, body, head, tools, output, error } = view;
        const identity = message.role === 'user' ? playChatMessageIdentity(chat.messages, message) : owner();
        const headerSignature = JSON.stringify([chat.messages.indexOf(message), message.hidden, message.createdAt, identity?.name, identity?.avatar]);
        if (view.headerSignature !== headerSignature) {
            const updated = messageHeader(message); head.replaceChildren(...updated.childNodes, tools); view.headerSignature = headerSignature;
        }
        node.classList.toggle('is-hidden-floor', !!message.hidden);
        view.visibility.title = message.hidden ? '显示楼层' : '隐藏楼层'; view.visibility.setAttribute('aria-label', view.visibility.title);
        view.visibility.replaceChildren(createPlayFloorIcon(message.hidden ? 'eye-slash' : 'eye'));
        const result = currentResult(message);
        updateFavorite(view);
        placePlayEditorActions(tools, view.edit, editing ? session.editor : null);
        if (editing) {
            if (!body.contains(session.editor.body)) { body.replaceChildren(session.editor.body); session.editor.restore(session.state); }
        } else if (message.role === 'user') {
            const text = processed(message);
            if (view.userText !== text || body.querySelector('.play-edit-form')) { renderPlayText(body, text, `${chat.id}/${message.id}`, false, true, { role: 'user' }); view.userText = text; }
        } else renderPlayReply(output, result, { name: owner()?.name, displayText: processed(message, result), job: playground.getState(result.id), error, anchor: `${chat.id}/${message.id}` });
        if (view.reply) {
            const reply = view.reply, last = chat.messages.at(-1)?.id === message.id;
            const index = message.results.indexOf(result), atEnd = index === message.results.length - 1;
            reply.swipes.hidden = reply.again.hidden = !last; reply.continueBtn.hidden = !last || !result.text.trim();
            updatePlayReplyCount(reply.count, index, message.results.length);
            reply.next.title = atEnd ? '生成新版本' : '下一个结果'; reply.next.setAttribute('aria-label', reply.next.title);

            reply.continueBtn.title = message.hidden ? '请先显示此楼层再续写' : '续写';
            reply.stop.hidden = !showPlayReplyStop(playground.getState(result.id), !!session || playground.getStates().filter(job => activePhases.has(job.phase)).length > 1);
            if (result.status === 'unfinished' && !ownJobs().length) {
                if (!view.finish) {
                    view.finish = textButton('结束未完成回复', async () => {
                        const confirmed = await ctx().callGenericPopup(element('p', '保留已经保存的文字，并结束这条未完成回复？如果其他页面仍在生成这条回复，它后续生成的文字将不再保存。'), ctx().POPUP_TYPE.CONFIRM, '', { okButton: '结束回复', cancelButton: '取消' });
                        if (confirmed === ctx().POPUP_RESULT.AFFIRMATIVE) await run(() => playground.finishUnfinishedChat(chat.id));
                    }); reply.actions.append(view.finish);
                }
            } else { view.finish?.remove(); view.finish = null; }
        }
        syncMessageDeletion(view);
        return node;
    }
    function syncMessageDeletion(view) {
        const { node } = view;
        let choose = node.querySelector(':scope > .play-delete-checkbox');
        if (deletingFrom !== null) {
            if (!choose) {
                choose = element('input', undefined, 'play-delete-checkbox'); choose.type = 'checkbox'; node.prepend(choose);
                node.onclick = event => {
                    if (mutating || event.target.closest('.play-header-actions,.play-message-actions')) return;
                    if (event.target !== choose) event.preventDefault();
                    deletingFrom = chat.messages.findIndex(message => message.id === node.dataset.messageId); updateDeletionSelection();
                };
            }
            choose.setAttribute('aria-label', `从第 ${chat.messages.findIndex(message => message.id === node.dataset.messageId) + 1} 条消息删除到最后`);
        } else {
            choose?.remove(); node.onclick = null;
        }
    }
    function setDeletionMode(value) {
        const saved = position();
        deletingFrom = value; closeVersions(false);
        for (const view of messageViews.values()) syncMessageDeletion(view);
        const jobs = playground.getStates();
        syncPermissions(jobs); updateDeletionSelection(); updateInput(jobs); updateReadingControls(); restore(saved);
    }
    function updateFavorite(view) {
        const message = view.message, result = currentResult(message);
        const starred = message.role === 'user' ? promptFavorites?.isFavorite({ prompt: message.text, origin: message.origin })
            : favorites.has(favoriteSourceKey({ roundId: chat.id, resultId: result.id, startedAt: result.startedAt }));
        view.favorite.title = starred ? '取消收藏' : message.role === 'user' ? '收藏用户消息' : '收藏演出记录';
        view.favorite.setAttribute('aria-label', view.favorite.title); view.favorite.setAttribute('aria-pressed', String(!!starred));
    }
    let messageDepths = new Map();
    function renderChat(saved = positions.get(chat?.id), targetId) {
        if (!chat || !visible || route !== 'chat' || mobile.matches && browsing) { resumeNeedsRender = true; return; }
        closeVersions(false);
        messageDepths = playMessageDepths(chat.messages);
        const name = playChatTitle(chat), parts = /^(.*?)\s*·\s*(分支#\d+)$/.exec(name);
        titleName.textContent = parts?.[1] ?? name; titleName.title = name;
        titleBranch.textContent = parts ? `· ${parts[2]}` : ''; titleBranch.hidden = !parts;
        menuItems.replaceChildren();
        menuItems.append(textButton(chatFavorite ? '取消收藏该聊天' : '收藏该聊天', () => void toggleChatFavorite()),
            textButton('隐藏楼层管理', () => void manageHiddenFloors()),
            textButton('修改聊天名称', () => void renameChat(chat)), textButton('删除该聊天', () => void deleteChat(chat)),
            textButton('删除', () => { menu.open = false; setDeletionMode(-1); }));
        for (const [index, action] of ['favorite', 'hidden', 'rename', 'delete', 'truncate'].entries()) menuItems.children[index].dataset.chatAction = action;
        const session = editingSession();
        const nodes = chatUnavailable && session ? [session.view.node] : chat.messages.slice(start, end).map(renderMessage);
        if (session && !chat.messages.some(message => message.id === session.messageId) && !nodes.includes(session.view.node)) nodes.push(session.view.node);
        if (start > 0) nodes.unshift(textButton('显示更早的消息', () => void loadRange(Math.max(0, start - 24), end, position())));
        if (end < chat.messages.length) nodes.push(textButton('显示后面的消息', () => void loadRange(start, Math.min(chat.messages.length, end + 24), position())));
        if (!nodes.length) nodes.push(element('p', '输入内容，开始这段剧情。', 'play-empty-title'));
        const retained = new Set(nodes);
        for (const node of [...content.children]) if (!retained.has(node)) {
            if (node === editingSession()?.view.node) captureEditor();
            node.remove();
        }
        let cursor = content.firstChild;
        for (const node of nodes) {
            if (node !== cursor) content.insertBefore(node, cursor);
            cursor = node.nextSibling;
        }
        const ids = new Set(chat.messages.slice(start, end).map(message => message.id));
        for (const id of messageViews.keys()) if (!ids.has(id) && id !== editingSession()?.messageId) messageViews.delete(id);
        if (session && session.view.node.getClientRects().length && session.state) { session.editor.restore(session.state); session.state = null; }
        const jobs = playground.getStates();
        syncPermissions(jobs); updateDeletionSelection(); updateInput(jobs); restore(saved, targetId);
    }
    function updateDeletionSelection() {
        deleteControls.hidden = deletingFrom === null;
        confirmDelete.disabled = mutating || deletingFrom === null || deletingFrom < 0;
        deleteDescription.textContent = deletingFrom >= 0 && deletingFrom !== null
            ? `将删除所选消息到最后，共 ${chat.messages.length - deletingFrom} 条消息` : '请选择要从哪里开始删除';
        for (const node of content.querySelectorAll('[data-message-id]')) {
            const selected = deletingFrom !== null && deletingFrom >= 0 && chat.messages.findIndex(message => message.id === node.dataset.messageId) >= deletingFrom;
            node.classList.toggle('play-delete-selected', selected);
            const checkbox = node.querySelector('.play-delete-checkbox');
            if (checkbox) checkbox.checked = selected;
        }
    }
    async function confirmMessageDeletion() {
        if (deletingFrom === null || deletingFrom < 0 || mutating) return;
        const message = chat.messages[deletingFrom];
        if (message) await run(() => playground.truncateChat(chat.id, message.id, chat.revision));
    }
    function updateInput(jobs = playground.getStates()) {
        const own = ownJobs(jobs), generating = own.find(job => activePhases.has(job.phase));
        const ownPending = own.length > 0;
        const stopping = ownPending || (!input.value.trim() && jobs.some(job => activePhases.has(job.phase)));
        const icon = stopping ? 'stop' : 'send', label = generating ? '停止这份回复' : ownPending ? '正在保存回复' : stopping ? '停止所有生成' : '发送消息';
        if (send.dataset.icon !== icon) { send.replaceChildren(glyph(icon)); send.dataset.icon = icon; }
        send.title = label; send.setAttribute('aria-label', label);
        send.disabled = stopping ? ownPending && !generating : busy(own) || !canWrite() || !input.value.trim() || !playground.availability({ chatId: chat?.id }).available;
        compose.hidden = deletingFrom !== null;
        input.disabled = settings.enabled === false;
        scheduleInputSizing();
    }
    function scheduleInputSizing() {
        if (inputFrame || !visible || inputComposing) return;
        inputFrame = requestAnimationFrame(() => {
            inputFrame = 0;
            if (!visible || inputComposing) return;
            inputSizer.resize();
        });
    }
    input.addEventListener('input', () => {
        if (!chat) return; drafts.set(chat.id, input.value); clearTimeout(draftTimer); draftTimer = setTimeout(saveDrafts, 300);
        updateInput();
    });
    input.addEventListener('compositionstart', () => { inputComposing = true; cancelAnimationFrame(inputFrame); inputFrame = 0; });
    input.addEventListener('compositionend', () => { inputComposing = false; scheduleInputSizing(); });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && ((event.ctrlKey || event.metaKey) || ctx().shouldSendOnEnter?.())) {
            event.preventDefault(); event.stopPropagation(); void sendDraft();
        }
    });
    feed.addEventListener('scroll', () => { remember(); updateReadingControls(); }, { passive: true });
    const resize = new ResizeObserver(() => {
        if (!visible) return;
        scheduleInputSizing(); updateReadingControls();
        if (!editingSession()) restore(positions.get(chat?.id), undefined, true);
    });
    async function loadFavorites(isCurrent = () => true) {
        const rows = await playground.listFavorites();
        if (!isCurrent()) return;
        favorites = new Map(rows.filter(row => !row.source.type).map(row => [favoriteSourceKey(row.source), row]));
        chatFavorite = rows.find(row => row.source.type === 'chat' && row.source.chatId === chat?.id);
        for (const view of messageViews.values()) updateFavorite(view);
        if (menuItems.firstElementChild) menuItems.firstElementChild.textContent = chatFavorite ? '取消收藏该聊天' : '收藏该聊天';
    }
    async function open(id, targetId) {
        if (chat?.id === id && !editingSession(id)) {
            const request = ++openId, metadata = await playground.getChatMetadata(id);
            if (request !== openId || chat?.id !== id) return;
            const targetIndex = chat.messages.findIndex(message => message.id === targetId);
            if (metadata.revision === chat.revision && (!targetId || targetIndex >= start && targetIndex < end)) {
                route = 'chat'; showRoute(); loading = false; resumeNeedsRender = false;
                if (visible) renderChat(positions.get(id), targetId);
                if (visible) { restore(positions.get(id), targetId); updateInput(); syncPermissions(); }
                return;
            }
        }
        remember(); captureEditor(); saveDirectory(); closeVersions(); queryId++; directoryId++; const request = ++openId; loading = true; chatUnavailable = false;
        deletingFrom = null; chat = null; messageViews.clear(); content.replaceChildren(element('p', '正在读取聊天…'));
        deleteControls.hidden = true; menu.open = false;
        route = 'chat'; showRoute(); input.value = drafts.get(id) ?? '';
        try {
            const saved = positions.get(id), editingMessageId = editingSession(id)?.messageId;
            await playground.ensureChat(id);
            const window = await playground.getChatWindow(id, { anchorId: targetId ?? saved?.messageId ?? editingMessageId,
                latest: !targetId && !!saved?.bottom });
            const next = window.chat;
            if (request !== openId) return;
            if (!await refreshCharacters(false, () => request === openId && route === 'chat')) return;
            chat = next; selected = characters.find(character => character.id === chat.characterId); picker.render();
            await playground.display?.ensure(owner());
            if (request !== openId || route !== 'chat') return;
            void loadFavorites(() => request === openId && route === 'chat').catch(error => notify(error.message));
            if (request !== openId) return;
            if (targetId === 'initial-user' || targetId === 'initial-assistant') {
                targetId = chat.messages.find(message => chat.startMessageIds.includes(message.id)
                    && message.role === (targetId === 'initial-user' ? 'user' : 'assistant'))?.id;
            }
            const index = chat.messages.findIndex(message => message.id === targetId);
            start = window.start; end = window.end;
            loading = false;
            if (!suspended) renderChat(saved, targetId ?? (!saved ? editingMessageId : undefined));
            else if (suspended) resumeNeedsRender = true;
            if (visible) { resize.observe(content); resize.observe(feed); resize.observe(branchPage); }
            if (targetId && index < 0) notify('原回复已删除');
        } catch (error) {
            if (request === openId && visible) {
                const session = editingSession(id);
                if (session) {
                    chat = session.chat; selected = session.character; loading = false; start = 0; end = chat.messages.length; chatUnavailable = true;
                    renderChat(positions.get(id), session.messageId);
                    for (const button of content.querySelectorAll('[data-chat-action]')) button.disabled = true;
                } else showError(content, error, () => open(id, targetId));
            } else resumeNeedsRender = true;
        }
        finally { if (request === openId) { loading = false; updateInput(); } }
    }
    async function reload(render = true) {
        if (!chat) return;
        if (!visible || mobile.matches && browsing) { resumeNeedsRender = true; return; }
        const id = chat.id, request = openId, refresh = ++reloadId, saved = positions.get(id);
        const editingMessageId = editingSession(id)?.messageId;
        const window = await playground.getChatWindow(id, { start, end: Math.max(end, start + 24), latest: !!saved?.bottom,
            anchorId: saved?.messageId ?? editingMessageId });
        const next = window.chat;
        if (request !== openId || refresh !== reloadId || chat?.id !== id) return;
        chat = next; chatUnavailable = false;
        void loadFavorites(() => request === openId && refresh === reloadId && chat?.id === id).catch(error => notify(error.message));
        if (request !== openId || refresh !== reloadId || chat?.id !== id) return;
        start = window.start; end = window.end;
        if (render && visible && route === 'chat') renderChat(editingSession() && !restoring ? position(false) : saved);
        else if (suspended) resumeNeedsRender = true;
    }
    async function run(action) {
        if (mutating) return;
        remember(); mutating = true; updateInput(); syncPermissions(); menu.open = false;
        try { await action(); deletingFrom = null; await reload(false); }
        catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
        finally { mutating = false; if (chat && visible) renderChat(positions.get(chat.id)); }
    }
    async function manageHiddenFloors() {
        if (!menuPermission('hidden')) return;
        menu.open = false;
        const chatId = chat.id;
        const area = element('div', undefined, 'play-hidden-manager');
        let dialogPopup;
        const header = element('header', undefined, 'play-hidden-manager-head');
        const close = iconButton('close', '关闭', () => void dialogPopup?.complete(ctx().POPUP_RESULT.AFFIRMATIVE));
        header.append(element('h3', '隐藏楼层管理'), close);
        const summary = element('dl', undefined, 'play-hidden-summary');
        const latest = element('dd', undefined, 'play-hidden-latest'), ranges = element('dd', undefined, 'play-hidden-ranges');
        for (const [label, value] of [['最新楼层', latest], ['已隐藏', ranges]]) {
            const row = element('div'); row.append(element('dt', label), value); summary.append(row);
        }
        const fields = element('div', undefined, 'play-hidden-range-fields');
        const inputs = ['起始楼层', '结束楼层'].map(name => {
            const label = element('label'), input = element('input', undefined, 'text_pole');
            input.type = 'text'; input.inputMode = 'numeric'; input.pattern = '[0-9]*'; input.autocomplete = 'off'; input.setAttribute('aria-label', name);
            label.append(element('span', name), input); fields.append(label); return input;
        });
        const separator = element('span', '—', 'play-hidden-range-to'); separator.setAttribute('aria-hidden', 'true');
        fields.insertBefore(separator, fields.lastElementChild);
        inputs[0].value = '0';
        const actions = element('div', undefined, 'play-hidden-range-actions');
        const error = element('p', '', 'play-result-error'); error.setAttribute('role', 'alert'); error.hidden = true;
        const update = () => {
            latest.textContent = chat.messages.length ? `#${chat.messages.length - 1}` : '无';
            ranges.textContent = playHiddenRanges(chat.messages) || '无';
            for (const button of actions.children) button.disabled = !chat.messages.length || mutating;
        };
        async function apply(hidden) {
            if (mutating || chat?.id !== chatId) return;
            error.hidden = true;
            const [first, last] = inputs.map(input => /^\d+$/.test(input.value.trim()) ? Number(input.value) : NaN);
            if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first > last || last >= chat.messages.length) {
                error.textContent = '请输入有效的起始、结束楼层整数，且不要超过最新楼层。'; error.hidden = false; return;
            }
            const ids = chat.messages.slice(first, last + 1).map(message => message.id), revision = chat.revision;
            remember(); mutating = true; updateInput(); update();
            for (const input of inputs) input.disabled = true;
            try {
                await playground.setMessagesHidden(chatId, ids, hidden, revision);
                await reload();
            } catch (cause) {
                error.textContent = cause.message; error.hidden = false;
                if (cause.code === 'chat_conflict' || cause.code === 'message_missing') {
                    try { await reload(); } catch { /* Preserve the original operation error. */ }
                }
            } finally {
                mutating = false;
                for (const input of inputs) input.disabled = false;
                if (chat?.id === chatId) { update(); if (visible) renderChat(positions.get(chatId)); }
            }
        }
        actions.append(textButton('隐藏', () => void apply(true)), textButton('显示', () => void apply(false)));
        actions.firstElementChild.prepend(createPlayFloorIcon('eye')); actions.lastElementChild.prepend(createPlayFloorIcon('eye-slash'));
        area.append(header, summary, fields, error, actions);
        update();
        await ctx().callGenericPopup(area, ctx().POPUP_TYPE.TEXT, '', { okButton: false, onClosing: () => !mutating,
            onOpen: popup => {
                dialogPopup = popup; popup.dlg.classList.add('tea-hidden-dialog'); popup.dlg.setAttribute('aria-label', '隐藏楼层管理');
                const source = getComputedStyle(page.closest('.tea-panel-surface'));
                for (const name of ['--tea-paper', '--tea-ink', '--tea-heading', '--tea-muted', '--tea-line', '--tea-accent', '--tea-field-paper', '--tea-control-paper', '--tea-control-ink', '--tea-error', '--tea-ui', '--play-prose-font', '--tea-popup-shadow', 'color-scheme']) {
                    const value = source.getPropertyValue(name); if (value.trim()) popup.dlg.style.setProperty(name, value);
                }
            } });
    }
    async function sendDraft() {
        const job = ownJobs().find(job => activePhases.has(job.phase));
        if (job) { playground.stop(job.resultId); return; }
        if (!input.value.trim()) { playground.stopAll(); return; }
        if (busy() || !canWrite()) return;
        const id = chat.id, text = input.value;
        positions.set(id, { bottom: true }); pendingDrafts.set(id, text);
        try {
            const task = playground.sendChat(id, { ...target(), prompt: text, expectedRevision: chat.revision });
            await task;
        } catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
        finally { if (pendingDrafts.get(id) === text) pendingDrafts.delete(id); }
    }
    async function generate(operation, message) {
        if (busy() || !canWrite()) return;
        const result = currentResult(message), id = chat.id, args = [id, message.id];
        const method = operation === 'another' ? 'generateChatVersion' : operation === 'regenerate' ? 'regenerateChat' : 'continueChat';
        if (operation !== 'another') args.push(result.id);
        args.push({ ...target(), expectedRevision: chat.revision });
        try { await playground[method](...args); }
        catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
    }
    async function branchAt(message) {
        if (!messagePermissions(message).branch) return;
        try { const branch = await playground.createBranch(chat.id, message.id, chat.revision); onBranch(branch); }
        catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
    }
    async function selectVersion(message, index) {
        if (busy() || !message.results[index]) return;
        await run(() => playground.setMessageVersion(chat.id, message.id, message.results[index].id, message.selectedResultId));
    }
    function closeVersions(restore = true) { versionMenu.close(restore); }
    async function showVersions(message) {
        if (!messagePermissions(message).choose) return;
        const view = messageViews.get(message.id), reply = replyViews.get(view?.node);
        if (!reply) return;
        if (message.results.some(result => result.text === undefined)) {
            const id = chat.id, request = openId;
            try {
                const window = await playground.getChatWindow(id, { start, end, versionsFor: message.id });
                if (request !== openId || chat?.id !== id || !visible || !view.node.isConnected
                    || chat.messages.find(item => item.id === message.id) !== message || !messagePermissions(message).choose) return;
                const next = window.chat.messages.find(item => item.id === message.id);
                if (!next || window.chat.revision !== chat.revision) { await reload(); return; }
                chat = window.chat; message = next; view.message = next;
            } catch (error) { notify(error.message); return; }
        }
        versionMenu.toggle({ key: message.id, root: panel, readingArea, feed, opener: reply.count, alignment: view.body,
            selectedId: message.selectedResultId, label: '选择回复版本',
            entries: message.results.map(result => {
                const recent = playRecentTime(result.startedAt);
                return { id: result.id, text: playTextPreview(processed(message, result)), time: `${recent.day} · ${recent.time}` };
            }), onSelect: resultId => void selectVersion(message, message.results.findIndex(result => result.id === resultId)) });
    }
    function editMessage(message) {
        if (!messagePermissions(message).edit) return;
        const id = chat.id, messageId = message.id, resultId = currentResult(message)?.id;
        void messageEditing.open({ key: `chat/${id}/${messageId}/${resultId ?? ''}`, async create() {
            await playground.ensureChat(id);
            let latest = playground.session.currentChat(id);
            let current = latest.messages.find(item => item.id === messageId);
            if (resultId ? current?.results.find(result => result.id === resultId)?.text === undefined : current?.text === undefined) {
                latest = await playground.session.loadMessage(id, messageId, resultId); current = latest.messages.find(item => item.id === messageId);
            }
            const result = current?.results?.find(item => item.id === resultId);
            if (!current || resultId && !result) throw new Error('原回复已删除');
            if (chat?.id !== id || mutating || loading || settings.enabled === false || playMessageIsPending(current, ownJobs())) return null;
            const saved = position(false); chat = latest; chatUnavailable = false;
            const index = chat.messages.indexOf(current); start = Math.min(start, index); end = Math.max(end, index + 1);
            renderChat(saved);
            const view = messageViews.get(messageId), original = result?.text ?? current.text;
            const session = { page: 'chat', id, messageId, role: current.role, resultId, view, chat: latest, character: owner(),
                activate() {
                    closeVersions(false);
                    const saved = { bottom: false, anchor: messageId, messageId,
                        offset: readPlayElementPosition(feed, view.node, getReadingInset()), scrollTop: feed.scrollTop };
                    view.body.replaceChildren(session.editor.body);
                    placePlayEditorActions(view.tools, view.edit, session.editor); session.editor.resize();
                    updateReplyStops(); updateInput(); updateReadingControls(); restore(saved, undefined, true);
                    session.editor.input.focus({ preventScroll: true });
                    revealPlayEditor(feed, session.editor, getReadingInset(), setFeedScroll); remember();
                },
                async finish() {
                    view.userText = undefined; view.output.signature = undefined;
                    if (chat?.id !== id || !visible) { session.editor.actions.remove(); session.editor.body.remove(); view.edit.hidden = false; resumeNeedsRender = true; return; }
                    try {
                        chat = playground.session.currentChat(id);
                        const area = feed.getBoundingClientRect(), box = view.node.getBoundingClientRect();
                        const saved = box.bottom > area.top + getReadingInset() && box.top < area.bottom
                            ? { bottom: false, anchor: messageId, messageId, offset: readPlayElementPosition(feed, view.node, getReadingInset()), scrollTop: feed.scrollTop }
                            : position(false);
                        session.editor.actions.remove();
                        chatUnavailable = false;
                        renderChat(saved); restore(saved, undefined, true);
                    } catch (error) {
                        session.editor.actions.remove(); session.editor.body.remove(); view.node.remove(); chatUnavailable = true;
                        showError(content, error, () => open(id)); if (!playground.session.isSaveError(error)) notify(error.message);
                    }
                },
                async reveal() {
                    if (chat?.id !== id || route !== 'chat') await open(id, messageId);
                    setBrowsing(false);
                    if (session.view.node.getClientRects().length) {
                        session.editor.restore(session.state);
                        const error = session.editor.error.getBoundingClientRect(), area = feed.getBoundingClientRect();
                        if (error.bottom > area.bottom) setFeedScroll(feed.scrollTop + error.bottom - area.bottom);
                        else if (error.top < area.top + getReadingInset()) setFeedScroll(feed.scrollTop + error.top - area.top - getReadingInset());
                    }
                },
            };
            session.editor = createPlayEditor({ text: original, label: current.role === 'user' ? '用户消息原文' : '回复原文',
                onSubmit: () => messageEditing.save(session), onCancel: () => messageEditing.cancel(session),
                onSave: ({ text }) => playground.editMessage(id, messageId, { text, expectedText: original, resultId }),
            });
            return session;
        } });
    }
    async function removeMessage(message) {
        if (!messagePermissions(message).remove) return;
        const confirmed = await ctx().callGenericPopup(element('p', message.role === 'assistant' ? '删除这条 AI 消息及其全部版本？' : '删除这条用户消息？'),
            ctx().POPUP_TYPE.CONFIRM, '', { okButton: '删除消息', cancelButton: '取消' });
        if (confirmed === ctx().POPUP_RESULT.AFFIRMATIVE) await run(() => playground.removeMessage(chat.id, message.id, chat.revision));
    }
    async function toggleMessageFavorite(message) {
        if (!messagePermissions(message).favorite) return;
        if (message.role === 'user') return run(() => promptFavorites.toggle({ prompt: message.text, origin: message.origin }));
        const result = currentResult(message), key = favoriteSourceKey({ roundId: chat.id, resultId: result.id, startedAt: result.startedAt });
        const existing = favorites.get(key), text = processed(message);
        await run(() => existing ? playground.removeFavorite(existing.id) : playground.addFavorite({ roundId: chat.id,
            messageId: message.id, resultId: result.id, startedAt: result.startedAt, expectedText: result.text, text, firstLine: favoriteFirstLine(text) }));
    }
    async function toggleChatFavorite() {
        if (busy()) return;
        await run(() => chatFavorite ? playground.removeFavorite(chatFavorite.id) : playground.favoriteChat(chat.id));
    }
    async function changeChatRecord(record, action) {
        if (mutating) return;
        const characterId = selected?.id, inDirectory = route === 'history', scroll = list.scrollTop;
        mutating = true; menu.open = false;
        if (inDirectory) for (const view of rowViews.values()) view.button.disabled = view.rename.disabled = view.remove.disabled = true;
        else updateInput();
        try {
            await action();
            if (inDirectory && route === 'history' && selected?.id === characterId) { await refreshDirectory(false); list.scrollTop = scroll; }
            else if (chat?.id === record.id && route === 'chat') await reload(false);
        } catch (error) { if (!playground.session.isSaveError(error)) notify(error.message); }
        finally {
            mutating = false;
            if (inDirectory) for (const view of rowViews.values()) {
                view.button.disabled = false; view.rename.disabled = view.remove.disabled = settings.enabled === false;
            }
            else if (chat && visible) renderChat(positions.get(chat.id));
        }
    }
    async function renameChat(record) {
        menu.open = false;
        if (mutating || settings.enabled === false || route === 'chat' && !menuPermission('rename')) return;
        const name = await ctx().callGenericPopup('修改聊天名称', ctx().POPUP_TYPE.INPUT, record.name || '未命名聊天');
        if (typeof name === 'string') await changeChatRecord(record, () => playground.renameChat(record.id, name, record.revision));
    }
    async function deleteChat(record) {
        if (mutating || settings.enabled === false || editingSession(record.id) || route === 'chat' && busy()) return;
        menu.open = false;
        const confirmed = await ctx().callGenericPopup(element('p', '删除整条聊天？已有收藏会保留，聊天将从历史记录移除。'),
            ctx().POPUP_TYPE.CONFIRM, '', { okButton: '删除该聊天', cancelButton: '取消' });
        if (confirmed !== ctx().POPUP_RESULT.AFFIRMATIVE) return;
        const id = record.id, inDirectory = route === 'history';
        await changeChatRecord(record, async () => {
            await playground.deleteChat(id, record.revision);
            drafts.delete(id); positions.delete(id); saveDrafts();
            if (chat?.id === id) chat = null;
        });
        if (!inDirectory && !chat) onDelete(id);
    }
    function updateReplyStops(jobs = playground.getStates()) {
        const multiple = jobs.filter(job => activePhases.has(job.phase)).length > 1;
        for (const node of content.querySelectorAll('.play-assistant-message')) {
            const message = chat?.messages.find(message => message.id === node.dataset.messageId);
            const stop = node.querySelector('.play-stop');
            if (message && stop) stop.hidden = !showPlayReplyStop(jobs.find(job => job.resultId === currentResult(message).id), !!editingSession() || multiple);
        }
    }
    const changedMessages = new Set();
    playground.subscribe(job => {
        const pending = pendingDrafts.get(job.roundId);
        if (job.chatMode && job.operation === 'send' && job.phase === 'preparing' && job.roundId && pending !== undefined) {
            if (drafts.get(job.roundId) === pending) drafts.set(job.roundId, '');
            if (chat?.id === job.roundId && input.value === pending) input.value = '';
            pendingDrafts.delete(job.roundId); saveDrafts();
        }
        if (route !== 'chat' || !chat) return;
        if (visible) { const jobs = playground.getStates(); updateReplyStops(jobs); updateInput(jobs); syncPermissions(jobs); }
        if ((job.roundId ?? job.requestedRoundId) !== chat.id) return;
        const previousLength = chat.messages.length;
        const previousStructure = JSON.stringify(chat.messages.map(message => [message.id, message.selectedResultId, message.results?.map(result => result.id)]));
        if (job.chat) chat = job.chat;
        const added = chat.messages.length > previousLength;
        const structureChanged = previousStructure !== JSON.stringify(chat.messages.map(message => [message.id, message.selectedResultId, message.results?.map(result => result.id)]));
        if (added) { start = Math.max(0, chat.messages.length - 24); end = chat.messages.length; }
        const message = chat.messages.find(message => message.results?.some(result => result.id === job.resultId));
        const result = message?.results.find(result => result.id === job.resultId);
        if (added && visible) { renderChat({ bottom: true }); restore({ bottom: true }, undefined, true); }
        else if (structureChanged && visible) renderChat(position(false));
        if (suspended && result) resumeNeedsRender = true;
        if (!visible || mobile.matches && browsing) return;
        if (message) {
            changedMessages.add(message.id);
            const previous = chat.messages[chat.messages.indexOf(message) - 1];
            if (previous?.role === 'user') changedMessages.add(previous.id);
        }
        if (job.userMessageId) changedMessages.add(job.userMessageId);
        if (renderFrame) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = 0; if (!visible || !chat || mobile.matches && browsing) return;
            const saved = positions.get(chat.id);
            for (const message of chat.messages) if (changedMessages.has(message.id) && messageViews.has(message.id)) renderMessage(message);
            changedMessages.clear();
            const jobs = playground.getStates();
            syncPermissions(jobs); updateInput(jobs); updateReadingControls(); if (!editingSession() && saved?.bottom) restore(saved, undefined, true);
        });
    });
    window.addEventListener('pagehide', saveDrafts);
    function showRoute() {
        page.dataset.route = route;
        if (route === 'chat' && branchPage.hidden) branchPage.hidden = false;
        branchPage.style.zIndex = route === 'chat' ? '1' : '0';
        branchPage.setAttribute('aria-hidden', String(route !== 'chat'));
        directory.hidden = route === 'chat';
    }
    return {
        page, browser: picker.node, chooseButton, open, get route() { return route; }, get selected() { return selected; }, get chatId() { return chat?.id; },
        get suspended() { return suspended; },
        async showDirectory(character, sort = true) {
            closeVersions(false);
            remember(); captureEditor(); openId++; loading = false; route = 'history'; showRoute(); menu.open = false; deletingFrom = null;
            deleteControls.hidden = true;
            if (character) selected = character;
            const saved = directories.get(playCharacterKey(selected));
            search.value = saved?.query ?? ''; searchOpen = saved?.searchOpen ?? false; limit = saved?.limit ?? 24;
            if (saved?.rows) rows = saved.rows;
            await refreshDirectory(sort); list.scrollTop = saved?.scroll ?? 0; picker.render();
        },
        activate(container) {
            panel = container; visible = true; suspended = false; setBrowsing(browsing); updateSearch(); picker.render();
            if (route === 'chat') { resize.observe(content); resize.observe(feed); resize.observe(branchPage); scheduleInputSizing(); restore(positions.get(chat?.id)); }
            if (resumeNeedsRender) { resumeNeedsRender = false; void this.refresh(); }
        },
        prepareActivation() {
            if (visible || suspended || !chat) return;
            const saved = positions.get(chat.id), index = chat.messages.findIndex(message => message.id === saved?.messageId);
            const nextStart = saved?.bottom || index < 0 ? Math.max(0, chat.messages.length - 24) : Math.max(0, index - 12);
            const nextEnd = Math.min(chat.messages.length, nextStart + 24);
            for (const [id, view] of messageViews) if (!chat.messages.slice(nextStart, nextEnd).some(message => message.id === id) && !view.node.querySelector('iframe,.play-edit-form')) { view.node.remove(); messageViews.delete(id); }
            start = nextStart; end = nextEnd; resumeNeedsRender = true;
        },
        suspend() {
            remember(); captureEditor(); saveDirectory(); closeVersions(false); visible = false; suspended = true;
            if (route === 'history') { resumeNeedsRender = true; directoryId++; queryId++; }
            cancelAnimationFrame(inputFrame); inputFrame = 0; cancelAnimationFrame(renderFrame); renderFrame = 0;
            changedMessages.clear();
            resize.disconnect(); picker.suspend();
        },
        resume(container, { displayChanged = false, checkData = false } = {}) {
            panel = container; visible = true; suspended = false; picker.render();
            if (route === 'chat') {
                resize.observe(content); resize.observe(feed); resize.observe(branchPage);
                if (resumeNeedsRender || checkData) void reload();
                else if (displayChanged) renderChat(positions.get(chat?.id));
                else { scheduleInputSizing(); renderChat(positions.get(chat?.id)); }
            } else if (displayChanged || resumeNeedsRender || checkData) void refreshDirectory(false);
            resumeNeedsRender = false;
        },
        deactivate() { remember(); captureEditor(); saveDirectory(); saveDrafts(); closeVersions(); visible = false; suspended = false;
            directoryId++; queryId++;
            cancelAnimationFrame(inputFrame); inputFrame = 0; cancelAnimationFrame(renderFrame); renderFrame = 0; changedMessages.clear(); resize.disconnect(); picker.suspend(); },
        close() { this.deactivate(); panel = null; page.remove(); picker.node.remove(); },
        async refresh() {
            if (!visible || mobile.matches && browsing) { resumeNeedsRender = true; return; }
            if (route === 'history') await refreshDirectory(false);
            else {
                await playground.display?.ensure(owner());
                await reload();
            }
        },
        canLeave, updateEditing() { syncPermissions(); updateInput(); },
        prepareLayout() { closeVersions(false); remember(); captureEditor(); },
    };
}
