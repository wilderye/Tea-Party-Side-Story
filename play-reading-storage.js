function readPositions(text) {
    if (text === null) return null;
    const saved = JSON.parse(text);
    if (saved?.format !== 1 || !Array.isArray(saved.positions)) throw new Error('剧场阅读位置的保存格式无法读取。');
    return new Map(saved.positions.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string'
        && entry[1] && typeof entry[1] === 'object'));
}

/** Reading positions belong to this browser/account, never Tavern's settings save. */
export function createPlayReadingStorage({ getUserHandle = async () => {
    const { getCurrentUserHandle } = await import('/scripts/user.js');
    return getCurrentUserHandle();
}, getStorage = () => globalThis.localStorage } = {}) {
    let key, storage, previous;
    return {
        async read(legacyPositions) {
            const handle = await getUserHandle();
            if (typeof handle !== 'string' || !handle) throw new Error('未能确认酒馆账号，阅读位置暂未保存。');
            key = `teahouse-play-reading-v1:${encodeURIComponent(handle)}`;
            storage = getStorage();
            const text = storage.getItem(key), saved = readPositions(text);
            previous = text;
            if (saved) return saved;
            const positions = new Map(legacyPositions);
            // Keep the old account value intact until the independent copy succeeds.
            if (positions.size) this.save(positions);
            return positions;
        },
        save(positions) {
            if (!key || !storage) throw new Error('剧场阅读位置的存储尚未准备好。');
            const text = JSON.stringify({ format: 1, positions: [...positions] });
            if (text === previous) return;
            storage.setItem(key, text);
            previous = text;
        },
    };
}
