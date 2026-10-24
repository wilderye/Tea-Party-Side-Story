import { readThemeBodyStyles } from './theme-styles.js';

// Only read the active page's appearance. Theme files and Tavern settings are not needed.
function readColor(context, value, fallback) {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = fallback;
    context.fillStyle = value || fallback;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
}

function composite(foreground, background) {
    const alpha = foreground[3] / 255;
    return foreground.slice(0, 3).map((channel, index) => Math.round(channel * alpha + background[index] * (1 - alpha)));
}

function luminance(color) {
    const channels = color.slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

function contrastRatio(first, second) {
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return (lighter + .05) / (darker + .05);
}

function mix(first, second, amount) {
    return first.map((channel, index) => Math.round(channel * (1 - amount) + second[index] * amount));
}

function rgb(color) { return `rgb(${color.map(channel => Math.round(channel)).join(',')})`; }

export function createAppearance(panel, diagnostics) {
    const properties = ['--tea-theme-surface', '--tea-theme-reading', '--tea-error', '--tea-warning',
        '--tea-switch-paper', '--tea-switch-off-paper', '--tea-switch-off-ink', '--tea-switch-off-line', 'color-scheme'];
    let style;
    return {
        apply(source) {
            const following = source === 'tavern';
            panel.dataset.appearance = following ? 'tavern' : 'default';
            for (const name of properties) panel.style.removeProperty(name);
            style?.remove(); style = null;
            if (!following) return;

            const host = getComputedStyle(document.body);
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            const text = readColor(context, host.getPropertyValue('--SmartThemeBodyColor'), '#233d35');
            // Transparent themes need a solid base. Prefer the host's background;
            // otherwise choose a neutral base opposite to its text brightness.
            const neutral = luminance(text) > .179 ? [24, 26, 29] : [250, 247, 238];
            const background = composite(readColor(context, host.backgroundColor, 'transparent'), neutral);
            const surface = composite(readColor(context, host.getPropertyValue('--SmartThemeBlurTintColor'), '#faf7ee'), background);
            const reading = composite(readColor(context, host.getPropertyValue('--SmartThemeChatTintColor'), 'transparent'), surface);
            const ink = composite(text, surface);
            const accent = composite(readColor(context, host.getPropertyValue('--SmartThemeUnderlineColor'),
                host.getPropertyValue('--SmartThemeQuoteColor') || host.getPropertyValue('--SmartThemeBodyColor') || '#233d35'), surface);
            let switchOn = accent;
            // Keep a usable theme accent; only blend toward its text when it fades into the surface.
            for (let step = 1; step <= 10 && contrastRatio(switchOn, surface) < 3; step++) switchOn = mix(accent, ink, step / 10);
            const dark = luminance(surface) < .18;
            panel.style.setProperty('--tea-theme-surface', `rgb(${surface.join(',')})`);
            panel.style.setProperty('--tea-theme-reading', `rgb(${reading.join(',')})`);
            panel.style.setProperty('--tea-error', dark ? '#ffaaa2' : '#a6382c');
            panel.style.setProperty('--tea-warning', dark ? '#efc474' : '#8a600c');
            panel.style.setProperty('--tea-switch-paper', rgb(switchOn));
            panel.style.setProperty('--tea-switch-off-paper', rgb(mix(surface, ink, .1)));
            panel.style.setProperty('--tea-switch-off-ink', rgb(mix(surface, ink, .6)));
            panel.style.setProperty('--tea-switch-off-line', rgb(mix(surface, ink, .45)));
            panel.style.setProperty('color-scheme', dark ? 'dark' : 'light');
            const body = readThemeBodyStyles();
            if (body.css) {
                style = document.createElement('style'); style.setAttribute('data-tea-theme-style', '');
                style.textContent = body.css; document.head.append(style);
            }
            if (body.skipped.length || body.unreadable) diagnostics?.info('部分正文美化依赖酒馆消息结构或无法读取，未应用到小剧场。');
        },
        dispose() { style?.remove(); style = null; },
    };
}
