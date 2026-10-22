import { element, textButton } from './ui.js';
import { formatDiagnostic } from './diagnostics.js';

function renderEntry(entry) {
    const item = element('pre', formatDiagnostic(entry), 'tea-log-entry');
    item.dataset.level = entry.level; item.dataset.id = entry.id;
    return item;
}

export function renderDiagnostics(area, diagnostics, viewState) {
    const section = element('section', undefined, 'tea-settings-group tea-diagnostics');
    section.append(element('h3', '插件日志'));
    const controls = element('div', undefined, 'tea-log-controls');
    const list = element('div', undefined, 'tea-log-list'); list.hidden = !viewState?.open; list.tabIndex = 0;
    list.setAttribute('role', 'log'); list.setAttribute('aria-label', '插件运行日志');
    list.setAttribute('aria-live', 'polite'); list.setAttribute('aria-relevant', 'additions');
    const nodes = new Map();
    let scrollTop = viewState?.scrollTop ?? 0, followTail = viewState?.followTail ?? true;
    const restore = () => { if (!list.hidden) list.scrollTop = followTail ? list.scrollHeight : scrollTop; };
    const viewButton = textButton('查看日志', () => {
        list.hidden = !list.hidden; viewButton.setAttribute('aria-expanded', String(!list.hidden));
        restore();
    });
    viewButton.setAttribute('aria-expanded', String(!list.hidden));
    list.addEventListener('scroll', () => {
        if (list.hidden || !list.isConnected) return;
        scrollTop = list.scrollTop; followTail = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    });
    const notice = element('p', '', 'tea-setting-description'); notice.setAttribute('role', 'status');
    const exportButton = textButton('导出日志', () => {
        const url = URL.createObjectURL(new Blob([diagnostics.export()], { type: 'text/plain;charset=utf-8' }));
        const link = element('a'); link.href = url; link.download = `茶话会插件日志-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const clearButton = textButton('清空日志', () => diagnostics.clear());
    controls.append(viewButton, exportButton, clearButton);
    function refresh() {
        const { entries, persistenceError } = diagnostics.read();
        viewButton.textContent = `查看日志（${entries.length} 条）`;
        notice.textContent = persistenceError || '按时间记录插件运行情况和完整错误；不附带提示词或密钥。';
        clearButton.disabled = entries.length === 0;
        // Preserve the visible line and text selection while new logs arrive.
        const top = list.getBoundingClientRect().top;
        const anchor = !followTail && !list.hidden ? [...nodes.values()].find(node => node.getBoundingClientRect().bottom > top) : null;
        const anchorTop = anchor?.getBoundingClientRect().top;
        const ids = new Set(entries.map(entry => entry.id));
        for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
        list.querySelector('.tea-log-empty')?.remove();
        for (const entry of entries) {
            if (nodes.has(entry.id)) continue;
            const node = renderEntry(entry); nodes.set(entry.id, node); list.append(node);
        }
        if (!entries.length) {
            list.append(element('p', '暂无日志', 'tea-setting-description tea-log-empty'));
            scrollTop = 0; followTail = true;
        } else if (anchor?.isConnected) scrollTop = list.scrollTop + anchor.getBoundingClientRect().top - anchorTop;
        if (list.isConnected) restore();
    }
    section.append(controls, notice, list); area.append(section); refresh();
    const unsubscribe = diagnostics.subscribe(refresh);
    return { restore, dispose: unsubscribe, capture: () => ({ open: !list.hidden, scrollTop, followTail }) };
}
