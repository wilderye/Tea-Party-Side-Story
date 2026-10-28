export function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

export function textButton(text, action) {
    const node = element('button', text); node.type = 'button';
    node.addEventListener('click', action); return node;
}

let pageJumpId = 0;

/** The same page-number entry for story catalogs and the character catalog. */
export function createPageJump({ getPage, getPages, onSelect, label = '跳转到某页' }) {
    const id = `tea-page-${++pageJumpId}`;
    const node = element('details', undefined, 'tea-page-jump');
    const summary = element('summary', undefined, 'tea-page-display');
    summary.setAttribute('role', 'button'); summary.setAttribute('aria-label', label);
    summary.setAttribute('aria-expanded', 'false'); summary.setAttribute('aria-controls', `${id}-popover`);
    const current = element('span', undefined, 'tea-page-current'), total = element('span', undefined, 'tea-page-total');
    summary.append(current, element('span', ' / ', 'tea-page-divider'), total, glyph('down'));
    const form = element('form', undefined, 'tea-page-popover'); form.id = `${id}-popover`; form.noValidate = true;
    const caption = element('label', '跳转'); caption.htmlFor = `${id}-target`;
    const controls = element('div', undefined, 'tea-page-controls'), input = element('input');
    input.id = `${id}-target`; input.type = 'text'; input.inputMode = 'numeric'; input.pattern = '[0-9]*'; input.autocomplete = 'off';
    input.setAttribute('aria-label', '跳转页码'); input.setAttribute('aria-describedby', `${id}-hint`);
    const go = element('button'); go.type = 'submit'; go.setAttribute('aria-label', '确认跳转'); go.title = '确认跳转'; go.append(glyph('check'));
    const hint = element('p', undefined, 'tea-page-hint'); hint.id = `${id}-hint`; hint.setAttribute('aria-live', 'polite');
    const resetHint = () => { hint.textContent = `共 ${getPages()} 页`; hint.classList.remove('tea-page-error'); input.removeAttribute('aria-invalid'); };
    const update = () => {
        current.textContent = String(getPage() + 1).padStart(2, '0'); total.textContent = String(getPages()).padStart(2, '0');
        summary.title = `第 ${getPage() + 1} 页，共 ${getPages()} 页，点击跳转`;
        if (!node.open) { input.value = String(getPage() + 1); resetHint(); }
    };
    controls.append(caption, input, go); form.append(controls, hint); node.append(summary, form);
    summary.addEventListener('click', event => {
        event.preventDefault(); node.open = !node.open;
        // Keep focus inside the tap event so phones can open the numeric keyboard.
        if (node.open) { input.value = String(getPage() + 1); resetHint(); input.focus({ preventScroll: true }); input.select(); }
    });
    node.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(node.open)));
    node.addEventListener('focusout', event => { if (!node.contains(event.relatedTarget)) node.open = false; });
    node.addEventListener('keydown', event => {
        if (node.open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); node.open = false; summary.focus({ preventScroll: true }); }
    });
    input.addEventListener('input', resetHint);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const value = input.value.trim(), target = Number(value), pages = getPages();
        if (!/^\d+$/.test(value) || !Number.isInteger(target) || target < 1 || target > pages) {
            hint.textContent = `请输入 1～${pages}`; hint.classList.add('tea-page-error'); input.setAttribute('aria-invalid', 'true'); input.focus({ preventScroll: true }); return;
        }
        node.open = false; input.blur(); await onSelect(target - 1);
        if (node.isConnected) summary.focus({ preventScroll: true });
    });
    return { node, update };
}

/** Keep one-click copying available on ordinary LAN HTTP, including dialogs. */
export async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return; } catch { /* Try the selection-based browser command. */ }
    }
    const active = document.activeElement;
    const input = element('textarea'); input.value = text; input.readOnly = true;
    input.style.cssText = 'position:fixed;inset:0 auto auto 0;width:1px;height:1px;opacity:0;font-size:16px;';
    (document.querySelector('dialog[open]:last-of-type') ?? document.body).append(input);
    try {
        input.focus({ preventScroll: true }); input.select(); input.setSelectionRange(0, text.length);
        if (!document.execCommand('copy')) throw new Error('复制未成功');
    } finally { input.remove(); active?.focus({ preventScroll: true }); }
}

const paths = {
    branch: '<path d="M6 4v11a5 5 0 0 0 5 5h7M6 9h5a5 5 0 0 0 5-5"/><circle cx="6" cy="3" r="2"/><circle cx="16" cy="3" r="2"/><circle cx="19" cy="20" r="2"/>',
    history: '<path d="M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    conversation: '<rect x="3" y="3" width="15" height="13" rx="2"/><path d="m7 16-4 4v-4M18 7h3v14l-4-3h-6v-2"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', plus: '<path d="M12 4v16M4 12h16"/>',
    left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m10 6 6 6-6 6"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16"/>',
    people: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v3"/>',
    down: '<path d="m6 9 6 6 6-6"/>', up: '<path d="m6 15 6-6 6 6"/>',
    top: '<path d="M5 4h14M12 20V8m-5 5 5-5 5 5"/>',
    bottom: '<path d="M5 20h14M12 4v12m-5-5 5 5 5-5"/>',
    send: '<path d="M12 20V4m-6 6 6-6 6 6"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    forward: '<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    settings: '<path d="M5 4v16M12 4v16M19 4v16M2 8h6M9 16h6M16 9h6"/>',
    edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
    save: '<path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/>',
    insert: '<path d="M14 4h6v16H4v-6M3 8h11m-4-4 4 4-4 4"/>',
    refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
    sort: '<path d="M3 6h18M6 12h12M9 18h6"/>', check: '<path d="m5 12 4 4L19 6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    cup: '<path d="M4 9h14v6a6 6 0 0 1-12 0V9M18 10h2a3 3 0 0 1 0 6h-2M3 22h18M9 6c-3-2 3-3 0-5M14 6c-3-2 3-3 0-5"/>',
    asterisk: '<path d="M12 4v16M4 12h16M6.35 6.35l11.3 11.3M6.35 17.65l11.3-11.3"/>',
};

export function glyph(name) {
    const holder = element('span', undefined, 'tea-glyph');
    holder.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
    return holder;
}

export function iconButton(name, label, action) {
    const node = textButton('', action); node.className = 'tea-icon'; node.title = label;
    node.setAttribute('aria-label', label); node.append(glyph(name)); return node;
}
