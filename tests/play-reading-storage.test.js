import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayReadingStorage } from '../play-reading-storage.js';

function memoryStorage() {
    const values = new Map(), writes = [];
    return { values, writes, getItem: key => values.get(key) ?? null,
        setItem(key, value) { writes.push(key); values.set(key, value); } };
}
const positions = () => new Map([['test-character', { bottom: false, anchor: 'round/assistant/p0', offset: 12 }]]);

test('旧阅读位置首次复制到独立存储，以后以新位置为准，不反复迁移', async () => {
    const storage = memoryStorage(), legacy = positions();
    const options = { getStorage: () => storage, getUserHandle: () => 'test-user' };
    const first = createPlayReadingStorage(options);
    assert.deepEqual(await first.read(legacy), legacy);
    const next = new Map([['test-character', { bottom: true }]]);
    first.save(next);
    first.save(next);
    assert.equal(storage.writes.length, 2, '相同位置不重复写入');
    assert.deepEqual(await createPlayReadingStorage(options).read(legacy), next);
    assert.deepEqual(legacy, positions(), '不修改迁移前的账号数据');
});

test('同一浏览器中的不同酒馆账号使用各自的阅读位置', async () => {
    const storage = memoryStorage();
    const a = createPlayReadingStorage({ getStorage: () => storage, getUserHandle: () => 'user:a' });
    const b = createPlayReadingStorage({ getStorage: () => storage, getUserHandle: () => 'user:b' });
    await a.read(positions());
    assert.deepEqual(await b.read([]), new Map());
    b.save(new Map([['other-character', { bottom: true }]]));
    assert.equal(storage.values.size, 2);
    assert.deepEqual(await createPlayReadingStorage({ getStorage: () => storage, getUserHandle: () => 'user:a' }).read([]), positions());
});

test('已有新存储即使为空，也不会重新恢复旧位置', async () => {
    const storage = memoryStorage();
    storage.values.set('teahouse-play-reading-v1:test-user', JSON.stringify({ format: 1, positions: [] }));
    const reader = createPlayReadingStorage({ getStorage: () => storage, getUserHandle: () => 'test-user' });
    assert.deepEqual(await reader.read(positions()), new Map());
    assert.equal(storage.writes.length, 0);
});

test('本地读取或迁移失败时保留原位置，不覆盖无法读取的新存储', async () => {
    const legacy = positions();
    const unavailable = createPlayReadingStorage({ getUserHandle: () => 'test-user', getStorage: () => {
        throw new Error('storage denied');
    } });
    await assert.rejects(unavailable.read(legacy), /storage denied/);
    assert.deepEqual(legacy, positions());
    const storage = memoryStorage();
    storage.values.set('teahouse-play-reading-v1:test-user', 'invalid json');
    await assert.rejects(createPlayReadingStorage({ getStorage: () => storage, getUserHandle: () => 'test-user' }).read(legacy));
    assert.equal(storage.writes.length, 0);
    assert.equal(storage.values.get('teahouse-play-reading-v1:test-user'), 'invalid json');
});

test('写入失败可以在下一次位置保存时重试', async () => {
    const storage = memoryStorage(), write = storage.setItem;
    const reader = createPlayReadingStorage({ getStorage: () => storage, getUserHandle: () => 'test-user' });
    await reader.read([]);
    storage.setItem = () => { throw new Error('quota exceeded'); };
    assert.throws(() => reader.save(positions()), /quota exceeded/);
    storage.setItem = write;
    reader.save(positions());
    assert.equal(storage.writes.length, 1);
});
