import { createBrowserPlayHistory } from './play-storage.js';
import { createPlayground, PlaygroundError } from './playground.js';
import { createNativePlayPreparer } from './play-prompt.js';
import { readPlaySettings } from './play-settings.js';
import { createPlayDisplay } from './play-processing.js';

export function readPlayTarget(context) {
    if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '') {
        throw new PlaygroundError('group_not_supported', '剧场演出目前只为单个角色的当前聊天生成，群聊尚未接入。');
    }
    const character = context.characters?.[context.characterId];
    const chatId = context.getCurrentChatId?.() ?? context.chatId;
    if (!character?.avatar || !character.name || typeof chatId !== 'string' || !chatId) {
        throw new PlaygroundError('no_current_character', '请先在酒馆中打开一个角色的聊天。');
    }
    return { character: { avatar: character.avatar, name: character.name }, chatId };
}

// Capture only the data this request needs. Extension prompt filters are
// native callbacks, not serializable history or a second variable environment.
export function capturePlayEnvironment(context, settings) {
    const target = readPlayTarget(context);
    if (context.mainApi !== 'openai') throw new PlaygroundError('api_not_supported', '剧场演出目前支持酒馆的聊天补全预设。');
    const api = settings.playApi ?? { mode: 'tavern' };
    if (!['tavern', 'custom'].includes(api.mode)) throw new PlaygroundError('invalid_api_mode', '游玩的 API 选择不正确');
    const streaming = context.streamingProcessor;
    const unfinished = streaming && !streaming.isFinished ? streaming.messageId : -1;
    try {
        return structuredClone({
            ...target,
            context: { chatId: target.chatId, characterName: target.character.name, apiMode: api.mode,
                presetName: String(context.chatCompletionSettings?.preset_settings ?? '') },
            api,
            playPrompt: readPlaySettings(settings).prompt,
            tavern: {
                settings: context.chatCompletionSettings,
                power: context.powerUserSettings ?? {},
                model: context.getChatCompletionModel?.(),
                name1: context.name1, name2: context.name2,
            },
            chat: context.chat,
            unfinishedMessageId: Number.isInteger(unfinished) ? unfinished : -1,
            // structuredClone drops symbol keys; retain ST's "ignore" marker
            // separately so its native formatter still honors hidden messages.
            ignoredMessages: context.chat.flatMap((message, index) =>
                context.symbols?.ignore && message.extra?.[context.symbols.ignore] ? [index] : []),
            characterId: context.characterId,
        });
    } catch {
        throw new PlaygroundError('context_not_copyable', '本次聊天内容无法读取，请重新打开聊天后再试。');
    }
}

/** Wire native prompt preparation, independent storage and chat identity. */
export function createPlayRuntime(ctx, settings, history = createBrowserPlayHistory(ctx), { prepareRequest = createNativePlayPreparer(ctx), loadRegex,
    loadPersona = () => import('/scripts/personas.js'), onError = () => {}, diagnostics } = {}) {
    const playground = createPlayground({ history, prepareRequest, diagnostics, enabled: () => settings.enabled !== false,
        uuid: () => ctx().uuidv4(),
        captureEnvironment: () => {
            const environment = capturePlayEnvironment(ctx(), settings);
            Object.assign(environment.tavern, structuredClone(prepareRequest.capture?.() ?? {}));
            return environment;
        },
        isCurrent(environment) {
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
    return { ...playground, display: createPlayDisplay(ctx, settings, loadRegex, diagnostics),
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
