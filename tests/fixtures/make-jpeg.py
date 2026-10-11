"""Builds gps.jpg: a small JPEG with GPS, camera, date taken and Orientation 6, for the metadata tests.

    .venv/bin/python tests/fixtures/make-jpeg.py
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent

img = Image.new('RGB', (40, 30), (200, 120, 40))
exif = Image.Exif()
exif[0x010F] = 'TestMake'
exif[0x0110] = 'TestMake Phone 1'
exif[0x0112] = 6
exif[0x0131] = 'Fixture 1.0'
exif.get_ifd(0x8769)[0x9003] = '2024:05:06 07:08:09'
gps = exif.get_ifd(0x8825)
gps[1] = 'N'
gps[2] = (50.0, 50.0, 0.0)
gps[3] = 'E'
gps[4] = (4.0, 21.0, 0.0)
img.save(HERE / 'gps.jpg', quality=90, exif=exif, comment=b'secret comment')

# progressive.jpg: several scans, so the stripper must walk past more than one SOS.
noisy = Image.effect_noise((64, 48), 60).convert('RGB')
noisy.save(HERE / 'progressive.jpg', quality=85, progressive=True, exif=exif)

# size-*.webp: the three WebP layouts the header reader must know (lossy VP8, lossless VP8L, extended VP8X).
small = Image.new('RGB', (37, 21), (10, 120, 200))
small.save(HERE / 'size-lossy.webp', quality=80)
small.save(HERE / 'size-lossless.webp', lossless=True)
Image.new('RGBA', (37, 21), (10, 120, 200, 128)).save(HERE / 'size-extended.webp', quality=80, exif=exif)
