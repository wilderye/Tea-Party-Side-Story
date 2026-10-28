// Browser plugin not available. Use the repository's synthetic panel harness.
// Flow: original pair -> new branch -> chat -> history/search -> favorites -> return.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (request, response) => {
    try {
        const name = new URL(request.url, 'http://test').pathname.slice(1);
        if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(harness); }
        if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
        if (name === 'thumbnail') { response.setHeader('Content-Type','image/svg+xml'); return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#739785"/></svg>'); }
        if (!/^(?:[\w-]+\.(?:js|css)|vendor\/markdown-it\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(name)) {
            response.statusCode = 404; return response.end();
        }
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml'
            : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await fs.readFile(path.join(root, name)));
    } catch (error) { response.statusCode = 500; response.end(error.message); }
});
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page, name) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}
async function verify(page, url, viewport) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator('#teahouse-panel'), button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    await button('剧场演出').click();
    const seedId = await page.evaluate(() => seed.a);
    const original = panel.locator(`[data-record="${seedId}"]`);
    await original.getByRole('button', { name: '创建分支', exact: true }).waitFor();
    const originalFeed = panel.locator('.play-feed').filter({ visible: true });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    await originalFeed.evaluate(node => { node.scrollTop = 140; }); await settle(page);
    const oldScroll = await originalFeed.evaluate(node => node.scrollTop);
    await original.getByRole('button', { name: '创建分支', exact: true }).click();
    const branch = panel.locator('.play-branch-page').filter({ visible: true });
    await branch.locator('[data-message-id]').first().waitFor();
    assert.equal(await button('历史记录').getAttribute('aria-pressed'), 'true');
    const branchId = await page.evaluate(async () => (await runtime.listChats((await runtime.listCharacters()).find(c => c.avatar === 'A.png').id)).find(row => row.branched).id);
    assert.notEqual(branchId, seedId);
    assert.equal(await branch.locator('[data-message-id]').count(), 2);
    const input = branch.getByRole('textbox', { name: '分支聊天输入', exact: true });
    await input.fill('给这段剧情接上下一幕');
    await button('发送消息').click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await input.fill('下一轮尚未发送的草稿');
    assert.equal(await branch.getByRole('button', { name: '停止这份回复', exact: true }).count() >= 1, true);
    assert.equal(await button('发送消息').count(), 0, '本分支生成时仍是停止按钮');
    await button('历史记录').click();
    await original.waitFor(); await settle(page);
    const returnScroll = await originalFeed.evaluate(node => node.scrollTop);
    assert.ok(Math.abs(returnScroll - oldScroll) < 3, `返回保留来源阅读位置：${oldScroll} → ${returnScroll}`);
    await page.evaluate(() => { emitGeneration('续聊后的最新AI回复'); finishGeneration('续聊后的最新AI回复'); });
    await page.waitForFunction(() => runtime.getStates().length === 0);
    await button('历史记录').click();
    const directory = panel.locator('.play-history-directory').filter({ visible: true });
    await directory.locator(`[data-chat-id="${branchId}"]`).waitFor();
    assert.equal(await directory.locator('.play-history-row').count(), 3, '当前角色两个对子与一个新分支都显示');
    assert.match(await directory.locator(`[data-chat-id="${branchId}"]`).innerText(), /续聊后的最新AI回复/);
    await screenshot(page, `chat-history-${viewport.width}.png`);
    if (viewport.width <= 760) await directory.getByRole('button', { name: '搜索历史记录', exact: true }).click();
    const search = directory.getByRole('searchbox', { name: '搜索历史记录', exact: true });
    await search.fill('给这段剧情接上下一幕');
    await page.waitForFunction(() => document.querySelectorAll('.play-history-row').length === 1);
    await directory.locator(`[data-chat-id="${branchId}"]`).click();
    await branch.locator('[data-message-id]').nth(3).waitFor();
    assert.equal(await input.inputValue(), '下一轮尚未发送的草稿');
    const oldAi = branch.locator('.play-assistant-message').first();
    assert.equal(await oldAi.locator('.play-count').count(), 0);
    assert.equal(await oldAi.getByRole('button', { name: '重新生成', exact: true }).count(), 0);
    await branch.getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    await branch.getByRole('button', { name: '收藏该聊天', exact: true }).click();
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    await branch.getByRole('button', { name: '取消收藏该聊天', exact: true }).waitFor();
    await screenshot(page, `branch-chat-${viewport.width}.png`);
    await button('我的收藏').click();
    await button('演出记录').click();
    if (viewport.width <= 760) await panel.locator('.tea-story').filter({ visible: true }).first().click();
    await panel.locator('.play-favorite-content').getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: '编辑演出记录收藏', exact: true }).filter({ visible: true }).count(), 0);
    await button('前往分支').click();
    await branch.getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    await button('历史记录').click();
    await panel.locator('.play-favorite-content').getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    if (viewport.width <= 760) await button('返回收藏目录').click();
    await button('剧场演出').click();
    await button('历史记录').click();
    await directory.locator(`[data-chat-id="${branchId}"]`).waitFor();
    await directory.locator(`[data-chat-id="${branchId}"]`).click();
    await branch.getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    await input.fill('重开后保留草稿');
    await button('关闭面板').click(); await panel.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    await branch.getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '重开后保留草稿');
    const latest = branch.locator('.play-assistant-message').last();
    await latest.getByRole('button', { name: '生成新版本', exact: true }).click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await page.evaluate(() => { emitGeneration('新版本二'); finishGeneration('新版本二'); });
    await page.waitForFunction(() => runtime.getStates().length === 0);
    await latest.getByText('新版本二', { exact: true }).waitFor();
    assert.equal(await latest.locator('.play-count').innerText(), '2/2');
    await latest.getByRole('button', { name: '上一个结果', exact: true }).click();
    await latest.getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    await latest.getByRole('button', { name: '收藏演出记录', exact: true }).click();
    await latest.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    await latest.getByRole('button', { name: '下一个结果', exact: true }).click();
    await latest.getByText('新版本二', { exact: true }).waitFor();
    const singleId = await page.evaluate(async () => (await runtime.listFavorites()).find(row => row.source.resultId).id);
    await button('我的收藏').click();
    await panel.locator(`.tea-story[data-id="${singleId}"]`).filter({ visible: true }).waitFor();
    await panel.locator(`.tea-story[data-id="${singleId}"]`).filter({ visible: true }).click();
    await panel.locator('.play-favorite-content').getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    await button('前往分支').click();
    await latest.getByText('新版本二', { exact: true }).waitFor();
    assert.equal(await latest.locator('.play-count').innerText(), '2/2', '单条收藏跳转保留当前版本');
    await latest.getByRole('button', { name: '续写', exact: true }).click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await page.evaluate(() => { emitGeneration('新版本二继续'); finishGeneration('新版本二继续'); });
    await page.waitForFunction(() => runtime.getStates().length === 0);
    await latest.getByText('新版本二继续', { exact: true }).waitFor();
    await latest.getByRole('button', { name: '重新生成', exact: true }).click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await page.evaluate(() => { emitGeneration('重新生成的正文'); finishGeneration('重新生成的正文'); });
    await page.waitForFunction(() => runtime.getStates().length === 0);
    await latest.getByText('重新生成的正文', { exact: true }).waitFor();
    assert.equal(await latest.locator('.play-count').innerText(), '1/1');
    const firstUser = branch.locator('.play-user-message').first();
    await firstUser.getByRole('button', { name: '修改用户消息', exact: true }).click();
    await firstUser.getByRole('textbox', { name: '用户消息原文', exact: true }).fill('较早的用户消息修改');
    await firstUser.getByRole('button', { name: '保存', exact: true }).click();
    await firstUser.getByText('较早的用户消息修改', { exact: true }).waitFor();
    await latest.getByText('重新生成的正文', { exact: true }).waitFor();
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    await branch.getByRole('button', { name: '删除', exact: true }).click();
    await branch.getByRole('button', { name: '从这里删除到最后', exact: true }).first().click();
    assert.equal(await branch.locator('.play-delete-selected').count(), 4);
    await branch.getByRole('button', { name: '确认删除', exact: true }).click();
    await branch.getByText('输入内容，开始这段剧情。', { exact: true }).waitFor();
    const emptyChat = await page.evaluate(id => runtime.getChat(id), branchId);
    assert.equal(emptyChat.messages.length, 0);
    await input.fill('清空后新的起始'); await button('发送消息').click();
    await page.waitForFunction(() => runtime.getStates().some(job => job.phase === 'generating'));
    await page.evaluate(() => { emitGeneration('清空后的AI回复'); finishGeneration('清空后的AI回复'); });
    await page.waitForFunction(() => runtime.getStates().length === 0);
    await branch.getByText('清空后的AI回复', { exact: true }).waitFor();
    await branch.getByRole('button', { name: '聊天操作', exact: true }).click();
    await branch.getByRole('button', { name: '删除该聊天', exact: true }).click();
    await panel.locator('.play-favorite-content').getByText('续聊后的最新AI回复', { exact: true }).waitFor();
    await assert.rejects(page.evaluate(id => runtime.getChat(id), branchId));
    if (viewport.width <= 760) await button('返回收藏目录').click();
    const wholeId = await page.evaluate(async () => (await runtime.listFavorites()).find(row => row.source.type === 'chat').id);
    await panel.locator(`.tea-story[data-id="${wholeId}"]`).filter({ visible: true }).click();
    await panel.locator('.play-favorite-content').getByText('清空后的AI回复', { exact: true }).waitFor();
    assert.equal(await button('前往分支').isDisabled(), true);
    await page.reload(); await page.waitForFunction(() => window.ready);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    assert.equal(await button('茶会选集').getAttribute('aria-pressed'), 'true', '刷新后默认茶会选集');
    await button('剧场演出').click();await button('历史记录').click();
    if (viewport.width <= 760) await directory.getByRole('button',{name:'搜索历史记录',exact:true}).click();
    const searchAgain=directory.getByRole('searchbox',{name:'搜索历史记录',exact:true});
    for(const term of ['默认隐藏的思考','默认隐藏状态','全局标记','乙的旧记录']){
        await searchAgain.fill(term);await directory.getByText('没有找到符合条件的聊天。',{exact:true}).waitFor();
    }
    await searchAgain.fill('全局已处理');await directory.locator(`[data-chat-id="${seedId}"]`).waitFor();
    assert.equal(await directory.locator('.play-history-row').count(),1);
    await directory.locator(`[data-chat-id="${seedId}"]`).click();
    await branch.locator('[data-message-id]').nth(1).waitFor();
    await input.fill('原对子自己的草稿');
    await button('设置').click();
    const settingsArea=panel.locator('.tea-settings').filter({visible:true});
    await settingsArea.getByRole('textbox',{name:'隐藏标签',exact:true}).fill('');
    await button(viewport.width<=760?'返回剧场演出':'设置').click();
    await branch.locator('iframe.play-web-output').contentFrame().getByText('状态卡：默认隐藏状态',{exact:false}).waitFor();
    assert.equal(await input.inputValue(),'原对子自己的草稿');
    await button('设置').click();
    await settingsArea.getByRole('textbox',{name:'隐藏标签',exact:true}).fill('think,thinking,update,status');
    await button(viewport.width<=760?'返回剧场演出':'设置').click();
    if(viewport.width<=760)await button('选择角色').click();
    await panel.locator('.play-people').filter({visible:true}).getByRole('button',{name:'测试乙',exact:true}).click();
    await directory.locator(`[data-chat-id="${await page.evaluate(()=>seed.b)}"]`).waitFor();
    assert.equal(await directory.locator('.play-history-row').count(),1);
    if(viewport.width<=760)await button('选择角色').click();
    await panel.locator('.play-people').filter({visible:true}).getByRole('button',{name:'测试甲',exact:true}).click();
    await directory.locator(`[data-chat-id="${seedId}"]`).click();
    assert.equal(await input.inputValue(),'原对子自己的草稿');
    const searchSamples=await page.evaluate(async()=>{
        const {playSearchText}=await import('/play-render.js');
        return [playSearchText('<!doctype html><html><head><style>.secret{display:none}</style></head><body><p>可搜索正文</p><p hidden>隐藏甲</p><p aria-hidden="true">隐藏乙</p><div style="display:none">隐藏丙</div><script>隐藏脚本</script></body></html>'),
            playSearchText('**加粗搜索词**\n\n```text\n完整代码内容\n```')];
    });
    assert.equal(searchSamples[0],'可搜索正文');assert.match(searchSamples[1],/加粗搜索词.*完整代码内容/);
    await oldAi.getByRole('button',{name:'创建分支',exact:true}).click();
    await branch.locator('[data-message-id]').nth(1).waitFor();
    assert.equal(await input.inputValue(),'','新分支不复制草稿');
    await button('历史记录').click();await directory.waitFor();

    const longId=await page.evaluate(async()=>{
        const original=await runtime.getChat(seed.a),branch=await runtime.createBranch(original.id,original.messages[1].id);
        for(let i=0;i<28;i++){
            const stamp=new Date().toISOString(),resultId=crypto.randomUUID();
            await testHistory.begin({roundId:branch.id,chatMode:true,operation:'send',character:ctx.characters[0],
                prompt:'长对话用户'+i,resultId,startedAt:stamp,context:original.messages[1].results[0].context});
            await testHistory.saveResult(branch.id,resultId,{text:'长对话AI'+i+'\n\n'+'正文段落。'.repeat(80),status:'complete',finishedAt:stamp});
        }
        ui.refresh();return branch.id;
    });
    await button('历史记录').click();await button('历史记录').click();
    await searchAgain.fill('');await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,200)));
    await directory.locator(`[data-chat-id="${longId}"]`).waitFor();
    const opened=Date.now();await directory.locator(`[data-chat-id="${longId}"]`).click();
    await branch.getByText(/长对话AI27/).waitFor();
    assert.ok(await branch.locator('[data-message-id]').count()<=24,'长对话初次只建立末尾24条消息');
    await settle(page);const longFeed=branch.locator('.play-chat-feed');
    assert.ok(await longFeed.evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop<4),'无阅读位置从最底部打开');
    await branch.getByRole('button',{name:'显示更早的消息',exact:true}).click();
    assert.equal(await branch.locator('[data-message-id]').count(),48);
    await longFeed.evaluate(node=>node.scrollTop=120);await settle(page);
    const scroll=await longFeed.evaluate(node=>{
        const top=node.getBoundingClientRect().top,anchor=[...node.querySelectorAll('[data-message-id]')].find(item=>item.getBoundingClientRect().bottom>top+1);
        return{id:anchor.dataset.messageId,offset:anchor.getBoundingClientRect().top-top};
    });
    await button('历史记录').click();await directory.locator(`[data-chat-id="${longId}"]`).click();
    await branch.locator('[data-message-id]').first().waitFor();await settle(page);
    const anchor=await longFeed.evaluate((node,id)=>node.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top-node.getBoundingClientRect().top,scroll.id);
    assert.ok(Math.abs(anchor-scroll.offset)<4,`恢复本次阅读位置 ${scroll.offset} → ${anchor}`);
    const firstFloor=branch.locator('.play-assistant-message').first(),firstFloorId=await firstFloor.getAttribute('data-message-id');
    await page.evaluate(async({id,messageId})=>{
        const chat=await runtime.getChat(id),message=chat.messages.find(message=>message.id===messageId);
        await runtime.editMessage(id,messageId,{text:'<div><p>高度变化前</p><button onclick="document.getElementById(\'more\').innerHTML=\'<p>增加的网页内容</p>\'.repeat(20)">展开网页</button><div id="more"></div></div>',expectedText:message.results[0].text,resultId:message.selectedResultId});
    },{id:longId,messageId:firstFloorId});
    await button('历史记录').click();await directory.locator(`[data-chat-id="${longId}"]`).click();
    await settle(page);
    const frame=branch.locator('iframe.play-web-output').first();await frame.waitFor();
    await longFeed.evaluate((node,id)=>{node.scrollTop+=node.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top-node.getBoundingClientRect().top;},firstFloorId);await settle(page);
    await frame.contentFrame().getByRole('button',{name:'展开网页',exact:true}).waitFor();
    await page.waitForFunction(()=>parseFloat(document.querySelector('.play-branch-page iframe.play-web-output')?.style.height)>0);
    await longFeed.evaluate((node,id)=>{node.scrollTop+=node.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top-node.getBoundingClientRect().top;},firstFloorId);await settle(page);
    const oldHeight=await frame.evaluate(node=>parseFloat(node.style.height));
    const beforeHeightChange=await longFeed.evaluate((node,id)=>node.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top-node.getBoundingClientRect().top,firstFloorId);
    await frame.contentFrame().getByRole('button',{name:'展开网页',exact:true}).evaluate(node=>node.click());
    await page.waitForFunction(height=>parseFloat(document.querySelector('.play-branch-page iframe.play-web-output')?.style.height)>height+100,oldHeight);
    await settle(page);
    const afterHeightChange=await longFeed.evaluate((node,id)=>node.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top-node.getBoundingClientRect().top,firstFloorId);
    assert.ok(Math.abs(afterHeightChange-beforeHeightChange)<4,`网页高度变化保持消息位置 ${beforeHeightChange} → ${afterHeightChange}`);
    await branch.getByRole('button',{name:'聊天操作',exact:true}).click();
    await branch.getByRole('button',{name:'收藏该聊天',exact:true}).click();
    await button('我的收藏').click();await button('演出记录').click();
    const longFavorite=await page.evaluate(async id=>(await runtime.listFavorites()).find(row=>row.source.chatId===id).id,longId);
    if(viewport.width<=760)await panel.locator(`.tea-story[data-id="${longFavorite}"]`).click();
    await panel.locator('.play-favorite-content').getByRole('button',{name:'显示更多聊天内容',exact:true}).waitFor();
    assert.equal(await panel.locator('.play-favorite-content > .play-message').count(),24);
    await panel.locator('.play-favorite-content').getByRole('button',{name:'显示更多聊天内容',exact:true}).click();
    assert.equal(await panel.locator('.play-favorite-content > .play-message').count(),48);
    console.log(JSON.stringify({viewport,additional:'hidden/regex search, character scope, drafts, branch return, long transcript, lazy favorites',openAndChecksMs:Date.now()-opened}));
    await button('前往分支').click();
    await branch.locator('[data-message-id]').first().waitFor();
    await input.fill('本分支保存失败检查');await button('发送消息').click();
    await page.waitForFunction(()=>runtime.getStates().some(job=>job.phase==='generating'));
    await page.evaluate(()=>{window.failSave=true;emitGeneration('保存失败仍保留的正文');finishGeneration('保存失败仍保留的正文');});
    await branch.getByRole('button',{name:'重试保存',exact:true}).waitFor();
    assert.equal(await button('发送消息').count(),0,'保存失败时本分支不接受新发送');
    await page.evaluate(()=>window.failSave=false);await branch.getByRole('button',{name:'重试保存',exact:true}).click();
    await page.waitForFunction(()=>runtime.getStates().length===0);
    await branch.getByText('保存失败仍保留的正文',{exact:true}).waitFor();
    await page.evaluate(async id=>{
        const chat=await runtime.getChat(id),stamp=new Date().toISOString(),resultId=crypto.randomUUID();
        await testHistory.begin({roundId:id,chatMode:true,operation:'send',character:ctx.characters[0],prompt:'刷新中断',
            resultId,startedAt:stamp,context:chat.messages.at(-1).results[0].context});
        await testHistory.saveResult(id,resultId,{text:'已保存中断片段',status:'unfinished',finishedAt:null});
    },longId);
    await page.reload();await page.waitForFunction(()=>window.ready);
    await page.getByRole('button',{name:'打开小剧场面板',exact:true}).click();
    await button('剧场演出').click();await button('历史记录').click();
    await directory.locator(`[data-chat-id="${longId}"]`).click();
    await branch.getByRole('button',{name:'结束未完成回复',exact:true}).click();
    await branch.getByText('已保存中断片段',{exact:true}).waitFor();
    await branch.getByRole('button',{name:'结束未完成回复',exact:true}).waitFor({state:'detached'});
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), '无横向溢出');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport, passed: true, checks: 'branch, followup, stop, history, search, favorite, return, reopen, responsive', errors }));
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
            const context = await browser.newContext({ viewport });
            await verify(await context.newPage(), url, viewport); await context.close();
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
