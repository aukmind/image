import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
import { headerSize, ORIENTATION_PROBE } from '../js/img/size.js';

test('JPEG: size from SOF, swapped by Exif orientation 6', () => {
    assert.deepEqual(headerSize(fixture('gps.jpg')), { width: 30, height: 40, rotated: true });
    assert.deepEqual(headerSize(fixture('progressive.jpg')), { width: 48, height: 64, rotated: true });
});

test('the orientation probe is a rotated 32×16 JPEG shown 16×32', () => {
    assert.deepEqual(headerSize(new Uint8Array(Buffer.from(ORIENTATION_PROBE, 'base64'))), { width: 16, height: 32, rotated: true });
});

test('WebP: lossy, lossless and extended layouts', () => {
    for (const name of ['size-lossy.webp', 'size-lossless.webp', 'size-extended.webp']) assert.deepEqual(headerSize(fixture(name)), { width: 37, height: 21, rotated: false }, name);
});

test('PNG: size from IHDR', () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x0f, 0xa0, 0, 0, 0x0b, 0xb8]);
    assert.deepEqual(headerSize(png), { width: 4000, height: 3000, rotated: false });
});

test('unknown or truncated headers give null', () => {
    assert.equal(headerSize(fixture('grid.heic')), null);
    assert.equal(headerSize(fixture('gps.jpg').subarray(0, 40)), null);
});
