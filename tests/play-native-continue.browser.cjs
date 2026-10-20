// Native integration test for continue (续写) functionality
// against SillyTavern 1.14 (port 9051) and 1.19 (port 9052).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
    const urls = (process.env.PLAY_NATIVE_URLS || 'http://127.0.0.1:9051,http://127.0.0.1:9052').split(',');
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const deadline = setTimeout(() => void browser.close(), 90_000);
    try {
        for (const rawUrl of urls) {
            const url = rawUrl.trim();
            const port = new URL(url).port;
            const page = await browser.newPage();
            const errors = [], outbound = [];
            page.on('pageerror', err => errors.push(err.message));

            await page.route('**/api/backends/chat-completions/generate', route => {
                const payload = route.request().postDataJSON();
                outbound.push(payload);
                const isContinue = payload.type === 'continue';
                const content = isContinue ? '【续写的后半部分台词】' : '这是初始的前半部分，';
                return payload.stream
                    ? route.fulfill({ contentType: 'text/event-stream', body: 'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n' })
                    : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
            });
            await page.route('**/scripts/extensions/third-party/tea-review/**', async route => {
                const file = path.basename(new URL(route.request().url()).pathname);
                await route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(path.join(root, file)) });
            });

            await page.goto(url);
            await page.waitForFunction(() => window.SillyTavern?.getContext?.().chatCompletionSettings?.prompts?.length > 0);
            await page.evaluate(() => new Promise(resolve => {
                const ctx = SillyTavern.getContext();
                ctx.eventSource.once(ctx.eventTypes.APP_READY, resolve);
            }));

            await page.locator('#main_api').selectOption('openai', { force: true });
            await page.waitForFunction(() => SillyTavern.getContext().mainApi === 'openai');
            await page.locator('#chat_completion_source').selectOption('openai', { force: true });

            const result = await page.evaluate(async () => {
                const openai = await import('/scripts/openai.js');
                const { createPlayRuntime } = await import('/scripts/extensions/third-party/tea-review/play-runtime.js');
                const { createPlayHistory } = await import('/scripts/extensions/third-party/tea-review/play-history.js');
                await SillyTavern.getContext().selectCharacterById(0);
                openai.setupChatCompletionPromptManager(openai.oai_settings);
                Object.assign(openai.oai_settings, {
                    chat_completion_source: 'openai',
                    openai_model: 'gpt-4o',
                    temp_openai: 0.7,
                    stream_openai: true,
                    n: 1,
                    continue_prefill: false,
                    continue_nudge_prompt: '[Continue your last message without repeating its original content.]',
                    assistant_prefill: '',
                    send_if_empty: '',
                    openai_max_context: 8192,
                    openai_max_tokens: 512,
                });

                const files = new Map();
                const history = createPlayHistory({
                    readFile: async name => files.get(name) ?? null,
                    writeFile: async (name, text) => files.set(name, text),
                    removeFile: async name => files.delete(name),
                });
                const ctx = () => SillyTavern.getContext();
                const runtime = createPlayRuntime(ctx, { enabled: true }, history);
                await runtime.initialize();

                // 1. 发送初始生成
                const first = await runtime.send({ prompt: '第一幕开场' });
                const roundId = first.roundId;
                const resultId = first.result.id;
                const initialText = first.result.text;

                // 2. 针对第一份结果触发续写
                const continued = await runtime.continueResult(roundId, resultId);
                const savedRound = await runtime.getRound(roundId);

                return {
                    roundId,
                    resultId,
                    initialText,
                    continuedText: continued.result.text,
                    savedText: savedRound.results[0].text,
                    resultsCount: savedRound.results.length,
                    continuedStatus: continued.result.status,
                };
            });

            assert.equal(result.initialText, '这是初始的前半部分，');
            assert.equal(result.continuedText, '这是初始的前半部分，【续写的后半部分台词】');
            assert.equal(result.savedText, '这是初始的前半部分，【续写的后半部分台词】');
            assert.equal(result.resultsCount, 1, '续写必须原地更新，不能增加新结果');
            assert.equal(result.continuedStatus, 'complete');

            // 检查发往模型的请求
            assert.equal(outbound.length, 2, '初始生成 1 次，续写 1 次');
            const continueRequest = outbound[1];
            // 待续写消息应作为末位 assistant
            const assistantMsg = continueRequest.messages.findLast(m => m.role === 'assistant');
            assert.ok(assistantMsg, '必须包含待续写的 assistant 消息');
            assert.equal(assistantMsg.content, '这是初始的前半部分，');
            // 末尾应包含 Nudge 提示
            const lastMsg = continueRequest.messages.at(-1);
            assert.equal(lastMsg.role, 'system');
            assert.ok(lastMsg.content.includes('Continue your last message without repeating'));
            assert.equal(continueRequest.type, 'continue', '发送参数保留续写类型');

            const comparisons = await page.evaluate(async () => {
                const openai = await import('/scripts/openai.js'), core = await import('/script.js');
                const persona = await import('/scripts/power-user.js'), constants = await import('/scripts/constants.js');
                const { preparePlayPreset } = await import('/scripts/extensions/third-party/tea-review/play-preset.js');
                const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-review/play-prompt.js');
                const ctx = SillyTavern.getContext(), preparer = createNativePlayPreparer(() => ctx);
                await preparer.ready();
                const base = structuredClone(openai.oai_settings), cases = [];
                for (const source of ['openai', 'claude']) for (const prefill of [false, true]) {
                    for (const variant of ['tail', 'empty-nudge', 'send-empty', 'budget']) {
                        Object.assign(openai.oai_settings, structuredClone(base), {
                            chat_completion_source: source, continue_prefill: prefill, assistant_prefill: '合成前缀',
                            continue_nudge_prompt: variant === 'empty-nudge' ? '' : '继续写：{{lastChatMessage}}',
                            send_if_empty: variant === 'send-empty' ? '合成空消息替代文字' : '',
                            openai_max_context: variant === 'budget' ? 900 : 8192, openai_max_tokens: 200,
                            squash_system_messages: false, function_calling: false, names_behavior: 1,
                        });
                        for (const key of Object.keys(core.extension_prompts)) delete core.extension_prompts[key];
                        core.setExtensionPrompt('synthetic-tail', '插入的助手指令', core.extension_prompt_types.IN_CHAT, 0, false, 2);
                        const history = Array.from({ length: variant === 'budget' ? 24 : 2 }, (_, index) => ({
                            name: index % 2 ? ctx.name2 : ctx.name1, is_user: index % 2 === 0,
                            mes: variant === 'budget' ? '合成历史正文。'.repeat(20) : index % 2 ? '原回复，' : '合成提示词', extra: {},
                        }));
                        const options = { name2: ctx.name2, charDescription: '', charPersonality: '', scenario: '',
                            worldInfoBefore: '', worldInfoAfter: '', extensionPrompts: core.extension_prompts,
                            bias: '', type: 'continue', quietPrompt: '', quietImage: null, cyclePrompt: history.at(-1).mes,
                            systemPromptOverride: '', jailbreakPromptOverride: '', history, messageExamples: [] };
                        const environment = { tavern: { settings: structuredClone(openai.oai_settings),
                            power: structuredClone(persona.power_user), name1: ctx.name1, name2: ctx.name2,
                            model: openai.getChatCompletionModel(), ...preparer.capture() } };
                        const [native] = await openai.prepareOpenAIMessages({ ...options, messages: openai.setOpenAIMessages(history) }, false);
                        const [scoped] = await preparePlayPreset(ctx, { openai, core, persona, constants }, environment, options);
                        cases.push({ source, prefill, variant, native, scoped });
                    }
                }
                Object.assign(openai.oai_settings, base);
                return cases;
            });
            for (const item of comparisons) assert.deepEqual(item.scoped, item.native,
                `${port}: ${item.source}, prefill=${item.prefill}, ${item.variant} 与酒馆原生续写一致`);

            console.log(JSON.stringify({ port, check: 'native continue verified', cases: comparisons.length,
                status: result.continuedStatus, resultsCount: result.resultsCount, errors }));
            assert.deepEqual(errors, []);
            await page.close();
        }
    } finally {
        clearTimeout(deadline);
        await browser.close();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
