import { element, iconButton, textButton } from './ui.js';
import { createPlayEditor } from './play-editor.js';
import { favoriteFirstLine } from './play-favorites-view.js';
import { createCharacterAvatar, createPlayCharacterPicker } from './play-character-picker.js';

/** A new favorite draft never changes the selected performance character. */
export function createPlayFavoriteComposer(ctx, playground, { onSave, onCancel }) {
    const node = element('section', undefined, 'tea-workspace play-favorite-composer');
    node.setAttribute('aria-label', '添加演出记录收藏');
    const head = element('header', undefined, 'tea-view-title');
    const name = element('div'); name.append(element('h2', '添加演出记录收藏'));
    const close = iconButton('close', '取消添加收藏', onCancel); head.append(name, close);
    const form = element('div', undefined, 'play-favorite-new-form tea-scroll');
    const characterField = element('div', undefined, 'play-favorite-character-field');
    const characterValue = element('div', undefined, 'play-favorite-selected-character');
    let character = null, choosing = false;
    const choose = textButton('选择角色', openPicker); choose.classList.add('play-favorite-choose');
    characterField.append(element('span', '角色'), characterValue, choose);
    const editor = createPlayEditor({ title: '', text: '', autoGrow: false, onCancel,
        async onSave({ title, text }) {
            if (!character) throw new Error('请先选择角色。');
            const favorite = await playground.addManualFavorite({ characterAvatar: character.avatar,
                title, text, firstLine: favoriteFirstLine(text) });
            onSave(favorite);
        },
    });
    editor.body.classList.add('play-favorite-new-body');
    const titleLabel = element('label', '标题（可留空）', 'tea-field'); titleLabel.append(editor.titleInput);
    const contentLabel = element('label', '内容', 'tea-field'); contentLabel.append(editor.body);
    form.append(characterField, titleLabel, contentLabel);
    const footer = element('footer', undefined, 'tea-reader-footer');
    footer.append(element('p', '保存在我的收藏中。', 'tea-footer-note'), editor.actions);
    node.append(head, form, footer);
    const save = editor.actions.querySelector('.play-edit-save');
    const overlay = element('div', undefined, 'play-favorite-picker-overlay'); overlay.hidden = true;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', '选择收藏所属角色'); overlay.setAttribute('aria-modal', 'true');
    const picker = createPlayCharacterPicker(ctx, {
        getCharacters: () => (ctx().characters ?? []).filter(card => card?.avatar && card.name)
            .map(card => ({ avatar: card.avatar, name: card.name })),
        getSelected: () => character, isVisible: () => choosing,
        onBack: closePicker, backLabel: '返回添加收藏',
        onSelect(selected) { character = selected; renderCharacter(); closePicker(); },
    });
    overlay.append(picker.node); node.append(overlay);
    function renderCharacter() {
        characterValue.replaceChildren(...(character
            ? [createCharacterAvatar(ctx, character, 'play-avatar'), element('span', character.name)] : [element('span', '尚未选择')]));
        save.disabled = !character;
    }
    function closePicker() {
        choosing = false; overlay.hidden = true; form.inert = false; head.inert = false; footer.inert = false;
        picker.suspend(); choose.focus({ preventScroll: true });
    }
    function openPicker() {
        if (editor.saving) return;
        choosing = true; overlay.hidden = false; form.inert = true; head.inert = true; footer.inert = true;
        picker.render(); picker.focus();
    }
    node.addEventListener('keydown', event => {
        if (!choosing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); }
        if (event.key === 'Tab') {
            const controls = [...overlay.querySelectorAll('button, input, summary')].filter(control => !control.disabled && control.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    overlay.addEventListener('click', event => { if (event.target === overlay) closePicker(); });
    const observer = new ResizeObserver(() => { if (choosing) picker.layout(); }); observer.observe(overlay);
    renderCharacter();
    return { node, dirty: () => !!character || !!editor.titleInput.value || !!editor.input.value,
        canLeave: () => !editor.saving,
        focus() { choose.focus({ preventScroll: true }); },
        dispose() { observer.disconnect(); picker.suspend(); editor.dispose(); } };
}
