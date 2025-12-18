import {
  initializeImageMagick,
  MagickFormat,
  MagickGeometry,
  MagickImage,
  MagickImageCollection,
  MagickColor
} from 'https://esm.sh/@imagemagick/magick-wasm@0.0.37';

const WASM_URL = 'https://unpkg.com/@imagemagick/magick-wasm@0.0.37/dist/magick.wasm';
const GRAVITY_CENTER = 5;

let initPromise = null;

export function ensureMagickReady() {
  if (!initPromise) initPromise = initializeImageMagick(new URL(WASM_URL));
  return initPromise;
}

export { MagickFormat };

const MULTI_FRAME = new Set([MagickFormat.Gif, MagickFormat.WebP, MagickFormat.Pdf, MagickFormat.Tiff]);
const ANIMATION = new Set([MagickFormat.Gif, MagickFormat.WebP]);
const CANVAS_OUTPUT = new Set([MagickFormat.Png, MagickFormat.Jpeg, MagickFormat.WebP]);
const ANIMATABLE_INPUT = new Set(['image/gif', 'image/webp', 'image/apng']);

export const isMultiFrameFormat = (f) => MULTI_FRAME.has(f);
export const isAnimationFormat = (f) => ANIMATION.has(f);

export function canUseCanvasPath(file, targetFormat) {
  if (typeof createImageBitmap !== 'function') return false;
  if (!CANVAS_OUTPUT.has(targetFormat)) return false;
  if (file.type === 'application/pdf') return false;
  // WebP-from-animatable would silently drop frames via canvas.
  if (targetFormat === MagickFormat.WebP && ANIMATABLE_INPUT.has(file.type)) return false;
  return true;
}

function calcSize(opts, srcW, srcH) {
  if (opts.resizeMode === 'percent') {
    const p = opts.resizePercent / 100;
    return { w: srcW * p, h: srcH * p, exact: false };
  }
  if (opts.resizeMode === 'pixels') {
    const tw = opts.resizeWidth || srcW;
    const th = opts.resizeHeight || srcH;
    if (opts.lockRatio) {
      const r = Math.min(tw / srcW, th / srcH);
      return { w: srcW * r, h: srcH * r, exact: false };
    }
    return { w: tw, h: th, exact: true };
  }
  return null;
}

function applyEdits(image, opts) {
  if (opts.rotation) image.rotate(opts.rotation);
  const s = calcSize(opts, image.width, image.height);
  if (!s) return;
  if (s.exact) {
    const geom = new MagickGeometry(s.w, s.h);
    geom.ignoreAspectRatio = true;
    image.resize(geom);
  } else {
    image.resize(s.w, s.h);
  }
}

function writeBlob(target, format) {
  return new Promise((resolve) => {
    target.write(format, (data) => resolve(new Blob([data], { type: `image/${format}` })));
  });
}

export async function processViaCanvas(file, opts) {
  const bitmap = await createImageBitmap(file);
  const s = calcSize(opts, bitmap.width, bitmap.height);
  const w = Math.max(1, Math.round(s?.w ?? bitmap.width));
  const h = Math.max(1, Math.round(s?.h ?? bitmap.height));

  const rot = ((opts.rotation % 360) + 360) % 360;
  const swap = rot % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  if (rot) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  } else {
    ctx.drawImage(bitmap, 0, 0, w, h);
  }
  bitmap.close?.();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('Canvas encode failed')),
      `image/${opts.targetFormat}`,
      opts.quality / 100
    );
  });
}

export async function processSingleImage(file, opts) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const collection = MagickImageCollection.create();
  try {
    collection.read(bytes);
    if (collection.length > 1) collection.coalesce();
    for (let i = 0; i < collection.length; i++) {
      applyEdits(collection[i], opts);
      collection[i].format = opts.targetFormat;
      collection[i].quality = opts.quality;
    }
    if (isMultiFrameFormat(opts.targetFormat)) {
      if (opts.targetFormat === MagickFormat.Gif) collection.optimize();
      return writeBlob(collection, opts.targetFormat);
    }
    return writeBlob(collection[0], opts.targetFormat);
  } finally {
    collection.dispose();
  }
}

export async function processMergeAnimation(files, opts, onProgress) {
  const collection = MagickImageCollection.create();
  try {
    const buffers = await Promise.all(files.map(f => f.arrayBuffer()));
    const padW = opts.resizeWidth, padH = opts.resizeHeight;
    const wantPad = opts.targetFormat === MagickFormat.Gif
      && opts.resizeMode === 'pixels' && padW && padH && opts.lockRatio;

    for (let i = 0; i < buffers.length; i++) {
      onProgress?.(i, buffers.length);
      const image = MagickImage.create();
      image.read(new Uint8Array(buffers[i]));
      applyEdits(image, opts);
      if (wantPad) {
        image.backgroundColor = new MagickColor(0, 0, 0, 0);
        image.extent(padW, padH, GRAVITY_CENTER);
      }
      image.animationDelay = Math.round(opts.animationDelay / 10);
      if (opts.targetFormat === MagickFormat.Gif) image.gifDisposeMethod = 2;
      collection.push(image);
    }
    if (opts.targetFormat === MagickFormat.Gif) collection.optimize();
    return writeBlob(collection, opts.targetFormat);
  } finally {
    collection.dispose();
  }
}
