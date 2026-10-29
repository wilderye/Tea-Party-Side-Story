import { element, textButton, iconButton, glyph } from './ui.js';
import { createPlayCharacterPicker, createCharacterAvatar } from './play-character-picker.js';
import { createPlayEditor } from './play-editor.js';
import { renderPlayText, playSearchText } from './play-render.js';
import { playChatTitle } from './play-history.js';
import { favoriteFirstLine, favoriteSourceKey } from './play-favorites-view.js';
import { createPlayReplyActions, renderPlayReply, showPlayReplyStop, syncPlayReplyFooter, updatePlayReplyCount, createPlayInputSizer } from './play-message-ui.js';

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
    notify, onOpen, onBranch, onCharacter, onDelete, onInspectPrompt, getReadingInset = () => 0, onProgrammaticScroll = () => {},
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
    const title = element('h2', '', 'play-chat-name');
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
    const send = iconButton('send', '发送消息', () => void sendDraft()); send.classList.add('play-send');
    inputRow.append(menu, input, send); inner.append(inputRow); compose.append(inner);
    branchPage.append(title, readingArea, compose); page.append(directory, branchPage);
    let characters = [], selected, chat, visible = false, route = 'history', browsing = false;
    let searchOpen = false, queryTimer, queryId = 0, directoryId = 0, openId = 0, reloadId = 0, loading = false, mutating = false, panel;
    let editor, deletingFrom = null, restoring = false, renderFrame, versionMenu, inputFrame, inputComposing = false;
    const inputSizer = createPlayInputSizer({ input, compose, page: branchPage, isVisible: () => visible && route === 'chat' && !compose.hidden,
        isComposing: () => inputComposing });
    let rows = [], limit = 24, start = 0, end = 0, favorites = new Map(), chatFavorite;
    const rowViews = new Map(), directoryRecords = new Map(), displayCache = new Map(), positions = new Map(), directories = new Map(), drafts = new Map();
    const pendingDrafts = new Map();
    const replyViews = new WeakMap();
    const cacheWeight = new WeakMap();
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
    const ownJobs = () => playground.getStates().filter(job => (job.roundId ?? job.requestedRoundId) === chat?.id);
    const busy = () => !chat || mutating || loading || ownJobs().length > 0 || chat.messages.some(message => message.results?.some(result => result.status === 'unfinished'));
    const canWrite = () => settings.enabled !== false && !!ctx().characters?.some(character => character.avatar === owner()?.avatar);
    const currentResult = message => message.results?.find(result => result.id === message.selectedResultId);
    function branchDisabled(message) {
        const result = currentResult(message);
        return mutating || result.status === 'unfinished' || ownJobs().some(job => job.resultId === result.id) || settings.enabled === false;
    }
    function processed(message, result = currentResult(message)) {
        const text = result?.text ?? message.text;
        const key = `${message.id}/${result?.id ?? ''}/${result?.bodyRevision ?? message.bodyRevision}/${playground.display?.revision ?? 0}`;
        const cached = displayCache.get(key);
        if (cached?.raw === text) return cached.text;
        const rendered = playground.display?.process(text, owner(), result?.context, message.role) ?? text;
        cacheEntry(displayCache, key, { raw: text, text: rendered });
        return rendered;
    }
    function setBrowsing(value) {
        browsing = value; page.classList.toggle('is-browsing-characters', mobile.matches && browsing);
        panel?.classList.toggle('play-choosing-character', mobile.matches && browsing);
        picker.node.classList.toggle('is-mobile-open', browsing); chooseButton.setAttribute('aria-pressed', String(browsing));
        picker.render();
    }
    function updateSearch() {
        searchBox.hidden = mobile.matches && !searchOpen && !search.value;
        searchToggle.hidden = !mobile.matches;
        searchToggle.setAttribute('aria-expanded', String(!searchBox.hidden));
    }
    function saveDirectory() {
        if (selected?.id && route === 'history' && visible) directories.set(selected.id, { rows, query: search.value, searchOpen, scroll: list.scrollTop, limit });
    }
    async function chooseCharacter(character) {
        saveDirectory(); remember(); openId++; queryId++; directoryId++; closeVersions(); editor?.dispose(); editor = null; selected = character; chat = null;
        route = 'history'; branchPage.hidden = true; directory.hidden = false; setBrowsing(false);
        const saved = directories.get(character.id);
        rows = saved?.rows ?? []; search.value = saved?.query ?? ''; searchOpen = saved?.searchOpen ?? false; limit = saved?.limit ?? 24;
        updateSearch(); picker.render(); onCharacter?.(character);
        await refreshDirectory(false); list.scrollTop = saved?.scroll ?? 0;
    }
    async function refreshCharacters(sort = true) {
        const saved = await playground.listCharacters();
        if (!sort) {
            const order = new Map(characters.map((character, index) => [character.id, index]));
            saved.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
        }
        const available = new Map((ctx().characters ?? []).map(character => [character.avatar, character]));
        characters = saved.map(character => ({ ...character, name: available.get(character.avatar)?.name ?? character.name }));
        if (!selected) {
            const current = ctx().characters?.[ctx().characterId];
            selected = characters.find(character => character.avatar === current?.avatar) ?? characters[0];
        } else selected = characters.find(character => character.id === selected.id) ?? selected;
        picker.render();
    }
    async function refreshDirectory(sort = true) {
        const id = ++directoryId;
        try {
            await refreshCharacters(sort);
            const next = selected?.id ? await playground.listChats(selected.id) : [];
            if (id !== directoryId) return;
            if (sort) rows = next;
            else {
                const order = new Map(rows.map((row, index) => [row.id, index]));
                rows = next.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
            }
            await playground.display?.ensure(selected);
            await renderDirectory();
        } catch (error) { if (id === directoryId) showError(list, error, () => refreshDirectory(sort)); }
    }
    function showError(container, error, retry) {
        container.replaceChildren(element('p', error.message, 'play-result-error'), textButton('重新读取', () => void retry()));
    }
    async function renderDirectory() {
        const id = ++queryId, term = search.value.trim().toLocaleLowerCase(), matching = [];
        updateSearch();
        const count = term ? rows.length : Math.min(rows.length, limit);
        for (let index = 0; index < count; index++) {
            if (id !== queryId || route !== 'history') return;
            const row = rows[index];
            try {
                const recordKey = `${row.id}/${!!term}`;
                let record = directoryRecords.get(recordKey);
                if (record?.revision !== row.revision) {
                    record = await (term ? playground.getChatSearch(row.id) : playground.getChatPreview(row.id));
                    cacheEntry(directoryRecords, recordKey, record);
                }
                if (id !== queryId) return;
                const name = record.name, ai = [...record.messages].reverse().find(message => message.role === 'assistant');
                const character = selected;
                const displayText = (message, result) => playground.display?.process(result?.text ?? message.text, character, result?.context, message.role) ?? result?.text ?? message.text;
                const preview = ai ? favoriteFirstLine(displayText(ai)) : '暂无消息';
                let matchMessageId;
                if (term) {
                    let checked = 0;
                    for (const message of record.messages) {
                        if (id !== queryId || route !== 'history') return;
                        const result = null, key = `${record.id}/${message.messageId}/${message.resultId ?? ''}/${message.bodyRevision}/${playground.display?.revision ?? 0}`;
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
            if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (id !== queryId) return;
        const nodes = matching.map(row => {
            let view = rowViews.get(row.id);
            if (!view) {
                const button = textButton('', () => onOpen(view.row.id, view.row.matchMessageId)); button.className = 'play-history-row'; button.dataset.chatId = row.id;
                const text = element('span', undefined, 'play-history-copy'), name = element('strong'), preview = element('span', undefined, 'play-history-preview');
                const time = element('time', undefined, 'play-person-time'); text.append(name, preview); button.append(text, time);
                view = { button, name, preview, time }; rowViews.set(row.id, view);
            }
            view.row = row; view.name.textContent = row.name; view.preview.textContent = row.preview;
            const recent = playRecentTime(row.lastPlayedAt); view.time.dateTime = row.lastPlayedAt;
            view.time.replaceChildren(element('span', recent.day, 'play-person-date'), element('small', recent.time, 'play-person-clock'));
            return view.button;
        });
        if (!nodes.length) nodes.push(element('p', term ? '没有找到符合条件的聊天。' : '这个角色还没有演出记录。', 'play-empty-title'));
        if (!term && count < rows.length) nodes.push(textButton('显示更多历史记录', () => { limit += 24; void renderDirectory(); }));
        const scroll = list.scrollTop; list.replaceChildren(...nodes); list.scrollTop = scroll;
        const currentIds = new Set(rows.map(row => row.id));
        for (const [key, view] of rowViews) if (!currentIds.has(key)) { view.button.remove(); rowViews.delete(key); }
    }
    search.addEventListener('input', event => {
        queryId++; clearTimeout(queryTimer);
        if (!event.isComposing) queryTimer = setTimeout(() => void renderDirectory(), 150);
    });
    search.addEventListener('compositionend', () => { clearTimeout(queryTimer); void renderDirectory(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void renderDirectory(); } });
    function position() {
        const bottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 32;
        const top = feed.getBoundingClientRect().top + getReadingInset();
        const anchor = [...content.querySelectorAll('[data-read-anchor], [data-message-id]')].find(node => node.getBoundingClientRect().bottom > top + 1);
        return { bottom, anchor: anchor?.dataset.readAnchor ?? anchor?.dataset.messageId,
            messageId: anchor?.closest('[data-message-id]')?.dataset.messageId,
            offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
    }
    function remember() { if (chat && route === 'chat' && visible && feed.clientHeight && !restoring) positions.set(chat.id, position()); }
    function setFeedScroll(value) {
        feed.scrollTop = value; onProgrammaticScroll(feed);
    }
    function updateReadingControls() {
        const height = feed.clientHeight - getReadingInset();
        const hidden = !visible || route !== 'chat' || !chat || !!editor || deletingFrom !== null || height <= 0
            || (end >= chat.messages.length && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= height);
        const updates = [];
        for (const node of content.querySelectorAll('.play-assistant-message')) {
            const top = node.querySelector('.play-message-top');
            if (!top) continue;
            const hidden = !!editor || node.querySelector('.play-results').scrollHeight + node.querySelector('.play-message-meta').offsetHeight <= height;
            if (top.hidden !== hidden) updates.push({ top, hidden });
        }
        if (jump.hidden !== hidden) jump.hidden = hidden;
        for (const { top, hidden } of updates) top.hidden = hidden;
        for (const node of content.querySelectorAll('.play-assistant-message')) {
            const view = replyViews.get(node);
            if (view && !view.actions.querySelector('button:not(.tea-icon):not(.play-count)')) syncPlayReplyFooter(view, !!editor);
        }
    }
    function jumpToMessage(node) {
        setFeedScroll(feed.scrollTop + node.getBoundingClientRect().top - feed.getBoundingClientRect().top - getReadingInset() - 10);
        remember(); updateReadingControls();
    }
    function jumpToLatest() {
        if (!chat) return;
        start = Math.max(0, chat.messages.length - 24); end = chat.messages.length;
        positions.set(chat.id, { bottom: true });
        renderChat({ bottom: true });
    }
    function restore(saved, targetId) {
        restoring = true;
        requestAnimationFrame(() => {
            if (!visible || route !== 'chat') { restoring = false; return; }
            if (targetId) {
                const target = content.querySelector(`[data-message-id="${CSS.escape(targetId)}"]`);
                if (target) setFeedScroll(feed.scrollTop + target.getBoundingClientRect().top - feed.getBoundingClientRect().top - getReadingInset());
            }
            else if (!saved || saved.bottom) setFeedScroll(feed.scrollHeight);
            else {
                const anchor = [...content.querySelectorAll('[data-read-anchor], [data-message-id]')]
                    .find(node => node.dataset.readAnchor === saved.anchor || node.dataset.messageId === saved.anchor);
                if (anchor) setFeedScroll(feed.scrollTop + anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top - getReadingInset() - saved.offset);
            }
            restoring = false; remember(); updateReadingControls();
        });
    }
    function messageHeader(message, result) {
        const index = chat.messages.findIndex(item => item.id === message.id);
        const userContext = currentResult(chat.messages.slice(index + 1).find(item => item.role === 'assistant') ?? {})?.context;
        const identity = message.role === 'user' ? { name: userContext?.userName ?? ctx().name1 ?? 'User', avatar: userContext?.userAvatar || null } : owner();
        const head = element('header', undefined, `play-message-meta play-${message.role === 'user' ? 'user' : 'assistant'}-meta`);
        head.append(createCharacterAvatar(ctx, identity ?? { name: '角色', avatar: null }, 'play-message-avatar', message.role === 'user' ? 'persona' : 'avatar'));
        const heading = element('div', undefined, 'play-message-identity'); heading.append(element('strong', identity?.name ?? '角色', 'play-speaker'));
        const recent = playRecentTime(message.createdAt); heading.append(element('time', `${recent.day} · ${recent.time}`, 'play-message-time'));
        head.append(heading); return head;
    }
    function renderMessage(message) {
        const result = currentResult(message), last = chat.messages.at(-1)?.id === message.id;
        const node = element('section', undefined, `play-message play-${message.role === 'user' ? 'user' : 'assistant'}-message`);
        node.dataset.messageId = message.id;
        const head = messageHeader(message, result), tools = element('div', undefined, 'play-header-actions');
        const body = element('div', undefined, message.role === 'user' ? 'play-user-text' : 'play-results');
        let output, error;
        if (message.role === 'user') renderPlayText(body, processed(message), `${chat.id}/${message.id}`, false, true);
        else {
            error = element('p', undefined, 'play-result-error'); error.hidden = true; output = { box: body };
            renderPlayReply(output, result, { displayText: processed(message, result), job: playground.getState(result.id),
                error, anchor: `${chat.id}/${message.id}` });
        }
        const edit = iconButton('edit', message.role === 'user' ? '修改用户消息' : '编辑回复原文', () => editMessage(message, body, tools));
        const remove = iconButton('trash', message.role === 'user' ? '删除用户消息' : '删除 AI 消息', () => void removeMessage(message));
        edit.disabled = remove.disabled = busy() || settings.enabled === false;
        const favorite = iconButton('star', message.role === 'user' ? '收藏用户消息' : '收藏演出记录', () => void toggleMessageFavorite(message)); favorite.classList.add('tea-star');
        const starred = message.role === 'user' ? promptFavorites?.isFavorite({ prompt: message.text, origin: message.origin })
            : favorites.has(favoriteSourceKey({ roundId: chat.id, resultId: result.id, startedAt: result.startedAt }));
        if (starred) { favorite.title = '取消收藏'; favorite.setAttribute('aria-label', favorite.title); }
        favorite.setAttribute('aria-pressed', String(!!starred)); favorite.disabled = busy() || !(result?.text ?? message.text)?.trim() || settings.enabled === false;
        tools.append(favorite, edit, remove); head.append(tools); node.append(head, body);
        if (message.role === 'assistant') {
            const prompt = iconButton('prompt', '查看实际提示词', () => onInspectPrompt?.(currentResult(message).id));
            prompt.classList.add('play-sent-prompt-action'); prompt.hidden = !onInspectPrompt;
            const branch = iconButton('branch', '创建分支', () => void branchAt(message));
            branch.classList.add('play-branch-action');
            branch.disabled = branchDisabled(message);
            tools.prepend(branch); tools.append(prompt);
            const index = message.results.indexOf(result), atEnd = index === message.results.length - 1;
            const { actions: footer, swipes, prev, count, next, again, continueBtn, stop, assistantTop } = createPlayReplyActions({
                onPrevious: () => void selectVersion(message, index - 1), onChoose: () => void showVersions(message),
                onNext: () => {
                    if (index === message.results.length - 1) void generate('another', message); else void selectVersion(message, index + 1);
                },
                onAgain: () => {
                    if (result.status === 'save-failed') void run(() => playground.retrySave(result.id)); else void generate('regenerate', message);
                },
                onContinue: () => void generate('continue', message), onStop: () => playground.stop(result.id), onTop: () => jumpToMessage(node),
            });
            replyViews.set(node, { actions: footer, swipes, again, continueBtn, stop, assistantTop, output, error });
            swipes.hidden = again.hidden = !last; continueBtn.hidden = !last || !result.text.trim();
            prev.disabled = busy() || index === 0; updatePlayReplyCount(count, index, message.results.length); count.disabled = busy();
            next.title = atEnd ? '生成新版本' : '下一个结果'; next.setAttribute('aria-label', next.title); next.disabled = busy() || !canWrite();
            again.title = result.status === 'save-failed' ? '重试保存' : '重新生成'; again.setAttribute('aria-label', again.title);
            again.disabled = mutating || (!canWrite() && result.status !== 'save-failed') || (busy() && result.status !== 'save-failed');
            continueBtn.disabled = busy() || !canWrite() || !result.text.trim();
            const job = ownJobs().find(job => job.resultId === result.id);
            stop.hidden = !showPlayReplyStop(job, playground.getStates().filter(job => activePhases.has(job.phase)).length > 1);
            if (result.status === 'unfinished' && !ownJobs().length) {
                const finish = textButton('结束未完成回复', async () => {
                    const confirmed = await ctx().callGenericPopup(element('p', '保留已经保存的文字，并结束这条未完成回复？如果其他页面仍在生成这条回复，它后续生成的文字将不再保存。'),
                        ctx().POPUP_TYPE.CONFIRM, '', { okButton: '结束回复', cancelButton: '取消' });
                    if (confirmed === ctx().POPUP_RESULT.AFFIRMATIVE) await run(() => playground.finishUnfinishedChat(chat.id));
                });
                finish.disabled = mutating || settings.enabled === false; footer.append(finish);
            }
            node.append(footer);
        }
        if (deletingFrom !== null) {
            node.classList.toggle('play-delete-selected', chat.messages.indexOf(message) >= deletingFrom);
            const choose = textButton('从这里删除到最后', () => { deletingFrom = chat.messages.indexOf(message); renderChat(); });
            choose.className = 'play-delete-select'; node.prepend(choose);
        }
        return node;
    }
    function renderChat(saved = positions.get(chat?.id), targetId) {
        if (!chat || editor) return;
        title.textContent = playChatTitle(chat); menuItems.replaceChildren();
        menuItems.append(textButton(chatFavorite ? '取消收藏该聊天' : '收藏该聊天', () => void toggleChatFavorite()),
            textButton('修改聊天名称', () => void rename()), textButton('删除该聊天', () => void deleteChat()),
            textButton('删除', () => { menu.open = false; deletingFrom = chat.messages.length ? chat.messages.length - 1 : null; renderChat(position()); }));
        for (const button of menuItems.children) button.disabled = busy() || settings.enabled === false;
        const nodes = chat.messages.slice(start, end).map(renderMessage);
        if (start > 0) nodes.unshift(textButton('显示更早的消息', () => { const saved = position(); start = Math.max(0, start - 24); renderChat(saved); }));
        if (end < chat.messages.length) nodes.push(textButton('显示后面的消息', () => { const saved = position(); end = Math.min(chat.messages.length, end + 24); renderChat(saved); }));
        if (!nodes.length) nodes.push(element('p', '输入内容，开始这段剧情。', 'play-empty-title'));
        if (deletingFrom !== null) {
            const controls = element('div', undefined, 'play-delete-controls');
            controls.append(element('span', `将删除所选楼层到最后，共 ${chat.messages.length - deletingFrom} 条消息`),
                textButton('确认删除', () => void run(() => playground.truncateChat(chat.id, chat.messages[deletingFrom].id, chat.revision))),
                textButton('取消', () => { deletingFrom = null; renderChat(position()); }));
            nodes.push(controls);
        }
        content.replaceChildren(...nodes); updateInput(); restore(saved, targetId);
    }
    function updateInput() {
        const jobs = ownJobs(), generating = jobs.find(job => activePhases.has(job.phase));
        const ownPending = jobs.length > 0;
        const stopping = ownPending || (!input.value.trim() && playground.getStates().some(job => activePhases.has(job.phase)));
        const icon = stopping ? 'stop' : 'send', label = generating ? '停止这份回复' : ownPending ? '正在保存回复' : stopping ? '停止所有生成' : '发送消息';
        if (send.dataset.icon !== icon) { send.replaceChildren(glyph(icon)); send.dataset.icon = icon; }
        send.title = label; send.setAttribute('aria-label', label);
        send.disabled = stopping ? ownPending && !generating : busy() || !canWrite() || !input.value.trim() || !playground.availability({ chatId: chat?.id }).available;
        compose.hidden = !!editor || deletingFrom !== null;
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
    const resize = new ResizeObserver(() => { if (visible && !editor) { scheduleInputSizing(); restore(positions.get(chat?.id)); } });
    async function loadFavorites() {
        const rows = await playground.listFavorites();
        favorites = new Map(rows.filter(row => !row.source.type).map(row => [favoriteSourceKey(row.source), row]));
        chatFavorite = rows.find(row => row.source.type === 'chat' && row.source.chatId === chat?.id);
    }
    async function open(id, targetId) {
        remember(); saveDirectory(); closeVersions(); queryId++; directoryId++; const request = ++openId; loading = true;
        editor?.dispose(); editor = null; deletingFrom = null; chat = null; content.replaceChildren(element('p', '正在读取聊天…'));
        route = 'chat'; branchPage.hidden = false; directory.hidden = true; input.value = drafts.get(id) ?? '';
        try {
            const next = await playground.getChat(id);
            if (request !== openId) return;
            await refreshCharacters(false);
            chat = next; selected = characters.find(character => character.id === chat.characterId); picker.render();
            await playground.display?.ensure(owner()); await loadFavorites();
            if (request !== openId) return;
            if (targetId === 'initial-user' || targetId === 'initial-assistant') {
                targetId = chat.messages.find(message => chat.startMessageIds.includes(message.id)
                    && message.role === (targetId === 'initial-user' ? 'user' : 'assistant'))?.id;
            }
            const saved = positions.get(id), anchor = targetId ?? saved?.messageId;
            const index = chat.messages.findIndex(message => message.id === anchor);
            end = !targetId && saved?.bottom ? chat.messages.length : index < 0 ? chat.messages.length : Math.min(chat.messages.length, index + 24);
            start = index < 0 ? Math.max(0, end - 24) : Math.max(0, index - 12);
            if (!targetId && saved?.bottom) start = Math.max(0, end - 24);
            loading = false; renderChat(saved, targetId);
            if (visible) { resize.observe(content); resize.observe(feed); resize.observe(branchPage); }
            if (targetId && index < 0) notify('原回复已删除');
        } catch (error) { if (request === openId) showError(content, error, () => open(id, targetId)); }
        finally { if (request === openId) { loading = false; updateInput(); } }
    }
    async function reload() {
        if (!chat) return;
        const id = chat.id, request = openId, refresh = ++reloadId, saved = positions.get(id);
        const next = await playground.getChat(id);
        if (request !== openId || refresh !== reloadId || chat?.id !== id) return;
        chat = next; await loadFavorites();
        if (request !== openId || refresh !== reloadId || chat?.id !== id) return;
        end = saved?.bottom ? chat.messages.length : Math.min(Math.max(end, start + 24), chat.messages.length);
        start = Math.min(start, Math.max(0, end - 1));
        if (saved?.bottom) start = Math.max(0, end - 24);
        if (visible && route === 'chat') renderChat(saved);
    }
    async function run(action) {
        if (mutating) return;
        remember(); mutating = true; updateInput(); menu.open = false;
        try { await action(); deletingFrom = null; await reload(); }
        catch (error) { notify(error.message); }
        finally { mutating = false; if (chat && visible) renderChat(positions.get(chat.id)); }
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
        } catch (error) { notify(error.message); }
        finally { pendingDrafts.delete(id); if (chat?.id === id) await reload(); }
    }
    async function generate(operation, message) {
        if (busy() || !canWrite()) return;
        const result = currentResult(message), id = chat.id, args = [id, message.id];
        const method = operation === 'another' ? 'generateChatVersion' : operation === 'regenerate' ? 'regenerateChat' : 'continueChat';
        if (operation !== 'another') args.push(result.id);
        args.push({ ...target(), expectedRevision: chat.revision });
        try { await playground[method](...args); }
        catch (error) { notify(error.message); }
        finally { if (chat?.id === id) await reload(); }
    }
    async function branchAt(message) {
        try { const branch = await playground.createBranch(chat.id, message.id, chat.revision); onBranch(branch); }
        catch (error) { notify(error.message); }
    }
    async function selectVersion(message, index) {
        if (busy() || !message.results[index]) return;
        await run(() => playground.setMessageVersion(chat.id, message.id, message.results[index].id, message.selectedResultId));
    }
    function closeVersions() { versionMenu?.remove(); versionMenu = null; }
    async function showVersions(message) {
        if (versionMenu) { closeVersions(); return; }
        const choices = element('div', undefined, 'play-chat-version-choices');
        for (const [index, result] of message.results.entries()) {
            choices.append(textButton(`${index + 1} · ${favoriteFirstLine(processed(message, result)) || '无正文'}`, async () => {
                await selectVersion(message, index);
                closeVersions();
            }));
        }
        choices.append(textButton('关闭', closeVersions)); choices.setAttribute('role', 'dialog'); choices.setAttribute('aria-label', '选择回复版本');
        versionMenu = choices; branchPage.append(choices);
    }
    function editMessage(message, body, tools) {
        if (busy() || editor) return;
        remember(); const result = currentResult(message), text = result?.text ?? message.text, id = chat.id;
        const finish = () => { editor?.dispose(); editor = null; renderChat(positions.get(id)); };
        editor = createPlayEditor({ text, label: message.role === 'user' ? '用户消息原文' : '回复原文', onCancel: finish,
            async onSave({ text }) {
                chat = await playground.editMessage(id, message.id, { text, expectedText: result?.text ?? message.text, resultId: result?.id });
                finish();
            } });
        tools.replaceChildren(editor.actions); body.replaceChildren(editor.body); compose.hidden = true; updateReadingControls(); editor.body.focus({ preventScroll: true });
    }
    async function removeMessage(message) {
        if (busy()) return;
        const confirmed = await ctx().callGenericPopup(element('p', message.role === 'assistant' ? '删除这条 AI 消息及其全部版本？' : '删除这条用户消息？'),
            ctx().POPUP_TYPE.CONFIRM, '', { okButton: '删除消息', cancelButton: '取消' });
        if (confirmed === ctx().POPUP_RESULT.AFFIRMATIVE) await run(() => playground.removeMessage(chat.id, message.id, chat.revision));
    }
    async function toggleMessageFavorite(message) {
        if (busy()) return;
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
    async function rename() {
        menu.open = false;
        const name = await ctx().callGenericPopup('修改聊天名称', ctx().POPUP_TYPE.INPUT, chat.name || playChatTitle(chat));
        if (typeof name === 'string') await run(() => playground.renameChat(chat.id, name, chat.revision));
    }
    async function deleteChat() {
        if (busy()) return;
        menu.open = false;
        const confirmed = await ctx().callGenericPopup(element('p', '删除整条聊天？已有收藏会保留，聊天将从历史记录移除。'),
            ctx().POPUP_TYPE.CONFIRM, '', { okButton: '删除该聊天', cancelButton: '取消' });
        if (confirmed !== ctx().POPUP_RESULT.AFFIRMATIVE) return;
        const id = chat.id;
        try { await playground.deleteChat(id, chat.revision); drafts.delete(id); positions.delete(id); saveDrafts(); onDelete(id); }
        catch (error) { notify(error.message); }
    }
    function updateReplyStops() {
        const multiple = playground.getStates().filter(job => activePhases.has(job.phase)).length > 1;
        for (const node of content.querySelectorAll('.play-assistant-message')) {
            const message = chat?.messages.find(message => message.id === node.dataset.messageId);
            const stop = node.querySelector('.play-stop');
            if (message && stop) stop.hidden = !showPlayReplyStop(playground.getState(currentResult(message).id), multiple);
        }
    }
    playground.subscribe(job => {
        const pending = pendingDrafts.get(job.roundId);
        if (job.chatMode && job.operation === 'send' && job.phase === 'preparing' && job.roundId && pending !== undefined) {
            if (drafts.get(job.roundId) === pending) drafts.set(job.roundId, '');
            if (chat?.id === job.roundId && input.value === pending) input.value = '';
            pendingDrafts.delete(job.roundId); saveDrafts();
        }
        if (route !== 'chat' || !chat) return;
        if (visible) { updateReplyStops(); updateInput(); }
        if ((job.roundId ?? job.requestedRoundId) !== chat.id) return;
        if (job.phase === 'idle' || job.phase === 'save-failed' || job.phase === 'preparing' && job.roundId) {
            void reload().catch(error => notify(error.message)); return;
        }
        const message = chat.messages.find(message => message.results?.some(result => result.id === job.resultId));
        const result = message?.results.find(result => result.id === job.resultId);
        if (result) { result.text = job.text; result.status = job.phase; result.error = job.error; }
        if (!visible || renderFrame || editor) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = 0; if (!visible || !chat) return;
            const saved = positions.get(chat.id), node = content.querySelector(`[data-message-id="${CSS.escape(message?.id ?? '')}"]`);
            const latest = chat.messages.find(item => item.id === message?.id);
            const view = replyViews.get(node);
            if (view && latest) {
                const current = currentResult(latest);
                renderPlayReply(view.output, current, { displayText: processed(latest, current), job: playground.getState(current.id),
                    error: view.error, anchor: `${chat.id}/${latest.id}` });
                view.continueBtn.hidden = chat.messages.at(-1)?.id !== latest.id || !current.text.trim();
                view.continueBtn.disabled = busy() || !canWrite();
            }
            for (const button of content.querySelectorAll('.play-header-actions button')) {
                const message = chat.messages.find(message => message.id === button.closest('[data-message-id]').dataset.messageId);
                button.disabled = button.classList.contains('play-sent-prompt-action') ? false : button.classList.contains('play-branch-action')
                    ? branchDisabled(message)
                    : busy() || settings.enabled === false;
            }
            for (const button of menuItems.children) button.disabled = busy() || settings.enabled === false;
            updateInput(); updateReadingControls(); if (saved?.bottom) restore(saved);
        });
    });
    window.addEventListener('pagehide', saveDrafts);
    return {
        page, browser: picker.node, chooseButton, open, get route() { return route; }, get selected() { return selected; },
        async showDirectory(character, sort = true) {
            remember(); route = 'history'; branchPage.hidden = true; directory.hidden = false; editor?.dispose(); editor = null;
            if (character) selected = character;
            const saved = directories.get(selected?.id);
            search.value = saved?.query ?? ''; searchOpen = saved?.searchOpen ?? false; limit = saved?.limit ?? 24;
            if (saved?.rows) rows = saved.rows;
            await refreshDirectory(sort); list.scrollTop = saved?.scroll ?? 0; picker.render();
        },
        activate(container) {
            panel = container; visible = true; setBrowsing(browsing); updateSearch(); picker.render();
            if (route === 'chat') { resize.observe(content); resize.observe(feed); resize.observe(branchPage); scheduleInputSizing(); restore(positions.get(chat?.id)); }
        },
        deactivate() { remember(); saveDirectory(); saveDrafts(); closeVersions(); visible = false; cancelAnimationFrame(inputFrame); inputFrame = 0; resize.disconnect(); picker.suspend(); },
        async refresh() {
            if (route === 'history') await refreshDirectory(false);
            else {
                await playground.display?.ensure(owner());
                await reload();
            }
        },
        canLeave: () => !mutating && !editor?.saving,
        prepareLayout: remember,
    };
}
