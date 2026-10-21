import { element, iconButton, textButton } from './ui.js';
import { readPlaySettings, readPlayPromptSettings, readPlayContinuationSettings, playContinuationError } from './play-settings.js';
import { fetchCustomApiModels } from './play-request.js';

export function createPlayApiSettings(ctx, settings, saveSettings, diagnostics) {
    const api = settings.playApi ??= { mode: 'tavern' };
    const section = element('section', undefined, 'play-api-settings');
    const row = element('label', undefined, 'tea-setting-row'), description = element('span');
    description.append(element('strong', '生成使用的 API'), element('small', '两种方式都复用酒馆当前预设。'));
    const mode = element('select'); mode.setAttribute('aria-label', '生成使用的 API');
    for (const [value, text] of [['tavern', '酒馆当前 API'], ['custom', '插件独立 API']]) {
        const option = element('option', text); option.value = value; mode.append(option);
    }
    mode.value = api.mode; row.append(description, mode); section.append(row);
    const fields = element('div', undefined, 'play-api-fields'); fields.hidden = api.mode !== 'custom';
    fields.append(element('p', '支持 OpenAI 兼容接口。填写地址和密钥后，拉取并选择模型。', 'tea-setting-description'));
    let models = [], request = null;
    for (const [key, name, type, placeholder] of [['url', '接口地址', 'url', 'https://api.example.com/v1'], ['key', 'API 密钥', 'password', '填写密钥（无密钥的接口可留空）']]) {
        const label = element('label', name, 'tea-field'), input = element('input');
        input.type = type; input.value = api[key] ?? ''; input.placeholder = placeholder; input.spellcheck = false;
        input.autocomplete = key === 'key' ? 'new-password' : 'off'; input.setAttribute('aria-label', name);
        input.addEventListener('input', () => {
            const value = input.value.trim();
            if (value === (api[key] ?? '')) return;
            api[key] = value; api.model = ''; models = []; cancel();
            status.textContent = ''; update(); saveSettings();
        });
        label.append(input); fields.append(label);
    }
    const modelRow = element('div', undefined, 'play-api-model-row');
    const label = element('label', '模型', 'tea-field'), select = element('select');
    select.setAttribute('aria-label', '模型'); label.append(select);
    const refresh = textButton('拉取模型', () => void load()); refresh.className = 'play-api-model-refresh';
    refresh.setAttribute('aria-label', '拉取模型');
    modelRow.append(label, refresh);
    const status = element('p', '', 'tea-setting-description play-api-model-status'); status.setAttribute('role', 'status');
    fields.append(modelRow, status); section.append(fields);
    select.addEventListener('change', () => { api.model = select.value; saveSettings(); });
    mode.addEventListener('change', () => {
        api.mode = mode.value; fields.hidden = api.mode !== 'custom';
        if (fields.hidden) cancel();
        saveSettings();
    });

    function update() {
        const values = api.model && !models.includes(api.model) ? [api.model, ...models] : models;
        const placeholder = element('option', values.length ? '请选择模型' : '请先拉取模型');
        placeholder.value = ''; placeholder.disabled = true; select.replaceChildren(placeholder);
        for (const value of values) {
            const option = element('option', value); option.value = value; select.append(option);
        }
        select.value = api.model || ''; select.disabled = !!request || !values.length;
        refresh.disabled = !!request || !api.url;
        refresh.textContent = request ? '拉取中…' : '拉取模型'; refresh.setAttribute('aria-busy', String(!!request));
        status.hidden = !status.textContent;
    }
    function cancel() {
        if (!request) return;
        request.abort(); request = null; status.textContent = ''; update();
    }
    async function load() {
        if (request) return;
        const controller = request = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('拉取模型超时，请重试。')), 30000);
        status.textContent = '正在拉取模型…'; update();
        diagnostics?.info('开始拉取独立 API 模型');
        try {
            const result = await fetchCustomApiModels(ctx(), api, controller.signal);
            if (request !== controller) return;
            models = result;
            const removed = api.model && !models.includes(api.model);
            if (removed) { api.model = ''; saveSettings(); }
            status.textContent = !models.length ? '接口未返回可选模型。'
                : removed ? '原模型不在本次列表中，请重新选择。' : `已拉取 ${models.length} 个模型。`;
            diagnostics?.info('独立 API 模型拉取完成', { count: models.length });
        } catch (error) {
            if (request !== controller) return;
            status.textContent = error.code === 'invalid_api_url' ? error.message : '拉取模型失败，请检查接口地址和密钥后重试。';
            diagnostics?.error('拉取独立 API 模型', error, {}, [api.key]);
        } finally {
            clearTimeout(timeout);
            if (request === controller) { request = null; update(); }
        }
    }
    update();
    return { node: section, cancel };
}

function textSetting(area, settings, saveSettings, key, name, value, note) {
    const field = element('label', name, 'tea-field');
    const input = element('textarea'); input.rows = 3; input.value = value; input.spellcheck = false;
    input.setAttribute('aria-label', name);
    input.addEventListener('input', () => { settings[key] = input.value; saveSettings(); });
    field.append(input, element('small', note, 'tea-setting-description')); area.append(field);
    return input;
}

export function renderPlayPromptSetting(area, settings, saveSettings) {
    const section = element('section', undefined, 'play-prompt-settings');
    const heading = element('div', undefined, 'play-prompt-heading');
    const add = iconButton('plus', '新增提示词', () => openDialog('add'));
    heading.append(element('strong', '自定义小剧场提示词'), add);
    const controls = element('div', undefined, 'play-prompt-controls'), select = element('select');
    select.setAttribute('aria-label', '自定义小剧场提示词');
    const selected = () => {
        const config = readPlayPromptSettings(settings);
        return config.presets.find(preset => preset.id === config.selectedId);
    };
    const rename = iconButton('edit', '修改提示词名称', () => openDialog('rename', selected()));
    controls.append(select, rename);
    const contentField = element('label', '提示词内容', 'tea-field play-prompt-content-field'), content = element('textarea');
    content.rows = 3; content.spellcheck = false; content.setAttribute('aria-label', '小剧场提示词内容');
    content.placeholder = '填写要发送给 AI 的提示词。'; contentField.append(content);
    const note = element('div', undefined, 'play-prompt-note');
    const remove = textButton('删除提示词', () => openDialog('delete', selected())); remove.className = 'play-prompt-delete';
    note.append(element('small', '内容修改后自动保存；留空时不添加。', 'tea-setting-description'), remove);
    const positionField = element('label', undefined, 'tea-setting-row play-prompt-position'), position = element('select');
    positionField.append(element('strong', '提示词插入位置'));
    position.setAttribute('aria-label', '提示词插入位置');
    for (const [value, name] of [['start', '全部提示词前'], ['user-before', '最新用户消息前'], ['user-after', '最新用户消息后']]) {
        const option = element('option', name); option.value = value; position.append(option);
    }
    positionField.append(position);
    const description = element('p', '', 'tea-setting-description');
    section.append(heading, controls, contentField, note, positionField, description); area.append(section);

    function save(config) {
        settings.playPromptConfig = config;
        // The old textarea value is migrated once; only the presets remain authoritative.
        delete settings.playPrompt;
        saveSettings();
    }
    function resizeContent() {
        const scrollTop = content.scrollTop;
        content.style.height = 'auto'; content.style.height = `${content.scrollHeight}px`;
        content.scrollTop = scrollTop;
    }
    function update() {
        const config = readPlayPromptSettings(settings);
        select.replaceChildren();
        for (const preset of config.presets) {
            const option = element('option', preset.name); option.value = preset.id; select.append(option);
        }
        select.value = config.selectedId; position.value = config.position;
        content.value = selected().content; resizeContent(); requestAnimationFrame(resizeContent);
        remove.hidden = ['default', 'recommended'].includes(config.selectedId);
        description.textContent = config.position === 'start'
            ? '将上面的内容放在发给 AI 的全部提示词最前面。'
            : config.position === 'user-before'
                ? '在本次小剧场用户消息中，先放上面的内容，空一行，再放你输入的小剧场。'
                : '在本次小剧场用户消息中，先放你输入的小剧场，空一行，再放上面的内容。';
    }
    select.addEventListener('change', () => { save({ ...readPlayPromptSettings(settings), selectedId: select.value }); update(); });
    position.addEventListener('change', () => { save({ ...readPlayPromptSettings(settings), position: position.value }); update(); });
    content.addEventListener('input', () => {
        const config = readPlayPromptSettings(settings);
        save({ ...config, presets: config.presets.map(preset => preset.id === config.selectedId ? { ...preset, content: content.value } : preset) });
        resizeContent();
    });

    function openDialog(mode, preset) {
        const adding = mode === 'add', deleting = mode === 'delete';
        const title = adding ? '新增提示词' : deleting ? '删除提示词' : '修改名称';
        const dialog = element('dialog', undefined, `play-prompt-editor${adding ? '' : ' play-prompt-compact'}`);
        if (mode === 'rename') dialog.classList.add('play-prompt-rename');
        dialog.setAttribute('aria-label', title);
        const form = element('form', undefined, 'play-prompt-editor-form');
        form.noValidate = true;
        const header = element('header', undefined, 'play-prompt-editor-header');
        const close = () => dialog.close();
        header.append(element('h3', title), iconButton('close', '关闭提示词弹窗', close));
        const fields = element('div', undefined, 'play-prompt-editor-fields');
        const nameField = element('label', adding ? '小剧场提示词名称' : undefined, 'tea-field'), name = element('input');
        name.type = 'text'; name.value = preset?.name ?? ''; name.required = true; name.maxLength = 100;
        if (adding) name.placeholder = '例如：完整故事';
        name.setAttribute('aria-label', '小剧场提示词名称');
        nameField.append(name);
        const draftContent = element('textarea');
        if (deleting) fields.append(element('p', `确定删除「${preset.name}」？删除后将选中“默认提示词”。`, 'play-prompt-delete-message'));
        else fields.append(nameField);
        if (adding) {
            const draftField = element('label', '内容', 'tea-field play-prompt-draft');
            draftContent.spellcheck = false; draftContent.rows = 10;
            draftContent.placeholder = '填写要发送给 AI 的提示词；留空时不添加。'; draftContent.setAttribute('aria-label', '内容');
            draftField.append(draftContent); fields.append(draftField);
        }
        const footer = element('footer', undefined, 'play-prompt-editor-footer');
        const error = element('p', '', 'tea-setting-description play-prompt-editor-error'); error.hidden = true; error.setAttribute('role', 'alert');
        fields.append(error);
        const actions = element('div', undefined, 'tea-actions');
        const cancel = textButton('取消', close); cancel.className = 'play-prompt-cancel';
        const submit = element('button', deleting ? '确认删除' : '保存', 'play-prompt-save'); submit.type = 'submit';
        actions.append(cancel, submit); footer.append(actions);
        form.append(header, fields, footer); dialog.append(form); section.append(dialog);
        dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
        dialog.addEventListener('close', () => {
            dialog.remove(); (adding ? add : deleting ? select : rename).focus({ preventScroll: true });
        });
        name.addEventListener('input', () => { name.removeAttribute('aria-invalid'); error.hidden = true; });
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (deleting) {
                const config = readPlayPromptSettings(settings);
                save({ ...config, presets: config.presets.filter(entry => entry.id !== preset.id), selectedId: 'default' });
                update(); close(); return;
            }
            const config = readPlayPromptSettings(settings), title = name.value.trim();
            const message = !title ? '请填写小剧场提示词名称。'
                : config.presets.some(entry => entry.id !== preset?.id && entry.name === title) ? '已有同名提示词，请换一个名称。' : '';
            if (message) { error.textContent = message; error.hidden = false; name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
            const id = preset?.id ?? `custom-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
            const entry = { id, name: title, content: adding ? draftContent.value : config.presets.find(item => item.id === id).content };
            save({ ...config, presets: preset ? config.presets.map(item => item.id === id ? entry : item) : [...config.presets, entry], selectedId: id });
            update(); close();
        });
        dialog.showModal(); (deleting ? cancel : name).focus({ preventScroll: true });
    }
    update();
}

export function renderPlayContinuationSettings(area, settings, saveSettings) {
    const section = element('section', undefined, 'play-continue-settings');
    const row = element('label', undefined, 'tea-setting-row');
    row.append(element('strong', '续写方式'));
    const mode = element('select'); mode.setAttribute('aria-label', '续写方式');
    for (const [value, text] of [['history', '第一种：保留 AI 消息'], ['prompt', '第二种：正文放入提示词']]) {
        const option = element('option', text); option.value = value; mode.append(option);
    }
    mode.value = readPlayContinuationSettings(settings).mode; row.append(mode);
    const description = element('p', '', 'tea-setting-description');
    const field = element('label', '续写提示词', 'tea-field');
    const input = element('textarea'); input.rows = 5; input.spellcheck = false;
    input.setAttribute('aria-label', '续写提示词');
    const error = element('p', '', 'tea-setting-description play-continue-error');
    error.id = 'tea-play-continue-error'; error.setAttribute('role', 'status');
    input.setAttribute('aria-describedby', error.id);
    field.append(input); section.append(row, description, field, error); area.append(section);
    function validate() {
        const message = playContinuationError(readPlayContinuationSettings(settings));
        error.textContent = message; error.hidden = !message;
        input.setAttribute('aria-invalid', String(!!message)); input.setCustomValidity(message);
    }
    function update() {
        const continuation = readPlayContinuationSettings(settings);
        input.value = continuation.prompt;
        description.textContent = continuation.mode === 'history'
            ? '保留待续写 AI 消息，最后追加续写提示词。默认提示词不引用原正文。'
            : '本次请求不单独保留待续写 AI 消息，通过 {{lastChatMessage}} 引用原正文；它的思维链紧接在原正文前。';
        validate();
    }
    mode.addEventListener('change', () => { settings.playContinueMode = mode.value; saveSettings(); update(); });
    input.addEventListener('input', () => {
        (settings.playContinuePrompts ??= {})[mode.value] = input.value;
        saveSettings(); validate();
    });
    update();
}

export function renderPlayProcessingSettings(area, settings, saveSettings, display, viewState) {
    const config = readPlaySettings(settings);
    const section = element('section', undefined, 'play-processing-settings');
    const tags = textSetting(section, settings, saveSettings, 'playHiddenTags', '隐藏标签', config.hiddenTags,
        '用中英文逗号或换行分隔；标签闭合后隐藏内容，原文保留。');
    tags.classList.add('play-hidden-tags');
    const resizeTags = () => { tags.rows = Math.min(5, tags.value.split(/\r\n|\r|\n/).length); };
    tags.addEventListener('input', resizeTags); resizeTags();
    const toggleRow = element('label', undefined, 'tea-setting-row');
    const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = config.regexEnabled;
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', '沿用酒馆正则');
    toggleRow.append(element('strong', '沿用酒馆正则'), toggle); section.append(toggleRow);
    const paused = element('p', '正则已停用，勾选项将在重新开启后生效。', 'tea-setting-description play-regex-paused');
    paused.setAttribute('role', 'status'); section.append(paused);

    const details = element('details', undefined, 'play-regex-list');
    details.append(element('summary', '选择酒馆正则'));
    const toolbar = element('div', undefined, 'play-regex-toolbar');
    const status = element('p', '', 'tea-setting-description'); status.setAttribute('role', 'status');
    const list = element('div', undefined, 'play-regex-groups'); let loading = false, loaded = !!viewState?.loaded;
    const refresh = iconButton('refresh', '刷新列表', () => void load());
    toolbar.append(element('p', '跟随酒馆当前选择；取消勾选即可停用，忽略楼层限制。', 'tea-setting-description'), refresh);
    details.append(toolbar, status, list);
    section.append(details); area.append(section);

    function updateEnabled() {
        paused.hidden = toggle.checked;
        details.classList.toggle('is-paused', !toggle.checked);
    }
    toggle.addEventListener('change', () => { settings.playRegexEnabled = toggle.checked; saveSettings(); updateEnabled(); });
    updateEnabled();

    function renderList() {
        const excluded = new Set(readPlaySettings(settings).excludedRegex);
        list.replaceChildren();
        for (const [source, title] of [['GLOBAL', '全局'], ['PRESET', '当前预设'], ['SCOPED', '当前角色']]) {
            const rules = (display?.rules ?? []).filter(rule => rule.source === source);
            const group = element('section', undefined, 'play-regex-group');
            const heading = element('h4', undefined, 'play-regex-heading'); heading.append(element('span', title));
            if (source !== 'GLOBAL') heading.append(element('span', display?.sources?.[source] || '未选择', 'play-regex-owner'));
            group.append(heading);
            for (const rule of rules) {
                const label = element('label', undefined, 'play-regex-rule'), input = element('input');
                input.type = 'checkbox'; input.checked = !excluded.has(rule.key);
                input.addEventListener('change', () => {
                    const next = new Set(readPlaySettings(settings).excludedRegex);
                    if (input.checked) next.delete(rule.key); else next.add(rule.key);
                    settings.playRegexExclusions = [...next]; saveSettings();
                });
                label.append(input, element('span', rule.script.scriptName || '未命名正则')); group.append(label);
            }
            if (!rules.length) group.append(element('p', '暂无可用规则', 'tea-setting-description'));
            list.append(group);
        }
    }
    async function load() {
        if (loading) return;
        loading = true; refresh.disabled = true; refresh.setAttribute('aria-busy', 'true'); status.hidden = false; status.textContent = '正在读取酒馆正则…';
        try {
            if (!display) throw new Error('酒馆正则读取接口尚未连接。');
            await display.refresh(); loaded = true;
            status.textContent = ''; status.hidden = true;
            renderList();
        } catch (error) { loaded = false; list.replaceChildren(); status.textContent = `读取失败：${error.message}`; }
        finally { loading = false; refresh.disabled = false; refresh.setAttribute('aria-busy', 'false'); }
    }
    details.addEventListener('toggle', () => { if (details.open && !loaded) void load(); });
    status.hidden = true;
    if (loaded) renderList();
    details.open = !!viewState?.open;
    return () => ({ open: details.open, loaded });
}
