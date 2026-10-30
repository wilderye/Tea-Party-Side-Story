import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlaySettings, DEFAULT_PLAY_PROMPT, DEFAULT_HIDDEN_TAGS } from '../play-settings.js';
import { hidePlayTags, readTavernRegex, processPlayText, processPlayPromptText, isPlayRegexSelected, createPlayDisplay, compileRegexGuard } from '../play-processing.js';
import { renderMarkdown } from '../markdown.js';

test('默认值实际生效，清空标签和提示词后不会恢复默认值', () => {
    assert.equal(readPlaySettings({}).prompt, DEFAULT_PLAY_PROMPT);
    assert.equal(readPlaySettings({}).hiddenTags, 'think,thinking,update,status');
    const settings = readPlaySettings({ playPrompt: '', playHiddenTags: '', playRegexEnabled: false });
    assert.equal(settings.prompt, ''); assert.equal(settings.hiddenTags, '');
    assert.equal(processPlayText('<thinking>保留</thinking>', settings, [], () => assert.fail()), '<thinking>保留</thinking>');
});

test('标签未闭合时保留完整内容，最外层闭合后隐藏，后续正文原样保留', () => {
    const open = '<thinking>甲乙丙';
    assert.equal(hidePlayTags(open, DEFAULT_HIDDEN_TAGS), open);
    assert.equal(hidePlayTags(open + '</thinking>\n**正文**', DEFAULT_HIDDEN_TAGS), '\n**正文**');
    assert.equal(hidePlayTags('<thinking>甲提到<thinking>乙</thinking>\n**正文**', DEFAULT_HIDDEN_TAGS), '\n**正文**');
    assert.equal(hidePlayTags('<thinking>外层<thinking>内层</thinking>后续</thinking>\n**正文**', DEFAULT_HIDDEN_TAGS), '\n**正文**');
    assert.equal(hidePlayTags('<thinking>外层<status>状态</status>后续</thinking>\n**正文**', DEFAULT_HIDDEN_TAGS), '\n**正文**');
    assert.equal(hidePlayTags('<status>状态</status>正文<update>更新</update>', DEFAULT_HIDDEN_TAGS), '正文');
    assert.equal(hidePlayTags('<thinking>正文也被包进去了</thinking>', DEFAULT_HIDDEN_TAGS), '');
    assert.equal(hidePlayTags('<thinking>分析中提到<status>状态尚未闭合</thinking>正文', DEFAULT_HIDDEN_TAGS), '正文');
    assert.equal(hidePlayTags('<thinking>思考中列出<status>与<update>标签</thinking>\n**小剧场正文**', DEFAULT_HIDDEN_TAGS), '\n**小剧场正文**');
    assert.equal(hidePlayTags('<think>思考提到<status>标签</think>正文', DEFAULT_HIDDEN_TAGS), '正文');
    assert.equal(hidePlayTags('<thinking>思考提到<status>与<thinking>未闭合', DEFAULT_HIDDEN_TAGS), '<thinking>思考提到<status>与<thinking>未闭合');
    assert.equal(hidePlayTags('<thinking>思考提到<status>与<thinking>标签</thinking>正文', DEFAULT_HIDDEN_TAGS), '正文');
    assert.equal(hidePlayTags('<thinking></thinking></thinking>', DEFAULT_HIDDEN_TAGS), '');
    assert.equal(hidePlayTags('<thinking>思考</thinking></thinking>正文', DEFAULT_HIDDEN_TAGS), '正文');
    assert.equal(hidePlayTags('<thinking>思考</thinking>\n</thinking>\n**正文**', DEFAULT_HIDDEN_TAGS), '\n**正文**');
    assert.equal(hidePlayTags('</thinking>孤立闭合开头的正文', DEFAULT_HIDDEN_TAGS), '</thinking>孤立闭合开头的正文');
    assert.equal(hidePlayTags('<thinking>闭合`</thinking>`后输出，仅输出`<thinking>`思维链</thinking>正文', DEFAULT_HIDDEN_TAGS), '正文');
    assert.equal(hidePlayTags('<thinking>包含`<status>`代码</thinking>正文', DEFAULT_HIDDEN_TAGS), '正文');
});

test('隐藏名单支持中英文逗号、换行和空行，旧名单仍按原来的名称生效', () => {
    const source = '<think>思考</think><thinking>思考</thinking><update>更新</update><status>状态</status>正文';
    for (const names of [DEFAULT_HIDDEN_TAGS, 'think，thinking，update，status', ' think, thinking，\n\nupdate\r\nstatus,, ']) {
        assert.equal(hidePlayTags(source, names), '正文');
    }
    assert.equal(hidePlayTags(source, 'thinking\nstatus\nupdate'), '<think>思考</think>正文');
    assert.equal(hidePlayTags(source, ',，\n\r\n '), source);
});

test('英文标签在正则之后由正文渲染隐藏，中文标签、正文和完整原文都保留', () => {
    const source = '<content>\n<regard>**正文**</regard>\n</content><中文>后续</中文>';
    const settings = readPlaySettings({ playHiddenTags: '' });
    const rules = [{ key: 'body', script: { placement: [2] } }];
    let calls = 0;
    const shown = processPlayText(source, settings, rules, (_script, text) => {
        calls++; assert.equal(text, source); return text.replace('正文**', '替换后的正文**');
    });
    assert.equal(calls, 1);
    assert.equal(shown, source.replace('正文**', '替换后的正文**'));
    assert.equal(renderMarkdown(shown, { hideEnglishTags: true }), '<p><br>\n<strong>替换后的正文</strong><br>\n&lt;中文&gt;后续&lt;/中文&gt;</p>\n');
    assert.equal(source, '<content>\n<regard>**正文**</regard>\n</content><中文>后续</中文>');
    const unfinished = processPlayText('<content>尚未闭合的正文', { ...settings, regexEnabled: false }, rules, () => assert.fail());
    assert.equal(renderMarkdown(unfinished, { hideEnglishTags: true }), '<p>尚未闭合的正文</p>\n');
    assert.equal(processPlayText('<status>保留</status>', settings, [], () => assert.fail()), '<status>保留</status>');
});

test('正文处理保留网页属性、脚本、样式、标签和网页代码示例', () => {
    const html = '<!doctype html><html><head><style>p::after{content:"<content>"}</style></head>'
        + '<body data-template="<内容>"><script>window.template="<content>保留</content>"</script>'
        + '<p>正文</p><pre><code><content>代码示例</content></code></pre>'
        + '<textarea><内容>输入示例</内容></textarea><!-- <content>注释</content> --></body></html>';
    const wrapped = `<content><内容>${html}</内容></content>`;
    assert.equal(processPlayText(wrapped, readPlaySettings({}), [], () => assert.fail()), wrapped);
});

test('只识别大小写和写法一致的标签，代码框也处理，其他字节不改动', () => {
    const untouched = '<STATUS>大写</STATUS><status type="a">属性</status><status/>\r\n';
    const source = untouched + '```text\n<status>隐藏</status>\n```\n<thinking>未闭合';
    assert.equal(hidePlayTags(source, 'status\nthinking'), untouched + '```text\n\n```\n<thinking>未闭合');
    assert.equal(hidePlayTags('<a.b>删除</a.b><axb>保留</axb>', 'a.b'), '<axb>保留</axb>');
});

function fixture() {
    const script = (id, extra = {}) => ({ id, scriptName: id, placement: [2], findRegex: '标记', replaceString: id,
        minDepth: 999, maxDepth: 0, ...extra });
    const groups = {
        0: [script('display', { markdownOnly: true }), script('same'), script('prompt', { promptOnly: true }), script('off', { disabled: true }), script('user', { placement: [1] })],
        2: [script('same')],
        1: [script('same'), script('both', { markdownOnly: true, promptOnly: true })],
    };
    const ctx = { characters: [{ avatar: 'A.png', name: '角色甲' }, { avatar: 'B.png', name: '角色乙' }], characterId: 0, extensionSettings: {} };
    const engine = {
        SCRIPT_TYPES: { GLOBAL: 0, PRESET: 2, SCOPED: 1 }, regex_placement: { AI_OUTPUT: 2 },
        getCurrentPresetAPI: () => 'openai', getCurrentPresetName: () => '预设甲',
        getScriptsByType(type) { return groups[type]; },
        runRegexScript(script, text) { return script.disabled ? text : text.replaceAll('标记', script.replaceString); },
    };
    return { ctx, engine, groups };
}

test('显示和收藏前处理使用该回复保存的人设名字，查找和修剪也遵守宏替换模式', async () => {
    for (const taskBound of [false, true]) {
        const f = fixture(), calls = [];
        f.ctx.name1 = '当前人设';
        f.engine.taskBound = taskBound;
        f.engine.runRegexScript = (script, text) => { calls.push(script); return text; };
        const display = createPlayDisplay(() => f.ctx, {}, async () => f.engine);
        for (const mode of [0, 1, 2]) {
            f.groups[0] = [{ id: 'names', placement: [2], findRegex: '/{{user}}/g',
                replaceString: '{{char}}/{{user}}', trimStrings: ['<user>'], substituteRegex: mode }];
            f.groups[1] = []; f.groups[2] = [];
            await display.refresh(f.ctx.characters[0]);
            display.process('正文', f.ctx.characters[0], { userName: '旧人设.[+]' });
            const script = calls.at(-1);
            assert.equal(script.replaceString, '角色甲/旧人设.[+]');
            assert.deepEqual(script.trimStrings, ['旧人设.[+]']);
            assert.equal(script.findRegex, mode === 0 ? '/{{user}}/g' : mode === 1 ? '/旧人设.[+]/g' : '/旧人设\\.\\[\\+\\]/g');
        }
        display.process('正文', f.ctx.characters[0]);
        assert.equal(calls.at(-1).replaceString, '角色甲/{{user}}', '旧记录没有人设时仍由对应引擎处理');
    }
});

test('三处规则都读取，普通回复先于显示规则执行，脱离聊天的文本不虚构深度', () => {
    const f = fixture(), rules = readTavernRegex(f.engine, f.ctx), calls = [];
    assert.deepEqual(rules.map(rule => rule.script.id), ['display', 'same', 'prompt', 'off', 'user', 'same', 'same', 'both']);
    const original = '<status>不应参与美化</status>正文';
    const result = processPlayText(original, readPlaySettings({}), rules, (script, text) => {
        calls.push(script.id); assert.doesNotMatch(text, /不应参与美化/); return text;
    });
    assert.equal(result, '正文');
    assert.deepEqual(calls, ['same', 'same', 'same', 'display', 'both']);
    assert.equal(original, '<status>不应参与美化</status>正文');
    f.ctx.extensionSettings.disabledExtensions = ['regex'];
    const disabled = readTavernRegex(f.engine, f.ctx);
    assert.equal(disabled.length, rules.length, '酒馆关闭正则后，规则仍可在插件选择');
    assert.ok(disabled.every(rule => !isPlayRegexSelected(rule, readPlaySettings({}))));
});

test('同标识的规则按来源和所属角色预设分开，排除一处不影响另外两处', () => {
    const f = fixture(), rules = readTavernRegex(f.engine, f.ctx);
    const same = rules.filter(rule => rule.script.id === 'same');
    assert.equal(new Set(same.map(rule => rule.key)).size, 3);
    const calls = [];
    processPlayText('正文', readPlaySettings({ playRegexExclusions: [same[1].key] }), rules, (script, text) => { calls.push(script); return text; });
    assert.equal(calls.filter(script => script.id === 'same').length, 2);
    f.ctx.characterId = 1;
    const next = readTavernRegex(f.engine, f.ctx);
    assert.notEqual(next.find(rule => rule.source === 'SCOPED').key, same[2].key);
    assert.equal(next.find(rule => rule.source === 'GLOBAL' && rule.script.id === 'same').key, same[0].key);
});

test('显示和发送共用选择，保留各自用途、消息角色和执行顺序，酒馆关闭的规则可单独启用', () => {
    const f = fixture(), rules = readTavernRegex(f.engine, f.ctx);
    const apply = (config, placement, purpose) => {
        const calls = [];
        const runRegexScript = (script, text) => { assert.ok(!script.disabled); calls.push(script.id); return text; };
        if (purpose === 'display') processPlayText('正文', config, rules, runRegexScript, placement);
        else processPlayPromptText('正文', config, rules, { runRegexScript }, placement);
        return calls;
    };
    const defaults = readPlaySettings({});
    assert.deepEqual(apply(defaults, 2, 'display'), ['same', 'same', 'same', 'display', 'both']);
    assert.deepEqual(apply(defaults, 2, 'prompt'), ['same', 'same', 'same', 'prompt', 'both']);
    assert.deepEqual(apply(defaults, 1, 'display'), ['user']);
    assert.deepEqual(apply(defaults, 1, 'prompt'), ['user']);
    const settings = readPlaySettings({ playRegexOverrides: Object.fromEntries(rules.map(rule => [rule.key, rule.script.id === 'off'])) });
    assert.deepEqual(rules.filter(rule => isPlayRegexSelected(rule, settings)).map(rule => rule.script.id), ['off']);
    assert.deepEqual(apply(settings, 2, 'display'), ['off']);
    assert.deepEqual(apply(settings, 2, 'prompt'), ['off']);
    assert.equal(f.groups[0].find(script => script.id === 'off').disabled, true, '启用副本不改酒馆');
    assert.deepEqual(apply({ ...settings, regexEnabled: false }, 2, 'display'), []);
    assert.deepEqual(apply({ ...settings, regexEnabled: false }, 2, 'prompt'), []);
});

test('未允许的预设和非当前角色规则仍列出，默认关闭，勾选后只处理目标角色', async () => {
    const f = fixture();
    f.ctx.characters[1].data = { extensions: { regex_scripts: [{ id: 'same', scriptName: '乙', placement: [1, 2], replaceString: '乙' }] } };
    f.engine.getScriptsByType = (type, { allowedOnly }) => type === 2 && allowedOnly ? [] : f.groups[type];
    const before = structuredClone({ context: f.ctx, groups: f.groups });
    const settings = {}, display = createPlayDisplay(() => f.ctx, settings, async () => f.engine);
    await display.refresh(f.ctx.characters[1]);
    const preset = display.rules.find(rule => rule.source === 'PRESET'), scoped = display.rules.find(rule => rule.source === 'SCOPED');
    assert.equal(preset.enabled, false); assert.equal(scoped.enabled, false);
    assert.equal(scoped.key, JSON.stringify(['SCOPED', 'B.png', 'same']));
    assert.equal(display.rules.some(rule => rule.key.includes('A.png')), false);
    settings.playRegexOverrides = Object.fromEntries(display.rules.map(rule => [rule.key, rule === scoped]));
    display.updateSettings();
    assert.equal(display.process('标记', f.ctx.characters[1]), '乙');
    assert.equal(display.process('标记', f.ctx.characters[1], undefined, 'user'), '乙');
    const revision = display.revision;
    f.ctx.extensionSettings.character_allowed_regex = ['B.png']; await display.refresh();
    assert.ok(display.revision > revision, '酒馆权限变化刷新显示缓存');
    delete f.ctx.extensionSettings.character_allowed_regex;
    assert.deepEqual({ context: f.ctx, groups: f.groups }, before);
});

test('深度规则只清空符合深度的分支，取消勾选阻止发送；开关关闭仍去掉隐藏标签', () => {
    const f = fixture();
    f.groups[0] = [{ id: 'erase', placement: [1, 2], promptOnly: true, findRegex: '[\\s\\S]+', replaceString: '', minDepth: 7, maxDepth: null }];
    f.groups[1] = []; f.groups[2] = [];
    const rules = readTavernRegex(f.engine, f.ctx), source = '分支正文<status>隐藏</status>';
    const engine = { runRegexScript: (script, text) => text.replace(new RegExp(script.findRegex), script.replaceString) };
    for (const placement of [1, 2]) {
        assert.equal(processPlayPromptText(source, readPlaySettings({}), rules, engine, placement, 6), '分支正文');
        assert.equal(processPlayPromptText(source, readPlaySettings({}), rules, engine, placement, 7), '');
        for (const saved of [{ playRegexExclusions: [rules[0].key] }, { playRegexOverrides: { [rules[0].key]: false } }, { playRegexEnabled: false }]) {
            const settings = readPlaySettings(saved);
            assert.equal(processPlayPromptText(source, settings, rules, engine, placement, 7), '分支正文');
            assert.equal(processPlayText(source, settings, rules, engine.runRegexScript, placement, 7), '分支正文');
        }
    }
});

test('酒馆已保存正文只执行发送规则，插件原文先执行普通规则且不修改来源', () => {
    const f = fixture();
    f.groups[0] = [
        { id: 'ordinary', placement: [1, 2], findRegex: '正文', replaceString: '正文追加', minDepth: null, maxDepth: null },
        { id: 'prompt', placement: [1, 2], promptOnly: true, findRegex: '发送', replaceString: '处理后', minDepth: 0, maxDepth: 0 },
    ];
    f.groups[1] = []; f.groups[2] = [];
    const rules = readTavernRegex(f.engine, f.ctx), settings = readPlaySettings({ playHiddenTags: '' });
    const engine = { runRegexScript: (script, text) => text.replace(new RegExp(script.findRegex), script.replaceString) };
    const native = '正文追加发送', branch = '正文发送';
    for (const placement of [1, 2]) {
        assert.equal(processPlayPromptText(native, settings, rules, engine, placement, 0, false), '正文追加处理后');
        assert.equal(processPlayPromptText(branch, settings, rules, engine, placement, 0), '正文追加处理后');
    }
    assert.equal(native, '正文追加发送'); assert.equal(branch, '正文发送');
});

test('旧取消勾选只在读取时兼容，新选择可覆盖旧排除而不改变源设置', () => {
    const saved = { playRegexExclusions: ['a', 'b'], playRegexOverrides: { a: true, c: false } }, before = structuredClone(saved);
    assert.deepEqual(readPlaySettings(saved).regexOverrides, { a: true, b: false, c: false });
    assert.deepEqual(saved, before);
});

test('规则改名改内容仍排除；新规则默认生效，刷新前保留当前显示用规则', async () => {
    const f = fixture(), settings = { playHiddenTags: '', playRegexExclusions: [] };
    f.groups[0] = [f.groups[0][1]]; f.groups[1] = []; f.groups[2] = [];
    const display = createPlayDisplay(() => f.ctx, settings, async () => f.engine);
    await display.refresh();
    assert.equal(display.process('标记'), 'same');
    f.groups[0][0].replaceString = '酒馆修改后的内容';
    assert.equal(display.process('标记'), 'same', '读取结果不直接引用酒馆可变对象');
    settings.playRegexExclusions = [display.rules[0].key];
    display.updateSettings();
    f.groups[0][0].scriptName = '改了名字'; await display.refresh();
    assert.equal(display.process('标记'), '标记');
    f.groups[0] = []; await display.refresh();
    assert.equal(settings.playRegexExclusions.length, 1, '暂时缺失不清掉选择');
    f.groups[0] = [{ id: 'new', scriptName: '改了名字', placement: [2], replaceString: '新规则' }];
    await display.refresh(); assert.equal(display.process('标记'), '新规则');
    settings.playRegexEnabled = false; settings.playHiddenTags = 'status'; display.updateSettings();
    assert.equal(display.process('<status>隐藏</status>标记'), '标记', '总开关仅停正则，不停标签隐藏');
});

test('规则来源名称跟随同一次读取，切换酒馆角色后在刷新时一起更新', async () => {
    const f = fixture(), display = createPlayDisplay(() => f.ctx, {}, async () => f.engine);
    await display.refresh();
    assert.deepEqual(display.sources, { PRESET: '预设甲', SCOPED: '角色甲' });
    f.ctx.characterId = 1; f.engine.getCurrentPresetName = () => '预设乙';
    assert.deepEqual(display.sources, { PRESET: '预设甲', SCOPED: '角色甲' });
    await display.refresh();
    assert.deepEqual(display.sources, { PRESET: '预设乙', SCOPED: '角色乙' });
    f.engine.getScriptsByType = () => { throw Error('读取失败'); };
    await assert.rejects(display.refresh(), /读取失败/);
    assert.deepEqual(display.sources, {}); assert.deepEqual(display.rules, []);
});

test('刷新显示规则时保留可用快照，不出现临时空规则；只有完整新结果才替换', async () => {
    const f = fixture();
    f.groups[0] = [{ id: 'one', scriptName: '规则', placement: [2], replaceString: 'old' }];
    f.groups[1] = []; f.groups[2] = [];
    let release, gate;
    const display = createPlayDisplay(() => f.ctx, {}, async () => { if (gate) await gate; return f.engine; });
    const target = f.ctx.characters[0];
    assert.equal(display.isReady(target), false);
    await display.refresh(target);
    assert.equal(display.isReady(target), true);
    assert.equal(display.process('标记', target), 'old');
    gate = new Promise(resolve => { release = resolve; });
    const pending = display.refresh(target);
    f.groups[0][0].replaceString = 'new';
    assert.equal(display.process('标记', target), 'old', '网络等待期间仍按上次完整快照显示');
    release(); await pending;
    assert.equal(display.process('标记', target), 'new');
});

test('重复刷新或未改动配置时不递增 revision，配置与规则变更时才使缓存失效', async () => {
    const f = fixture(), settings = { playHiddenTags: 'think', playRegexExclusions: [] };
    const display = createPlayDisplay(() => f.ctx, settings, async () => f.engine);
    assert.equal(display.revision, 0);

    // 首次读取规则，revision 从 0 增至 1
    await display.refresh();
    assert.equal(display.revision, 1);

    // 酒馆与插件配置均未改变，重复 refresh 不应递增 revision（保留界面输出缓存）
    await display.refresh();
    assert.equal(display.revision, 1);

    // 未改变配置的 updateSettings 也不应递增 revision
    display.updateSettings();
    assert.equal(display.revision, 1);

    // 修改隐藏标签配置后 updateSettings 递增 revision
    settings.playHiddenTags = 'think,thinking';
    display.updateSettings();
    assert.equal(display.revision, 2);

    // 修改酒馆规则后 refresh 递增 revision
    f.groups[0][0].replaceString = '新替换文字';
    await display.refresh();
    assert.equal(display.revision, 3);
});

test('无锚点贪婪匹配在缺失触发词时快速短路跳过，包含触发词时正常执行', () => {
    const dangerousRegex = '/([\\s\\S]*)(?:<\\/think>|<\\/thinking>|<\\/wave>|<\\/Fleur>|\\[[Pp]\\w*\\s+[Ww]\\w*:\\])/m';
    const guard = compileRegexGuard(dangerousRegex);
    assert.ok(guard, '成功提取无锚点通配规则的守卫');
    assert.deepEqual(guard.literals, ['</think>', '</thinking>', '</wave>', '</Fleur>', ':]']);

    // 正文缺少任意候选词时，canMatch 判定为 false
    const cleanText = '这是一段正常的长篇正文，不包含任何特殊隐藏标签。'.repeat(100);
    assert.equal(guard.canMatch(cleanText), false);

    // 正文包含其一（例如 </think> 或 :]）时，canMatch 判定为 true
    assert.equal(guard.canMatch('思考过程</think>正文'), true);
    assert.equal(guard.canMatch('[Prompt Word:]正文'), true);

    // processPlayText 实际集成测试：短路跳过后不调用 runRegex，存在触发词时调用 runRegex
    const rule = { key: 'danger', script: { placement: [2], findRegex: dangerousRegex, replaceString: '' } };
    let runCalls = 0;
    const settings = readPlaySettings({ playRegexEnabled: true });

    // 缺失触发词 -> 0 次调用 runRegex，直接返回
    const resultSkipped = processPlayText(cleanText, settings, [rule], () => { runCalls++; return ''; });
    assert.equal(runCalls, 0);
    assert.equal(resultSkipped, cleanText);

    // 存在触发词 -> 触发 runRegex
    const textWithTag = '思考</think>正文';
    const resultRun = processPlayText(textWithTag, settings, [rule], (_script, text) => { runCalls++; return text.replace(/[\s\S]*<\/think>/, ''); });
    assert.equal(runCalls, 1);
    assert.equal(resultRun, '正文');
});

test('预检查只排除确实不可能匹配的正文，分组选择、可选分组和 Unicode 大小写不误判', () => {
    for (const [pattern, flags, text] of [
        [String.raw`[\s\S]*?(?:<content>|<正文>)([\s\S]*)`, '', '前言<正文>真正的正文'],
        [String.raw`[\s\S]*?(foo)?bar`, '', '前言bar'],
        [String.raw`[\s\S]*?(?:foo|bar)?baz`, '', 'baz'],
        [String.raw`[\s\S]*(?:foo|bar)tail`, '', 'bartail'],
        [String.raw`[\s\S]*?(?!secret)foo`, '', '前言foo'],
        [String.raw`[\s\S]*?(?<named>foo)\k<named>`, '', 'foofoo'],
        [String.raw`[\s\S]*k`, 'iu', 'K'],
        [String.raw`[\s\S]*(?:|foo)`, '', '正文'],
    ]) {
        const regex = new RegExp(pattern, flags);
        assert.equal(regex.test(text), true, pattern);
        const guard = compileRegexGuard(`/${pattern}/${flags}`);
        assert.ok(!guard || guard.canMatch(text), `${pattern} 不得跳过实际能匹配的正文`);
    }
    const pattern = String.raw`[\s\S]*?(?:<content>|<正文>)([\s\S]*)`;
    const rule = { key: 'extract', script: { placement: [2], findRegex: pattern, replaceString: '$1' } };
    const actual = processPlayText('前言<正文>真正的正文', readPlaySettings({ playHiddenTags: '' }), [rule],
        (script, text) => text.replace(new RegExp(script.findRegex), script.replaceString));
    assert.equal(actual, '真正的正文');
});

