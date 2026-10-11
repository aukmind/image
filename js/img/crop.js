// Crop box math in normalized image coordinates. `ratio` is the image's width / height in pixels;
// `aspect` the wanted box width / height in pixels (null = free).

export const ASPECTS = [
    { key: 'free', label: 'Free', value: null },
    { key: 'original', label: 'Original', value: 'original' },
    { key: '1:1', label: '1:1', value: 1 },
    { key: '4:3', label: '4:3', value: 4 / 3 },
    { key: '3:4', label: '3:4', value: 3 / 4 },
    { key: '16:9', label: '16:9', value: 16 / 9 },
    { key: '9:16', label: '9:16', value: 9 / 16 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Largest centred box of that aspect, inset by `margin` (fraction of the image).
export function fittedBox(aspect, ratio, margin = 0) {
    const room = 1 - 2 * margin;
    if (!aspect) return { x: margin, y: margin, w: room, h: room };
    let w = room, h = (w * ratio) / aspect;
    if (h > room) {
        h = room;
        w = (h * aspect) / ratio;
    }
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// Makes a box dragged by `handle` keep the aspect, anchored at the opposite side; stays inside the image.
export function lockAspect(rect, handle, aspect, ratio) {
    if (!aspect) return rect;
    const byWidth = handle.includes('e') || handle.includes('w');
    let w = rect.w, h = rect.h;
    if (byWidth) h = (w * ratio) / aspect;
    else w = (h * aspect) / ratio;
    const right = rect.x + rect.w, bottom = rect.y + rect.h;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const place = (w, h) => ({
        x: handle.includes('w') ? right - w : handle.includes('e') ? rect.x : cx - w / 2,
        y: handle.includes('n') ? bottom - h : handle.includes('s') ? rect.y : cy - h / 2,
    });
    let { x, y } = place(w, h);
    // Shrink until it fits: the anchored side stays put.
    const over = Math.max(1, w / (handle.includes('w') ? right : handle.includes('e') ? 1 - rect.x : 1),
        h / (handle.includes('n') ? bottom : handle.includes('s') ? 1 - rect.y : 1));
    if (over > 1 || x < 0 || y < 0 || x + w > 1 || y + h > 1) {
        w /= over;
        h /= over;
        ({ x, y } = place(w, h));
        x = clamp(x, 0, 1 - w);
        y = clamp(y, 0, 1 - h);
    }
    return { x, y, w, h };
}

// A new box drawn from `start` to `point`, with the aspect if any.
export function drawnBox(start, point, aspect, ratio, min) {
    let w = Math.max(min, Math.abs(point.x - start.x));
    let h = Math.max(min, Math.abs(point.y - start.y));
    if (aspect) {
        h = (w * ratio) / aspect;
        const maxW = point.x >= start.x ? 1 - start.x : start.x;
        const maxH = point.y >= start.y ? 1 - start.y : start.y;
        const s = Math.min(1, maxW / w, maxH / h);
        w *= s;
        h *= s;
    }
    return {
        x: point.x >= start.x ? start.x : start.x - w,
        y: point.y >= start.y ? start.y : start.y - h,
        w, h,
    };
}

export function moveBox(rect, dx, dy) {
    return { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.w), y: clamp(rect.y + dy, 0, 1 - rect.h) };
}

export const isFullBox = (r) => r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999;
