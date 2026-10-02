import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLibrary } from '../scripts/build-library.js';
import { validateManifest, readPack, collectPacks, selectTheatre, findEntries } from '../library.js';
const entry = (id, month, body = '让 {{char}} 与 {{user}} 一起露营') => ({
    id, publishedAt: `2026-${month}-03T00:00:00.000Z`, type: 'preset', title: '露营', author: '茶友', body,
});
test('编辑历史投稿仅改变所属月包；破损更新被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'teahouse-'));
    try {
        const source = join(root, 'source'), output = join(root, 'output'); await mkdir(source);
        const a = entry('123456789012345678', '09'), b = entry('223456789012345678', '10');
        for (const item of [a,b]) await writeFile(join(source, `${item.id}.json`), JSON.stringify(item));
        const first = validateManifest(await buildLibrary(source, output));
        await writeFile(join(source, `${a.id}.json`), JSON.stringify({...a, body: '改为野餐'}));
        const second = validateManifest(await buildLibrary(source, output));
        assert.notEqual(first.packs[0].path, second.packs[0].path);
        assert.equal(first.packs[1].path, second.packs[1].path);
        const pack = second.packs[0], text = await readFile(join(output, pack.path), 'utf8');
        assert.equal((await readPack(text, pack))[0].body, '改为野餐');
        await assert.rejects(readPack(text + ' ', pack), /校验失败/);
        assert.throws(() => collectPacks([[a],[a]]), /编号重复/);
    } finally { await rm(root, {recursive:true, force:true}); }
});
test('抽取排除紧邻上次，续写保留存在的原条，删除后重抽', () => {
    const a=entry('123456789012345678','09'), b=entry('223456789012345678','10');
    const pool=new Map([[a.id,a],[b.id,b]]);
    assert.equal(selectTheatre(pool,a.id,undefined,()=>0).id,b.id);
    assert.equal(selectTheatre(pool,b.id,a.id,()=>0).id,a.id);
    pool.delete(a.id);
    assert.equal(selectTheatre(pool,b.id,a.id,()=>0).id,b.id);
    assert.equal(selectTheatre(new Map(),null),null);
});
test('搜索正文和署名，收藏按收藏时间排序', () => {
    const a=entry('123456789012345678','09'), b={...entry('223456789012345678','10'),author:'小茶'};
    const pool=new Map([[a.id,a],[b.id,b]]);
    assert.equal(findEntries(pool,{tab:'preset',query:'小茶'})[0].id,b.id);
    assert.equal(findEntries(pool,{tab:'preset',query:'露营'}).length,2);
    assert.deepEqual(findEntries(pool,{tab:'favorites',favorites:{[a.id]:20,[b.id]:10}}).map(x=>x.id),[a.id,b.id]);
});

 test('SHA256在分块边界、中文和空文本上与Node标准实现一致', async()=>{
    const {createHash}=await import('node:crypto');const {hash}=await import('../library.js');
    for(const n of [0,1,55,56,63,64,65,1000,10000]) {
        const text='茶'.repeat(n)+'a'.repeat(n);
        assert.equal(await hash(text),createHash('sha256').update(text).digest('hex'));
    }
 });
