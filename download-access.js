import { sha256 } from './sha256.js';

// Yield between short batches so HTTP/LAN installations need neither Web Crypto
// nor a busy main thread. This is an obstacle to direct downloads, not identity.
export async function solveChallenge(nonce, bits) {
    if (!/^[a-f0-9]{32}$/.test(nonce) || bits !== 14) throw new Error('不支持的下载验证');
    const encoder = new TextEncoder(), started = performance.now();
    for (let counter = 0; ; ) {
        const slice = performance.now();
        do {
            const digest = sha256(encoder.encode(`${nonce}:${counter}`));
            if (Number.parseInt(digest.slice(0, 4), 16) < 4) return counter;
            counter++;
        } while (performance.now() - slice < 6);
        if (performance.now() - started > 30_000) throw new Error('下载验证超时，请稍后重新更新');
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

export async function createLibraryRequest(base, request) {
    const challenge = await (await request(new URL('access/challenge', base), { cache: 'no-store' })).json();
    const counter = await solveChallenge(challenge.nonce, challenge.bits);
    const result = await (await request(new URL('access/redeem', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: challenge.challenge, counter }),
    })).json();
    if (typeof result.token !== 'string' || !result.token) throw new Error('下载凭证无效');
    return url => {
        const target = new URL(url, base);
        if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
            throw new Error('剧场文件地址不属于当前剧场库');
        }
        return request(target, { cache: 'no-store', headers: { Authorization: `Bearer ${result.token}` } });
    };
}
