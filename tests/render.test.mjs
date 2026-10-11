import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeTarget, outputGeometry, fitSize, adjustPixels, arrowHead, watermarkSpots, patternLattice, reshapedSize } from '../js/img/render.js';

test('resize modes', () => {
    assert.deepEqual(resizeTarget({ mode: 'percent', percent: 50 }, 4000, 3000), { width: 2000, height: 1500 });
    assert.deepEqual(resizeTarget({ mode: 'longest', side: 1080 }, 3000, 4000), { width: 810, height: 1080 });
    assert.deepEqual(resizeTarget({ mode: 'pixels', width: 1000, height: 1000, lock: true }, 4000, 3000), { width: 1000, height: 750 });
    assert.deepEqual(resizeTarget({ mode: 'pixels', width: 1000, lock: true }, 4000, 3000), { width: 1000, height: 750 });
    assert.deepEqual(resizeTarget({ mode: 'pixels', width: 500, height: 500, lock: false }, 4000, 3000), { width: 500, height: 500 });
});

test('output geometry follows rotate, crop, resize in order', () => {
    const ops = [{ type: 'rotate', deg: 90 }, { type: 'crop', x: 0, y: 0, w: 0.5, h: 0.5 }, { type: 'resize', mode: 'percent', percent: 50 }];
    assert.deepEqual(outputGeometry(ops, 4000, 3000), { width: 750, height: 1000, scale: 0.5 });
    assert.deepEqual(outputGeometry([], 10, 20), { width: 10, height: 20, scale: 1 });
});

test('fitSize never upscales and respects a pixel budget', () => {
    assert.deepEqual(fitSize(4000, 3000, 400), { width: 400, height: 300 });
    assert.deepEqual(fitSize(100, 50, 400), { width: 100, height: 50 });
    assert.deepEqual(fitSize(8000, 6000, Infinity, 12e6), { width: 4000, height: 3000 });
});

test('adjust: neutral keeps pixels, grayscale equalises channels, brightness lifts', () => {
    const px = () => new Uint8ClampedArray([200, 100, 50, 255]);
    assert.deepEqual([...adjustPixels(px(), {})], [200, 100, 50, 255]);
    const g = adjustPixels(px(), { grayscale: true });
    assert.ok(g[0] === g[1] && g[1] === g[2]);
    assert.ok(adjustPixels(px(), { brightness: 50 })[1] > 100);
});

test('arrow head ends at the tip', () => {
    const head = arrowHead(0, 0, 10, 0, 2);
    assert.deepEqual(head[1], [10, 0]);
    assert.ok(head[0][0] < 10 && head[2][0] < 10);
});

test('watermark: one copy in a corner; a pattern lattice covers the image turned any way', () => {
    assert.deepEqual(watermarkSpots({ position: 'br' }, 1000, 500, 100, 20), [[1000 - 20 - 50, 500 - 20 - 10]]);
    const pts = patternLattice(1000, 500, 100, 40);
    const reach = Math.hypot(1000, 500) / 2;
    for (const [dx, dy] of [[reach, 0], [0, reach], [-reach, 0], [0, -reach]]) {
        assert.ok(pts.some(p => p.mark && Math.abs(p.x - (500 + dx)) <= 200 && Math.abs(p.y - (250 + dy)) <= 80), `covers ${dx},${dy}`);
    }
    const centre = pts.find(p => p.i === 0 && p.j === 0), right = pts.find(p => p.i === 1 && p.j === 0);
    assert.ok(centre.mark && !right.mark);
});

test('a resize that changes the shape reshapes the canvas; a proportional one waits', () => {
    const before = { width: 4000, height: 3000 };
    assert.deepEqual(reshapedSize(2000, 1500, before, { mode: 'pixels', width: 1000, height: 1000, lock: false }), { width: 1500, height: 1500 });
    assert.equal(reshapedSize(2000, 1500, before, { mode: 'percent', percent: 50 }), null);
});
