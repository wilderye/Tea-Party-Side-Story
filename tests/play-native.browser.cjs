// Run against disposable SillyTavern 1.14 / 1.19 profiles with first-run setup
// complete and at least one character. Settings are changed in these profiles.
// PLAY_NATIVE_URLS can override the comma-separated local test server URLs.
// PLAYWRIGHT_MODULE can point to an installed Playwright package.
// All generation requests are intercepted and receive a simulated reply.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const url of (process.env.PLAY_NATIVE_URLS || 'http://127.0.0.1:9051,http://127.0.0.1:9052').split(',')) {
      const port = new URL(url.trim()).port;
      const page = await browser.newPage();
      const errors = [], outbound = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/backends/chat-completions/generate', route => {
        const payload = route.request().postDataJSON(); outbound.push(payload);
        return payload.stream
          ? route.fulfill({ contentType: 'text/event-stream', body: 'data: '+JSON.stringify({choices:[{delta:{content:'模拟回复'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n' })
          : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '模拟回复' } }] }) });
      });
      await page.route('**/scripts/extensions/third-party/tea-review/**', async route => {
        const file = path.basename(new URL(route.request().url()).pathname);
        await route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(path.join(root, file)) });
      });
      await page.goto(url.trim());
      await page.waitForFunction(() => window.SillyTavern?.getContext?.().chatCompletionSettings?.prompts?.length > 0);
      await page.evaluate(() => new Promise(resolve => { const ctx = SillyTavern.getContext(); ctx.eventSource.once(ctx.eventTypes.APP_READY, resolve); }));
      const result = await page.evaluate(async () => {
        const openai = await import('/scripts/openai.js');
        const core = await import('/script.js');
        const persona = await import('/scripts/power-user.js');
        const constants = await import('/scripts/constants.js');
        const { preparePlayPreset } = await import('/scripts/extensions/third-party/tea-review/play-preset.js');
        const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-review/play-prompt.js');
        const ctx = SillyTavern.getContext();
        const preparer = createNativePlayPreparer(() => ctx); await preparer.ready();
        openai.setupChatCompletionPromptManager(openai.oai_settings);
        Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o',
          openai_max_context: 8192, openai_max_tokens: 512, scenario_format: '', personality_format: '',
          function_calling: false, image_inlining: false, squash_system_messages: false, names_behavior: 0 });
        Object.assign(persona.power_user, { persona_description: '测试人设', persona_description_position: persona.persona_description_positions.IN_PROMPT });
        const history = [{ name: '角色', is_user: false, mes: '前面的回复', extra: {} }, { name: '你', is_user: true, mes: '这次小剧场的提示词', extra: {} }];
        const options = { name2: '角色', charDescription: '角色说明', charPersonality: '角色性格', scenario: '测试场景',
          worldInfoBefore: '世界书前', worldInfoAfter: '世界书后', extensionPrompts: {}, bias: '', type: 'normal',
          quietPrompt: '', quietImage: null, cyclePrompt: '', systemPromptOverride: '', jailbreakPromptOverride: '',
          history, messageExamples: [[{ name: 'example_user', content: '示例问题' }, { name: 'example_assistant', content: '示例答案' }]] };
        const environment = { tavern: { settings: structuredClone(openai.oai_settings), power: structuredClone(persona.power_user),
          name1: ctx.name1, name2: ctx.name2, model: 'gpt-4o', ...preparer.capture() } };
        const modules = { openai, core, persona, constants };
        window.playNativeBase = structuredClone({ settings: environment.tavern.settings, power: environment.tavern.power });
        const [native] = await openai.prepareOpenAIMessages({ ...options, messages: openai.setOpenAIMessages(history) }, false);
        const [scoped] = await preparePlayPreset(ctx, modules, environment, options);
        openai.oai_settings.prompts.find(prompt => prompt.identifier === 'main').content = '后来改过的主提示词';
        openai.oai_settings.names_behavior = 2;
        openai.oai_settings.new_chat_prompt = '后来改过的开场';
        openai.oai_settings.openai_model = 'gpt-4.1';
        openai.oai_settings.openai_max_context = 1024;
        const [afterSwitch] = await preparePlayPreset(ctx, modules, environment, options);
        return { native, scoped, afterSwitch, unchanged: openai.oai_settings.new_chat_prompt === '后来改过的开场' };
      });
      console.log(JSON.stringify({ port, check: 'basic preset snapshot', messages: result.native.length, errors }));
      assert.deepEqual(result.scoped, result.native, 'scoped assembly must match the host');
      assert.deepEqual(result.afterSwitch, result.native, 'switching settings must not change the snapshot');
      assert.equal(result.unchanged, true, 'snapshot assembly must not restore over user changes');
      const advanced = await page.evaluate(async () => {
        const openai = await import('/scripts/openai.js'), core = await import('/script.js');
        const persona = await import('/scripts/power-user.js'), constants = await import('/scripts/constants.js');
        const tokenizers = await import('/scripts/tokenizers.js'), utils = await import('/scripts/utils.js');
        const { preparePlayPreset } = await import('/scripts/extensions/third-party/tea-review/play-preset.js');
        const ctx = SillyTavern.getContext(), checks = [];
        const { createNativePlayPreparer } = await import('/scripts/extensions/third-party/tea-review/play-prompt.js');
        const preparer = createNativePlayPreparer(() => ctx); await preparer.ready();
        for (const kind of ['depth', 'relative', 'overrides', 'names', 'quotes', 'budget', 'disabled',
          'signature', 'unsupported-signature', 'foreign-signature']) {
          Object.assign(openai.oai_settings, structuredClone(window.playNativeBase.settings));
          Object.assign(persona.power_user, structuredClone(window.playNativeBase.power));
          for (const key of Object.keys(core.extension_prompts)) delete core.extension_prompts[key];
          const settings = openai.oai_settings;
          const history = Array.from({length: kind === 'budget' ? 25 : 4},(_,i)=>({name:i%2?'你':'角色',is_user:!!(i%2),mes:'消息'+i+'：'+('测试正文。'.repeat(kind==='budget'?15:1)),extra:{}}));
          const options = { name2:ctx.name2,charDescription:'角色说明',charPersonality:'角色性格',scenario:'场景',worldInfoBefore:'世界书前',worldInfoAfter:'世界书后',
            extensionPrompts:core.extension_prompts,bias:'',type:'normal',quietPrompt:'',quietImage:null,cyclePrompt:'',systemPromptOverride:'',jailbreakPromptOverride:'',
            history,messageExamples:[[{name:'example_user',content:'例子问'},{name:'example_assistant',content:'例子答'}]] };
          const order = settings.prompt_order.find(row=>String(row.character_id)===String(openai.promptManager.activeCharacter.id)).order;
          if (kind === 'depth') {
            settings.prompts.push({identifier:'test-depth',role:'assistant',content:'预设深度提示',system_prompt:false,injection_position:1,injection_depth:1,injection_order:80});
            order.push({identifier:'test-depth',enabled:true});
            core.setExtensionPrompt('test-in-chat','扩展深度提示',core.extension_prompt_types.IN_CHAT,1,false,0);
          }
          if (kind === 'relative') {
            core.setExtensionPrompt('2_floating_prompt','作者注释',core.extension_prompt_types.IN_PROMPT,0,false,0);
            core.setExtensionPrompt('test-before','主提示前的扩展',core.extension_prompt_types.BEFORE_PROMPT,0,false,1);
            core.setExtensionPrompt('test-after','主提示后的扩展',core.extension_prompt_types.IN_PROMPT,0,false,0);
          }
          if (kind === 'overrides') { options.systemPromptOverride='角色主提示 {{original}}'; options.jailbreakPromptOverride='角色末尾提示'; }
          if (kind === 'names') settings.names_behavior=2;
          if (kind === 'quotes') settings.wrap_in_quotes=true;
          if (kind === 'budget') { settings.openai_max_context=900; settings.openai_max_tokens=300; persona.power_user.pin_examples=true; }
          if (kind === 'disabled') { order.find(item=>item.identifier==='main').enabled=false; order.find(item=>item.identifier==='dialogueExamples').enabled=false; }
          if (kind.includes('signature')) {
            if (kind !== 'unsupported-signature') Object.assign(settings, { chat_completion_source: 'makersuite', google_model: 'gemini-2.5-pro' });
            Object.assign(history[0].extra, { api: settings.chat_completion_source,
              model: kind === 'foreign-signature' ? 'another-model' : ctx.getChatCompletionModel(), reasoning_signature: 'test-thought-signature' });
          }
          const env={tavern:{settings:structuredClone(settings),power:structuredClone(persona.power_user),name1:ctx.name1,name2:ctx.name2,model:ctx.getChatCompletionModel(),...preparer.capture(),canUseTools:false}};
          const modules={openai,core,persona,constants,tokenizers,utils};
          const [native]=await openai.prepareOpenAIMessages({...options,messages:openai.setOpenAIMessages(history)},false);
          const [scoped]=await preparePlayPreset(ctx,modules,env,options);
          settings.prompts.find(item=>item.identifier==='main').content='后来修改';
          settings.new_chat_prompt='后来修改的开场'; settings.openai_model='gpt-3.5-turbo'; settings.openai_max_context=500;
          settings.chat_completion_source='openai';
          const [switched]=await preparePlayPreset(ctx,modules,env,options);
          checks.push({kind,native,scoped,switched});
        }
        return checks;
      });
      for (const item of advanced) {
        assert.deepEqual(item.scoped,item.native,port+': native parity '+item.kind);
        assert.deepEqual(item.switched,item.native,port+': pinned settings '+item.kind);
      }
      console.log(JSON.stringify({port,check:'preset variants',cases:advanced.map(item=>item.kind)}));
      const parameters = await page.evaluate(async () => {
        const openai=await import('/scripts/openai.js'), persona=await import('/scripts/power-user.js'), core=await import('/script.js');
        const {legacyPlayParameters}=await import('/scripts/extensions/third-party/tea-review/play-parameters.js');
        const ctx=SillyTavern.getContext(), cases=[];
        const definitions=[['openai','openai_model','gpt-4o'],['openai','openai_model','gpt-5.1'],['openai','openai_model','gpt-5.1-chat-latest'],
          ['openai','openai_model','o1'],['custom','custom_model','custom-model'],['claude','claude_model','claude-sonnet-4-5'],
          ['makersuite','google_model','gemini-2.5-pro'],['vertexai','vertexai_model','gemini-2.5-pro'],['openrouter','openrouter_model','openai/gpt-4o'],
          ['cohere','cohere_model','command-r-plus'],['mistralai','mistralai_model','mistral-large-latest'],['deepseek','deepseek_model','deepseek-chat'],
          ['xai','xai_model','grok-4-fast-reasoning'],['perplexity','perplexity_model','sonar'],['zai','zai_model','glm-4.5']];
        for(const [source,key,model] of definitions){
          Object.assign(openai.oai_settings,structuredClone(window.playNativeBase.settings),{chat_completion_source:source,[key]:model,seed:42,n:1,reasoning_effort:'min',function_calling:false,reverse_proxy:''});
          Object.assign(persona.power_user,structuredClone(window.playNativeBase.power),{custom_stopping_strings:'["STOP","END","THREE","FOUR","FIVE"]',custom_stopping_strings_macro:false,request_token_probabilities:true});
          const settings=structuredClone(openai.oai_settings),messages=[{role:'system',content:'规则'},{role:'user',content:'问题'}];
          const modern=typeof openai.createGenerationParameters==='function';
          let native;
          if(modern) native=(await openai.createGenerationParameters(settings,model,'normal',structuredClone(messages))).generate_data;
          else {
            const capture=data=>native=structuredClone(data),controller=new AbortController(); controller.abort();
            ctx.eventSource.makeLast(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,capture);
            try{await openai.sendOpenAIRequest('normal',structuredClone(messages),controller.signal)}catch(error){if(error.name!=='AbortError')throw error}
            finally{ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,capture)}
          }
          let ours=legacyPlayParameters(settings,model,structuredClone(messages),{power:structuredClone(persona.power_user),name1:ctx.name1,name2:ctx.name2,modern},text=>core.substituteParams(text));
          if(modern){const keys=['stop','logprobs','reverse_proxy','proxy_password','assistant_prefill','user_name','char_name','group_names'];
            native=Object.fromEntries(keys.map(key=>[key,native[key]]));ours=Object.fromEntries(keys.map(key=>[key,ours[key]]));}
          cases.push({source,model,native:JSON.parse(JSON.stringify(native)),ours:JSON.parse(JSON.stringify(ours))});
        }
        return cases;
      });
      for(const item of parameters)assert.deepEqual(item.ours,item.native,port+': parameter parity '+item.source+'/'+item.model);
      console.log(JSON.stringify({port,check:'request parameter variants',cases:parameters.length}));
      await page.locator('#main_api').selectOption('openai', { force: true });
      await page.waitForFunction(()=>SillyTavern.getContext().mainApi==='openai');
      const runtime = await page.evaluate(async()=>{
        const openai=await import('/scripts/openai.js'), core=await import('/script.js');
        const {createPlayRuntime}=await import('/scripts/extensions/third-party/tea-review/play-runtime.js');
        const {createPlayHistory}=await import('/scripts/extensions/third-party/tea-review/play-history.js');
        await SillyTavern.getContext().selectCharacterById(0);
        Object.assign(openai.oai_settings,structuredClone(window.playNativeBase.settings),{chat_completion_source:'openai',openai_model:'gpt-4o',temp_openai:0.7,stream_openai:false,n:3});
        openai.oai_settings.prompts.find(item=>item.identifier==='main').content='固定预设正文';
        let gate,entered;const held=new Promise(resolve=>gate=resolve),began=new Promise(resolve=>entered=resolve);
        let first=true,payload;const files=new Map(), original=SillyTavern.getContext(), before=structuredClone(original.chat);
        const history=createPlayHistory({readFile:async name=>files.get(name)??null,writeFile:async(name,text)=>{if(first){first=false;entered();await held}files.set(name,text)},removeFile:async name=>files.delete(name)});
        const ctx=()=>({...SillyTavern.getContext(),ChatCompletionService:{sendRequest:async(data,...args)=>{payload=structuredClone(data);return original.ChatCompletionService.sendRequest(data,...args)}}});
        const runtime=createPlayRuntime(ctx,{enabled:true},history);await runtime.initialize();
        const sending=runtime.send({prompt:'测试本次小剧场'});await Promise.race([began,sending.then(()=>{throw Error('Missing save checkpoint')})]);
        openai.oai_settings.openai_model='gpt-4.1';openai.oai_settings.temp_openai=1.3;openai.oai_settings.prompts.find(item=>item.identifier==='main').content='不应混入的后来预设';gate();
        const result=await sending;
        return {result,payload,chatUnchanged:JSON.stringify(before)===JSON.stringify(original.chat),latestModel:openai.oai_settings.openai_model};
      });
      assert.equal(runtime.result.result.status,'complete',JSON.stringify(runtime.result));
      assert.equal(runtime.payload.model,'gpt-4o');assert.equal(runtime.payload.temperature,0.7);assert.equal(runtime.payload.n??1,1);
      assert.ok(runtime.payload.messages.some(message=>String(message.content).includes('固定预设正文')));
      assert.ok(!JSON.stringify(runtime.payload.messages).includes('不应混入的后来预设'));
      assert.equal(runtime.latestModel,'gpt-4.1');assert.equal(runtime.chatUnchanged,true);
      assert.equal(outbound.at(-1).messages[0].content,'本次仅输出小剧场，不生成任何状态栏或待办等附加内容。');
      assert.deepEqual(errors, [], 'native flow must not raise browser errors');
      console.log(JSON.stringify({port,check:'full runtime with settings switched during save',status:runtime.result.result.status,model:runtime.payload.model,n:runtime.payload.n}));

      const additions = await page.evaluate(async()=>{
        const openai=await import('/scripts/openai.js'),core=await import('/script.js'),persona=await import('/scripts/power-user.js');
        const constants=await import('/scripts/constants.js'),tokenizers=await import('/scripts/tokenizers.js');
        const regex=await import('/scripts/extensions/regex/engine.js'),extensions=await import('/scripts/extensions.js');
        const {createPlayRuntime}=await import('/scripts/extensions/third-party/tea-review/play-runtime.js');
        const {createPlayHistory}=await import('/scripts/extensions/third-party/tea-review/play-history.js');
        const {createNativePlayPreparer}=await import('/scripts/extensions/third-party/tea-review/play-prompt.js');
        const {preparePlayPreset}=await import('/scripts/extensions/third-party/tea-review/play-preset.js');
        const {createPlayDisplay}=await import('/scripts/extensions/third-party/tea-review/play-processing.js');
        const ctx=()=>SillyTavern.getContext();
        Object.assign(openai.oai_settings,structuredClone(window.playNativeBase.settings),{chat_completion_source:'openai',openai_model:'gpt-4o',stream_openai:false,n:1});
        const files=new Map(),history=createPlayHistory({readFile:async name=>files.get(name)??null,writeFile:async(name,text)=>files.set(name,text),removeFile:async name=>files.delete(name)});
        const settings={enabled:true,playPrompt:'自定义请求最前段',playApi:{mode:'tavern'}};
        const runtime=createPlayRuntime(ctx,settings,history);await runtime.initialize();
        const assembled=data=>data.prompt.unshift({role:'system',content:'ASSEMBLED_CALLBACK'});
        const final=data=>data.messages.unshift({role:'system',content:'SETTINGS_CALLBACK'});
        ctx().eventSource.on(ctx().eventTypes.GENERATE_AFTER_DATA,assembled);
        ctx().eventSource.on(ctx().eventTypes.CHAT_COMPLETION_SETTINGS_READY,final);
        const requests=[];
        try {
          for(const mode of ['tavern','custom'])for(const squash of [false,true]){
            openai.oai_settings.squash_system_messages=squash;
            settings.playApi=mode==='tavern'?{mode}:{mode,url:'http://127.0.0.1:1/v1',model:'synthetic-model',key:''};
            const result=await runtime.send({prompt:'本次小剧场要求'});
            requests.push({mode,squash,status:result.result.status});
          }
          settings.playPrompt='';openai.oai_settings.squash_system_messages=false;
          const cleared=await runtime.send({prompt:'清空附加提示词'});requests.push({mode:'clear',status:cleared.result.status});
          settings.playPrompt='再次生成的第一条';
          const again=await runtime.regenerate(cleared.roundId,cleared.result.id);requests.push({mode:'regenerate',status:again.result.status});
        } finally {
          ctx().eventSource.removeListener(ctx().eventTypes.GENERATE_AFTER_DATA,assembled);
          ctx().eventSource.removeListener(ctx().eventTypes.CHAT_COMPLETION_SETTINGS_READY,final);
        }

        const preparer=createNativePlayPreparer(ctx);await preparer.ready();
        const budgetSettings={...structuredClone(openai.oai_settings),openai_max_context:900,openai_max_tokens:200,squash_system_messages:false};
        budgetSettings.prompts.find(prompt=>prompt.identifier==='main').content='系统规则';
        const env={tavern:{settings:budgetSettings,power:structuredClone(persona.power_user),name1:ctx().name1,name2:ctx().name2,model:'gpt-4o',...preparer.capture()}};
        const historyMessages=Array.from({length:25},(_,i)=>({name:i%2?ctx().name1:ctx().name2,is_user:!!(i%2),mes:'历史消息'+i+'：'+'绿茶香气弥漫房间。'.repeat(12),extra:{}}));
        const options={charDescription:'角色说明',charPersonality:'',scenario:'',worldInfoBefore:'',worldInfoAfter:'',extensionPrompts:{},bias:'',type:'normal',
          history:historyMessages,messageExamples:[],systemPromptOverride:'',jailbreakPromptOverride:''};
        const modules={openai,core,persona,constants,tokenizers};
        const [normal]=await preparePlayPreset(ctx(),modules,env,options);
        const prefix='仅输出小剧场。'.repeat(22);
        const [reserved]=await preparePlayPreset(ctx(),modules,env,{...options,leadingSystemPrompt:prefix});
        const requestMessages=[{role:'system',content:prefix},...reserved];
        // The host's array helper counts each message separately, repeating
        // request padding. Count this complete request with padding only once.
        const counted=await fetch('/api/tokenizers/openai/count?model='+encodeURIComponent(env.tavern.tokenizerModel),{
          method:'POST',headers:ctx().getRequestHeaders(),body:JSON.stringify(requestMessages)});
        if(!counted.ok)throw Error('预算验证无法读取完整请求的长度');
        const total=Number((await counted.json()).token_count);
        const nativeMessages=await Promise.all(requestMessages.map(message=>openai.Message.createAsync(message.role,message.content)));
        const budgeted=3+nativeMessages.reduce((sum,message)=>sum+message.getTokens(),0);

        // Use the host's three real rule stores and native replacement engine.
        const rule=(id,name,find,replace,extra={})=>({id,scriptName:name,findRegex:find,replaceString:replace,trimStrings:[],placement:[regex.regex_placement.AI_OUTPUT],
          disabled:false,markdownOnly:false,promptOnly:false,runOnEdit:true,substituteRegex:0,minDepth:99,maxDepth:0,...extra});
        const shared=ctx().uuidv4();
        const global=[rule(shared,'全局规则','BEGIN','GLOBAL'),rule(ctx().uuidv4(),'显示美化','SCOPED','<div>{{char}} 的网页</div>',{markdownOnly:true})];
        const preset=[rule(shared,'预设规则','GLOBAL','PRESET')],scoped=[rule(shared,'角色规则','PRESET','SCOPED')];
        extensions.extension_settings.disabledExtensions=extensions.extension_settings.disabledExtensions.filter(name=>name!=='regex');
        await regex.saveScriptsByType(global,regex.SCRIPT_TYPES.GLOBAL);
        await regex.saveScriptsByType(preset,regex.SCRIPT_TYPES.PRESET);
        await regex.saveScriptsByType(scoped,regex.SCRIPT_TYPES.SCOPED);
        regex.allowPresetScripts(regex.getCurrentPresetAPI(),regex.getCurrentPresetName());regex.allowScopedScripts(ctx().characters[ctx().characterId]);
        const displaySettings={},display=createPlayDisplay(ctx,displaySettings);await display.refresh();
        const keys=display.rules.filter(item=>item.script.id===shared).map(item=>item.key);
        const rendered=display.process('<status>隐藏状态</status>BEGIN');
        const native=regex.getRegexedString(regex.getRegexedString('BEGIN',regex.regex_placement.AI_OUTPUT),regex.regex_placement.AI_OUTPUT,{isMarkdown:true});
        displaySettings.playRegexExclusions=[display.rules.find(item=>item.source==='PRESET').key];display.updateSettings();
        const excluded=display.process('BEGIN');
        return{requests,budget:{normal:normal.length,reserved:reserved.length,total,budgeted,limit:700},regex:{rendered,native,excluded,keys},name:ctx().name2};
      });
      assert.ok(additions.requests.every(item=>item.status==='complete'),JSON.stringify(additions.requests));
      const latest=outbound.slice(-6);
      assert.equal(latest.length,6);
      for(let i=0;i<4;i++){
        assert.ok(latest[i].messages[0].content.startsWith('自定义请求最前段'));
        assert.equal(latest[i].messages.map(message=>message.content).join('\n').split('自定义请求最前段').length,2);
        assert.equal(latest[i].chat_completion_source,i<2?'openai':'custom');
      }
      assert.equal(latest[4].messages[0].content,'SETTINGS_CALLBACK');
      assert.equal(latest[5].messages[0].content,'再次生成的第一条');
      assert.ok(additions.budget.reserved<additions.budget.normal,'前置提示词占用长度会相应减少可放入的聊天内容');
      assert.ok(additions.budget.total<=additions.budget.limit,JSON.stringify(additions.budget));
      assert.ok(additions.budget.budgeted<=additions.budget.limit,'酒馆原生消息计数同样计入前置提示词：'+JSON.stringify(additions.budget));
      assert.equal(additions.regex.rendered,additions.regex.native,'三处规则和两个显示阶段的结果与酒馆一致');
      assert.match(additions.regex.rendered,/<div>.* 的网页<\/div>/);
      assert.equal(additions.regex.excluded,'GLOBAL');assert.equal(new Set(additions.regex.keys).size,3);
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({port,check:'prefix, token budget, native regex',requests:additions.requests,budget:additions.budget,regex:additions.regex.rendered,errors}));
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
