// Browser plugin not available. Only explicitly named disposable local profiles.
// Model, character chat and worldbook endpoints all use synthetic data.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const urls = process.env.PLAY_NATIVE_URLS?.split(',').map(raw => new URL(raw.trim()));
assert.ok(urls?.length && urls.every(url => url.hostname === '127.0.0.1' && url.port !== '8000'), '请指定隔离酒馆测试地址');
const card = { name: 'Tea Hidden Depth Fixture', avatar: 'hidden-depth.png', chat: 'hidden-depth-main', first_mes: '酒馆1',
    description: '', personality: '', scenario: '', mes_example: '', data: { name: 'Tea Hidden Depth Fixture', extensions: { world: 'tea-hidden-world' } } };
const book = { entries: {
    0: { uid: 0, key: [], content: '世界书深度0', constant: true, position: 4, depth: 0, role: 0, order: 100,
        disable: false, probability: 100, useProbability: true, sticky: 0, cooldown: 0, delay: 0 },
    1: { uid: 1, key: ['HIDDEN_KEYWORD'], content: '隐藏关键词触发条目', constant: false, position: 0, depth: 0, role: 0, order: 90,
        selective: false, disable: false, probability: 100, useProbability: true, sticky: 0, cooldown: 0, delay: 0 },
} };
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const url of urls) {
            const context = await browser.newContext(), page = await context.newPage(), errors = [], outbound = [];
            page.on('pageerror', error => errors.push(error.stack));
            await context.route('**/scripts/extensions/third-party/tea-hidden-test/**', async route => {
                const file = path.resolve(root, decodeURIComponent(new URL(route.request().url()).pathname.split('/tea-hidden-test/')[1]));
                assert.ok(file.startsWith(root + path.sep) && file.endsWith('.js'));
                await route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(file, 'utf8') });
            });
            await context.route('**/api/characters/all', route => route.fulfill({ json: [card] }));
            await context.route('**/api/characters/chats', route => route.fulfill({ json: [{ file_name: card.chat + '.jsonl', last_mes: '2026-10-30', chat_items: 4 }] }));
            await context.route('**/api/chats/get', route => route.fulfill({ json: [{ chat_metadata: {} }, ...Array.from({ length: 4 }, (_, index) => ({ name: card.name,
                is_user: false, is_system: false, mes: `酒馆${index + 1}`, send_date: '2026-10-30', extra: {} }))] }));
            await context.route('**/api/groups/all', route => route.fulfill({ json: [] }));
            await context.route('**/api/settings/get', async route => {
                const response = await route.fetch(), data = await response.json(), settings = JSON.parse(data.settings);
                settings.firstRun = false; data.settings = JSON.stringify(settings); data.world_names = ['tea-hidden-world'];
                await route.fulfill({ json: data });
            });
            await context.route('**/api/worldinfo/get', route => route.fulfill({ json: book }));
            for (const endpoint of ['settings/save', 'chats/save', 'stats/update', 'worldinfo/edit']) {
                await context.route('**/api/' + endpoint, route => route.fulfill({ json: {} }));
            }
            await context.route('**/api/backends/chat-completions/generate', route => {
                const data = route.request().postDataJSON(); outbound.push(data);
                if (data.stream) return route.fulfill({ contentType: 'text/event-stream',
                    body: 'data: {"choices":[{"delta":{"content":"合成模型回复"}}]}\n\ndata: [DONE]\n\n' });
                return route.fulfill({ json: { choices: [{ message: { content: '合成模型回复' } }] } });
            });
            await page.addInitScript(() => {
                window.hiddenAppReady = false;
                const timer = setInterval(() => {
                    let c;
                    try { c = window.SillyTavern?.getContext?.(); } catch { return; }
                    if (!c?.eventSource) return;
                    clearInterval(timer); c.eventSource.on(c.eventTypes.APP_READY, () => { window.hiddenAppReady = true; });
                }, 10);
            });
            await page.goto(url.href); await page.waitForFunction(() => window.hiddenAppReady);
            const result = await page.evaluate(async () => {
                const core = await import('/script.js'), openai = await import('/scripts/openai.js');
                const regex = await import('/scripts/extensions/regex/engine.js');
                const world = await import('/scripts/world-info.js'), notes = await import('/scripts/authors-note.js');
                const power = await import('/scripts/power-user.js');
                const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-hidden-test/play-prompt.js');
                const { createPlayRuntime } = await import('/scripts/extensions/third-party/tea-hidden-test/play-runtime.js');
                const { createPlayHistory } = await import('/scripts/extensions/third-party/tea-hidden-test/play-history.js');
                const ctx = () => SillyTavern.getContext();
                await ctx().selectCharacterById(0);
                openai.setupChatCompletionPromptManager(openai.oai_settings);
                Object.assign(openai.oai_settings, { chat_completion_source: 'custom', custom_model: 'synthetic-model',
                    custom_url: 'http://127.0.0.1:1/v1', openai_max_context: 8192, openai_max_tokens: 128,
                    stream_openai: false, n: 1, function_calling: false, image_inlining: false, squash_system_messages: false,
                    send_if_empty: '', names_behavior: 0, new_chat_prompt: '', custom_include_headers: '', custom_include_body: '', custom_exclude_body: '' });
                const main = openai.oai_settings.prompts.find(prompt => prompt.identifier === 'main');
                main.content = '';
                for (const prompt of openai.oai_settings.prompts) if (prompt.identifier === 'depthPreset') prompt.content = '';
                Object.assign(power.power_user, { persona_description: '', persona_description_position: 0 });
                const rule = { id: 'erase-depth', scriptName: '只保留最近5层', placement: [1, 2], promptOnly: true,
                    findRegex: '/[\\s\\S]+/g', replaceString: '', trimStrings: [], minDepth: 5, maxDepth: null, disabled: false };
                await regex.saveScriptsByType([rule], regex.SCRIPT_TYPES.GLOBAL);
                await regex.saveScriptsByType([], regex.SCRIPT_TYPES.PRESET);
                await regex.saveScriptsByType([], regex.SCRIPT_TYPES.SCOPED);
                world.setWorldInfoSettings({ world_info_depth: 100, world_info_budget: 50, world_info_budget_cap: 2048,
                    world_info_recursive: false, world_info_min_activations: 0, world_info: { globalSelect: [] } }, { world_names: ['tea-hidden-world'] });
                const meta = core.chat_metadata, keys = notes.metadata_keys;
                Object.assign(meta, { [keys.prompt]: '作者注释深度1', [keys.interval]: 1, [keys.position]: 1, [keys.depth]: 1, [keys.role]: 0 });
                document.querySelector('#extension_floating_prompt').value = '作者注释深度1';
                const before = JSON.stringify({ chat: core.chat, meta: core.chat_metadata, settings: openai.oai_settings });
                const files = new Map(), history = createPlayHistory({ readFile: async name => files.get(name) ?? null,
                    writeFile: async (name, text) => files.set(name, text), removeFile: async name => files.delete(name) });
                const character = { avatar: 'hidden-depth.png', name: 'Tea Hidden Depth Fixture' }, stamp = new Date().toISOString();
                const initial = await history.begin({ character, prompt: '插件1', resultId: crypto.randomUUID(), startedAt: stamp,
                    context: { chatId: 'fixture', apiMode: 'custom', characterName: character.name } });
                await history.saveResult(initial.id, initial.results[0].id, { text: '插件2 HIDDEN_KEYWORD', status: 'complete', finishedAt: stamp });
                let chat = await history.getChat(initial.id);
                const preparer = createNativePlayPreparer(ctx), settings = { enabled: true, playPrompt: '', playHiddenTags: '',
                    playApi: { mode: 'custom', url: 'http://127.0.0.1:1/v1', model: 'synthetic-model' } };
                const runtime = createPlayRuntime(ctx, settings, history, { prepareRequest: preparer }); await runtime.initialize();
                const target = { character, characterId: chat.characterId };
                const operations = [];
                const base = await runtime.createBranch(chat.id, chat.messages[1].id, chat.revision);
                operations.push((await runtime.sendChat(base.id, { ...target, prompt: '插件3' })).result.status);
                chat = await runtime.setMessagesHidden(chat.id, [chat.messages[1].id], true, chat.revision);
                const hidden = await runtime.createBranch(chat.id, chat.messages[1].id, chat.revision);
                operations.push((await runtime.sendChat(hidden.id, { ...target, prompt: '插件3' })).result.status);
                const unfiltered = await runtime.createBranch(chat.id, chat.messages[1].id, chat.revision);
                settings.playRegexEnabled = false;
                operations.push((await runtime.sendChat(unfiltered.id, { ...target, prompt: '插件3' })).result.status);
                settings.playRegexEnabled = true;
                settings.playNoChat = true;
                const independent = await runtime.createBranch(chat.id, chat.messages[1].id, chat.revision);
                operations.push((await runtime.sendChat(independent.id, { ...target, prompt: '插件3' })).result.status);
                settings.playNoChat = false;
                chat = await runtime.getChat(base.id);
                const last = chat.messages.at(-1);
                operations.push((await runtime.continueChat(base.id, last.id, last.selectedResultId, target)).result.status);
                await regex.saveScriptsByType([rule, { id: 'continue-clean', scriptName: '续写目标清洗', placement: [2], promptOnly: true,
                    findRegex: '/合成/g', replaceString: '', trimStrings: [], minDepth: -1, maxDepth: 0, disabled: false }], regex.SCRIPT_TYPES.GLOBAL);
                settings.playContinueMode = 'prompt';
                operations.push((await runtime.continueChat(base.id, last.id, last.selectedResultId, target)).result.status);
                const branchSaved = (await runtime.getChat(base.id)).messages.at(-1).results.find(result => result.id === last.selectedResultId).text;
                const ordinary = await history.begin({ character, prompt: '普通用户', resultId: crypto.randomUUID(), startedAt: stamp,
                    context: { chatId: 'fixture', apiMode: 'custom', characterName: character.name } });
                await history.saveResult(ordinary.id, ordinary.results[0].id, { text: '合成模型回复', status: 'complete', finishedAt: stamp });
                operations.push((await runtime.continueResult(ordinary.id, ordinary.results[0].id, target)).result.status);
                const ordinarySaved = (await runtime.getRound(ordinary.id)).results[0].text;
                return { operations, branchSaved, ordinarySaved,
                    unchanged: before === JSON.stringify({ chat: core.chat, meta: core.chat_metadata, settings: openai.oai_settings }) };
            });
            assert.deepEqual(result.operations, Array(7).fill('complete')); assert.equal(result.unchanged, true);
            assert.equal(outbound.length, 7);
            assert.equal(result.branchSaved, '合成模型回复'.repeat(3));
            assert.equal(result.ordinarySaved, '合成模型回复'.repeat(2));
            const texts = index => outbound[index].messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
            const floors = index => texts(index).filter(text => /^(酒馆|插件)/.test(text));
            assert.deepEqual(floors(0), ['酒馆3', '酒馆4', '插件1', '插件2 HIDDEN_KEYWORD', '插件3']);
            assert.deepEqual(floors(1), ['酒馆2', '酒馆3', '酒馆4', '插件1', '插件3']);
            assert.deepEqual(floors(2), ['酒馆1', '酒馆2', '酒馆3', '酒馆4', '插件1', '插件3']);
            assert.deepEqual(floors(3), ['插件1', '插件3']);
            assert.ok(texts(0).join('\n').includes('隐藏关键词触发条目'));
            assert.ok(!texts(1).join('\n').includes('隐藏关键词触发条目'));
            for (const index of [0, 1, 2, 3]) {
                assert.ok(texts(index).indexOf('世界书深度0') > texts(index).indexOf('插件3'));
                assert.ok(texts(index).indexOf('作者注释深度1') < texts(index).indexOf('插件3'));
            }
            for (const index of [5, 6]) {
                const nudge = outbound[index].messages.findLast(message => message.role === 'user').content;
                assert.ok(nudge.includes(index === 5 ? '模型回复模型回复' : '模型回复'));
                assert.doesNotMatch(nudge, /合成模型回复/, '第二种续写使用处理后正文，保存仍沿用完整原文');
            }
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ port: url.port, passed: true, checks: 'combined depths, batch-hidden sending, regex switch, worldbook keyword exclusion, depth0/1 placement, continuation, independent noChat, main-state preservation' }));
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
