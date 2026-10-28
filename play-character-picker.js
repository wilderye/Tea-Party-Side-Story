import { element, textButton, glyph, iconButton, createPageJump } from './ui.js';

const characterKey = character => character?.id ?? (character?.avatar ? `avatar:${character.avatar}` : '');
const batchSize = 24;

export function createCharacterAvatar(ctx, character, className, type = 'avatar') {
    const fallback = element('span', character.name.slice(0, 1), `${className} play-avatar-fallback`);
    fallback.setAttribute('aria-hidden', 'true');
    if (!character.avatar) return fallback;
    const image = element('img', undefined, className); image.alt = ''; image.draggable = false;
    image.loading = 'lazy'; image.decoding = 'async';
    image.src = ctx().getThumbnailUrl?.(type, character.avatar)
        ?? `/thumbnail?type=${type}&file=${encodeURIComponent(character.avatar)}`;
    image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
    return image;
}

/** Shared catalog UI; selecting a character belongs to the calling page. */
export function createPlayCharacterPicker(ctx, { getCharacters, getSelected, onSelect, onBack,
    backLabel = '返回', isVisible = () => true, emptyText = () => '酒馆里还没有角色', renderMeta, signatureExtra }) {
    const mobile = matchMedia('(max-width: 760px)');
    const node = element('div', undefined, 'play-character-browser');
    const head = element('header', undefined, 'play-character-heading');
    const back = iconButton('left', backLabel, onBack); head.append(back, element('h2', '选择角色'));
    const searchLine = element('div', undefined, 'tea-search-line play-character-search');
    const searchLabel = element('label', undefined, 'tea-search-box');
    const search = element('input'); search.type = 'search'; search.placeholder = '搜索角色…'; search.setAttribute('aria-label', '搜索角色');
    searchLabel.append(glyph('search'), search); searchLine.append(searchLabel);
    const people = element('nav', undefined, 'play-people'); people.setAttribute('aria-label', '角色列表');
    const pagination = element('nav', undefined, 'tea-pagination play-people-pagination'); pagination.setAttribute('aria-label', '角色列表翻页');
    let query = '', page = 0, perPage = 8, limit = batchSize, scroll = 0, rowHeight = 0;
    let composing = false, searchTimer, lastMobile = mobile.matches;
    const matches = () => {
        const term = query.trim().toLocaleLowerCase();
        return getCharacters().filter(character => !term || character.name.toLocaleLowerCase().includes(term));
    };
    const signature = character => JSON.stringify([character.name, character.avatar, signatureExtra?.(character)]);
    const previous = iconButton('left', '上一页角色', () => { page--; render(true); });
    const next = iconButton('right', '下一页角色', () => { page++; render(true); });
    const jump = createPageJump({ label: '跳转角色页码', getPage: () => page,
        getPages: () => Math.max(1, Math.ceil(matches().length / perPage)),
        onSelect: target => { page = target; render(true); } });
    pagination.append(previous, jump.node, next); node.append(head, searchLine, people, pagination);
    function characterButton(character) {
        const button = textButton('', () => onSelect(character)); button.className = 'play-person';
        button.dataset.character = characterKey(character); button.dataset.signature = signature(character);
        button.setAttribute('aria-label', character.name); button.title = character.name;
        button.setAttribute('aria-pressed', String(characterKey(getSelected()) === characterKey(character)));
        const copy = element('span', undefined, 'play-person-copy'); copy.append(element('span', character.name, 'play-person-name'));
        button.append(createCharacterAvatar(ctx, character, 'play-avatar'), copy);
        const meta = renderMeta?.(character); if (meta) button.append(meta);
        return button;
    }
    function measure() {
        if (mobile.matches || !people.clientHeight || !people.clientWidth) return perPage;
        if (!rowHeight) {
            const row = people.querySelector('.play-person');
            const probe = !row && getCharacters().length ? characterButton(getCharacters()[0]) : null;
            if (probe) people.append(probe);
            rowHeight = (row ?? probe)?.getBoundingClientRect().height || 0;
            probe?.remove();
        }
        return rowHeight ? Math.max(1, Math.floor(people.clientHeight / rowHeight)) : perPage;
    }
    function render(resetScroll = false) {
        if (!isVisible()) return;
        if (lastMobile !== mobile.matches) { lastMobile = mobile.matches; rowHeight = 0; }
        if (resetScroll) scroll = 0;
        const count = measure();
        if (count !== perPage) { page = Math.floor(page * perPage / count); perPage = count; }
        const entries = matches(), pages = Math.max(1, Math.ceil(entries.length / perPage));
        page = Math.max(0, Math.min(page, pages - 1));
        const start = mobile.matches ? 0 : page * perPage;
        const shown = entries.slice(start, mobile.matches ? limit : start + perPage);
        const current = [...people.querySelectorAll('.play-person')];
        if (shown.length && current.length === shown.length && shown.every((c, i) => characterKey(c) === current[i].dataset.character)) {
            for (const [i, button] of current.entries()) {
                if (button.dataset.signature !== signature(shown[i])) button.replaceWith(characterButton(shown[i]));
                else button.setAttribute('aria-pressed', String(button.dataset.character === characterKey(getSelected())));
            }
        } else {
            people.replaceChildren(...shown.map(characterButton));
            if (!shown.length) people.append(element('p', query.trim() ? '没有找到这个角色' : emptyText(), 'play-people-empty'));
        }
        jump.update(); previous.disabled = page === 0; next.disabled = page >= pages - 1;
        if (people.scrollTop !== scroll) people.scrollTop = scroll;
    }
    function loadMore() {
        if (!mobile.matches || !isVisible() || !people.clientHeight || people.scrollHeight - people.scrollTop - people.clientHeight > 200) return;
        const entries = matches(); if (limit >= entries.length) return;
        const end = limit + batchSize;
        people.append(...entries.slice(limit, end).map(characterButton)); limit = end;
    }
    function applySearch() {
        clearTimeout(searchTimer); query = search.value; page = 0; limit = batchSize; render(true); loadMore();
    }
    search.addEventListener('compositionstart', () => { composing = true; clearTimeout(searchTimer); });
    search.addEventListener('compositionend', () => { composing = false; applySearch(); });
    search.addEventListener('input', event => {
        if (!composing && !event.isComposing) { clearTimeout(searchTimer); searchTimer = setTimeout(applySearch, 120); }
    });
    search.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); applySearch(); search.blur(); }
    });
    people.addEventListener('scroll', () => { scroll = people.scrollTop; loadMore(); }, { passive: true });
    return { node, people, back, render, layout() { render(); loadMore(); },
        focus() { back.focus({ preventScroll: true }); },
        suspend() { clearTimeout(searchTimer); jump.node.open = false; } };
}
