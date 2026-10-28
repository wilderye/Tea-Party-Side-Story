import { favoriteCacheKey } from './play-history.js';

/** Resolve only missing processed bodies, outside the storage write lock. */
export function createPlayChatFavorites(history, display) {
    async function prepare(chat, favorite) {
        const cached = new Set((favorite?.cache ?? []).map(favoriteCacheKey));
        const entries = [];
        const character = (await history.listCharacters()).find(character => character.id === chat.characterId);
        await display?.ensure(character);
        let processed = 0;
        for (const message of chat.messages) {
            const result = message.role === 'user' ? message : message.results.find(result => result.id === message.selectedResultId);
            if (result.status === 'unfinished') continue;
            const identity = { messageId: message.id, resultId: message.role === 'user' ? null : result.id, bodyRevision: result.bodyRevision };
            if (!cached.has(favoriteCacheKey(identity))) {
                entries.push({ ...identity, text: display?.process(result.text, character, result.context, message.role) ?? result.text });
                if (++processed % 12 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            // Long transcripts yield between small batches; no work is done
            // here on streamed text or frequent version switches during play.
        }
        return entries;
    }
    return {
        async add(chatId) {
            const chat = await history.getChat(chatId);
            const entries = await prepare(chat);
            return history.addChatFavorite({ chatId, expectedRevision: chat.revision, entries });
        },
        async read(id) {
            const favorite = await history.getFavorite(id);
            if (favorite.format !== 2 || favorite.frozen) return favorite;
            for (let attempt = 0; attempt < 3; attempt++) {
                let chat;
                try { chat = await history.getChat(favorite.source.chatId); }
                catch (error) {
                    if (error.code !== 'chat_missing') throw error;
                    const current = await history.getFavorite(id);
                    if (current.frozen) return current;
                    throw error;
                }
                const entries = await prepare(chat, favorite);
                try {
                    await history.syncChatFavorite(id, { chatRevision: chat.revision, entries });
                    return history.getFavorite(id);
                } catch (error) { if (error.code !== 'chat_conflict' || attempt === 2) throw error; }
            }
        },
        async removeChat(chatId, expectedRevision) {
            const chat = await history.getChat(chatId);
            if (expectedRevision && chat.revision !== expectedRevision) throw new Error('聊天内容已改变，请重新读取后再删除。');
            const row = (await history.listFavorites()).find(row => row.source.type === 'chat' && row.source.chatId === chatId);
            const favorite = row && await history.getFavorite(row.id);
            const favoriteEntries = favorite ? await prepare(chat, favorite) : [];
            return history.deleteChat(chatId, chat.revision, { favoriteEntries });
        },
    };
}
