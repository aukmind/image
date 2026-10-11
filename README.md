# Image Toolbox

Every image tool, private by design: convert (HEIC → JPG included), compress, resize, crop, rotate, adjust, annotate, blur, edit metadata and watermark photos — in the browser, on phones first. Nothing is uploaded.

Served as a static page under `aukmind.github.io/image/`. No build step: Vue 3 + naive-ui from CDNs, ES modules as-is.

## Tools

| Group | Tool | What it does |
|---|---|---|
| Convert | Convert | Same format / JPG / PNG / WEBP / PDF (AVIF where the browser can write it), quality, **Highest resolution** for HEIC |
| | Compress | A quality, or a size every file must stay under (quality search, then shrinking if needed) |
| | Resize | Longest side (1080…4K presets), percent, or width × height |
| Edit | Crop | Photo by photo, free or fixed shapes, "Crop & next", same box for all |
| | Rotate | Turn or mirror one photo or the selection |
| | Adjust | Brightness, contrast, saturation, warmth, black & white — exact live preview |
| | Annotate | Text, arrows, lines, boxes, circles, drawing, highlighter, device and added fonts |
| Privacy | Blur | Boxes or circles that blur or pixelate |
| | Metadata | View, keep, remove and edit tags (bulk over the selection); a remembered default for unedited photos |
| | Watermark | Text, logo or both; one corner or a repeated pattern with optional grid lines; "Watermark & save all" |

Saving: the header's split button downloads the selection (or everything) in the chosen format; its menu has Share… (send to apps / Save to Photos), ZIP, Make a PDF and Open in PDF Editor. Untouched JPG/PNG files are saved losslessly (metadata swapped, pixels untouched). Saved JPG/PNG files carry `Software: https://aukmind.com/image`.

## Running

Serve the **site root** so `/shared/` and `/naive-ui-theme.js` resolve:

    cd aukmind.github.io && python3 -m http.server 8000

then open `http://localhost:8000/image/`. On an Android phone over USB (secure context, so WebCodecs works): `adb reverse tcp:8000 tcp:8000` and open the same URL in Chrome on the phone.

`bench.html` times every HEIC decode path on your own photos (Copy results to share the numbers).

## Tests

    npm test

`node:test` on the pure modules (HEIF parser, render math, crop math, encoding, metadata). Fixtures: `tests/fixtures/make-heic.py` and `make-jpeg.py` build the committed synthetic files; personal photos go in `tests/fixtures/private/` (git-ignored) and are picked up by the parser test.

## Libraries (CDN, pinned)

Vue 3.5, naive-ui 2.45, Sortable 1.15; loaded on first use: libheif-js 1.19 (HEIC fallback), exifr 7.1 (reading metadata), pdf.js 3.11 (PDF pages in), pdf-lib 1.17 (PDF out), JSZip 3.10.
