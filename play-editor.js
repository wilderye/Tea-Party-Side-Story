import { element, glyph, iconButton } from './ui.js';

/** Inline source editor shared by messages and saved performances. */
export function createPlayEditor({ text, title, label = title === undefined ? '回复原文' : '收藏内容', autoGrow = true, onSave, onSubmit, onCancel }) {
    const body = element('div', undefined, 'play-edit-form');
    body.setAttribute('role', 'group'); body.setAttribute('aria-label', title === undefined ? `编辑${label}` : '编辑收藏');
    const input = element('textarea'); input.value = text; input.spellcheck = false; input.rows = 2;
    const initialValue = input.value;
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
    let width = 0, fixed = false;
    function resize() {
        if (fixed || !input.getClientRects().length) return;
        const scroll = input.scrollTop;
        input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`;
        input.scrollTop = scroll;
    }
    const observer = autoGrow && !nativeSizing ? new ResizeObserver(() => {
        if (input.clientWidth && input.clientWidth !== width) { width = input.clientWidth; resize(); }
    }) : null;
    observer?.observe(body);
    if (autoGrow && !nativeSizing) input.addEventListener('input', resize);
    let savingTask = null;
    const editor = { body, actions, input, titleInput, error,
        get saving() { return savingTask !== null; },
        get dirty() { return input.value !== initialValue; },
        save() {
            if (savingTask) return savingTask;
            savingTask = performSave().finally(() => { savingTask = null; });
            return savingTask;
        },
        resize() { if (autoGrow && !nativeSizing) resize(); },
        capture() { return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, scroll: input.scrollTop }; },
        restore(state) {
            if (!state) return;
            this.resize(); input.setSelectionRange(state.start, state.end, state.direction); input.scrollTop = state.scroll;
        },
        scrollToTop() { input.scrollTop = 0; },
        scrollToEnd({ caret = false } = {}) {
            if (caret) input.setSelectionRange(input.value.length, input.value.length);
            input.scrollTop = input.scrollHeight;
        },
        setFixed(value) {
            if (fixed === value) return;
            fixed = value;
            if (fixed) input.style.height = '';
            body.classList.toggle('is-native-sized', nativeSizing && !fixed);
            this.resize();
        },
        dispose: () => observer?.disconnect() };
    const cancel = iconButton('close', '取消', () => { if (!editor.saving) onCancel(); });
    const save = iconButton('check', '保存', () => onSubmit ? onSubmit() : editor.save());
    async function performSave() {
        input.disabled = true; save.disabled = true; cancel.disabled = true; error.hidden = true;
        if (titleInput) titleInput.disabled = true;
        save.setAttribute('aria-busy', 'true'); save.title = '正在保存'; save.replaceChildren(glyph('refresh'));
        try { await onSave({ text: input.value, ...(titleInput ? { title: titleInput.value } : {}) }); return true; }
        catch (cause) { error.textContent = cause.message; error.hidden = false; return false; }
        finally {
            input.disabled = false; save.disabled = false; cancel.disabled = false;
            if (titleInput) titleInput.disabled = false;
            save.setAttribute('aria-busy', 'false'); save.title = '保存'; save.replaceChildren(glyph('check'));
        }
    }
    save.classList.add('play-edit-save'); actions.append(save, cancel);
    body.append(input, error);
    return editor;
}
