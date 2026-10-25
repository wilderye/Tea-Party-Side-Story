import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayTemplateContext, readPlayTemplateFeatures } from '../play-template-context.js';
import { replacePlayVariableMacros } from '../play-macro-context.js';
import { readPlayInitialVariables, readPlayHelperVariables } from '../play-variable-context.js';
import { canUseNativePlayScope } from '../play-independent.js';

const cloneDefinitions = (value, customizer = () => undefined) => {
    const custom = customizer(value);
    if (custom !== undefined) return custom;
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => cloneDefinitions(item, customizer));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDefinitions(item, customizer)]));
};
const libraries = { _: {
    get(value, path, fallback) { return String(path).split('.').reduce((item, key) => item?.[key], value) ?? fallback; },
    unescape: value => value,
    set(target, path, value) {
        const keys = String(path).split('.'), last = keys.pop();
        for (const key of keys) target = target[key] ??= {};
        target[last] = value;
    },
    isPlainObject: value => value?.constructor === Object,
    cloneDeep: cloneDefinitions,
    cloneDeepWith: cloneDefinitions,
    mergeWith(target, value, customizer = () => undefined) {
        for (const [key, item] of Object.entries(value)) target[key] = customizer(target[key], item)
            ?? (item?.constructor === Object ? this.mergeWith(target[key] ?? {}, item, customizer) : item);
        return target;
    },
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

test('EJS 缺少变量时留空，不补默认值；插件或生成处理禁用时不执行', async () => {
    let calls = 0;
    const host = { compileTemplate: async () => { calls++; return data => '保留前后内容 ' + (data.getvar('missing') ?? ''); } };
    const source = '保留前后内容 <%= getvar("missing") %>';
    const target = resolved();
    assert.equal(await createPlayTemplateContext(environment(), target, libraries, signal(), host).process(source), '保留前后内容 ');
    assert.equal(Object.hasOwn(target.variables, 'missing'), false);
    for (const feature of ['enabled', 'generate_enabled']) {
        const env = environment(); env.tavern.templateFeatures[feature] = false;
        assert.equal(await createPlayTemplateContext(env, resolved(), libraries, signal(), host).process(source), source);
    }
    assert.equal(calls, 1);
    assert.deepEqual(readPlayTemplateFeatures({ getFeatures() { throw Error('Plugin changed'); } }), { enabled: false });
});

test('EJS 读取本任务合并后的变量，初值随后加入也可读取且不污染原资料', async () => {
    const target = resolved(); target.variables = {};
    const host = { compileTemplate: async () => data => [data.getvar('stat_data.year'),
        data.getvar('chatValue'), data.getvar('globalValue'), data.variables.stat_data.year].join('/') };
    const template = createPlayTemplateContext(environment(), target, libraries, signal(), host);
    target.variables.stat_data = { year: 750 };
    assert.equal(await template.process('<%= values %>'), '750/2/3/750');
    assert.deepEqual(target.variables, { stat_data: { year: 750 } });
});

test('EJS 编译期间停止仍然停止本次任务，不作为兼容失败继续发送', async () => {
    const controller = new AbortController(); let finish, started;
    const ready = new Promise(resolve => { started = resolve; });
    const host = { compileTemplate: () => new Promise(resolve => { finish = resolve; started(); }) };
    const template = createPlayTemplateContext(environment(), resolved(), libraries, controller.signal, host);
    const pending = template.process('<%= 1 %>');
    await ready;
    controller.abort(new DOMException('停止测试', 'AbortError')); finish(() => '1');
    await assert.rejects(pending, { name: 'AbortError' });
});

test('可选编译器超时后本任务不再逐段等待，普通文字照常保留', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let started, calls = 0;
    const ready = new Promise(resolve => { started = resolve; });
    const host = { compileTemplate: () => { calls++; started(); return new Promise(() => {}); } };
    const template = createPlayTemplateContext(environment(), resolved(), libraries, signal(), host);
    const source = '<%= first %>', pending = template.process(source);
    await ready;
    t.mock.timers.tick(3000);
    assert.equal(await pending, source);
    assert.equal(await template.process('<%= second %>'), '<%= second %>');
    assert.equal(await template.process('普通角色设定'), '普通角色设定');
    assert.equal(calls, 1);
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

test('模板 define 在同一次任务的后续模板可用，函数绑定本次读取的资料', async () => {
    const target = resolved(), before = structuredClone(target);
    const host = { compileTemplate: async source => source === '<% define %>' ? data => {
        assert.equal(data.define('TIMELINE', { year: 750 }), undefined);
        data.define('helpers.year', function() { return this.getvar('stat_data.year'); });
        return String(data.TIMELINE.year);
    } : data => [data.TIMELINE.year, data.helpers.year()].join('/') };
    const template = createPlayTemplateContext(environment(), target, libraries, signal(), host);
    assert.equal(await template.process('<% define %>'), '750');
    assert.equal(await template.process('<%= defined %>'), '750/749');
    target.variables.stat_data.year = 751;
    assert.equal(await template.process('<%= defined %>'), '750/751');
    target.variables.stat_data.year = 749;
    assert.deepEqual(target, before);
});

test('define 支持路径、数组追加和对象合并，对象里的数组替换', async () => {
    const host = { compileTemplate: async () => data => {
        data.define('items', [1]);
        assert.deepEqual(data.define('items', [2], true), [1]);
        data.define('info', { nested: { first: 1, items: [1] } });
        data.define('info', { nested: { second: 2, items: [2] } }, true);
        data.define('info.owner', '甲');
        return JSON.stringify({ items: data.items, info: data.info });
    } };
    assert.deepEqual(JSON.parse(await createPlayTemplateContext(environment(), resolved(), libraries, signal(), host).process('<% merge %>')),
        { items: [1, 2], info: { nested: { first: 1, second: 2, items: [2] }, owner: '甲' } });
});

test('模板失败或返回无效结果时丢弃新定义及对原定义的修改', async () => {
    const host = { compileTemplate: async source => data => {
        if (source === '<% start %>') { data.define('info', { value: 1 }); return ''; }
        if (source === '<% read %>') return JSON.stringify({ info: data.info, leaked: data.leaked });
        data.define('info', { value: 2 }, true); data.define('leaked', 3);
        if (source === '<% bad %>') throw Error('Synthetic failure');
        return undefined;
    } };
    const template = createPlayTemplateContext(environment(), resolved(), libraries, signal(), host);
    assert.equal(await template.process('<% start %>'), '');
    for (const source of ['<% bad %>', '<% invalid %>']) {
        assert.equal(await template.process(source), source);
        assert.equal(await template.process('<% read %>'), '{"info":{"value":1}}');
    }
});

test('同时进行的模板任务不串用 define，超时后完成的模板也不能留下定义', async t => {
    const host = { compileTemplate: async () => async data => {
        data.define('owner', data.getvar('stat_data.year'));
        await Promise.resolve();
        return String(data.owner);
    } };
    const values = await Promise.all([749, 750].map(year => {
        const target = resolved(); target.variables.stat_data.year = year;
        return createPlayTemplateContext(environment(), target, libraries, signal(), host).process('<% define %>');
    }));
    assert.deepEqual(values, ['749', '750']);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish, started;
    const ready = new Promise(resolve => { started = resolve; });
    const delayedHost = { compileTemplate: async source => source === '<% late %>' ? async data => {
        data.define('lateValue', 1); started();
        await new Promise(resolve => { finish = resolve; });
        return '';
    } : data => String(data.lateValue ?? 'empty') };
    const template = createPlayTemplateContext(environment(), resolved(), libraries, signal(), delayedHost);
    const pending = template.process('<% late %>');
    await ready; t.mock.timers.tick(3000);
    assert.equal(await pending, '<% late %>');
    finish(); await Promise.resolve();
    assert.equal(await template.process('<%= lateValue %>'), 'empty');
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

test('初始值的 EJS 使用可选处理，失败条目不丢弃其他初值，不执行结构注册', async () => {
    const entries = [{ comment: '[initvar]', content: '{"year":750}' },
        { comment: '[initvar]', content: '{invalid' },
        { comment: '[initvar]', content: '{"name":"<%= charName %>"}' },
        { comment: '[initvar]', content: '<%= unsupported() %>' }];
    const before = structuredClone(entries);
    const context = { worldNames: ['fixture'], loadWorldInfo: async () => ({ entries }) };
    const process = text => text.replace('<%= charName %>', '目标角色');
    assert.deepEqual(await readPlayInitialVariables(environment(), context, text => text, libraries, signal(), process),
        { stat_data: { year: 750, name: '目标角色' } });
    assert.deepEqual(entries, before);
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
