import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAY_PROMPT, RECOMMENDED_PLAY_PROMPT, readPlayPromptSettings, readPlaySettings } from '../play-settings.js';

test('默认小剧场提示词要求只输出小剧场内容', () => {
    assert.equal(DEFAULT_PLAY_PROMPT, '按要求输出思维链后仅输出小剧场内容，不生成任何附加模块如顶部/尾部状态栏/待办/变量命令/总结等。');
});

test('首次读取提供默认和强调完整性提示词，保持旧内容以及留空的选择，不写入设置', () => {
    for (const legacy of [undefined, '已保存的小剧场要求', '']) {
        const settings = legacy === undefined ? {} : { playPrompt: legacy };
        const before = structuredClone(settings);
        const config = readPlayPromptSettings(settings);
        assert.deepEqual(config, {
            presets: [
                { id: 'default', name: '默认提示词', content: legacy ?? DEFAULT_PLAY_PROMPT },
                { id: 'recommended', name: '强调完整性', content: RECOMMENDED_PLAY_PROMPT },
            ],
            selectedId: 'default', position: 'user-after',
        });
        assert.equal(readPlaySettings(settings).prompt, legacy ?? DEFAULT_PLAY_PROMPT);
        assert.deepEqual(settings, before);
    }
});

test('一次只使用选中的一条提示词，使用已编辑的内容和统一位置', () => {
    const settings = { playPromptConfig: { presets: [
        { id: 'default', name: '默认提示词', content: '旧默认' },
        { id: 'recommended', name: '强调完整性', content: '改过的推荐' },
        { id: 'custom-test', name: '用户新增', content: '新增要求' },
    ], selectedId: 'recommended', position: 'user-after' } };
    assert.equal(readPlaySettings(settings).prompt, '改过的推荐');
    assert.equal(readPlaySettings(settings).promptPosition, 'user-after');
    settings.playPromptConfig.selectedId = 'custom-test';
    assert.equal(readPlaySettings(settings).prompt, '新增要求');
    settings.playPromptConfig.presets[2].content = '';
    assert.equal(readPlaySettings(settings).prompt, '');
});

test('升级时只替换旧内置默认提示词和名称，保留用户改过的内容', () => {
    const settings = { playPromptConfig: { presets: [
        { id: 'default', name: '默认提示词', content: '本次仅输出小剧场，不生成任何状态栏或待办等附加内容。' },
        { id: 'recommended', name: '推荐提示词', content: '用户改过的完整性要求' },
    ], selectedId: 'default' } };
    const config = readPlayPromptSettings(settings);
    assert.equal(config.presets[0].content, DEFAULT_PLAY_PROMPT);
    assert.equal(config.presets[1].name, '强调完整性');
    assert.equal(config.presets[1].content, '用户改过的完整性要求');
    assert.equal(settings.playPromptConfig.presets[0].content, '本次仅输出小剧场，不生成任何状态栏或待办等附加内容。');
});

test('无效选择和位置回到默认，缺少内置项时补齐', () => {
    const settings = { playPromptConfig: { presets: [], selectedId: 'removed', position: 'unknown' } };
    assert.equal(readPlaySettings(settings).prompt, DEFAULT_PLAY_PROMPT);
    assert.equal(readPlaySettings(settings).promptPosition, 'user-after');
    assert.deepEqual(readPlayPromptSettings(settings).presets.map(preset => preset.id), ['default', 'recommended']);
});

test('已保存的三种插入位置均保留，缺少位置时使用最新用户消息后', () => {
    for (const position of ['start', 'user-before', 'user-after']) {
        const settings = { playPromptConfig: { position } };
        assert.equal(readPlaySettings(settings).promptPosition, position);
        assert.deepEqual(settings, { playPromptConfig: { position } });
    }
    assert.equal(readPlaySettings({ playPromptConfig: { presets: [] } }).promptPosition, 'user-after');
});
