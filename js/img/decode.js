import { WorkerPool } from './pool.js';
import { isIOS } from '../util.js';

export const THUMB_SIZE = 480;
const PROXY_PIXELS = 24e6;

// HEIC decoders to try, fastest first. native/webcodecs: true, false or null (not probed yet).
export function heifPaths({ native = null, webcodecs = false, forced = null } = {}) {
    if (forced) return [forced];
    const paths = [];
    if (native !== false) paths.push('native');
    if (webcodecs) paths.push('webcodecs');
    paths.push('wasm');
    return paths;
}

// Workers each hold a decoder and a decoded preview. iOS doesn't report memory and kills tabs early: one worker there.
export function poolSize(cores = globalThis.navigator?.hardwareConcurrency || 2, memory = globalThis.navigator?.deviceMemory ?? (isIOS ? 2 : 4)) {
    return Math.max(1, Math.min(cores - 1, memory >= 4 ? 2 : 1));
}

// Main-thread face of the worker pool. Images are { source: Blob, width, height } (the size of that source).
export function createEngine() {
    const pool = new WorkerPool(new URL('./worker.js', import.meta.url), poolSize());
    return {
        // Resolves { width, height, proxy, thumb, originalWidth, originalHeight }; onThumb gets an early thumbnail.
        prepare(file, { onThumb = null, priority = 1 } = {}) {
            return pool.run('prepare', { file, thumbSize: THUMB_SIZE, proxyPixels: PROXY_PIXELS },
                { priority, large: true, onProgress: p => p.thumb && onThumb?.(p) });
        },
        // A small rendering of the edited image (thumbnails, stage preview). Resolves { blob, width, height }.
        // cacheKey: the same image previewed again (slider moves) reuses its decoded pixels in the worker.
        preview(image, ops, { maxSide = THUMB_SIZE, fonts = [], tag = null, priority = 2, cacheKey = null } = {}) {
            // Large (one at a time): a big result, or a big source that may have to be decoded in full first.
            const fullDecode = image.width * image.height > 16e6 && (image.heif || image.rotated);
            return pool.run('render', { ...image, ops, fonts, target: { maxSide }, encode: null, cacheKey },
                { priority, large: maxSide > 1200 || fullDecode, tag, affinity: cacheKey });
        },
        // The real output. encode: { format, quality, maxBytes }. Resolves { blob, width, height, quality, fits }.
        render(image, ops, encode, { fonts = [] } = {}) {
            return pool.run('render', { ...image, ops, fonts, target: 'output', encode }, { priority: 0, large: true });
        },
        bench(file, path) {
            return pool.run('bench', { file, path }, { priority: 3, large: true });
        },
        capabilities() {
            return pool.run('capabilities', {}, { priority: 4 });
        },
        cancel(tag) {
            pool.cancel(tag);
        },
    };
}
