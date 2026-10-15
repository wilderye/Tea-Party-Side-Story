// Use only disposable profiles containing the synthetic Tea Architecture Fixture.
// PLAY_NATIVE_URLS must explicitly name their local servers. Model requests are mocked.
// Flow: native WI scan -> isolated timers -> overlapping native main-chat Generate.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
    const urls = process.env.PLAY_NATIVE_URLS?.split(',').map(value => new URL(value.trim()));
    assert.ok(urls?.length && urls.every(url => url.hostname === '127.0.0.1'), '请指定隔离酒馆的本地测试地址');
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const url of urls) {
            const page = await browser.newPage(), errors = [], outbound = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/scripts/extensions/third-party/tea-state-test/**', async route => {
                const name = path.basename(new URL(route.request().url()).pathname);
                await route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(path.join(root, name)) });
            });
            await page.route('**/api/backends/chat-completions/generate', route => {
                const payload = route.request().postDataJSON();
                outbound.push(payload);
                const content = '这是隔离测试的模拟回复。';
                return payload.stream ? route.fulfill({ contentType: 'text/event-stream', body:
                    'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\n'
                    + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' })
                    : route.fulfill({ json: { choices: [{ message: { content } }] } });
            });
            await page.addInitScript(() => {
                window.nativeAppReady = false;
                const wait = setInterval(() => {
                    const context = window.SillyTavern?.getContext?.();
                    if (!context?.eventSource) return;
                    clearInterval(wait);
                    context.eventSource.on(context.eventTypes.APP_READY, () => { window.nativeAppReady = true; });
                }, 10);
            });
            await page.goto(url.href);
            await page.waitForFunction(() => window.nativeAppReady);
            await page.locator('#main_api').selectOption('openai', { force: true });
            await page.waitForFunction(() => SillyTavern.getContext().mainApi === 'openai');
            const result = await page.evaluate(async () => {
                const core = await import('/script.js');
                const world = await import('/scripts/world-info.js');
                const notes = await import('/scripts/authors-note.js');
                const extensions = await import('/scripts/extensions.js');
                const openai = await import('/scripts/openai.js');
                const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-state-test/play-prompt.js');
                const { capturePlayEnvironment } = await import('/scripts/extensions/third-party/tea-state-test/play-runtime.js');
                const ctx = () => SillyTavern.getContext();
                const characterId = ctx().characters.findIndex(character => character.name === 'Tea Architecture Fixture');
                if (characterId < 0) throw new Error('隔离测试角色不存在，拒绝使用其他角色');
                await ctx().selectCharacterById(characterId);
                openai.setupChatCompletionPromptManager(openai.oai_settings);
                Object.assign(openai.oai_settings, { chat_completion_source: 'custom', custom_model: 'synthetic-model',
                    custom_url: 'http://127.0.0.1:1/v1', custom_include_headers: '', custom_include_body: '', custom_exclude_body: '',
                    openai_max_context: 8192, openai_max_tokens: 512, stream_openai: false, n: 1,
                    function_calling: false, image_inlining: false, squash_system_messages: false });
                core.setOnlineStatus('connected');
                const source = ctx().eventSource, events = ctx().eventTypes;
                const book = { entries: {} };
                const entry = patch => Object.assign(world.createWorldInfoEntry('synthetic-state', book), {
                    world: 'synthetic-state', disable: false, constant: false, selective: false,
                    useProbability: false, probability: 100, key: [], keysecondary: [],
                }, patch);
                const rows = [
                    entry({ key: ['SIDE_ONLY_TOKEN'], content: '夜市中有售卖花灯的摊位。', position: world.world_info_position.ANBottom, sticky: 3, cooldown: 5 }),
                    entry({ key: ['NEVER_MATCH_STICKY'], content: 'STICKY_RULE_INCLUDED', position: world.world_info_position.before, sticky: 99 }),
                    entry({ constant: true, content: 'COOLDOWN_RULE_EXCLUDED', position: world.world_info_position.before, cooldown: 99 }),
                ];
                let scanGate;
                const injectEntries = async data => {
                    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) data[key].splice(0);
                    data.globalLore.push(...structuredClone(rows));
                    if (scanGate) { const gate = scanGate; scanGate = null; gate.enter(); await gate.promise; }
                };
                source.on(events.WORLDINFO_ENTRIES_LOADED, injectEntries);
                const note = '保持第三人称叙述。';
                Object.assign(core.chat_metadata, { [notes.metadata_keys.prompt]: note, [notes.metadata_keys.interval]: 1,
                    [notes.metadata_keys.position]: core.extension_prompt_types.IN_CHAT, [notes.metadata_keys.depth]: 0,
                    [notes.metadata_keys.role]: 0 });
                document.querySelector('#extension_floating_prompt').value = note;
                extensions.extension_settings.note.allowWIScan = true;
                const sorted = await world.getSortedEntries();
                const timed = (row, end) => ({ hash: row.hash, start: 0, end, protected: true });
                const sticky = sorted.find(row => row.content === 'STICKY_RULE_INCLUDED');
                const cooldown = sorted.find(row => row.content === 'COOLDOWN_RULE_EXCLUDED');
                const timers = core.chat_metadata.timedWorldInfo = {
                    sticky: { [`${sticky.world}.${sticky.uid}`]: timed(sticky, 99) },
                    cooldown: { [`${cooldown.world}.${cooldown.uid}`]: timed(cooldown, 99) },
                };
                const originalTimers = JSON.stringify(timers);
                const originalChat = JSON.stringify(core.chat);
                const prepare = createNativePlayPreparer(ctx);
                await prepare.ready();
                const options = () => ({ prompt: 'SIDE_ONLY_TOKEN 本次小剧场',
                    environment: { ...capturePlayEnvironment(ctx(), { playPrompt: '' }),
                        tavern: { ...capturePlayEnvironment(ctx(), {}).tavern, ...prepare.capture() } },
                    signal: new AbortController().signal });
                let serializedDuringScan;
                const observeScan = () => { serializedDuringScan = JSON.stringify(core.chat_metadata.timedWorldInfo); };
                source.on(events.WORLD_INFO_ACTIVATED, observeScan);
                try {
                    const request = await prepare(options());
                    const preservedAfterScan = core.chat_metadata.timedWorldInfo === timers
                        && JSON.stringify(timers) === originalTimers && JSON.stringify(core.chat) === originalChat;
                    await request.send({ signal: new AbortController().signal });
                    const deferred = () => {
                        let resolve; const promise = new Promise(done => { resolve = done; });
                        return { promise, resolve };
                    };
                    const entered = deferred(), release = deferred(), mainRequested = deferred();
                    scanGate = { enter: entered.resolve, promise: release.promise };
                    const side = prepare(options()).then(() => 'unexpected_success', error => error.code);
                    await entered.promise;
                    let mainStarted = false;
                    const observeMain = () => { mainStarted = true; };
                    source.on(events.GENERATION_STARTED, observeMain);
                    const originalEmit = source.emit;
                    source.emit = function (event, ...args) {
                        if (event === events.GENERATION_STARTED) mainRequested.resolve();
                        return originalEmit.call(this, event, ...args);
                    };
                    document.querySelector('#send_textarea').value = 'MAIN_ONLY_TOKEN 主聊天请求';
                    const main = core.Generate('normal');
                    try {
                        await mainRequested.promise;
                        const mainWaited = !mainStarted;
                        release.resolve();
                        const stopped = await side;
                        await main;
                        return { preservedAfterScan, serializedDuringScan: serializedDuringScan === originalTimers,
                            mainWaited, stopped, savedNote: core.chat_metadata[notes.metadata_keys.prompt] === note,
                            temporaryNoteClean: !core.extension_prompts['2_floating_prompt'].value.includes('花灯') };
                    } finally {
                        release.resolve(); source.emit = originalEmit;
                        source.removeListener(events.GENERATION_STARTED, observeMain);
                    }
                } finally {
                    source.removeListener(events.WORLDINFO_ENTRIES_LOADED, injectEntries);
                    source.removeListener(events.WORLD_INFO_ACTIVATED, observeScan);
                }
            });
            assert.equal(outbound.length, 2, '一次正常小剧场和一次主聊天；被中断的小剧场没有发送');
            const side = JSON.stringify(outbound[0].messages), main = JSON.stringify(outbound[1].messages);
            assert.ok(side.includes('花灯') && side.includes('STICKY_RULE_INCLUDED') && !side.includes('COOLDOWN_RULE_EXCLUDED'));
            assert.ok(main.includes('保持第三人称叙述。') && !main.includes('花灯') && !main.includes('SIDE_ONLY_TOKEN'));
            assert.deepEqual(result, { preservedAfterScan: true, serializedDuringScan: true, mainWaited: true,
                stopped: 'main_preparation_started', savedNote: true, temporaryNoteClean: true });
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ url: url.href, checks: '原生世界书计时与激活、准备中保存、原生主聊天发送重叠、最终主聊天请求无残留', result, errors }));
            await page.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
