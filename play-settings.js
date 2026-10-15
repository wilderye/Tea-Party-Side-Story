export const DEFAULT_PLAY_PROMPT = '本次仅输出小剧场，不生成任何状态栏或待办等附加内容。';
export const DEFAULT_HIDDEN_TAGS = 'think,thinking,update,status';

/** Empty strings are saved choices, not missing defaults. */
export function readPlaySettings(settings) {
    return {
        prompt: settings.playPrompt ?? DEFAULT_PLAY_PROMPT,
        hiddenTags: settings.playHiddenTags ?? DEFAULT_HIDDEN_TAGS,
        regexEnabled: settings.playRegexEnabled !== false,
        excludedRegex: settings.playRegexExclusions ?? [],
    };
}
