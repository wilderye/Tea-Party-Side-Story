import { element, iconButton } from './ui.js';
import { createPlayEditor } from './play-editor.js';
import { renderPlayText, playTextPreview } from './play-render.js';
import { truncateTitle } from './library.js';

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
export function createPlayFavoriteReader(playground, { onChange, onRemove, notify }) {
    const node = element('article', undefined, 'play-favorite-reading tea-scroll');
    const article = element('div', undefined, 'play-favorite-article play-message');
    const head = element('header', undefined, 'play-favorite-head');
    const heading = element('div', undefined, 'play-favorite-heading');
    const title = element('h2', '', 'play-favorite-title');
    const character = element('p', '', 'play-favorite-character');
    const tools = element('div', undefined, 'play-header-actions');
    const body = element('div', undefined, 'play-favorite-content');
    const edit = iconButton('edit', '编辑演出记录收藏', beginEdit);
    const remove = iconButton('star', '取消收藏', async () => {
        if (!value || removing || editor) return;
        removing = true; remove.disabled = true; edit.disabled = true;
        try { await playground.removeFavorite(value.id); onRemove(value.id); }
        catch (error) { notify(error.message); }
        finally { removing = false; remove.disabled = false; edit.disabled = false; }
    });
    remove.classList.add('tea-star'); remove.setAttribute('aria-pressed', 'true');
    heading.append(title, character); head.append(heading, tools); article.append(head, body); node.append(article);
    let value, editor, signature, loadingId = 0, requestedRevision, removing = false;

    function render() {
        if (!value || editor) return;
        title.textContent = value.title; title.hidden = !value.title.trim();
        character.textContent = value.characterName;
        heading.replaceChildren(title, character); tools.replaceChildren(remove, edit);
        const text = value.cleaned ? value.text : (playground.display?.process(value.text) ?? value.text);
        if (signature === text) return;
        if (text.trim()) renderPlayText(body, text, `favorite/${value.id}`, true);
        else body.replaceChildren(element('p', '内容已隐藏', 'play-result-empty'));
        signature = text;
    }
    function finish() {
        editor?.dispose();
        editor = null; signature = null; render(); edit.focus({ preventScroll: true });
    }
    function beginEdit() {
        if (!value || editor || removing) return;
        const original = value;
        const initialText = original.cleaned ? original.text : (playground.display?.process(original.text) ?? original.text);
        editor = createPlayEditor({ text: initialText, title: original.title, autoGrow: false, onCancel: finish,
            async onSave({ text, title }) {
                value = await playground.editFavorite(original.id,
                    { text, title, firstLine: favoriteFirstLine(text) }, original.revision);
                requestedRevision = value.revision;
                finish(); onChange(value);
            },
        });
        heading.replaceChildren(character); tools.replaceChildren(editor.actions);
        body.replaceChildren(editor.titleInput, editor.body); editor.titleInput.focus({ preventScroll: true });
    }
    async function load(row, force = false) {
        if (editor) return;
        if (!force && row.revision === requestedRevision) { render(); return; }
        const id = ++loadingId; requestedRevision = row.revision;
        title.textContent = row.title; title.hidden = !row.title.trim(); character.textContent = row.characterName;
        if (!value) body.replaceChildren(element('p', '正在读取收藏…', 'play-result-empty'));
        try {
            const next = await playground.getFavorite(row.id);
            if (id !== loadingId) return;
            value = next; requestedRevision = next.revision; render();
        } catch (error) {
            if (id !== loadingId) return;
            requestedRevision = null; signature = null;
            const retry = iconButton('refresh', '重新读取收藏', () => void load(row, true));
            body.replaceChildren(element('p', error.message, 'play-result-error'), retry);
        }
    }
    return { node, load, canLeave: () => !removing && !editor?.saving };
}
