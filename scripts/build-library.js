import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateEntry, hash, FORMAT, MAX_PACK_BYTES } from '../library.js';
export async function buildLibrary(sourceDir, outputDir) {
    const months = new Map();
    const ids = new Set();
    for (const file of (await readdir(sourceDir)).sort()) {
        if (!/^\d{16,22}\.json$/.test(file)) continue;
        const entry = validateEntry(JSON.parse(await readFile(resolve(sourceDir, file), 'utf8')));
        if (file !== `${entry.id}.json` || ids.has(entry.id)) throw new Error('源文件编号不一致');
        ids.add(entry.id);
        // First publication month uses the same Asia/Shanghai day boundary as the publisher.
        const month = new Date(Date.parse(entry.publishedAt) + 8 * 3600_000).toISOString().slice(0, 7);
        if (!months.has(month)) months.set(month, []);
        months.get(month).push(entry);
    }
    await mkdir(resolve(outputDir, 'packs'), { recursive: true });
    const packs = [];
    for (const [month, entries] of [...months].sort()) {
        let batch = [], bytes = 2, part = 0;
        const flush = async () => {
            if (!batch.length) return;
            const text = JSON.stringify(batch), sha256 = await hash(text);
            const path = `packs/${month}-${part++}-${sha256}.json`;
            packs.push({ path, sha256, bytes: Buffer.byteLength(text), count: batch.length });
            await writeFile(resolve(outputDir, path), text);
            batch = []; bytes = 2;
        };
        for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
            const size = Buffer.byteLength(JSON.stringify(entry));
            if (bytes + size + (batch.length ? 1 : 0) > MAX_PACK_BYTES) await flush();
            bytes += size + (batch.length ? 1 : 0); batch.push(entry);
        }
        await flush();
    }
    const manifest = { format: FORMAT, packs };
    await writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(resolve(outputDir, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n/manifest.json\n  Cache-Control: no-cache\n/packs/*\n  Cache-Control: public, max-age=31536000, immutable\n');
    return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const manifest = await buildLibrary(resolve(process.argv[2] || 'submissions'), resolve(process.argv[3] || 'dist'));
    console.log(`Built ${manifest.packs.length} packs`);
}
