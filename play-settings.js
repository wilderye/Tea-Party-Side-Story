export const DEFAULT_PLAY_PROMPT = '按要求输出思维链后仅输出小剧场内容，不生成任何附加模块如顶部/尾部状态栏/待办/变量命令/总结等。';
const LEGACY_DEFAULT_PLAY_PROMPT = '本次仅输出小剧场，不生成任何状态栏或待办等附加内容。';
const LEGACY_RECOMMENDED_PLAY_PROMPT_NAME = '推荐提示词';
export const RECOMMENDED_PLAY_PROMPT = `按要求输出思维链后仅输出小剧场内容，不生成任何附加模块如顶部/尾部状态栏/待办/变量命令/总结等。
小剧场需要是一个完整的故事，“小剧场”的“小”仅为特定惯性叫法，你更愿意将其称之为“新的故事”，宛如一篇短篇小说。这意味着它要有一个故事的开端，和一个结束，即使是开放式的结尾，而非仅仅给出提示词中的需求一个切面。
它可以跨越时段来讲述一个故事。
故事不能仅等于小剧场的提示词，需要“超过”。譬如，一个设定触及了二人任意的核心设定或二人的核心纠葛，可以从任意的更早的时间点开始写，甚至是从小时候开始，来讲述它的过往；也可以扩展未知，探索新故事中相对与现在来说属于“将来”的图景和细节。一个全新的世界观，会带来世界方方面面的变化，刻画世界对人物造成的影响，及其随之而来的故事，而非仅以人物的情感和关系来推动故事。`;
export const DEFAULT_HIDDEN_TAGS = 'think,thinking,update,status';
export const DEFAULT_PLAY_PROMPT_POSITION = 'user-after';
export const DEFAULT_CONTINUE_PROMPTS = {
    history: 'Resume the preceding assistant reply exactly where it stops. Return only the added text, joining it naturally to the existing ending.',
    prompt: 'Resume the reply provided below exactly where it stops. Return only the added text, joining it naturally to the existing ending.\n\n{{lastChatMessage}}',
};

export function readPlayContinuationSettings(settings) {
    const mode = settings.playContinueMode === 'prompt' ? 'prompt' : 'history';
    return { mode, prompt: settings.playContinuePrompts?.[mode] ?? DEFAULT_CONTINUE_PROMPTS[mode],
        sendReasoning: settings.playContinueSendReasoning !== false };
}

export function playContinuationError(continuation = readPlayContinuationSettings({})) {
    return continuation.mode === 'prompt' && !/\{\{lastChatMessage\}\}/i.test(continuation.prompt)
        ? '第二种方式需要在续写提示词中加入 {{lastChatMessage}}。' : '';
}

/** Read legacy content without changing settings during request capture. */
export function readPlayPromptSettings(settings) {
    const saved = settings.playPromptConfig;
    const presets = Array.isArray(saved?.presets) ? saved.presets.filter(preset =>
        preset && typeof preset.id === 'string' && typeof preset.name === 'string' && typeof preset.content === 'string') : [];
    const defaults = [
        { id: 'default', name: '默认提示词', content: settings.playPrompt === LEGACY_DEFAULT_PLAY_PROMPT
            ? DEFAULT_PLAY_PROMPT : settings.playPrompt ?? DEFAULT_PLAY_PROMPT },
        { id: 'recommended', name: '强调完整性', content: RECOMMENDED_PLAY_PROMPT },
    ];
    const entries = defaults.map(preset => {
        const saved = presets.find(entry => entry.id === preset.id);
        if (!saved) return preset;
        if (saved.id === 'default' && saved.content === LEGACY_DEFAULT_PLAY_PROMPT) {
            return { ...saved, content: DEFAULT_PLAY_PROMPT };
        }
        if (saved.id === 'recommended' && saved.name === LEGACY_RECOMMENDED_PLAY_PROMPT_NAME) {
            return { ...saved, name: preset.name };
        }
        return saved;
    })
        .concat(presets.filter(preset => !defaults.some(entry => entry.id === preset.id)));
    return {
        presets: entries,
        selectedId: entries.some(preset => preset.id === saved?.selectedId) ? saved.selectedId : 'default',
        position: ['start', 'user-before', 'user-after'].includes(saved?.position) ? saved.position : DEFAULT_PLAY_PROMPT_POSITION,
    };
}

/** Empty strings are saved choices, not missing defaults. */
export function readPlaySettings(settings) {
    const prompts = readPlayPromptSettings(settings);
    return {
        prompt: prompts.presets.find(preset => preset.id === prompts.selectedId).content,
        promptPosition: prompts.position,
        hiddenTags: settings.playHiddenTags ?? DEFAULT_HIDDEN_TAGS,
        regexEnabled: settings.playRegexEnabled !== false,
        excludedRegex: settings.playRegexExclusions ?? [],
        noChat: settings.playNoChat !== false,
    };
}
