import { element, textButton, iconButton, glyph } from './ui.js';
import { renderPlayText } from './play-render.js';

const activePhases = new Set(['preparing', 'generating', 'retry-wait']);
export const playResultStatusText = { preparing: '正在准备', generating: '正在生成', 'retry-wait': '等待自动重试',
    saving: '正在保存', 'save-failed': '尚未保存', unfinished: '未完成', failed: '生成失败', stopped: '已停止' };

let replyToolsId = 0, replyToolsDismissalBound = false;

/** Use the same hidden-floor icons as SillyTavern's message controls. */
export function createPlayFloorIcon(name) {
    const icon = element('span', undefined, `fa-solid fa-${name} play-floor-icon`);
    icon.setAttribute('aria-hidden', 'true'); return icon;
}

/** User messages and replies reveal their secondary buttons inline on both layouts. */
export function setupPlayReplyHeaderActions(tools, { branch, prompt, remove, favorite, edit, visibility, role = 'assistant' }) {
    tools.classList.add('play-reply-tools'); tools.id = `play-reply-tools-${++replyToolsId}`;
    const secondary = [branch, prompt, visibility, remove].filter(Boolean);
    for (const button of secondary) button.classList.add('play-reply-secondary');
    const more = iconButton('more', role === 'user' ? '更多消息操作' : '更多回复操作', () => {
        tools.classList.add('is-expanded'); more.setAttribute('aria-expanded', 'true');
        [...secondary, favorite, edit].find(button => !button.hidden && !button.disabled)?.focus({ preventScroll: true });
    });
    more.classList.add('play-reply-more'); more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', tools.id);
    tools.replaceChildren(...(role === 'user' ? [visibility, favorite, edit, remove, more].filter(Boolean) : [...secondary, favorite, edit, more]));
    tools.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !tools.classList.contains('is-expanded')) return;
        event.preventDefault(); event.stopPropagation(); tools.classList.remove('is-expanded');
        more.setAttribute('aria-expanded', 'false'); more.focus({ preventScroll: true });
    });
    if (!replyToolsDismissalBound) {
        document.addEventListener('pointerdown', event => {
            for (const opened of document.querySelectorAll('.play-reply-tools.is-expanded')) {
                if (opened.contains(event.target)) continue;
                opened.classList.remove('is-expanded'); opened.querySelector('.play-reply-more')?.setAttribute('aria-expanded', 'false');
            }
        });
        replyToolsDismissalBound = true;
    }
    return more;
}

/** Both conversation pages use the same button groups and layout. */
export function createPlayReplyActions({ onPrevious, onNext, onChoose, onAgain, onContinue, onStop, onTop }) {
    const actions = element('footer', undefined, 'play-message-actions');
    const actionGroup = element('div', undefined, 'play-action-group');
    const again = iconButton('refresh', '重新生成', onAgain); again.classList.add('play-again');
    const continueBtn = iconButton('forward', '续写', onContinue); continueBtn.classList.add('play-continue');
    actionGroup.append(again, continueBtn);
    const swipes = element('div', undefined, 'play-swipes');
    swipes.setAttribute('role', 'group'); swipes.setAttribute('aria-label', '切换这条回复的生成结果');
    const prev = iconButton('left', '上一个结果', onPrevious), next = iconButton('right', '下一个结果', onNext);
    const count = textButton('', onChoose); count.className = 'play-count';
    count.setAttribute('aria-haspopup', 'listbox'); count.setAttribute('aria-expanded', 'false');
    swipes.append(prev, count, next);
    const stop = iconButton('stop', '停止这份回复', onStop); stop.classList.add('play-stop'); stop.hidden = true;
    const assistantTop = iconButton('top', '回到这条消息开头', onTop); assistantTop.classList.add('play-message-top'); assistantTop.hidden = true;
    const rightActions = element('div', undefined, 'play-right-actions'); rightActions.append(stop, assistantTop);
    actions.append(actionGroup, swipes, rightActions);
    return { actions, actionGroup, again, continueBtn, swipes, prev, next, count, stop, assistantTop };
}

export function showPlayReplyStop(job, multipleActive) {
    return !!job && multipleActive && activePhases.has(job.phase);
}

export function syncPlayReplyFooter(view, editing = false) {
    const hidden = editing || [view.swipes, view.again, view.continueBtn, view.stop, view.assistantTop].every(node => node.hidden);
    if (view.actions.hidden !== hidden) view.actions.hidden = hidden;
}

export function updatePlayReplyCount(count, index, total) {
    const label = `第 ${index + 1} / ${total} 个结果，选择历史结果`;
    if (count.getAttribute('aria-label') === label) return;
    count.replaceChildren(element('span', String(index + 1)), element('small', `/ ${total}`), glyph('down'));
    count.setAttribute('aria-label', label); count.title = '选择历史结果';
}

/** Shared result-list presentation, placement and keyboard interaction. */
export function createPlayResultMenu() {
    let current;
    function close(restore = true) {
        if (!current) return;
        const { menu, opener, root, dismiss, resize, scroll } = current;
        current = null; menu.remove(); root.removeEventListener('pointerdown', dismiss);
        window.removeEventListener('resize', resize); scroll.feed.removeEventListener('scroll', scroll.dismiss);
        opener.setAttribute('aria-expanded', 'false'); opener.removeAttribute('aria-controls');
        if (restore && opener.isConnected) opener.focus({ preventScroll: true });
    }
    function toggle({ key, root, readingArea, feed, opener, alignment = opener, entries, selectedId, label = '生成结果', onSelect }) {
        if (current?.key === key) { close(); return; }
        close(false);
        const menu = element('div', undefined, 'play-result-menu');
        menu.id = 'play-result-menu'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label);
        for (const [index, entry] of entries.entries()) {
            const option = textButton('', () => { close(); onSelect(entry.id); }); option.className = 'play-result-option';
            const selected = entry.id === selectedId;
            option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(selected)); option.tabIndex = selected ? 0 : -1;
            const copy = element('span', undefined, 'play-result-option-copy');
            copy.append(element('span', entry.text || '无正文', 'play-result-opening'), element('time', entry.time, 'play-result-time'));
            const check = glyph('check'); check.classList.add('play-result-check');
            option.append(element('span', String(index + 1).padStart(2, '0'), 'play-result-number'), copy, check); menu.append(option);
        }
        if (!menu.children.length) return;
        const dismiss = event => { if (!menu.contains(event.target) && !opener.contains(event.target)) close(false); };
        const resize = () => close(false), scrollTop = feed.scrollTop;
        const scroll = { feed, dismiss: () => { if (feed.scrollTop !== scrollTop) close(false); } };
        current = { key, menu, opener, root, dismiss, resize, scroll };
        root.append(menu); root.addEventListener('pointerdown', dismiss); window.addEventListener('resize', resize);
        feed.addEventListener('scroll', scroll.dismiss, { passive: true });
        opener.setAttribute('aria-controls', menu.id); opener.setAttribute('aria-expanded', 'true');
        const mobile = matchMedia('(max-width: 760px)').matches;
        const bounds = root.getBoundingClientRect(), area = readingArea.getBoundingClientRect(), anchor = opener.getBoundingClientRect();
        const inset = 12, gap = 8, align = (mobile ? alignment : opener).getBoundingClientRect();
        if (mobile) menu.style.width = `${Math.min(align.width, bounds.width - inset * 2)}px`;
        const above = Math.max(0, anchor.top - area.top - gap - inset), below = Math.max(0, area.bottom - anchor.bottom - gap - inset);
        const upwards = below < Math.min(menu.scrollHeight, 340) && above > below;
        const room = Math.min(340, upwards ? above : below), rowHeight = menu.firstElementChild.getBoundingClientRect().height;
        const style = getComputedStyle(menu), paddingTop = parseFloat(style.paddingTop), paddingBottom = parseFloat(style.paddingBottom);
        const rows = Math.max(1, Math.floor((room - paddingTop - paddingBottom) / rowHeight));
        menu.style.maxHeight = `${Math.min(room, rows * rowHeight + paddingTop + paddingBottom)}px`;
        menu.style.left = `${Math.max(inset, Math.min(align.left - bounds.left, bounds.width - menu.offsetWidth - inset))}px`;
        menu.style.top = `${upwards ? anchor.top - bounds.top - gap - menu.offsetHeight : anchor.bottom - bounds.top + gap}px`;
        const options = [...menu.children];
        const focusOption = option => {
            for (const node of options) node.tabIndex = node === option ? 0 : -1;
            option.focus({ preventScroll: true });
            if (option.offsetTop - paddingTop < menu.scrollTop) menu.scrollTop = option.offsetTop - paddingTop;
            else if (option.offsetTop + option.offsetHeight + paddingBottom > menu.scrollTop + menu.clientHeight) {
                menu.scrollTop = option.offsetTop + option.offsetHeight + paddingBottom - menu.clientHeight;
            }
        };
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
            else if (event.key === 'Tab') close();
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const index = options.indexOf(document.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                    : index + (event.key === 'ArrowDown' ? 1 : -1);
                focusOption(options[Math.max(0, Math.min(options.length - 1, next))]);
            }
        });
        focusOption(menu.querySelector('[aria-selected=true]') ?? options[0]);
    }
    return { toggle, close };
}

/** Keep notices in the reply body, using the existing playground behavior. */
export function renderPlayReply(output, result, { displayText, job, error, anchor, editing = false }) {
    const pendingSave = job?.resultId === result.id && (job.phase === 'save-failed' || job.unsaved && job.phase === 'saving');
    const retryingSave = pendingSave && job.phase === 'saving';
    const retryMessage = job?.retry && activePhases.has(job.phase)
        ? job.phase === 'retry-wait'
            ? `遇到${job.retry.reason === 'rateLimit' ? ' 429' : '空内容'}，${job.retry.remainingSeconds} 秒后进行第 ${job.retry.attempt}/${job.retry.maxRetries} 次自动重试。`
            : `正在进行第 ${job.retry.attempt}/${job.retry.maxRetries} 次自动重试。`
        : '';
    const errorMessage = retryingSave ? '正在保存…' : pendingSave ? result.error?.message || '回复尚未保存，请重试。'
        : ['failed', 'save-failed'].includes(result.status) ? result.error?.message || '' : '';
    const renderHtml = ['saving', 'complete', 'stopped', 'failed', 'save-failed'].includes(result.status);
    const signature = result.text ? `${renderHtml}:${displayText}` : `${result.status}:${!!errorMessage}:${!!retryMessage}`;
    if (!editing && output.signature !== signature) {
        if (result.text) {
            if (displayText.trim()) renderPlayText(output.box, displayText, anchor, renderHtml, true);
            else output.box.replaceChildren(element('p', '内容已隐藏', 'play-result-empty'));
        } else if (errorMessage || retryMessage) output.box.replaceChildren();
        else {
            const waiting = activePhases.has(result.status);
            const message = waiting ? playResultStatusText[result.status] : result.status === 'failed' ? '这次没有收到回复。'
                : result.status === 'stopped' ? '这次生成已停止。' : result.status === 'unfinished' ? '这次生成未完成，没有已保存的正文。' : playResultStatusText[result.status] || '';
            const text = element('p', message, waiting ? 'play-waiting' : 'play-result-empty');
            text.setAttribute('role', 'status'); text.dataset.readAnchor = `${anchor}/0`; output.box.replaceChildren(text);
        }
        output.signature = signature;
    }
    output.box.dataset.status = result.status;
    error.textContent = retryMessage || errorMessage; error.hidden = !(retryMessage || errorMessage) || editing;
    error.setAttribute('role', retryingSave || retryMessage ? 'status' : 'alert');
    error.classList.toggle('is-saving', !!(retryingSave || retryMessage)); error.dataset.readAnchor = `${anchor}/error`;
    output.box.append(error);
}

/** One input-height calculation for playground drafts and branch drafts. */
export function createPlayInputSizer({ input, compose, page, isVisible, isComposing, getContextHeight = () => 0 }) {
    const nativeSizing = CSS.supports('field-sizing', 'content'); input.classList.toggle('is-native-sized', nativeSizing);
    let lastValue, lastWidth, lastPageHeight;
    return { nativeSizing, resize(force = false) {
        if (!isVisible() || !page.clientHeight) return;
        const value = nativeSizing ? null : input.value, width = input.clientWidth, pageHeight = page.clientHeight;
        if (!nativeSizing && !force && value === lastValue && width === lastWidth && pageHeight === lastPageHeight) return;
        lastValue = value; lastWidth = width; lastPageHeight = pageHeight;
        const previousScroll = input.scrollTop, style = getComputedStyle(input);
        const line = parseFloat(style.lineHeight) || 20, padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const maxLines = matchMedia('(max-width: 760px)').matches ? 8 : 20, footerStyle = getComputedStyle(compose);
        const available = pageHeight - getContextHeight() - (parseFloat(footerStyle.paddingTop) || 0) - (parseFloat(footerStyle.paddingBottom) || 0) - 32;
        const maximum = Math.max(line + padding, Math.min(maxLines * line + padding, available));
        const maximumHeight = `${maximum}px`;
        if (input.style.maxHeight !== maximumHeight) input.style.maxHeight = maximumHeight;
        if (input.dataset.maxLines !== String(maxLines)) input.dataset.maxLines = String(maxLines);
        if (nativeSizing || isComposing()) return;
        input.style.height = 'auto';
        input.style.height = `${Math.max(line + padding, Math.min(input.scrollHeight, maximum))}px`;
        input.scrollTop = previousScroll;
    } };
}
