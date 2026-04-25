const HEIC_MIME = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_EXT = /\.(hei[cf]|hif)$/i;

let heifLibPromise = null;

const isHeic = (file) =>
  HEIC_MIME.has(file.type) || HEIC_EXT.test(file.name || '');

const loadHeifLib = () => {
  if (!heifLibPromise) {
    heifLibPromise = import('https://esm.sh/libheif-js@1.19.8/wasm-bundle')
      .then(m => m.default || m);
  }
  return heifLibPromise;
};

async function decodeHeic(file) {
  const lib = await loadHeifLib();
  const decoder = new lib.HeifDecoder();
  const buf = await file.arrayBuffer();
  const images = decoder.decode(buf);
  if (!images || !images.length) throw new Error('HEIC: no image found');
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const imageData = new ImageData(width, height);
  await new Promise((resolve, reject) => {
    image.display(imageData, (out) => {
      if (!out) reject(new Error('HEIC decode failed'));
      else resolve();
    });
  });
  return imageData;
}

function calcSize(opts, srcW, srcH) {
  if (opts.resizeMode === 'percent') {
    const p = opts.resizePercent / 100;
    return { w: srcW * p, h: srcH * p };
  }
  if (opts.resizeMode === 'pixels') {
    const tw = opts.resizeWidth || srcW;
    const th = opts.resizeHeight || srcH;
    if (opts.lockRatio) {
      const r = Math.min(tw / srcW, th / srcH);
      return { w: srcW * r, h: srcH * r };
    }
    return { w: tw, h: th };
  }
  return null;
}

async function decodeStandard(file, opts) {
  const probe = await createImageBitmap(file);
  const s = calcSize(opts, probe.width, probe.height);
  if (!s) return probe;
  const w = Math.max(1, Math.round(s.w));
  const h = Math.max(1, Math.round(s.h));
  if (w >= probe.width && h >= probe.height) return probe;
  probe.close?.();
  try {
    return await createImageBitmap(file, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high'
    });
  } catch {
    return createImageBitmap(file);
  }
}

async function process(file, opts) {
  const heic = isHeic(file);
  const source = heic ? await decodeHeic(file) : await decodeStandard(file, opts);
  const srcW = source.width, srcH = source.height;
  const target = calcSize(opts, srcW, srcH);
  const w = target ? Math.max(1, Math.round(target.w)) : srcW;
  const h = target ? Math.max(1, Math.round(target.h)) : srcH;

  const rot = ((opts.rotation % 360) + 360) % 360;
  const swap = rot % 180 !== 0;
  const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
  const ctx = canvas.getContext('2d');

  let drawable = source;
  if (source instanceof ImageData) {
    const tmp = new OffscreenCanvas(srcW, srcH);
    tmp.getContext('2d').putImageData(source, 0, 0);
    drawable = tmp;
  }

  if (rot) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(drawable, -w / 2, -h / 2, w, h);
  } else {
    ctx.drawImage(drawable, 0, 0, w, h);
  }
  if (drawable.close) drawable.close();

  return canvas.convertToBlob({
    type: `image/${opts.targetFormat}`,
    quality: opts.quality / 100
  });
}

self.onmessage = async (e) => {
  const { id, kind, file, opts } = e.data;
  try {
    if (kind === 'preload') {
      await loadHeifLib();
      self.postMessage({ id });
      return;
    }
    const blob = await process(file, opts);
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
