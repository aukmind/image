export const Format = Object.freeze({
  Png: 'png',
  Jpeg: 'jpeg',
  WebP: 'webp',
  Pdf: 'pdf'
});

const CANVAS_OUTPUT = new Set([Format.Png, Format.Jpeg, Format.WebP]);
const HEIC_MIME = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_EXT = /\.(hei[cf]|hif)$/i;
const MIME_TO_FORMAT = {
  'image/png': Format.Png,
  'image/jpeg': Format.Jpeg,
  'image/webp': Format.WebP
};

export const isHeic = (file) =>
  HEIC_MIME.has(file.type) || HEIC_EXT.test(file.name || '');

export const formatExtension = (format) => format === Format.Jpeg ? 'jpg' : format;

export const isCanvasOutput = (format) => CANVAS_OUTPUT.has(format);

export function isPassthrough(file, opts) {
  if (opts.rotation) return false;
  if (opts.resizeMode && opts.resizeMode !== 'none') return false;
  return MIME_TO_FORMAT[file.type] === opts.targetFormat;
}

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, blob, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(blob);
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'Worker error'));
    pending.clear();
  };
  return worker;
}

export function processInWorker(file, opts) {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, file, opts });
  });
}

let heicPreloaded = false;
export function preloadHeic() {
  if (heicPreloaded) return Promise.resolve();
  heicPreloaded = true;
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, kind: 'preload' });
  }).catch((e) => {
    heicPreloaded = false;
    throw e;
  });
}
