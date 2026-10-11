// HEIF/HEIC container parser: finds the primary image (single item or tile grid), its thumbnail, transforms,
// colour info and Exif. No decoding. Works on the whole file (Samsung puts mdat before meta).

const text = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

class Reader {
    constructor(bytes, pos = 0, end = bytes.length) {
        this.b = bytes;
        this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = pos;
        this.end = end;
    }
    u8() { return this.b[this.pos++]; }
    u16() { const x = this.v.getUint16(this.pos); this.pos += 2; return x; }
    u32() { const x = this.v.getUint32(this.pos); this.pos += 4; return x; }
    u64() { const hi = this.u32(); return hi * 2 ** 32 + this.u32(); }
    int(size) { return size === 0 ? 0 : size === 2 ? this.u16() : size === 4 ? this.u32() : size === 8 ? this.u64() : this.fail(`field size ${size}`); }
    s32() { const x = this.v.getInt32(this.pos); this.pos += 4; return x; }
    fourcc() { const s = text(this.b, this.pos); this.pos += 4; return s; }
    fail(what) { throw new Error(`HEIF: unsupported ${what}`); }
}

// Boxes between start and end: [{ type, start (payload), end }].
function boxes(bytes, start, end) {
    const out = [];
    const r = new Reader(bytes, start, end);
    while (r.pos + 8 <= end) {
        const at = r.pos;
        let size = r.u32();
        const type = r.fourcc();
        if (size === 1) size = r.u64();
        else if (size === 0) size = end - at;
        if (size < 8 || at + size > end) throw new Error(`HEIF: bad ${type} box`);
        out.push({ type, start: r.pos, end: at + size });
        r.pos = at + size;
    }
    return out;
}

const child = (bytes, box, type, skip = 0) => boxes(bytes, box.start + skip, box.end).find(b => b.type === type);

export function isHeif(bytes) {
    if (bytes.length < 12 || text(bytes, 4) !== 'ftyp') return false;
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    const brands = [];
    for (let o = 8; o + 4 <= Math.min(size, bytes.length); o += 4) if (o !== 12) brands.push(text(bytes, o)); // 12: minor version
    if (brands.some(b => /^(heic|heix|heim|heis|hevc|hevx)$/.test(b))) return true;
    // AVIF lists mif1 too: it's the generic image brand, not a sign of HEVC.
    return brands.some(b => /^(mif1|msf1|heif)$/.test(b)) && !brands.some(b => /^(avif|avis|avio)$/.test(b));
}

function parseItemInfo(bytes, box) {
    const r = new Reader(bytes, box.start);
    const version = r.u8(); r.pos += 3;
    const count = version === 0 ? r.u16() : r.u32();
    const items = new Map();
    for (const infe of boxes(bytes, r.pos, box.end).slice(0, count)) {
        const e = new Reader(bytes, infe.start);
        const v = e.u8();
        const flags = (e.u8() << 16) | e.u16();
        if (v < 2) continue;
        const id = v === 2 ? e.u16() : e.u32();
        e.pos += 2; // protection index
        items.set(id, { id, type: e.fourcc(), hidden: !!(flags & 1) });
    }
    return items;
}

function parseLocations(bytes, box) {
    const r = new Reader(bytes, box.start);
    const version = r.u8(); r.pos += 3;
    const a = r.u8(), c = r.u8();
    const offsetSize = a >> 4, lengthSize = a & 15, baseSize = c >> 4, indexSize = version >= 1 ? c & 15 : 0;
    const count = version < 2 ? r.u16() : r.u32();
    const locs = new Map();
    for (let i = 0; i < count; i++) {
        const id = version < 2 ? r.u16() : r.u32();
        const method = version >= 1 ? r.u16() & 15 : 0;
        r.pos += 2; // data reference index
        const base = r.int(baseSize);
        const n = r.u16();
        const extents = [];
        for (let k = 0; k < n; k++) {
            if (indexSize) r.int(indexSize);
            extents.push({ offset: base + r.int(offsetSize), length: r.int(lengthSize) });
        }
        locs.set(id, { method, extents });
    }
    return locs;
}

function parseReferences(bytes, box) {
    const r = new Reader(bytes, box.start);
    const version = r.u8(); r.pos += 3;
    const refs = [];
    for (const b of boxes(bytes, r.pos, box.end)) {
        const e = new Reader(bytes, b.start);
        const from = version === 0 ? e.u16() : e.u32();
        const n = e.u16();
        const to = [];
        for (let i = 0; i < n; i++) to.push(version === 0 ? e.u16() : e.u32());
        refs.push({ type: b.type, from, to });
    }
    return refs;
}

const NCLX = {
    primaries: { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' },
    transfer: { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' },
    matrix: { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' },
};

function parseProperty(bytes, b) {
    const r = new Reader(bytes, b.start, b.end);
    switch (b.type) {
        case 'hvcC': return { type: 'hvcC', data: bytes.subarray(b.start, b.end) };
        case 'ispe': r.pos += 4; return { type: 'ispe', width: r.u32(), height: r.u32() };
        case 'irot': return { type: 'irot', angle: r.u8() & 3 };
        case 'imir': return { type: 'imir', axis: r.u8() & 1 };
        case 'clap': {
            const f = () => { const n = r.s32(); const d = r.s32(); return d ? n / d : 0; };
            return { type: 'clap', width: f(), height: f(), hOffset: f(), vOffset: f() };
        }
        case 'colr': {
            const kind = r.fourcc();
            if (kind === 'nclx') {
                const primaries = r.u16(), transfer = r.u16(), matrix = r.u16();
                return { type: 'colr', nclx: { primaries, transfer, matrix, fullRange: !!(r.u8() & 0x80) } };
            }
            if (kind === 'prof' || kind === 'rICC') return { type: 'colr', icc: bytes.subarray(r.pos, b.end) };
            return { type: 'other' };
        }
        case 'pixi': {
            r.pos += 4;
            const n = r.u8();
            return { type: 'pixi', bits: Array.from({ length: n }, () => r.u8()) };
        }
        case 'auxC': r.pos += 4; return { type: 'auxC', urn: new TextDecoder().decode(bytes.subarray(r.pos, b.end)).replace(/\0.*$/s, '') };
        default: return { type: b.type };
    }
}

function parseProperties(bytes, iprp) {
    const ipco = child(bytes, iprp, 'ipco');
    const props = ipco ? boxes(bytes, ipco.start, ipco.end).map(b => parseProperty(bytes, b)) : [];
    const assoc = new Map();
    for (const ipma of boxes(bytes, iprp.start, iprp.end).filter(b => b.type === 'ipma')) {
        const r = new Reader(bytes, ipma.start);
        const version = r.u8();
        const flags = (r.u8() << 16) | r.u16();
        const count = r.u32();
        for (let i = 0; i < count; i++) {
            const id = version < 1 ? r.u16() : r.u32();
            const n = r.u8();
            const list = assoc.get(id) || [];
            for (let k = 0; k < n; k++) {
                const index = flags & 1 ? r.u16() & 0x7fff : r.u8() & 0x7f;
                if (index && props[index - 1]) list.push(props[index - 1]);
            }
            assoc.set(id, list);
        }
    }
    return assoc;
}

// RFC 6381 / ISO 14496-15 Annex E codec string, e.g. 'hvc1.1.6.L93.B0'.
export function hevcCodecString(hvcC) {
    const r = new Reader(hvcC);
    r.pos = 1;
    const p = r.u8();
    const space = p >> 6, tier = (p >> 5) & 1, profile = p & 31;
    let compat = r.u32();
    let reversed = 0;
    for (let i = 0; i < 32; i++) { reversed = (reversed << 1) | (compat & 1); compat >>>= 1; }
    const constraints = Array.from(hvcC.subarray(6, 12));
    while (constraints.length && constraints.at(-1) === 0) constraints.pop();
    const level = hvcC[12];
    return ['hvc1', `${space ? 'ABC'[space - 1] : ''}${profile}`, (reversed >>> 0).toString(16).toUpperCase(),
        `${tier ? 'H' : 'L'}${level}`, ...constraints.map(c => c.toString(16).toUpperCase())].join('.');
}

export function hvcCInfo(hvcC) {
    return {
        chromaFormat: hvcC[16] & 3,
        bitDepth: (hvcC[17] & 7) + 8,
        bitDepthChroma: (hvcC[18] & 7) + 8,
        lengthSize: (hvcC[21] & 3) + 1,
    };
}

// The nclx colour box as a WebCodecs VideoColorSpaceInit (unknown codes are left to the bitstream).
export function videoColorSpace(nclx) {
    if (!nclx) return null;
    const out = { fullRange: nclx.fullRange };
    if (NCLX.primaries[nclx.primaries]) out.primaries = NCLX.primaries[nclx.primaries];
    if (NCLX.transfer[nclx.transfer]) out.transfer = NCLX.transfer[nclx.transfer];
    if (NCLX.matrix[nclx.matrix]) out.matrix = NCLX.matrix[nclx.matrix];
    return out;
}

// Clean-aperture crop in pixels of a width x height image, rounded like libheif.
export function clapRect(clap, width, height) {
    const w = Math.max(1, Math.min(width, Math.round(clap.width)));
    const h = Math.max(1, Math.min(height, Math.round(clap.height)));
    const left = Math.round(clap.hOffset + (width - 1) / 2 - (w - 1) / 2);
    const top = Math.round(clap.vOffset + (height - 1) / 2 - (h - 1) / 2);
    return {
        x: Math.max(0, Math.min(width - w, left)),
        y: Math.max(0, Math.min(height - h, top)),
        width: w, height: h,
    };
}

// Size once the transforms (in property order) are applied.
export function displaySize(image) {
    let w = image.width, h = image.height;
    for (const t of image.transforms) {
        if (t.type === 'clap') ({ width: w, height: h } = clapRect(t, w, h));
        else if (t.type === 'irot' && t.angle % 2) [w, h] = [h, w];
    }
    return { width: w, height: h };
}

function itemData(bytes, loc, idat) {
    if (!loc) throw new Error('HEIF: item has no data');
    const source = loc.method === 1 ? idat : loc.method === 0 ? bytes : null;
    if (!source) throw new Error('HEIF: unsupported item construction');
    if (loc.extents.length === 1) {
        const { offset, length } = loc.extents[0];
        if (offset + length > source.length) throw new Error('HEIF: truncated file');
        return source.subarray(offset, offset + (length || source.length - offset));
    }
    const total = loc.extents.reduce((s, e) => s + e.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const { offset, length } of loc.extents) {
        out.set(source.subarray(offset, offset + length), at);
        at += length;
    }
    return out;
}

// Parses a HEIF file. Returns { primary, thumbnail, exif } where each image is
// { id, kind: 'hvc1' | 'grid', width, height, rows, cols, tileWidth, tileHeight, tiles: Uint8Array[], hvcC, codec,
//   bitDepth, chromaFormat, transforms, nclx, icc, alpha } (width/height before transforms; see displaySize).
export function parseHeif(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isHeif(bytes)) throw new Error('Not a HEIF file');
    const meta = boxes(bytes, 0, bytes.length).find(b => b.type === 'meta');
    if (!meta) throw new Error('HEIF: no meta box');
    const inside = boxes(bytes, meta.start + 4, meta.end);
    const find = (type) => inside.find(b => b.type === type);

    const pitm = find('pitm');
    const pr = new Reader(bytes, pitm?.start ?? 0);
    const primaryId = pitm ? (pr.u8() === 0 ? (pr.pos += 3, pr.u16()) : (pr.pos += 3, pr.u32())) : null;
    const items = find('iinf') ? parseItemInfo(bytes, find('iinf')) : new Map();
    const locs = find('iloc') ? parseLocations(bytes, find('iloc')) : new Map();
    const refs = find('iref') ? parseReferences(bytes, find('iref')) : [];
    const props = find('iprp') ? parseProperties(bytes, find('iprp')) : new Map();
    const idatBox = find('idat');
    const idat = idatBox ? bytes.subarray(idatBox.start, idatBox.end) : null;

    const propsOf = (id) => props.get(id) || [];
    const prop = (id, type) => propsOf(id).find(p => p.type === type) || null;
    const data = (id) => itemData(bytes, locs.get(id), idat);

    const describe = (id) => {
        const item = items.get(id);
        if (!item) throw new Error(`HEIF: missing item ${id}`);
        const own = propsOf(id);
        const transforms = own.filter(p => p.type === 'irot' || p.type === 'imir' || p.type === 'clap');
        const colr = own.filter(p => p.type === 'colr');
        const alphaRef = refs.find(r => r.type === 'auxl' && r.to.includes(id) && /alpha/.test(prop(r.from, 'auxC')?.urn || ''));
        const base = {
            id, kind: item.type, transforms,
            nclx: colr.find(c => c.nclx)?.nclx || null,
            icc: colr.find(c => c.icc)?.icc || null,
            alpha: !!alphaRef,
        };
        if (item.type === 'hvc1') {
            const ispe = prop(id, 'ispe');
            const hvcC = prop(id, 'hvcC')?.data;
            if (!ispe || !hvcC) throw new Error('HEIF: image without size or decoder config');
            return { ...base, width: ispe.width, height: ispe.height, rows: 1, cols: 1, tileWidth: ispe.width, tileHeight: ispe.height,
                tiles: [data(id)], hvcC, codec: hevcCodecString(hvcC), ...hvcCInfo(hvcC) };
        }
        if (item.type === 'grid') {
            const g = new Reader(data(id));
            g.u8();
            const flags = g.u8();
            const rows = g.u8() + 1, cols = g.u8() + 1;
            const width = flags & 1 ? g.u32() : g.u16();
            const height = flags & 1 ? g.u32() : g.u16();
            const tileIds = refs.find(r => r.type === 'dimg' && r.from === id)?.to || [];
            if (tileIds.length !== rows * cols) throw new Error('HEIF: grid tile count mismatch');
            if (tileIds.some(t => items.get(t)?.type !== 'hvc1')) throw new Error('HEIF: grid of non-HEVC tiles');
            const first = tileIds[0];
            const ispe = prop(first, 'ispe');
            const hvcC = prop(first, 'hvcC')?.data;
            if (!ispe || !hvcC) throw new Error('HEIF: tile without size or decoder config');
            return { ...base, width, height, rows, cols, tileWidth: ispe.width, tileHeight: ispe.height,
                tiles: tileIds.map(data), hvcC, codec: hevcCodecString(hvcC), ...hvcCInfo(hvcC) };
        }
        throw new Error(`HEIF: unsupported image type ${item.type}`);
    };

    const id = primaryId ?? [...items.values()].find(i => !i.hidden && (i.type === 'hvc1' || i.type === 'grid'))?.id;
    const primary = describe(id);

    const thumbRef = refs.find(r => r.type === 'thmb' && r.to.includes(id) && items.get(r.from)?.type === 'hvc1');
    let thumbnail = null;
    if (thumbRef) {
        try { thumbnail = describe(thumbRef.from); } catch { thumbnail = null; }
        // Thumbnails don't always carry the master's rotation; they are shown like the master.
        if (thumbnail && !thumbnail.transforms.length) thumbnail.transforms = primary.transforms.filter(t => t.type !== 'clap');
    }

    let exif = null;
    const exifRef = refs.find(r => r.type === 'cdsc' && r.to.includes(id) && items.get(r.from)?.type === 'Exif');
    if (exifRef) {
        try {
            const raw = data(exifRef.from);
            const skip = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
            exif = raw.subarray(4 + skip);
        } catch { exif = null; }
    }

    return { primary, thumbnail, exif };
}

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map(c => c.charCodeAt(0));
const mkbox = (type, ...parts) => {
    const body = parts.flatMap(p => (p instanceof Uint8Array ? Array.from(p) : p));
    return [...be32(8 + body.length), ...ascii(type), ...body];
};
const mkfull = (type, version, flags, ...parts) => mkbox(type, [version, ...be32(flags).slice(1)], ...parts);

// A minimal one-item HEIF holding `data` (one coded HEVC frame), for decoders that only take whole files (libheif).
// Transforms are left out: the caller applies them, the same way for every decoder.
export function singleItemHeif({ hvcC, width, height, nclx = null }, data) {
    const props = [mkbox('hvcC', hvcC), mkfull('ispe', 0, 0, be32(width), be32(height))];
    if (nclx) props.push(mkbox('colr', ascii('nclx'), be16(nclx.primaries), be16(nclx.transfer), be16(nclx.matrix), [nclx.fullRange ? 0x80 : 0]));
    const ipma = mkfull('ipma', 0, 0, be32(1), be16(1), [props.length], props.map((_, i) => (i === 0 ? 0x80 : 0) | (i + 1)));
    const ftyp = mkbox('ftyp', ascii('heic'), be32(0), ascii('mif1heic'));
    const meta = (offset) => mkfull('meta', 0, 0,
        mkfull('hdlr', 0, 0, be32(0), ascii('pict'), new Array(13).fill(0)),
        mkfull('pitm', 0, 0, be16(1)),
        mkfull('iinf', 0, 0, be16(1), mkfull('infe', 2, 0, be16(1), be16(0), ascii('hvc1'), [0])),
        mkbox('iprp', mkbox('ipco', ...props), ipma),
        mkfull('iloc', 0, 0, [0x44, 0x00], be16(1), be16(1), be16(0), be16(1), be32(offset), be32(data.length)));
    const head = ftyp.length + meta(0).length;
    const out = new Uint8Array(head + 8 + data.length);
    out.set(ftyp, 0);
    out.set(meta(head + 8), ftyp.length);
    out.set([...be32(8 + data.length), ...ascii('mdat')], head);
    out.set(data, head + 8);
    return out;
}

// The parsed file when it's a HEIF this parser can read, else null (the browser may still open it natively).
export function probeHeif(bytes) {
    if (!isHeif(bytes)) return null;
    try {
        return parseHeif(bytes);
    } catch (err) {
        console.warn(err);
        return null;
    }
}
