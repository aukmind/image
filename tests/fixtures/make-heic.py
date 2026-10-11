"""Builds the synthetic HEIC fixtures and their expected colours.

    python3 -m venv .venv && .venv/bin/pip install pillow-heif
    .venv/bin/python tests/fixtures/make-heic.py

grid.heic: a 2x2 grid of 64 px HEVC tiles (red, green / blue, white) cropped to 120x100, with irot, imir,
an nclx colour box and a 32 px thumbnail item, laid out like a phone photo. single.heic: one plain item.
expected.json holds libheif's decode of both (size and the colour at a few points) as the reference.
"""
import io
import json
import struct
from pathlib import Path

import pillow_heif
from PIL import Image

HERE = Path(__file__).parent
TILE = 64
OUT_W, OUT_H = 120, 100
COLORS = [(220, 40, 40), (40, 200, 60), (40, 60, 220), (240, 240, 240)]
IROT = 1  # 90 degrees anticlockwise
IMIR = 1


def box(kind, payload):
    return struct.pack('>I4s', 8 + len(payload), kind) + payload


def full(kind, version, flags, payload):
    return box(kind, struct.pack('>I', (version << 24) | flags) + payload)


def children(data, start, end):
    out = {}
    o = start
    while o < end:
        size, kind = struct.unpack('>I4s', data[o:o + 8])
        out.setdefault(kind, []).append((o, size))
        o += size
    return out


def encode_one(img):
    """Encodes one image with x265 and returns (hvcC payload, coded data) from libheif's output file."""
    buf = io.BytesIO()
    pillow_heif.from_pillow(img).save(buf, quality=90, chroma=420, save_to_12bit=False)
    data = buf.getvalue()
    top = children(data, 0, len(data))
    meta_o, meta_s = top[b'meta'][0]
    meta = children(data, meta_o + 12, meta_o + meta_s)
    iprp_o, iprp_s = meta[b'iprp'][0]
    ipco_o, ipco_s = children(data, iprp_o + 8, iprp_o + iprp_s)[b'ipco'][0]
    hvcc_o, hvcc_s = children(data, ipco_o + 8, ipco_o + ipco_s)[b'hvcC'][0]
    hvcc = data[hvcc_o + 8:hvcc_o + hvcc_s]
    iloc_o, _ = meta[b'iloc'][0]
    version = data[iloc_o + 8]
    sizes = data[iloc_o + 12]
    offset_size, length_size, base_size = sizes >> 4, sizes & 15, data[iloc_o + 13] >> 4
    assert (offset_size, length_size, base_size) in ((4, 4, 0), (0, 4, 0), (4, 4, 4)), (offset_size, length_size, base_size)
    p = iloc_o + 14
    count = struct.unpack('>H', data[p:p + 2])[0]
    p += 2
    extents = []
    for _ in range(count):
        p += 2  # item id
        if version >= 1:
            p += 2
        p += 2  # data reference index
        base = int.from_bytes(data[p:p + base_size], 'big') if base_size else 0
        p += base_size
        n = struct.unpack('>H', data[p:p + 2])[0]
        p += 2
        for _ in range(n):
            off = int.from_bytes(data[p:p + offset_size], 'big') if offset_size else 0
            p += offset_size
            length = int.from_bytes(data[p:p + length_size], 'big')
            p += length_size
            extents.append(data[base + off:base + off + length])
    return hvcc, b''.join(extents)


def ispe(w, h):
    return full(b'ispe', 0, 0, struct.pack('>II', w, h))


def infe(item_id, kind, hidden=False):
    return full(b'infe', 2, 1 if hidden else 0, struct.pack('>HH4s', item_id, 0, kind) + b'\0')


def build_grid():
    tiles = []
    for color in COLORS:
        hvcc, coded = encode_one(Image.new('RGB', (TILE, TILE), color))
        tiles.append(coded)
    tile_hvcc = hvcc
    thumb_img = Image.new('RGB', (32, 24))
    for i, color in enumerate(COLORS):
        thumb_img.paste(color, ((i % 2) * 16, (i // 2) * 12, (i % 2) * 16 + 16, (i // 2) * 12 + 12))
    thumb_hvcc, thumb_coded = encode_one(thumb_img)

    tile_ids = [1, 2, 3, 4]
    grid_id, thumb_id = 5, 6
    grid_desc = struct.pack('>BBBBHH', 0, 0, 1, 1, OUT_W, OUT_H)

    # Property indices are 1-based in ipma.
    props = [
        box(b'hvcC', tile_hvcc),            # 1
        ispe(TILE, TILE),                   # 2
        ispe(OUT_W, OUT_H),                 # 3
        box(b'irot', bytes([IROT])),        # 4
        box(b'imir', bytes([IMIR])),        # 5
        box(b'colr', b'nclx' + struct.pack('>HHHB', 1, 13, 6, 0x80)),  # 6: bt709 / sRGB / bt601, full range
        box(b'hvcC', thumb_hvcc),           # 7
        ispe(32, 24),                       # 8
    ]
    assoc = [(i, [(1, True), (2, False)]) for i in tile_ids]
    assoc.append((grid_id, [(3, False), (6, False), (4, True), (5, True)]))
    assoc.append((thumb_id, [(7, True), (8, False)]))
    ipma = struct.pack('>I', len(assoc)) + b''.join(
        struct.pack('>HB', item, len(a)) + bytes((0x80 if essential else 0) | idx for idx, essential in a) for item, a in assoc)
    iprp = box(b'iprp', box(b'ipco', b''.join(props)) + full(b'ipma', 0, 0, ipma))

    iinf = full(b'iinf', 0, 0, struct.pack('>H', 6) + b''.join(
        [infe(i, b'hvc1', hidden=True) for i in tile_ids] + [infe(grid_id, b'grid'), infe(thumb_id, b'hvc1')]))
    iref = full(b'iref', 0, 0,
                box(b'dimg', struct.pack('>HH', grid_id, 4) + b''.join(struct.pack('>H', i) for i in tile_ids))
                + box(b'thmb', struct.pack('>HHH', thumb_id, 1, grid_id)))
    hdlr = full(b'hdlr', 0, 0, b'\0' * 4 + b'pict' + b'\0' * 12 + b'\0')
    pitm = full(b'pitm', 0, 0, struct.pack('>H', grid_id))
    idat = box(b'idat', grid_desc)

    payloads = tiles + [thumb_coded]
    payload_ids = tile_ids + [thumb_id]

    def iloc(mdat_start):
        entries = []
        offset = mdat_start + 8
        for item, data in zip(payload_ids, payloads):
            entries.append(struct.pack('>HHHHII', item, 0, 0, 1, offset, len(data)))
            offset += len(data)
        entries.append(struct.pack('>HHHHII', grid_id, 1, 0, 1, 0, len(grid_desc)))
        return full(b'iloc', 1, 0, bytes([0x44, 0x00]) + struct.pack('>H', len(entries)) + b''.join(entries))

    ftyp = box(b'ftyp', b'heic' + struct.pack('>I', 0) + b'mif1heic')

    def meta(mdat_start):
        return full(b'meta', 0, 0, hdlr + pitm + iinf + iref + iprp + iloc(mdat_start) + idat)

    mdat_start = len(ftyp) + len(meta(0))
    return ftyp + meta(mdat_start) + box(b'mdat', b''.join(payloads))


def reference(path, points):
    heif = pillow_heif.open_heif(path, convert_hdr_to_8bit=True)
    img = heif.to_pillow().convert('RGB')
    info = {'width': img.width, 'height': img.height,
            'points': [{'x': x, 'y': y, 'rgb': list(img.getpixel((round(x * (img.width - 1)), round(y * (img.height - 1)))))}
                       for x, y in points]}
    if heif.info.get('thumbnails'):
        info['thumbnail'] = True
    return info


def main():
    grid = build_grid()
    (HERE / 'grid.heic').write_bytes(grid)

    single = Image.new('RGB', (80, 60), (250, 200, 30))
    single.paste((30, 30, 30), (0, 0, 40, 30))
    heif = pillow_heif.from_pillow(single)
    heif[0].info["thumbnails"] = [24]
    heif.save(HERE / 'single.heic', quality=92, chroma=420)

    corners = [(0.15, 0.15), (0.85, 0.15), (0.15, 0.85), (0.85, 0.85)]
    expected = {'grid.heic': reference(HERE / 'grid.heic', corners), 'single.heic': reference(HERE / 'single.heic', corners)}
    (HERE / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')
    print(json.dumps(expected, indent=2))


if __name__ == '__main__':
    main()
