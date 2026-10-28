import { element, iconButton, textButton } from './ui.js';
import { createPlayEditor } from './play-editor.js';
import { renderPlayText, playTextPreview } from './play-render.js';
import { truncateTitle } from './library.js';
import { createCharacterAvatar } from './play-character-picker.js';

export function favoriteFirstLine(text) {
    return [...playTextPreview(text, true)].slice(0, 160).join('');
}

export function favoriteTitle(item, limit = 28) {
    const title = item.title.trim() || item.firstLine || '内容已隐藏';
    return truncateTitle(title, limit);
}

export function favoriteSourceKey({ roundId, resultId, startedAt }) {
    return `${roundId}/${resultId}/${startedAt}`;
}

/** A reader owns its inline draft; saved content stays in the history service. */
export function createPlayFavoriteReader(playground, { onChange, onRemove, onNavigate, onGoToBranch, notify }) {
    const node = element('article', undefined, 'play-favorite-reading tea-scroll');
    const navigation = element('nav', undefined, 'play-favorite-navigation');
    navigation.setAttribute('aria-label', '演出记录收藏切换');
    const previous = navigationButton('left', '上一条收藏', -1);
    const next = navigationButton('right', '下一条收藏', 1);
    navigation.append(previous, next);
    const article = element('div', undefined, 'play-favorite-article play-message');
    const head = element('header', undefined, 'play-favorite-head');
    const heading = element('div', undefined, 'play-favorite-heading');
    const title = element('h2', '', 'play-favorite-title');
    const character = element('p', '', 'play-favorite-character');
    const tools = element('div', undefined, 'play-header-actions');
    const body = element('div', undefined, 'play-favorite-content');
    const goToBranch = textButton('前往分支', () => {
        if (!value || value.frozen || !onGoToBranch) return;
        const source = value.source;
        if (source.type === 'chat') onGoToBranch(source.chatId);
        else void (async () => {
            try {
                const chat = await playground.getChat(source.roundId);
                const message = chat.messages.find(message => message.results?.some(result => result.id === source.resultId));
                onGoToBranch(source.roundId, message?.id ?? source.messageId ?? 'missing');
            } catch (error) { notify(error.message); }
        })();
    }); goToBranch.className = 'tea-text-button play-go-branch';
    const sourceNotice = element('p', '', 'play-favorite-source-notice');
    const edit = iconButton('edit', '编辑演出记录收藏', beginEdit);
    const remove = iconButton('star', '取消收藏', async () => {
        if (!value || removing || editor) return;
        removing = true; remove.disabled = true; edit.disabled = true; updateNavigation();
        try { await playground.removeFavorite(value.id); onRemove(value.id); }
        catch (error) { notify(error.message); }
        finally { removing = false; remove.disabled = false; edit.disabled = false; updateNavigation(); }
    });
    remove.classList.add('tea-star'); remove.setAttribute('aria-pressed', 'true');
    heading.append(title, character); head.append(heading, tools); article.append(head, goToBranch, sourceNotice, body); node.append(navigation, article);
    let value, editor, signature, loadingId = 0, requestedRevision, removing = false, renderedMessages = 0;
    const moreMessages = textButton('显示更多聊天内容', () => appendMessages());
    let canPrevious = false, canNext = false;

    function navigationButton(icon, label, direction) {
        let press, cancelled = false;
        const button = iconButton(icon, label, event => {
            // Keyboard and assistive activation have no pointer click count.
            if (event.detail && cancelled) { event.preventDefault(); return; }
            if (!editor && !removing) onNavigate?.(direction);
        });
        button.disabled = true;
        button.addEventListener('pointerdown', event => {
            cancelled = !event.isPrimary || event.button !== 0;
            press = { id: event.pointerId, x: event.clientX, y: event.clientY };
        });
        const checkMovement = event => {
            if (press?.id !== event.pointerId) return;
            if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelled = true;
        };
        button.addEventListener('pointermove', checkMovement);
        button.addEventListener('pointerup', event => {
            checkMovement(event);
            const bounds = button.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom) cancelled = true;
            press = null;
        });
        button.addEventListener('pointercancel', () => { cancelled = true; press = null; });
        button.addEventListener('pointerleave', () => { if (press) cancelled = true; });
        return button;
    }
    function updateNavigation() {
        navigation.hidden = !!editor;
        previous.disabled = !canPrevious || removing;
        next.disabled = !canNext || removing;
    }
    function setNavigation({ previous, next }) {
        canPrevious = previous; canNext = next; updateNavigation();
    }

    function render() {
        if (!value || editor) return;
        title.textContent = value.title; title.hidden = !value.title.trim();
        character.textContent = value.characterName;
        heading.replaceChildren(title, character); tools.replaceChildren(remove, ...(value.format === 2 ? [] : [edit]));
        goToBranch.hidden = !onGoToBranch || value.source.type === 'manual'; goToBranch.disabled = !!value.frozen;
        sourceNotice.textContent = value.frozen ? '来源聊天已删除' : ''; sourceNotice.hidden = !value.frozen;
        if (value.format === 2) {
            const key = value.revision;
            if (signature === key) return;
            const previousCount = renderedMessages;
            renderedMessages = 0; body.replaceChildren();
            appendMessages(Math.max(24, previousCount)); signature = key; return;
        }
        const text = value.cleaned ? value.text : (playground.display?.process(value.text, { avatar: value.characterAvatar, name: value.characterName }) ?? value.text);
        if (signature === text) return;
        if (text.trim()) renderPlayText(body, text, `favorite/${value.id}`, true, true);
        else body.replaceChildren(element('p', '内容已隐藏', 'play-result-empty'));
        signature = text;
    }
    function appendMessages(count = 24) {
        moreMessages.remove();
        const fragment = document.createDocumentFragment();
        for (const message of value.messages.slice(renderedMessages, renderedMessages + count)) {
            const user = message.role === 'user', identity = { name: message.speakerName ?? (user ? '用户' : value.characterName),
                avatar: message.speakerAvatar || null };
            const floor = element('section', undefined, `play-message play-${user ? 'user' : 'assistant'}-message`);
            const head = element('header', undefined, `play-message-meta play-${user ? 'user' : 'assistant'}-meta`);
            head.append(createCharacterAvatar(() => ({}), identity, 'play-message-avatar', user ? 'persona' : 'avatar'));
            const speaker = element('div', undefined, 'play-message-identity');
            speaker.append(element('strong', identity.name, 'play-speaker'));
            const date = new Date(message.createdAt);
            speaker.append(element('time', `${date.getMonth() + 1}/${date.getDate()} · ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`, 'play-message-time'));
            head.append(speaker);
            const content = element('div', undefined, user ? 'play-user-text' : 'play-results');
            renderPlayText(content, message.text, `favorite/${value.id}/${message.messageId}`, !user, true);
            floor.append(head, content); fragment.append(floor); renderedMessages++;
        }
        body.append(fragment);
        if (renderedMessages < value.messages.length) body.append(moreMessages);
    }
    function finish() {
        editor?.dispose();
        editor = null; signature = null; updateNavigation(); render(); edit.focus({ preventScroll: true });
    }
    function beginEdit() {
        if (!value || value.format === 2 || editor || removing) return;
        const original = value;
        const initialText = original.cleaned ? original.text : (playground.display?.process(original.text, { avatar: original.characterAvatar, name: original.characterName }) ?? original.text);
        editor = createPlayEditor({ text: initialText, title: original.title, autoGrow: false, onCancel: finish,
            async onSave({ text, title }) {
                value = await playground.editFavorite(original.id,
                    { text, title, firstLine: favoriteFirstLine(text) }, original.revision);
                requestedRevision = value.revision;
                finish(); onChange(value);
            },
        });
        updateNavigation();
        heading.replaceChildren(character); tools.replaceChildren(editor.actions);
        body.replaceChildren(editor.titleInput, editor.body); editor.titleInput.focus({ preventScroll: true });
    }
    async function load(row, force = false) {
        if (editor) return;
        if (!force && row.revision === requestedRevision && row.source.type !== 'chat') { render(); return; }
        const id = ++loadingId; requestedRevision = row.revision;
        title.textContent = row.title; title.hidden = !row.title.trim(); character.textContent = row.characterName;
        if (!value) body.replaceChildren(element('p', '正在读取收藏…', 'play-result-empty'));
        try {
            const next = await playground.getFavorite(row.id);
            if (!next.cleaned) await playground.display?.ensure?.({ avatar: next.characterAvatar, name: next.characterName });
            if (id !== loadingId) return;
            if (value?.id !== next.id) renderedMessages = 0;
            value = next; requestedRevision = next.revision; render();
        } catch (error) {
            if (id !== loadingId) return;
            requestedRevision = null; signature = null;
            const retry = iconButton('refresh', '重新读取收藏', () => void load(row, true));
            body.replaceChildren(element('p', error.message, 'play-result-error'), retry);
        }
    }
    return { node, load, setNavigation, canLeave: () => !removing && !editor?.saving, canNavigate: () => !removing && !editor };
}
