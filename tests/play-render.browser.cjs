const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const taverns = process.env.TAVERN_RENDER_ROOTS?.split(';');
const helper = process.env.HELPER_RENDER_ROOT;
assert.ok(taverns?.length, 'Set TAVERN_RENDER_ROOTS to disposable Tavern source directories');
const extract = (source, name, kind = 'function') => {
    const start = source.indexOf(`export ${kind} ${name}`), end = source.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 2) + (kind === 'const' ? ';' : '');
};
const modules = new Map();
let tavern, manifest = '', resources = new Map(), requests = [];
const harness = `<!doctype html><meta charset="utf-8"><title>正文与网页显示验证</title><link rel="stylesheet" href="/style.css">
<style>body{margin:0;background:#f5f3ea}#teahouse-panel{display:block;height:auto;padding:20px;width:100%;box-sizing:border-box}#other{padding:20px}</style>
<h1>正文与网页显示验证</h1><div id="other">网页外的文字</div><div id="teahouse-panel"><div id="output"></div></div>
<script src="/deps/showdown/dist/showdown.js"></script><script src="/deps/dompurify/dist/purify.js"></script><script src="/deps/@adobe/css-tools/dist/umd/adobe-css-tools.js"></script>
<script type="module">
import {initializeTavernRenderer} from '/play-tavern-render.js';
import {initializeHelperResources} from '/play-helper-resources.js';
import {renderPlayText,splitPlayText,helperResourceMarkup,initializePlayRendering} from '/play-render.js';
import {createDiagnostics} from '/diagnostics.js';
window.diag=createDiagnostics({storage:{getItem:()=>null,setItem(){}}});
await initializeTavernRenderer(diag); initializeHelperResources(diag);
initializePlayRendering(diag);
window.renderText=(text,run=true)=>renderPlayText(document.getElementById('output'),text,'test',run,true,{name:'测试角色'});
window.split=splitPlayText;window.markup=helperResourceMarkup;window.ready=true;
</script>`;
const server = http.createServer(async (request, response) => {
    try {
        const name = decodeURIComponent(new URL(request.url, 'http://test').pathname);
        requests.push(name);
        if (name === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === '/favicon.ico') { response.statusCode = 204; return response.end(); }
        if (modules.has(name)) { response.setHeader('Content-Type', 'text/javascript'); return response.end(modules.get(name)); }
        if (name.endsWith('/src/iframe/third_party_message.html')) { response.setHeader('Content-Type','text/html'); return response.end(manifest); }
        if (resources.has(name)) {
            const value = resources.get(name);
            if (value.delay) await new Promise(resolve=>setTimeout(resolve,value.delay));
            response.statusCode = value.status || 200; response.setHeader('Content-Type',value.type || 'text/javascript');
            return response.end(value.text);
        }
        if (name.startsWith('/deps/')) {
            response.setHeader('Content-Type','text/javascript');
            return response.end(await fs.readFile(path.join(tavern, 'node_modules',name.slice(6))));
        }
        if (/^\/(?:[\w-]+\.(?:js|css)|vendor\/markdown-it.js|assets\/(?:fonts\/)?[\w.-]+)$/.test(name)) {
            response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
            return response.end(await fs.readFile(path.join(root, name.slice(1))));
        }
        response.statusCode=404;response.end();
    } catch(error) { response.statusCode=500;response.end(error.message); }
});
async function setup(directory) {
    tavern=directory;
    const read = name => fs.readFile(path.join(tavern,'public',name),'utf8');
    const [core,chats,power,utils,underscore,exclusion,patch] = await Promise.all(['script.js','scripts/chats.js','scripts/power-user.js','scripts/utils.js','scripts/showdown-underscore.js','scripts/showdown-exclusion.js','scripts/util/showdown-patch.js'].map(read));
    modules.set('/script.js',['messageFormatting','reloadMarkdownProcessor','addCopyToCodeBlocks'].map(name=>extract(core,name)).join('\n'));
    modules.set('/scripts/chats.js',['addDOMPurifyHooks','encodeStyleTags','decodeStyleTags'].map(name=>extract(chats,name)).join('\n'));
    modules.set('/scripts/power-user.js',`export const power_user={auto_fix_generated_markdown:true,encode_tags:false,allow_name2_display:true,markdown_escape_strings:'***,{{user}}',forbid_external_media:false};\n`+extract(power,'fixMarkdown'));
    modules.set('/scripts/utils.js',['canUseNegativeLookbehind','escapeHtml','escapeRegex','countOccurrences','isOdd','copyText'].map(name=>extract(utils,name,name==='copyText'&&utils.includes('export async function copyText')?'async function':'function')).join('\n'));
    modules.set('/scripts/showdown-underscore.js',underscore);
    modules.set('/scripts/showdown-exclusion.js',exclusion.replace("import { substituteParams } from '../script.js';",'const substituteParams=()=>{window.hostCalls++;return "WRONG"};'));
    modules.set('/scripts/extensions.js',`export const extensionNames=['third-party/JS-Slash-Runner'];`);
    modules.set('/lib.js',`
${patch.replace(/^export /m,'')}
addShowdownPatch(window.showdown);window.hostCalls=0;
export const showdown=window.showdown, DOMPurify=window.DOMPurify, css=window.cssTools;
export const hljs={highlightElement:node=>node.dataset.highlighted='yes'};`);
}
async function main() {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${server.address().port}/`, browser=await chromium.launch({channel:'msedge',headless:true});
    try {
        for(const directory of taverns) {
            await setup(directory);
            manifest='<script src="/a.js"></script><script src="/b.js"></script><link rel="stylesheet" href="/fixture/theme.css">';
            resources=new Map([
                ['/a.js',{text:'window.order=["library-a"];window.a=1;'}],
                ['/b.js',{text:'order.push("library-b");window.b=a+1;'}],
                ['/fixture/theme.css',{type:'text/css',text:'.colored{color:rgb(12,34,56);background-image:url("./pixel.svg")}'}],
                ['/fixture/pixel.svg',{type:'image/svg+xml',text:'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'}],
            ]);
            for(const viewport of [{width:1100,height:800},{width:390,height:844}]) {
                const page=await browser.newPage({viewport}); const errors=[];page.on('pageerror',error=>errors.push(error.message));
                await page.goto(url);await page.waitForFunction(()=>window.ready);
                assert.equal(await page.title(),'正文与网页显示验证');
                assert.equal(await page.evaluate(()=>diag.read().count),0,await page.evaluate(()=>diag.export()));
                await testWrappedHtmlReply(page,directory,viewport);
                await testReviewFixes(page);
                await testHiddenHeight(page);
                const original='<abstract>原来的摘要内容</abstract>\n\n<div>状态卡片</div>\n\n**后面的粗体**\n\n<style>.red{color:rgb(198,30,40)}</style><span class="red">红字</span> <ruby>茶<rt>chá</rt></ruby> :smile:';
                await page.evaluate(text=>renderText(text.replace(/<abstract>([\s\S]*?)<\/abstract>/g,'<details><summary>摘要</summary>\n$1\n</details>')),original);
                assert.equal(await page.locator('iframe').count(),0);
                await page.locator('summary').click();assert.equal(await page.locator('details').getAttribute('open'),'');
                assert.equal(await page.locator('strong').innerText(),'后面的粗体');
                assert.equal(await page.locator('.custom-red').evaluate(node=>getComputedStyle(node).color),'rgb(198, 30, 40)');
                assert.equal(await page.locator('rt').innerText(),'chá');
                assert.ok((await page.locator('#output').innerText()).includes('😄'));
                assert.equal(await page.evaluate(()=>hostCalls),0);
                if(process.env.TEA_QA_DIR){await fs.mkdir(process.env.TEA_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEA_QA_DIR,`details-${path.basename(directory)}-${viewport.width}.png`)});}
                await testTheatrePanelTagPreservation(page, viewport.width < 500);
                const boundary=await page.evaluate(()=>[
                    '```text\n<script>bad()</script>\n```',
                    '    <script>bad()</script>',
                    '<!-- <script>bad()</script> -->',
                    '<details><summary>摘要</summary>正文</details>\n\n**粗体**',
                    '<style>.x{color:red}</style>\n\n<section class="x">内容</section>\n\n<script>window.x=1</script>\n\n**粗体**',
                    '前言 <!doctype html><html><body>网页</body></html>\n\n**粗体**',
                    '<div>普通内容</div>\n\n    <script>bad()</script>',
                    '<!doctype html><html><body>第一张</body></html>\n\n<!doctype html><html><body>第二张</body></html>',
                    '\\<button onclick="bad()">示例</button> <span>文字</span>',
                    '<!doctype html><html><body><pre>\n```js\nexample()\n```\n</pre></body></html>',
                ].map(source=>split(source).map(part=>part.type)));
                assert.deepEqual(boundary,[['prose'],['prose'],['prose'],['prose'],['web','prose'],['prose','web','prose'],['prose'],['web','prose','web'],['prose'],['web']]);
                await page.evaluate(async()=>{
                    const {power_user}=await import('/scripts/power-user.js');power_user.forbid_external_media=true;
                    renderText('<img src="https://example.invalid/image.png"><style>.test{background:url(https://example.invalid/a)}</style><div class="test">媒体测试</div>');
                });
                assert.equal(await page.locator('#output img').count(),0);
                assert.doesNotMatch(await page.locator('#output style').innerText(),/example.invalid/);
                assert.equal(await page.evaluate(()=>hostCalls),0);
                const web='<style>body{margin:0;padding:16px}h2{font-size:24px}</style>\n\n<section><h2 class="colored">独立网页</h2><button id="next">翻页</button><div id="text">第一页</div></section>\n\n<script>order.push("own-init");document.addEventListener("DOMContentLoaded",()=>order.push("ready"));addEventListener("load",()=>order.push("load"));document.querySelector("#next").onclick=()=>document.querySelector("#text").textContent="第二页";try{parent.document.body;window.escaped=true}catch{window.escaped=false}</script>\n\n**网页后面的正文**';
                await page.evaluate(text=>renderText(text),web);const frame=page.frameLocator('iframe');
                await frame.getByRole('button',{name:'翻页'}).click();assert.equal(await frame.locator('#text').innerText(),'第二页');
                const execution=await frame.locator('body').evaluate(()=>({order,b,escaped}));
                assert.deepEqual(execution,{order:['library-a','library-b','own-init','ready','load'],b:2,escaped:false});
                assert.equal(await frame.locator('h2').evaluate(node=>getComputedStyle(node).color),'rgb(12, 34, 56)');
                assert.ok(requests.includes('/fixture/pixel.svg'));
                assert.equal(await page.locator('#output strong').innerText(),'网页后面的正文');
                assert.equal(await page.evaluate(()=>window.a),undefined);
                assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
                if(process.env.TEA_QA_DIR){await fs.mkdir(process.env.TEA_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEA_QA_DIR,`render-${path.basename(directory)}-${viewport.width}.png`)});}
                await page.evaluate(()=>renderText('```html\n<style>body{color:red}</style>\n```'));
                await page.frameLocator('iframe').locator('body').waitFor({state:'attached'});
                assert.deepEqual(errors,[]);
                console.log(JSON.stringify({version:path.basename(directory),viewport,formatter:'passed',resources:'passed',boundary:'passed',isolation:'passed',errors}));
                await page.close();
            }
        }
        await testFailures(browser,url);
        await testLifecycle(browser,url);
        await testLogPrivacy(browser,url);
        if(helper) await testInstalledResources(browser,url);
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
}
async function testTheatrePanelTagPreservation(page, mobile) {
    const testBody = '剧场正文 <char><user>{{char}}{{user}} <story>内容</story>\n\n<details><summary>折叠</summary>正文</details>';
    await page.evaluate(async ({ testBody }) => {
        const { createTheatrePanel } = await import('/panel.js');
        const community = new Map([
            ['test:tag-item', { id: 'test:tag-item', title: '标签测试条目', type: 'standalone', body: testBody, publishedAt: '2026-01-01T00:00:00Z' }]
        ]);
        const state = {
            settings: { enabled: true, pageSize: 5, favorites: {} },
            community,
            manuscripts: new Map(),
            status: '',
            personalError: '',
            get entries() { return this.community; }
        };
        let finish;
        const context = {
            POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
            POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0 },
            callGenericPopup: async () => false,
            Popup: class {
                constructor(panel) {
                    this.dlg = document.createElement('dialog');
                    this.dlg.className = 'popup';
                    this.dlg.innerHTML = '<div class="popup-body"><div class="popup-content"></div></div>';
                    this.dlg.querySelector('.popup-content').append(panel);
                }
                show() { document.body.append(this.dlg); this.dlg.showModal(); return new Promise(r => finish = r); }
                async complete() { try { this.dlg.close(); } catch {} this.dlg.remove(); finish?.(); }
            }
        };
        const ui = createTheatrePanel(() => context, state, {
            loaded: Promise.resolve(),
            saveSettings() {},
            toggleFavorite() {},
            updateLibrary() {},
            async saveManuscript() {},
            async deleteManuscript() {}
        });
        window.__panelTestInstance = ui;
        ui.open();
    }, { testBody });

    const panel = page.locator(':is(#teahouse-panel,.tea-panel-surface[data-active=true])');
    const bodyLocator = mobile
        ? panel.locator('.tea-feed-entry[data-id="test:tag-item"] .tea-body')
        : panel.locator('.tea-reading .tea-body');

    assert.equal(await bodyLocator.locator('details').count(), 0, '小剧场正文不得生成 HTML details 折叠元素');
    const text = await bodyLocator.innerText();
    assert.ok(text.includes('<char><user>{{char}}{{user}}'), '小剧场正文完整保留四种占位符文字');
    assert.ok(text.includes('<story>内容</story>'), '小剧场正文保留普通标签文字');
    assert.ok(text.includes('<details><summary>折叠</summary>正文</details>'), '小剧场正文把 HTML 标签作为文字显示');

    await page.evaluate(async () => {
        await window.__panelTestInstance?.close();
        delete window.__panelTestInstance;
        document.querySelectorAll('dialog.popup').forEach(d => { try { d.close(); } catch {} d.remove(); });
    });
}
async function testHiddenHeight(page) {
    await page.evaluate(() => {
        const output = document.getElementById('output');
        window.heightReports = [];
        window.captureHeight = event => {
            const frame = output.querySelector('iframe');
            if (event.source === frame?.contentWindow && event.data?.type === 'teahouse-output-height') heightReports.push(event.data.height);
        };
        addEventListener('message', captureHeight);
        const observer = new MutationObserver(() => {
            if (!output.querySelector('iframe')) return;
            output.setAttribute('aria-hidden', 'true'); observer.disconnect();
        });
        observer.observe(output, { childList: true });
        renderText('<button id="counter">计数 0</button><div id="body">网页高度验证</div><script>let count=0;document.querySelector("#counter").onclick=()=>{document.querySelector("#counter").textContent="计数 "+(++count);document.querySelector("#body").textContent="增加的内容 ".repeat(300);};</script>');
    });
    await page.waitForFunction(() => heightReports.length > 0);
    assert.equal(await page.locator('#output iframe').evaluate(frame => frame.style.height), '');
    await page.evaluate(() => { window.retainedHeightFrame = document.querySelector('#output iframe'); document.getElementById('output').removeAttribute('aria-hidden'); });
    await page.waitForFunction(() => parseFloat(retainedHeightFrame.style.height) === heightReports.at(-1));
    await page.frameLocator('#output iframe').getByRole('button', { name: '计数 0' }).click();
    await page.waitForFunction(() => parseFloat(retainedHeightFrame.style.height) === heightReports.at(-1) && heightReports.length > 1);
    assert.equal(await page.locator('#output iframe').evaluate(frame => frame === retainedHeightFrame), true);
    assert.equal(await page.frameLocator('#output iframe').getByRole('button').innerText(), '计数 1');
    await page.evaluate(() => { removeEventListener('message', captureHeight); renderText(''); });
}
async function testFailures(browser,url) {
    const page=await browser.newPage();await page.goto(url);await page.waitForFunction(()=>window.ready);
    const result=await page.evaluate(async()=>{
        const {createHelperResourceProvider}=await import('/play-helper-resources.js');
        const logs=[],request=async(url,{signal})=>{
            if(url.endsWith('manifest'))return new Response('<script src="/good"></script><script src="/bad"></script><script src="/late"></script>');
            if(url.endsWith('bad'))return new Response('',{status:503});
            if(url.endsWith('late'))await new Promise(resolve=>setTimeout(resolve,250));
            return new Response(url.endsWith('late')?'window.late=true':'window.good=true');
        };
        const provider=createHelperResourceProvider({locate:async()=>({url:location.origin+'/manifest',base:location.href}),request,timeout:80,diagnostics:{warn:(_op,error)=>logs.push(error.name),info(){}}});
        const prepared=await provider.prepare();
        const html=markup(prepared)+'<script>window.own=true</script>';
        renderText('```html\n'+html+'\n```');
        await new Promise(resolve=>setTimeout(resolve,350));
        return {count:prepared.length,logs,cache:(await provider.prepare()).length};
    });
    assert.deepEqual(result,{count:1,logs:['Error','TimeoutError'],cache:1});
    assert.deepEqual(await page.frameLocator('iframe').locator('body').evaluate(()=>({good:window.good,late:window.late,own:window.own})),{good:true,late:undefined,own:true});
    await page.close();console.log('Failure, timeout and late response checks passed');
}
async function testInstalledResources(browser,url) {
    manifest=await fs.readFile(path.join(helper,'src/iframe/third_party_message.html'),'utf8');
    resources.set('/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js',{text:await fs.readFile(path.join(helper,'lib/tailwindcss.min.js'),'utf8')});
    const page=await browser.newPage();await page.goto(url);await page.waitForFunction(()=>window.ready);
    const web='<div id="app" class="p-4"></div><i class="fa-solid fa-star"></i><h1>标题</h1><script>const state=Vue.ref(0);Vue.createApp({setup:()=>()=>Vue.h("button",{id:"counter",onClick:()=>state.value++},"点击 "+state.value)}).mount("#app");window.libraryState={jquery:typeof $,ui:typeof $.ui,touch:typeof $.ui.mouse,vue:typeof Vue,router:typeof VueRouter};</script>';
    await page.evaluate(text=>renderText('```html\n'+text+'\n```'),web);
    const frame=page.frameLocator('iframe.play-web-output');await frame.locator('body').waitFor();
    await page.waitForTimeout(3500);
    const diagnostics=await page.evaluate(()=>diag.export());
    const state=await frame.locator('body').evaluate(()=>({libraries:window.libraryState,padding:getComputedStyle(document.querySelector('#app')).padding,resources:[...document.querySelectorAll('script[src],link[href]')].length}));
    console.log(JSON.stringify({installedResources:state,diagnostics}));
    assert.equal(state.resources,8,'全部当前助手资源都需要有成功验证');
    assert.equal(state.padding,'16px');
    assert.deepEqual(state.libraries,{jquery:'function',ui:'object',touch:'function',vue:'object',router:'object'});
    await frame.locator('#counter').click();assert.equal(await frame.locator('#counter').innerText(),'点击 1');
    const font=await frame.locator('.fa-star').evaluate(async node=>{await document.fonts.ready;const style=getComputedStyle(node);return {family:style.fontFamily,loaded:document.fonts.check('900 16px "Font Awesome 7 Free"'),content:getComputedStyle(node,'::before').content};});
    assert.match(font.family,/Font Awesome/);assert.notEqual(font.content,'none');assert.equal(font.loaded,true);
    await page.evaluate(({manifest,web})=>{const comparison=document.createElement('iframe');comparison.id='helper-comparison';comparison.setAttribute('sandbox','allow-scripts');comparison.srcdoc=manifest+web;document.body.append(comparison);},{manifest,web});
    const comparison=page.frameLocator('#helper-comparison');await comparison.locator('#counter').click();
    const appearance=locator=>locator.locator('h1').evaluate(node=>{const style=getComputedStyle(node);return {size:style.fontSize,weight:style.fontWeight,margin:style.margin};});
    assert.deepEqual(await appearance(frame),await appearance(comparison));
    const jquery=manifest.match(/<script src="([^"]*\/jquery\/[^\"]+)"/)[1];
    await page.evaluate(source=>{
        document.querySelector('#helper-comparison').remove();
        renderText('```html\n<script>window.originalJquery=$;window.beforeOwn=typeof $.ui;</script><script src="'+source+'"></script><script>window.ownJquery=$;window.ownReady=false;$(function(){ownReady=true});addEventListener("load",()=>window.ownLoaded=true)</script><div>自己的 jQuery</div>\n```');
    },jquery);
    await page.frameLocator('iframe').locator('body').evaluate(()=>new Promise(resolve=>{if(window.ownLoaded)resolve();else addEventListener('load',resolve)}));
    assert.deepEqual(await page.frameLocator('iframe').locator('body').evaluate(()=>({beforeOwn,distinct:originalJquery!==ownJquery,ownReady,ownLoaded})),{beforeOwn:'object',distinct:true,ownReady:true,ownLoaded:true});
    console.log(JSON.stringify({font,helperAppearance:'matched',ownJqueryOrder:'passed'}));
    await page.close();
}
async function testLifecycle(browser,url) {
    manifest='<script src="/delayed.js"></script><script src="/integrity.js" integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="></script><script src="/throws.js"></script><script src="/after.js"></script>';
    resources.set('/delayed.js',{text:'window.sharedLibrary=true;',delay:300});
    resources.set('/integrity.js',{text:'window.invalidIntegrity=true;'});
    resources.set('/throws.js',{text:'throw new Error("fixture library error")'});
    resources.set('/after.js',{text:'window.afterFailure=true;'});
    const page=await browser.newPage();await page.goto(url);await page.waitForFunction(()=>window.ready);
    const optional=await page.evaluate(async()=>{
        const {createHelperResourceProvider}=await import('/play-helper-resources.js');
        const missing=createHelperResourceProvider({locate:async()=>null});
        const broken=createHelperResourceProvider({locate:async()=>({url:location.origin+'/missing',base:location.href}),request:async()=>new Response('',{status:404})});
        let source='/first.js';
        const fresh=()=>createHelperResourceProvider({locate:async()=>({url:location.origin+'/manifest',base:location.href}),request:async url=>new Response(url.endsWith('/manifest')?'<script src="'+source+'"></script>':'window.loaded=true')});
        const first=fresh(),before=(await first.prepare())[0].url;source='/second.js';
        return {missing:(await missing.prepare()).length,broken:(await broken.prepare()).length,before,cached:(await first.prepare())[0].url,refreshed:(await fresh().prepare())[0].url};
    });
    assert.equal(optional.missing,0);assert.equal(optional.broken,0);assert.equal(optional.before,optional.cached);
    assert.match(optional.refreshed,/second.js$/);
    await page.evaluate(()=>{
        renderText('```html\n<p>旧网页</p><script>parent.postMessage({oldRan:true},"*")</script>\n```');
        window.oldRan=0;addEventListener('message',event=>{if(event.data?.oldRan)oldRan++});
        setTimeout(()=>renderText('新正文'),40);
    });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(()=>oldRan),0);
    assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await page.locator('#output').innerText(),'新正文');
    await page.evaluate(()=>renderText('```html\n<button onclick="this.textContent=\'点击成功\'">继续显示</button><script>window.ownRan=true</script>\n```'));
    await page.frameLocator('iframe').getByRole('button',{name:'继续显示'}).click();
    assert.deepEqual(await page.frameLocator('iframe').locator('body').evaluate(()=>({shared:window.sharedLibrary,invalid:window.invalidIntegrity,after:window.afterFailure,own:window.ownRan})),{shared:true,invalid:undefined,after:true,own:true});
    await page.waitForFunction(()=>diag.read().entries.some(entry=>entry.operation==='独立网页资源执行' && entry.error?.name==='Error'));
    const logs=await page.evaluate(()=>diag.export());assert.doesNotMatch(logs,/data:text|base64|throw new Error/);
    await page.evaluate(()=>{window.oldFrame=document.querySelector('iframe');renderText('关闭后');});
    await page.waitForFunction(()=>!oldFrame.hasAttribute('srcdoc'));
    await page.close();
    manifest='<script src="/delayed.js"></script>';
    const hidden=await browser.newPage();await hidden.goto(url);await hidden.waitForFunction(()=>window.ready);
    await hidden.evaluate(()=>{
        renderText('```html\n<button>隐藏期间不运行</button><script>parent.postMessage({hiddenRan:true},"*")</script>\n```');
        window.runs=0;addEventListener('message',event=>{if(event.data?.hiddenRan)runs++});
        setTimeout(()=>document.getElementById('output').hidden=true,40);
    });
    await hidden.waitForTimeout(500);assert.equal(await hidden.evaluate(()=>runs),0);
    await hidden.evaluate(()=>document.getElementById('output').hidden=false);
    await hidden.waitForFunction(()=>runs===1);
    await hidden.close();console.log('Replacement, hiding, teardown, integrity and execution failure checks passed');
}
async function testWrappedHtmlReply(page,directory,viewport) {
    const html='<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<style>body{margin:0;padding:16px}#wrapped-text{color:rgb(12,34,56)}</style>\n</head>\n<body>\n<div id="wrapped-text">网页正文</div>\n<button id="wrapped-next">翻页</button>\n<script>document.getElementById("wrapped-next").onclick=()=>document.getElementById("wrapped-text").textContent="第二页";</script>\n</body>\n</html>';
    const opening='<content>\n```html\n', summary='<details><summary>摘要</summary>\n<span id="wrapped-summary">模拟摘要</span>\n</details>';
    const source=opening+html+'\n```\n\n</content>\n\n'+summary;
    const parts=await page.evaluate(source=>split(source),source);
    assert.deepEqual(parts.map(part=>part.type),['prose','web','prose']);
    assert.equal(parts[0].text,'<content>\n');
    assert.equal(parts[1].text,html+'\n');
    assert.equal(parts[2].text,'\n</content>\n\n'+summary);
    await page.evaluate(async text=>{
        const {renderPlayReply}=await import('/play-message-ui.js');
        window.wrappedOutput={box:document.getElementById('output')};
        window.wrappedError=document.createElement('p');
        window.renderWrapped=(text,status)=>renderPlayReply(wrappedOutput,{text,status},{displayText:text,error:wrappedError,anchor:'wrapped',name:'测试角色'});
        renderWrapped(text,'generating');
    },opening+html);
    assert.equal(await page.locator('iframe').count(),0);
    await page.evaluate(source=>renderWrapped(source,'complete'),source);
    const frame=page.frameLocator('iframe');
    await frame.getByRole('button',{name:'翻页'}).click();
    assert.equal(await page.locator('iframe').count(),1);
    assert.equal(await frame.locator('#wrapped-text').innerText(),'第二页');
    assert.equal(await frame.locator('#wrapped-text').evaluate(node=>getComputedStyle(node).color),'rgb(12, 34, 56)');
    assert.equal(await frame.locator('details').count(),0);
    assert.equal(await page.locator('#output pre').count(),0);
    assert.equal(await page.locator('#output').evaluate(node=>node.textContent.includes('```')),false);
    await page.locator('#output summary').click();
    assert.equal(await page.locator('#output details').getAttribute('open'),'');
    assert.equal(await page.locator('#wrapped-summary').innerText(),'模拟摘要');
    await page.locator('#output summary').click();
    assert.equal(await page.locator('#output details').getAttribute('open'),null);
    if(process.env.TEA_QA_DIR){await fs.mkdir(process.env.TEA_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEA_QA_DIR,`wrapped-html-${path.basename(directory)}-${viewport.width}.png`)});}
    for(const gap of ['', '\n']) {
        const source=opening+html+'\n```\n'+gap+'</content>\n\n'+summary;
        for(const status of ['complete','stopped','failed']) {
            await page.evaluate(({source,status})=>renderWrapped(source,status),{source,status});
            await page.frameLocator('iframe').getByRole('button',{name:'翻页'}).click();
            assert.equal(await page.frameLocator('iframe').locator('#wrapped-text').innerText(),'第二页');
            assert.equal(await page.locator('#output details').count(),1);
        }
    }
    const boundaries=await page.evaluate(()=>[
        '<content>\n```text\n<script>window.exampleExecuted=true</script>\n```\n</content>',
        '```text\n<content>\n```html\n<script>window.exampleExecuted=true</script>\n```\n</content>\n```',
        '````text\n<content>\n```html\n<script>window.exampleExecuted=true</script>\n```\n</content>\n````',
        '<!--\n<content>\n```html\n<script>window.exampleExecuted=true</script>\n```\n</content>\n-->',
        '<textarea>\n\n<content>\n```html\n<script>window.exampleExecuted=true</script>\n```\n</content>\n</textarea>',
        '<template>\n\n<content>\n```html\n<script>window.exampleExecuted=true</script>\n```\n</content>\n</template>',
        '    <content>\n    ```html\n    <script>window.exampleExecuted=true</script>\n    ```\n    </content>',
    ].map(source=>split(source).map(part=>part.type)));
    assert.deepEqual(boundaries,Array.from({length:7},()=>['prose']));
    await page.evaluate(()=>{renderText('清理测试内容');delete window.wrappedOutput;delete window.wrappedError;delete window.renderWrapped;});
}
async function testReviewFixes(page) {
    await page.route('**/review-event-image', route=>route.fulfill({status:404,body:''}));
    for (const run of [false, true]) {
        await page.evaluate(run=>{
            window.proseExecuted=0;
            const payload='p{--x:"</style><img src=/review-event-image onerror=window.proseExecuted++><style>"}';
            renderText('<custom-style>'+encodeURIComponent(payload)+'</custom-style><p>仍能阅读的正文</p>',run);
        },run);
        await page.waitForTimeout(30);
        assert.equal(await page.evaluate(()=>proseExecuted),0,'解码 CSS 不能创建可执行 HTML');
        assert.equal(await page.locator('#output img').count(),0);
        assert.ok((await page.locator('#output').innerText()).includes('仍能阅读的正文'));
    }
    const raw=['textarea','title','xmp','iframe','noembed','noframes','noscript','template'];
    for (const tag of raw) {
        for (const gap of ['', '\n\n']) {
            await page.evaluate(({tag,gap})=>renderText('<'+tag+'>'+gap+'<script>window.exampleExecuted=true</script>'+gap+'</'+tag+'>'),{tag,gap});
            assert.equal(await page.locator('iframe').count(),0,tag+' 中的脚本示例不运行');
        }
    }
    const source='<!doctype html><html><head><style>li{color:rgb(12,34,56)}</style></head><body><ul><li id="row">第一项<li>第二项</ul><button id="b">更新列表</button><script>document.getElementById("b").onclick=()=>document.getElementById("row").textContent="已更新";</script></body></html>\n\n**网页后的正文**';
    await page.evaluate(source=>renderText(source),source);
    await page.frameLocator('iframe').getByRole('button',{name:'更新列表'}).waitFor();
    assert.equal(await page.locator('iframe').count(),1,'省略 li 的结束标签仍是一个完整网页');
    await page.frameLocator('iframe').getByRole('button',{name:'更新列表'}).click();
    assert.equal(await page.frameLocator('iframe').locator('#row').innerText(),'已更新');
    assert.equal(await page.frameLocator('iframe').locator('#row').evaluate(node=>getComputedStyle(node).color),'rgb(12, 34, 56)');
    assert.equal(await page.locator('#output strong').innerText(),'网页后的正文');
    await page.evaluate(()=>{window.savedOutput=document.getElementById('output');window.oldWeb=savedOutput.querySelector('iframe');savedOutput.remove();});
    await page.waitForFunction(()=>!oldWeb.hasAttribute('srcdoc'));
    await page.evaluate(()=>document.getElementById('teahouse-panel').append(savedOutput));
    await page.frameLocator('iframe').getByRole('button',{name:'更新列表'}).click();
    assert.equal(await page.frameLocator('iframe').locator('#row').innerText(),'已更新','相同容器重新挂接后恢复网页');
    const animations=await page.evaluate(async()=>{
        const {renderTavernProse}=await import('/play-tavern-render.js');
        const outsideStyle=document.createElement('style');outsideStyle.textContent='@keyframes spin{from{opacity:1}to{opacity:1}}#other{animation:spin 1s infinite}';document.head.append(outsideStyle);
        const host=document.getElementById('output');host.replaceChildren();
        for(const opacity of [0.25,0.75]) {
            const body=document.createElement('div');host.append(body);
            renderTavernProse(body,'<style>@media(min-width:1px){@keyframes spin{from{opacity:'+opacity+'}to{opacity:'+opacity+'}}.test{animation:spin 1s linear infinite;--motion:spin 1s infinite}.variable{animation:var(--motion)}}</style><div class="test">动画</div><div class="test variable">变量动画</div><div style="animation-name:spin;animation-duration:1s;animation-iteration-count:infinite">行内动画</div>');
        }
        const result={outside:getComputedStyle(document.getElementById('other')).opacity,
            children:[...host.querySelectorAll('.custom-test,[style]')].map(node=>({opacity:getComputedStyle(node).opacity,name:getComputedStyle(node).animationName}))};
        outsideStyle.remove();return result;
    });
    assert.equal(animations.outside,'1','正文动画不影响外层页面');
    assert.deepEqual(animations.children.map(item=>item.opacity),['0.25','0.25','0.25','0.75','0.75','0.75']);
    assert.notEqual(animations.children[0].name,animations.children[3].name,'不同正文中的同名动画相互隔离');
    await page.evaluate(()=>renderText('清理测试内容'));
}
async function testLogPrivacy(browser,url) {
    manifest='<script src="/privacy-jquery.js"></script><script src="/privacy-throw.js"></script>';
    resources.set('/privacy-jquery.js',{text:await fs.readFile(path.join(tavern,'public/lib/jquery-3.5.1.min.js'),'utf8')});
    resources.set('/privacy-throw.js',{text:'window.failWithContent=text=>{const error=new TypeError(text);error.name=text;throw error;};'});
    const page=await browser.newPage();await page.goto(url);await page.waitForFunction(()=>window.ready);
    await page.evaluate(()=>renderText('```html\n<p id="private">### !! 虚构回复正文-不应进入日志</p><script>$.find(document.getElementById("private").textContent)</script><script>failWithContent(document.getElementById("private").textContent)</script><script>window.afterError=true</script>\n```'));
    await page.waitForFunction(()=>diag.read().entries.filter(entry=>entry.operation==='独立网页资源执行').length===2);
    assert.equal(await page.frameLocator('iframe').locator('body').evaluate(()=>window.afterError),true);
    const logs=await page.evaluate(()=>({entries:diag.read().entries.filter(entry=>entry.error),exported:diag.export()}));
    assert.deepEqual(logs.entries.map(entry=>entry.error),[{name:'Error'},{name:'Error'}]);
    assert.ok(logs.entries.every(entry=>Number.isSafeInteger(entry.line)));
    assert.doesNotMatch(logs.exported,/虚构回复|不应进入日志|data:|base64|Syntax error|unrecognized expression/);
    await page.close();console.log('Library errors retain type and location without response text');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
