import { createBrowserPlayHistory } from './play-storage.js';
import { createPlayground, PlaygroundError } from './playground.js';
import { createNativePlayPreparer } from './play-prompt.js';
import { readPlaySettings, readPlayContinuationSettings, readPlayRetrySettings } from './play-settings.js';
import { createPlayDisplay } from './play-processing.js';
import { createPlayChatFavorites } from './play-chat-favorites.js';

export function readPlayTarget(context) {
    if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '') {
        throw new PlaygroundError('group_not_supported', '剧场演出目前只为单个角色的当前聊天生成，群聊尚未接入。');
    }
    const character = context.characters?.[context.characterId];
    if (!character?.avatar || !character.name) {
        throw new PlaygroundError('no_current_character', '请在小剧场中选择一张角色卡。');
    }
    return { character: { avatar: character.avatar, name: character.name }, chatId: context.getCurrentChatId?.() ?? context.chatId ?? '' };
}

// Capture only the data this request needs. Extension prompt filters are
// native callbacks, not serializable history or a second variable environment.
export function capturePlayEnvironment(context, settings, requested = {}) {
    const card = requested.character?.avatar
        ? context.characters?.find(character => character.avatar === requested.character.avatar)
        : context.characters?.[context.characterId];
    if (!card?.avatar || !card.name) throw new PlaygroundError('target_character_missing', '请在小剧场中选择一张仍然存在的角色卡。');
    const target = { character: { avatar: card.avatar, name: card.name }, chatId: '' };
    if (context.mainApi !== 'openai') throw new PlaygroundError('api_not_supported', '剧场演出目前支持酒馆的聊天补全预设。');
    const api = settings.playApi ?? { mode: 'tavern' };
    if (!['tavern', 'custom'].includes(api.mode)) throw new PlaygroundError('invalid_api_mode', '游玩的 API 选择不正确');
    const playSettings = readPlaySettings(settings);
    const noChat = playSettings.noChat;
    const chatId = context.getCurrentChatId?.() ?? context.chatId;
    const nativeChat = !noChat && context.characters?.[context.characterId]?.avatar === card.avatar
        && !context.groupId && typeof chatId === 'string' && chatId
        ? { chatId, messages: context.chat, metadata: context.chatMetadata ?? {} } : null;
    try {
        return structuredClone({
            ...target,
            independent: true, noChat, characterCard: card,
            ...(nativeChat ? { nativeChat } : {}),
            context: { chatId: '', chatMode: noChat ? 'initial' : 'latest', characterName: target.character.name, apiMode: api.mode,
                presetName: String(context.chatCompletionSettings?.preset_settings ?? '') },
            api,
            playPrompt: playSettings.prompt,
            playPromptPosition: playSettings.promptPosition,
            playHiddenTags: playSettings.hiddenTags,
            playRegex: { enabled: playSettings.regexEnabled, overrides: playSettings.regexOverrides },
            continuation: readPlayContinuationSettings(settings),
            retry: readPlayRetrySettings(settings),
            tavern: {
                settings: context.chatCompletionSettings,
                power: context.powerUserSettings ?? {},
                model: context.getChatCompletionModel?.(),
                name1: context.name1, name2: card.name,
            },
            chat: [], ignoredMessages: nativeChat ? (context.chat ?? []).flatMap((message, index) =>
                context.symbols?.ignore && message.extra?.[context.symbols.ignore] ? [index] : []) : [],
            unfinishedMessageId: nativeChat && context.streamingProcessor?.isFinished === false ? context.streamingProcessor.messageId : -1,
            characterId: context.characters.indexOf(card), sourceCharacterId: context.characters.indexOf(card),
        });
    } catch (cause) {
        throw new PlaygroundError('context_not_copyable', '本次角色资料无法复制，尚未发送到模型。', { cause });
    }
}

/** Wire native prompt preparation, independent storage and chat identity. */
export function createPlayRuntime(ctx, settings, history, { prepareRequest = createNativePlayPreparer(ctx), loadRegex,
    loadPersona = () => import('/scripts/personas.js'), onError = () => {}, diagnostics } = {}) {
    history ??= createBrowserPlayHistory(ctx, diagnostics);
    const playground = createPlayground({ history, prepareRequest, diagnostics, enabled: () => settings.enabled !== false,
        uuid: () => ctx().uuidv4(),
        captureEnvironment: target => {
            const environment = capturePlayEnvironment(ctx(), settings, target);
            Object.assign(environment.tavern, structuredClone(prepareRequest.capture?.(environment.characterCard) ?? {}));
            return environment;
        },
        isCurrent(environment) {
            if (environment.independent) return true;
            try {
                const current = readPlayTarget(ctx());
                return current.character.avatar === environment.character.avatar && current.chatId === environment.chatId;
            } catch { return false; }
        },
    });
    const events = ctx().eventTypes, source = ctx().eventSource;
    // SillyTavern awaits its event listeners. Queue our own file update without
    // making a character rename/deletion wait for an upload or network timeout.
    if (events.CHARACTER_RENAMED) source.on(events.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        const name = ctx().characters?.find(character => character.avatar === newAvatar)?.name;
        void history.renameCharacter(oldAvatar, newAvatar, name)
            .catch(error => { diagnostics?.error('角色改名后更新演出历史', error); onError('角色改名后，游玩历史中的角色标识更新失败。'); });
    });
    if (events.CHARACTER_DELETED) source.on(events.CHARACTER_DELETED, ({ character } = {}) => {
        if (!character?.avatar) return;
        void history.renameCharacter(character.avatar, null)
            .catch(error => { diagnostics?.error('删除角色后更新演出历史', error); onError('删除角色后，游玩历史中的角色标识更新失败；原历史仍保留。'); });
    });
    const loadDisplayRegex = loadRegex ?? (async character => {
        const modules = await prepareRequest.ready();
        const context = ctx();
        if (!character?.avatar || character.avatar === context.characters?.[context.characterId]?.avatar) return modules.regex;
        const { createPlayDisplayRegex } = await import('./play-independent.js');
        return createPlayDisplayRegex(context, modules, character, prepareRequest.capture(character));
    });
    const display = createPlayDisplay(ctx, settings, loadDisplayRegex, diagnostics);
    const chatFavorites = createPlayChatFavorites(history, display);
    function legacySelection(id, options) {
        if (!options?.selectedResultId) {
            try {
                const saved = JSON.parse(ctx().accountStorage?.getItem('teahouse-play-view-v1') ?? 'null');
                const selectedResultId = saved?.selections?.find(([chatId]) => chatId === id)?.[1];
                if (selectedResultId) return { ...options, selectedResultId };
            } catch { /* Draft storage failure must not prevent reading persisted history. */ }
        }
        return options;
    }
    return { ...playground, display,
        getChat(id, options) {
            return playground.getChat(id, legacySelection(id, options));
        },
        getChatWindow(id, options) {
            return playground.getChatWindow(id, legacySelection(id, options));
        },
        getChatPreview: (id, options) => playground.getChatPreview(id, legacySelection(id, options)),
        getChatSearch: (id, options) => playground.getChatSearch(id, legacySelection(id, options)),
        async createChatDirectoryReader() {
            const read = await history.createChatDirectoryReader();
            return (id, options) => read(id, legacySelection(id, options));
        },
        getFavorite: id => chatFavorites.read(id),
        getFavoriteWindow: (id, options) => chatFavorites.read(id, options),
        getChatMetadata: id => history.getChatMetadata(id),
        async syncFavorite(id, options) {
            try { return await chatFavorites.sync(id, options); }
            catch (error) { diagnostics?.error('更新聊天收藏', error); throw error; }
        },
        favoriteChat: id => chatFavorites.add(id),
        deleteChat: (id, revision) => {
            if (!playground.availability({ chatId: id }).available) throw new PlaygroundError('busy', '请结束并保存这条聊天后再删除。');
            return chatFavorites.removeChat(id, revision);
        },
        addManualFavorite({ characterAvatar, title, text, firstLine }) {
            const card = ctx().characters?.find(character => character.avatar === characterAvatar);
            if (!card?.avatar || !card.name) throw new PlaygroundError('target_character_missing', '所选角色卡已不存在，请重新选择角色。');
            return playground.addManualFavorite({ character: { avatar: card.avatar, name: card.name }, title, text, firstLine });
        },
        async getUserIdentity() {
            try {
                const persona = await loadPersona();
                return { name: ctx().name1 || 'User', avatar: persona.user_avatar || null };
            } catch (error) { diagnostics?.warn('读取用户头像，已使用默认显示', error); throw error; }
        },
        async initialize() {
            try { await prepareRequest.ready?.(); }
            catch (error) { diagnostics?.error('载入剧场生成接口', error); throw error; }
        } };
}
