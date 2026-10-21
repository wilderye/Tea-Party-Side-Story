export const DEFAULT_PLAY_PROMPT = '本次仅输出小剧场，不生成任何状态栏或待办等附加内容。';
export const DEFAULT_HIDDEN_TAGS = 'think,thinking,update,status';
export const DEFAULT_CONTINUE_PROMPTS = {
    history: 'Resume the preceding assistant reply exactly where it stops. Return only the added text, joining it naturally to the existing ending.',
    prompt: 'Resume the reply provided below exactly where it stops. Return only the added text, joining it naturally to the existing ending.\n\n{{lastChatMessage}}',
};

export function readPlayContinuationSettings(settings) {
    const mode = settings.playContinueMode === 'prompt' ? 'prompt' : 'history';
    return { mode, prompt: settings.playContinuePrompts?.[mode] ?? DEFAULT_CONTINUE_PROMPTS[mode] };
}

export function playContinuationError(continuation = readPlayContinuationSettings({})) {
    return continuation.mode === 'prompt' && !/\{\{lastChatMessage\}\}/i.test(continuation.prompt)
        ? '第二种方式需要在续写提示词中加入 {{lastChatMessage}}。' : '';
}

/** Empty strings are saved choices, not missing defaults. */
export function readPlaySettings(settings) {
    return {
        prompt: settings.playPrompt ?? DEFAULT_PLAY_PROMPT,
        hiddenTags: settings.playHiddenTags ?? DEFAULT_HIDDEN_TAGS,
        regexEnabled: settings.playRegexEnabled !== false,
        excludedRegex: settings.playRegexExclusions ?? [],
    };
}
