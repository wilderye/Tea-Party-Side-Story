import { element, glyph, iconButton } from './ui.js';

/** Inline source editor shared by messages and saved performances. */
export function createPlayEditor({ text, title, label = title === undefined ? '回复原文' : '收藏内容', autoGrow = true, onSave, onCancel }) {
    const body = element('div', undefined, 'play-edit-form');
    body.setAttribute('role', 'group'); body.setAttribute('aria-label', title === undefined ? `编辑${label}` : '编辑收藏');
    const input = element('textarea'); input.value = text; input.spellcheck = false; input.rows = 2;
    input.setAttribute('aria-label', label);
    const nativeSizing = autoGrow && CSS.supports('field-sizing', 'content');
    body.classList.toggle('is-native-sized', nativeSizing);
    const titleInput = title === undefined ? null : element('input', undefined, 'play-edit-title');
    if (titleInput) {
        titleInput.type = 'text'; titleInput.value = title; titleInput.maxLength = 100;
        titleInput.placeholder = '标题（可留空）'; titleInput.setAttribute('aria-label', '收藏标题');
    }
    const error = element('p', '', 'play-result-error'); error.hidden = true; error.setAttribute('role', 'alert');
    const actions = element('div', undefined, 'play-edit-actions');
    let width = 0;
    function resize() {
        if (!input.getClientRects().length) return;
        const scroll = input.scrollTop;
        input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`;
        input.scrollTop = scroll;
    }
    const observer = autoGrow && !nativeSizing ? new ResizeObserver(() => {
        if (input.clientWidth && input.clientWidth !== width) { width = input.clientWidth; resize(); }
    }) : null;
    observer?.observe(body);
    if (autoGrow && !nativeSizing) input.addEventListener('input', resize);
    const editor = { body, actions, input, titleInput, saving: false, dispose: () => observer?.disconnect() };
    const cancel = iconButton('close', '取消', onCancel);
    const save = iconButton('check', '保存', async () => {
        if (editor.saving) return;
        editor.saving = true; input.disabled = true; save.disabled = true; cancel.disabled = true; error.hidden = true;
        if (titleInput) titleInput.disabled = true;
        save.setAttribute('aria-busy', 'true'); save.title = '正在保存'; save.replaceChildren(glyph('refresh'));
        try { await onSave({ text: input.value, ...(titleInput ? { title: titleInput.value } : {}) }); }
        catch (cause) { error.textContent = cause.message; error.hidden = false; }
        finally {
            editor.saving = false; input.disabled = false; save.disabled = false; cancel.disabled = false;
            if (titleInput) titleInput.disabled = false;
            save.setAttribute('aria-busy', 'false'); save.title = '保存'; save.replaceChildren(glyph('check'));
        }
    });
    save.classList.add('play-edit-save'); actions.append(save, cancel);
    if (title === undefined) body.append(actions);
    body.append(input, error);
    return editor;
}
