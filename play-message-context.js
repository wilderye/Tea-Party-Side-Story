export function playJobCanStop(job) {
    return !!job && ['preparing', 'generating', 'retry-wait'].includes(job.phase);
}

export function getPlayComposerAction({ prompt = '', chatMode = false, lastRole = null, jobs = [], allowStop = true } = {}) {
    const hasPrompt = !!prompt.trim();
    if (jobs.some(playJobCanStop) && (chatMode || !hasPrompt)) return allowStop ? 'stop' : null;
    if (hasPrompt) return 'send';
    return lastRole === 'user' || chatMode && lastRole === 'assistant' ? 'reply' : null;
}

export function playResultIsPending(result, jobs = [], pending = []) {
    return !!result && (['unfinished', 'preparing', 'generating', 'retry-wait'].includes(result.status)
        || jobs.some(job => playJobCanStop(job) && (job.resultId === result.id || job.replaceResultId === result.id))
        || pending.some(operation => ['begin', 'result'].includes(operation.kind) && operation.resultId === result.id));
}

export function playMessageIsPending(message, jobs = [], pending = []) {
    return !!message && (message.results?.some(result => playResultIsPending(result, jobs, pending))
        || jobs.some(job => playJobCanStop(job) && job.messageId === message.id));
}

export function getPlayActionPermission(action, { chat, round, message, messageId, result, resultId, role = 'assistant',
    isLast, chatMode = false, jobs = [], pending = [] } = {}) {
    if (round) {
        const userId = round.initialUserId ?? `${round.id}/user`, assistantId = round.initialAssistantId ?? round.id;
        chat = { id: round.id, startMessageIds: [userId, assistantId], messages: [
            round.prompt !== null && { id: userId, role: 'user', text: round.prompt, hidden: round.initialUserHidden },
            (action !== 'reply' || round.results.length > 0) && { id: assistantId, role: 'assistant', results: round.results, selectedResultId: round.selectedResultId, hidden: round.initialAssistantHidden },
        ].filter(Boolean) };
        isLast ??= round.initialIsLast !== false;
    }
    const messages = chat?.messages ?? [];
    if (message === undefined) message = messageId ? messages.find(item => item.id === messageId)
        : action === 'reply' ? messages.at(-1)
        : resultId ? messages.find(item => item.results?.some(version => version.id === resultId)) : messages.findLast(item => item.role === role);
    if (result === undefined) result = resultId ? message?.results?.find(item => item.id === resultId)
        : message?.results?.find(item => item.id === message.selectedResultId) ?? message?.results?.at(-1);
    isLast ??= !message || messages.at(-1)?.id === message.id;
    const blocked = (code, text) => ({ available: false, code, message: text });
    const busy = text => blocked('busy', text);
    pending = ['send', 'reply'].includes(action) ? [] : action === 'edit' ? pending.filter(operation => operation.saving !== false) : pending;
    const resultPending = playResultIsPending(result, jobs, pending);
    const messagePending = playMessageIsPending(message, jobs, pending);
    if (action === 'reply') {
        if (Array.isArray(chat?.messages) && (!isLast || !message || message.role !== 'user' && (!chatMode || message.role !== 'assistant'))) {
            return blocked('empty_prompt', '请先输入小剧场提示词');
        }
        if (jobs.some(job => playJobCanStop(job) && (job.roundId ?? job.requestedRoundId) === chat?.id)) {
            return busy('这条聊天正在生成或尚未保存，请结束并保存后再操作。');
        }
    } else if (action === 'finish') {
        if (jobs.some(job => playJobCanStop(job) && (job.roundId ?? job.requestedRoundId) === chat?.id)
            || pending.some(operation => ['begin', 'result'].includes(operation.kind))) {
            return busy('这条聊天正在生成或尚未保存，请结束并保存后再操作。');
        }
    } else if (['send', 'favorite-chat', 'delete-chat', 'truncate'].includes(action)) {
        if (messages.some(item => playMessageIsPending(item, jobs, pending))
            || jobs.some(job => playJobCanStop(job) && (job.roundId ?? job.requestedRoundId) === chat?.id)
            || pending.some(operation => ['begin', 'result'].includes(operation.kind))) {
            return busy('这条聊天正在生成或尚未保存，请结束并保存后再操作。');
        }
    } else if (['choose', 'another', 'again', 'continue'].includes(action)) {
        if (!isLast || message && message.role !== 'assistant') return blocked('message_not_last', '只能对聊天末尾的 AI 楼层操作，请先从较早楼层创建分支。');
        if (action !== 'choose' && !messages.some(item => item.role === 'user' && chat.startMessageIds.includes(item.id))) {
            return blocked('prompt_missing', '这条用户消息已删除，无法使用原提示词生成。');
        }
        if (action !== 'another' && !result) return blocked('result_missing', action === 'again'
            ? '这份结果已在其他窗口替换，请重新打开记录后再试。' : '这次生成结果已不存在');
        if (action === 'continue') {
            if (message?.hidden) return blocked('message_hidden', '请先显示此楼层再续写。');
            if (!result.text?.trim()) return blocked('empty_result', '这份结果没有正文，无法续写；请使用重新生成。');
        }
        if (['again', 'continue'].includes(action) && resultPending) return busy('这份回复正在生成或保存，请先等待或停止');
    } else if (action === 'branch') {
        if (!message) return blocked('message_missing', '这条消息已删除，请保留草稿并重新读取。');
        const through = messages.findIndex(item => item.id === message.id);
        if (messages.slice(0, through + 1).some(item => playMessageIsPending(item, jobs, pending))) {
            return busy('请在这层回复结束并保存后创建分支。');
        }
    } else if (action === 'edit' || action === 'favorite') {
        const target = message?.role === 'user' ? message : result;
        if (!target) return blocked('message_missing', '这条消息已删除，请保留草稿并重新读取。');
        if (message?.role === 'user' ? messagePending : resultPending) {
            return busy(action === 'favorite' ? '请在这份回复结束并保存后收藏' : '这条回复正在生成或保存，请结束后再编辑。');
        }
        if (action === 'favorite' && !target.text?.trim()) return blocked('empty_result', '收藏内容不能为空。');
    } else if (action === 'remove' || action === 'visibility') {
        if (!message) return blocked('message_missing', '这条消息已删除，请保留草稿并重新读取。');
        if (messagePending) return busy('所选消息正在生成或尚未保存，请结束并保存后再操作。');
    }
    return { available: true };
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

export function playUserIdentity(context) {
    if (typeof context?.userName !== 'string' && typeof context?.userAvatar !== 'string') return null;
    return { name: typeof context.userName === 'string' && context.userName.trim() ? context.userName : '用户',
        avatar: typeof context.userAvatar === 'string' && context.userAvatar.trim() ? context.userAvatar : null };
}

export function playMessageIdentity(message, result) {
    return playUserIdentity(result?.context) ?? message.userIdentity ?? { name: '用户', avatar: null };
}

export function playChatMessageIdentity(messages, message) {
    const reply = messages[messages.indexOf(message) + 1];
    return playMessageIdentity(message, reply?.role === 'assistant' ? reply.results?.find(result => result.id === reply.selectedResultId) : null);
}
