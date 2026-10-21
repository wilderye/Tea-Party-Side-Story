import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAY_PROMPT, RECOMMENDED_PLAY_PROMPT, readPlayPromptSettings, readPlaySettings } from '../play-settings.js';

test('首次读取提供默认和推荐提示词，保持旧内容以及留空的选择，不写入设置', () => {
    for (const legacy of [undefined, '已保存的小剧场要求', '']) {
        const settings = legacy === undefined ? {} : { playPrompt: legacy };
        const before = structuredClone(settings);
        const config = readPlayPromptSettings(settings);
        assert.deepEqual(config, {
            presets: [
                { id: 'default', name: '默认提示词', content: legacy ?? DEFAULT_PLAY_PROMPT },
                { id: 'recommended', name: '推荐提示词', content: RECOMMENDED_PLAY_PROMPT },
            ],
            selectedId: 'default', position: 'start',
        });
        assert.equal(readPlaySettings(settings).prompt, legacy ?? DEFAULT_PLAY_PROMPT);
        assert.deepEqual(settings, before);
    }
});

test('一次只使用选中的一条提示词，使用已编辑的内容和统一位置', () => {
    const settings = { playPromptConfig: { presets: [
        { id: 'default', name: '默认提示词', content: '旧默认' },
        { id: 'recommended', name: '推荐提示词', content: '改过的推荐' },
        { id: 'custom-test', name: '用户新增', content: '新增要求' },
    ], selectedId: 'recommended', position: 'user-after' } };
    assert.equal(readPlaySettings(settings).prompt, '改过的推荐');
    assert.equal(readPlaySettings(settings).promptPosition, 'user-after');
    settings.playPromptConfig.selectedId = 'custom-test';
    assert.equal(readPlaySettings(settings).prompt, '新增要求');
    settings.playPromptConfig.presets[2].content = '';
    assert.equal(readPlaySettings(settings).prompt, '');
});

test('无效选择和位置回到默认，缺少内置项时补齐', () => {
    const settings = { playPromptConfig: { presets: [], selectedId: 'removed', position: 'unknown' } };
    assert.equal(readPlaySettings(settings).prompt, DEFAULT_PLAY_PROMPT);
    assert.equal(readPlaySettings(settings).promptPosition, 'start');
    assert.deepEqual(readPlayPromptSettings(settings).presets.map(preset => preset.id), ['default', 'recommended']);
});
