import {
  Format,
  formatExtension,
  isCanvasOutput,
  isPassthrough,
  processInWorker,
  preloadHeic
} from './image-handler.js';
import { expandPdfPages, bundleImagesToPdf } from './pdf-handler.js';

const { createApp, defineComponent, ref, onMounted, onBeforeUnmount } = Vue;
const naive = window.naive;

const QUICK_FORMATS = [
  ['PNG', Format.Png],
  ['JPG', Format.Jpeg],
  ['WEBP', Format.WebP],
  ['PDF', Format.Pdf]
];

const quickFormatList = QUICK_FORMATS.map(([label, value]) => ({ label, value }));

const HEIC_EXT = /\.(hei[cf]|hif)$/i;

const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const ImageApp = defineComponent({
  template: '#image-app-template',
  setup() {
    const message = naive.useMessage();

    const processing = ref(false);
    const progress = ref(0);
    const progressLabel = ref('');
    const errorMessage = ref('');

    const files = ref([]);
    const isDragging = ref(false);

    const targetFormat = ref(Format.Png);
    const quality = ref(90);

    const resizeMode = ref('none');
    const resizePercent = ref(50);
    const resizeWidth = ref(null);
    const resizeHeight = ref(null);
    const lockRatio = ref(true);
    const rotation = ref(0);

    const resizeModeOptions = [
      { label: 'None', value: 'none' },
      { label: 'Percent', value: 'percent' },
      { label: 'Pixels', value: 'pixels' }
    ];

    onMounted(() => {
      const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1000));
      idle(() => preloadHeic().catch(() => {}));
    });

    onBeforeUnmount(() => {
      files.value.forEach(f => URL.revokeObjectURL(f.preview));
    });

    const wrapFile = (f) => ({
      file: f,
      id: crypto.randomUUID(),
      preview: URL.createObjectURL(f),
      renderError: false
    });

    const isAccepted = (f) =>
      f.type.startsWith('image/') ||
      f.type === 'application/pdf' ||
      HEIC_EXT.test(f.name || '');

    const addFiles = async (fileList) => {
      const incoming = Array.from(fileList);
      const valid = incoming.filter(isAccepted);
      const rejected = incoming.filter(f => !isAccepted(f));

      if (rejected.length) {
        const head = rejected.slice(0, 5).map(f => f.name).join(', ');
        const more = rejected.length > 5 ? `, and ${rejected.length - 5} others.` : '.';
        errorMessage.value = `Skipped unsupported files: ${head}${more}`;
      } else {
        errorMessage.value = '';
      }

      const pdfs = valid.filter(f => f.type === 'application/pdf');
      const images = valid.filter(f => f.type !== 'application/pdf');
      files.value = [...files.value, ...images.map(wrapFile)];

      if (pdfs.length === 0) return;

      processing.value = true;
      try {
        for (const pdf of pdfs) {
          progressLabel.value = `Reading ${pdf.name}...`;
          progress.value = 0;
          try {
            const pages = await expandPdfPages(pdf, 1.5, (i, total) => {
              progressLabel.value = `Reading ${pdf.name} (${i + 1}/${total})`;
              progress.value = ((i + 1) / total) * 100;
            });
            files.value = [...files.value, ...pages.map(wrapFile)];
          } catch (e) {
            errorMessage.value = `Failed to read ${pdf.name}: ${e.message}`;
          }
        }
      } finally {
        processing.value = false;
        progress.value = 0;
        progressLabel.value = '';
      }
    };

    const removeFile = (id) => {
      const removed = files.value.find(f => f.id === id);
      if (removed) URL.revokeObjectURL(removed.preview);
      files.value = files.value.filter(f => f.id !== id);
    };

    const handlePreviewError = (item) => { item.renderError = true; };

    const onDrop = (e) => {
      isDragging.value = false;
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
    };

    const rotateLeft = () => rotation.value = (rotation.value - 90 + 360) % 360;
    const rotateRight = () => rotation.value = (rotation.value + 90) % 360;

    const buildOpts = () => ({
      targetFormat: targetFormat.value,
      quality: quality.value,
      rotation: rotation.value,
      resizeMode: resizeMode.value,
      resizePercent: resizePercent.value,
      resizeWidth: resizeWidth.value,
      resizeHeight: resizeHeight.value,
      lockRatio: lockRatio.value
    });

    const convertOne = (file, opts) => {
      if (isPassthrough(file, opts)) return Promise.resolve(file);
      return processInWorker(file, opts);
    };

    const convertAndDownload = async () => {
      if (files.value.length === 0) return;
      processing.value = true;
      progress.value = 0;
      errorMessage.value = '';

      try {
        const opts = buildOpts();
        const ext = formatExtension(opts.targetFormat);
        const targetIsPdf = opts.targetFormat === Format.Pdf;
        const stepOpts = targetIsPdf ? { ...opts, targetFormat: Format.Jpeg } : opts;
        const stepCap = targetIsPdf ? 80 : 100;
        const total = files.value.length;
        const processed = [];

        for (let i = 0; i < total; i++) {
          const item = files.value[i];
          progressLabel.value = `Processing ${item.file.name}...`;
          const blob = await convertOne(item.file, stepOpts);
          const newName = item.file.name.replace(/\.[^/.]+$/, '') + '.' + ext;
          processed.push({ name: newName, blob });
          progress.value = ((i + 1) / total) * stepCap;
        }

        if (targetIsPdf) {
          progressLabel.value = 'Building PDF...';
          const pdfBlob = await bundleImagesToPdf(
            processed.map(p => p.blob),
            (i, t) => { progress.value = 80 + (i / t) * 20; }
          );
          triggerDownload(pdfBlob, 'document.pdf');
        } else if (total > 1) {
          progressLabel.value = 'Compressing...';
          const zip = new JSZip();
          processed.forEach(p => zip.file(p.name, p.blob));
          const content = await zip.generateAsync({ type: 'blob' });
          triggerDownload(content, 'converted_images.zip');
        } else {
          triggerDownload(processed[0].blob, processed[0].name);
        }
        message.success('Conversion complete!');
      } catch (e) {
        console.error(e);
        errorMessage.value = 'Conversion failed. ' + (e.message || e);
      } finally {
        processing.value = false;
        progress.value = 0;
        progressLabel.value = '';
      }
    };

    return {
      processing, progress, progressLabel, errorMessage,
      files, isDragging,
      targetFormat, quality,
      resizeMode, resizePercent, resizeWidth, resizeHeight, lockRatio, rotation,
      resizeModeOptions, quickFormatList,
      addFiles, removeFile, handlePreviewError, onDrop,
      rotateLeft, rotateRight,
      convertAndDownload
    };
  }
});

const app = createApp({
  setup() {
    return { theme: window.aukmindTheme || null };
  }
});

app.use(naive);
app.component('image-app', ImageApp);
app.mount('#app');
