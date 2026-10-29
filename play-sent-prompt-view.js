import { element, textButton, iconButton, copyText } from './ui.js';
import { formatSentPrompt, sentPromptCapture } from './play-sent-prompt.js';

export function showSentPromptViewer(panel, resultId, capture = sentPromptCapture) {
    const existing = panel.querySelector('.play-sent-prompt-overlay');
    if (existing) { existing.querySelector('button')?.focus(); return; }
    const active = document.activeElement;
    const overlay = element('section', undefined, 'play-sent-prompt-overlay');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '实际发送的提示词');
    const head = element('header', undefined, 'play-sent-prompt-head');
    const close = () => { unsubscribe(); overlay.remove(); active?.focus({ preventScroll: true }); };
    head.append(element('h2', '实际发送的提示词'), iconButton('close', '关闭提示词查看', close));
    const controls = element('div', undefined, 'play-sent-prompt-controls');
    const copy = textButton('复制提示词', async () => {
        status.hidden = false;
        try { await copyText(body.textContent); status.textContent = '提示词已复制。'; }
        catch { status.textContent = '复制失败，请选中正文后手动复制。'; }
    });
    controls.append(copy);
    const status = element('p', '', 'play-sent-prompt-status'); status.setAttribute('role', 'status');
    const body = element('pre', '', 'play-sent-prompt-body'); body.tabIndex = 0;
    body.setAttribute('aria-label', '实际提示词正文');
    function refresh() {
        const prompt = capture?.read(resultId);
        body.textContent = prompt ? formatSentPrompt(prompt) : '';
        body.hidden = !prompt; copy.disabled = !prompt;
        status.textContent = prompt ? '' : '这条回复没有可查看的提示词。';
        status.hidden = !status.textContent;
    }
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...overlay.querySelectorAll('button, pre[tabindex]')].filter(node => !node.disabled && !node.hidden);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    const unsubscribe = capture?.subscribe(refresh) ?? (() => {});
    overlay.append(head, controls, status, body); panel.append(overlay); refresh();
    head.querySelector('button').focus({ preventScroll: true });
    return { dispose() { unsubscribe(); overlay.remove(); } };
}
