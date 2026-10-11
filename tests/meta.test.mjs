import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
import { buildExif, readTiffTags, jpegOrientation, stripJpegMetadata, spliceExif, stripPngMetadata, parseTagValue, formatTagValue } from '../js/img/meta.js';

const gpsJpeg = fixture('gps.jpg');
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text));

test('fixture has GPS, camera and orientation 6', () => {
    assert.ok(has(gpsJpeg, 'TestMake'));
    assert.equal(jpegOrientation(gpsJpeg), 6);
});

test('stripping a JPEG removes Exif (GPS, camera) and comments, keeps the image data', () => {
    const out = stripJpegMetadata(gpsJpeg);
    assert.ok(!has(out, 'Exif') && !has(out, 'TestMake') && !has(out, 'secret comment'));
    assert.deepEqual([out[0], out[1], out.at(-2), out.at(-1)], [0xff, 0xd8, 0xff, 0xd9]);
    assert.equal(jpegOrientation(out), 1);
});

test('kept date: the stripped JPEG gets only the date and the orientation back', () => {
    const tiff = buildExif({ DateTimeOriginal: '2024:05:06 07:08:09' }, { orientation: 6 });
    const out = spliceExif(stripJpegMetadata(gpsJpeg), tiff, 'jpeg');
    assert.equal(jpegOrientation(out), 6);
    const tags = readTiffTags(tiff);
    assert.equal(tags[0x9003], '2024:05:06 07:08:09');
    assert.equal(tags.gps, undefined);
    assert.ok(!has(out, 'TestMake'));
});

test('edited tags round-trip: text, numbers, rationals and a southern/western location', () => {
    const t = readTiffTags(buildExif({ Artist: 'Ana', Copyright: '© 2024', ISO: 200, FNumber: 1.8, ExposureTime: 1 / 120, latitude: -33.8688, longitude: -70.5, GPSAltitude: 512 }));
    assert.equal(t[0x013b], 'Ana');
    assert.equal(t[0x8298], '© 2024');
    assert.equal(t[0x8827], 200);
    assert.ok(Math.abs(t[0x829d] - 1.8) < 1e-9);
    assert.ok(Math.abs(t[0x829a] - 1 / 120) < 1e-9);
    assert.equal(t.gps[1], 'S');
    assert.equal(t.gps[3], 'W');
    const [d, m, sec] = t.gps[2];
    assert.ok(Math.abs(d + m / 60 + sec / 3600 - 33.8688) < 1e-6);
    assert.ok(Math.abs(t.gps[6] - 512) < 1e-9);
});

test('nothing to write gives no Exif block', () => {
    assert.equal(buildExif({}, { orientation: 1 }), null);
});

test('typed values are parsed or rejected with a message', () => {
    assert.equal(parseTagValue('DateTimeOriginal', '2024-05-31T14:05'), '2024:05:31 14:05:00');
    assert.throws(() => parseTagValue('DateTimeOriginal', 'yesterday'), /Dates look like/);
    assert.ok(Math.abs(parseTagValue('ExposureTime', '1/250') - 0.004) < 1e-12);
    assert.throws(() => parseTagValue('latitude', '120'), /between -90 and 90/);
    assert.equal(formatTagValue('ExposureTime', 0.004), '1/250');
});

test('PNG text and eXIf chunks are dropped', () => {
    const chunk = (type, data) => {
        const b = Buffer.alloc(12 + data.length);
        b.writeUInt32BE(data.length, 0);
        b.write(type, 4, 'latin1');
        Buffer.from(data).copy(b, 8);
        return b;
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
        chunk('tEXt', [...Buffer.from('Author\0me')]), chunk('eXIf', [1, 2]), chunk('IDAT', [1]), chunk('IEND', [])]);
    const out = Buffer.from(stripPngMetadata(new Uint8Array(png)));
    assert.ok(!out.includes('tEXt') && !out.includes('eXIf') && out.includes('IDAT') && out.includes('IEND'));
    const tagged = Buffer.from(spliceExif(new Uint8Array(out), buildExif({ Artist: 'Ana' }), 'png'));
    assert.ok(tagged.indexOf('eXIf') > tagged.indexOf('IHDR') && tagged.indexOf('eXIf') < tagged.indexOf('IDAT'));
});


test('data after the end of the image (Motion Photo video, MPF images) is dropped', () => {
    const trailer = Buffer.from('ftypmp42 GPS +50.8503+004.3517 TestMake');
    const motion = new Uint8Array(Buffer.concat([Buffer.from(gpsJpeg), trailer]));
    const out = stripJpegMetadata(motion);
    assert.ok(!has(out, 'GPS +50') && !has(out, 'TestMake'));
    assert.deepEqual([out.at(-2), out.at(-1)], [0xff, 0xd9]);
});

test('progressive JPEGs keep every scan', () => {
    const prog = fixture('progressive.jpg');
    const out = stripJpegMetadata(prog);
    const scans = (b) => { let n = 0; for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xda) n++; return n; };
    assert.ok(scans(prog) > 1);
    assert.equal(scans(out), scans(prog));
    assert.ok(!has(out, 'TestMake'));
    assert.ok(Buffer.from(prog).includes(Buffer.from(out.subarray(out.length - 200))));
});
