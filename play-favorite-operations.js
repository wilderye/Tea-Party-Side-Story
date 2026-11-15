export function favoriteSourceKey({ roundId, resultId, startedAt }) {
    return `${roundId}/${resultId}/${startedAt}`;
}

function operationKey(source) {
    if (source.type === 'chat') return `chat/${source.chatId}`;
    if (source.type === 'prompt') return `prompt/${JSON.stringify([source.origin?.id ?? null,
        typeof source.prompt === 'string' ? source.prompt.replace(/\r\n?/g, '\n') : null])}`;
    return favoriteSourceKey(source);
}

export function createPlayFavoriteOperations(diagnostics) {
    const pending = new Map(), listeners = new Set();
    function publish(item, committed = false) {
        for (const listener of listeners) {
            try { listener({ source: item.source, value: item.value, committed }); }
            catch (error) { diagnostics?.error('更新收藏状态', error); }
        }
    }
    async function save(item) {
        while (item.desired !== !!item.value) {
            const desired = item.desired;
            try {
                if (desired) item.value = await item.add();
                else { await item.remove(item.value); item.value = null; }
                publish(item, true);
            } catch (error) {
                if (item.desired === desired) {
                    item.desired = !!item.value;
                    item.onError(error, desired);
                }
                break;
            }
        }
        return item.value;
    }
    return {
        isFavorite(source, value) { return pending.get(operationKey(source))?.desired ?? !!value; },
        hasPending: () => pending.size > 0,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        toggle(source, { value, add, remove, onError }) {
            const key = operationKey(source);
            let item = pending.get(key);
            if (!item) {
                item = { source: structuredClone(source), value, desired: !!value };
                pending.set(key, item);
                item.completion = new Promise(resolve => setTimeout(resolve, 0)).then(() => save(item)).finally(() => {
                    pending.delete(key); publish(item);
                });
            }
            Object.assign(item, { add, remove, onError });
            item.desired = !item.desired;
            publish(item);
            return item.completion;
        },
    };
}
