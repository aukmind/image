// PDFs in (pages become images) and out (pdf-lib, one page per image), plus the hand-off to the PDF editor.

const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
const PDFLIB_URL = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const PAGE_LONGEST = 3000;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Couldn't download ${src.split('/').pop()}`));
        document.head.appendChild(s);
    });
}

let pdfjs = null;
const loadPdfJs = () => (pdfjs ??= loadScript(`${PDFJS_BASE}/pdf.min.js`).then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;
    return window.pdfjsLib;
}).catch((err) => { pdfjs = null; throw err; }));

let pdflib = null;
const loadPdfLib = () => (pdflib ??= loadScript(PDFLIB_URL).then(() => window.PDFLib).catch((err) => { pdflib = null; throw err; }));

export const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

// Each page as a JPEG File (longest side ~3000 px), named like "report-page-2.jpg".
export async function pdfToImages(file, onProgress = null) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const stem = file.name.replace(/\.pdf$/i, '');
    const pages = [];
    try {
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(4, PAGE_LONGEST / Math.max(base.width, base.height)) });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport }).promise;
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
            canvas.width = canvas.height = 0;
            page.cleanup();
            pages.push(new File([blob], `${stem}-page-${i}.jpg`, { type: 'image/jpeg' }));
            onProgress?.(i / doc.numPages);
        }
    } finally {
        doc.destroy();
    }
    return pages;
}

// entries: [{ blob (JPEG or PNG), width, height }] → PDF bytes; each page is the image's size at 96 dpi.
export async function imagesToPdf(entries, { creator = null } = {}) {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();
    if (creator) {
        doc.setCreator(creator);
        doc.setProducer(creator);
    }
    for (const { blob, width, height } of entries) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const image = blob.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const w = width * 0.75, h = height * 0.75;
        doc.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
    }
    return doc.save();
}

// The PDF editor (/pdfmerge/) picks these up when opened at #import.
const HANDOFF_DB = 'aukmind-handoff';

function openHandoff() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(HANDOFF_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function handOffToPdfEditor(files) {
    const db = await openHandoff();
    await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ at: Date.now(), files: files.map(f => ({ name: f.name, type: f.type, blob: f })) }, 'pending');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}
