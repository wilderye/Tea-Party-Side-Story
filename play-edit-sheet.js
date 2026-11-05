import { element } from './ui.js';

export function createPlayEditSheet() {
    const node = element('section', undefined, 'play-edit-sheet');
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', '编辑');
    const head = element('header', undefined, 'play-edit-sheet-head');
    const body = element('div', undefined, 'play-edit-sheet-body');
    head.append(element('h2', '编辑')); node.append(head, body);
    const covered = new Set();
    let editor = null;
    function uncover() {
        for (const child of covered) child.inert = false;
        covered.clear();
    }
    return {
        get editor() { return editor; },
        contains: target => node.contains(target),
        show(surface, next) {
            if (node.parentElement !== surface) { uncover(); surface.append(node); }
            for (const child of surface.children) {
                if (child !== node && !child.inert) { child.inert = true; covered.add(child); }
            }
            if (editor === next && head.contains(next.actions) && body.contains(next.body)) return false;
            if (editor && editor !== next) editor.setFixed(false);
            editor = next; next.setFixed(true);
            head.append(next.actions); body.replaceChildren(next.body);
            return true;
        },
        hide() {
            uncover(); node.remove();
            if (!editor) return;
            if (head.contains(editor.actions)) editor.actions.remove();
            if (body.contains(editor.body)) editor.body.remove();
            editor.setFixed(false); editor = null;
        },
    };
}
