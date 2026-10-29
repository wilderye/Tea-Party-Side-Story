import { selectPlayPersona } from './play-character-context.js';

const sessions = new WeakMap();

async function waitForPersonaChange(pending, signal) {
    signal.throwIfAborted();
    let abort;
    try {
        await Promise.race([pending, new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
        })]);
        signal.throwIfAborted();
    } finally { signal.removeEventListener('abort', abort); }
}

/** Choices live only in this page, shared by all theatre requests for a host. */
export function getPlayPersonaSession(ctx, getPersonas) {
    const source = ctx().eventSource;
    if (sessions.has(source)) return sessions.get(source);
    const choices = new Map(), chatChanges = new Set();
    let queue = Promise.resolve(), active = null;

    function readCurrent() {
        const context = ctx(), avatar = context.characters?.[context.characterId]?.avatar;
        const chatId = context.getCurrentChatId?.() ?? context.chatId;
        const id = getPersonas()?.user_avatar;
        return !context.groupId && avatar && chatId && id ? { avatar, chatId, id } : null;
    }

    function rememberCurrent(current = readCurrent()) {
        if (!current) return;
        const { avatar, id } = current;
        choices.set(avatar, { id, source: 'host' });
        if (active?.avatar === avatar) {
            active.override = id;
            if (active.popup) void active.popup.complete(ctx().POPUP_RESULT.CANCELLED);
        }
    }

    // Observe completion, including Tavern's asynchronous persona chooser and
    // listeners registered after this extension; a last listener is insufficient.
    const originalEmit = source.emit, events = ctx().eventTypes;
    if (typeof originalEmit === 'function') source.emit = async function (event, ...args) {
        let changed, finish;
        const personaChanged = events.PERSONA_CHANGED && event === events.PERSONA_CHANGED;
        // ST 1.14 has no persona event; selecting one saves settings instead.
        const legacyPersonaChanged = !events.PERSONA_CHANGED && events.SETTINGS_UPDATED && event === events.SETTINGS_UPDATED;
        const hostSelection = personaChanged || legacyPersonaChanged ? readCurrent() : null;
        if (events.CHAT_CHANGED && event === events.CHAT_CHANGED) {
            changed = new Promise(resolve => { finish = resolve; });
            chatChanges.add(changed);
        }
        try {
            const result = await originalEmit.call(this, event, ...args);
            if (changed) rememberCurrent();
            if (hostSelection) rememberCurrent(hostSelection);
            if (events.CHARACTER_RENAMED && event === events.CHARACTER_RENAMED) {
                const [oldAvatar, newAvatar] = args;
                if (choices.has(oldAvatar)) { choices.set(newAvatar, choices.get(oldAvatar)); choices.delete(oldAvatar); }
            }
            if (events.CHARACTER_DELETED && event === events.CHARACTER_DELETED) choices.delete(args[0]?.character?.avatar);
            return result;
        } finally {
            if (changed) { chatChanges.delete(changed); finish(); }
        }
    };

    function recall(power, character) {
        const choice = choices.get(character.avatar);
        if (!choice) return null;
        const exists = Object.hasOwn(power.personas ?? {}, choice.id);
        const connected = power.persona_descriptions?.[choice.id]?.connections?.some(connection => connection.id === character.avatar);
        if (exists && (choice.source === 'host' || connected)) return choice.id;
        choices.delete(character.avatar);
        return null;
    }

    const session = {
        refresh() { if (!chatChanges.size) rememberCurrent(); },
        select(power, character, metadata, current, signal) {
            const task = queue.then(async () => {
                while (chatChanges.size) await waitForPersonaChange(Promise.all([...chatChanges]), signal);
                signal.throwIfAborted();
                session.refresh();
                const remembered = recall(power, character);
                const selectedMetadata = remembered ? { ...metadata, persona: remembered } : metadata;
                const selection = { avatar: character.avatar, override: null, popup: null };
                let chosen = false, persona;
                active = selection;
                try {
                    try {
                        persona = await selectPlayPersona(power, character, selectedMetadata, current, async personas => {
                            chosen = true;
                            const context = ctx(), before = new Set(context.Popup.util.popups);
                            const pending = getPersonas().askForPersonaSelection('选择用户设定',
                                `为「${character.name}」选择用户设定。本次打开酒馆期间，小剧场会沿用这次选择；在主聊天中选择人设后，改为沿用主聊天的选择。`, personas, { okButton: '取消' });
                            const popup = selection.popup = context.Popup.util.popups.find(item => !before.has(item));
                            const abort = () => { if (popup) void popup.complete(context.POPUP_RESULT.CANCELLED); };
                            signal.addEventListener('abort', abort, { once: true });
                            try { const result = await pending; signal.throwIfAborted(); return result; }
                            finally { signal.removeEventListener('abort', abort); selection.popup = null; }
                        });
                    } catch (error) {
                        if (!selection.override || signal.aborted || (error?.name !== 'AbortError' && error?.code !== 'invalid_persona_selection')) throw error;
                    }
                    signal.throwIfAborted();
                    if (selection.override && Object.hasOwn(power.personas ?? {}, selection.override)) {
                        persona = await selectPlayPersona(power, character, { ...metadata, persona: selection.override }, current);
                    } else if (chosen && persona) choices.set(character.avatar, { id: persona.id, source: 'play' });
                    return persona;
                } finally { if (active === selection) active = null; }
            });
            queue = task.catch(() => {});
            return task;
        },
    };
    sessions.set(source, session);
    return session;
}
