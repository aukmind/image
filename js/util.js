export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Like Promise.all over items, but with at most `limit` calls of fn in flight.
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export function readStored(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
    } catch {
        return fallback;
    }
}

export function writeStored(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {}
}

// iOS saves downloads to Files, so sharing (Save to Photos) comes first there.
export const isIOS = typeof navigator !== 'undefined'
    && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
