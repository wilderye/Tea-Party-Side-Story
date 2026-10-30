const STORAGE_KEY = 'teahouse-diagnostics-v1';
const fields = new Set(['phase', 'apiMode', 'source', 'model', 'stream', 'endpoint',
    'startedAt', 'requestStartedAt', 'firstContentAt', 'lastContentAt', 'receivedCharacters', 'savedAt',
    'count', 'file', 'line', 'column']);
// UI observations are scalars selected by the collector, never DOM/content or
// configuration objects. Keep the schema version in every viewing session.
const viewFields = new Set(('session sequence schema count pageMs elapsedMs durationMs scope mode route appearance fontSource '
    + 'browser platform viewportWidth viewportHeight scale pixelRatio visibility reason character record batch ordinal total '
    + 'start end target ready pending failed latestReady rulesReady rulesRevision cached shown added removed replaced '
    + 'scrollTop scrollHeight clientHeight bottomDistance programmatic targetScroll loading earlier later jump '
    + 'proseAdded proseRemoved textChanges framesAdded framesRemoved image imageKind complete naturalWidth naturalHeight '
    + 'fontFamily fontWeight fontSize lineHeight fontStatus fontLoaded fontLoading fontUnloaded fontFailed fontSwap fontBlock '
    + 'probe node connected hidden width height top color textFill background opacity display cssVisibility animation transition transform filter mask '
    + 'textNodes imagePending framePending longTaskSupported layoutShiftSupported '
    + 'frameHeight maxFrameGap longTasks longestTask layoutShifts layoutShiftScore resourceKind resource duration transferBytes '
    + 'decodedBytes cacheHint sampleMs suppressed').split(' '));

function viewMetadata(value) {
    const result = {};
    for (const [key, item] of Object.entries(value ?? {})) {
        if (!viewFields.has(key)) continue;
        if (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean') result[key] = item;
        else if (typeof item === 'string') result[key] = redactor()(item).replace(/[\r\n]/g, ' ').slice(0, 180);
    }
    return result;
}
const statusNames = { complete: '已完成', failed: '失败', stopped: '已停止', 'save-failed': '保存失败' };
const phaseNames = { preparing: '准备提示词', generating: '已发出生成请求', 'retry-wait': '等待自动重试', saving: '保存回复' };
// Error objects sometimes carry an entire request or host configuration. Keep
// diagnostic properties, but never copy those containers into a log.
const privateFields = /^(?:(?:request|response)(?:data|body|headers|config|options)?|config|configuration|settings|options|payload|parameters|headers|custom_include_headers|authorization|cookie|set-cookie|messages|prompt|prompts|input|output|content|text|body|chat|reasoning|reasoning_signature|api[-_]?key|key|proxy_password|access_token|refresh_token|password|secret)$/i;

function redactor(secrets = []) {
    const privateValues = secrets.filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length);
    return value => {
        let text = String(value);
        for (const secret of privateValues) text = text.split(secret).join('[已隐藏]');
        text = text.replace(/\bBearer\s+[^\s"'<>;,}]+/gi, 'Bearer [已隐藏]');
        text = text.replace(/((?:authorization|cookie|set-cookie)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi, '$1[已隐藏]');
        text = text.replace(/((?:api[-_ ]?key|proxy_password|access_token|refresh_token)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[已隐藏]');
        // V8 includes a fragment of the parsed body in some SyntaxErrors.
        // Keep the error and call sites, but do not log that prompt/reply text.
        text = text.replace(/(Unexpected token [^\r\n,]+),[\s\S]*?( is not valid JSON)/g, '$1, [解析内容已隐藏]$2');
        return text.replace(/https?:\/\/[^\s"'<>]+/gi, value => {
            try {
                const url = new URL(value);
                let changed = false;
                if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
                for (const name of [...url.searchParams.keys()]) {
                    if (/key|token|auth|password|secret|signature/i.test(name)) {
                        url.searchParams.set(name, '[已隐藏]'); changed = true;
                    }
                }
                return changed ? url.toString() : value;
            } catch { return value; }
        });
    };
}

function errorDetails(error, clean, seen = new Set()) {
    if (error === undefined || error === null) return null;
    if (typeof error !== 'object') return { message: clean(error) };
    if (seen.has(error)) return { message: '[循环引用]' };
    seen.add(error);
    if (Array.isArray(error)) {
        const items = error.map(item => typeof item === 'string' ? clean(item)
            : item && typeof item === 'object' ? errorDetails(item, clean, seen) : item);
        seen.delete(error);
        return items;
    }
    const result = {};
    const keys = new Set(['name', 'message', 'stack', ...Object.getOwnPropertyNames(error)]);
    for (const key of keys) {
        if (privateFields.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        let item;
        try { item = error[key]; } catch { continue; }
        if (typeof item === 'string') result[key] = clean(item);
        else if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
        else if (typeof item === 'object' && item !== null) result[key] = errorDetails(item, clean, seen);
    }
    seen.delete(error);
    return result;
}

/** Also used when an error crosses the history worker boundary. */
export function serializeDiagnosticError(error, secrets = []) {
    return errorDetails(error, redactor(secrets));
}

function errorText(error) {
    if (!error || typeof error !== 'object') return String(error);
    if (Array.isArray(error)) return error.map(errorText).join('\n\n');
    const lines = [];
    if (typeof error.message === 'string' && !error.stack?.includes(error.message)) lines.push(error.message);
    if (typeof error.stack === 'string') lines.push(error.stack);
    for (const key of Object.keys(error)) {
        if (['message', 'stack', 'cause', 'error', 'errors'].includes(key)) continue;
        if (error[key] === undefined || (key === 'name' && error.stack?.startsWith(error.name))) continue;
        lines.push(`${key}: ${typeof error[key] === 'object' ? JSON.stringify(error[key], null, 2) : error[key]}`);
    }
    for (const key of ['cause', 'error', 'errors']) if (error[key]) lines.push(`${key}:\n${errorText(error[key])}`);
    return lines.length ? lines.join('\n') : JSON.stringify(error);
}

/** The viewer and export use the same flat text, with the original error first. */
export function formatDiagnostic(entry) {
    const message = entry.error ? errorText(entry.error) : [entry.operation, entry.message].filter(Boolean).join(' · ');
    const context = [...fields].filter(key => entry[key] !== undefined && entry[key] !== '')
        .map(key => `${key}: ${entry[key]}`);
    if (entry.view) context.push(JSON.stringify(entry.view));
    return `[${entry.at}] [${entry.level}] ${[message, ...context].join('\n')}`;
}

function metadata(value, clean) {
    const result = {};
    for (const [key, item] of Object.entries(value ?? {})) {
        if (!fields.has(key)) continue;
        if (typeof item === 'string') result[key] = clean(item);
        else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
    }
    return result;
}

/** Local diagnostics contain observed events and errors, never request/settings objects. */
export function createDiagnostics({ storage, limit = 500, now = () => new Date().toISOString(),
    uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` } = {}) {
    let entries = [], persistenceError = '', epoch = 0, viewTimer;
    const listeners = new Set();
    try {
        storage ??= globalThis.localStorage;
        const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
        const clean = redactor();
        if (Array.isArray(saved)) entries = saved.filter(item => item && typeof item.id === 'string')
            .map(item => {
                return { id: item.id, at: clean(item.at ?? (item.finishedAt || item.startedAt) ?? ''),
                    level: ['info', 'warn', 'error'].includes(item.level) ? item.level : item.error ? 'error' : 'info',
                    operation: clean(item.operation ?? ''),
                    message: clean(item.message ?? item.status ?? ''),
                    ...metadata(item, clean), ...(item.view ? { view: viewMetadata(item.view) } : {}),
                    ...(item.error ? { error: errorDetails(item.error, clean) } : {}) };
            }).sort((a, b) => a.at.localeCompare(b.at));
    } catch (error) {
        persistenceError = '旧日志无法读取；新日志仍可查看和导出。';
        entries.push({ id: uuid(), at: now(), level: 'error', operation: '读取插件日志', error: serializeDiagnosticError(error) });
    }
    function trim(items, maximum) {
        if (items.length > maximum) items.splice(0, items.length - maximum);
    }
    trim(entries, limit);
    function persist() {
        if (!storage) { persistenceError = '浏览器未提供日志存储；当前日志仍可查看和导出。'; return; }
        const candidate = entries.slice();
        while (true) {
            try {
                storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
                entries = candidate; persistenceError = ''; return;
            } catch (error) {
                if (error?.name === 'QuotaExceededError' && candidate.length > 1) {
                    // Free some headroom with bounded retries, keeping the
                    // newest entry whole even if one entry alone is too large.
                    trim(candidate, Math.max(1, Math.floor(candidate.length * 0.9)));
                    continue;
                }
                persistenceError = '日志暂时无法保存到浏览器；请在刷新或关闭页面前导出。';
                // Only commit evictions after a successful write. Storage may
                // be unavailable even for one entry; retain the export then.
                entries.push({ id: uuid(), at: now(), level: 'error', operation: '保存插件日志', error: serializeDiagnosticError(error) });
                trim(entries, limit);
                return;
            }
        }
    }
    function changed() {
        clearTimeout(viewTimer); viewTimer = undefined;
        persist();
        let viewerFailed = false;
        for (const listener of listeners) {
            try { listener(); }
            catch (error) {
                entries.push({ id: uuid(), at: now(), level: 'error', operation: '更新插件日志显示', error: serializeDiagnosticError(error) });
                trim(entries, limit);
                viewerFailed = true;
            }
        }
        // Do not notify the broken viewer again and recurse through logging.
        if (viewerFailed) persist();
    }
    function append(level, operation, values = {}, error, clean = redactor(), message = '') {
        const entry = { id: uuid(), at: now(), level, operation: clean(operation), message: clean(message),
            ...metadata(values, clean),
            ...(error != null ? { error: errorDetails(error, clean) } : {}) };
        entries.push(entry);
        trim(entries, limit);
        changed();
        return entry;
    }
    // Long operations add milestones to the same timeline as ordinary runtime logs.
    // Per-chunk updates stay in memory until a milestone or the final outcome.
    function start(operation, initial = {}, privateValues = []) {
        let clean = redactor(privateValues);
        const values = { startedAt: now(), ...metadata(initial, clean) }, ownEpoch = epoch;
        append('info', operation, values, undefined, clean, '开始');
        let closed = false;
        return {
            update(next) {
                if (closed || ownEpoch !== epoch) return;
                const previousPhase = values.phase, hadContent = !!values.firstContentAt;
                Object.assign(values, metadata(next, clean));
                if (values.phase && values.phase !== previousPhase) {
                    append('info', operation, values, undefined, clean, phaseNames[values.phase] ?? values.phase);
                }
                if (!hadContent && values.firstContentAt) append('info', operation, values, undefined, clean, '首次收到正文');
            },
            finish(status, error, final = {}) {
                if (closed) return;
                closed = true;
                if (ownEpoch === epoch) {
                    Object.assign(values, metadata(final, clean));
                    append(['failed', 'save-failed'].includes(status) ? 'error' : status === 'interrupted' ? 'warn' : 'info',
                        operation, values, error, clean, statusNames[status] ?? status);
                }
                clean = null;
            },
        };
    }
    return {
        start,
        view(operation, values) {
            entries.push({ id: uuid(), at: now(), level: 'info', operation: redactor()(operation), message: '', view: viewMetadata(values) });
            trim(entries, limit);
            // Never synchronously serialize the whole log in a rendering or
            // scroll callback. Export and lifecycle boundaries flush this batch.
            if (!viewTimer) { viewTimer = setTimeout(changed, 1000); viewTimer.unref?.(); }
        },
        flush() { if (viewTimer) changed(); },
        info(operation, values = {}) { append('info', operation, values); },
        warn(operation, error, values = {}, secrets = []) { append('warn', operation, values, error, redactor(secrets)); },
        error(operation, error, values = {}, secrets = []) { append('error', operation, values, error, redactor(secrets)); },
        read: () => ({ entries: structuredClone(entries), persistenceError, limit }),
        export() { if (viewTimer) changed(); return entries.map(formatDiagnostic).join('\n\n'); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        clear() { entries = []; epoch++; changed(); },
    };
}

/** Only collect errors attributable to this extension, not the host's whole console. */
export function observePluginErrors(diagnostics, { target = globalThis,
    root = new URL('./', import.meta.url).href } = {}) {
    if (typeof target.addEventListener !== 'function') return () => {};
    function belongs(error, seen = new Set()) {
        if (!error || typeof error !== 'object' || seen.has(error)) return false;
        seen.add(error);
        return (typeof error.stack === 'string' && error.stack.includes(root))
            || belongs(error.cause, seen) || belongs(error.error, seen);
    }
    const onError = event => {
        const file = event.filename || event.target?.src || event.target?.href || '';
        if (!file.startsWith(root) && !belongs(event.error)) return;
        diagnostics.error(event.error || event.message ? '插件运行异常' : '插件资源加载失败',
            event.error ?? event.message ?? '资源未能载入', { file, line: event.lineno, column: event.colno });
    };
    const onRejection = event => {
        if (belongs(event.reason)) diagnostics.error('插件异步操作未完成', event.reason);
    };
    target.addEventListener('error', onError, true);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
        target.removeEventListener('error', onError, true);
        target.removeEventListener('unhandledrejection', onRejection);
    };
}
