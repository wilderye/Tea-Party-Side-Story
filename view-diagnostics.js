// Lightweight observations of the plugin surface. Never read message strings,
// character names, resource URLs into the log, or take screenshots automatically.
const collectors = new WeakMap();
let sessionNumber = 0;
const pageSession = Math.random().toString(36).slice(2, 8);
const clock = () => performance.now();
const rounded = value => Math.round(value * 10) / 10;

export function recordViewEvent(node, operation, values) {
    const panel = node?.closest?.('#teahouse-panel');
    collectors.get(panel)?.event(operation, values);
}

export function createViewDiagnostics(panel, diagnostics, getState) {
    if (!diagnostics?.view) return null;
    const session = `${pageSession}-${++sessionNumber}`, started = clock();
    const ids = new Map(), nodes = new WeakMap(), subscriptions = [], timers = new Set();
    let sequence = 0, nodeCount = 0, disposed = false, sampling, sampleSignature = '', activeUntil = started + 20000;
    let emitted = 0, suppressed = 0, frame = 0, lastFrame = 0, maxFrameGap = 0, longTasks = 0, longestTask = 0, surface = '';
    let layoutShifts = 0, layoutShiftScore = 0, mutations = {}, resourceCounts = {}, inputAt = -Infinity;
    const completedFrames = new WeakSet();
    let observerMs = 0, observerCalls = 0;
    const id = value => {
        if (!value) return '';
        if (!ids.has(value)) ids.set(value, ids.size + 1);
        return ids.get(value);
    };
    const nodeId = value => { if (!nodes.has(value)) nodes.set(value, ++nodeCount); return nodes.get(value); };
    const record = (operation, values = {}, force = false) => {
        if (disposed) return;
        if (!force && emitted >= 180) { suppressed++; return; }
        const safe = { ...values };
        for (const name of ['character', 'record', 'target', 'resource']) if (safe[name]) safe[name] = id(safe[name]);
        diagnostics.view(operation, { session, sequence: ++sequence, pageMs: rounded(clock()), elapsedMs: rounded(clock() - started), ...safe });
        emitted++;
    };
    const listen = (target, name, handler, options) => {
        target?.addEventListener(name, handler, options);
        subscriptions.push(() => target?.removeEventListener(name, handler, options));
    };
    const later = (run, ms) => {
        const timer = setTimeout(() => { timers.delete(timer); if (!disposed) run(); }, ms);
        timers.add(timer); return timer;
    };
    function fontState(reason, changed = []) {
        const fonts = [...(document.fonts ?? [])];
        record('显示观察：字体状态', { reason, fontStatus: document.fonts?.status ?? 'unsupported',
            fontLoaded: fonts.filter(font => font.status === 'loaded').length, fontLoading: fonts.filter(font => font.status === 'loading').length,
            fontUnloaded: fonts.filter(font => font.status === 'unloaded').length, fontFailed: fonts.filter(font => font.status === 'error').length,
            fontSwap: fonts.filter(font => font.display === 'swap').length, fontBlock: fonts.filter(font => ['auto', 'block'].includes(font.display)).length });
        for (const family of [...new Set(changed.map(font => font.family))].slice(0, 4)) {
            const group = changed.filter(font => font.family === family);
            record('显示观察：字体加载事件', { reason, fontFamily: family, count: group.length,
                fontLoaded: group.filter(font => font.status === 'loaded').length, fontFailed: group.filter(font => font.status === 'error').length });
        }
    }
    function cssSnapshot(node, probe) {
        if (!node) return;
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        const values = { probe, node: nodeId(node), connected: node.isConnected, hidden: !!node.closest('[hidden]'),
            width: rounded(box.width), height: rounded(box.height), top: rounded(box.top), fontFamily: style.fontFamily,
            fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color,
            textFill: style.webkitTextFillColor, opacity: style.opacity, display: style.display, cssVisibility: style.visibility,
            background: style.backgroundColor, animation: style.animationName, transition: style.transitionDuration,
            transform: style.transform, filter: style.filter === 'none' ? 'none' : 'present', mask: style.maskImage === 'none' ? 'none' : 'present',
            textNodes: [...node.childNodes].filter(child => child.nodeType === 3).length };
        return values;
    }
    function sample(reason) {
        sampling = undefined;
        if (!panel.isConnected || document.hidden || clock() > activeUntil) return;
        const sampleStarted = clock();
        const state = getState(), scope = state.scope;
        const area = state.mode === 'settings' ? panel.querySelector('.tea-settings')
            : scope === 'play' ? panel.querySelector('.play-workspace:not([hidden]) .play-feed')
            : matchMedia('(max-width: 760px)').matches ? panel.querySelector('.tea-catalog:not([hidden]) .tea-list')
            : panel.querySelector('.tea-workspace:not([hidden]) .tea-reading');
        const box = area?.getBoundingClientRect();
        // Probe only the visible reading surface; do not enumerate paragraphs or
        // force layout for the whole history. elementFromPoint returns one node.
        const hit = box?.height ? document.elementFromPoint(box.left + box.width * .5, Math.min(innerHeight - 20, box.top + box.height * .65)) : null;
        let prose = hit && panel.contains(hit) ? hit.closest('.tea-body,.play-prose') : null;
        let paragraph = prose && (hit.closest('p,q,blockquote') ?? prose);
        // The first screen of a short catalog entry may leave the sample point
        // on blank space. Still observe that entry's body without walking history.
        if (!prose && scope !== 'play' && state.mode === 'list') {
            const candidate = area?.querySelector('.tea-body'), candidateBox = candidate?.getBoundingClientRect();
            if (candidateBox?.bottom > 0 && candidateBox.top < innerHeight) { prose = candidate; paragraph = candidate.firstElementChild ?? candidate; }
        }
        const quote = prose?.querySelector('q');
        const samples = [cssSnapshot(panel, 'panel'), cssSnapshot(panel.closest('dialog'), 'dialog'), cssSnapshot(area, 'scroll-area'),
            cssSnapshot(prose, 'prose'), cssSnapshot(paragraph, 'paragraph'), cssSnapshot(quote, 'quote')].filter(Boolean);
        const values = { ...state, visibility: document.visibilityState, fontStatus: document.fonts?.status ?? 'unsupported',
            viewportWidth: innerWidth, viewportHeight: innerHeight, scale: window.visualViewport?.scale ?? 1,
            scrollTop: rounded(area?.scrollTop ?? 0), scrollHeight: area?.scrollHeight ?? 0, clientHeight: area?.clientHeight ?? 0,
            bottomDistance: rounded(area ? area.scrollHeight - area.clientHeight - area.scrollTop : 0),
            record: hit?.closest('.play-record')?.dataset.record, loading: !!panel.querySelector('.play-empty:not([hidden])[data-state="loading"]'),
            imagePending: [...panel.querySelectorAll('img')].filter(node => !node.complete).length,
            framePending: [...panel.querySelectorAll('iframe.play-web-output')].filter(node => !completedFrames.has(node)).length,
            shown: panel.querySelectorAll('.play-record:not([hidden])').length,
            proseAdded: mutations.proseAdded ?? 0, proseRemoved: mutations.proseRemoved ?? 0, replaced: mutations.replaced ?? 0,
            textChanges: mutations.textChanges ?? 0, framesAdded: mutations.framesAdded ?? 0, framesRemoved: mutations.framesRemoved ?? 0 };
        const signature = JSON.stringify([values, samples]);
        if (signature !== sampleSignature) {
            record('显示观察：画面状态', { reason, ...values });
            for (const item of samples) record('显示观察：元素样式', item);
            sampleSignature = signature;
        }
        mutations = {};
        if (maxFrameGap >= 100 || longTasks || layoutShifts) {
            record('显示观察：绘制间隔', { maxFrameGap: rounded(maxFrameGap), longTasks, longestTask: rounded(longestTask),
                layoutShifts, layoutShiftScore: rounded(layoutShiftScore), sampleMs: rounded(clock() - started) });
            maxFrameGap = 0; longTasks = 0; longestTask = 0; layoutShifts = 0; layoutShiftScore = 0;
        }
        observerMs += clock() - sampleStarted; observerCalls++;
    }
    function schedule(reason) {
        if (!sampling && !disposed && clock() <= activeUntil) sampling = later(() => sample(reason), 250);
    }
    function measureFrame(time) {
        frame = 0;
        if (document.hidden || clock() > activeUntil || disposed) { lastFrame = 0; return; }
        if (lastFrame) maxFrameGap = Math.max(maxFrameGap, time - lastFrame);
        lastFrame = time; frame = requestAnimationFrame(measureFrame);
    }
    function activate(reason = 'surface') {
        if (disposed) return;
        const state = getState(), nextSurface = JSON.stringify(state);
        if (reason === 'render' && surface === nextSurface) {
            record('显示观察：重新生成面板', state); schedule('render'); return;
        }
        surface = nextSurface;
        if (suppressed) record('显示观察：合并频繁事件', { suppressed }, true);
        emitted = 0; suppressed = 0; resourceCounts = {};
        activeUntil = clock() + 20000; sampleSignature = '';
        timers.forEach(clearTimeout); timers.clear(); sampling = undefined;
        record('显示观察：进入页面', { reason, ...state }, true);
        fontState(reason);
        for (const ms of [0, 100, 500, 1500, 4000, 10000, 19000]) later(() => sample('scheduled'), ms);
        later(() => { record('显示观察：密集采样结束', { sampleMs: 20000, durationMs: rounded(observerMs), count: observerCalls, suppressed }, true); diagnostics.flush(); }, 20000);
        if (!frame) frame = requestAnimationFrame(measureFrame);
    }
    const observer = new MutationObserver(changes => {
        if (clock() > activeUntil || disposed) return;
        let changed = false;
        for (const change of changes) {
            const parent = change.target.nodeType === 1 ? change.target : change.target.parentElement;
            if (parent?.closest('.tea-diagnostics')) continue;
            changed = true;
            if (change.type === 'characterData' && parent?.closest('.tea-body,.play-prose')) mutations.textChanges = (mutations.textChanges ?? 0) + 1;
            if (change.type !== 'childList') continue;
            if (parent?.matches('.play-result,.tea-body,.play-prose') && change.removedNodes.length) mutations.replaced = (mutations.replaced ?? 0) + 1;
            for (const [nodes, suffix] of [[change.addedNodes, 'Added'], [change.removedNodes, 'Removed']]) for (const node of nodes) {
                if (node.nodeType !== 1) continue;
                for (const [name, selector] of [['prose', '.tea-body'], ['frames', 'iframe.play-web-output']]) {
                    const count = Number(node.matches(selector)) + node.querySelectorAll(selector).length;
                    if (count) mutations[name + suffix] = (mutations[name + suffix] ?? 0) + count;
                }
            }
        }
        if (changed) schedule('mutation');
    });
    observer.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
    listen(panel, 'pointerdown', () => { inputAt = clock(); }, { passive: true });
    listen(panel, 'wheel', () => { inputAt = clock(); }, { passive: true });
    listen(panel, 'scroll', () => schedule(clock() - inputAt < 1000 ? 'user-scroll' : 'scroll'), { capture: true, passive: true });
    for (const name of ['load', 'error']) listen(panel, name, event => {
        const node = event.target;
        if (!node?.matches?.('img,iframe') || clock() > activeUntil) return;
        const imageKind = node.matches('iframe') ? 'iframe' : node.closest('.tea-body,.play-prose') ? 'prose' : 'decoration';
        if (imageKind === 'iframe' && name === 'load') completedFrames.add(node);
        record('显示观察：资源事件', { reason: name, image: nodeId(node), imageKind, complete: !!node.complete,
            naturalWidth: node.naturalWidth ?? 0, naturalHeight: node.naturalHeight ?? 0 });
        schedule('resource');
    }, true);
    for (const name of ['loading', 'loadingdone', 'loadingerror']) listen(document.fonts, name, event => { fontState(name, event.fontfaces ?? []); schedule('font'); });
    listen(document, 'visibilitychange', () => {
        record('显示观察：页面可见性', { visibility: document.visibilityState });
        if (document.hidden) diagnostics.flush(); else activate('visible');
    });
    listen(window, 'pagehide', () => { record('显示观察：离开浏览器页面', {}, true); diagnostics.flush(); });
    listen(window.visualViewport, 'resize', () => schedule('viewport'));
    let performanceObserver;
    if (typeof PerformanceObserver === 'function') {
        performanceObserver = new PerformanceObserver(list => {
            if (clock() > activeUntil) return;
            for (const entry of list.getEntries()) {
                if (entry.entryType === 'longtask') { longTasks++; longestTask = Math.max(longestTask, entry.duration); }
                if (entry.entryType === 'layout-shift' && entry.sources?.some(source => panel.contains(source.node))) {
                    layoutShifts++; layoutShiftScore += entry.value;
                }
                if (entry.entryType === 'resource') {
                    const resourceKind = /\.(woff2?|otf|ttf)(?:[?#]|$)/i.test(entry.name) ? 'font'
                        : entry.name.startsWith(new URL('./assets/', import.meta.url).href) ? 'decoration' : null;
                    if (!resourceKind) continue;
                    resourceCounts[resourceKind] = (resourceCounts[resourceKind] ?? 0) + 1;
                    if (resourceCounts[resourceKind] <= 8 || entry.duration > 500) record('显示观察：资源耗时', {
                        resourceKind, resource: entry.name, durationMs: rounded(entry.duration), transferBytes: entry.transferSize,
                        decodedBytes: entry.decodedBodySize, cacheHint: entry.transferSize > 0 ? 'transferred' : entry.decodedBodySize > 0 ? 'cached' : 'unknown' });
                }
            }
            schedule('performance');
        });
        for (const type of ['longtask', 'layout-shift', 'resource']) if (PerformanceObserver.supportedEntryTypes.includes(type)) performanceObserver.observe({ type });
    }
    const agent = navigator.userAgent, browser = /EdgA?\/[\d.]+/.exec(agent)?.[0]
        ?? /Firefox\/[\d.]+|Chrome\/[\d.]+|Version\/[\d.]+/.exec(agent)?.[0] ?? 'unknown';
    record('显示观察：打开面板', { schema: 1, browser, platform: /Android|iPhone|iPad|Windows|Mac/.exec(agent)?.[0] ?? 'unknown',
        pixelRatio: devicePixelRatio, viewportWidth: innerWidth, viewportHeight: innerHeight,
        longTaskSupported: globalThis.PerformanceObserver?.supportedEntryTypes.includes('longtask') ?? false,
        layoutShiftSupported: globalThis.PerformanceObserver?.supportedEntryTypes.includes('layout-shift') ?? false }, true);
    const collector = {
        event(operation, values = {}) { record(`显示观察：${operation}`, values); schedule('event'); },
        activate,
        dispose() {
            sample('close'); record('显示观察：结束本次打开', { durationMs: rounded(observerMs), count: observerCalls, suppressed }, true); disposed = true;
            observer.disconnect(); performanceObserver?.disconnect(); subscriptions.forEach(stop => stop());
            timers.forEach(clearTimeout); cancelAnimationFrame(frame); collectors.delete(panel); diagnostics.flush();
        },
    };
    collectors.set(panel, collector); return collector;
}
