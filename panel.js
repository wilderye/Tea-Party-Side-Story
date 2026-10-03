import { findEntries, isManuscript } from './library.js';

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
function iconButton(icon, label, action) {
    const node = textButton('', action); node.className = 'tea-icon'; node.title = label;
    node.setAttribute('aria-label', label);
    if (icon === 'star') {
        node.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.6l6.3-.9Z"/></svg>';
    } else {
        const glyph = element('i', undefined, `fa-solid fa-${icon}`); glyph.setAttribute('aria-hidden', 'true');
        node.append(glyph);
    }
    return node;
}

export function createTheatrePanel(ctx, state, actions) {
    let panel, popup, opening = false, observer, measureFrame, resizeViewport;
    let scope = 'community', type = 'standalone', query = '', page = 0, mode = 'list';
    let draft, originalDraft, busy = false, confirming = false, message = '', returnScroll = 0;
    const expanded = new Set();
    const dirty = () => mode === 'editor' && JSON.stringify(draft) !== originalDraft;
    async function confirm(text, actionLabel) {
        const content = element('div', text, 'tea-confirm');
        return await ctx().callGenericPopup(content, ctx().POPUP_TYPE.CONFIRM, '', { okButton: actionLabel, cancelButton: '取消' }) === ctx().POPUP_RESULT.AFFIRMATIVE;
    }
    async function canLeave() {
        if (busy || confirming) return false;
        if (!dirty()) return true;
        confirming = true;
        try { return await confirm('手稿有未保存的修改，确定放弃吗？', '放弃修改'); }
        finally { confirming = false; }
    }
    async function close() { if (popup) await popup.complete(ctx().POPUP_RESULT.CANCELLED); }
    function showMessage(text) {
        message = text;
        const status = panel?.querySelector('.tea-status');
        if (status) status.textContent = message || state.status;
    }
    function measureBodies() {
        cancelAnimationFrame(measureFrame);
        measureFrame = requestAnimationFrame(() => {
            if (!panel) return;
            for (const article of panel.querySelectorAll('article[data-id]')) {
                const body = article.querySelector('.tea-body'), toggle = article.querySelector('.tea-fold');
                toggle.hidden = !expanded.has(article.dataset.id) && body.scrollHeight <= body.clientHeight + 1;
            }
        });
    }
    function beginEdit(item) {
        returnScroll = panel.querySelector('.tea-list')?.scrollTop ?? 0;
        draft = item ? { id: item.id, title: item.title, type: item.type, body: item.body }
            : { title: '', type, body: '' };
        originalDraft = JSON.stringify(draft); mode = 'editor'; message = ''; render();
    }
    async function select(item) {
        if (!state.settings.enabled) return;
        const input = document.querySelector('#send_textarea');
        if (!input) { showMessage('当前没有可用的聊天输入框'); return; }
        input.value += `${input.value ? '\n' : ''}${item.body}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await close(); input.focus();
    }
    function render() {
        if (!panel) return;
        const scroll = panel.querySelector('.tea-list')?.scrollTop ?? 0;
        const oldSearch = panel.querySelector('input[type="search"]');
        const focused = oldSearch && document.activeElement === oldSearch, cursor = oldSearch?.selectionStart;
        panel.replaceChildren();
        const header = element('header', undefined, 'tea-header');
        if (mode !== 'list') header.append(iconButton('arrow-left', '返回剧场列表', async () => {
            if (!await canLeave()) return;
            mode = 'list'; message = ''; render(); panel.querySelector('.tea-list').scrollTop = returnScroll;
        }));
        header.append(element('h2', mode === 'editor' ? '亲笔手稿' : mode === 'settings' ? '插件设置' : mode === 'help' ? '宏用法' : '茶话会小剧场'));
        const headerActions = element('div', undefined, 'tea-actions');
        if (mode === 'list') headerActions.append(iconButton('sliders', '插件设置', () => { mode = 'settings'; message = ''; render(); }));
        if (mode === 'editor') {
            const save = iconButton('check', '保存手稿', () => panel.querySelector('form').requestSubmit()); save.classList.add('tea-primary'); save.disabled = busy;
            headerActions.append(save);
        }
        const exit = iconButton('xmark', '关闭面板', close); exit.disabled = busy; headerActions.append(exit);
        header.append(headerActions); panel.append(header);
        if (!state.settings.enabled && mode !== 'settings') {
            panel.append(element('p', '插件已停用，请在扩展设置中重新启用。', 'tea-empty')); return;
        }
        if (mode === 'editor') renderEditor();
        else if (mode === 'settings') renderSettings();
        else if (mode === 'help') renderHelp();
        else renderList();
        const status = element('div', message || state.status, 'tea-status'); status.setAttribute('role', 'status'); panel.append(status);
        if (mode === 'list') {
            panel.querySelector('.tea-list').scrollTop = scroll;
            if (focused) { const input = panel.querySelector('input[type="search"]'); input.focus(); if (cursor !== null) input.setSelectionRange(cursor, cursor); }
            measureBodies();
        }
    }
    function renderList() {
        const tabs = element('nav', undefined, 'tea-tabs'); tabs.setAttribute('aria-label', '剧场范围');
        for (const [value, label] of [['community','茶会选集'], ['favorites','我的收藏'], ['local','亲笔手稿']]) {
            const button = textButton(label, () => { scope = value; page = 0; message = ''; render(); panel.querySelector('.tea-list').scrollTop = 0; });
            button.setAttribute('aria-pressed', String(scope === value)); tabs.append(button);
        }
        panel.append(tabs);
        const controls = element('div', undefined, 'tea-controls'), kinds = element('div', undefined, 'tea-kinds');
        for (const [value, label] of [['standalone','独立剧场'], ['preset','随文剧场']]) {
            const button = textButton(label, () => { type = value; page = 0; message = ''; render(); panel.querySelector('.tea-list').scrollTop = 0; });
            button.setAttribute('aria-pressed', String(type === value)); kinds.append(button);
        }
        controls.append(kinds);
        const searchLine = element('div', undefined, 'tea-search-line');
        const searchBox = element('label', undefined, 'tea-search-box'), searchGlyph = element('i', undefined, 'fa-solid fa-magnifying-glass');
        searchGlyph.setAttribute('aria-hidden', 'true');
        const input = element('input'); input.type = 'search'; input.placeholder = '搜索剧场'; input.value = query;
        input.setAttribute('aria-label', '搜索标题、正文或署名');
        input.addEventListener('input', () => { query = input.value; page = 0; render(); panel.querySelector('.tea-list').scrollTop = 0; });
        searchBox.append(searchGlyph, input); searchLine.append(searchBox);
        if (scope === 'community') {
            const refresh = iconButton('rotate', '更新茶会选集', actions.updateLibrary); refresh.disabled = state.updating; searchLine.append(refresh);
        }
        if (scope === 'local') {
            const add = iconButton('plus', '添加手稿', () => beginEdit()); add.classList.add('tea-primary'); add.disabled = !!state.personalError; searchLine.append(add);
        }
        controls.append(searchLine); panel.append(controls);
        const matches = findEntries(state.entries, { scope, type, query, favorites: state.settings.favorites });
        const pageSize = [5,10,20,50].includes(state.settings.pageSize) ? state.settings.pageSize : 10;
        const pages = Math.max(1, Math.ceil(matches.length / pageSize)); page = Math.min(page, pages - 1);
        const list = element('div', undefined, 'tea-list tea-scroll');
        if (state.personalError && scope !== 'community') list.append(element('p', state.personalError, 'tea-error'));
        for (const item of matches.slice(page * pageSize, (page + 1) * pageSize)) {
            const article = element('article'); article.dataset.id = item.id;
            article.append(element('h3', item.title));
            const body = element('div', item.body, 'tea-body'); body.id = `tea-body-${item.id.replaceAll(':', '-')}`;
            body.classList.toggle('tea-collapsed', !expanded.has(item.id)); article.append(body);
            const fold = iconButton(expanded.has(item.id) ? 'chevron-up' : 'chevron-down', expanded.has(item.id) ? '收起正文' : '展开全文', () => {
                const wasExpanded = expanded.has(item.id);
                if (wasExpanded) expanded.delete(item.id); else expanded.add(item.id);
                render();
                if (wasExpanded) panel.querySelector(`article[data-id="${item.id}"]`)?.scrollIntoView({ block: 'nearest' });
            });
            fold.classList.add('tea-fold'); fold.setAttribute('aria-expanded', String(expanded.has(item.id))); fold.setAttribute('aria-controls', body.id); article.append(fold);
            const footer = element('div', undefined, 'tea-entry-footer');
            const caption = item.author ?? (scope === 'favorites' ? '亲笔手稿' : ''); footer.append(element('span', caption, 'tea-author'));
            const buttons = element('div', undefined, 'tea-actions'); const favorite = Object.hasOwn(state.settings.favorites, item.id);
            const star = iconButton('star', favorite ? '取消收藏' : '收藏', () => { actions.toggleFavorite(item.id); render(); });
            star.setAttribute('aria-pressed', String(favorite)); star.classList.add('tea-star'); buttons.append(star);
            if (isManuscript(item.id)) {
                const edit = iconButton('pen', '编辑手稿', () => beginEdit(item)); edit.disabled = !!state.personalError; buttons.append(edit);
            }
            if (item.type === 'standalone') {
                const use = iconButton('circle-check', '选用：放入聊天输入框，由你发送', () => select(item)); use.classList.add('tea-primary'); buttons.append(use);
            }
            footer.append(buttons); article.append(footer); list.append(article);
        }
        if (!matches.length) {
            const text = query.trim() ? '没有找到符合条件的剧场' : scope === 'favorites' ? `还没有收藏${type === 'preset' ? '随文' : '独立'}剧场`
                : scope === 'local' ? '在这里保存你自己的剧场提示词。' : '茶会选集里还没有这类剧场，可检查更新。';
            list.append(element('p', text, 'tea-empty'));
        }
        panel.append(list);
        const footer = element('footer', undefined, 'tea-pagination'); const size = element('select'); size.setAttribute('aria-label', '每页条数');
        for (const count of [5,10,20,50]) { const option = element('option', `${count} 条 / 页`); option.value = String(count); size.append(option); }
        size.value = String(pageSize); size.addEventListener('change', () => { state.settings.pageSize = Number(size.value); actions.saveSettings(); page = 0; render(); });
        const nav = element('div', undefined, 'tea-actions');
        const prev = iconButton('chevron-left', '上一页', () => { page--; render(); panel.querySelector('.tea-list').scrollTop = 0; }); prev.disabled = page === 0;
        const next = iconButton('chevron-right', '下一页', () => { page++; render(); panel.querySelector('.tea-list').scrollTop = 0; }); next.disabled = page + 1 >= pages;
        nav.append(prev, element('span', `${page + 1} / ${pages}`), next); footer.append(size, nav); panel.append(footer);
    }
    function renderEditor() {
        const form = element('form', undefined, 'tea-form tea-scroll');
        function field(text, tag, name) {
            const label = element('label', text, 'tea-field'), input = element(tag); input.name = name; input.value = draft[name] ?? ''; input.disabled = busy;
            input.addEventListener('input', () => { draft[name] = input.value; input.setCustomValidity(''); });
            label.append(input); form.append(label); return input;
        }
        const title = field('标题', 'input', 'title'); title.required = true; title.maxLength = 100;
        const kind = field('类型', 'select', 'type');
        for (const [value, label] of [['standalone','独立剧场'], ['preset','随文剧场']]) { const option = element('option', label); option.value = value; kind.append(option); }
        kind.value = draft.type;
        const body = field('剧场内容', 'textarea', 'body'); body.required = true; body.placeholder = '写下或粘贴你的剧场提示词…';
        if (draft.id) {
            const remove = iconButton('trash-can', '删除手稿', async () => {
                if (busy || confirming) return;
                confirming = true;
                let approved;
                try { approved = await confirm(`确定删除手稿「${draft.title}」吗？对应收藏也会移除。`, '删除手稿'); }
                finally { confirming = false; }
                if (!approved) return;
                busy = true; render();
                try { await actions.deleteManuscript(draft.id); mode = 'list'; message = '手稿已删除'; }
                catch (error) { message = error.message; }
                finally { busy = false; render(); }
            }); remove.disabled = busy; form.append(remove);
        }
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy) return;
            if (!draft.title.trim() || !draft.body.trim()) {
                const empty = !draft.title.trim() ? title : body; empty.setCustomValidity('请填写内容'); empty.reportValidity(); return;
            }
            busy = true; render();
            try {
                const item = await actions.saveManuscript(draft);
                if (!draft.id || type !== item.type) page = 0;
                if (!draft.id) query = '';
                type = item.type; mode = 'list'; message = '手稿已保存';
            } catch (error) { message = error.message; }
            finally { busy = false; render(); if (mode === 'list') panel.querySelector('.tea-list').scrollTop = returnScroll; }
        });
        panel.append(form);
    }
    function renderSettings() {
        const area = element('div', undefined, 'tea-scroll tea-settings');
        for (const [key, label] of [['enabled','启用插件'], ['qrEnabled','启用 QR 入口'], ['edgeEnabled','启用侧边折叠']]) {
            const row = element('label', undefined, 'tea-check'), input = element('input'); input.type = 'checkbox'; input.checked = state.settings[key];
            input.disabled = key !== 'enabled' && !state.settings.enabled;
            input.addEventListener('change', () => key === 'enabled' ? actions.setEnabled(input.checked) : actions.setEntrance(key, input.checked));
            row.append(input, element('span', label)); area.append(row);
        }
        const help = textButton('宏用法', () => { mode = 'help'; render(); }); help.className = 'tea-text-button'; area.append(help); panel.append(area);
    }
    function renderHelp() {
        const area = element('div', undefined, 'tea-scroll tea-help');
        for (const [title, macro, description] of [
            ['茶会随文剧场', '{{茶话会小剧场}}', '从茶会选集的随文剧场中随机抽取。'],
            ['收藏的随文剧场', '{{我收藏的小剧场}}', '从收藏的随文剧场中随机抽取，也包括收藏的亲笔手稿。'],
        ]) {
            area.append(element('h3', title)); const row = element('div', undefined, 'tea-macro'); row.append(element('code', macro));
            row.append(iconButton('copy', '复制宏', async () => {
                try { await navigator.clipboard.writeText(macro); showMessage('宏已复制，可粘贴到预设中'); }
                catch { showMessage('浏览器未允许复制，请选中宏文字手动复制。'); }
            })); area.append(row, element('p', description));
        }
        area.append(element('p', '把需要的宏放进预设即可使用；两个宏同时使用时各自输出一条。收藏为空时，收藏宏填空。'));
        panel.append(area);
    }
    return {
        async open() {
            if (popup || opening || !state.settings.enabled) return;
            opening = true;
            try {
                await actions.loaded;
                if (!state.settings.enabled) return;
                mode = 'list'; message = ''; panel = element('div'); panel.id = 'teahouse-panel'; render();
                const context = ctx();
                popup = new context.Popup(panel, context.POPUP_TYPE.TEXT, '', {
                    okButton: false, cancelButton: false, onClosing: canLeave,
                    onOpen: () => { measureBodies(); panel.querySelector('.tea-header button')?.focus({ preventScroll: true }); },
                });
                popup.dlg.classList.add('teahouse-dialog');
                resizeViewport = () => {
                    const viewport = window.visualViewport;
                    if (!viewport || !popup) return;
                    popup.dlg.style.setProperty('--tea-viewport-height', `${viewport.height}px`);
                    popup.dlg.style.setProperty('--tea-viewport-top', `${viewport.offsetTop}px`);
                };
                window.visualViewport?.addEventListener('resize', resizeViewport);
                window.visualViewport?.addEventListener('scroll', resizeViewport);
                resizeViewport();
                let lastWidth = 0;
                observer = new ResizeObserver(entries => {
                    const width = entries[0].contentRect.width;
                    if (width !== lastWidth) { lastWidth = width; measureBodies(); }
                }); observer.observe(panel);
                await popup.show();
            } finally {
                observer?.disconnect(); cancelAnimationFrame(measureFrame);
                window.visualViewport?.removeEventListener('resize', resizeViewport);
                window.visualViewport?.removeEventListener('scroll', resizeViewport);
                popup = null; panel = null; opening = false;
            }
        },
        refresh() { if (!panel) return; if (mode === 'editor') showMessage(message); else { message = ''; render(); } },
        close,
    };
}
