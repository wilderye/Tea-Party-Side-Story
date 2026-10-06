import { registerTheatreMacros, theatreMacros } from './macro-registration.js';
import { selectTheatre, favoritePool, allowsContent } from './library.js';

// Prompt assembly and delivery of a native reply have different lifetimes.
// An extension may assemble another prompt while MESSAGE_RECEIVED is still running.
export async function registerTheatreGeneration(ctx, state, loaded, saveSettings) {
    const { settings } = state;
    const events = ctx().eventTypes;
    const source = ctx().eventSource;
    const chatId = () => ctx().getCurrentChatId?.() ?? ctx().chatId ?? ctx().chat;
    const writesReply = type => !['quiet', 'impersonate'].includes(type);
    let frame = null, nativeStart = null, nativeFrame = null;
    const pendingReplies = new Map();
    let toolResume = false, resolving = false, epoch = 0;

    function reset() {
        frame = nativeStart = nativeFrame = null;
        pendingReplies.clear();
        toolResume = false;
        epoch++;
    }

    source.on(events.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun) return;
        nativeStart = { type, chatId: chatId() };
        if (writesReply(type)) {
            for (const [id, pending] of pendingReplies) {
                if (!ctx().chat[id] || pending.chatId !== chatId()) pendingReplies.delete(id);
            }
            if (!toolResume) nativeFrame = null;
        }
    });
    source.on(events.GENERATION_AFTER_COMMANDS, async (type, _options, dryRun) => {
        // Macro callbacks have no request identity. A dry run must not replace
        // the real assembly or consume its STARTED marker. If they overlap,
        // both use that assembly's single cached choice; an idle preview has none.
        if (dryRun) return;
        // Native Generate emits STARTED first. Extension-only prompt requests may
        // emit AFTER_COMMANDS too: evaluate their macros, but don't give them a reply.
        const native = !!nativeStart && nativeStart.type === type
            && nativeStart.chatId === chatId();
        nativeStart = null;
        const generationEpoch = epoch, origin = chatId();
        await loaded;
        if (generationEpoch !== epoch || origin !== chatId() || !settings.enabled) return;
        const previous = native && writesReply(type) && toolResume ? nativeFrame : null;
        if (native && writesReply(type)) toolResume = false;
        frame = {
            choices: previous?.choices ?? {}, texts: previous?.texts ?? {},
            used: previous?.used ?? new Set(), missing: previous?.missing ?? new Set(),
            warned: previous?.warned ?? false, prepared: false, native, type, chatId: origin,
            original: type === 'continue' ? ctx().chat.at(-1)?.extra?.teahouse ?? {} : {},
        };
        if (native && writesReply(type)) nativeFrame = frame;
    });

    source.on(events.GENERATE_AFTER_DATA, (_data, dryRun) => {
        if (dryRun || !settings.enabled || !frame || frame.chatId !== chatId()) return;
        if (!frame.prepared) {
            frame.prepared = true;
            if (frame.native && writesReply(frame.type)) {
                const chat = ctx().chat;
                const existing = ['swipe', 'continue', 'append', 'appendFinal'].includes(frame.type);
                const messageId = existing ? chat.length - 1 : chat.length;
                const record = {};
                if (frame.used.has('community')) record.id = frame.choices.community;
                if (frame.used.has('favorites')) record.favoriteId = frame.choices.favorites;
                pendingReplies.delete(messageId);
                if (frame.used.size) pendingReplies.set(messageId, {
                    chatId: frame.chatId, record,
                    message: existing ? chat[messageId] : null,
                    anchor: chat[messageId - 1],
                    swipeId: existing ? chat[messageId]?.swipe_id ?? 0 : 0,
                });
            }
        }
        if (!frame.missing.size || frame.warned) return;
        frame.warned = true;
        const names = theatreMacros.filter(({ key }) => frame.missing.has(key)).map(({ name }) => `{{${name}}}`);
        globalThis.toastr?.warning(`${names.join('/')}无可用小剧场，填写内容为空`, '',
            { timeOut: 5000, extendedTimeOut: 1000, closeButton: true, escapeHtml: true });
    });

    function recordReply(messageId) {
        const pending = pendingReplies.get(messageId), chat = ctx().chat, message = chat[messageId];
        if (!settings.enabled || !pending || pending.chatId !== chatId()
            || !message || message.is_user || message.is_system
            || (message.swipe_id ?? 0) !== pending.swipeId
            || (pending.message ? message !== pending.message : chat[messageId - 1] !== pending.anchor)) return false;
        pending.message = message;
        message.extra ??= {};
        message.extra.teahouse = { ...pending.record };
        const swipe = message.swipe_info?.[message.swipe_id];
        if (swipe) { swipe.extra ??= {}; swipe.extra.teahouse = { ...pending.record }; }
        return true;
    }

    source.on(events.MESSAGE_RECEIVED, (messageId, type) => {
        if (type === 'first_message' || type === 'extension') return;
        if (recordReply(messageId)) pendingReplies.delete(messageId);
    });
    // A failed/interrupted swipe or continuation need not emit MESSAGE_RECEIVED.
    // Bind its original selection once actual streamed output starts arriving.
    source.on(events.STREAM_TOKEN_RECEIVED, text => {
        const streaming = ctx().streamingProcessor;
        if (text && streaming && streaming.type !== 'impersonate') recordReply(streaming.messageId);
    });
    source.on(events.GENERATION_STOPPED, id => {
        // Native stopGeneration emits no arguments; a scoped extension stop isn't ours.
        if (id !== undefined) return;
        const streaming = ctx().streamingProcessor;
        if (streaming?.result) recordReply(streaming.messageId);
        pendingReplies.clear();
        toolResume = false;
    });
    source.on(events.GENERATION_ENDED, () => {
        // This is a button-state notification, not delivery of a particular reply.
        // In both ST 1.14 and 1.19 it can precede MESSAGE_RECEIVED.
        frame = nativeStart = null;
    });
    source.on(events.TOOL_CALLS_PERFORMED, () => {
        if (nativeFrame?.used.size) toolResume = true;
    });
    source.on(events.CHAT_CHANGED, reset);

    function theatreMacro(kind) {
        if (!settings.enabled || resolving) return '';
        const active = frame?.chatId === chatId() ? frame : null;
        if (active && Object.hasOwn(active.texts, kind)) {
            const cached = state.entries.get(active.choices[kind]);
            if (cached && !allowsContent(cached, settings.showGore)) {
                active.texts[kind] = ''; delete active.choices[kind]; active.missing.add(kind);
            }
            return active.texts[kind];
        }
        const all = new Map([...state.entries].filter(([, item]) => allowsContent(item, settings.showGore)));
        const pool = kind === 'community' ? all : favoritePool(all, settings.favorites);
        const lastKey = kind === 'community' ? 'lastId' : 'lastFavoriteId';
        const originalKey = kind === 'community' ? 'id' : 'favoriteId';
        const originalId = active?.original[originalKey];
        const original = active ? all.get(originalId) : null;
        // A filtered continuation must not inject a different story into the old reply.
        if (originalId && state.entries.has(originalId) && !all.has(originalId)) {
            active.texts[kind] = ''; active.missing.add(kind); return '';
        }
        const selected = active
            ? (original?.type === 'preset' ? original : selectTheatre(pool, settings[lastKey]))
            : [...pool.values()].find(x => x.type === 'preset');
        if (!selected) {
            if (active) { active.texts[kind] = ''; active.missing.add(kind); }
            return '';
        }
        resolving = true;
        let text;
        try { text = ctx().substituteParams(selected.body); } finally { resolving = false; }
        if (active) {
            active.choices[kind] = selected.id; active.texts[kind] = text; active.used.add(kind);
            // Background requests still expand macros, but only native replies
            // advance the history used to avoid repeats in the next reply.
            if (active.native && writesReply(active.type)) {
                settings[lastKey] = selected.id; saveSettings();
            }
        }
        return text;
    }
    await registerTheatreMacros(ctx(), {
        community: () => theatreMacro('community'), favorites: () => theatreMacro('favorites'),
    });
    return { reset };
}
