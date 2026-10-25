import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayTemplateContext, readPlayTemplateFeatures } from '../play-template-context.js';
import { replacePlayVariableMacros } from '../play-macro-context.js';
import { readPlayInitialVariables, readPlayHelperVariables } from '../play-variable-context.js';
import { canUseNativePlayScope } from '../play-independent.js';

const libraries = { _: {
    get(value, path, fallback) { return String(path).split('.').reduce((item, key) => item?.[key], value) ?? fallback; },
    unescape: value => value,
    mergeWith(target, value) { Object.assign(target, value); },
}, YAML: { parse: JSON.parse, stringify: JSON.stringify } };
const environment = () => ({ character: { name: '目标角色', avatar: 'A.png' }, characterCard: { name: '目标角色' },
    sourceCharacterId: 1, noChat: false, nativeChat: { chatId: 'latest' },
    tavern: { userAvatar: 'bound', templateFeatures: { enabled: true }, extensionSettings: { variables: { global: { globalValue: 3 } } } } });
const resolved = () => ({ chatId: 'latest', messages: [], metadata: { variables: { chatValue: 2 } },
    persona: { id: 'bound', name: '目标人设' }, variables: { stat_data: { year: 749 } } });
const signal = () => new AbortController().signal;

test('酒馆助手资料的形状改变或无法复制时跳过变量，不影响普通角色卡', () => {
    for (const value of [undefined, [{}], { variables: [] }, { variables: { unsupported() {} } }]) assert.deepEqual(readPlayHelperVariables(value), {});
    assert.deepEqual(readPlayHelperVariables([['variables', { value: 3 }]]), { value: 3 });
});

test('没有 EJS 接口、接口变动、编译失败或执行失败时保留原文，普通文字不访问接口', async () => {
    const source = '普通说明 <%= getvar("stat_data.year") %> 尾部';
    const hosts = [undefined, {}, { compileTemplate() { throw Error('Changed public interface'); } },
        { compileTemplate: async () => { throw Error('Compilation failed'); } },
        { compileTemplate: async () => () => { throw Error('Unsupported template helper'); } },
        { compileTemplate: async () => () => undefined }];
    for (const host of hosts) {
        const template = createPlayTemplateContext(environment(), resolved(), libraries, signal(), host);
        assert.equal(await template.process(source), source);
        assert.equal(await template.process('普通角色设定'), '普通角色设定');
    }
    const host = { get compileTemplate() { throw Error('Must not inspect for plain text'); } };
    assert.equal(await createPlayTemplateContext(environment(), resolved(), libraries, signal(), host).process('普通内容'), '普通内容');
});

test('只调用公开编译方法，变量、人设和聊天属于本次任务，不准备主聊天上下文', async () => {
    const target = resolved(), before = structuredClone(target), calls = [];
    const host = { prepareContext() { throw Error('Must not read current chat'); },
        compileTemplate: async (source, options) => {
            calls.push({ source, options });
            return data => [data.charName, data.userName, data.getvar('stat_data.year'), data.getLocalVar('chatValue'), data.getGlobalVar('globalValue')].join('/');
        } };
    const template = createPlayTemplateContext(environment(), target, libraries, signal(), host);
    const source = '<%= getvar("stat_data.year") %>';
    assert.equal(await template.process(source), '目标角色/目标人设/749/2/3');
    assert.equal(await template.process(source), '目标角色/目标人设/749/2/3');
    assert.equal(calls.length, 1, '同一任务重复模板复用编译结果');
    assert.equal(calls[0].options.logging, false);
    assert.deepEqual(target, before);
});

test('EJS 缺少变量时保留整段原文，不把表达式换成空白；禁用状态不执行', async () => {
    let calls = 0;
    const host = { compileTemplate: async () => { calls++; return data => data.getvar('missing'); } };
    const source = '保留前后内容 <%= getvar("missing") %>';
    assert.equal(await createPlayTemplateContext(environment(), resolved(), libraries, signal(), host).process(source), source);
    const env = environment(); env.tavern.templateFeatures.enabled = false;
    assert.equal(await createPlayTemplateContext(env, resolved(), libraries, signal(), host).process(source), source);
    assert.equal(calls, 1);
    assert.deepEqual(readPlayTemplateFeatures({ getFeatures() { throw Error('Plugin changed'); } }), { enabled: false });
});

test('EJS 编译期间停止仍然停止本次任务，不作为兼容失败继续发送', async () => {
    const controller = new AbortController(); let finish;
    const host = { compileTemplate: () => new Promise(resolve => { finish = resolve; }) };
    const template = createPlayTemplateContext(environment(), resolved(), libraries, controller.signal, host);
    const pending = template.process('<%= 1 %>');
    controller.abort(new DOMException('停止测试', 'AbortError')); finish(() => '1');
    await assert.rejects(pending, { name: 'AbortError' });
});

test('失败的模板不能把修改的变量带到下一段模板或原聊天', async () => {
    const target = resolved();
    const host = { compileTemplate: async source => source === '<% bad %>' ? data => {
        data.variables.stat_data.year = 1;
        data.getvar('stat_data').year = 2;
        throw Error('Synthetic failure');
    } : data => String(data.getvar('stat_data.year')) };
    const template = createPlayTemplateContext(environment(), target, libraries, signal(), host);
    assert.equal(await template.process('<% bad %>'), '<% bad %>');
    assert.equal(await template.process('<%= year %>'), '749');
    assert.equal(target.variables.stat_data.year, 749);
});

test('可读取的变量宏正常替换，未知宏及未知变量保持原样', () => {
    const source = '{{get_message_variable::stat_data.year}}/{{get_message_variable::missing}}/{{custom_macro}}';
    assert.equal(replacePlayVariableMacros(source, { message: resolved().variables }, libraries),
        '749/{{get_message_variable::missing}}/{{custom_macro}}');
    for (const kind of ['get', 'format', 'format_quoted']) {
        const macro = kind === 'format_quoted' ? '{{format_message_variable_quoted::missing}}' : '{{' + kind + '_message_variable::missing}}';
        assert.equal(replacePlayVariableMacros('  ' + macro, {}, libraries), '  ' + macro);
    }
});

test('普通初始 JSON/YAML 使用已提供的解析器，复杂初值失败不阻止生成也不改世界书', async () => {
    const entries = [{ comment: '[initvar]', content: '{"year":750}' }];
    const context = { worldNames: ['fixture'], loadWorldInfo: async () => ({ entries }) };
    const before = structuredClone(entries);
    assert.deepEqual(await readPlayInitialVariables(environment(), context, text => text, libraries, signal()), { stat_data: { year: 750 } });
    assert.deepEqual(entries, before);
    for (const content of ['<%= initializationScript() %>', '{{unsupported_initial_macro}}', '{invalid', '[]']) {
        entries[0].content = content;
        assert.equal(await readPlayInitialVariables(environment(), context, text => text, libraries, signal()), null);
    }
});

test('已打开的当前聊天才使用原入口；不发聊天、其他角色或人设不匹配时隔离处理', () => {
    const env = environment(), target = resolved();
    const context = { characterId: 0, characters: [env.character], chatId: 'latest' };
    assert.equal(canUseNativePlayScope(context, env, target), true);
    assert.equal(canUseNativePlayScope(context, { ...env, noChat: true }, target), false);
    assert.equal(canUseNativePlayScope({ ...context, chatId: 'other' }, env, target), false);
    assert.equal(canUseNativePlayScope({ ...context, characters: [{ avatar: 'B.png' }] }, env, target), false);
    assert.equal(canUseNativePlayScope(context, env, { ...target, persona: { id: 'other' } }), false);
});
