// Browser plugin not available. Use Playwright/Edge and disposable Tavern profiles.
// Flow: unopened synthetic roles -> native independent processing -> concurrent replies.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const urls = process.env.PLAY_NATIVE_URLS?.split(',').map(value => new URL(value.trim()));
assert.ok(urls?.length && urls.every(url => url.hostname === '127.0.0.1' && url.port !== '8000'), '仅允许明确指定的隔离酒馆测试地址');
const cards = ['甲.[+]*', '乙'].map((name, i) => ({ name, avatar: `${i}.png`, description: '描述{{char}}', personality: '', scenario: '', mes_example: '', first_mes: '首楼', chat: `${i}-chat`,
    data: { name, description: '描述{{char}}', extensions: { world: `fixture-${i}`, regex_scripts: [{ id: `regex-${i}`, scriptName: '目标规则', placement: [2],
        findRegex: '/标记/g', replaceString: '{{char}}/{{user}}', substituteRegex: 0, promptOnly: true, markdownOnly: true, trimStrings: [] }] } } }));
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const url of urls) {
            const context = await browser.newContext(), page = await context.newPage(), outbound = [], reads = [];
            let worldContent = '世界{{char}}';
            await context.route('**/scripts/extensions/third-party/tea-independent/**', async route => {
                const prefix = '/scripts/extensions/third-party/tea-independent/';
                const file = path.resolve(root, decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length)));
                assert.ok(file.startsWith(root + path.sep) && file.endsWith('.js'));
                await route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(file, 'utf8') });
            });
            await context.route('**/api/characters/all', route => route.fulfill({ json: cards }));
            await context.route('**/api/settings/get', async route => {
                const response = await route.fetch(), data = await response.json();
                const settings = JSON.parse(data.settings); settings.firstRun = false;
                data.settings = JSON.stringify(settings);
                await route.fulfill({ json: data });
            });
            await context.route('**/api/groups/all', route => route.fulfill({ json: [] }));
            await context.route('**/api/characters/chats', route => { reads.push('list');
                const card = cards.find(item => item.avatar === route.request().postDataJSON().avatar_url);
                return route.fulfill({ json: [{ file_name: card.chat + '.jsonl', last_mes: '2026-10-25', chat_items: 13 }] }); });
            await context.route('**/api/chats/get', route => {
                reads.push('chat');
                return route.fulfill({ json: [{ chat_metadata: {} }, ...Array.from({ length: 13 }, (_, i) => ({ name: i % 2 ? '用户' : '角色', is_user: !!(i % 2), mes: i === 12 ? '标记' : '历史' + i,
                    swipe_id: 1, variables: i === 12 ? [{ stat_data: { year: 700 } }, { stat_data: { year: 749 } }] : undefined }))] });
            });
            await context.route('**/api/worldinfo/get', route => route.fulfill({ json: { entries: { 0: { uid: 0, key: [], keysecondary: [], comment: '测试常驻', content: worldContent, constant: true,
                selective: false, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
                probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
                matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, vectorized: false, displayIndex: 0, sticky: 0, cooldown: 0, delay: 0 } } } }));
            await context.route('**/api/backends/chat-completions/generate', route => {
                const data = route.request().postDataJSON(); outbound.push(data.messages);
                return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"模拟回复"}}]}\n\ndata: [DONE]\n\n' });
            });
            for (const endpoint of ['settings/save', 'chats/save', 'stats/update']) await context.route('**/api/' + endpoint, route => route.fulfill({ json: {} }));
            await page.addInitScript(() => {
                window.independentReady = false;
                const timer = setInterval(() => { const c = window.SillyTavern?.getContext?.(); if (!c?.eventSource) return; clearInterval(timer);
                    c.eventSource.on(c.eventTypes.APP_READY, () => { window.independentReady = true; }); }, 10);
            });
            await page.goto(url.href);
            await page.waitForFunction(() => window.independentReady, null, { timeout: 60000 });
            const result = await page.evaluate(async () => {
                const c = SillyTavern.getContext();
                const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-independent/play-prompt.js');
                const { capturePlayEnvironment } = await import('/scripts/extensions/third-party/tea-independent/play-runtime.js');
                const { createIndependentPlayScope } = await import('/scripts/extensions/third-party/tea-independent/play-independent.js');
                const prepare = createNativePlayPreparer(() => SillyTavern.getContext()); await prepare.ready();
                const before = JSON.stringify({ id: c.characterId, chat: c.chat, meta: c.chatMetadata });
                const env = (index, noChat = true) => {
                    const value = capturePlayEnvironment({ ...SillyTavern.getContext(), mainApi: 'openai' }, { playNoChat: noChat, playPrompt: '', playApi: { mode: 'custom', url: 'http://127.0.0.1:1/v1', model: 'synthetic', key: '' } }, { character: c.characters[index] });
                    Object.assign(value.tavern, structuredClone(prepare.capture(value.characterCard)));
                    Object.assign(value.tavern.settings, { openai_max_context: 8192, openai_max_tokens: 128, n: 1 });
                    Object.assign(value.tavern.power, { experimental_macro_engine: false, personas: { 'fixture-user.png': '测试用户' }, persona_descriptions: {},
                        default_persona: 'fixture-user.png', persona_description: '', persona_description_position: 0 });
                    value.tavern.extensionSettings = { regex: [], character_allowed_regex: ['0.png', '1.png'], preset_allowed_regex: {}, disabledExtensions: [], note: {}, variables: {} };
                    value.tavern.regexScripts = value.characterCard.data.extensions.regex_scripts;
                    value.tavern.presetFields = {}; value.tavern.presetHelper = {}; value.tavern.globalWorlds = [];
                    value.tavern.worldSettings.world_info = { charLore: [] }; value.tavern.templateFeatures = undefined;
                    return value;
                };
                window.teaIndependentTest = { env, prepare };
                const initial = env(0), scope = await createIndependentPlayScope(c, await prepare.ready(), { environment: initial, prompt: '', signal: new AbortController().signal });
                const regex = scope.worldContext.regex, name = initial.character.name;
                const rule = mode => ({ findRegex: '/^{{char}}$/', replaceString: '{{user}}', trimStrings: [], substituteRegex: mode });
                const macroChecks = [regex.runRegexScript(rule(0), '{{char}}') === '测试用户',
                    regex.runRegexScript(rule(2), name) === '测试用户', regex.runRegexScript(rule(1), name) === name,
                    scope.macros.substitute('{{mesExamples}}/{{get_message_variable::stat_data.year}}') === '/{{get_message_variable::stat_data.year}}'];
                scope.dispose();
                const latest = env(1, false), savedScope = await createIndependentPlayScope(c, await prepare.ready(), { environment: latest, prompt: '', signal: new AbortController().signal });
                const year = savedScope.resolved.variables.stat_data.year; savedScope.dispose();
                await Promise.all(Array.from({ length: 12 }, async (_, i) => {
                    const request = await prepare({ environment: env(i % 2, i % 3 !== 0), prompt: '标记', signal: new AbortController().signal });
                    const text = await request.send({ signal: new AbortController().signal }); if (text !== '模拟回复') throw Error('流式回复不匹配');
                }));
                return { macroChecks, year, initialMessages: initial.chat.length,
                    unchanged: before === JSON.stringify({ id: c.characterId, chat: c.chat, meta: c.chatMetadata }) };
            });
            assert.ok(result.macroChecks.every(Boolean)); assert.equal(result.year, 749); assert.equal(result.initialMessages, 0); assert.equal(result.unchanged, true);
            assert.equal(outbound.length, 12);
            for (const messages of outbound) assert.ok(messages.some(m => typeof m.content === 'string' && /世界(?:甲|乙)/.test(m.content)));
            assert.equal(outbound.filter(messages => messages.some(m => typeof m.content === 'string' && /[甲乙].*\/测试用户/.test(m.content))).length, 4, '仅发送聊天的四份任务对历史 AI 消息执行角色正则');
            assert.equal(reads.filter(value => value === 'list').length, 5, '不发聊天的八份任务不查询聊天列表');
            worldContent = '世界{{char}} <%= nativeCurrent() %> {{get_message_variable::missing}}';
            const optional = await page.evaluate(async () => {
                const { env, prepare } = window.teaIndependentTest;
                const modules = await prepare.ready();
                const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-independent/play-prompt.js');
                const { createIndependentPlayScope, createPlayDisplayRegex } = await import('/scripts/extensions/third-party/tea-independent/play-independent.js');
                window.EjsTemplate = { getFeatures() { throw Error('Synthetic plugin version change'); },
                    compileTemplate() { throw Error('Synthetic unavailable compiler'); } };
                modules.core.setCharacterId(0);
                modules.core.setCharacterName(modules.core.characters[0].name);
                modules.core.chat.splice(0, modules.core.chat.length, { name: '角色', is_user: false, mes: '当前正文', variables: [{ stat_data: { year: 749 } }] });
                const c = SillyTavern.getContext(), states = [];
                const before = JSON.stringify({ id: c.characterId, chat: c.chat, meta: c.chatMetadata });
                let nativeFault = false;
                const nativePrepare = createNativePlayPreparer(() => SillyTavern.getContext(), {
                    loadModules: async () => ({ ...modules, core: { ...modules.core, getCharacterCardFields() {
                        if (nativeFault) { nativeFault = false; throw Error('Synthetic native preparation failure'); }
                        return modules.core.getCharacterCardFields();
                    } } }),
                    createScope: async (...args) => { const scope = await createIndependentPlayScope(...args); states.push(scope.native ? 'native' : 'independent'); return scope; },
                });
                await nativePrepare.ready();
                const nativeEnv = () => {
                    const value = env(0, false), id = value.tavern.userAvatar;
                    value.tavern.power.personas = { [id]: c.name1 }; value.tavern.power.persona_descriptions = {};
                    value.tavern.power.default_persona = id;
                    return value;
                };
                const nativeTemplate = data => { for (const message of data.prompt) if (typeof message.content === 'string') {
                    message.content = message.content.replace('<%= nativeCurrent() %>', '原入口正常处理');
                } };
                c.eventSource.on(c.eventTypes.GENERATE_AFTER_DATA, nativeTemplate);
                const first = await nativePrepare({ environment: nativeEnv(), prompt: '当前角色', signal: new AbortController().signal });
                await first.send({ signal: new AbortController().signal });
                c.eventSource.removeListener(c.eventTypes.GENERATE_AFTER_DATA, nativeTemplate);
                const broken = () => { throw Error('Synthetic third-party callback failure'); };
                c.eventSource.on(c.eventTypes.GENERATE_AFTER_DATA, broken);
                const fallback = await nativePrepare({ environment: nativeEnv(), prompt: '回退', signal: new AbortController().signal });
                await fallback.send({ signal: new AbortController().signal });
                c.eventSource.removeListener(c.eventTypes.GENERATE_AFTER_DATA, broken);
                nativeFault = true;
                const recovered = await nativePrepare({ environment: nativeEnv(), prompt: '准备失败回退', signal: new AbortController().signal });
                await recovered.send({ signal: new AbortController().signal });
                const ordinary = await prepare({ environment: env(1), prompt: '普通角色', signal: new AbortController().signal });
                await ordinary.send({ signal: new AbortController().signal });
                const regex = await createPlayDisplayRegex({ ...c, mainApi: 'textgenerationwebui' }, modules, c.characters[1], prepare.capture(c.characters[1]));
                const display = regex.runRegexScript({ findRegex: '/标记/g', replaceString: '{{char}}', trimStrings: [], substituteRegex: 0 }, '标记');
                const original = JSON.parse(before), after = { id: c.characterId, chat: c.chat, meta: c.chatMetadata };
                const changedFields = Object.keys(after).filter(key => JSON.stringify(original[key]) !== JSON.stringify(after[key]));
                const changedMetadata = Object.keys(after.meta).filter(key => JSON.stringify(original.meta[key]) !== JSON.stringify(after.meta[key]));
                const changedMessages = after.chat.flatMap((message, index) => Object.keys(message).filter(key => JSON.stringify(original.chat[index]?.[key]) !== JSON.stringify(message[key])).map(key => ({ index, key })));
                return { states, display, unchanged: before === JSON.stringify(after), changedFields, changedMetadata, changedMessages };
            });
            assert.deepEqual(optional.states, ['native', 'native', 'native', 'independent']);
            if(!optional.unchanged)console.log(JSON.stringify({port:url.port,...optional}));
            assert.equal(optional.display, '乙'); assert.equal(optional.unchanged, true);
            assert.equal(outbound.length, 16);
            assert.ok(outbound[12].some(message => typeof message.content === 'string' && message.content.includes('原入口正常处理')));
            for (const messages of outbound.slice(13)) assert.ok(messages.some(message => typeof message.content === 'string'
                && message.content.includes('<%= nativeCurrent() %>') && message.content.includes('{{get_message_variable::missing}}')));
            console.log(JSON.stringify({ port: url.port, nativeRequests: outbound.length, optionalModes: optional.states, ...result }));
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
