import {
  ensureMagickReady,
  MagickFormat,
  isMultiFrameFormat,
  isAnimationFormat,
  canUseCanvasPath,
  processViaCanvas,
  processSingleImage,
  processMergeAnimation
} from './image-handler.js';
import { expandPdfPages, bundleImagesToPdf } from './pdf-handler.js';

const { createApp, defineComponent, ref, computed, watch, onMounted, onBeforeUnmount } = Vue;
const naive = window.naive;

const QUICK_FORMATS = [
  ['PNG', MagickFormat.Png],
  ['JPG', MagickFormat.Jpeg],
  ['GIF', MagickFormat.Gif],
  ['WEBP', MagickFormat.WebP],
  ['PDF', MagickFormat.Pdf],
  ['BMP', MagickFormat.Bmp],
  ['ICO', MagickFormat.Ico]
];
const EXTRA_FORMATS = [
  ['TIFF', MagickFormat.Tiff],
  ['AVIF', MagickFormat.Avif],
  ['TGA', MagickFormat.Tga],
  ['DDS', MagickFormat.Dds]
];

const toOptions = (entries) => entries.map(([label, value]) => ({ label, value }));
const quickFormatList = toOptions(QUICK_FORMATS);
const extraFormatOptions = toOptions(EXTRA_FORMATS);
const extraFormatSet = new Set(EXTRA_FORMATS.map(([, v]) => v));

const formatExtension = (format) => format === MagickFormat.Jpeg ? 'jpg' : format;

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

const friendlyError = (msg) => {
  if (msg.includes('FailedToExecuteCommand') || msg.includes('ffmpeg'))
    return 'This format requires external libraries (ffmpeg) not available. Please use GIF or WebP.';
  if (msg.includes('ImagesAreNotTheSameSize'))
    return "GIF Error: Frames mismatch. Please ensure 'Resize' width/height are set if locking ratio.";
  return 'Conversion failed. ' + msg;
};

const ImageApp = defineComponent({
  template: '#image-app-template',
  setup() {
    const message = naive.useMessage();

    const isReady = ref(false);
    const processing = ref(false);
    const progress = ref(0);
    const progressLabel = ref('');
    const errorMessage = ref('');

    const files = ref([]);
    const isDragging = ref(false);

    const targetFormat = ref(MagickFormat.Png);
    const quality = ref(90);
    const makeAnimation = ref(false);
    const animationDelay = ref(200);

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

    const isExtraFormatActive = computed(() => extraFormatSet.has(targetFormat.value));
    const isMultiFrame = computed(() => isMultiFrameFormat(targetFormat.value));
    const canMergeAnimation = computed(() =>
      files.value.length >= 2 && isAnimationFormat(targetFormat.value)
    );

    watch(canMergeAnimation, (ok) => { if (!ok) makeAnimation.value = false; });

    const loadEngine = async () => {
      if (isReady.value) return;
      await ensureMagickReady();
      isReady.value = true;
    };

    onMounted(() => {
      const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
      idle(() => loadEngine().catch((e) => {
        errorMessage.value = 'Failed to load Magick: ' + e.message;
      }));
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

    const isAccepted = (f) => f.type.startsWith('image/') || f.type === 'application/pdf';

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
      lockRatio: lockRatio.value,
      animationDelay: animationDelay.value
    });

    const convertOne = async (file, opts) => {
      if (canUseCanvasPath(file, opts.targetFormat)) {
        try { return await processViaCanvas(file, opts); }
        catch (e) { console.warn('Canvas path failed, falling back to WASM', e); }
      }
      await loadEngine();
      return processSingleImage(file, opts);
    };

    const convertAndDownload = async () => {
      if (files.value.length === 0) return;
      processing.value = true;
      progress.value = 0;
      errorMessage.value = '';

      try {
        const opts = buildOpts();
        const ext = formatExtension(opts.targetFormat);
        const merging = makeAnimation.value && canMergeAnimation.value;
        const targetIsPdf = opts.targetFormat === MagickFormat.Pdf;

        if (merging) {
          progressLabel.value = 'Loading engine...';
          await loadEngine();
          progressLabel.value = 'Merging Animation...';
          const blob = await processMergeAnimation(
            files.value.map(f => f.file),
            opts,
            (i, total) => {
              progressLabel.value = `Adding frame ${i + 1}/${total}`;
              progress.value = (i / total) * 100;
            }
          );
          progress.value = 100;
          triggerDownload(blob, `animation.${ext}`);
        } else {
          const total = files.value.length;
          const stepOpts = targetIsPdf ? { ...opts, targetFormat: MagickFormat.Jpeg } : opts;
          const stepCap = targetIsPdf ? 80 : 100;
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
        }
        message.success('Conversion complete!');
      } catch (e) {
        console.error(e);
        errorMessage.value = friendlyError(e.message);
      } finally {
        processing.value = false;
        progress.value = 0;
        progressLabel.value = '';
      }
    };

    return {
      isReady, processing, progress, progressLabel, errorMessage,
      files, isDragging,
      targetFormat, quality,
      makeAnimation, animationDelay,
      resizeMode, resizePercent, resizeWidth, resizeHeight, lockRatio, rotation,
      resizeModeOptions, quickFormatList, extraFormatOptions, isExtraFormatActive,
      isMultiFrameFormat: isMultiFrame,
      canMergeAnimation,
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
