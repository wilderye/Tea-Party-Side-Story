import { PlaygroundError } from './playground.js';

/** Adapt imports to a request's supplied values, leaving native algorithms intact. */
export function bindPlayModuleSource(source, sourceUrl, bindings) {
    const declarations = [];
    const prefix = 'const __teaEnvironment = __teaArguments;\nconst console = __teaEnvironment.console;\n';
    const names = new Set(bindings);
    const adapted = source.replace(/import\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;/g, (_whole, imported, _quote, path) => {
        const kept = [];
        for (const item of imported.split(',').map(value => value.trim()).filter(Boolean)) {
            const [name, alias = name] = item.split(/\s+as\s+/);
            if (names.has(name)) declarations.push(`const ${alias} = __teaEnvironment[${JSON.stringify(name)}];`);
            else kept.push(item);
        }
        if (kept.length) {
            declarations.push(`const { ${kept.map(item => item.replace(/\s+as\s+/, ': ')).join(', ')} } = __teaEnvironment.originalImports[${JSON.stringify(new URL(path, sourceUrl).href)}];`);
        }
        return '';
    }).replace(/import\s*\*\s*as\s+(\w+)\s*from\s*(['"])([^'"]+)\2\s*;/g, (_whole, name, _quote, path) => {
        declarations.push(`const ${name} = __teaEnvironment.originalImports[${JSON.stringify(new URL(path, sourceUrl).href)}];`); return '';
    });
    const exported = [...adapted.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g)].map(match => match[1]);
    const body = adapted.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g, '')
        .replace(/\bexport\s*\{([^}]+)\}\s*;/g, (_whole, items) => {
            for (const item of items.split(',').map(value => value.trim()).filter(Boolean)) {
                const match = item.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
                if (!match) throw new PlaygroundError('independent_module_exports', '当前酒馆的模块导出形式尚未支持独立处理。');
                exported.push([match[2] ?? match[1], match[1]]);
            }
            return '';
        });
    if (/\bexport\s/.test(body)) throw new PlaygroundError('independent_module_exports', '当前酒馆的模块导出形式尚未支持独立处理。');
    return prefix + declarations.join('\n') + '\n' + body + '\nreturn Object.defineProperties({}, {\n'
        + exported.map(entry => {
            const [name, local] = Array.isArray(entry) ? entry : [entry, entry];
            return `${JSON.stringify(name)}: { enumerable: true, get: () => ${local} }`;
        }).join(',\n') + '\n});';
}

/** Each imported module closes over one task; imports never replace host state. */
export async function importPlayTaskModule(source, sourceUrl, environment) {
    // Import the host's public dependencies once. The task's functions live in
    // an ordinary closure, allowing its private data to be collected on finish;
    // unique ESM/blob modules would retain one instance per request indefinitely.
    const paths = [...source.matchAll(/\bimport\s*(?:\{[^}]+\}|\*\s*as\s+\w+)\s*from\s*(['"])([^'"]+)\1\s*;/g)].map(match => new URL(match[2], sourceUrl).href);
    const originalImports = Object.fromEntries(await Promise.all([...new Set(paths)].map(async path => [path, await import(path)])));
    const text = bindPlayModuleSource(source, sourceUrl, Object.keys(environment));
    try { return new Function('__teaArguments', text)({ ...environment, originalImports }); }
    catch (cause) { throw new PlaygroundError('independent_module_failed', '酒馆的独立资料处理接口载入失败，本次没有发送。', { cause }); }
}

const sources = new Map();
export async function loadPlayModuleSource(path) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) throw new PlaygroundError('invalid_module_source', '独立处理只能读取当前酒馆的源码。');
    if (!sources.has(url.href)) sources.set(url.href, (async () => {
        const response = await fetch(url.href);
        if (!response.ok) throw new PlaygroundError('independent_module_missing', '独立处理所需的酒馆源码无法读取，请刷新后重试。');
        return response.text();
    })().catch(error => { sources.delete(url.href); throw error; }));
    return sources.get(url.href);
}

export const quietPlayConsole = Object.fromEntries(['log', 'debug', 'info', 'warn', 'error', 'group', 'groupEnd', 'time', 'timeEnd'].map(name => [name, () => {}]));
