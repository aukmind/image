// Photo metadata: read it (exifr, loaded on first use), strip it from JPEG/PNG without re-encoding,
// and write back the tags the user chose to keep or edited.

const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs';

let exifr = null;
const loadExifr = () => (exifr ??= import(EXIFR_URL).then(m => m.default || m).catch((err) => { exifr = null; throw err; }));

// Tags that can be kept or edited. key = exifr's name; GPS uses decimal latitude/longitude/altitude.
export const TAGS = [
    { key: 'DateTimeOriginal', label: 'Date taken', ifd: 'exif', tag: 0x9003, type: 'date', group: 'date' },
    { key: 'CreateDate', label: 'Date digitized', ifd: 'exif', tag: 0x9004, type: 'date', group: 'date' },
    { key: 'ModifyDate', label: 'Date modified', ifd: 0, tag: 0x0132, type: 'date', group: 'date' },
    { key: 'OffsetTimeOriginal', label: 'Time zone', ifd: 'exif', tag: 0x9011, type: 'ascii', group: 'date' },
    { key: 'latitude', label: 'Latitude', ifd: 'gps', type: 'gps', group: 'location' },
    { key: 'longitude', label: 'Longitude', ifd: 'gps', type: 'gps', group: 'location' },
    { key: 'GPSAltitude', label: 'Altitude (m)', ifd: 'gps', tag: 6, type: 'rational', group: 'location' },
    { key: 'Make', label: 'Camera make', ifd: 0, tag: 0x010f, type: 'ascii', group: 'camera' },
    { key: 'Model', label: 'Camera model', ifd: 0, tag: 0x0110, type: 'ascii', group: 'camera' },
    { key: 'LensModel', label: 'Lens', ifd: 'exif', tag: 0xa434, type: 'ascii', group: 'camera' },
    { key: 'BodySerialNumber', label: 'Camera serial', ifd: 'exif', tag: 0xa431, type: 'ascii', group: 'camera' },
    { key: 'FNumber', label: 'Aperture (f/)', ifd: 'exif', tag: 0x829d, type: 'rational', group: 'camera' },
    { key: 'ExposureTime', label: 'Exposure (s)', ifd: 'exif', tag: 0x829a, type: 'rational', group: 'camera' },
    { key: 'ISO', label: 'ISO', ifd: 'exif', tag: 0x8827, type: 'short', group: 'camera' },
    { key: 'FocalLength', label: 'Focal length (mm)', ifd: 'exif', tag: 0x920a, type: 'rational', group: 'camera' },
    { key: 'Software', label: 'Software', ifd: 0, tag: 0x0131, type: 'ascii', group: 'other' },
    { key: 'Artist', label: 'Author', ifd: 0, tag: 0x013b, type: 'ascii', group: 'author' },
    { key: 'Copyright', label: 'Copyright', ifd: 0, tag: 0x8298, type: 'ascii', group: 'author' },
    { key: 'ImageDescription', label: 'Description', ifd: 0, tag: 0x010e, type: 'ascii', group: 'author' },
];
export const TAG = Object.fromEntries(TAGS.map(t => [t.key, t]));

const DATE = /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/;

// Turns what a user typed into a value for that tag, or throws with a message for them.
export function parseTagValue(key, input) {
    const def = TAG[key];
    const text = String(input ?? '').trim();
    if (!def) throw new Error(`Unknown tag ${key}`);
    if (def.type === 'ascii') return text;
    if (def.type === 'date') {
        const v = text.replace(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d:\d\d)(:\d\d)?$/, (m, y, mo, d, hm, sec) => `${y}:${mo}:${d} ${hm}${sec || ':00'}`);
        if (!DATE.test(v)) throw new Error('Dates look like 2024:05:31 14:05:00');
        return v;
    }
    const frac = text.match(/^(\d+)\s*\/\s*(\d+)$/);
    const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(text.replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`${def.label} must be a number`);
    if (key === 'latitude' && Math.abs(n) > 90) throw new Error('Latitude is between -90 and 90');
    if (key === 'longitude' && Math.abs(n) > 180) throw new Error('Longitude is between -180 and 180');
    if (def.type === 'short') return Math.round(Math.abs(n));
    return def.type === 'gps' ? n : Math.abs(n);
}

export function formatTagValue(key, value) {
    if (value == null) return '';
    if (key === 'ExposureTime' && value > 0 && value < 1) return `1/${Math.round(1 / value)}`;
    if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
    return String(value);
}

const showRaw = (v) => (v instanceof Uint8Array || ArrayBuffer.isView(v) ? `${v.length} bytes`
    : Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v).slice(0, 80) : String(v));

// Everything a photo reveals: editable tags (TAGS keys), plus the rest as read-only [name, value] pairs.
export async function readMeta(blob) {
    const lib = await loadExifr();
    const raw = await lib.parse(blob, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, ifd1: false, reviveValues: false, mergeOutput: true }).catch(() => null);
    if (!raw || !Object.keys(raw).length) return null;
    const tags = {};
    for (const t of TAGS) {
        const v = raw[t.key];
        if (v == null || v === '') continue;
        const value = t.type === 'ascii' || t.type === 'date' ? String(v).replace(/\0+$/, '').trim() : Number(v);
        if (value !== '' && !Number.isNaN(value)) tags[t.key] = value;
    }
    const skip = new Set([...TAGS.map(t => t.key), 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef', 'GPSAltitudeRef', 'MakerNote', 'ExifIFDPointer', 'GPSInfoIFDPointer']);
    const other = Object.entries(raw).filter(([k, v]) => !skip.has(k) && v != null && v !== '').map(([k, v]) => [k, showRaw(v)]);
    return { tags, other, count: Object.keys(raw).length };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function rational(v) {
    if (v > 0 && v < 1 && Math.abs(1 / v - Math.round(1 / v)) < 1e-6) return [1, Math.round(1 / v)];
    const den = 10000;
    const num = Math.round(v * den);
    const g = gcd(num, den) || 1;
    return [num / g, den / g];
}

const be = {
    ascii: (text) => new TextEncoder().encode(`${text}\0`),
    short: (n) => new Uint8Array([(n >> 8) & 255, n & 255]),
    long: (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]),
    rationals: (values) => {
        const out = new Uint8Array(values.length * 8);
        const v = new DataView(out.buffer);
        values.forEach((x, i) => { const [n, d] = rational(x); v.setUint32(i * 8, n); v.setUint32(i * 8 + 4, d); });
        return out;
    },
};
const TYPE = { byte: 1, ascii: 2, short: 3, long: 4, rational: 5 };

function entryFor(def, value) {
    if (def.type === 'ascii' || def.type === 'date') {
        const data = be.ascii(String(value).slice(0, def.type === 'date' ? 19 : 2000));
        return { tag: def.tag, type: TYPE.ascii, count: data.length, data };
    }
    if (def.type === 'short') return { tag: def.tag, type: TYPE.short, count: 1, data: be.short(value) };
    return { tag: def.tag, type: TYPE.rational, count: 1, data: be.rationals([value]) };
}

function gpsEntries(tags) {
    const out = [{ tag: 0, type: TYPE.byte, count: 4, data: new Uint8Array([2, 3, 0, 0]) }];
    const dms = (v) => { const a = Math.abs(v); const d = Math.floor(a); const m = Math.floor((a - d) * 60); return [d, m, Math.round(((a - d) * 60 - m) * 60 * 10000) / 10000]; };
    if (tags.latitude != null) {
        out.push({ tag: 1, type: TYPE.ascii, count: 2, data: be.ascii(tags.latitude < 0 ? 'S' : 'N') });
        out.push({ tag: 2, type: TYPE.rational, count: 3, data: be.rationals(dms(tags.latitude)) });
    }
    if (tags.longitude != null) {
        out.push({ tag: 3, type: TYPE.ascii, count: 2, data: be.ascii(tags.longitude < 0 ? 'W' : 'E') });
        out.push({ tag: 4, type: TYPE.rational, count: 3, data: be.rationals(dms(tags.longitude)) });
    }
    if (tags.GPSAltitude != null) {
        out.push({ tag: 5, type: TYPE.byte, count: 1, data: new Uint8Array([0]) });
        out.push({ tag: 6, type: TYPE.rational, count: 1, data: be.rationals([tags.GPSAltitude]) });
    }
    return out.length > 1 ? out : [];
}

// A big-endian TIFF block holding `tags` (TAGS keys) and the orientation. Null when there is nothing to write.
export function buildExif(tags = {}, { orientation = 1 } = {}) {
    const ifd0 = [], exif = [];
    if (orientation && orientation !== 1) ifd0.push({ tag: 0x0112, type: TYPE.short, count: 1, data: be.short(orientation) });
    for (const def of TAGS) {
        const v = tags[def.key];
        if (v == null || v === '' || def.ifd === 'gps') continue;
        (def.ifd === 'exif' ? exif : ifd0).push(entryFor(def, v));
    }
    const gps = gpsEntries(tags);
    if (!ifd0.length && !exif.length && !gps.length) return null;
    if (exif.length) ifd0.push({ tag: 0x8769, type: TYPE.long, count: 1, pointer: 'exif' });
    if (gps.length) ifd0.push({ tag: 0x8825, type: TYPE.long, count: 1, pointer: 'gps' });
    const ifds = [['ifd0', ifd0], ['exif', exif], ['gps', gps]].filter(([, e]) => e.length);
    for (const [, entries] of ifds) entries.sort((a, b) => a.tag - b.tag);

    const ifdSize = (n) => 2 + n * 12 + 4;
    const dataSize = (entries) => entries.reduce((n, e) => n + (e.data && e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
    const at = {};
    let p = 8;
    for (const [name, entries] of ifds) {
        at[name] = p;
        p += ifdSize(entries.length) + dataSize(entries);
    }
    const out = new Uint8Array(p);
    const v = new DataView(out.buffer);
    out.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
    for (const [name, entries] of ifds) {
        const start = at[name];
        let d = start + ifdSize(entries.length);
        v.setUint16(start, entries.length);
        entries.forEach((e, i) => {
            const q = start + 2 + i * 12;
            v.setUint16(q, e.tag);
            v.setUint16(q + 2, e.type);
            v.setUint32(q + 4, e.count);
            if (e.pointer) v.setUint32(q + 8, at[e.pointer]);
            else if (e.data.length <= 4) out.set(e.data, q + 8);
            else {
                v.setUint32(q + 8, d);
                out.set(e.data, d);
                d += e.data.length + (e.data.length & 1);
            }
        });
        v.setUint32(start + 2 + entries.length * 12, 0);
    }
    return out;
}

// Tags of IFD0 and the Exif IFD by number, plus `gps` (the GPS IFD by number). Rationals become numbers.
export function readTiffTags(tiff) {
    if (tiff.length < 8) return {};
    const little = tiff[0] === 0x49;
    const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const u16 = (o) => v.getUint16(o, little), u32 = (o) => v.getUint32(o, little);
    const readIfd = (at, into) => {
        if (at + 2 > tiff.length) return into;
        const n = u16(at);
        for (let i = 0; i < n; i++) {
            const p = at + 2 + i * 12;
            if (p + 12 > tiff.length) break;
            const tag = u16(p), type = u16(p + 2), count = u32(p + 4);
            const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type] || 1;
            const off = count * size <= 4 ? p + 8 : u32(p + 8);
            if (type === 3) into[tag] = u16(off);
            else if (type === 4) into[tag] = u32(off);
            else if (type === 2) into[tag] = new TextDecoder().decode(tiff.subarray(off, off + count)).replace(/\0+$/, '');
            else if (type === 5) {
                const vals = Array.from({ length: count }, (_, k) => u32(off + k * 8) / (u32(off + k * 8 + 4) || 1));
                into[tag] = count === 1 ? vals[0] : vals;
            } else if (type === 1) into[tag] = Array.from(tiff.subarray(off, off + count));
            else into[tag] = { type, count };
        }
        return into;
    };
    const tags = readIfd(u32(4), {});
    if (typeof tags[0x8769] === 'number') readIfd(tags[0x8769], tags);
    if (typeof tags[0x8825] === 'number') tags.gps = readIfd(tags[0x8825], {});
    return tags;
}

// Marker segments up to and including EOI. Compressed scan data rides along with the SOS segment before it.
// Anything after EOI (Motion Photo videos, MPF secondary images, each with its own metadata) is left out.
// untilScan: stop at the first scan (enough for headers, and works on the first bytes of a file).
function jpegSegments(bytes, { untilScan = false } = {}) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG');
    const segments = [];
    let p = 2;
    while (p + 2 <= bytes.length) {
        if (bytes[p] !== 0xff) throw new Error('Bad JPEG segment');
        const marker = bytes[p + 1];
        if (marker === 0xff) { p++; continue; }
        if (marker === 0xd9) { segments.push({ marker, start: p, end: p + 2 }); break; }
        if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
        if (marker === 0xda && untilScan) break;
        if (p + 4 > bytes.length) throw new Error('Truncated JPEG');
        const len = (bytes[p + 2] << 8) | bytes[p + 3];
        let end = p + 2 + len;
        if (marker === 0xda) {
            // Entropy-coded data runs to the next marker that isn't a stuffed 0xFF00 or a restart marker.
            while (end + 1 < bytes.length && !(bytes[end] === 0xff && bytes[end + 1] !== 0 && !(bytes[end + 1] >= 0xd0 && bytes[end + 1] <= 0xd7))) end++;
            if (end + 1 >= bytes.length) end = bytes.length;
        }
        segments.push({ marker, start: p, end });
        p = end;
    }
    return segments;
}

const isExifSegment = (bytes, s) => s.marker === 0xe1 && String.fromCharCode(...bytes.subarray(s.start + 4, s.start + 8)) === 'Exif';

// The TIFF block of a JPEG's Exif segment, or null.
function jpegExifTiff(bytes) {
    try {
        const seg = jpegSegments(bytes).find(s => isExifSegment(bytes, s));
        return seg ? bytes.subarray(seg.start + 10, seg.end) : null;
    } catch {
        return null;
    }
}

// Displayed size of a JPEG from its first bytes, and whether an Exif orientation applies (null if not in `head`).
export function jpegHeaderSize(head) {
    let segments;
    try {
        segments = jpegSegments(head, { untilScan: true });
    } catch {
        return null;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    const sof = segments.find(s => s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc);
    if (!sof || sof.start + 9 > head.length) return null;
    const height = (head[sof.start + 5] << 8) | head[sof.start + 6], width = (head[sof.start + 7] << 8) | head[sof.start + 8];
    if (!width || !height) return null;
    const exif = segments.find(s => isExifSegment(head, s));
    const orientation = (exif && readTiffTags(head.subarray(exif.start + 10, exif.end))[0x0112]) || 1;
    const swap = orientation >= 5;
    return { width: swap ? height : width, height: swap ? width : height, rotated: orientation !== 1 };
}

export function jpegOrientation(bytes) {
    const tiff = jpegExifTiff(bytes);
    return (tiff && readTiffTags(tiff)[0x0112]) || 1;
}

// Drops Exif/XMP (APP1), MPF (APP2), APP12/APP13 (IPTC), comments and whatever trails the image;
// keeps JFIF, ICC colour (APP2), Adobe (APP14) and the image.
export function stripJpegMetadata(bytes) {
    const isMpf = (seg) => seg.marker === 0xe2 && String.fromCharCode(...bytes.subarray(seg.start + 4, seg.start + 8)) === 'MPF\0';
    const drop = (seg) => seg.marker === 0xe1 || seg.marker === 0xec || seg.marker === 0xed || seg.marker === 0xfe || isMpf(seg);
    const kept = jpegSegments(bytes).filter(s => !drop(s));
    const size = 2 + kept.reduce((n, s) => n + (s.end - s.start), 0);
    const out = new Uint8Array(size);
    out.set([0xff, 0xd8]);
    let p = 2;
    for (const s of kept) {
        out.set(bytes.subarray(s.start, s.end), p);
        p += s.end - s.start;
    }
    return out;
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function stripPngMetadata(bytes) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!sig.every((b, i) => bytes[i] === b)) throw new Error('Not a PNG');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts = [bytes.subarray(0, 8)];
    let p = 8;
    while (p + 12 <= bytes.length) {
        const len = v.getUint32(p);
        const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
        const end = p + 12 + len;
        if (!PNG_DROP.has(type)) parts.push(bytes.subarray(p, end));
        p = end;
        if (type === 'IEND') break;
    }
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
}

let crcTable = null;
function crc32(bytes) {
    crcTable ??= Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Where and what to insert so a JPEG (Exif APP1 after SOI and JFIF) or PNG (eXIf chunk after IHDR) carries `tiff`.
// `head` only needs the file's first few dozen bytes, so callers can splice Blobs without reading the image.
export function exifInsertion(head, tiff, format) {
    if (format === 'png') {
        const at = 8 + 12 + new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(8);
        const chunk = new Uint8Array(12 + tiff.length);
        const cv = new DataView(chunk.buffer);
        cv.setUint32(0, tiff.length);
        chunk.set([0x65, 0x58, 0x49, 0x66], 4);
        chunk.set(tiff, 8);
        cv.setUint32(8 + tiff.length, crc32(chunk.subarray(4, 8 + tiff.length)));
        return { at, bytes: chunk };
    }
    const at = head[2] === 0xff && head[3] === 0xe0 ? 4 + ((head[4] << 8) | head[5]) : 2;
    const len = 2 + 6 + tiff.length;
    if (len > 0xffff) throw new Error('Exif block too large');
    const seg = new Uint8Array(2 + len);
    seg.set([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    seg.set(tiff, 10);
    return { at, bytes: seg };
}

export function spliceExif(bytes, tiff, format) {
    const { at, bytes: insert } = exifInsertion(bytes, tiff, format);
    const out = new Uint8Array(bytes.length + insert.length);
    out.set(bytes.subarray(0, at));
    out.set(insert, at);
    out.set(bytes.subarray(at), at + insert.length);
    return out;
}
