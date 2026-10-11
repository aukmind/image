import { isHeif, probeHeif, displaySize, clapRect, videoColorSpace, singleItemHeif } from './heif.js';
import { renderOps, outputGeometry, fitSize, rotateCanvas, flipCanvas, scaleCanvas } from './render.js';
import { encodeCanvas } from './encode.js';
import { headerSize, ORIENTATION_PROBE } from './size.js';
import { heifPaths } from './decode.js';

const LIBHEIF_URL = 'https://esm.sh/libheif-js@1.19.8/wasm-bundle';

const makeCanvas = (w, h) => new OffscreenCanvas(w, h);
// native: does createImageBitmap read HEIC here (Safari)? codecs: WebCodecs support per decoder config.
const caps = { native: null, codecs: new Map() };

let libheif = null;
function loadLibheif() {
    libheif ??= import(LIBHEIF_URL).then(m => m.default || m).catch((err) => {
        libheif = null;
        throw new Error(`Couldn't download the HEIC decoder (${err.message})`);
    });
    return libheif;
}

const coded = (code, message) => Object.assign(new Error(message), { code });

function decoderConfig(desc) {
    const config = { codec: desc.codec, description: desc.hvcC, codedWidth: desc.tileWidth, codedHeight: desc.tileHeight, optimizeForLatency: true };
    const colorSpace = videoColorSpace(desc.nclx);
    if (colorSpace) config.colorSpace = colorSpace;
    return config;
}

const codecKey = (desc) => `${desc.codec}|${desc.tileWidth}x${desc.tileHeight}|${desc.bitDepth}`;

function webcodecsSupported(desc) {
    if (typeof VideoDecoder === 'undefined' || desc.alpha) return Promise.resolve(false);
    const key = codecKey(desc);
    if (!caps.codecs.has(key)) {
        caps.codecs.set(key, VideoDecoder.isConfigSupported(decoderConfig(desc)).then(r => !!r.supported).catch(() => false));
    }
    return caps.codecs.get(key);
}

// A canvas for the coded image at `scale`; place(i, image) draws tile i on whole-pixel edges so scaled tiles leave no seams.
function tileCanvas(desc, scale) {
    const canvas = makeCanvas(Math.max(1, Math.round(desc.width * scale)), Math.max(1, Math.round(desc.height * scale)));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const place = (i, image) => {
        const r = Math.floor(i / desc.cols), c = i % desc.cols;
        const x0 = Math.round(c * desc.tileWidth * scale), x1 = Math.round((c + 1) * desc.tileWidth * scale);
        const y0 = Math.round(r * desc.tileHeight * scale), y1 = Math.round((r + 1) * desc.tileHeight * scale);
        ctx.drawImage(image, 0, 0, desc.tileWidth, desc.tileHeight, x0, y0, x1 - x0, y1 - y0);
    };
    return { canvas, place };
}

async function decodeWebCodecs(desc, place) {
    let failure = null;
    let count = 0;
    const decoder = new VideoDecoder({
        output: (frame) => {
            try {
                place(Number(frame.timestamp), frame);
                count++;
            } finally {
                frame.close();
            }
        },
        error: (err) => { failure ??= err; },
    });
    try {
        decoder.configure(decoderConfig(desc));
        desc.tiles.forEach((data, i) => decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data })));
        await decoder.flush();
    } catch (err) {
        failure ??= err;
    } finally {
        if (decoder.state !== 'closed') decoder.close();
    }
    if (failure) throw failure;
    if (count !== desc.tiles.length) throw new Error(`Hardware decoder returned ${count} of ${desc.tiles.length} tiles`);
}

// Interleaved RGBA straight from libheif, cropped to the item size. libheif-js's display() assumes the decoded
// frame is exactly the item size and throws from a timer (uncatchable) when the coded frame is padded.
function libheifPixels(lib, image) {
    const res = lib.heif_js_decode_image2(image.handle, lib.heif_colorspace.heif_colorspace_RGB, lib.heif_chroma.heif_chroma_interleaved_RGBA);
    if (!res || res.code) throw new Error('HEIC decode failed');
    try {
        const plane = res.channels.find(c => c.id === lib.heif_channel.heif_channel_interleaved);
        if (!plane) throw new Error('HEIC decode returned no pixels');
        const w = Math.min(plane.width, image.get_width()), h = Math.min(plane.height, image.get_height());
        const out = new ImageData(w, h);
        for (let y = 0; y < h; y++) out.data.set(plane.data.subarray(y * plane.stride, y * plane.stride + w * 4), y * w * 4);
        return out;
    } finally {
        lib.heif_image_release(res.image);
    }
}

// libheif one tile at a time (each wrapped in a tiny HEIF), so a 50 MP photo never sits in memory at full size.
async function decodeWasmTiles(desc, place) {
    const lib = await loadLibheif();
    const decoder = new lib.HeifDecoder();
    let scratch = null;
    for (let i = 0; i < desc.tiles.length; i++) {
        const file = singleItemHeif({ hvcC: desc.hvcC, width: desc.tileWidth, height: desc.tileHeight, nclx: desc.nclx }, desc.tiles[i]);
        const [image] = decoder.decode(file.buffer);
        if (!image) throw new Error('The HEIC decoder could not read a tile');
        const pixels = libheifPixels(lib, image);
        image.free?.();
        const w = pixels.width, h = pixels.height;
        if (!scratch || scratch.width !== w || scratch.height !== h) scratch = makeCanvas(w, h);
        scratch.getContext('2d').putImageData(pixels, 0, 0);
        place(i, scratch);
    }
}

// Whole file through libheif: it applies the transforms and keeps alpha. For images with an alpha plane.
async function decodeWasmWhole(bytes, scale) {
    const lib = await loadLibheif();
    const images = new lib.HeifDecoder().decode(bytes.slice().buffer);
    const image = images.find(i => i.is_primary?.()) || images[0];
    if (!image) throw new Error('No image found in this HEIC file');
    const pixels = libheifPixels(lib, image);
    images.forEach(i => i.free?.());
    const full = makeCanvas(pixels.width, pixels.height);
    full.getContext('2d').putImageData(pixels, 0, 0);
    return downscale(full, scale);
}

// clap / irot / imir in property order. irot turns anticlockwise; imir axis 1 mirrors left-right (as libheif does).
function applyTransforms(canvas, desc) {
    let fw = desc.width, fh = desc.height;
    for (const t of desc.transforms) {
        if (t.type === 'clap') {
            const r = clapRect(t, fw, fh);
            const sx = canvas.width / fw, sy = canvas.height / fh;
            const x = Math.round(r.x * sx), y = Math.round(r.y * sy);
            const w = Math.max(1, Math.min(canvas.width - x, Math.round(r.width * sx))), h = Math.max(1, Math.min(canvas.height - y, Math.round(r.height * sy)));
            const out = makeCanvas(w, h);
            out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
            canvas = out;
            fw = r.width;
            fh = r.height;
        } else if (t.type === 'irot' && t.angle) {
            canvas = rotateCanvas(canvas, 360 - t.angle * 90, makeCanvas);
            if (t.angle % 2) [fw, fh] = [fh, fw];
        } else if (t.type === 'imir') {
            canvas = flipCanvas(canvas, t.axis ? 'h' : 'v', makeCanvas);
        }
    }
    return canvas;
}

async function decodeDesc(desc, scale, path, bytes) {
    if (path === 'wasm' && desc.alpha) return decodeWasmWhole(bytes, scale);
    const { canvas, place } = tileCanvas(desc, scale);
    if (path === 'webcodecs') await decodeWebCodecs(desc, place);
    else await decodeWasmTiles(desc, place);
    return applyTransforms(canvas, desc);
}

// Decodes one image of a parsed HEIF (primary or thumbnail) at `scale`, trying each path in turn.
// Returns { image, path, width, height } where width/height is the full display size.
async function decodeHeif({ file, bytes, parsed, part = 'primary', scale = 1, forced = null }) {
    const desc = parsed[part];
    if (!desc) throw new Error(`No ${part} image in this file`);
    const full = displaySize(desc);
    const paths = heifPaths({ native: part === 'primary' ? caps.native : false, webcodecs: await webcodecsSupported(desc), forced });
    if (forced === 'webcodecs' && !paths.includes('webcodecs')) throw new Error('WebCodecs HEVC is not available here');
    let lastError = null;
    for (const path of paths) {
        try {
            if (path === 'native') {
                const bitmap = await createImageBitmap(file);
                caps.native = true;
                return { image: downscale(bitmap, scale), path, width: bitmap.width, height: bitmap.height };
            }
            return { image: await decodeDesc(desc, scale, path, bytes), path, ...full };
        } catch (err) {
            lastError = err;
            if (path === 'native' && !forced) caps.native = false;
            if (path === 'webcodecs' && !forced) caps.codecs.set(codecKey(desc), Promise.resolve(false));
        }
    }
    throw lastError;
}

// A bitmap at `scale`, as a canvas; the full-size bitmap is freed right away (it can be ~200 MB on a phone).
function downscale(bitmap, scale) {
    if (scale >= 1) return bitmap;
    const canvas = scaleCanvas(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)), makeCanvas);
    bitmap.close?.();
    return canvas;
}

// A drawable as an OffscreenCanvas this code may draw on or encode (bitmaps can't be).
function ownCanvas(image) {
    if (image instanceof OffscreenCanvas) return image;
    const out = makeCanvas(image.width, image.height);
    out.getContext('2d').drawImage(image, 0, 0);
    return out;
}

let webp = null;
const webpOk = () => (webp ??= canEncode('image/webp'));

const hasTransparency = (image) => {
    const ctx = makeCanvas(32, 32).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
};

// Previews: WebP (small, keeps transparency). Where it can't be written (Safari), JPEG unless there's
// transparency to show: PNG of a big stage preview is slow to make and to decode. `opaque`: known not to have any.
async function encodePreview(canvas, opaque = false, quality = 0.85) {
    const type = (await webpOk()) ? 'image/webp' : opaque || !hasTransparency(canvas) ? 'image/jpeg' : 'image/png';
    return ownCanvas(canvas).convertToBlob({ type, quality });
}

async function previewBlob(image, maxSide, quality = 0.85) {
    const size = fitSize(image.width, image.height, maxSide);
    return { blob: await encodePreview(scaleCanvas(image, size.width, size.height, makeCanvas), false, quality), width: size.width, height: size.height };
}

async function readBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

// Enough of a file for its type and, in JPEGs, the size after a big Exif block with a preview.
const HEAD_BYTES = 256 * 1024;

// Browsers disagree on whether a resizing decode applies Exif orientation, so it's tried once on a tiny rotated
// JPEG (red stored left, shown on top) before being trusted with rotated photos.
let resizeOrients = null;
function resizeKeepsOrientation() {
    resizeOrients ??= (async () => {
        try {
            const bytes = Uint8Array.from(atob(ORIENTATION_PROBE), c => c.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { resizeWidth: 8, resizeHeight: 16, resizeQuality: 'high' });
            const ctx = makeCanvas(8, 16).getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const shape = bitmap.width === 8 && bitmap.height === 16;
            bitmap.close();
            const [top, bottom] = [ctx.getImageData(4, 3, 1, 1).data, ctx.getImageData(4, 12, 1, 1).data];
            return shape && top[0] > 150 && top[2] < 110 && bottom[2] > 150 && bottom[0] < 110;
        } catch {
            return false;
        }
    })();
    return resizeOrients;
}

// `blob` decoded straight at w × h (a fraction of the memory a 48 MP photo takes in full), or null when that
// can't be trusted here: the caller then decodes in full and scales down.
async function decodeAt(blob, size, w, h) {
    if (!size || (size.rotated && !(await resizeKeepsOrientation()))) return null;
    try {
        const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        if (Math.abs(bitmap.width - w) <= 1 && Math.abs(bitmap.height - h) <= 1) return bitmap;
        bitmap.close();
    } catch {}
    return null;
}

// Size + thumbnail for a file the browser opens itself. With the size in the header, the thumbnail is decoded
// small directly instead of the whole photo.
// `blob` (a file the browser decodes itself, `size` its displayed size) at about `need` of that size.
// Straight at the reduced size when that can be trusted here; else in full, then scaled down.
async function decodeScaled(blob, size, need) {
    if (need >= 0.9) return createImageBitmap(blob);
    const small = size?.width && await decodeAt(blob, size, Math.max(1, Math.round(size.width * need)), Math.max(1, Math.round(size.height * need)));
    return small || downscale(await createImageBitmap(blob), need);
}

// Size + thumbnail of a file the browser opens itself. `size` (from the header, when known) lets the thumbnail be
// decoded small directly.
async function nativeResult(file, size, thumbSize) {
    const image = size ? await decodeScaled(file, size, Math.min(1, thumbSize / Math.max(size.width, size.height))) : await createImageBitmap(file);
    const width = size?.width ?? image.width, height = size?.height ?? image.height;
    const { blob: thumb } = await previewBlob(image, thumbSize);
    image.close?.();
    return { width, height, originalWidth: width, originalHeight: height, proxy: null, thumb, rotated: !!size?.rotated };
}

// Opens a file: its size, a thumbnail, and for HEIC the browser can't decode, a proxy. Also what renders need to know
// about the file (`heif`, `rotated`), so they never read its header again.
async function prepare({ file, thumbSize, proxyPixels }) {
    forgetDecoded();
    const head = await readBytes(file.slice(0, HEAD_BYTES));
    if (!isHeif(head)) {
        try {
            return { ...(await nativeResult(file, headerSize(head), thumbSize)), heif: false };
        } catch {
            throw coded('unsupported', `${file.name} isn't an image this browser can open`);
        }
    }
    // Safari decodes HEIC itself: try that before reading the whole file.
    if (caps.native !== false) {
        try {
            const result = await nativeResult(file, null, thumbSize);
            caps.native = true;
            return { ...result, heif: true };
        } catch {
            caps.native = false;
        }
    }
    const bytes = await readBytes(file);
    const parsed = probeHeif(bytes);
    if (!parsed) throw coded('unsupported', `${file.name} isn't an image this browser can open`);

    const full = displaySize(parsed.primary);
    // The embedded thumbnail first, so the grid fills in long before the full decode is done.
    if (parsed.thumbnail) {
        try {
            const t = displaySize(parsed.thumbnail);
            const { image } = await decodeHeif({ file, bytes, parsed, part: 'thumbnail', scale: Math.min(1, thumbSize / Math.max(t.width, t.height)) });
            const { blob } = await previewBlob(image, thumbSize);
            self.postMessage({ progress: { thumb: blob, width: full.width, height: full.height } });
        } catch (err) {
            console.warn('Embedded thumbnail failed', err);
        }
    }

    const scale = Math.min(1, Math.sqrt(proxyPixels / (full.width * full.height)));
    const { image } = await decodeHeif({ file, bytes, parsed, scale });
    const proxy = await image.convertToBlob(parsed.primary.alpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.95 });
    const { blob: thumb } = await previewBlob(image, thumbSize);
    return { width: image.width, height: image.height, originalWidth: full.width, originalHeight: full.height, proxy, thumb, heif: true, rotated: false };
}

const registeredFonts = new Set();
async function registerFonts(fonts) {
    const map = {};
    for (const f of fonts || []) {
        if (f.blob && !registeredFonts.has(f.family) && self.fonts) {
            const face = new FontFace(f.family, await f.blob.arrayBuffer());
            await face.load();
            self.fonts.add(face);
            registeredFonts.add(f.family);
        }
        map[f.key] = f.css;
    }
    return map;
}

// Ops with their images decoded, and a release() for those bitmaps once the render is done.
async function prepareOps(ops) {
    const bitmaps = [];
    const ready = await Promise.all(ops.map(async (op) => {
        if (op.type !== 'watermark' || !op.imageBlob) return op;
        const image = await createImageBitmap(op.imageBlob);
        bitmaps.push(image);
        return { ...op, image };
    }));
    return { ops: ready, release: () => bitmaps.forEach(b => b.close()) };
}

// Previews of one image while sliders move: keep its decoded source so only the ops are redone.
// One per worker (the pool sends an image's previews to the worker that has it); a big job frees it.
let decoded = null;
const forgetDecoded = () => {
    decoded?.image.close?.();
    decoded = null;
};

// `info` (from prepare, via the store): { width, height, heif, rotated } of this source.
async function decodeSource(source, need, info) {
    if (info.heif && caps.native !== true) {
        const bytes = await readBytes(source);
        const parsed = probeHeif(bytes);
        if (parsed) return (await decodeHeif({ file: source, bytes, parsed, scale: need })).image;
    }
    return decodeScaled(source, info, need);
}

// Decodes `source` at the size the result needs (never more than full), runs the ops, encodes.
async function render({ source, width, height, heif = false, rotated = false, opaque = false, ops, fonts, target, encode, cacheKey = null }) {
    const fontMap = await registerFonts(fonts);
    const geo = outputGeometry(ops, width, height);
    const fit = target === 'output' ? 1 : Math.min(1, target.maxSide / Math.max(geo.width, geo.height));
    const need = Math.min(1, geo.scale * fit);
    const cacheable = cacheKey && target !== 'output';
    if (!cacheable) forgetDecoded();
    let image;
    if (cacheable && decoded?.key === cacheKey && decoded.need >= need && decoded.need <= need * 2) image = decoded.image;
    else {
        image = await decodeSource(source, need, { width, height, heif, rotated });
        if (cacheable) {
            forgetDecoded();
            decoded = { key: cacheKey, need, image };
        }
    }
    const prepared = await prepareOps(ops);
    const out = renderOps(image, prepared.ops, { baseWidth: width, baseHeight: height, makeCanvas, target, fonts: fontMap });
    try {
        return await encodeResult(out, encode, opaque);
    } finally {
        prepared.release();
        // The result may be the decoded image itself, so it's freed only once encoded.
        if (!cacheable) image.close?.();
    }
}

async function encodeResult(out, encode, opaque) {
    if (!encode) return { blob: await encodePreview(out.canvas, opaque), width: out.width, height: out.height };

    let canvas = ownCanvas(out.canvas);
    if (encode.format === 'jpeg') {
        // JPEG has no alpha: put transparent areas on white rather than black, under what's drawn.
        const ctx = canvas.getContext('2d');
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
    }
    let result = await encodeCanvas(canvas, encode);
    // A size limit quality alone can't reach: shrink the pixels until the file fits.
    for (let tries = 0; encode.maxBytes && !result.fits && tries < 6; tries++) {
        const f = Math.max(0.3, Math.min(0.9, Math.sqrt(encode.maxBytes / result.blob.size) * 0.95));
        canvas = scaleCanvas(canvas, Math.max(1, Math.round(canvas.width * f)), Math.max(1, Math.round(canvas.height * f)), makeCanvas);
        result = { ...(await encodeCanvas(canvas, encode)), shrunk: true };
    }
    return { ...result, width: canvas.width, height: canvas.height };
}

function sample(image, points) {
    const canvas = makeCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return points.map(([x, y]) => {
        const px = Math.round(x * (image.width - 1)), py = Math.round(y * (image.height - 1));
        const r = 2;
        const x0 = Math.max(0, px - r), y0 = Math.max(0, py - r);
        const d = ctx.getImageData(x0, y0, Math.min(image.width - x0, 2 * r + 1), Math.min(image.height - y0, 2 * r + 1)).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
        const n = d.length / 4;
        return sum.map(v => Math.round(v / n));
    });
}

const SAMPLE_POINTS = [[0.15, 0.15], [0.85, 0.15], [0.5, 0.5], [0.15, 0.85], [0.85, 0.85]];

// Times one decode path on one file: parse, embedded thumbnail, full-size decode; plus colour samples to compare paths.
async function bench({ file, path }) {
    const out = { path, ok: false };
    const t0 = performance.now();
    try {
        const bytes = await readBytes(file);
        const parsed = probeHeif(bytes);
        const heif = !!parsed;
        if (heif) {
            out.tiles = `${parsed.primary.cols}×${parsed.primary.rows} × ${parsed.primary.tileWidth}px`;
            out.codec = parsed.primary.codec;
        }
        out.parseMs = performance.now() - t0;
        if (heif && parsed.thumbnail && path !== 'native') {
            const t1 = performance.now();
            await decodeHeif({ file, bytes, parsed, part: 'thumbnail', forced: path });
            out.thumbMs = performance.now() - t1;
        }
        const t2 = performance.now();
        const { image, width, height } = heif
            ? await decodeHeif({ file, bytes, parsed, forced: path })
            : { image: await createImageBitmap(file), width: 0, height: 0 };
        out.decodeMs = performance.now() - t2;
        out.width = width || image.width;
        out.height = height || image.height;
        out.samples = sample(image, SAMPLE_POINTS);
        out.preview = (await previewBlob(image, 480, 0.9)).blob;
        image.close?.();
        out.ok = true;
    } catch (err) {
        out.error = err?.message || String(err);
    }
    out.totalMs = performance.now() - t0;
    return out;
}

async function canEncode(type) {
    try {
        const canvas = new OffscreenCanvas(2, 2);
        canvas.getContext('2d');
        return (await canvas.convertToBlob({ type })).type === type;
    } catch {
        return false;
    }
}

async function capabilities() {
    return { videoDecoder: typeof VideoDecoder !== 'undefined', webp: await webpOk(), avif: await canEncode('image/avif') };
}

const HANDLERS = { prepare, render, bench, capabilities };

self.onmessage = async ({ data: { type, payload } }) => {
    try {
        self.postMessage({ result: await HANDLERS[type](payload) });
    } catch (err) {
        self.postMessage({ error: err?.message || String(err), code: err?.code });
    }
};
