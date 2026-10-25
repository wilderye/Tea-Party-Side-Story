// Browser plugin not available. Use existing Playwright/Edge with disposable Tavern profiles.
// Flow: real installed template plugin/standard engine -> task-local data -> synthetic requests.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const templateRoot = process.env.PLAY_TEMPLATE_ROOT && path.resolve(process.env.PLAY_TEMPLATE_ROOT);
const urls = process.env.PLAY_NATIVE_URLS?.split(',').map(value => new URL(value.trim()));
assert.ok(templateRoot, '必须指定待验证的提示词模板插件源码目录');
assert.ok(urls?.length && urls.every(url => url.hostname === '127.0.0.1' && url.port !== '8000'), '只允许隔离酒馆测试地址');
const cards = ['甲', '乙'].map((name, index) => ({ name, avatar: `${index}.png`, chat: `${index}-chat`, description: '普通角色{{char}}',
    personality: '', scenario: '', mes_example: '', first_mes: '模拟首楼', data: { name, extensions: { world: `fixture-${index}` } } }));
const entry = (uid, content, comment = '常驻测试') => ({ uid, content, comment, key: [], keysecondary: [], constant: true,
    order: 100 - uid, position: 0, disable: false, selective: false, depth: 4, probability: 100, useProbability: true,
    excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false, group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0,
    vectorized: false, displayIndex: uid, sticky: 0, cooldown: 0, delay: 0 });

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const url of urls) {
            const context = await browser.newContext(), page = await context.newPage(), outbound = [], assets = new Set(), errors = [];
            page.on('pageerror', error => errors.push(error.stack ?? error.message));
            let worldContent = '已处理<%= charName %>/<%= userName %>/<%= getvar("stat_data.year") %>/<%= getvar("missing") %>';
            for (const [prefix, directory] of [['/scripts/extensions/third-party/tea-independent/', root],
                ['/scripts/extensions/third-party/ST-Prompt-Template/', templateRoot]]) {
                await context.route('**' + prefix + '**', async route => {
                    const requestPath = new URL(route.request().url()).pathname;
                    const file = path.resolve(directory, decodeURIComponent(requestPath.slice(prefix.length)));
                    assert.ok(file.startsWith(directory + path.sep), '源码请求必须位于指定插件目录');
                    const contentType = file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/html';
                    assets.add(requestPath);
                    try { await route.fulfill({ contentType, body: await fs.readFile(file) }); }
                    catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                        await route.fulfill({ status: 404, body: 'Test asset unavailable' });
                    }
                });
            }
            await context.route('**/api/extensions/discover', route => route.fulfill({ json: [] }));
            await context.route('**/api/settings/get', async route => {
                const response = await route.fetch(), data = await response.json();
                const settings = JSON.parse(data.settings);
                settings.firstRun = false;
                data.settings = JSON.stringify(settings);
                await route.fulfill({ json: data });
            });
            await context.route('**/api/characters/all', route => route.fulfill({ json: cards }));
            await context.route('**/api/groups/all', route => route.fulfill({ json: [] }));
            await context.route(/\/(?:User%20Avatars|user\/avatar)\//, route => route.fulfill({ contentType: 'image/png',
                body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5AAAAABJRU5ErkJggg==', 'base64') }));
            await context.route('**/api/characters/chats', route => {
                const card = cards.find(item => item.avatar === route.request().postDataJSON().avatar_url);
                return route.fulfill({ json: [{ file_name: card.chat + '.jsonl', last_mes: '2026-10-26' }] });
            });
            await context.route('**/api/chats/get', route => route.fulfill({ json: [{ chat_metadata: { variables: { chatValue: 2 } } },
                { name: '模拟角色', is_user: false, mes: '模拟聊天', swipe_id: 1,
                    variables: [{ stat_data: { year: 700 } }, { stat_data: { year: 749 } }] }] }));
            await context.route('**/api/worldinfo/get', route => route.fulfill({ json: { entries: {
                0: entry(0, worldContent),
                1: { ...entry(1, '{"year":<%= 700 + 50 %>,"owner":"<%= charName %>"}', '[initvar]'), disable: true },
                2: { ...entry(2, '<%= unsupportedInitializer() %>', '[initvar]'), disable: true },
            } } }));
            await context.route('**/api/backends/chat-completions/generate', route => {
                outbound.push(route.request().postDataJSON().messages);
                return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"模拟回复"}}]}\n\ndata: [DONE]\n\n' });
            });
            for (const endpoint of ['settings/save', 'chats/save', 'stats/update']) {
                await context.route('**/api/' + endpoint, route => route.fulfill({ json: {} }));
            }
            await page.addInitScript(() => {
                window.templateTestReady = false;
                const timer = setInterval(() => {
                    const c = window.SillyTavern?.getContext?.();
                    if (!c?.eventSource) return;
                    clearInterval(timer);
                    c.eventSource.on(c.eventTypes.APP_READY, () => { window.templateTestReady = true; });
                }, 10);
            });
            await page.goto(url.href);
            await page.waitForFunction(() => window.templateTestReady, null, { timeout: 60000 });
            assert.match(await page.title(), /SillyTavern/);
            await page.evaluate(() => import('/scripts/extensions/third-party/ST-Prompt-Template/dist/index.js'));
            await page.waitForFunction(() => typeof globalThis.EjsTemplate?.compileTemplate === 'function');
            const result = await page.evaluate(async () => {
                const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-independent/play-prompt.js');
                const { capturePlayEnvironment } = await import('/scripts/extensions/third-party/tea-independent/play-runtime.js');
                const { createPlayTemplateContext } = await import('/scripts/extensions/third-party/tea-independent/play-template-context.js');
                const { createIndependentPlayScope } = await import('/scripts/extensions/third-party/tea-independent/play-independent.js');
                const prepare = createNativePlayPreparer(() => SillyTavern.getContext()); await prepare.ready();
                const modules = await prepare.ready(), host = globalThis.EjsTemplate;
                host.setFeatures({ enabled: true, generate_enabled: true, debug_enabled: false,
                    preload_worldinfo_enabled: false, render_enabled: false, autosave_enabled: false });
                modules.core.setCharacterId(0); modules.core.setCharacterName('甲');
                modules.core.chat.splice(0, modules.core.chat.length, { name: '甲', is_user: false, mes: '主聊天模拟正文', swipe_id: 0,
                    variables: [{ stat_data: { year: 101 } }] });
                const baseline = await host.evalTemplate('<%= getvar("stat_data.year") %>');
                const c = SillyTavern.getContext();
                const before = JSON.stringify({ id: c.characterId, chat: c.chat, meta: c.chatMetadata });
                let compileCalls = 0, prepareCalls = 0;
                const realCompile = host.compileTemplate, realPrepare = host.prepareContext;
                host.compileTemplate = (...args) => { compileCalls++; return realCompile.apply(host, args); };
                host.prepareContext = (...args) => { prepareCalls++; return realPrepare.apply(host, args); };
                const env = (index, noChat = true) => {
                    const value = capturePlayEnvironment({ ...SillyTavern.getContext(), mainApi: 'openai' },
                        { playNoChat: noChat, playPrompt: '', playApi: { mode: 'custom', url: 'http://127.0.0.1:1/v1', model: 'synthetic', key: '' } },
                        { character: c.characters[index] });
                    Object.assign(value.tavern, structuredClone(prepare.capture(value.characterCard)));
                    Object.assign(value.tavern.settings, { openai_max_context: 8192, openai_max_tokens: 128, n: 1 });
                    Object.assign(value.tavern.power, { experimental_macro_engine: false, personas: { 'fixture.png': '任务人设' },
                        persona_descriptions: {}, default_persona: 'fixture.png', persona_description: '', persona_description_position: 0 });
                    value.tavern.extensionSettings = { regex: [], character_allowed_regex: [], preset_allowed_regex: {}, disabledExtensions: [], note: {}, variables: { global: { globalValue: 3 } } };
                    value.tavern.presetFields = {}; value.tavern.presetHelper = {}; value.tavern.globalWorlds = [];
                    value.tavern.worldSettings.world_info = { charLore: [] }; value.tavern.templateFeatures = host.getFeatures();
                    return value;
                };
                const resolved = year => ({ chatId: '任务聊天', messages: [], metadata: { variables: { chatValue: 2 } },
                    persona: { name: '任务人设' }, variables: { stat_data: { year } } });
                const render = (source, year = 749) => createPlayTemplateContext(env(1), resolved(year), { _: window._ }, new AbortController().signal).process(source);
                const supported = await render('<%= charName %>/<%= userName %>/<%= getvar("stat_data.year") %>/<%= getvar("chatValue") %>/<%= getvar("globalValue") %>');
                const missing = await render('前<%= getvar("missing") %>后');
                const failureSources = ['<% if ( %>', '<%= unsupportedHelper() %>'];
                const failures = await Promise.all(failureSources.map(source => render(source)));
                const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => render('<%= getvar("stat_data.year") %>', 800 + index)));
                const initialScope = await createIndependentPlayScope(c, modules,
                    { environment: env(1), prompt: '', signal: new AbortController().signal });
                const initial = structuredClone(initialScope.resolved.variables); initialScope.dispose();
                await Promise.all(Array.from({ length: 4 }, async (_, index) => {
                    const request = await prepare({ environment: env(index % 2, index < 2), prompt: '模拟任务', signal: new AbortController().signal });
                    await request.send({ signal: new AbortController().signal });
                }));
                const unchanged = before === JSON.stringify({ id: c.characterId, chat: c.chat, meta: c.chatMetadata });
                const noHostPreparation = prepareCalls === 0;
                const afterBaseline = await host.evalTemplate('<%= getvar("stat_data.year") %>');
                window.templatePublicTest = { env, prepare, host, modules };
                return { supported, missing, failures, failureSources, concurrent, initial,
                    unchanged, noHostPreparation, baseline, afterBaseline, compileCalls };
            });
            assert.equal(result.supported, '乙/任务人设/749/2/3'); assert.equal(result.missing, '前后');
            assert.deepEqual(result.failures, result.failureSources);
            assert.deepEqual(result.concurrent, Array.from({ length: 12 }, (_, index) => String(800 + index)));
            assert.deepEqual(result.initial, { stat_data: { year: 750, owner: '乙' } });
            assert.equal(result.unchanged, true); assert.equal(result.noHostPreparation, true);
            assert.equal(result.baseline, '101'); assert.equal(result.afterBaseline, '101');
            assert.equal(result.compileCalls, 0, '使用安装包自带的标准引擎，不调用缺少 worker 文件的接口');
            assert.equal(outbound.length, 4);
            for (let index = 0; index < 4; index++) {
                const expected = `已处理${index % 2 ? '乙' : '甲'}/任务人设/${index < 2 ? 750 : index === 2 ? 101 : 749}/`;
                const present = outbound.some(messages => messages.some(message => typeof message.content === 'string' && message.content.includes(expected)));
                assert.ok(present, JSON.stringify({ case: index, messages: outbound.map(messages => ({ count: messages.length,
                    processed: messages.some(message => String(message.content).includes('已处理')),
                    rawEjs: messages.some(message => String(message.content).includes('<%')) })) }));
            }
            worldContent = '普通内容 <%= unsupportedHelper() %>';
            await page.evaluate(async () => {
                const { env, prepare } = window.templatePublicTest;
                const request = await prepare({ environment: env(1), prompt: '兼容失败', signal: new AbortController().signal });
                await request.send({ signal: new AbortController().signal });
            });
            assert.equal(outbound.length, 5);
            assert.ok(outbound[4].some(message => typeof message.content === 'string' && message.content.includes(worldContent)));
            worldContent = '原入口<%= charName %>/<%= getvar("stat_data.year") %>';
            const native = await page.evaluate(async () => {
                const { env, prepare, modules } = window.templatePublicTest;
                const { createIndependentPlayScope } = await import('/scripts/extensions/third-party/tea-independent/play-independent.js');
                const c = SillyTavern.getContext(), before = JSON.stringify({ id: c.characterId, chat: c.chat, meta: c.chatMetadata });
                const value = env(0, false), id = value.tavern.userAvatar;
                Object.assign(value.tavern.power, { personas: { [id]: c.name1 }, default_persona: id, persona_descriptions: {} });
                const scope = await createIndependentPlayScope(c, modules, { environment: structuredClone(value), prompt: '', signal: new AbortController().signal });
                const native = scope.native; scope.dispose();
                const request = await prepare({ environment: value, prompt: '当前聊天', signal: new AbortController().signal });
                await request.send({ signal: new AbortController().signal });
                return { native, unchanged: before === JSON.stringify({ id: c.characterId, chat: c.chat, meta: c.chatMetadata }) };
            });
            assert.equal(native.native, true); assert.equal(native.unchanged, true);
            assert.equal(outbound.length, 6);
            assert.ok(outbound[5].some(message => typeof message.content === 'string' && message.content.includes('原入口甲/101')));
            assert.ok(assets.has('/scripts/extensions/third-party/ST-Prompt-Template/dist/index.js'));
            assert.ok(assets.has('/scripts/extensions/third-party/ST-Prompt-Template/src/3rdparty/ejs.js'));
            assert.deepEqual(errors, []);
            for (const viewport of [{ width: 1332, height: 900 }, { width: 390, height: 844 }]) {
                await page.setViewportSize(viewport);
                await page.evaluate(() => {
                    const { env, modules } = window.templatePublicTest;
                    const c = SillyTavern.getContext(), power = c.powerUserSettings;
                    power.personas = { 'first.png': '人设一', 'second.png': '人设二' };
                    power.persona_descriptions = Object.fromEntries(Object.keys(power.personas).map(id => [id,
                        { description: id, connections: [{ id: '0.png' }, { id: '1.png' }] }]));
                    power.persona_allow_multi_connections = true;
                    window.personaBindingBefore = JSON.stringify({ personas: power.personas, descriptions: power.persona_descriptions });
                    window.personaChecks = { states: [], controllers: [] };
                    window.startPersonaCheck = async index => {
                        const { createIndependentPlayScope } = await import('/scripts/extensions/third-party/tea-independent/play-independent.js');
                        const value = env(index);
                        Object.assign(value.tavern.power, { personas: structuredClone(power.personas),
                            persona_descriptions: structuredClone(power.persona_descriptions), persona_allow_multi_connections: true });
                        const controller = new AbortController(), slot = personaChecks.states.length;
                        personaChecks.controllers.push(controller); personaChecks.states.push({ status: 'pending' });
                        void createIndependentPlayScope(c, modules, { environment: value, prompt: '', signal: controller.signal })
                            .then(scope => { personaChecks.states[slot] = { status: 'ready', id: scope.resolved.persona.id }; scope.dispose(); },
                                error => { personaChecks.states[slot] = { status: error.name }; });
                    };
                    void startPersonaCheck(0); void startPersonaCheck(1);
                });
                const dialog = page.locator('dialog:visible');
                await dialog.getByText('为「甲」的本次小剧场选择用户设定。', { exact: true }).waitFor();
                assert.equal(await dialog.count(), 1, '多份任务的选择窗口依次出现');
                await page.waitForFunction(() => [...document.querySelectorAll('dialog[open]')]
                    .every(node => getComputedStyle(node).opacity === '1'));
                if (process.env.TEA_QA_DIR) {
                    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
                    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, `persona-${url.port}-${viewport.width}.png`) });
                }
                await dialog.locator('.avatar[data-pid="first.png"]').click();
                await page.waitForFunction(() => personaChecks.states[0].status === 'ready');
                assert.equal(await page.evaluate(() => personaChecks.states[0].id), 'first.png');
                await dialog.getByText('为「乙」的本次小剧场选择用户设定。', { exact: true }).waitFor();
                await dialog.getByRole('button', { name: '取消', exact: true }).click();
                await page.waitForFunction(() => personaChecks.states[1].status === 'AbortError');
                await page.evaluate(() => startPersonaCheck(0));
                await dialog.getByText('为「甲」的本次小剧场选择用户设定。', { exact: true }).waitFor();
                await page.evaluate(() => personaChecks.controllers[2].abort(new DOMException('停止测试', 'AbortError')));
                await page.waitForFunction(() => personaChecks.states[2].status === 'AbortError');
                await dialog.waitFor({ state: 'hidden' });
                assert.equal(await page.evaluate(() => {
                    const power = SillyTavern.getContext().powerUserSettings;
                    return personaBindingBefore === JSON.stringify({ personas: power.personas, descriptions: power.persona_descriptions });
                }), true, '选择和取消不改变酒馆的人设绑定');
            }
            await context.route('**/scripts/extensions/third-party/ST-Prompt-Template/src/3rdparty/ejs.js',
                route => route.fulfill({ status: 404, body: 'Synthetic missing engine' }));
            await page.reload();
            await page.waitForFunction(() => window.templateTestReady, null, { timeout: 60000 });
            await page.evaluate(() => import('/scripts/extensions/third-party/ST-Prompt-Template/dist/index.js'));
            await page.waitForFunction(() => typeof globalThis.EjsTemplate?.compileTemplate === 'function');
            const unavailable = await page.evaluate(async () => {
                const { createPlayTemplateContext } = await import('/scripts/extensions/third-party/tea-independent/play-template-context.js');
                const env = { character: { name: '模拟角色' }, tavern: { templateFeatures: { enabled: true } } };
                const resolved = { metadata: {}, persona: { name: '模拟人设' }, variables: {}, messages: [] };
                const template = createPlayTemplateContext(env, resolved, { _: window._ }, new AbortController().signal);
                const first = await template.process('<%= first %>');
                const start = performance.now(), second = await template.process('<%= second %>');
                return { first, second, immediate: performance.now() - start < 100,
                    plain: await template.process('普通角色内容') };
            });
            assert.equal(unavailable.first, '<%= first %>'); assert.equal(unavailable.second, '<%= second %>');
            assert.equal(unavailable.plain, '普通角色内容'); assert.equal(unavailable.immediate, true);
            console.log(JSON.stringify({ port: url.port, realInstalledEngine: true, taskIsolation: true,
                missingValueBlank: true, concurrentTemplates: 12, processedRequests: 4, fallbackRequests: 1, nativeTemplateRequests: 1,
                personaDialogs: [1332, 390], unavailableCompilerFallback: true, mainChatUnchanged: true }));
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
