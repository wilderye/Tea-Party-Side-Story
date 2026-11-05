export function createPlayMessageEditing({ onChange = () => {}, onReveal = session => session.reveal(), onError = () => {}, confirmDiscard = () => true } = {}) {
    let current = null, operation = null;
    const editing = {
        get current() { return current; },
        get busy() { return operation !== null || !!current?.editor.saving; },
        find(page, id, role, resultId) {
            return current?.page === page && current.id === id && (!role || current.role === role)
                && (!resultId || current.resultId === resultId) ? current : null;
        },
        open({ key, create }) {
            if (editing.busy) return Promise.resolve(false);
            if (current?.key === key) return Promise.resolve(true);
            return run(async () => {
                if (current && !await saveCurrent(current)) return false;
                const session = await create();
                if (!session) return false;
                current = session;
                session.key = key;
                try { session.activate(); }
                catch (error) { await finish(session, 'cancel'); throw error; }
                return true;
            });
        },
        save(session = current) {
            if (!session || session !== current || editing.busy) return Promise.resolve(false);
            return run(() => saveCurrent(session));
        },
        cancel(session = current) {
            if (!session || session !== current || editing.busy) return Promise.resolve(false);
            return run(async () => {
                if (session.editor.dirty && !await confirmDiscard()) return false;
                await finish(session, 'cancel'); return true;
            });
        },
    };
    function run(work) {
        operation = Promise.resolve().then(work).catch(error => { onError(error); return false; }).finally(() => {
            operation = null; onChange();
        });
        onChange();
        return operation;
    }
    async function saveCurrent(session) {
        const state = session.editor.capture();
        if (!await session.editor.save()) {
            session.state = state;
            await onReveal(session);
            if (current === session) session.editor.restore(state);
            return false;
        }
        await finish(session, 'save');
        return true;
    }
    async function finish(session, reason) {
        if (current !== session) return;
        current = null;
        session.editor.dispose();
        try { await session.finish(reason); }
        catch (error) { onError(error); }
        finally { session.editor.actions.remove(); }
    }
    return editing;
}
