import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fittedBox, lockAspect, drawnBox, moveBox, isFullBox } from '../js/img/crop.js';
import { withRotation, withFlip, splitLast } from '../js/img/ops.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const pxAspect = (r, ratio) => (r.w / r.h) * ratio;

test('fitted box: 1:1 in a 4:3 photo is full height, centred', () => {
    const b = fittedBox(1, 4 / 3);
    near(b.h, 1); near(b.w, 0.75); near(b.x, 0.125);
    assert.ok(isFullBox(fittedBox(null, 4 / 3)));
});

test('dragging a corner keeps the aspect and the opposite corner', () => {
    const r = lockAspect({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, 'se', 16 / 9, 4 / 3);
    near(pxAspect(r, 4 / 3), 16 / 9);
    near(r.x, 0.1); near(r.y, 0.1);
});

test('a locked box that would leave the image shrinks instead', () => {
    const r = lockAspect({ x: 0.5, y: 0.5, w: 0.5, h: 0.1 }, 'se', 1, 1);
    assert.ok(r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9);
    near(pxAspect(r, 1), 1);
});

test('drawing up-left with an aspect stays inside', () => {
    const r = drawnBox({ x: 0.2, y: 0.2 }, { x: 0, y: 0.15 }, 1, 2, 0.02);
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9);
    near(pxAspect(r, 2), 1);
});

test('moving clamps to the image', () => {
    assert.deepEqual(moveBox({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0.3, -0.9), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
});

test('turns fold into one op and cancel out; a second mirror undoes the first', () => {
    assert.deepEqual(withRotation([], -90), [{ type: 'rotate', deg: 270 }]);
    assert.deepEqual(withRotation([{ type: 'rotate', deg: 270 }], 90), []);
    assert.deepEqual(withFlip(withFlip([], 'h'), 'h'), []);
});

test('splitLast finds a trailing op of that type only', () => {
    const ops = [{ type: 'crop' }, { type: 'adjust', brightness: 5 }];
    assert.deepEqual(splitLast(ops, 'adjust'), { base: [ops[0]], last: ops[1] });
    assert.deepEqual(splitLast(ops, 'crop'), { base: ops, last: null });
});
