const resourceLimit = 64;
const byteLimit = 16 * 1024 * 1024;
let provider;

export function parseHelperResources(source, base) {
    const template = document.createElement('template'); template.innerHTML = source;
    const resources = [];
    for (const node of template.content.childNodes) {
        if (node.nodeType === 8 || node.nodeType === 3 && !node.textContent.trim()) continue;
        if (node.nodeType !== 1 || !node.matches('script[src],link[rel="stylesheet"][href]')) throw new Error('Unsupported helper resource manifest');
        const tag = node.localName, attributes = Object.fromEntries([...node.attributes].map(attr => [attr.name, attr.value]));
        const accepted = tag === 'script' ? ['src', 'type', 'async', 'defer', 'nomodule', 'crossorigin', 'integrity', 'referrerpolicy', 'fetchpriority']
            : ['href', 'rel', 'type', 'media', 'title', 'disabled', 'crossorigin', 'integrity', 'referrerpolicy', 'fetchpriority'];
        if (Object.keys(attributes).some(name => !accepted.includes(name)) || node.textContent.trim()) throw new Error('Unsupported helper resource attributes');
        const url = new URL(attributes[tag === 'script' ? 'src' : 'href'], base);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported helper resource URL');
        resources.push({ tag, url: url.href, attributes });
    }
    if (!resources.length || resources.length > resourceLimit) throw new Error('Unsupported helper resource count');
    return resources;
}

export function resolveHelperCss(source, base) {
    return source.replace(/\/\*[\s\S]*?\*\/|url\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)]*)\s*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@import\b/gi, token => {
        if (/^@import/i.test(token)) throw new Error('Imported helper stylesheets are unsupported');
        if (!/^url\(/i.test(token)) return token;
        const value = token.slice(4, -1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
        if (value.includes('\\')) throw new Error('Escaped helper stylesheet URLs are unsupported');
        if (!value || /^(?:data:|#)/i.test(value)) return token;
        return `url(${JSON.stringify(new URL(value, base).href)})`;
    });
}

export function createHelperResourceProvider({ locate, request = (...args) => fetch(...args), diagnostics, timeout = 3000 } = {}) {
    let cached, running;
    async function prepare(controller) {
        const result = [], signal = controller.signal;
        let bytes = 0;
        const read = async (url, attributes = {}) => {
            const response = await request(url, { signal, credentials: attributes.crossorigin === 'use-credentials' ? 'include' : 'same-origin',
                ...(attributes.integrity ? { integrity: attributes.integrity } : {}),
                ...(attributes.referrerpolicy ? { referrerPolicy: attributes.referrerpolicy } : {}) });
            if (!response.ok) throw new Error(`Helper resource HTTP ${response.status}: ${new URL(url).pathname}`);
            const buffer = await response.arrayBuffer(); signal.throwIfAborted();
            bytes += buffer.byteLength;
            if (bytes > byteLimit) throw new Error('Helper resource size limit exceeded');
            return { text: new TextDecoder().decode(buffer), url: response.url || url };
        };
        const work = (async () => {
            const location = await locate(); signal.throwIfAborted();
            if (!location) throw new Error('Tavern Helper resource manifest is unavailable');
            const manifest = await read(location.url);
            const resources = parseHelperResources(manifest.text, location.base);
            await Promise.all(resources.map(async (resource, index) => {
                try {
                    const type = resource.attributes.type?.toLowerCase();
                    if (type && !(resource.tag === 'script' ? /^(?:text|application)\/javascript$/.test(type) : type === 'text/css')) {
                        throw new Error('Unsupported helper resource type');
                    }
                    const downloaded = await read(resource.url, resource.attributes);
                    if (resource.tag === 'script' && /\bimport\s*(?:\.|\()|\bdocument\s*\.\s*currentScript\s*(?:\?\.)?\s*\.\s*src/.test(downloaded.text)) {
                        throw new Error('Source-relative helper scripts are unsupported');
                    }
                    const text = resource.tag === 'link' ? resolveHelperCss(downloaded.text, downloaded.url) : downloaded.text;
                    signal.throwIfAborted(); result[index] = { ...resource, text };
                } catch (error) {
                    if (!signal.aborted) {
                        diagnostics?.warn('读取酒馆助手网页资源', error, { file: new URL(resource.url).pathname });
                        diagnostics?.info('跳过不可用资源，继续显示网页');
                    }
                }
            }));
        })().catch(error => {
            if (!signal.aborted) {
                diagnostics?.warn('读取酒馆助手网页资源', error);
                diagnostics?.info('继续使用已有网页内容');
            }
        });
        let abort;
        const cancelled = new Promise(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); });
        const timer = setTimeout(() => {
            diagnostics?.warn('读取酒馆助手网页资源', new DOMException('Helper resource preparation timed out', 'TimeoutError'));
            diagnostics?.info('使用已准备好的资源继续显示网页');
            controller.abort();
        }, timeout);
        try { await Promise.race([work, cancelled]); return result.filter(Boolean); }
        finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    return {
        prepare(signal) {
            if (signal?.aborted) return Promise.resolve([]);
            if (cached) return Promise.resolve(cached);
            if (!running) {
                const controller = new AbortController();
                const job = { controller, readers: 0 };
                running = job;
                job.promise = prepare(controller).then(result => {
                    if (running === job) { cached = result; running = null; }
                    return result;
                });
            }
            const job = running; job.readers++;
            return new Promise(resolve => {
                let finished = false;
                const done = result => {
                    if (finished) return;
                    finished = true; signal?.removeEventListener('abort', cancel); job.readers--;
                    if (!job.readers && running === job) { running = null; job.controller.abort(); }
                    resolve(result);
                };
                const cancel = () => done([]);
                signal?.addEventListener('abort', cancel, { once: true });
                job.promise.then(done);
            });
        },
    };
}

export function initializeHelperResources(diagnostics) {
    provider ??= createHelperResourceProvider({ diagnostics, locate: async () => {
        const { extensionNames } = await import('/scripts/extensions.js');
        const name = extensionNames.find(value => /(?:^|\/)JS-Slash-Runner$/i.test(value));
        return name ? { url: new URL(`/scripts/extensions/${name}/src/iframe/third_party_message.html`, location.origin).href,
            base: location.href } : null;
    } });
}

export function prepareHelperResources(signal) {
    return provider?.prepare(signal) ?? Promise.resolve([]);
}
