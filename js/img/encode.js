export const FORMATS = {
    jpeg: { label: 'JPG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
    png: { label: 'PNG', mime: 'image/png', ext: 'png', lossy: false },
    webp: { label: 'WEBP', mime: 'image/webp', ext: 'webp', lossy: true },
    avif: { label: 'AVIF', mime: 'image/avif', ext: 'avif', lossy: true },
};

export const isLossy = (format) => !!FORMATS[format]?.lossy;

// The save setting's name for people: null for "keep each file's format".
export const formatLabel = (format) => (format === 'original' ? null : format === 'pdf' ? 'PDF' : FORMATS[format]?.label);

// Binary search on quality for the best quality whose output fits in maxBytes.
// encode(quality) resolves to a Blob. Returns { blob, quality, fits }; when nothing fits, the smallest try.
export async function searchQuality(encode, maxBytes, { min = 0.05, max = 0.95, steps = 7 } = {}) {
    const top = await encode(max);
    if (top.size <= maxBytes) return { blob: top, quality: max, fits: true };
    let lo = min, hi = max, best = null;
    let smallest = top, smallestQ = max;
    for (let i = 0; i < steps; i++) {
        const q = (lo + hi) / 2;
        const blob = await encode(q);
        if (blob.size < smallest.size) { smallest = blob; smallestQ = q; }
        if (blob.size <= maxBytes) { best = { blob, quality: q, fits: true }; lo = q; } else hi = q;
    }
    if (best) return best;
    const bottom = await encode(min);
    if (bottom.size <= maxBytes) return { blob: bottom, quality: min, fits: true };
    return bottom.size < smallest.size ? { blob: bottom, quality: min, fits: false } : { blob: smallest, quality: smallestQ, fits: false };
}

export async function encodeCanvas(canvas, { format = 'jpeg', quality = 0.9, maxBytes = null }) {
    const { mime } = FORMATS[format] || FORMATS.jpeg;
    const encode = async (q) => {
        const blob = await canvas.convertToBlob({ type: mime, quality: q });
        // Browsers fall back to PNG for types they can't write.
        if (blob.type !== mime) throw new Error(`This browser can't save ${FORMATS[format].label} images`);
        return blob;
    };
    if (maxBytes && isLossy(format)) return searchQuality(encode, maxBytes, { max: Math.min(0.95, quality) });
    const blob = await encode(quality);
    return { blob, quality, fits: !maxBytes || blob.size <= maxBytes };
}

export function baseName(name) {
    return String(name || 'image').replace(/(.)\.[^./\\]+$/, '$1') || 'image';
}

export function outputName(name, format) {
    return `${baseName(name)}.${FORMATS[format]?.ext || format}`;
}

// Keeps names unique inside one ZIP: photo.jpg, photo (2).jpg, …
export function uniqueNames(names) {
    const used = new Set();
    return names.map((name) => {
        let candidate = name;
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
        for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
        used.add(candidate.toLowerCase());
        return candidate;
    });
}

export function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
