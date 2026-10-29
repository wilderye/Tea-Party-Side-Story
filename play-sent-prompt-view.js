import { element, textButton, iconButton, copyText } from './ui.js';
import { formatSentPrompt, sentPromptCapture } from './play-sent-prompt.js';

export function showSentPromptViewer(panel, resultId, capture = sentPromptCapture) {
    const existing = panel.querySelector('.play-sent-prompt-overlay');
    if (existing) { existing.querySelector('select')?.focus(); return; }
    const active = document.activeElement;
    const overlay = element('section', undefined, 'play-sent-prompt-overlay');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '实际发送的提示词');
    const head = element('header', undefined, 'play-sent-prompt-head');
    const close = () => { unsubscribe(); overlay.remove(); active?.focus({ preventScroll: true }); };
    head.append(element('h2', '实际发送的提示词'), iconButton('close', '关闭提示词查看', close));
    const controls = element('div', undefined, 'play-sent-prompt-controls');
    const select = element('select'); select.setAttribute('aria-label', '选择发送记录');
    const tabs = element('div', undefined, 'play-sent-prompt-tabs');
    let stage = 'browser', selectedId = null, selectedServer = 0;
    const browserButton = textButton('小剧场发给酒馆', () => { stage = 'browser'; refresh(); });
    const serverButton = textButton('酒馆发给模型', () => { stage = 'server'; refresh(); });
    tabs.append(browserButton, serverButton);
    const attempts = element('select'); attempts.setAttribute('aria-label', '选择服务器发送');
    const copy = textButton('复制提示词', async () => {
        status.hidden = false;
        try { await copyText(body.textContent); status.textContent = '提示词已复制。'; }
        catch { status.textContent = '复制失败，请选中正文后手动复制。'; }
    });
    const clear = textButton('清空记录', () => capture?.clear(resultId));
    controls.append(select, attempts, copy, clear);
    const note = element('p', '刷新页面或重启酒馆后清空。', 'play-sent-prompt-note');
    const status = element('p', '', 'play-sent-prompt-status'); status.setAttribute('role', 'status');
    const body = element('pre', '', 'play-sent-prompt-body'); body.tabIndex = 0;
    body.setAttribute('aria-label', '实际提示词正文');
    select.addEventListener('change', () => { selectedId = select.value; selectedServer = 0; refresh(); });
    attempts.addEventListener('change', () => { selectedServer = Number(attempts.value); refresh(); });
    function refresh() {
        const snapshot = capture?.read() ?? {};
        const records = resultId ? (snapshot.records ?? []).filter(record => record.resultId === resultId) : [];
        const serverStatus = snapshot.serverStatus ?? '';
        if (!records.some(record => record.id === selectedId)) selectedId = records.at(-1)?.id ?? null;
        select.replaceChildren(...records.map((record, index) => {
            const option = element('option', `第 ${index + 1} 次发送 · ${new Date(record.sentAt).toLocaleTimeString()}`);
            option.value = record.id; return option;
        }));
        select.value = selectedId ?? ''; select.disabled = !records.length; select.hidden = records.length < 2;
        const record = records.find(record => record.id === selectedId);
        browserButton.setAttribute('aria-pressed', String(stage === 'browser'));
        serverButton.setAttribute('aria-pressed', String(stage === 'server'));
        attempts.hidden = stage !== 'server' || (record?.server.length ?? 0) < 2;
        attempts.replaceChildren(...(record?.server ?? []).map((send, index) => {
            const option = element('option', `服务器第 ${index + 1} 次发送 · ${new Date(send.sentAt).toLocaleTimeString()}`);
            option.value = String(index); return option;
        }));
        selectedServer = Math.min(selectedServer, Math.max(0, (record?.server.length ?? 0) - 1));
        attempts.value = String(selectedServer);
        const prompt = stage === 'browser' ? record?.browser : record?.server[selectedServer]?.prompt;
        body.textContent = prompt ? formatSentPrompt(prompt) : '';
        body.hidden = !prompt; copy.disabled = !prompt; clear.disabled = !records.length;
        status.textContent = !record ? '这条回复没有可查看的发送记录，或记录已清空。'
            : prompt ? ''
            : record.serverExpected ? `${serverStatus} 尚未取得这次发送的原文。`
            : record.serverStatus;
        status.hidden = !status.textContent;
    }
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...overlay.querySelectorAll('button, select, pre[tabindex]')].filter(node => !node.disabled && !node.hidden);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    const unsubscribe = capture?.subscribe(refresh) ?? (() => {});
    overlay.append(head, note, tabs, controls, status, body); panel.append(overlay); refresh();
    head.querySelector('button').focus({ preventScroll: true });
    return { dispose() { unsubscribe(); overlay.remove(); } };
}
