// The directory is committed after a complete round file. A failed upload
// therefore never replaces a readable round with half of a new version.
export const PLAY_HISTORY_INDEX = 'teahouse-play-index.json';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const statuses = ['unfinished', 'complete', 'stopped', 'failed'];
const clone = value => structuredClone(value);
const isText = value => typeof value === 'string' && !!value.trim();
const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isId = value => typeof value === 'string' && idPattern.test(value);
const assert = (condition, message = '演出记录文件格式不正确，未覆盖原文件') => {
    if (!condition) throw new PlayHistoryError('invalid_history', message);
};

export class PlayHistoryError extends Error {
    constructor(code, message, options) { super(message, options); this.name = 'PlayHistoryError'; this.code = code; }
}

export function playRoundFile(id, revision) {
    assert(isId(id) && isId(revision));
    return `teahouse-play-${id}-${revision}.json`;
}

export function playFavoriteFile(id, revision) {
    assert(isId(id) && isId(revision));
    return `teahouse-play-favorite-${id}-${revision}.json`;
}

function readFavoriteSource(value) {
    assert(value && isId(value.roundId) && isId(value.resultId) && isDate(value.startedAt));
    return { roundId: value.roundId, resultId: value.resultId, startedAt: value.startedAt };
}

function readFavoriteInfo(value) {
    assert(value && isId(value.id) && typeof value.title === 'string' && value.title.length <= 100
        && typeof value.firstLine === 'string' && value.firstLine.length <= 320
        && isText(value.characterName) && isDate(value.savedAt));
    return { id: value.id, title: value.title, firstLine: value.firstLine,
        characterName: value.characterName, savedAt: value.savedAt, source: readFavoriteSource(value.source) };
}

function readFavorite(value) {
    assert(value?.format === 1 && isText(value.text) && isDate(value.updatedAt));
    const result = { format: 1, ...readFavoriteInfo(value), text: value.text, updatedAt: value.updatedAt };
    if (value.cleaned !== undefined) result.cleaned = Boolean(value.cleaned);
    return result;
}

export function readPlayOrigin(value) {
    if (value == null) return null;
    assert(isText(value.id) && isText(value.title), '小剧场原文的编号或标题不完整');
    return { id: value.id, title: value.title };
}

// A request's full settings can contain API keys and proxy passwords. Only
// these explanatory fields are allowed into the history, including on retries.
export function readPlayContext(value) {
    assert(value && isText(value.chatId) && ['tavern', 'custom'].includes(value.apiMode), '本次生成的聊天或 API 信息不完整');
    const result = { chatId: value.chatId, apiMode: value.apiMode };
    for (const key of ['characterName', 'presetName', 'model', 'source']) {
        if (value[key] !== undefined) {
            assert(typeof value[key] === 'string');
            result[key] = value[key];
        }
    }
    return result;
}

// Only native reasoning fields may accompany a result. Never persist response
// objects or the captured settings, which may contain credentials.
export function readPlayReasoning(value) {
    assert(value && typeof value === 'object' && !Array.isArray(value));
    const result = {};
    for (const key of ['reasoning', 'api', 'model']) {
        if (value[key] !== undefined) { assert(typeof value[key] === 'string'); result[key] = value[key]; }
    }
    if (value.reasoning_signature !== undefined) {
        assert(value.reasoning_signature === null || typeof value.reasoning_signature === 'string');
        result.reasoning_signature = value.reasoning_signature;
    }
    if (value.reasoning_duration !== undefined) {
        assert(value.reasoning_duration === null || (Number.isFinite(value.reasoning_duration) && value.reasoning_duration >= 0));
        result.reasoning_duration = value.reasoning_duration;
    }
    return result;
}

function readResult(value) {
    assert(value && isId(value.id) && isDate(value.startedAt) && statuses.includes(value.status)
        && typeof value.text === 'string');
    assert(value.status === 'unfinished' ? value.finishedAt === null : isDate(value.finishedAt));
    if (value.status === 'complete') assert(isText(value.text));
    const result = {
        id: value.id, startedAt: value.startedAt, finishedAt: value.finishedAt,
        status: value.status, text: value.text, context: readPlayContext(value.context),
    };
    if (value.extra !== undefined) result.extra = readPlayReasoning(value.extra);
    if (value.error !== undefined) {
        assert(value.error && isText(value.error.code) && isText(value.error.message));
        result.error = { code: value.error.code, message: value.error.message };
    }
    return result;
}

export function readPlayRound(value) {
    assert(value?.format === 1 && isId(value.id) && isId(value.characterId)
        && (value.prompt === null || isText(value.prompt)) && isDate(value.createdAt) && Array.isArray(value.results)
        && (value.prompt !== null || value.results.length > 0));
    const results = value.results.map(readResult);
    assert(new Set(results.map(result => result.id)).size === results.length);
    return {
        format: 1, id: value.id, characterId: value.characterId, prompt: value.prompt,
        origin: readPlayOrigin(value.origin), createdAt: value.createdAt, results,
    };
}

export function readPlayIndex(value) {
    assert(value?.format === 1 && Array.isArray(value.characters) && Array.isArray(value.rounds));
    const characterIds = new Set(), avatars = new Set(), roundIds = new Set();
    const characters = value.characters.map(character => {
        assert(character && isId(character.id) && isText(character.name)
            && (character.avatar === null || isText(character.avatar)) && !characterIds.has(character.id));
        assert(character.avatar === null || !avatars.has(character.avatar));
        characterIds.add(character.id);
        if (character.avatar !== null) avatars.add(character.avatar);
        return { id: character.id, name: character.name, avatar: character.avatar };
    });
    const rounds = value.rounds.map(round => {
        assert(round && isId(round.id) && isId(round.revision) && characterIds.has(round.characterId)
            && isDate(round.createdAt) && isDate(round.lastPlayedAt) && !roundIds.has(round.id));
        roundIds.add(round.id);
        return { id: round.id, revision: round.revision, characterId: round.characterId,
            createdAt: round.createdAt, lastPlayedAt: round.lastPlayedAt };
    });
    const favoriteIds = new Set();
    assert(value.favorites === undefined || Array.isArray(value.favorites));
    const favorites = (value.favorites ?? []).map(favorite => {
        const info = readFavoriteInfo(favorite);
        assert(isId(favorite.revision) && !favoriteIds.has(info.id));
        favoriteIds.add(info.id);
        return { ...info, revision: favorite.revision };
    });
    return { format: 1, characters, rounds, favorites };
}

function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** readFile returns null only for HTTP 404. Other read failures must throw. */
export function createPlayHistory({ readFile, writeFile, removeFile, withLock = run => run(), uuid = randomId, onWarning = () => {} }) {
    let queue = Promise.resolve();
    const serialize = (run, signal) => {
        signal?.throwIfAborted();
        let stopWaiting = () => {};
        const next = queue.catch(() => {}).then(() => {
            signal?.throwIfAborted();
            return withLock(() => {
                // Cancelling a queued request also prevents its delayed callback
                // from writing. Once a commit starts, let it finish completely.
                signal?.throwIfAborted(); stopWaiting();
                return run();
            }, signal);
        });
        queue = next;
        if (!signal) return next;
        return new Promise((resolve, reject) => {
            const abort = () => { stopWaiting(); reject(signal.reason); };
            stopWaiting = () => signal.removeEventListener('abort', abort);
            signal.addEventListener('abort', abort, { once: true });
            next.then(value => { stopWaiting(); resolve(value); }, error => { stopWaiting(); reject(error); });
        });
    };
    async function index() {
        const text = await readFile(PLAY_HISTORY_INDEX);
        if (text === null) return { format: 1, characters: [], rounds: [], favorites: [] };
        try { return readPlayIndex(JSON.parse(text)); }
        catch (error) {
            if (error instanceof PlayHistoryError) throw error;
            throw new PlayHistoryError('invalid_history', '演出记录目录无法解析，未覆盖原文件', { cause: error });
        }
    }
    async function readRoundFromRow(row, retry = true) {
        if (!row) throw new PlayHistoryError('round_missing', '这轮演出记录已不存在');
        const text = await readFile(playRoundFile(row.id, row.revision));
        // Another tab may have committed and cleaned up this revision since
        // our directory read. Retry only when its directory entry has changed.
        if (text === null && retry) {
            const current = (await index()).rounds.find(item => item.id === row.id);
            if (current && current.revision !== row.revision) return readRoundFromRow(current, false);
        }
        if (text === null) throw new PlayHistoryError('round_missing', '这轮演出记录的正文文件缺失，未覆盖原文件');
        let round;
        try { round = readPlayRound(JSON.parse(text)); }
        catch (cause) { throw new PlayHistoryError('invalid_history', '这轮演出记录无法解析，未覆盖原文件', { cause }); }
        assert(round.id === row.id && round.characterId === row.characterId && round.createdAt === row.createdAt);
        return round;
    }
    async function readFavoriteFromRow(row, retry = true) {
        if (!row) throw new PlayHistoryError('favorite_missing', '这份演出记录收藏已不存在');
        const text = await readFile(playFavoriteFile(row.id, row.revision));
        if (text === null && retry) {
            const current = (await index()).favorites.find(item => item.id === row.id);
            if (current && current.revision !== row.revision) return readFavoriteFromRow(current, false);
        }
        if (text === null) throw new PlayHistoryError('favorite_missing', '这份收藏的正文文件缺失，未覆盖原文件');
        let favorite;
        try { favorite = readFavorite(JSON.parse(text)); }
        catch (cause) { throw new PlayHistoryError('invalid_favorite', '这份收藏无法解析，未覆盖原文件', { cause }); }
        assert(JSON.stringify(readFavoriteInfo(favorite)) === JSON.stringify(readFavoriteInfo(row)));
        return { ...favorite, revision: row.revision };
    }
    async function writeIndex(next) {
        const text = JSON.stringify(readPlayIndex(next));
        try { await writeFile(PLAY_HISTORY_INDEX, text); }
        catch (error) {
            // A dropped response does not prove the server failed to save.
            // Confirm the exact directory before reporting an unsaved result.
            let saved;
            try { saved = await readFile(PLAY_HISTORY_INDEX); }
            catch (verificationError) {
                if (error && typeof error === 'object') error.verificationError = verificationError;
                else onWarning('核实演出目录是否保存', verificationError);
            }
            if (saved !== text) throw error;
            onWarning('保存演出目录时连接报错，已核实文件保存成功', error);
        }
    }
    async function commitDocument(directory, rows, document, fileName, info) {
        const previous = rows.find(item => item.id === document.id);
        const row = { ...info, revision: uuid() };
        await writeFile(fileName(document.id, row.revision), JSON.stringify(document));
        if (previous) rows[rows.indexOf(previous)] = row;
        else rows.push(row);
        await writeIndex(directory);
        // Cleanup is not part of the save transaction. Never remove a revision
        // whose directory commit was not acknowledged or verified.
        if (previous && removeFile) {
            try { await removeFile(fileName(previous.id, previous.revision)); }
            catch (error) { onWarning('清理演出记录的旧文件', error); }
        }
        return row;
    }
    async function commitRound(directory, value) {
        const round = readPlayRound(value);
        const lastPlayedAt = directory.rounds.find(item => item.id === round.id)?.lastPlayedAt ?? round.createdAt;
        await commitDocument(directory, directory.rounds, round, playRoundFile,
            { id: round.id, characterId: round.characterId, createdAt: round.createdAt,
                lastPlayedAt: round.results.reduce((latest, result) => Date.parse(result.startedAt) > Date.parse(latest) ? result.startedAt : latest, lastPlayedAt) });
        return clone(round);
    }
    async function commitMessageRemoval(directory, round) {
        if (round.prompt !== null || round.results.length) return commitRound(directory, round);
        const previous = directory.rounds.find(item => item.id === round.id);
        directory.rounds = directory.rounds.filter(item => item !== previous);
        await writeIndex(directory);
        if (removeFile) {
            try { await removeFile(playRoundFile(previous.id, previous.revision)); }
            catch (error) { onWarning('清理已删除演出的旧文件', error); }
        }
        return null;
    }
    async function commitFavorite(directory, value) {
        const favorite = readFavorite(value);
        const row = await commitDocument(directory, directory.favorites, favorite, playFavoriteFile, readFavoriteInfo(favorite));
        return { ...clone(favorite), revision: row.revision };
    }

    return {
        async listCharacters() {
            const directory = await index();
            const latest = new Map();
            for (const round of directory.rounds) {
                const previous = latest.get(round.characterId);
                if (!previous || Date.parse(round.lastPlayedAt) > Date.parse(previous)) latest.set(round.characterId, round.lastPlayedAt);
            }
            return directory.characters.map(character => ({ ...character,
                lastPlayedAt: latest.get(character.id) ?? null,
            })).sort((a, b) => (Date.parse(b.lastPlayedAt) || 0) - (Date.parse(a.lastPlayedAt) || 0) || a.id.localeCompare(b.id));
        },
        async listRounds(characterId) {
            assert(isId(characterId));
            const directory = await index();
            return directory.rounds.filter(round => round.characterId === characterId)
                .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        },
        async getRound(id) {
            assert(isId(id));
            return readRoundFromRow((await index()).rounds.find(round => round.id === id));
        },
        async listFavorites() {
            return (await index()).favorites.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || b.id.localeCompare(a.id));
        },
        async getFavorite(id) {
            assert(isId(id));
            return readFavoriteFromRow((await index()).favorites.find(item => item.id === id));
        },
        addFavorite({ roundId, resultId, startedAt, expectedText, text, firstLine }) {
            const source = readFavoriteSource({ roundId, resultId, startedAt });
            assert(typeof expectedText === 'string' && typeof firstLine === 'string');
            if (text !== undefined) assert(isText(text), '收藏内容不能为空。');
            return serialize(async () => {
                const directory = await index();
                const round = await readRoundFromRow(directory.rounds.find(item => item.id === roundId));
                const result = round.results.find(item => item.id === resultId);
                if (!result) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                assert(result.status !== 'unfinished' && isText(result.text), '请在这份回复结束并保存后收藏');
                if (result.startedAt !== startedAt || result.text !== expectedText) {
                    throw new PlayHistoryError('favorite_conflict', '这条回复已在其他窗口修改，请重新打开记录后收藏。');
                }
                const previous = directory.favorites.find(item => JSON.stringify(item.source) === JSON.stringify(source));
                if (previous) return readFavoriteFromRow(previous);
                const now = new Date().toISOString();
                const favoriteText = text !== undefined ? text : result.text;
                return commitFavorite(directory, { format: 1, id: uuid(), source,
                    characterName: directory.characters.find(item => item.id === round.characterId).name,
                    title: round.origin?.title ?? '', firstLine, text: favoriteText,
                    cleaned: text !== undefined, savedAt: now, updatedAt: now });
            });
        },
        editFavorite(id, update, expectedRevision) {
            assert(isId(id) && isId(expectedRevision) && typeof update?.title === 'string' && typeof update?.firstLine === 'string');
            assert(isText(update.text), '收藏内容不能为空。');
            const patch = clone(update);
            return serialize(async () => {
                const directory = await index();
                const row = directory.favorites.find(item => item.id === id);
                const current = await readFavoriteFromRow(row);
                const next = readFavorite({ ...current, title: patch.title.trim(), text: patch.text, firstLine: patch.firstLine, cleaned: true });
                if (next.title === current.title && next.text === current.text && next.firstLine === current.firstLine && next.cleaned === current.cleaned) return current;
                if (row.revision !== expectedRevision) {
                    throw new PlayHistoryError('favorite_edit_conflict', '这份收藏已在其他窗口修改。请保留当前草稿，重新打开后核对内容。');
                }
                next.updatedAt = new Date().toISOString();
                return commitFavorite(directory, next);
            });
        },
        removeFavorite(id) {
            assert(isId(id));
            return serialize(async () => {
                const directory = await index();
                const previous = directory.favorites.find(item => item.id === id);
                if (!previous) return;
                directory.favorites = directory.favorites.filter(item => item !== previous);
                await writeIndex(directory);
                if (removeFile) {
                    try { await removeFile(playFavoriteFile(previous.id, previous.revision)); }
                    catch (error) { onWarning('清理已取消收藏的旧文件', error); }
                }
            });
        },
        begin({ roundId, replaceResultId, continueResultId, expectedText, characterId, character, prompt, origin = null, resultId, startedAt, context }, { signal } = {}) {
            // Copy caller-owned values before waiting for any other write.
            const input = clone({ roundId, replaceResultId, continueResultId, expectedText, characterId, character, prompt, origin, resultId, startedAt, context: readPlayContext(context) });
            assert(isText(input.character?.avatar) && isText(input.character?.name));
            assert(isId(input.resultId) && isDate(input.startedAt));
            if (input.roundId !== undefined) assert(isId(input.roundId));
            if (input.replaceResultId !== undefined) assert(isId(input.replaceResultId) && isId(input.roundId));
            if (input.continueResultId !== undefined) assert(isId(input.continueResultId) && isId(input.roundId));
            if (!input.roundId) assert(isText(input.prompt), '请先输入小剧场提示词');
            return serialize(async () => {
                const directory = await index();
                let owner = directory.characters.find(item => item.avatar === input.character.avatar);
                if (input.characterId && owner?.id !== input.characterId) {
                    throw new PlayHistoryError('other_character', '只能为酒馆当前聊天的角色生成；其他角色只能查看历史');
                }
                let round;
                if (input.roundId) {
                    round = await readRoundFromRow(directory.rounds.find(item => item.id === input.roundId));
                    if (!owner || round.characterId !== owner.id) {
                        throw new PlayHistoryError('other_character', '这轮记录不属于酒馆当前聊天的角色，只能查看历史');
                    }
                    if (round.prompt === null) throw new PlayHistoryError('prompt_missing', '这条用户消息已删除，无法使用原提示词生成。');
                } else {
                    if (!owner) {
                        owner = { id: uuid(), avatar: input.character.avatar, name: input.character.name };
                        directory.characters.push(owner);
                    }
                    round = { format: 1, id: uuid(), characterId: owner.id, prompt: input.prompt,
                        origin: readPlayOrigin(input.origin), createdAt: input.startedAt, results: [] };
                }
                owner.name = input.character.name;
                if (input.continueResultId) {
                    const target = round.results.findIndex(item => item.id === input.continueResultId);
                    if (target < 0) throw new PlayHistoryError('result_missing', '这份结果已在其他窗口删除或替换，请重新打开记录后再试。');
                    const existing = round.results[target];
                    if (!existing.text.trim()) throw new PlayHistoryError('empty_result', '这份结果没有正文，无法续写；请使用重新生成。');
                    if (input.expectedText !== undefined && existing.text !== input.expectedText) {
                        throw new PlayHistoryError('edit_conflict', '这份结果已在其他窗口修改，请重新读取后再续写。');
                    }
                    round.results[target] = { ...existing, status: 'unfinished', finishedAt: null, context: input.context };
                    delete round.results[target].error;
                    return commitRound(directory, round);
                }
                assert(!round.results.some(result => result.id === input.resultId), '生成编号重复，请重新发送');
                const result = { id: input.resultId, startedAt: input.startedAt, finishedAt: null,
                    status: 'unfinished', text: '', context: input.context };
                if (input.replaceResultId) {
                    const target = round.results.findIndex(item => item.id === input.replaceResultId);
                    if (target < 0) throw new PlayHistoryError('result_missing', '这份结果已在其他窗口替换，请重新打开记录后再试。');
                    // Replacement keeps the slot but uses a fresh generation ID,
                    // so a late save from the old request cannot overwrite it.
                    round.results[target] = result;
                } else round.results.push(result);
                return commitRound(directory, round);
            }, signal);
        },
        saveResult(roundId, resultId, update) {
            assert(isId(roundId) && isId(resultId));
            const patch = clone(update);
            return serialize(async () => {
                const directory = await index();
                const row = directory.rounds.find(item => item.id === roundId);
                if (!row) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                const round = await readRoundFromRow(row);
                const result = round.results.find(item => item.id === resultId);
                if (!result) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                const next = readResult({ ...result, ...patch, id: result.id, startedAt: result.startedAt,
                    context: patch.context ? { ...result.context, ...readPlayContext(patch.context) } : result.context });
                assert(next.context.chatId === result.context.chatId && next.context.apiMode === result.context.apiMode
                    && next.context.characterName === result.context.characterName, '保存结果时不能更换它所属的聊天或 API 选择');
                // A delayed streaming checkpoint must never replace a finished
                // result. An identical terminal write is a harmless save retry.
                if (result.status !== 'unfinished') {
                    if (next.status === 'unfinished' || JSON.stringify(next) === JSON.stringify(result)) return clone(round);
                    throw new PlayHistoryError('result_finished', '这份结果已结束，不能覆盖；请通过重新生成替换当前结果');
                }
                if (JSON.stringify(next) === JSON.stringify(result)) return clone(round);
                round.results[round.results.indexOf(result)] = next;
                return commitRound(directory, round);
            });
        },
        editPrompt(roundId, text, expectedText) {
            assert(isId(roundId) && typeof expectedText === 'string');
            assert(isText(text), '提示词不能为空。');
            return serialize(async () => {
                const directory = await index();
                const round = await readRoundFromRow(directory.rounds.find(item => item.id === roundId));
                if (round.prompt === null) throw new PlayHistoryError('prompt_missing', '这条用户消息已删除。请保留当前草稿，重新打开记录后核对。');
                if (round.prompt === text) return clone(round);
                if (round.prompt !== expectedText) throw new PlayHistoryError('edit_conflict', '这条用户消息已在其他窗口修改。请保留当前草稿，重新打开编辑框后核对内容。');
                round.prompt = text;
                return commitRound(directory, round);
            });
        },
        editResult(roundId, resultId, text, expectedText) {
            assert(isId(roundId) && isId(resultId) && typeof expectedText === 'string');
            assert(isText(text), '回复正文不能为空。');
            return serialize(async () => {
                const directory = await index();
                const round = await readRoundFromRow(directory.rounds.find(item => item.id === roundId));
                const result = round.results.find(item => item.id === resultId);
                if (!result) throw new PlayHistoryError('result_missing', '这次生成结果已不存在');
                if (result.status === 'unfinished') throw new PlayHistoryError('result_unfinished', '这条回复尚未完成保存，请先结束生成并保存后再编辑。');
                if (result.text === text) return clone(round);
                if (result.text !== expectedText) throw new PlayHistoryError('edit_conflict', '这条回复已在其他窗口修改。请保留当前草稿，重新打开编辑框后核对内容。');
                result.text = text;
                return commitRound(directory, round);
            });
        },
        removePrompt(roundId, expectedText) {
            assert(isId(roundId) && typeof expectedText === 'string');
            return serialize(async () => {
                const directory = await index(), row = directory.rounds.find(item => item.id === roundId);
                if (!row) return null;
                const round = await readRoundFromRow(row);
                if (round.prompt === null) return clone(round);
                if (round.prompt !== expectedText) throw new PlayHistoryError('delete_conflict', '这条用户消息已在其他窗口修改，请重新打开记录后再删除。');
                round.prompt = null;
                return commitMessageRemoval(directory, round);
            });
        },
        removeReply(roundId, expectedResults) {
            assert(isId(roundId) && Array.isArray(expectedResults)
                && expectedResults.every(result => isId(result?.id) && typeof result.text === 'string'));
            const expected = expectedResults.map(({ id, text }) => ({ id, text }));
            return serialize(async () => {
                const directory = await index(), row = directory.rounds.find(item => item.id === roundId);
                if (!row) return null;
                const round = await readRoundFromRow(row);
                if (!round.results.length) return clone(round);
                if (round.results.length !== expected.length || round.results.some((result, index) =>
                    result.id !== expected[index].id || result.text !== expected[index].text)) {
                    throw new PlayHistoryError('delete_conflict', '这条 AI 消息的内容或生成版本已在其他窗口改变，请重新打开记录后再删除。');
                }
                round.results = [];
                return commitMessageRemoval(directory, round);
            });
        },
        renameCharacter(oldAvatar, newAvatar, name) {
            assert(isText(oldAvatar) && (newAvatar === null || isText(newAvatar)));
            return serialize(async () => {
                const directory = await index();
                const character = directory.characters.find(item => item.avatar === oldAvatar);
                if (!character) return;
                if (newAvatar !== null && directory.characters.some(item => item !== character && item.avatar === newAvatar)) {
                    throw new PlayHistoryError('character_conflict', '改名后的角色头像标识已属于另一份游玩历史，未合并记录');
                }
                character.avatar = newAvatar;
                if (isText(name)) character.name = name;
                await writeIndex(directory);
            });
        },
    };
}
