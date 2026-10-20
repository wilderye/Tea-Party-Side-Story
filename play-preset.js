function requestMessages(context, modules, tavern, signal) {
    const { Message } = modules.openai;
    const cache = new Map();
    const count = async value => {
        if (!tavern.tokenizerModel) return modules.openai.promptManager.tokenHandler.countAsync(value);
        const key = JSON.stringify([value]);
        if (!cache.has(key)) cache.set(key, (async () => {
            const response = await fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(tavern.tokenizerModel)}`, {
                method: 'POST', headers: context.getRequestHeaders(), body: key,
                signal: signal ?? AbortSignal.timeout(60_000),
            });
            if (!response.ok) throw new Error('无法计算本次提示词长度');
            const data = await response.json();
            return Number(data.token_count) + (tavern.tokenCountOffset ?? 0) - (tavern.tokenizerModel === 'claude' ? 0 : 2);
        })());
        return cache.get(key);
    };
    const create = async (role, content, id) => {
        const message = await Message.createAsync(role, undefined, id);
        message.content = content;
        if (typeof content === 'string' && content.length) message.tokens = await count({ role: message.role, content });
        message.setName = async name => { message.name = name; message.tokens = await count({ role: message.role, content: message.content, name }); };
        message.setToolCalls = async (invocations, includeSignature, includeReasoning = false) => {
            message.tool_calls = invocations.map(item => ({ id: item.id, type: 'function',
                function: { arguments: item.parameters, name: item.name }, ...(includeSignature && item.signature ? { signature: item.signature } : {}) }));
            message.reasoning = includeReasoning ? invocations.find(item => item.reasoning)?.reasoning ?? null : null;
            message.tokens = await count({ role: message.role, tool_calls: JSON.stringify(message.tool_calls), ...(message.reasoning ? { reasoning: message.reasoning } : {}) });
        };
        if (modules.utils?.createThumbnail) message.compressImage = async image => {
            const mime = image.split(';')[0].split(':')[1];
            if (['openrouter', 'makersuite', 'mistralai', 'vertexai'].includes(tavern.settings.chat_completion_source) && image.length * 0.75 > 2 * 1024 * 1024) return modules.utils.createThumbnail(image, 2048, 2048);
            return ['image/jpeg', 'image/png', 'image/webp'].includes(mime) ? image : modules.utils.createThumbnail(image, null, null);
        };
        const addImage = message.addImage?.bind(message);
        if (addImage) message.addImage = async image => {
            const tokens = message.tokens, length = Array.isArray(message.content) ? message.content.length : 0;
            await addImage(image);
            const block = Array.isArray(message.content) && message.content.length > length ? message.content.at(-1) : null;
            if (!block?.image_url) return;
            const quality = tavern.settings.inline_image_quality || 'low';
            block.image_url.detail = quality;
            try { message.tokens = tokens + await message.getImageTokenCost(block.image_url.url, quality); }
            catch { message.tokens = tokens + Message.tokensPerImage; }
        };
        return message;
    };
    return { create, count, fromPrompt: prompt => create(prompt.role, prompt.content, prompt.identifier) };
}

/** A request-local preset assembly. ST's prepareOpenAIMessages reads its global
 * settings throughout several awaits; using it would mix two presets if the
 * user switches while a request is preparing. Reuse ST's PromptManager methods,
 * Message and ChatCompletion objects with our captured settings instead.
 * This path assembles normal and continue requests for a single character.
 */
export async function preparePlayPreset(context, modules, environment, options) {
    const { openai, core, persona, constants } = modules;
    const { settings, power, name1, name2, model } = environment.tavern;
    const { MessageCollection, ChatCompletion } = openai;
    const messages = requestMessages(context, modules, environment.tavern, options.signal);
    const manager = Object.assign(Object.create(openai.promptManager), {
        serviceSettings: settings, activeCharacter: structuredClone(openai.promptManager.activeCharacter),
    });
    const substitute = (text, original) => core.substituteParams(text || '', name1, name2, original, undefined, true, { model });
    // Only this object uses the snapshot. The host's prompt manager keeps its
    // live settings and remains available to the settings UI and other requests.
    const preparePrompt = manager.preparePrompt.bind(manager);
    manager.preparePrompt = (prompt, original) => {
        const prepared = preparePrompt({ ...prompt, content: '' });
        prepared.content = substitute(prompt.content, original);
        return prepared;
    };
    const prompts = manager.getPromptCollection(options.type ?? 'normal');
    const extensions = Object.fromEntries(Object.entries(options.extensionPrompts).map(([key, value]) => [key, { ...value }]));
    const wi = text => text && settings.wi_format?.trim() ? settings.wi_format.replace(/\{0\}/g, () => text) : text || '';
    const builtins = [
        ['worldInfoBefore', wi(options.worldInfoBefore)], ['worldInfoAfter', wi(options.worldInfoAfter)],
        ['charDescription', options.charDescription],
        ['charPersonality', options.charPersonality && settings.personality_format ? substitute(settings.personality_format) : options.charPersonality],
        ['scenario', options.scenario && settings.scenario_format ? substitute(settings.scenario_format) : options.scenario],
        ['bias', options.bias, 'assistant'],
    ].map(([identifier, content, role = 'system']) => ({ identifier, content, role }));
    if (power.persona_description && power.persona_description_position === persona.persona_description_positions.IN_PROMPT) {
        builtins.push({ identifier: 'personaDescription', role: 'system', content: power.persona_description });
    }
    const known = { '1_memory': 'summary', '2_floating_prompt': 'authorsNote', '3_vectors': 'vectorsMemory',
        '4_vectors_data_bank': 'vectorsDataBank', chromadb: 'smartContext' };
    const reserved = new Set([...Object.keys(known), 'PERSONA_DESCRIPTION', 'QUIET_PROMPT', 'DEPTH_PROMPT']);
    for (const [key, prompt] of Object.entries(extensions)) {
        if (!prompt.value || (prompt.filter && !await prompt.filter())) { delete extensions[key]; continue; }
        const position = openai.getPromptPosition(prompt.position);
        if (!known[key] && (reserved.has(key) || !position)) continue;
        builtins.push({ identifier: known[key] ?? key.replace(/\W/g, '_'), role: openai.getPromptRole(prompt.role),
            content: prompt.value, position, extension: !known[key] });
    }
    for (const builtin of builtins) {
        const original = prompts.get(builtin.identifier);
        if (original) for (const key of ['injection_position', 'injection_depth', 'injection_order', 'role']) {
            if (original[key] !== undefined) builtin[key] = original[key];
        }
        const prepared = manager.preparePrompt(builtin), index = prompts.index(builtin.identifier);
        if (index >= 0) prompts.collection[index] = prepared;
        else prompts.add(prepared);
    }
    for (const [id, content] of [['main', options.systemPromptOverride], ['jailbreak', options.jailbreakPromptOverride]]) {
        const prompt = prompts.get(id);
        if (content && prompt && !prompt.forbid_overrides && !manager.isPromptDisabledForActiveCharacter(id)) {
            prompts.override(manager.preparePrompt({ ...prompt, content }, prompt.content), prompts.index(id));
        }
    }

    const completion = new ChatCompletion();
    completion.setTokenBudget(settings.openai_max_context, settings.openai_max_tokens);
    completion.reserveBudget(3);
    if (options.leadingSystemPrompt) {
        completion.reserveBudget(await messages.create('system', options.leadingSystemPrompt, 'teahouseLeadingPrompt'));
    }
    completion.setOverriddenPrompts(prompts.overriddenPrompts);
    const absolute = prompts.collection.filter(prompt => prompt.injection_position === 1);
    const add = async id => {
        const prompt = prompts.get(id);
        if (!prompt || prompt.injection_position === 1 || (id !== 'main' && manager.isPromptDisabledForActiveCharacter(id))) return;
        const collection = new MessageCollection(id);
        collection.add(await messages.fromPrompt(prompt)); completion.add(collection, prompts.index(id));
    };
    for (const id of ['worldInfoBefore', 'main', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription',
        'nsfw', 'jailbreak', ...prompts.collection.filter(prompt => prompt.system_prompt === false && prompt.injection_position !== 1).map(prompt => prompt.identifier),
        'enhanceDefinitions', ...(options.bias?.trim() ? ['bias'] : [])]) await add(id);
    for (const prompt of prompts.collection.filter(prompt => prompt.position && (prompt.extension || Object.values(known).includes(prompt.identifier)))) {
        if (completion.has('main')) completion.insert(await messages.fromPrompt(prompt), 'main', prompt.position);
        else {
            const index = absolute.findIndex(item => item.identifier === 'main');
            if (index >= 0) {
                const main = absolute[index];
                absolute.splice(prompt.position === 'end' ? index + 1 : index, 0,
                    { ...prompt, role: main.role, injection_position: 1, injection_depth: main.injection_depth, injection_order: main.injection_order });
            }
        }
    }
    if (options.toolsData?.tools?.length) completion.reserveBudget(await messages.count({ role: 'user', content: JSON.stringify(options.toolsData) }));

    // Newest first, as expected by ST's depth rule. Only the captured messages
    // are formatted; plugin history is never appended to this conversation.
    const history = options.history.filter(message => !message.extra?.[constants.IGNORE_SYMBOL]).map(message => {
        const narrator = message.extra?.type === 'narrator';
        const role = narrator ? 'system' : message.is_user ? 'user' : 'assistant';
        let content = message.mes.replace(/\r/g, '');
        if (!narrator && (settings.names_behavior === 2 || (settings.names_behavior === 0 && message.force_avatar && message.name !== name1))) content = `${message.name}: ${content}`;
        if (role === 'user' && environment.tavern.wrapUserMessages) content = `"${content}"`;
        const sameModel = message.extra?.api === settings.chat_completion_source && message.extra?.model === model;
        return { ...message, role, content, sameModel };
    }).reverse();
    let continueCollection = null;
    const depths = new Set(absolute.map(prompt => Number(prompt.injection_depth)));
    for (const prompt of Object.values(extensions)) if (prompt.position === core.extension_prompt_types.IN_CHAT) depths.add(Number(prompt.depth));
    let inserted = 0;
    for (const depth of [...depths].filter(value => Number.isInteger(value) && value >= 0).sort((a, b) => a - b)) {
        const atDepth = absolute.filter(prompt => Number(prompt.injection_depth) === depth && prompt.content);
        const orders = [...new Set([100, ...atDepth.map(prompt => prompt.injection_order ?? 100)])].sort((a, b) => b - a);
        const injections = [];
        for (const order of orders) for (const role of ['system', 'user', 'assistant']) {
            const parts = atDepth.filter(prompt => (prompt.injection_order ?? 100) === order && prompt.role === role).map(prompt => prompt.content);
            if (order === 100) {
                parts.push(...Object.keys(extensions).sort().filter(key => {
                    const prompt = extensions[key];
                    return prompt.position === core.extension_prompt_types.IN_CHAT && Number(prompt.depth) === depth && openai.getPromptRole(prompt.role) === role;
                }).map(key => substitute(extensions[key].value).trim()));
            }
            const content = parts.filter(Boolean).map(text => text.trim()).join('\n');
            if (content) injections.push({ role, content, injected: true });
        }
        history.splice(depth + inserted, 0, ...injections); inserted += injections.length;
    }
    history.reverse();
    async function addHistory() {
        if (!prompts.has('chatHistory')) return;
        completion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));
        const header = await messages.create('system', substitute(settings.new_chat_prompt), 'newMainChat');
        completion.reserveBudget(header);
        // Theatre continuations always use a nudge, independent of Tavern's prefill setting.
        if (options.type === 'continue' && options.cyclePrompt) {
            const lastIndex = history.findLastIndex(prompt => !prompt.injected);
            continueCollection = new MessageCollection('continueNudge');
            if (lastIndex >= 0) {
                const target = history.splice(lastIndex, 1)[0];
                continueCollection.add(await messages.create(target.role, substitute(target.content), 'continueAssistant'));
            }
            const rawNudge = settings.continue_nudge_prompt?.trim()
                ? settings.continue_nudge_prompt : '[Continue your last message without repeating its original content.]';
            const nudgeContent = substitute(rawNudge.replace(/\{\{lastChatMessage\}\}/gi, () => options.cyclePrompt.trim()));
            const continueNudgeMessage = await messages.create('system', nudgeContent, 'continueNudge');
            continueCollection.add(continueNudgeMessage);
            completion.reserveBudget(continueCollection);
        }
        if (history.at(-1)?.role === 'assistant' && settings.send_if_empty) {
            const replacement = await messages.create('user', settings.send_if_empty, 'emptyUserMessageReplacement');
            if (completion.canAfford(replacement)) completion.insert(replacement, 'chatHistory');
        }
        for (const [index, prompt] of [...history].reverse().entries()) {
            const message = await messages.create(prompt.role, substitute(prompt.content), `chatHistory-${history.length - index}`);
            if (settings.names_behavior === 1 && prompt.name) await message.setName(manager.sanitizeName(prompt.name));
            const media = prompt.extra?.media ?? [];
            const selectedMedia = core.getMediaDisplay?.(prompt) === constants.MEDIA_DISPLAY?.LIST ? media : [media[core.getMediaIndex?.(prompt) ?? 0]];
            for (const attachment of selectedMedia.filter(Boolean)) {
                if ((!attachment.type || attachment.type === 'image') && (environment.tavern.imageInlining ?? settings.image_inlining)) await message.addImage(attachment.url);
                else if (attachment.type === 'video' && environment.tavern.videoInlining) await message.addVideo?.(attachment.url);
                else if (attachment.type === 'audio' && environment.tavern.audioInlining) await message.addAudio?.(attachment.url);
            }
            if ((environment.tavern.canUseTools ?? settings.function_calling) && Array.isArray(prompt.extra?.tool_invocations)) {
                const invocations = structuredClone(prompt.extra.tool_invocations);
                const call = await messages.create(prompt.role, undefined, `toolCall-${message.identifier}`);
                await call.setToolCalls(invocations, environment.tavern.reasoningSignatureSupported && prompt.sameModel, false);
                const results = await Promise.all(invocations.map(invocation => messages.create('tool', invocation.result || '[No content]', invocation.id)));
                if (!completion.canAffordAll([call, ...results])) break;
                for (const result of results.reverse()) completion.insertAtStart(result, 'chatHistory');
                completion.insertAtStart(call, 'chatHistory');
            } else {
                if (environment.tavern.reasoningSignatureSupported && prompt.sameModel && prompt.extra?.reasoning_signature) message.signature = prompt.extra.reasoning_signature;
                if (!completion.canAfford(message)) break;
                completion.insertAtStart(message, 'chatHistory');
            }
        }
        completion.freeBudget(header); completion.insertAtStart(header, 'chatHistory');
    }
    async function addExamples() {
        if (!prompts.has('dialogueExamples')) return;
        completion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));
        const header = await messages.create('system', substitute(settings.new_example_chat_prompt), 'newChat');
        for (const [index, dialogue] of options.messageExamples.entries()) {
            const dialogueMessages = [];
            for (const [offset, prompt] of dialogue.entries()) {
                const message = await messages.create('system', prompt.content || '', `dialogueExamples ${index}-${offset}`);
                await message.setName(prompt.name); dialogueMessages.push(message);
            }
            if (!completion.canAffordAll([header, ...dialogueMessages])) break;
            completion.insert(header, 'dialogueExamples');
            for (const message of dialogueMessages) completion.insert(message, 'dialogueExamples');
        }
    }
    if (power.pin_examples) { await addExamples(); await addHistory(); }
    else { await addHistory(); await addExamples(); }
    if (continueCollection) {
        completion.freeBudget(continueCollection);
        completion.add(continueCollection, -1);
    }
    if (settings.squash_system_messages) await completion.squashSystemMessages();
    const chat = completion.getChat();
    await context.eventSource.emit(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, { chat, dryRun: false });
    return [chat];
}
