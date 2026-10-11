# Image Toolbox — project context

Working knowledge for anyone (human or agent) changing this app. The README covers what the tools do; this file covers how the app is meant to behave, why, and the traps already found. `PLAN.md` holds the original plan and its decisions.

## What it is

An image toolbox served as a static page under `aukmind.github.io/image/`, shaped like the PDF editor (`/pdfmerge/`). Everything runs in the browser; no build step. Targets: Android, iOS, Firefox and Chrome — phones first. Every code path is picked by feature detection, never by user agent (the one exception: iOS puts Share before Download, because downloads land in Files there).

## Product decisions (from user feedback — keep them)

- **One workspace** of images, no tabs. Files are appended in the order they came; PDFs become one image per page. Opening files lands in Convert unless a tool was chosen first (landing card or a link opened fresh); a reload doesn't count as choosing.
- **Edits are ops, applied in place and undoable.** Each image has a pixel op list (rotate, flip, crop, resize, adjust, blur, annotate, watermark) and, separately, `meta` (the tags to save, or null for the default). The grid shows the result; `Undo change` in the header and the toast's Undo pop one step (one step per action, even over many images). No result banners.
- **Tools that re-edit their own last op** (Adjust, Annotate, Blur, Watermark) replace it instead of stacking another (`splitLast` in `img/ops.js`; the stepper/preview/apply logic is `useOpEditor` in `components/shared.js`). Resize replaces any resize: it sets the final size.
- **Selection decides the scope**: tools act on the picked images, none picked = all. "Each" tools (Crop, Adjust, Annotate, Blur, Watermark) step through the picked images, labelled with their real position.
- **Previews are exact**: stages and thumbnails are rendered by the same code that saves (worker + `render.js`). The only exception is Watermark's live overlay, which uses the same `drawWatermark()` on a canvas over the stage so sliders follow the finger.
- **HEIC decodes once** into a proxy (JPEG 95 %, ≤ 24 MP). **Highest resolution** (Convert/Compress, remembered) renders saved files from the original HEIC instead.
- **Compress "under N KB"** searches quality first, then shrinks the pixels until the file fits; the user is told the new size. The limit (remembered) and re-encoding apply only to saves made from Compress.
- **Metadata** is removed on save by default. The Metadata tool lists every editable tag of the picked photos (values of the photo tapped last, else the first); keeping, removing or editing applies to all picked photos. A remembered default (`metaDefault`: remove all / keep all but location / keep all) applies to photos not edited there; an empty `meta` ({}) means "removed" whatever the default. Other tags are shown read-only and always removed. Only JPG and PNG can carry metadata (the browser's WEBP/AVIF encoders can't); the user is warned.
- **Saved JPG/PNG files always carry `Software: https://aukmind.com/image`** (where Photoshop would appear); PDFs get it as Creator/Producer.
- **Untouched JPG/PNG are saved losslessly**: metadata swapped, pixels copied bit for bit, orientation tag kept.
- **Blur** areas can be boxes or circles. **Watermark** supports text, logo or both; a repeated pattern alternates them row by row and can join them with grid lines (crosses); angles go by 1°; "Watermark & save all" applies and downloads in one step.
- **Phones**: tools in a strip at the bottom, the main action in a bar just above it, + and camera buttons bottom-left, Android back closes the viewer. The stage zoom pill sits under the photo (on it, it covered crop handles).
- **Share** is tried right away; if the tap that started a long save has expired, a sticky toast's Share button provides a fresh one.
- **Keyboard**: shortcuts leave text fields and sliders alone, and a shortcut that means something to a focused button (Enter) calls preventDefault; the viewer owns its keys in the capture phase.
- **Tablets** get the phone layout's bottom tool strip (up to 1023 px); every touch screen gets ~40 px controls. + and the camera never float over content: on phones they sit at the left end of the bottom action bar, on tablets at the left end of the tool strip. Bottom space comes from `--rail-h`, `--bar-h` and `--fabs-w` in `styles.css`.
- **Thumbnails** re-render only for cards near the screen; one that scrolls away keeps its last picture and its queued render is dropped.
- **The UI must not move under the user**: disable rather than hide (quality slider for PNG, position picker when tiling), reserve space.

## Architecture

- `js/main.js` — shell: landing, rail, header row (`WorkspaceBar`: summary, undo, save split button, close), viewer, drop/paste, + and camera. `TOOL_VIEWS` maps tool ids to components.
- `js/store.js` — the only place that changes images: `addFiles`, `pick`/`pickCamera`, `edit(items, fn, summary)` / `addOp` (pixels), `editMeta` (tags), `remove`, `reorder`, `undo` (snapshots of order + each image's ops and meta), thumbnails (`thumb(item)`, cached per op list), `previewUrl`, `outputs` / `save(as)`, `run(label, fn)` for long jobs, save settings (persisted).
- `js/tools.js` — registry: id, group, label, hint, icon, scope, keepsState.
- `js/img/` — no Vue, unit-tested where pure:
  - `heif.js` HEIF parser (grid tiles, thumbnail item, irot/imir/clap, nclx/ICC, Exif) and `singleItemHeif()` to wrap one tile as a file.
  - `decode.js` engine (main-thread face of the pool), path order, pool size (1 worker on iOS). `pool.js` worker pool: priority, newest first, one large job at a time, cancellable tags (stage previews), affinity (an image's previews go to the worker holding it decoded).
  - `worker.js` decode (native → WebCodecs HEVC tiles → libheif per tile), proxy + thumbnail, render + encode, bench. Reads only a file's head unless it's HEIF; `prepare` reports `heif`/`rotated` once (the store passes them with every render, so headers are never re-read); `decodeScaled` decodes JPG/PNG/WebP straight at the size needed (rotated JPEGs only once a tiny probe shows the browser orients resized decodes); thumbnails of edited photos render from the 480 px thumbnail when it's enough; keeps the last decoded preview source; previews are WebP, or JPEG/PNG where WebP can't be written.
  - `render.js` ops → canvas (pure geometry/colour helpers + executor), `crop.js` box math, `ops.js` op-list rules, `encode.js` formats/quality search/names, `meta.js` read/strip/write metadata, `pdf.js` PDF in/out.
- `js/components/` — one file per tool; `shared.js` holds the grid/cards, selection bar, zoomable stage, stepper, drag helpers.
- `/shared/` (site root, shared with pdfmerge): `icons.js`, `options.js`, `fonts.js` (FontSelect, `fontCss`, device fonts, font files), `zoom.js` (wheel, Safari gesture and two-finger touch pinch, once per frame), `dom.js` (listeners, `useKeydown`, `useFileDrop`, `pickFiles`, `useObjectUrls`, drag/rect helpers, `useSortable`), `load.js` (`loadScript`, `once`), `handoff.js` (the IndexedDB protocol between the apps).

## Traps already hit

- **Vue proxies can't be posted to a worker** ("could not be cloned"). Ops are unwrapped with `plain()` when stored (`edit`) and when draft ops are previewed (`previewUrl`). A failed `postMessage` must free the worker and the large-job slot, or every later render waits forever (it once did: endless spinners).
- **libheif-js's `display()` assumes the decoded frame is the item's size** and throws from a timer (uncatchable) when the coded frame is padded. The worker reads libheif's planes itself (`libheifPixels`).
- **HEIF `imir` axis 1 mirrors left-right** (as libheif does), applied after `irot` in property order; `irot` turns anticlockwise.
- **A stacked flex column with `align-items: flex-start` collapses the stage** (it has no width of its own): Adjust and Watermark showed no photo on phones. The stacked `.editor` stretches its children.
- **Browsers disagree on Exif orientation when createImageBitmap resizes**: hence the probe, and a size check on every reduced decode (a mismatch falls back to a full decode).
- **Samsung puts `mdat` before `meta`**: the parser needs the whole file.
- **`OffscreenCanvas.convertToBlob` needs a context first** (`getContext('2d')`), and browsers silently return PNG for types they can't write — `encodeCanvas` checks the type.
- **Spreading saved values into a reactive form** can copy fields like `type` that break the op (Adjust once lost its `type`, so previews and re-applies did nothing).
- **Headless Chromium has no HEVC**; WebCodecs must be checked in real Chrome (bench.html) or on the phone.
- Same as pdfmerge: the production Vue build hides template warnings (test with `vue.global.js`), ES modules cache hard (hard-reload), `node --check` parses CommonJS (use `node --input-type=module --check < file.js`), naive-ui styles beat plain class selectors.

## Running and testing

- Serve the site root (`python3 -m http.server`), open `/image/`. `npm test` runs the unit tests.
- Browser checks: Playwright (Chromium and Firefox) scripts or Claude-in-Chrome in a dedicated tab; swap in `vue.global.js` while testing. Phones: `adb reverse tcp:8000 tcp:8000`, then `bench.html` and the app.

## Conventions

- Comments only for non-obvious *why*; docs describe shapes and decisions, not code.
- Commit only when asked; work happens on branch `image-toolbox` (shared modules: `shared-modules` in the site root and pdfmerge).
