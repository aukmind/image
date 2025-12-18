# Aukmind Image Converter

Local & secure image processing in the browser, using Vue 3 + Naive UI from CDN
(no build step) and ImageMagick WASM.

Open `index.html` in any static file server (e.g. `python3 -m http.server`).

Files:
- `index.html` — markup + Vue/Naive UI CDN scripts
- `app.js` — Vue component and orchestration
- `image-handler.js` — Canvas fast-path + ImageMagick fallback
- `pdf-handler.js` — pdf.js (read pages) + jsPDF (write multi-page PDF)
- `styles.css` — plain CSS
