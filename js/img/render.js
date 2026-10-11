// Ops → pixels. Pure geometry/colour helpers plus a canvas executor that runs anywhere a 2D canvas exists
// (OffscreenCanvas in the worker). Positions are normalized to the image as it looks when the op is applied;
// sizes (text, strokes, blur) are fractions of the shorter side, so they look the same at any resolution.
//
// Ops: rotate {deg} · flip {axis: 'h'|'v'} · crop {x,y,w,h} · resize {mode: 'percent'|'pixels'|'longest', percent, width, height, lock, side}
//      adjust {brightness, contrast, saturation, warmth, grayscale} · blur {rects (shape: 'rect'|'ellipse'), kind: 'blur'|'pixelate', strength}
//      annotate {elements} · watermark {text, image, opacity, angle, size, tile, lines, spacing, position, color, font, bold}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const round = (v) => Math.max(1, Math.round(v));

export function resizeTarget(op, w, h) {
    if (op.mode === 'percent') {
        const p = (op.percent || 100) / 100;
        return { width: round(w * p), height: round(h * p) };
    }
    if (op.mode === 'longest') {
        const r = (op.side || Math.max(w, h)) / Math.max(w, h);
        return { width: round(w * r), height: round(h * r) };
    }
    const tw = op.width || null, th = op.height || null;
    if (!tw && !th) return { width: w, height: h };
    if (op.lock !== false) {
        const r = Math.min(tw ? tw / w : Infinity, th ? th / h : Infinity);
        return { width: round(w * r), height: round(h * r) };
    }
    return { width: round(tw || w), height: round(th || h) };
}

// Output size after all ops, and how many output pixels one source pixel becomes (for decoding at the right size).
export function outputGeometry(ops, width, height) {
    let w = width, h = height, scale = 1;
    for (const op of ops) {
        if (op.type === 'rotate' && Math.abs(op.deg) % 180 === 90) {
            [w, h] = [h, w];
        } else if (op.type === 'crop') {
            w = round(w * op.w);
            h = round(h * op.h);
        } else if (op.type === 'resize') {
            const t = resizeTarget(op, w, h);
            scale *= Math.max(t.width / w, t.height / h);
            w = t.width;
            h = t.height;
        }
    }
    return { width: w, height: h, scale };
}

// Largest size fitting in maxSide (and maxPixels), never upscaling.
export function fitSize(w, h, maxSide = Infinity, maxPixels = Infinity) {
    const r = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
    return { width: round(w * r), height: round(h * r) };
}

// Colour adjustments, each -100..100 (0 = unchanged). Runs in place on RGBA bytes.
export function adjustPixels(data, { brightness = 0, contrast = 0, saturation = 0, warmth = 0, grayscale = false } = {}) {
    const b = brightness * 1.28;
    const c = (100 + contrast) / 100;
    const cf = c * c;
    const s = grayscale ? 0 : 1 + saturation / 100;
    const wr = warmth * 0.3, wb = -warmth * 0.3;
    for (let i = 0; i < data.length; i += 4) {
        let r = data[i], g = data[i + 1], bl = data[i + 2];
        r = (r - 128) * cf + 128 + b + wr;
        g = (g - 128) * cf + 128 + b;
        bl = (bl - 128) * cf + 128 + b + wb;
        const y = 0.299 * r + 0.587 * g + 0.114 * bl;
        data[i] = clampByte(y + (r - y) * s);
        data[i + 1] = clampByte(y + (g - y) * s);
        data[i + 2] = clampByte(y + (bl - y) * s);
    }
    return data;
}

export const isNeutralAdjust = (a) => !a.grayscale && !a.brightness && !a.contrast && !a.saturation && !a.warmth;

// Arrow head points for a line ending at (x2, y2), in the same units.
export function arrowHead(x1, y1, x2, y2, size) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const spread = Math.PI / 7;
    return [
        [x2 - size * Math.cos(a - spread), y2 - size * Math.sin(a - spread)],
        [x2, y2],
        [x2 - size * Math.cos(a + spread), y2 - size * Math.sin(a + spread)],
    ];
}

// Centre of a single watermark of markW × markH at `position`.
export function watermarkSpots({ position = 'center' }, w, h, markW, markH) {
    const pad = Math.min(w, h) * 0.04;
    const xs = { l: pad + markW / 2, c: w / 2, r: w - pad - markW / 2 };
    const ys = { t: pad + markH / 2, c: h / 2, b: h - pad - markH / 2 };
    const key = { center: 'cc', tl: 'tl', tr: 'tr', bl: 'bl', br: 'br', top: 'tc', bottom: 'bc' }[position] || 'cc';
    return [[xs[key[1]], ys[key[0]]]];
}

export const BUILTIN_FONTS = [
    { key: 'sans', label: 'Sans', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
    { key: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
    { key: 'mono', label: 'Mono', css: 'ui-monospace, Menlo, Consolas, "Courier New", monospace' },
    { key: 'hand', label: 'Handwriting', css: '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive' },
    { key: 'impact', label: 'Impact', css: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
];

// Canvas `font` value; `fonts` maps custom keys to CSS families.
export function canvasFont(key, px, bold, fonts = {}) {
    const css = fonts[key] || BUILTIN_FONTS.find(f => f.key === key)?.css || BUILTIN_FONTS[0].css;
    return `${bold || key === 'impact' ? 700 : 400} ${Math.max(1, Math.round(px))}px ${css}`;
}

// Halves repeatedly, then one last smooth step: big reductions stay sharp in browsers that ignore imageSmoothingQuality.
function scaleTo(source, w, h, makeCanvas) {
    let current = source;
    let cw = source.width, ch = source.height;
    while (cw / 2 >= w && ch / 2 >= h) {
        cw = Math.round(cw / 2);
        ch = Math.round(ch / 2);
        const step = makeCanvas(cw, ch);
        const ctx = step.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(current, 0, 0, cw, ch);
        current = step;
    }
    if (current.width === w && current.height === h) return current;
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, w, h);
    return out;
}

function transformed(canvas, w, h, makeCanvas, setup) {
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');
    setup(ctx);
    ctx.drawImage(canvas, 0, 0);
    return out;
}

function rotate(canvas, deg, makeCanvas) {
    const d = ((deg % 360) + 360) % 360;
    if (!d) return canvas;
    const w = canvas.width, h = canvas.height;
    const swap = d % 180 !== 0;
    return transformed(canvas, swap ? h : w, swap ? w : h, makeCanvas, (ctx) => {
        if (d === 90) ctx.setTransform(0, 1, -1, 0, h, 0);
        else if (d === 180) ctx.setTransform(-1, 0, 0, -1, w, h);
        else ctx.setTransform(0, -1, 1, 0, 0, w);
    });
}

function flip(canvas, axis, makeCanvas) {
    const w = canvas.width, h = canvas.height;
    return transformed(canvas, w, h, makeCanvas, (ctx) => {
        if (axis === 'v') ctx.setTransform(1, 0, 0, -1, 0, h);
        else ctx.setTransform(-1, 0, 0, 1, w, 0);
    });
}

function crop(canvas, r, makeCanvas) {
    const x = Math.round(r.x * canvas.width), y = Math.round(r.y * canvas.height);
    const w = Math.min(canvas.width - x, round(r.w * canvas.width)), h = Math.min(canvas.height - y, round(r.h * canvas.height));
    const out = makeCanvas(w, h);
    out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
    return out;
}

function adjust(canvas, op) {
    if (isNeutralAdjust(op)) return canvas;
    const ctx = canvas.getContext('2d');
    // Row bands keep the temporary ImageData small on big photos.
    const band = Math.max(1, Math.floor(4e6 / canvas.width));
    for (let y = 0; y < canvas.height; y += band) {
        const h = Math.min(band, canvas.height - y);
        const img = ctx.getImageData(0, 0 + y, canvas.width, h);
        adjustPixels(img.data, op);
        ctx.putImageData(img, 0, y);
    }
    return canvas;
}

function obscure(canvas, op, makeCanvas) {
    const ctx = canvas.getContext('2d');
    const unit = Math.min(canvas.width, canvas.height);
    const strength = op.strength || 5;
    for (const r of op.rects || []) {
        const x = Math.max(0, Math.floor(r.x * canvas.width)), y = Math.max(0, Math.floor(r.y * canvas.height));
        const w = Math.min(canvas.width - x, Math.ceil(r.w * canvas.width)), h = Math.min(canvas.height - y, Math.ceil(r.h * canvas.height));
        if (w < 1 || h < 1) continue;
        const block = Math.max(2, unit * 0.006 * strength);
        const sw = Math.max(1, Math.round(w / block)), sh = Math.max(1, Math.round(h / block));
        const small = makeCanvas(sw, sh);
        const sctx = small.getContext('2d');
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(canvas, x, y, w, h, 0, 0, sw, sh);
        ctx.save();
        ctx.beginPath();
        if (r.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        else ctx.rect(x, y, w, h);
        ctx.clip();
        if (op.kind === 'pixelate') {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(small, 0, 0, sw, sh, x, y, w, h);
        } else {
            // Down then up twice through a tiny canvas: a soft blur that can't be undone, with no ctx.filter (Safari lacks it).
            const tiny = makeCanvas(Math.max(1, Math.round(sw / 2)), Math.max(1, Math.round(sh / 2)));
            const tctx = tiny.getContext('2d');
            tctx.imageSmoothingQuality = 'high';
            tctx.drawImage(small, 0, 0, tiny.width, tiny.height);
            sctx.clearRect(0, 0, sw, sh);
            sctx.drawImage(tiny, 0, 0, sw, sh);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(small, 0, 0, sw, sh, x, y, w, h);
        }
        ctx.restore();
    }
    return canvas;
}

function textLines(el) {
    return String(el.text || '').split('\n');
}

export function drawElement(ctx, el, w, h, fonts = {}) {
    const unit = Math.min(w, h);
    ctx.save();
    ctx.strokeStyle = el.color || '#e11d48';
    ctx.fillStyle = el.color || '#e11d48';
    ctx.lineWidth = Math.max(1, (el.stroke || 0.006) * unit);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (el.kind) {
        case 'text': {
            const px = (el.size || 0.05) * unit;
            ctx.font = canvasFont(el.font, px, el.bold, fonts);
            ctx.textBaseline = 'top';
            const lines = textLines(el);
            const lh = px * 1.2;
            if (el.background) {
                const width = Math.max(...lines.map(l => ctx.measureText(l).width));
                ctx.fillStyle = el.background;
                ctx.fillRect(el.x * w - px * 0.2, el.y * h - px * 0.1, width + px * 0.4, lh * lines.length + px * 0.1);
                ctx.fillStyle = el.color || '#e11d48';
            }
            lines.forEach((line, i) => ctx.fillText(line, el.x * w, el.y * h + i * lh));
            break;
        }
        case 'rect':
            if (el.fill) ctx.fillRect(el.x * w, el.y * h, el.w * w, el.h * h);
            else ctx.strokeRect(el.x * w, el.y * h, el.w * w, el.h * h);
            break;
        case 'ellipse':
            ctx.beginPath();
            ctx.ellipse((el.x + el.w / 2) * w, (el.y + el.h / 2) * h, Math.abs(el.w * w) / 2, Math.abs(el.h * h) / 2, 0, 0, Math.PI * 2);
            el.fill ? ctx.fill() : ctx.stroke();
            break;
        case 'line':
        case 'arrow': {
            const x1 = el.x1 * w, y1 = el.y1 * h, x2 = el.x2 * w, y2 = el.y2 * h;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            if (el.kind === 'arrow') {
                const head = arrowHead(x1, y1, x2, y2, ctx.lineWidth * 4);
                ctx.beginPath();
                ctx.moveTo(...head[0]);
                ctx.lineTo(...head[1]);
                ctx.lineTo(...head[2]);
                ctx.stroke();
            }
            break;
        }
        case 'pen':
        case 'highlight': {
            const pts = el.points || [];
            if (!pts.length) break;
            if (el.kind === 'highlight') {
                ctx.globalAlpha = 0.4;
                ctx.globalCompositeOperation = 'multiply';
                ctx.lineCap = 'butt';
            }
            ctx.beginPath();
            ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
            for (const [x, y] of pts.slice(1)) ctx.lineTo(x * w, y * h);
            if (pts.length === 1) ctx.lineTo(pts[0][0] * w + 0.1, pts[0][1] * h);
            ctx.stroke();
            break;
        }
    }
    ctx.restore();
}

// Lattice points covering a w × h image once rotated about its centre: marks where i + j is even, crosses where odd.
export function patternLattice(w, h, cellX, cellY) {
    const reach = Math.hypot(w, h) / 2;
    const nx = Math.ceil(reach / cellX) + 1, ny = Math.ceil(reach / cellY) + 1;
    const points = [];
    for (let j = -ny; j <= ny; j++) {
        for (let i = -nx; i <= nx; i++) points.push({ x: w / 2 + i * cellX, y: h / 2 + j * cellY, i, j, mark: (((i + j) % 2) + 2) % 2 === 0 });
    }
    return points;
}

// A scratch canvas wherever this runs (worker or page).
const newCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

// Text, a logo, or both. One copy at `position`, or (tile) a pattern turned by `angle` across the whole image;
// with both marks they alternate row by row, and `lines` joins them with crosses like a printed pattern.
// Sizes are fractions of the shorter side: size = text height; spacing scales the gaps.
export function drawWatermark(ctx, w, h, op, fonts = {}) {
    const unit = Math.min(w, h);
    const px = (op.size || 0.06) * unit;
    const marks = [];
    if (op.text) {
        ctx.font = canvasFont(op.font, px, op.bold, fonts);
        const tw = ctx.measureText(op.text).width;
        if (tw) marks.push({ w: tw, h: px, draw: (c) => {
            c.font = canvasFont(op.font, px, op.bold, fonts);
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillStyle = op.color || '#ffffff';
            c.fillText(op.text, 0, 0);
        } });
    }
    if (op.image?.width) {
        const lh = px * 1.4, lw = lh * (op.image.width / op.image.height);
        marks.push({ w: lw, h: lh, draw: (c) => c.drawImage(op.image, -lw / 2, -lh / 2, lw, lh) });
    }
    if (!marks.length) return;
    const angle = ((op.angle || 0) * Math.PI) / 180;
    ctx.save();
    ctx.globalAlpha = op.opacity ?? 0.4;
    if (!op.tile) {
        // Logo above the text when there are both.
        const gw = Math.max(...marks.map(m => m.w)), gh = marks.reduce((n, m) => n + m.h, 0) + (marks.length - 1) * px * 0.3;
        const [[x, y]] = watermarkSpots(op, w, h, gw, gh);
        ctx.translate(x, y);
        ctx.rotate(angle);
        let top = -gh / 2;
        for (const m of [...marks].reverse()) {
            ctx.save();
            ctx.translate(0, top + m.h / 2);
            m.draw(ctx);
            ctx.restore();
            top += m.h + px * 0.3;
        }
        ctx.restore();
        return;
    }
    const spacing = op.spacing ?? 1;
    const maxW = Math.max(...marks.map(m => m.w)), maxH = Math.max(...marks.map(m => m.h));
    const gap = px * 0.6 * spacing;
    const cellX = maxW / 2 + gap + px * 0.8 * spacing;
    const cellY = maxH / 2 + gap + px * 0.5 * spacing;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angle);
    ctx.translate(-w / 2, -h / 2);
    if (op.lines) {
        ctx.strokeStyle = op.color || '#ffffff';
        ctx.lineWidth = Math.max(1, px * 0.06);
        ctx.lineCap = 'butt';
    }
    // Each mark is drawn once and stamped: a pattern can hold hundreds of copies.
    const stamps = marks.map((m) => {
        const pad = Math.ceil(px * 0.3);
        const c = newCanvas(Math.ceil(m.w) + 2 * pad, Math.ceil(m.h) + 2 * pad);
        const sctx = c.getContext('2d');
        sctx.translate(c.width / 2, c.height / 2);
        m.draw(sctx);
        return c;
    });
    for (const p of patternLattice(w, h, cellX, cellY)) {
        if (p.mark) {
            const stamp = stamps[stamps.length > 1 ? ((p.j % 2) + 2) % 2 : 0];
            ctx.drawImage(stamp, p.x - stamp.width / 2, p.y - stamp.height / 2);
        } else if (op.lines) {
            // A cross whose arms stop short of the neighbouring marks.
            const armX = Math.max(0, cellX - maxW / 2 - gap * 0.6), armY = Math.max(0, cellY - maxH / 2 - gap * 0.6);
            ctx.beginPath();
            ctx.moveTo(p.x - armX, p.y);
            ctx.lineTo(p.x + armX, p.y);
            ctx.moveTo(p.x, p.y - armY);
            ctx.lineTo(p.x, p.y + armY);
            ctx.stroke();
        }
    }
    ctx.restore();
}

function watermark(canvas, op, fonts) {
    drawWatermark(canvas.getContext('2d'), canvas.width, canvas.height, op, fonts);
    return canvas;
}

// Canvas size after a resize that changes the aspect ratio (null when it keeps it): each axis scales like the
// image does, normalised so the more enlarged axis keeps the canvas's resolution.
export function reshapedSize(cw, ch, before, op) {
    const t = resizeTarget(op, before.width, before.height);
    const fx = t.width / before.width, fy = t.height / before.height;
    if (Math.abs(fx - fy) <= 1e-3 * Math.max(fx, fy)) return null;
    const m = Math.max(fx, fy);
    return { width: round((cw * fx) / m), height: round((ch * fy) / m) };
}

// Runs ops on `source` (any drawable; may be pre-scaled) whose full size is baseWidth x baseHeight.
// target: 'output' renders at the real output size; { maxSide, maxPixels } fits a preview into that box.
// fonts: { key: cssFamily } for custom fonts already registered where this runs.
export function renderOps(source, ops, { baseWidth, baseHeight, makeCanvas, target = 'output', fonts = {} }) {
    const geo = outputGeometry(ops, baseWidth, baseHeight);
    // Rotate, flip, crop and resize make new canvases anyway; the source (maybe a cached decode) is copied only
    // before the first op that draws in place.
    let canvas = source;
    const own = () => {
        if (canvas !== source) return canvas;
        const copy = makeCanvas(source.width, source.height);
        copy.getContext('2d').drawImage(source, 0, 0);
        return (canvas = copy);
    };
    for (const [i, op] of ops.entries()) {
        if (op.type === 'resize') {
            // Proportional resizes wait for the final scale; one that changes the shape happens here, so drawing
            // ops after it work on the new shape instead of being stretched with it at the end.
            const size = reshapedSize(canvas.width, canvas.height, outputGeometry(ops.slice(0, i), baseWidth, baseHeight), op);
            if (size) canvas = scaleTo(canvas, size.width, size.height, makeCanvas);
        } else if (op.type === 'rotate') canvas = rotate(canvas, op.deg, makeCanvas);
        else if (op.type === 'flip') canvas = flip(canvas, op.axis, makeCanvas);
        else if (op.type === 'crop') canvas = crop(canvas, op, makeCanvas);
        else if (op.type === 'adjust') canvas = adjust(own(), op);
        else if (op.type === 'blur') canvas = obscure(own(), op, makeCanvas);
        else if (op.type === 'annotate') {
            const ctx = own().getContext('2d');
            for (const el of op.elements || []) drawElement(ctx, el, canvas.width, canvas.height, fonts);
        } else if (op.type === 'watermark') canvas = watermark(own(), op, fonts);
    }
    const size = target === 'output' ? geo : fitSize(geo.width, geo.height, target.maxSide, target.maxPixels);
    return { canvas: scaleTo(canvas, size.width, size.height, makeCanvas), width: size.width, height: size.height };
}

export { rotate as rotateCanvas, flip as flipCanvas, crop as cropCanvas, scaleTo as scaleCanvas };
