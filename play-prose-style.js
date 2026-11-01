const cssToken = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\\[0-9a-f]{1,6}\s?|\\[^\r\n]|[-\w\u0080-\uffff])+/gi;

function unescapeName(value) {
    return value.replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
        (_match, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : char);
}

export function scopeProseAnimations(fragment, scope) {
    const sheets = [...fragment.querySelectorAll('style')].map(node => {
        const sheet = new CSSStyleSheet(); sheet.replaceSync(node.textContent);
        return { node, sheet };
    });
    const names = new Map(), styles = [...fragment.querySelectorAll('[style]')].map(node => node.style);
    function collect(rules) {
        for (const rule of rules) {
            if (rule.type === CSSRule.KEYFRAMES_RULE) {
                const name = unescapeName(rule.name);
                if (!names.has(name)) names.set(name, `tea-${scope}-${names.size}`);
                rule.name = names.get(name);
            }
            if (rule.style) styles.push(rule.style);
            if (rule.cssRules) collect(rule.cssRules);
        }
    }
    for (const { sheet } of sheets) collect(sheet.cssRules);
    const variables = new Set();
    const collectVariables = value => {
        for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) variables.add(match[1]);
    };
    const rename = value => value.replace(cssToken, (token, offset) => {
        if (token.startsWith('/*') || value.slice(offset + token.length).trimStart().startsWith('(')) return token;
        return names.get(unescapeName(token)) ?? token;
    });
    for (const style of styles) {
        for (const property of ['animation-name', '-webkit-animation-name']) {
            const value = style.getPropertyValue(property);
            if (value) {
                collectVariables(value);
                style.setProperty(property, rename(value), style.getPropertyPriority(property));
            }
        }
        for (const property of ['animation', '-webkit-animation']) {
            const value = style.getPropertyValue(property);
            if (/var\(/.test(value)) {
                collectVariables(value);
                style.setProperty(property, rename(value), style.getPropertyPriority(property));
            }
        }
    }
    for (const variable of variables) {
        for (const style of styles) {
            const value = style.getPropertyValue(variable);
            if (!value) continue;
            collectVariables(value);
            style.setProperty(variable, rename(value), style.getPropertyPriority(variable));
        }
    }
    for (const { node, sheet } of sheets) node.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
}
