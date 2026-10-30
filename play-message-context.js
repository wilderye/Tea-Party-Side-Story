/** Protect the reply being generated or waiting for its save, wherever it is read. */
export function playMessageIsPending(message, jobs = []) {
    return !!message && (message.results?.some(result => ['unfinished', 'preparing', 'generating', 'retry-wait', 'saving', 'save-failed'].includes(result.status))
        || jobs.some(job => job.messageId === message.id || message.results?.some(result => result.id === job.resultId || result.id === job.replaceResultId)));
}

/** Derived from the supplied transcript; hidden floors keep their floor numbers. */
export function playMessageDepths(messages, { isContinue = false, include = message => !message.hidden } = {}) {
    const depths = new Map();
    let depth = isContinue ? -1 : 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (include(message)) depths.set(message, depth++);
    }
    return depths;
}

/** Keep the operation target separate from the history it replaces. */
export function playRequestMessages(messages) {
    const history = messages.slice();
    const target = history.pop();
    const user = history.at(-1)?.role === 'user' ? history.pop() : null;
    return { history, user, target };
}

export function playHiddenRanges(messages) {
    const ranges = [];
    for (let floor = 0; floor < messages.length; floor++) {
        if (!messages[floor].hidden) continue;
        const last = ranges.at(-1);
        if (last && last.end + 1 === floor) last.end = floor;
        else ranges.push({ start: floor, end: floor });
    }
    return ranges.map(range => range.start === range.end ? String(range.start) : `${range.start}–${range.end}`).join('、');
}

/** The playground reads the original pair, using its source floor visibility. */
export function playRoundDepth(round, role = 'assistant') {
    const messages = [];
    if (round.prompt !== null) messages.push({ role: 'user', hidden: round.initialUserHidden });
    if (round.results.length) messages.push({ role: 'assistant', hidden: round.initialAssistantHidden });
    const message = messages.find(message => message.role === role);
    return playMessageDepths(messages).get(message);
}
