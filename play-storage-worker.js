import { createHttpPlayHistory, playHistoryMethods } from './play-storage.js';
import { createHistoryLock } from './play-storage-lock.js';
import { serializeDiagnosticError } from './diagnostics.js';

const withLock = createHistoryLock();

globalThis.onconnect = ({ ports: [port] }) => {
    const waiting = new Map();
    port.onmessage = async ({ data }) => {
        const { id, method, args, headers } = data ?? {};
        if (typeof id === 'string' && data.cancel === true) { waiting.get(id)?.abort(); return; }
        if (typeof id !== 'string' || !playHistoryMethods.includes(method) || !Array.isArray(args)) return;
        const controller = method === 'begin' ? new AbortController() : null;
        if (controller) waiting.set(id, controller);
        try {
            // Headers belong to this call, including while another call waits.
            const history = createHttpPlayHistory(() => headers, undefined, withLock,
                (operation, error) => port.postMessage({ warning: { operation, error: serializeDiagnosticError(error) } }));
            const value = controller ? await history.begin(args[0], { signal: controller.signal }) : await history[method](...args);
            port.postMessage({ id, value });
        } catch (error) {
            port.postMessage({ id, error: serializeDiagnosticError(error) });
        } finally { waiting.delete(id); }
    };
    port.postMessage({ ready: true });
};
