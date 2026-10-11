// Small rules for editing an image's op list.

// Consecutive turns and flips fold into one op, so the op list stays short.
export function withRotation(ops, deg) {
    const last = ops.at(-1);
    if (last?.type !== 'rotate') return [...ops, { type: 'rotate', deg: ((deg % 360) + 360) % 360 }];
    const total = (((last.deg + deg) % 360) + 360) % 360;
    return total ? ops.with(-1, { type: 'rotate', deg: total }) : ops.slice(0, -1);
}

export function withFlip(ops, axis) {
    const last = ops.at(-1);
    return last?.type === 'flip' && last.axis === axis ? ops.slice(0, -1) : [...ops, { type: 'flip', axis }];
}

// Tools that re-edit their own last op (adjust, annotate, blur, watermark): the ops before it, and it.
export function splitLast(ops, type) {
    return ops.at(-1)?.type === type ? { base: ops.slice(0, -1), last: ops.at(-1) } : { base: ops, last: null };
}
