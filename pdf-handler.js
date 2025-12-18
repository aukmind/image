const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

const loadScript = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src;
  s.onload = () => resolve();
  s.onerror = () => reject(new Error('Failed to load ' + src));
  document.head.appendChild(s);
});

let pdfjsPromise = null;
let jspdfPromise = null;

function ensurePdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = loadScript(`${PDFJS_BASE}/pdf.min.js`).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;
      return window.pdfjsLib;
    });
  }
  return pdfjsPromise;
}

function ensureJsPdf() {
  if (!jspdfPromise) {
    jspdfPromise = loadScript(JSPDF_URL).then(() => window.jspdf.jsPDF);
  }
  return jspdfPromise;
}

export async function expandPdfPages(file, scale = 1.5, onProgress) {
  const pdfjs = await ensurePdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const baseName = file.name.replace(/\.pdf$/i, '');
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i - 1, pdf.numPages);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    pages.push(new File([blob], `${baseName}-page-${i}.jpg`, { type: 'image/jpeg' }));
  }
  return pages;
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

export async function bundleImagesToPdf(blobs, onProgress) {
  const jsPDF = await ensureJsPdf();
  let doc = null;
  for (let i = 0; i < blobs.length; i++) {
    onProgress?.(i, blobs.length);
    const blob = blobs[i];
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width, h = bitmap.height;
    bitmap.close?.();
    const dataUrl = await blobToDataUrl(blob);
    if (!doc) {
      doc = new jsPDF({ unit: 'pt', format: [w, h], compress: true });
    } else {
      doc.addPage([w, h]);
    }
    const fmt = blob.type === 'image/png' ? 'PNG' : 'JPEG';
    doc.addImage(dataUrl, fmt, 0, 0, w, h);
  }
  return doc.output('blob');
}
