import { TOOLS } from './tools.js';
import { createEngine, THUMB_SIZE } from './img/decode.js';
import { outputGeometry } from './img/render.js';
import { FORMATS, outputName, uniqueNames, formatSize, baseName } from './img/encode.js';
import { isPdf, pdfToImages, imagesToPdf } from './img/pdf.js';
import { stripJpegMetadata, stripPngMetadata, exifInsertion, buildExif, jpegOrientation, readMeta, TAG } from './img/meta.js';
import { customFont } from '/shared/fonts.js';
import { pickFiles } from '/shared/dom.js';
import { loadScript } from '/shared/load.js';
import { sendHandoff } from '/shared/handoff.js';
import { readStored, writeStored, isIOS, plural } from './util.js';

const { reactive, markRaw, toRaw } = Vue;

// Workers can't clone Vue proxies: ops are unwrapped all the way down when they're stored or previewed.
function plain(value) {
    value = toRaw(value);
    if (Array.isArray(value)) return value.map(plain);
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    return value;
}

const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|avif|hei[cf]|hif)$/i;
// iOS's photo picker turns HEIC into JPEG by itself when HEIC isn't listed; elsewhere .heic must be listed to be pickable.
const ACCEPT = isIOS ? 'image/*,.pdf,application/pdf' : 'image/*,.heic,.heif,.hif,image/heic,image/heif,.pdf,application/pdf';
const MAX_HISTORY = 40;
const PREVIEW_CACHE = 8;
const ZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

// Old links: the single-screen converter used format names.
const LEGACY = { heic: ['convert', 'jpeg'], jpg: ['convert', 'jpeg'], png: ['convert', 'png'], webp: ['convert', 'webp'], pdf: ['convert', 'pdf'] };

// metaDefault: what happens to the metadata of photos not edited in the Metadata tool: 'none' | 'safe' (all but location) | 'all'.
// target: Compress's size limit in KB (applies only when saving from Compress).
const DEFAULT_SAVE = { format: 'original', quality: 90, target: null, highest: false, metaDefault: 'none' };
export const SOFTWARE = 'https://aukmind.com/image';

// Tags kept under a default policy, from the tags the file has.
export function policyTags(original, policy) {
    if (!original || policy === 'none') return {};
    return Object.fromEntries(Object.entries(original).filter(([k]) => TAG[k] && k !== 'Software' && (policy === 'all' || TAG[k].group !== 'location')));
}

function sourceKind(file) {
    const t = file.type, n = file.name || '';
    if (/jpe?g/.test(t) || /\.(jpe?g|jfif)$/i.test(n)) return 'jpeg';
    if (/png/.test(t) || /\.png$/i.test(n)) return 'png';
    if (/webp/.test(t) || /\.webp$/i.test(n)) return 'webp';
    if (/hei[cf]/.test(t) || /\.(hei[cf]|hif)$/i.test(n)) return 'heic';
    if (/avif/.test(t) || /\.avif$/i.test(n)) return 'avif';
    if (/gif/.test(t) || /\.gif$/i.test(n)) return 'gif';
    return 'other';
}

const isImageFile = (file) => file.type.startsWith('image/') || IMAGE_EXT.test(file.name || '');
const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'jpeg' : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : null);

let nextId = 1;

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// `data` (a Blob or bytes) with the Exif block spliced in, as a Blob: the image data itself is never copied.
async function withExif(data, tiff, format) {
    const head = data instanceof Blob ? new Uint8Array(await data.slice(0, 64).arrayBuffer()) : data;
    const { at, bytes } = exifInsertion(head, tiff, format);
    const part = (a, b) => (data instanceof Blob ? data.slice(a, b) : data.subarray(a, b));
    return new Blob([part(0, at), bytes, part(at)], { type: FORMATS[format].mime });
}

export function createStore(message) {
    const engine = createEngine();
    const hashId = location.hash.slice(1);
    const legacy = LEGACY[hashId];
    const hashTool = legacy ? legacy[0] : hashId;
    if (legacy) window.history.replaceState(null, '', `#${hashTool}`);
    const knownTool = TOOLS.some(t => t.id === hashTool);
    // The hash also remembers the last tool across reloads; only a link someone opened counts as choosing it.
    const linked = knownTool && performance.getEntriesByType('navigation')[0]?.type === 'navigate';

    const save = { ...DEFAULT_SAVE, ...readStored('image.save', {}) };
    if (legacy?.[1]) save.format = legacy[1];

    const state = reactive({
        images: [],
        selected: [],
        tool: knownTool ? hashTool : 'convert',
        toolChosen: linked,
        save,
        thumbSize: readStored('image.thumbSize', window.innerWidth < 600 ? 140 : 190),
        thumbs: {}, // id -> url of the latest rendered thumbnail
        undoCount: 0,
        busy: null,
        notice: null,
        viewer: { show: false, ids: [], index: 0 },
        caps: { webp: true, avif: false, share: false },
    });

    // Each step: the image order and every image's { ops, meta } before the change.
    const undoStack = [];
    const previews = new Map(); // id -> Map(ops array -> url)
    const requested = new Map(); // id -> ops array being rendered
    const metaCache = new WeakMap(); // File -> Promise of readMeta()
    const fontBlobs = new Map(); // font key -> Promise of a Blob of the font file
    let lastRun = Promise.resolve();
    let noticeTimer = null;

    engine.capabilities().then(({ webp, avif }) => {
        Object.assign(state.caps, { webp, avif });
        if (state.save.format === 'avif' && !avif) state.save.format = 'jpeg';
    }).catch(() => {});
    try {
        state.caps.share = !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'a.jpg', { type: 'image/jpeg' })] });
    } catch {}

    const snapshot = (label) => {
        undoStack.push({ label, order: state.images.slice(), items: new Map(state.images.map(i => [i, { ops: i.ops, meta: i.meta }])) });
        if (undoStack.length > MAX_HISTORY) undoStack.shift();
        state.undoCount = undoStack.length;
    };

    const fontsFor = async (ops) => {
        const keys = new Set();
        for (const op of ops) {
            if (op.type === 'watermark' && op.font) keys.add(op.font);
            if (op.type === 'annotate') for (const el of op.elements || []) if (el.font) keys.add(el.font);
        }
        const fonts = [];
        for (const key of keys) {
            const font = customFont(key);
            if (!font) continue;
            // As a Blob: posted to the worker by reference, read there only the first time.
            if (key.startsWith('file:') && !fontBlobs.has(key)) fontBlobs.set(key, font.source.regular().then(b => new Blob([b])));
            const family = font.css.match(/^"([^"]+)"/)?.[1] || font.label;
            fonts.push({ key, css: font.css, family, blob: key.startsWith('file:') ? await fontBlobs.get(key) : null });
        }
        return fonts;
    };

    // What a render decodes: the proxy, or the file itself, with what prepare learnt about it.
    const imageFor = (item, highest = false) => {
        const opaque = item.kind === 'jpeg' || item.kind === 'heic';
        return (highest && item.proxy) || !item.proxy
            ? { source: item.file, width: item.originalWidth, height: item.originalHeight, heif: item.heif, rotated: item.rotated, opaque }
            : { source: item.proxy, width: item.width, height: item.height, heif: false, rotated: false, opaque };
    };

    // A thumbnail needs at most THUMB_SIZE source pixels across: unless a crop zooms in, the prepared thumbnail is enough.
    const thumbSource = (item, ops) => {
        const image = imageFor(item);
        const geo = outputGeometry(ops, image.width, image.height);
        const need = geo.scale * Math.min(1, THUMB_SIZE / Math.max(geo.width, geo.height));
        return need * Math.max(image.width, image.height) <= THUMB_SIZE * 1.05 && item.thumbBlob
            ? { ...image, source: item.thumbBlob, heif: false, rotated: false }
            : image;
    };

    const cachePreview = (id, ops, url) => {
        if (!previews.has(id)) previews.set(id, new Map());
        const cache = previews.get(id);
        cache.set(ops, url);
        while (cache.size > PREVIEW_CACHE) {
            const [oldOps, oldUrl] = cache.entries().next().value;
            cache.delete(oldOps);
            if (oldUrl !== state.thumbs[id]) URL.revokeObjectURL(oldUrl);
        }
    };

    const requestThumb = async (item) => {
        const ops = item.ops;
        if (requested.get(item.id) === ops || item.status !== 'ready') return;
        requested.set(item.id, ops);
        try {
            const { blob } = await engine.preview(thumbSource(item, ops), ops, { maxSide: THUMB_SIZE, fonts: await fontsFor(ops), tag: `thumb:${item.id}` });
            const url = URL.createObjectURL(blob);
            cachePreview(item.id, ops, url);
            if (item.ops === ops) state.thumbs[item.id] = url;
        } catch (err) {
            if (!err.cancelled) console.error('Thumbnail failed', err);
        } finally {
            if (requested.get(item.id) === ops) requested.delete(item.id);
        }
    };

    const prepare = (item, priority) => {
        engine.prepare(item.file, {
            priority,
            onThumb: (p) => {
                if (item.thumb) return;
                item.thumb = URL.createObjectURL(p.thumb);
                if (!item.width) Object.assign(item, { width: p.width, height: p.height, originalWidth: p.width, originalHeight: p.height });
            },
        }).then((r) => {
            const early = item.thumb;
            Object.assign(item, {
                width: r.width, height: r.height, originalWidth: r.originalWidth, originalHeight: r.originalHeight,
                heif: r.heif, rotated: r.rotated, proxy: r.proxy ? markRaw(r.proxy) : null,
                thumb: URL.createObjectURL(r.thumb), thumbBlob: markRaw(r.thumb), status: 'ready',
            });
            if (early) URL.revokeObjectURL(early);
            if (item.ops.length) requestThumb(item);
        }).catch((err) => {
            console.error(err);
            message.error(err.code === 'unsupported' ? err.message : `Couldn't open ${item.name}: ${err.message}`);
            state.images = state.images.filter(i => i !== item);
            state.selected = state.selected.filter(id => id !== item.id);
        });
    };

    // One undo step that sets `field` ('ops' or 'meta') of each ready image to fn(item, current).
    // summary: text, or (count of images changed) => text. Images still loading are left out, and said so.
    const change = (field, items, fn, summary) => {
        const waiting = items.filter(i => i.status !== 'ready').length;
        items = items.filter(i => i.status === 'ready');
        if (waiting) message.warning(`${plural(waiting, 'image')} still loading ${waiting > 1 ? 'were' : 'was'} left unchanged`);
        if (!items.length) return false;
        if (typeof summary === 'function') summary = summary(items.length);
        snapshot(summary);
        for (const item of items) {
            const next = fn(item, item[field]);
            if (next) item[field] = markRaw(plain(next));
        }
        store.undoNotice(summary);
        return true;
    };

    const store = {
        state,
        message,

        setTool(id) {
            state.tool = id;
            state.toolChosen = true;
            window.history.replaceState(null, '', `#${id}`);
        },

        setThumbSize(size) {
            state.thumbSize = size;
            writeStored('image.thumbSize', size);
        },

        setSave(patch) {
            Object.assign(state.save, patch);
            writeStored('image.save', state.save);
        },

        get totalSize() {
            return state.images.reduce((n, i) => n + i.size, 0);
        },

        // The selection, or every image when nothing is selected.
        targets(ids = state.selected) {
            const set = new Set(ids);
            return set.size ? state.images.filter(i => set.has(i.id)) : state.images.slice();
        },

        // A toast; sticky ones stay until their action is used or another toast replaces them.
        notify(text, actionLabel = null, action = null, { sticky = false } = {}) {
            clearTimeout(noticeTimer);
            state.notice = { text, actionLabel, action: action && markRaw(action) };
            if (!sticky) noticeTimer = setTimeout(() => { state.notice = null; }, 7000);
        },

        undoNotice(text) {
            store.notify(text, 'Undo', () => {
                state.notice = null;
                store.undo();
            });
        },

        async pick() {
            return store.addFiles(await pickFiles({ accept: ACCEPT, multiple: true }));
        },

        async pickCamera() {
            return store.addFiles(await pickFiles({ accept: 'image/*', capture: 'environment' }));
        },

        // Files join the end in the order they came; PDFs are expanded into one image per page.
        async addFiles(list) {
            const files = [];
            let skipped = 0;
            for (const file of list) {
                if (isPdf(file)) {
                    const pages = await store.run(`Reading ${file.name}`, progress => pdfToImages(file, progress));
                    if (pages) files.push(...pages);
                } else if (isImageFile(file)) files.push(file);
                else skipped++;
            }
            if (skipped) message.warning(`Skipped ${plural(skipped, 'file')}: not an image`);
            if (!files.length) return [];
            const first = !state.images.length;
            // After "Close all" the history is still undoable, so adding must be a step too.
            if (!first || undoStack.length) snapshot('Add');
            const items = files.map(file => reactive({
                id: `i${nextId++}`, name: file.name, file: markRaw(file), size: file.size, kind: sourceKind(file),
                status: 'loading', width: 0, height: 0, originalWidth: 0, originalHeight: 0,
                heif: false, rotated: false, proxy: null, ops: markRaw([]), meta: null, thumb: null, thumbBlob: null,
            }));
            state.images.push(...items);
            // First file first: the top of the grid fills in before the bottom.
            items.forEach((item, i) => prepare(item, 1 + (items.length - i) / (items.length + 1)));
            if (!state.toolChosen) store.setTool('convert');
            const what = files.length === 1 ? files[0].name : plural(files.length, 'image');
            if (first) message.success(`Opened ${what}`);
            else store.undoNotice(`Added ${what}`);
            return items;
        },

        // Pixel edits: ops(item, current) returns the new op list (or null to leave it).
        edit(items, ops, summary) {
            return change('ops', items, ops, summary);
        },

        addOp(items, op, summary) {
            return store.edit(items, (item, ops) => [...ops, typeof op === 'function' ? op(item) : op], summary);
        },

        // Metadata edits: tags(item, current) returns the tags to save ({} = remove all).
        editMeta(items, tags, summary) {
            return change('meta', items, tags, summary);
        },

        remove(ids, summary = null) {
            const set = new Set(ids);
            if (!set.size) return;
            snapshot('Remove');
            state.images = state.images.filter(i => !set.has(i.id));
            state.selected = state.selected.filter(id => !set.has(id));
            store.undoNotice(summary || `Removed ${plural(set.size, 'image')}`);
        },

        reorder(from, to) {
            snapshot('Reorder');
            const list = state.images.slice();
            list.splice(to, 0, ...list.splice(from, 1));
            state.images = list;
        },

        clear() {
            if (!state.images.length) return;
            snapshot('Close');
            const n = state.images.length;
            state.images = [];
            state.selected = [];
            state.toolChosen = false;
            store.undoNotice(`Closed ${plural(n, 'image')}`);
        },

        undo() {
            const step = undoStack.pop();
            state.undoCount = undoStack.length;
            if (!step) return;
            state.images = step.order;
            for (const [item, { ops, meta }] of step.items) Object.assign(item, { ops, meta });
            const ids = new Set(state.images.map(i => i.id));
            state.selected = state.selected.filter(id => ids.has(id));
            message.success(`Undid: ${step.label.toLowerCase()}`);
        },

        // Thumbnail of the image as edited, or the latest one while that renders (see wantThumb).
        thumb(item) {
            if (!item.ops.length) return item.thumb;
            return previews.get(item.id)?.get(item.ops) || state.thumbs[item.id] || item.thumb;
        },

        // A card near the screen wants its thumbnail to match the image's edits.
        wantThumb(item) {
            if (item.ops.length && !previews.get(item.id)?.has(item.ops)) requestThumb(item);
        },

        // The card left the screen: a thumbnail render still waiting in the queue isn't needed any more.
        dropThumb(item) {
            if (requested.has(item.id)) engine.cancel(`thumb:${item.id}`);
        },

        // A larger rendering for the stage or viewer (draft ops welcome). Resolves an object URL the caller revokes.
        // A newer request for the same image replaces one still waiting in the queue.
        async previewUrl(item, ops, maxSide) {
            const tag = `stage:${item.id}`;
            engine.cancel(tag);
            const { blob } = await engine.preview(imageFor(item), plain(ops), { maxSide, fonts: await fontsFor(ops), priority: 3, cacheKey: item.id, tag });
            return URL.createObjectURL(blob);
        },

        // Output format for one image under the current settings.
        formatFor(item) {
            const f = state.save.format;
            if (f !== 'original' && f !== 'pdf') return f === 'avif' && !state.caps.avif ? 'jpeg' : f;
            if (item.kind === 'jpeg' || item.kind === 'png') return item.kind;
            if (item.kind === 'webp') return state.caps.webp ? 'webp' : 'png';
            if (item.kind === 'avif' && state.caps.avif) return 'avif';
            return item.kind === 'heic' || item.kind === 'avif' ? 'jpeg' : 'png';
        },

        // What the file itself carries (read once per file).
        readMeta(item) {
            if (!metaCache.has(item.file)) metaCache.set(item.file, readMeta(item.file).catch((err) => { console.warn(err); return null; }));
            return metaCache.get(item.file);
        },

        // Tags this image is saved with: its own edits, else the default setting applied to what the file has.
        async tagsToWrite(item) {
            if (item.meta) return { ...item.meta };
            if (state.save.metaDefault === 'none') return {};
            return policyTags((await store.readMeta(item))?.tags, state.save.metaDefault);
        },

        // Renders (or losslessly cleans) each image. Returns [{ name, blob, width, height }].
        // Saving from Compress always re-encodes, under its size limit if one is set.
        async outputs(items, { forPdf = false } = {}, progress = null) {
            const s = state.save;
            const compress = state.tool === 'compress';
            const maxBytes = compress && s.target ? s.target * 1024 : null;
            const out = [];
            let unwritable = 0;
            for (const [i, item] of items.entries()) {
                const format = forPdf ? (item.kind === 'png' ? 'png' : 'jpeg') : store.formatFor(item);
                const tags = forPdf ? {} : await store.tagsToWrite(item);
                const carries = format === 'jpeg' || format === 'png';
                if (Object.keys(tags).length && !carries) unwritable++;
                tags.Software = SOFTWARE;
                let blob = null, width = item.width, height = item.height;
                if (!forPdf && !compress && !item.ops.length && !item.proxy && format === item.kind && carries) {
                    // Untouched JPEG/PNG: swap the metadata, keep the pixels bit for bit. The bytes decide, not the name:
                    // a mislabelled file (or one the cleaner can't parse) goes through the encoder instead.
                    const bytes = new Uint8Array(await item.file.arrayBuffer());
                    try {
                        if (sniff(bytes) === format) {
                            const clean = format === 'png' ? stripPngMetadata(bytes) : stripJpegMetadata(bytes);
                            const orientation = format === 'jpeg' ? jpegOrientation(bytes) : 1;
                            blob = await withExif(clean, buildExif(tags, { orientation }), format);
                        }
                    } catch (err) {
                        console.warn(`Lossless save of ${item.name} failed, re-encoding`, err);
                    }
                }
                if (!blob) {
                    let r;
                    try {
                        r = await engine.render(imageFor(item, s.highest), item.ops, { format, quality: s.quality / 100, maxBytes }, { fonts: await fontsFor(item.ops) });
                    } catch (err) {
                        // One unreadable image doesn't cost the rest of the batch.
                        console.error(err);
                        message.error(`Couldn't save ${item.name}: ${err.message}`);
                        progress?.((i + 1) / items.length);
                        continue;
                    }
                    ({ blob, width, height } = r);
                    if (carries) blob = await withExif(blob, buildExif(tags), format);
                    if (maxBytes && !r.fits) message.warning(`${item.name} is still ${formatSize(blob.size)} at the lowest quality`);
                    else if (r.shrunk) message.info(`${item.name} was made ${width}×${height} to stay under ${formatSize(maxBytes)}`);
                }
                out.push({ name: outputName(item.name, format), blob, width, height });
                progress?.((i + 1) / items.length);
            }
            if (unwritable) message.warning(`${plural(unwritable, 'file')} saved without the metadata you kept: only JPG and PNG can carry it`);
            if (!out.length) throw new Error('Nothing could be saved');
            uniqueNames(out.map(o => o.name)).forEach((name, i) => { out[i].name = name; });
            return out;
        },

        // as: 'files' | 'zip' | 'share' | 'pdf' | 'pdfeditor'. With PDF chosen as the format, files and ZIP give the PDF
        // and Share shares it.
        async save(as = 'files', { items = store.targets() } = {}) {
            items = items.filter(i => i.status === 'ready');
            if (!items.length) return message.warning('Wait for the images to finish loading');
            const pdfFormat = state.save.format === 'pdf';
            const kind = pdfFormat && (as === 'files' || as === 'zip') ? 'pdf' : as;
            const forPdf = kind === 'pdf' || kind === 'pdfeditor' || pdfFormat;
            // Open the tab now: after the work, the browser would treat it as a pop-up.
            const editorTab = kind === 'pdfeditor' ? window.open('', '_blank') : null;
            const outs = await store.run(forPdf ? 'Preparing pages' : 'Saving', p => store.outputs(items, { forPdf }, p));
            if (!outs) return editorTab?.close();
            const before = items.reduce((n, i) => n + i.size, 0);
            const after = outs.reduce((n, o) => n + o.blob.size, 0);
            const sizes = `${formatSize(before)} → ${formatSize(after)}`;
            const stem = items.length === 1 ? baseName(items[0].name) : 'images';
            try {
                let files = outs.map(o => new File([o.blob], o.name, { type: o.blob.type }));
                if (forPdf) {
                    const bytes = await store.run('Making the PDF', () => imagesToPdf(outs, { creator: SOFTWARE }));
                    if (!bytes) return editorTab?.close();
                    files = [new File([bytes], `${stem}.pdf`, { type: 'application/pdf' })];
                }
                if (kind === 'pdfeditor') {
                    await sendHandoff(files);
                    if (editorTab) editorTab.location.href = '/pdfmerge/#import';
                    else location.href = '/pdfmerge/#import';
                } else if (kind === 'share') {
                    await store.share(files);
                } else if (kind === 'pdf') {
                    download(files[0], files[0].name);
                    message.success(`Saved ${files[0].name} · ${formatSize(files[0].size)}`);
                } else if (kind === 'zip') {
                    const JSZip = await loadScript(ZIP_URL, 'JSZip');
                    const zip = new JSZip();
                    for (const f of files) zip.file(f.name, f);
                    download(await zip.generateAsync({ type: 'blob' }), `${stem}.zip`);
                    message.success(`Saved ${stem}.zip · ${sizes}`);
                } else {
                    for (const [i, f] of files.entries()) {
                        // Browsers drop rapid-fire downloads; space them out a little.
                        if (i) await new Promise(r => setTimeout(r, 250));
                        download(f, f.name);
                    }
                    message.success(files.length === 1 ? `Saved ${files[0].name} · ${sizes}` : `Saved ${plural(files.length, 'image')} · ${sizes}`);
                }
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.error(err);
                message.error(err.message || String(err));
            }
        },

        // navigator.share needs a recent tap, which a long render outlasts: then the files wait in a toast whose
        // button is that fresh tap.
        async share(files) {
            if (!navigator.canShare?.({ files })) throw new Error('This browser can\'t share these files — use Download');
            try {
                await navigator.share({ files });
            } catch (err) {
                if (err.name !== 'NotAllowedError') throw err;
                store.notify(files.length === 1 ? `${files[0].name} is ready` : `${plural(files.length, 'file')} ready`, 'Share', () => {
                    state.notice = null;
                    navigator.share({ files }).catch((e) => { if (e.name !== 'AbortError') message.error(e.message); });
                }, { sticky: true });
            }
        },

        // Queues behind a running operation. Returns undefined on failure.
        async run(label, fn) {
            const previous = lastRun;
            let finished;
            lastRun = new Promise(resolve => { finished = resolve; });
            await previous;
            state.busy = { label, progress: null };
            try {
                return await fn(progress => { if (state.busy) state.busy.progress = progress; });
            } catch (err) {
                console.error(err);
                message.error(err.message || String(err));
                return undefined;
            } finally {
                state.busy = null;
                finished();
            }
        },

        openViewer(ids, index) {
            Object.assign(state.viewer, { show: true, ids, index });
        },
    };

    return store;
}
