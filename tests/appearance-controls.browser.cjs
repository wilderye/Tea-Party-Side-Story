// Flow: choose a host theme -> open default/following appearance -> controls keep
// their own normal, selected, hover, disabled, focus and checked states;
// default prose, field hints and layout also ignore the host palette and CSS.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { harness } = require('./play-processing.browser.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const localCss = source => source.replace(/@import\s+[^;]+;/g, '').replace(/@font-face\s*\{[^}]*\}/g, '')
    .replace(/url\(\s*(?:"[^"\\]*"|'[^'\\]*'|[^)]*)\s*\)/g, 'none');
const synthetic = {
    name: 'synthetic', main_text_color: '#354352', italics_text_color: '#986abc', blur_tint_color: '#e1e7ed', chat_tint_color: 'transparent',
    quote_text_color: '#755595', underline_text_color: '#447799', border_color: '#99aabb',
    custom_css: `
        dialog.popup { width:95%!important; max-width:95%!important; height:90vh!important; max-height:90vh!important; padding:10px!important;
            background:red!important; border:4px solid blue!important; border-radius:24px!important; box-shadow:0 0 20px red!important; }
        .popup .popup-body,.popup .popup-content { padding:8px!important; }
        .popup button { background:white!important; border:2px solid blue!important; border-radius:12px!important; color:blue!important; }
        .popup button:hover { background:yellow!important; border-color:red!important; }
        .popup h3 { color:blue!important; }
        input { background:green!important; border:2px solid white!important; border-radius:3px; }
        textarea,input[type=text] { background:lightblue!important; border:2px solid white!important; color:blue!important; border-radius:2px!important; font-family:inherit!important; }
        textarea:focus { border-color:red!important; box-shadow:0 0 12px red!important; }
        textarea:not(#settingsSearch) { padding:6px 4px 6px 8px!important; }
        textarea,select { margin:4px 0!important; }
        textarea::placeholder,input::placeholder { color:var(--SmartThemeEmColor)!important; opacity:.7; }
        select option { color:var(--SmartThemeBodyColor)!important; background:var(--SmartThemeBlurTintColor)!important; }
        .mes_text code,pre { color:#ddd; background:#5d5d5d; font-family:serif; font-size:14px; padding:2px; }
        code { border-bottom:2px dashed var(--SmartThemeBorderColor); box-shadow:inset 0 0 5px blue!important; line-height:2!important; }
        blockquote { background:linear-gradient(red,blue); border-radius:4px; }
        hr { height:20px!important; min-height:20px; border:0!important; background:linear-gradient(red,blue); opacity:.2; }
        select,input[type=number] { appearance:none!important; background:white!important; border:0!important; border-bottom:2px solid blue!important;
            border-radius:0!important; color:blue!important; font-weight:600!important; font-size:.95em!important; padding:4px 8px!important; }
        input[type=checkbox] { appearance:none!important; width:15px!important; height:15px!important; background:white!important;
            border:1px solid blue!important; border-radius:50%!important; box-shadow:1px 1px blue!important; }
        input[type=checkbox]:hover { transform:scale(1.1)!important; background:lightblue!important; border-color:red!important; }
        input[type=checkbox]:checked { border:0!important; background:transparent!important; box-shadow:none!important; }
        input[type=checkbox]:checked::after { content:''!important; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)!important;
            width:21px!important; height:21px!important; background:linear-gradient(red,blue)!important; }
    `,
};
const paletteNames = { main_text_color: 'BodyColor', italics_text_color: 'EmColor', underline_text_color: 'UnderlineColor',
    quote_text_color: 'QuoteColor', blur_tint_color: 'BlurTintColor', chat_tint_color: 'ChatTintColor', border_color: 'BorderColor' };
const sample = '## 默认正文\n\n反引号内容：`中文代码 Code_123`。\n\n```text\n中文代码 Code_123\n  保留缩进\n```\n\n> 引用文字\n\n---\n\n正文结束。';

async function setTheme(page, theme) {
    await page.evaluate(({ css, palette }) => {
        const style = document.createElement('style'); style.id = 'custom-style'; style.textContent = css; document.head.append(style);
        window.controlThemePalette = Object.fromEntries(Object.entries(palette).map(([name, value]) => ['--SmartTheme' + name, value]));
        window.controlBasePalette = Object.fromEntries(Object.keys(controlThemePalette).map(name => [name, document.documentElement.style.getPropertyValue(name)]));
        for (const [name, value] of Object.entries(controlThemePalette)) document.documentElement.style.setProperty(name, value);
        const outside = document.createElement('section'); outside.id = 'shell-external'; outside.className = 'popup'; outside.hidden = true;
        outside.innerHTML = '<button>外部按钮</button><input type="text"><h3>外部标题</h3>'; document.body.append(outside);
    }, { css: localCss(theme.custom_css), palette: Object.fromEntries(Object.entries(paletteNames).map(([name, key]) => [key, theme[name] || '#777777'])) });
}

async function verifyControls(page, label) {
    const snapshots = await page.evaluate(() => {
        const props = ['color', 'backgroundColor', 'backgroundImage', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
            'borderTopColor', 'borderBottomColor', 'borderBottomStyle', 'borderRadius', 'padding', 'margin', 'width', 'height', 'fontFamily', 'fontSize', 'fontWeight',
            'lineHeight', 'boxShadow', 'textShadow', 'opacity', 'appearance', 'transform', 'whiteSpace'];
        const panel = document.getElementById('teahouse-panel');
        const following = panel.dataset.appearance === 'tavern';
        function snapshot() {
            const controls = [...panel.querySelectorAll('button,input,textarea,select,h3,.tea-macro code,.tea-log-entry')]
                .filter(node => node.checkVisibility() && node.getClientRects().length && !node.closest('.tea-body,.play-prose'));
            const prose = following ? [] : [...panel.querySelectorAll('.tea-body,.tea-body *')].filter(node => node.checkVisibility());
            const nodes = controls.concat(prose);
            const read = (node, names = props, pseudo) => Object.fromEntries(names.map(name => [name, getComputedStyle(node, pseudo)[name]]));
            const decoration = node => {
                if (!node.matches('input[type=checkbox],.tea-tabs button')) return null;
                const style = read(node, ['content', 'display', 'width', 'height', 'top', 'left', 'backgroundColor', 'backgroundImage', 'transform'], '::after');
                // Suppressed decorations do not render their theme dimensions/images.
                return style.display === 'none' || ['none', 'normal'].includes(style.content) ? { content: style.content, display: style.display } : style;
            };
            return [
                ...[panel.closest('dialog'), panel.parentElement, panel.parentElement.parentElement].map(node => ({ name: node.className,
                    style: read(node, ['backgroundColor', 'backgroundImage', 'borderTopWidth', 'borderRadius', 'padding', 'margin', 'width', 'height', 'boxShadow']) })),
                ...nodes.map((node, index) => ({ name: `${index} ${node.tagName}.${node.className} ${node.getAttribute('aria-label') || ''}`, style: read(node),
                    decoration: decoration(node), placeholder: node.hasAttribute('placeholder') ? read(node, ['color', 'opacity'], '::placeholder') : null,
                    options: node.matches('select') ? [...node.options].map(option => read(option, ['color', 'backgroundColor'])) : null })),
            ];
        }
        const sheet = document.getElementById('custom-style').sheet;
        function toggle(enabled) {
            sheet.disabled = !enabled;
            if (!following) for (const [name, value] of Object.entries(enabled ? controlThemePalette : controlBasePalette)) {
                if (value) document.documentElement.style.setProperty(name, value);
                else document.documentElement.style.removeProperty(name);
            }
        }
        toggle(false); const expected = snapshot();
        toggle(true); const actual = snapshot();
        return { expected, actual };
    });
    assert.equal(snapshots.actual.length, snapshots.expected.length, label);
    for (let index = 0; index < snapshots.actual.length; index++) {
        assert.deepEqual(snapshots.actual[index], snapshots.expected[index], `${label}: ${snapshots.actual[index].name}`);
    }
}

async function screenshot(page, name, target = page) {
    if (!process.env.TEA_QA_DIR) return;
    await fs.mkdir(process.env.TEA_QA_DIR, { recursive: true });
    await target.screenshot({ path: path.join(process.env.TEA_QA_DIR, name) });
}

async function verify(page, url, theme, viewport) {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    assert.equal(page.url(), url); assert.equal(await page.title(), '小剧场设置与原文编辑验证');
    await setTheme(page, theme);
    const external = () => page.locator('#shell-external').evaluate(node => [...node.children].map(child => {
        const style = getComputedStyle(child);
        return [style.color, style.backgroundColor, style.border, style.borderRadius];
    }));
    const externalBefore = await external();
    await page.evaluate(async body => {
        fixture.settings.appearance = 'default'; fixture.settings.fontSource = 'default';
        fixture.community.set('shell-test', { id: 'shell-test', title: '主题检查', author: '测试', body, type: 'standalone' });
        for (const id of [seed.a, seed.hidden]) {
            const round = await testHistory.getRound(id);
            await testHistory.editResult(id, round.results[0].id, body, round.results[0].text);
        }
    }, sample);
    await page.getByRole('button', { name: '打开小剧场面板', exact: true }).click();
    const panel = page.locator('#teahouse-panel');
    const button = name => panel.getByRole('button', { name, exact: true }).filter({ visible: true });
    const check = stage => verifyControls(page, `${theme.name} ${viewport.width} ${stage}`);
    await page.evaluate(() => document.fonts.ready);
    await check('library');
    const codeSizes = await panel.locator('.tea-body:visible pre').first().evaluate(node => ({
        pre: parseFloat(getComputedStyle(node).fontSize), body: parseFloat(getComputedStyle(node.parentElement).fontSize),
        code: parseFloat(getComputedStyle(node.querySelector('code')).fontSize) }));
    assert.equal(codeSizes.pre, codeSizes.body, '选集代码块以正文字号为基准');
    assert.equal(codeSizes.code, codeSizes.body * .875, '代码不被主题重复缩小');
    assert.equal(await page.locator('dialog.teahouse-dialog').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    assert.equal(await page.locator('dialog.teahouse-dialog').evaluate(node => getComputedStyle(node).borderRadius), viewport.width <= 760 ? '0px' : '8px');
    await button('跳转到某页').click();
    const pageInput = panel.getByRole('textbox', { name: '跳转页码', exact: true }).filter({ visible: true });
    await pageInput.fill('0'); await pageInput.press('Enter');
    assert.equal(await pageInput.getAttribute('aria-invalid'), 'true');
    await check('invalid page number'); await pageInput.press('Escape');
    await button('设置').hover(); await check('icon hover'); await page.mouse.move(0, 0);
    await button('剧场演出').click(); await panel.locator('.play-record:visible').first().waitFor();
    await check('performance prose');
    assert.equal(await panel.locator('.play-prose:visible pre').first().evaluate(node => getComputedStyle(node).fontSize), '13px', '演出保留原有代码块字号');
    await button('设置').click();
    const api = panel.getByRole('combobox', { name: '生成使用的 API', exact: true });
    await api.selectOption('custom');
    await page.evaluate(async () => {
        const diagnostics = (await import('/diagnostics.js')).createDiagnostics({ storage: null });
        diagnostics.info('合成日志：默认外观显示检查');
        const view = (await import('/diagnostics-view.js')).renderDiagnostics(document.querySelector('#teahouse-panel .tea-settings'), diagnostics, { open: true });
        view.dispose();
    });
    await check('settings fields, log text and disabled model controls');
    assert.equal(await panel.getByRole('combobox', { name: '模型', exact: true }).evaluate(node => getComputedStyle(node).fontSize), viewport.width <= 760 ? '16px' : '14px');
    const field = panel.getByRole('textbox', { name: '隐藏标签', exact: true });
    await field.focus(); await check('textarea focus');
    const toggle = panel.locator('input[role=switch]').filter({ visible: true }).first();
    await toggle.setChecked(true); await toggle.hover(); await check('checked switch hover');
    assert.equal(await toggle.evaluate(node => getComputedStyle(node, '::after').left), '27px');
    await toggle.setChecked(false); await check('unchecked switch');
    await panel.locator('.play-regex-list summary').click();
    const checkbox = panel.locator('.play-regex-rule input').filter({ visible: true }).first();
    await checkbox.waitFor(); await checkbox.setChecked(false); await check('native checkbox off');
    await checkbox.setChecked(true); await checkbox.hover(); await check('native checkbox on hover');
    assert.equal(await checkbox.evaluate(node => getComputedStyle(node).appearance), 'auto');
    await page.mouse.move(0, 0);
    const appearance = panel.getByRole('combobox', { name: '外观', exact: true });
    await appearance.selectOption('tavern'); await check('following appearance');
    const tavernSwitch = panel.getByRole('switch', { name: '沿用酒馆正则', exact: true });
    const switchColor = async (control, checked) => {
        await control.setChecked(checked);
        return control.evaluate(node => {
            const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
            const parse = value => {
                context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const luminance = color => color.map(value => value / 255).map(value =>
                value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
                .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
            const track = parse(getComputedStyle(node).backgroundColor);
            const surface = parse(getComputedStyle(node.closest('#teahouse-panel')).getPropertyValue('--tea-theme-surface'));
            return { track, thumb: getComputedStyle(node, '::after').backgroundColor,
                left: getComputedStyle(node, '::after').left,
                contrast: (Math.max(luminance(track), luminance(surface)) + .05)
                    / (Math.min(luminance(track), luminance(surface)) + .05) };
        });
    };
    const offSwitch = await switchColor(tavernSwitch, false); await check('following unchecked switch');
    await screenshot(page, `switch-${theme.slug || 'synthetic'}-off-${viewport.width}.png`, tavernSwitch.locator('..'));
    const onSwitch = await switchColor(tavernSwitch, true); await tavernSwitch.hover(); await check('following checked switch hover');
    await screenshot(page, `switch-${theme.slug || 'synthetic'}-on-${viewport.width}.png`, tavernSwitch.locator('..'));
    assert.ok(onSwitch.contrast >= 3, '跟随酒馆主题时开启状态与背景保持清楚对比');
    assert.ok(onSwitch.track.some((value, index) => Math.abs(value - offSwitch.track[index]) >= 20),
        '开启和关闭状态使用明显不同的轨道颜色');
    assert.equal(offSwitch.left, '3px'); assert.equal(onSwitch.left, '27px');
    for (const [name, key] of [['显示 G 向内容', 'showGore'], ['不发送角色聊天，仅读取预设/人设/世界书', 'playNoChat'], ['续写时发回原生思维链', 'playContinueSendReasoning']]) {
        const control = panel.getByRole('switch', { name, exact: true });
        await control.setChecked(true);
        assert.deepEqual(await switchColor(control, false), offSwitch, `${name} 共用关闭配色和圆点位置`);
        assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem('processingSettings'))[key], key), false);
        assert.deepEqual(await switchColor(control, true), onSwitch, `${name} 共用开启配色和圆点位置`);
        assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem('processingSettings'))[key], key), true);
    }
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('processingSettings')).playRegexEnabled), true);
    if (['synthetic', 'warm', 'dark'].includes(theme.name)) {
        assert.deepEqual(onSwitch.track, await page.evaluate(color => {
            const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
            context.fillStyle = color; context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        }, theme.underline_text_color), '清楚的主题开启色原样保留');
    }
    await page.mouse.move(0, 0);
    if (theme.name === 'synthetic') {
        assert.notEqual(await panel.locator('.play-prose pre').first().evaluate(node => getComputedStyle(node).color),
            await panel.locator('.play-prose').first().evaluate(node => getComputedStyle(node).color), '跟随模式仍应用主题代码颜色');
        assert.equal(await panel.locator('.play-prose hr').first().evaluate(node => getComputedStyle(node).height), '20px', '跟随模式仍应用主题分隔线');
    }
    await appearance.selectOption('default'); await check('restored default appearance');
    assert.equal(await panel.evaluate(node => ['--tea-switch-paper', '--tea-switch-off-paper', '--tea-switch-off-ink', '--tea-switch-off-line']
        .every(name => !node.style.getPropertyValue(name))), true, '切回默认外观清除所有开关主题颜色');
    await panel.locator('.tea-settings').evaluate(node => { node.scrollTop = 0; });
    await screenshot(page, `controls-${theme.slug || 'synthetic'}-settings-${viewport.width}.png`);
    await api.selectOption('tavern');
    await panel.getByRole('combobox', { name: '自定义小剧场提示词', exact: true }).selectOption('recommended');
    await panel.getByRole('textbox', { name: '小剧场提示词内容', exact: true }).focus();
    await check('prompt content and rename controls');
    await panel.getByRole('button', { name: '修改提示词名称', exact: true }).click();
    await check('prompt rename dialog');
    await panel.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await panel.getByRole('button', { name: '新增提示词', exact: true }).click();
    await panel.getByRole('dialog').getByRole('textbox', { name: '内容', exact: true }).focus();
    await check('prompt add dialog, fields and footer');
    await panel.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await button(viewport.width > 760 ? '设置' : '返回剧场演出').click();
    await check('restored default prose');
    const composer = panel.getByRole('textbox', { name: '小剧场提示词', exact: true });
    const send = panel.locator('.play-send');
    await composer.fill(''); assert.equal(await send.isDisabled(), true); await check('disabled send');
    const disabledBackground = await send.evaluate(node => getComputedStyle(node).backgroundColor);
    await composer.fill('用于检查输入框的草稿'); assert.equal(await send.isEnabled(), true);
    assert.notEqual(await send.evaluate(node => getComputedStyle(node).backgroundColor), disabledBackground);
    assert.equal(await send.evaluate(node => getComputedStyle(node).borderRadius), '4px');
    await send.hover(); await check('enabled send hover'); await page.mouse.move(0, 0);
    const record = panel.locator('.play-record:visible').first();
    const favorite = record.getByRole('button', { name: '收藏演出记录', exact: true });
    await favorite.click(); await page.waitForFunction(() => document.querySelector('.play-header-actions .tea-star[aria-pressed=true]'));
    await check('favorite selected');
    await record.locator('.play-delete').first().hover(); await check('delete hover');
    await record.getByRole('button', { name: '编辑回复原文', exact: true }).click();
    const editor = record.getByRole('textbox', { name: '回复原文', exact: true });
    await editor.focus(); await check('message editor');
    await record.locator('.play-assistant-message .play-edit-form').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await composer.inputValue(), '用于检查输入框的草稿');
    await screenshot(page, `controls-${theme.slug || 'synthetic'}-play-${viewport.width}.png`);
    await button('茶会选集').click(); await button('设置').click();
    await panel.getByRole('button', { name: '随文剧场用法', exact: true }).click();
    await panel.locator('.tea-macro').first().waitFor(); await check('macro help');
    await button('返回设置').click();
    await button(viewport.width > 760 ? '设置' : '返回列表').click();
    assert.deepEqual(await external(), externalBefore, 'Plugin control protection does not change host controls');
    assert.equal(await page.evaluate(() => captured.length), 0, 'No generation requests');
    assert.equal(await panel.evaluate(node => node.scrollWidth - node.clientWidth), 0, 'No horizontal panel overflow');
    await button('关闭面板').click(); await panel.waitFor({ state: 'detached' });
}

(async () => {
    const themes = [synthetic,
        { ...synthetic, name: 'light-close', slug: 'light-close', main_text_color: '#4d4e50', blur_tint_color: '#efefef',
            underline_text_color: '#acacac', border_color: '#acacac' },
        { ...synthetic, name: 'warm', slug: 'warm', main_text_color: '#5a524c', blur_tint_color: '#dddad7',
            underline_text_color: '#744728', border_color: '#744728' },
        { ...synthetic, name: 'dark', slug: 'dark', main_text_color: '#e6e0d8', blur_tint_color: '#25272c',
            underline_text_color: '#deae79', border_color: '#deae79' },
    ];
    if (process.env.TEA_THEME_DIR) {
        const names = (await fs.readdir(process.env.TEA_THEME_DIR)).filter(name => name.endsWith('.json')).sort();
        assert.ok(names.length, 'The supplied directory must contain theme fixtures');
        for (const [index, filename] of names.entries()) {
            themes.push({ ...JSON.parse(await fs.readFile(path.join(process.env.TEA_THEME_DIR, filename), 'utf8')), slug: `theme-${index + 1}` });
        }
    }
    let nativeCss = '';
    if (process.env.TEA_TAVERN_CSS) {
        const base = path.dirname(process.env.TEA_TAVERN_CSS);
        for (const name of ['style.css', 'css/popup.css', 'css/popup-safari-fix.css']) nativeCss += localCss(await fs.readFile(path.join(base, name), 'utf8'));
    }
    const html = harness.replace('<link rel="stylesheet" href="/style.css">', '<style>' + nativeCss + '</style><link rel="stylesheet" href="/style.css">');
    const server = http.createServer(async (request, response) => {
        try {
            const name = new URL(request.url, 'http://test').pathname.slice(1);
            if (!name) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
            if (name === 'favicon.ico') { response.statusCode = 204; return response.end(); }
            if (!/^(?:[\w-]+\.(?:js|css)|vendor\/[\w-]+\.js|assets\/tea-party\.svg|assets\/fonts\/[\w-]+\.woff2)$/.test(name)) {
                response.statusCode = 404; return response.end();
            }
            response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
            response.end(await fs.readFile(path.join(root, name)));
        } catch { response.statusCode = 404; response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const theme of themes) {
            for (const viewport of [{ width: 1332, height: 896 }, { width: 390, height: 844 }]) {
                const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
                await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.fulfill({ status: 204, body: '' }));
                const page = await context.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
                await verify(page, url, theme, viewport); assert.deepEqual(errors, []);
                console.log(`PASS ${theme.name} ${viewport.width}x${viewport.height}: controls, default prose, hints, spacing, appearance switching and host isolation`);
                await context.close();
            }
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
