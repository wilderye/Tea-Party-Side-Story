export function readPlayElementPosition(feed, node, inset = 0) {
    return node.getBoundingClientRect().top - feed.getBoundingClientRect().top - inset;
}

export function restorePlayElementPosition(feed, node, offset, inset, setScroll) {
    if (!node?.getClientRects().length) return;
    const target = feed.scrollTop + readPlayElementPosition(feed, node, inset) - offset;
    if (Math.abs(target - feed.scrollTop) > 0.5) setScroll(target);
}
