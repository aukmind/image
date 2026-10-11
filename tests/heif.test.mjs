import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fixture } from './fixtures.mjs';
import { parseHeif, isHeif, displaySize, hevcCodecString, clapRect, videoColorSpace, singleItemHeif } from '../js/img/heif.js';


test('grid fixture: tiles, output size and transforms in property order', () => {
    const { primary, thumbnail } = parseHeif(fixture('grid.heic'));
    assert.equal(primary.kind, 'grid');
    assert.deepEqual([primary.rows, primary.cols, primary.width, primary.height, primary.tileWidth], [2, 2, 120, 100, 64]);
    assert.equal(primary.tiles.length, 4);
    assert.deepEqual(primary.transforms.map(t => t.type), ['irot', 'imir']);
    assert.deepEqual(displaySize(primary), { width: 100, height: 120 });
    assert.deepEqual(primary.nclx, { primaries: 1, transfer: 13, matrix: 6, fullRange: true });
    assert.equal(primary.bitDepth, 8);
    assert.match(primary.codec, /^hvc1\.[13]\.[0-9A-F]+\.L\d+/);
    assert.deepEqual([thumbnail.width, thumbnail.height], [32, 24]);
    assert.deepEqual(thumbnail.transforms.map(t => t.type), ['irot', 'imir']);
});

test('single item with clap is cropped to its clean aperture', () => {
    const { primary, thumbnail } = parseHeif(fixture('single.heic'));
    assert.equal(primary.kind, 'hvc1');
    assert.deepEqual([primary.width, primary.height], [80, 64]);
    assert.deepEqual(displaySize(primary), { width: 80, height: 60 });
    assert.ok(thumbnail);
});

test('isHeif accepts heic/mif1 brands and rejects other files', () => {
    assert.ok(isHeif(fixture('grid.heic')));
    assert.ok(!isHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])));
    assert.throws(() => parseHeif(new Uint8Array(16)), /Not a HEIF/);
});

test('codec string reverses compatibility flags and trims constraint bytes', () => {
    const hvcC = new Uint8Array(23);
    hvcC[1] = 0x01; // Main profile, tier L
    hvcC.set([0x60, 0, 0, 0], 2); // compat flags for profiles 1 and 2
    hvcC[6] = 0xb0;
    hvcC[12] = 93;
    assert.equal(hevcCodecString(hvcC), 'hvc1.1.6.L93.B0');
});

test('clap rect is centred like libheif', () => {
    assert.deepEqual(clapRect({ width: 80, height: 60, hOffset: 0, vOffset: 0 }, 80, 64), { x: 0, y: 2, width: 80, height: 60 });
});

test('nclx maps to a WebCodecs colour space', () => {
    assert.deepEqual(videoColorSpace({ primaries: 12, transfer: 13, matrix: 6, fullRange: true }),
        { fullRange: true, primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'smpte170m' });
});

const privateDir = new URL('./fixtures/private/', import.meta.url);
const photos = existsSync(privateDir) ? readdirSync(privateDir).filter(f => /\.hei[cf]$/i.test(f)) : [];
test('private phone photos parse as tile grids with thumbnails', { skip: !photos.length && 'no private photos' }, () => {
    for (const name of photos) {
        const { primary, thumbnail, exif } = parseHeif(new Uint8Array(readFileSync(new URL(name, privateDir))));
        assert.equal(primary.tiles.length, primary.rows * primary.cols, name);
        assert.ok(primary.tiles.every(t => t.length > 0), name);
        assert.ok(thumbnail, name);
        assert.ok(exif && (exif[0] === 0x4d || exif[0] === 0x49), `${name} exif`);
    }
});

test('singleItemHeif wraps one tile into a file the parser reads back', () => {
    const { primary } = parseHeif(fixture('grid.heic'));
    const one = singleItemHeif({ hvcC: primary.hvcC, width: 64, height: 64, nclx: primary.nclx }, primary.tiles[2]);
    const back = parseHeif(one).primary;
    assert.deepEqual([back.kind, back.width, back.height, back.transforms.length], ['hvc1', 64, 64, 0]);
    assert.deepEqual(back.tiles[0], primary.tiles[2]);
    assert.deepEqual(back.nclx, primary.nclx);
});

test('AVIF is not HEIF even though it lists mif1', () => {
    const ftyp = (...brands) => {
        const b = new Uint8Array(8 + 4 * (brands.length + 1));
        new DataView(b.buffer).setUint32(0, b.length);
        b.set([...'ftyp'].map(c => c.charCodeAt(0)), 4);
        brands.forEach((brand, i) => b.set([...brand].map(c => c.charCodeAt(0)), i ? 12 + 4 * i : 8));
        return b;
    };
    assert.ok(!isHeif(ftyp('avif', 'mif1', 'miaf')));
    assert.ok(isHeif(ftyp('heic', 'mif1', 'heic')));
    assert.ok(isHeif(ftyp('mif1', 'heic')));
});
