import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchQuality, outputName, uniqueNames, baseName } from '../js/img/encode.js';
import { heifPaths, poolSize } from '../js/img/decode.js';

const fakeEncode = (bytesPerQ) => async (q) => ({ size: Math.round(q * bytesPerQ) });

test('quality search finds the best quality under the limit', async () => {
    const r = await searchQuality(fakeEncode(1000), 500);
    assert.ok(r.fits && r.blob.size <= 500 && r.quality > 0.4);
});

test('quality search keeps top quality when it already fits, reports when nothing fits', async () => {
    assert.equal((await searchQuality(fakeEncode(100), 500)).quality, 0.95);
    const none = await searchQuality(fakeEncode(100000), 10);
    assert.equal(none.fits, false);
    assert.equal(none.quality, 0.05);
});

test('file names: extension swap and unique names in one zip', () => {
    assert.equal(outputName('IMG_1234.HEIC', 'jpeg'), 'IMG_1234.jpg');
    assert.equal(baseName('.hidden'), '.hidden');
    assert.deepEqual(uniqueNames(['a.jpg', 'A.jpg', 'a.jpg', 'b.png']), ['a.jpg', 'A (2).jpg', 'a (3).jpg', 'b.png']);
});

test('decode path order and pool size', () => {
    assert.deepEqual(heifPaths({ native: null, webcodecs: true }), ['native', 'webcodecs', 'wasm']);
    assert.deepEqual(heifPaths({ native: false, webcodecs: false }), ['wasm']);
    assert.deepEqual(heifPaths({ forced: 'webcodecs' }), ['webcodecs']);
    assert.equal(poolSize(8, 8), 2);
    assert.equal(poolSize(8, 2), 1);
    assert.equal(poolSize(1, 8), 1);
});
