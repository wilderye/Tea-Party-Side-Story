// Native preparation callbacks may be asynchronous. Observing the end of emit,
// rather than adding a "last" listener, includes every registered callback.
const coordinators = new WeakMap();

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function waitFor(promise, signal) {
    signal.throwIfAborted();
    let abort;
    try {
        await Promise.race([promise, new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
        })]);
        signal.throwIfAborted();
    } finally { signal.removeEventListener('abort', abort); }
}

export function getPlayPreparationCoordinator(context, core = {}) {
    const source = context.eventSource, events = context.eventTypes;
    if (coordinators.has(source)) return coordinators.get(source);
    const ownEvent = Symbol('theatre-preparation');
    const originalEmit = source.emit;
    let host = core.is_send_press ? deferred() : null;
    let play = null;
    let hostRevision = 0;
    const beginEvents = new Set([events.GENERATION_STARTED, events.GENERATION_AFTER_COMMANDS].filter(Boolean));
    const renderEvents = new Set([events.MESSAGE_RECEIVED, events.CHARACTER_MESSAGE_RENDERED].filter(Boolean));
    source.emit = async function (event, ...args) {
        const owned = args.at(-1) === ownEvent;
        if (owned) args.pop();
        if (!owned && beginEvents.has(event)) {
            // Reserve the host's next preparation before releasing this one,
            // so another queued theatre request cannot take its place.
            host ??= deferred();
            hostRevision++;
            if (play) {
                play.interrupted = true;
                // Native WI scans cannot be aborted. Let the in-flight scan
                // finish and restore its shared state before host callbacks
                // prepare a new prompt (including a prompt-only dry run).
                await play.promise;
            }
        }
        // The main request can return while theatre preparation is awaiting a
        // tokenizer or EJS callback. Delay its reply handlers only until that
        // preparation finishes; neither model's network request is serialized.
        if (!owned && renderEvents.has(event) && play) await play.promise;
        const activeHost = host;
        const revision = hostRevision;
        try { return await originalEmit.call(this, event, ...args); }
        finally {
            const prepared = event === events.CHAT_COMPLETION_SETTINGS_READY
                || (event === events.GENERATE_AFTER_DATA && args[1] === true);
            if (!owned && prepared && activeHost) {
                // The caller serializes and dispatches the prepared payload in
                // the continuation of this emit. Yield one browser turn first.
                setTimeout(() => {
                    if (host === activeHost && revision === hostRevision) { host = null; activeHost.resolve(); }
                }, 0);
            } else if (!owned && event === events.GENERATION_ENDED && activeHost) {
                if (host === activeHost) { host = null; activeHost.resolve(); }
            }
        }
    };
    const coordinator = {
        emit: (event, ...args) => source.emit(event, ...args, ownEvent),
        async run(signal, action) {
            while (host || play) await waitFor((host ?? play).promise, signal);
            signal.throwIfAborted();
            const current = play = { ...deferred(), interrupted: false };
            try { return await action(() => current.interrupted); }
            finally { if (play === current) play = null; current.resolve(); }
        },
    };
    coordinators.set(source, coordinator);
    return coordinator;
}
