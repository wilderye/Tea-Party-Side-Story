// ST 1.14 exposes only a sender that reads global settings. Keep its request
// mapping here so both old and new hosts can use the captured request settings.
export function playStoppingStrings(power, substitute, limit) {
    let strings;
    try { strings = JSON.parse(power.custom_stopping_strings || '[]'); } catch { return []; }
    if (!Array.isArray(strings)) return [];
    strings = strings.filter(value => typeof value === 'string' && value.length);
    if (power.custom_stopping_strings_macro) strings = strings.map(substitute);
    return limit > 0 ? strings.slice(0, limit) : strings;
}

export function legacyPlayParameters(settings, model, messages, { power, name1, name2, modern = false, type = 'normal' }, substitute) {
    const source = settings.chat_completion_source;
    const isOpenAI = ['openai', 'azure_openai'].includes(source);
    const stop = limit => playStoppingStrings(power, substitute, limit);
    let effort = settings.reasoning_effort;
    if (['openai', 'azure_openai', 'custom', 'xai', 'aimlapi', 'openrouter', 'pollinations', 'perplexity', 'cometapi', 'electronhub'].includes(source)) {
        if (effort === 'auto') effort = undefined;
        if (effort === 'min' && !(isOpenAI && /^gpt-5/.test(model))) effort = 'low';
        if (effort === 'max') effort = 'high';
    }
    const payload = { type, messages, model, chat_completion_source: source,
        stream: !!settings.stream_openai && !(isOpenAI && ['o1', 'o1-2024-12-17'].includes(model)),
        temperature: Number(settings.temp_openai), frequency_penalty: Number(settings.freq_pen_openai),
        presence_penalty: Number(settings.pres_pen_openai), top_p: Number(settings.top_p_openai),
        max_tokens: settings.openai_max_tokens, logit_bias: undefined, stop: stop(4), user_name: name1, char_name: name2, group_names: [],
        include_reasoning: !!settings.show_thoughts, reasoning_effort: effort,
        enable_web_search: !!settings.enable_web_search, request_images: !!settings.request_images,
        custom_prompt_post_processing: settings.custom_prompt_post_processing,
    };
    const copy = (...keys) => { for (const key of keys) payload[key] = settings[key]; };
    const remove = (...keys) => { for (const key of keys) delete payload[key]; };
    if (source === 'azure_openai') {
        copy('azure_base_url', 'azure_deployment_name', 'azure_api_version');
        if (/^gpt-[34]/.test(model)) remove('reasoning_effort');
    }
    if (settings.reverse_proxy && ['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', ...(modern ? ['zai', 'moonshot'] : [])].includes(source)) copy('reverse_proxy', 'proxy_password');
    if (power.request_token_probabilities && ['openai', 'azure_openai', 'custom', 'deepseek', 'xai', 'aimlapi', ...(modern ? ['openrouter', 'chutes'] : [])].includes(source)) payload.logprobs = 5;
    if (['openai', 'azure_openai', 'openrouter'].includes(source)) {
        if (model.includes('gpt') && model.includes('vision')) remove('logit_bias', 'stop', 'logprobs');
        if (model.includes('gpt-4.5')) remove('logprobs');
    }
    if (['claude', 'openrouter', 'makersuite', 'vertexai', 'cohere', 'perplexity', 'electronhub'].includes(source)) payload.top_k = Number(settings.top_k_openai);
    if (source === 'claude') {
        copy('claude_use_sysprompt'); payload.stop = stop();
        if (type !== 'continue' || !settings.continue_prefill) payload.assistant_prefill = substitute(settings.assistant_prefill || '');
    }
    if (source === 'openrouter') {
        Object.assign(payload, { min_p: Number(settings.min_p_openai), repetition_penalty: Number(settings.repetition_penalty_openai),
            top_a: Number(settings.top_a_openai), use_fallback: settings.openrouter_use_fallback, provider: settings.openrouter_providers,
            allow_fallbacks: settings.openrouter_allow_fallbacks, middleout: settings.openrouter_middleout });
    }
    if (['makersuite', 'vertexai'].includes(source)) {
        payload.stop = stop(5).filter(value => value.length <= 16); copy('use_makersuite_sysprompt');
        if (source === 'vertexai') copy('vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id');
    }
    if (source === 'mistralai') { payload.safe_prompt = false; payload.stop = stop(); }
    if (source === 'custom') copy('custom_url', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers');
    if (source === 'cohere') {
        payload.top_p = Math.min(Math.max(payload.top_p, 0.01), 0.99);
        payload.frequency_penalty = Math.min(Math.max(payload.frequency_penalty, 0), 1);
        payload.presence_penalty = Math.min(Math.max(payload.presence_penalty, 0), 1); payload.stop = stop(5);
    }
    if (source === 'perplexity') remove('stop');
    if (source === 'groq') remove('logprobs', 'logit_bias', 'top_logprobs');
    if (source === 'deepseek') payload.top_p ||= Number.EPSILON;
    if (source === 'xai') {
        if (model.includes('grok-3-mini')) remove('presence_penalty', 'frequency_penalty', 'stop');
        else remove('reasoning_effort');
        if (model.includes('grok-4') || model.includes('grok-code')) {
            remove('presence_penalty', 'frequency_penalty');
            if (!model.includes('grok-4-fast-non-reasoning')) remove('stop');
        }
    }
    if (source === 'pollinations') remove('max_tokens');
    if (source === 'zai') {
        payload.top_p ||= 0.01; payload.stop = stop(1); payload.zai_endpoint = settings.zai_endpoint || 'common';
        remove('presence_penalty', 'frequency_penalty');
    }
    if (settings.seed >= 0 && ['openai', 'azure_openai', 'openrouter', 'mistralai', 'custom', 'cohere', 'groq', 'electronhub', 'nanogpt', 'xai', 'pollinations', 'aimlapi', 'vertexai', 'makersuite'].includes(source)) payload.seed = settings.seed;
    if (isOpenAI && /^(o1|o3|o4|gpt-5)/.test(model)) {
        payload.max_completion_tokens = payload.max_tokens; remove('max_tokens', 'logprobs', 'top_logprobs');
        if (/^(o1|o3|o4)/.test(model) || (!model.includes('gpt-5-chat-latest') && !(model.includes('gpt-5.1') && !model.includes('chat-latest')))) remove('temperature', 'top_p');
        if (!model.includes('gpt-5-chat-latest')) remove('frequency_penalty', 'presence_penalty', 'logit_bias', 'stop');
        if (model.startsWith('o1')) payload.messages = messages.map(message => message.role === 'system' ? { ...message, role: 'user' } : message);
    }
    if (!payload.stop?.length) remove('stop');
    return payload;
}
