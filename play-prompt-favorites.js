import { truncateTitle } from './library.js';

const comparableText = text => text.replace(/\r\n?/g, '\n');

/** Prompt favorites use the existing library entries and favorite IDs. */
export function createPlayPromptFavorites(state, { loaded, saveManuscript, toggleFavorite }) {
    function findEntry(round) {
        if (typeof round?.prompt !== 'string' || !round.prompt.trim()) return null;
        const text = comparableText(round.prompt);
        const source = state.community.get(round.origin?.id) ?? state.manuscripts.get(round.origin?.id);
        if (source && comparableText(source.body) === text) return source;
        // Reuse a saved copy after reopening or cancelling its favorite. No
        // separate message-to-manuscript map needs to track edits/deletions.
        return [...state.manuscripts.values()].find(item => item.type === 'standalone' && comparableText(item.body) === text) ?? null;
    }
    const isFavorite = round => {
        const entry = findEntry(round);
        return !!entry && Object.hasOwn(state.settings.favorites, entry.id);
    };

    return {
        isFavorite,
        async toggle(round) {
            await loaded;
            if (state.settings.enabled === false) throw new Error('插件已停用');
            if (typeof round?.prompt !== 'string' || !round.prompt.trim()) throw new Error('这条用户消息已删除，无法收藏。');
            let entry = findEntry(round);
            const created = !entry;
            if (!entry) {
                const firstLine = round.prompt.split(/\r\n?|\n/).find(line => line.trim()).trim();
                entry = await saveManuscript({ type: 'standalone', body: round.prompt,
                    title: round.origin?.title?.trim() || truncateTitle(firstLine) });
            }
            await toggleFavorite(entry.id);
            return { id: entry.id, favorite: Object.hasOwn(state.settings.favorites, entry.id), created };
        },
    };
}
