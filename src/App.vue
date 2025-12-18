<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import {
  initializeImageMagick,
  ImageMagick,
  MagickFormat,
  MagickGeometry,
  MagickImage,
  MagickImageCollection,
  MagickColor
} from '@imagemagick/magick-wasm';
import JSZip from 'jszip';

// --- Constants ---
const GRAVITY_CENTER = 5;

// --- State ---
const isReady = ref(false);
const processing = ref(false);
const progress = ref(0);
const progressLabel = ref('');
const files = ref([]);
const targetFormat = ref(MagickFormat.Png);
const zipOutput = ref(false);
const errorMessage = ref('');
const isDragging = ref(false);

// --- Animation State ---
const makeAnimation = ref(false);
const animationDelay = ref(200); // ms

// --- Editor State ---
const resizeMode = ref('none');
const resizePercent = ref(50);
const resizeWidth = ref(null);
const resizeHeight = ref(null);
const lockRatio = ref(true);
const rotation = ref(0);

// --- Quality Control ---
const quality = ref(90);

// --- Formats Configuration ---
const showMoreDropdown = ref(false);

const quickFormats = {
  'PNG': MagickFormat.Png,
  'JPG': MagickFormat.Jpeg,
  'GIF': MagickFormat.Gif,
  'ICO': MagickFormat.Ico,
  'WEBP': MagickFormat.WebP,
  'PDF': MagickFormat.Pdf
};

const extraFormats = {
  'BMP': MagickFormat.Bmp,
  'TIFF': MagickFormat.Tiff,
  'TGA': MagickFormat.Tga,
  'AVIF': MagickFormat.Avif,
  'DDS': MagickFormat.Dds
};

const isMoreSelected = computed(() => Object.values(extraFormats).includes(targetFormat.value));
const currentMoreLabel = computed(() => Object.keys(extraFormats).find(key => extraFormats[key] === targetFormat.value));

// --- Logic Helpers ---

const isMultiFrameFormat = computed(() => {
  return [
    MagickFormat.Gif,
    MagickFormat.WebP,
    MagickFormat.Pdf,
    MagickFormat.Tiff
  ].includes(targetFormat.value);
});

const canMergeAnimation = computed(() => {
  if (files.value.length < 2) return false;
  return [MagickFormat.Gif, MagickFormat.WebP].includes(targetFormat.value);
});

watch(targetFormat, () => {
  if (!canMergeAnimation.value) makeAnimation.value = false;
});

watch(() => files.value.length, (newCount) => {
  if (newCount > 1 && !makeAnimation.value) zipOutput.value = true;
  if (newCount < 2) makeAnimation.value = false;
});

watch([resizeWidth, resizeHeight], ([newW, newH]) => {
  if (newW && newH && resizeMode.value === 'pixels') {
    lockRatio.value = false;
  }
});

const selectFormat = (format) => {
  targetFormat.value = format;
  showMoreDropdown.value = false;
};

// --- Initialization ---
onMounted(async () => {
  try {
    const wasmLocation = 'https://unpkg.com/@imagemagick/magick-wasm/dist/magick.wasm';
    const data = await fetch(wasmLocation);
    const wasmBytes = await data.arrayBuffer();
    await initializeImageMagick(wasmBytes);
    isReady.value = true;
  } catch (e) {
    errorMessage.value = "Failed to load Magick: " + e.message;
  }
});

const closeDropdown = () => { showMoreDropdown.value = false; };

// --- File Handling ---
const addFiles = (fileList) => {
  const allFiles = Array.from(fileList);

  const validFiles = [];
  const rejectedNames = [];

  // Separate valid images/PDFs from unsupported files
  allFiles.forEach(f => {
    if (f.type.startsWith('image/')) {
      validFiles.push(f);
    } else {
      rejectedNames.push(f.name);
    }
  });

  // 1. Report Rejected Files specifically
  if (rejectedNames.length > 0) {
    // Show up to 5 names, then "...and X more" to avoid huge messages
    const displayNames = rejectedNames.slice(0, 5).join(', ');
    const extraCount = rejectedNames.length - 5;
    const suffix = extraCount > 0 ? `, and ${extraCount} others.` : '.';

    errorMessage.value = `Skipped unsupported files: ${displayNames}${suffix}`;
  } else {
    errorMessage.value = '';
  }

  const filesWithPreviews = validFiles.map(f => ({
    file: f,
    id: Math.random().toString(36).substr(2, 9),
    preview: URL.createObjectURL(f),
    renderError: false
  }));
  files.value = [...files.value, ...filesWithPreviews];
};

const removeFile = (id) => {
  files.value = files.value.filter(f => f.id !== id);
};

// 2. Handle Corrupt/Unsupported Preview Rendering
const handlePreviewError = (fileItem) => {
  fileItem.renderError = true;
};

const onDrop = (e) => {
  e.preventDefault();
  isDragging.value = false;
  if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
};

const rotateLeft = () => rotation.value = (rotation.value - 90) % 360;
const rotateRight = () => rotation.value = (rotation.value + 90) % 360;

// --- Conversion Logic ---
const convertAndDownload = async () => {
  if (files.value.length === 0) return;
  processing.value = true;
  progress.value = 0;
  errorMessage.value = '';

  try {
    let ext = 'dat';
    const quickKey = Object.keys(quickFormats).find(key => quickFormats[key] === targetFormat.value);
    if (quickKey) ext = quickKey.toLowerCase();
    const extraKey = Object.keys(extraFormats).find(key => extraFormats[key] === targetFormat.value);
    if (extraKey) ext = extraKey.toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';

    if (makeAnimation.value && canMergeAnimation.value) {
      progressLabel.value = "Merging Animation...";
      const blob = await processMergeAnimation();
      progress.value = 100;
      triggerDownload(blob, `animation.${ext}`);
    }
    else {
      const zip = new JSZip();
      const processedFiles = [];
      const totalFiles = files.value.length;

      for (let i = 0; i < totalFiles; i++) {
        const item = files.value[i];
        progressLabel.value = `Processing ${item.file.name}...`;

        const convertedBlob = await processSingleImage(item.file);

        const newName = item.file.name.replace(/\.[^/.]+$/, "") + '.' + ext;
        processedFiles.push({ name: newName, blob: convertedBlob });
        progress.value = ((i + 1) / totalFiles) * 90;
      }

      if (zipOutput.value || totalFiles > 1) {
        progressLabel.value = "Compressing...";
        processedFiles.forEach(f => zip.file(f.name, f.blob));
        const content = await zip.generateAsync({ type: "blob" }, (metadata) => {
          progress.value = 90 + (metadata.percent * 0.1);
        });
        triggerDownload(content, "converted_images.zip");
      } else {
        progressLabel.value = "Finalizing...";
        progress.value = 100;
        triggerDownload(processedFiles[0].blob, processedFiles[0].name);
      }
    }
  } catch (e) {
    console.error(e);
    if (e.message.includes("FailedToExecuteCommand") || e.message.includes("ffmpeg")) {
      errorMessage.value = "This format requires external libraries (ffmpeg) not available. Please use GIF or WebP.";
    } else if (e.message.includes("ImagesAreNotTheSameSize")) {
      errorMessage.value = "GIF Error: Frames mismatch. Please ensure 'Resize' width/height are set if locking ratio.";
    } else {
      errorMessage.value = "Conversion failed. " + e.message;
    }
  } finally {
    setTimeout(() => {
      processing.value = false;
      progress.value = 0;
      progressLabel.value = '';
    }, 500);
  }
};

// --- SINGLE FILE PROCESSOR ---
const processSingleImage = async (file) => {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  return new Promise((resolve, reject) => {
    const collection = MagickImageCollection.create();

    try {
      collection.read(bytes);
      collection.coalesce();

      for (let i = 0; i < collection.length; i++) {
        const image = collection[i];
        applyEdits(image);
        image.format = targetFormat.value;
        image.quality = quality.value;
      }

      if (isMultiFrameFormat.value) {
        if (targetFormat.value === MagickFormat.Gif) collection.optimize();
        collection.write(targetFormat.value, (data) => {
          resolve(new Blob([data], { type: `image/${targetFormat.value}` }));
        });
      }
      else {
        const firstFrame = collection[0];
        firstFrame.write(targetFormat.value, (data) => {
          resolve(new Blob([data], { type: `image/${targetFormat.value}` }));
        });
      }

    } catch (err) {
      reject(err);
    } finally {
      collection.dispose();
    }
  });
};

// --- MERGE ANIMATION PROCESSOR ---
const processMergeAnimation = async () => {
  const collection = MagickImageCollection.create();

  try {
    for (let i = 0; i < files.value.length; i++) {
      const file = files.value[i].file;
      progressLabel.value = `Adding frame ${i + 1}/${files.value.length}`;
      progress.value = (i / files.value.length) * 80;

      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const image = MagickImage.create();
      image.read(bytes);

      applyEdits(image);

      if (targetFormat.value === MagickFormat.Gif && resizeMode.value === 'pixels' && resizeWidth.value && resizeHeight.value && lockRatio.value) {
        const w = parseInt(resizeWidth.value);
        const h = parseInt(resizeHeight.value);
        image.backgroundColor = new MagickColor(0, 0, 0, 0);
        image.extent(w, h, GRAVITY_CENTER);
      }

      image.animationDelay = Math.round(animationDelay.value / 10);

      if (targetFormat.value === MagickFormat.Gif) {
        image.gifDisposeMethod = 2;
      }

      collection.push(image);
    }

    progressLabel.value = "Rendering Animation...";

    if (targetFormat.value === MagickFormat.Gif) {
      collection.optimize();
    }

    return new Promise((resolve) => {
      collection.write(targetFormat.value, (data) => {
        resolve(new Blob([data], { type: `image/${targetFormat.value}` }));
      });
    });

  } finally {
    collection.dispose();
  }
};

const applyEdits = (image) => {
  if (rotation.value !== 0) image.rotate(rotation.value);

  if (resizeMode.value === 'percent') {
    const p = resizePercent.value / 100;
    image.resize(image.width * p, image.height * p);
  }
  else if (resizeMode.value === 'pixels') {
    const w = resizeWidth.value ? parseInt(resizeWidth.value) : image.width;
    const h = resizeHeight.value ? parseInt(resizeHeight.value) : image.height;

    if (lockRatio.value) {
      image.resize(w, h);
    } else {
      const geom = new MagickGeometry(w, h);
      geom.ignoreAspectRatio = true;
      image.resize(geom);
    }
  }
};

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
</script>

<template>
  <div class="min-h-screen bg-gray-50 flex items-center justify-center p-4 md:p-10 font-sans text-slate-800 pb-24"
    @click="closeDropdown">
    <div
      class="w-full max-w-5xl bg-white shadow-2xl rounded-3xl overflow-hidden flex flex-col min-h-[600px] relative z-10">

      <div class="px-8 py-5 border-b border-gray-100 flex items-center justify-between bg-white">
        <div class="flex items-center gap-3">
          <div
            class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-md shadow-indigo-200">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24"
              stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
          </div>
          <div>
            <h1 class="text-xl font-bold text-gray-800 tracking-tight">Aukmind Image Converter</h1>
            <p class="text-xs text-gray-500 font-medium">Local & Secure Image Processing</p>
          </div>
        </div>
        <div class="hidden md:block">
          <span v-if="isReady"
            class="px-3 py-1 bg-green-50 text-green-600 text-xs font-bold rounded-full border border-green-100 flex items-center gap-1">
            <span class="w-2 h-2 bg-green-500 rounded-full"></span> Engine Ready
          </span>
        </div>
      </div>

      <div class="flex flex-col md:flex-row flex-grow">

        <div class="md:w-1/2 p-8 bg-gray-100/50 border-r border-gray-200 flex flex-col">
          <h2 class="text-lg font-bold text-slate-700 mb-4 flex items-center gap-2">
            <span class="w-7 h-7 bg-blue-600 text-white rounded-lg flex items-center justify-center text-sm">1</span>
            Input images
          </h2>

          <div @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false" @drop="onDrop" :class="[
            'flex-1 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center transition-all p-6 text-center cursor-pointer relative',
            isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-white'
          ]">
            <input type="file" multiple @change="(e) => addFiles(e.target.files)"
              class="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />

            <div v-if="files.length === 0" class="pointer-events-none">
              <div
                class="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24"
                  stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <p class="text-gray-600 font-medium">Drop files here or click to upload</p>
            </div>

            <div v-else
              class="w-full h-full overflow-y-auto grid grid-cols-3 gap-2 content-start pr-2 pointer-events-none relative z-10">
              <div v-for="file in files" :key="file.id"
                class="aspect-square relative group bg-white rounded-xl shadow-sm overflow-hidden border border-gray-200">

                <img v-if="!file.renderError" :src="file.preview" @error="handlePreviewError(file)"
                  class="w-full h-full object-cover" />

                <div v-else class="w-full h-full flex flex-col items-center justify-center bg-gray-50 p-2 text-center">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-gray-400 mb-1" fill="none"
                    viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <span class="text-[10px] text-gray-500 font-medium truncate w-full">{{ file.file.name }}</span>
                </div>

                <button @click.stop.prevent="removeFile(file.id)"
                  class="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1 opacity-40 group-hover:opacity-100 transition-opacity pointer-events-auto hover:bg-red-500">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div
                class="aspect-square flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-xl text-gray-400">
                <span class="text-2xl">+</span>
              </div>
            </div>
          </div>
        </div>

        <div class="md:w-1/2 p-8 flex flex-col bg-white overflow-y-auto">
          <h2 class="text-lg font-bold text-slate-700 mb-6 flex items-center gap-2">
            <span class="w-7 h-7 bg-indigo-600 text-white rounded-lg flex items-center justify-center text-sm">2</span>
            Options
          </h2>

          <div class="flex-1 space-y-6">

            <div>
              <label class="block text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Format &
                Compression</label>
              <div class="space-y-4">
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  <button v-for="(val, key) in quickFormats" :key="key" @click="targetFormat = val" :class="['cursor-pointer border rounded-lg p-2 flex items-center justify-center transition-all text-sm font-medium',
                    targetFormat === val
                      ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-600 font-bold'
                      : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:bg-gray-50']">
                    {{ key }}
                  </button>

                  <div class="relative col-span-2 lg:col-span-2">
                    <button @click.stop="showMoreDropdown = !showMoreDropdown" :class="['w-full h-full cursor-pointer border rounded-lg p-2 flex items-center justify-between px-4 transition-all text-sm font-medium',
                      isMoreSelected || showMoreDropdown
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-600 font-bold'
                        : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:bg-gray-50'
                    ]">
                      <span>{{ isMoreSelected ? 'Selected: ' + currentMoreLabel : 'More Formats...' }}</span>
                      <svg class="w-4 h-4 transform transition-transform" :class="showMoreDropdown ? 'rotate-180' : ''"
                        fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>

                    <div v-if="showMoreDropdown"
                      class="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden grid grid-cols-2 gap-1 p-2">
                      <button v-for="(val, key) in extraFormats" :key="key" @click="selectFormat(val)"
                        :class="['text-left px-3 py-2 rounded-lg text-sm transition-colors flex justify-between items-center',
                          targetFormat === val ? 'bg-indigo-100 text-indigo-700 font-bold' : 'hover:bg-gray-100 text-gray-600']">
                        {{ key }}
                        <svg v-if="targetFormat === val" class="w-4 h-4" fill="none" viewBox="0 0 24 24"
                          stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                <div class="pt-4 border-t border-gray-100">
                  <div class="flex items-center gap-3 px-1">
                    <span class="text-xs text-gray-500 font-medium w-16">Quality</span>
                    <input type="range" v-model="quality" min="1" max="100"
                      class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
                    <span class="w-12 text-right font-mono font-bold text-indigo-600 text-sm">{{ quality }}%</span>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="canMergeAnimation" class="bg-indigo-50 border border-indigo-100 rounded-xl p-4 transition-all">
              <label class="flex items-center gap-3 cursor-pointer">
                <div class="relative inline-flex items-center">
                  <input type="checkbox" v-model="makeAnimation" class="sr-only peer">
                  <div
                    class="w-11 h-6 bg-gray-300 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600">
                  </div>
                </div>
                <span class="text-sm font-bold text-indigo-900">Merge into Animation <span
                    class="text-xs font-normal text-indigo-500">(GIF / WebP Only)</span></span>
              </label>

              <div v-if="makeAnimation" class="mt-3 pl-2 border-l-2 border-indigo-200 ml-2">
                <label class="block text-xs font-semibold text-indigo-600 mb-1">Frame Delay (ms)</label>
                <input type="number" v-model="animationDelay"
                  class="w-full border border-indigo-200 rounded-lg py-1 px-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="e.g. 200" />
                <p class="text-[10px] text-indigo-400 mt-1">Time between frames in milliseconds</p>
              </div>
            </div>

            <div v-if="files.length > 1 && !isMultiFrameFormat" class="text-xs text-gray-400 text-center italic">
              Animation is only available for GIF and WebP formats.
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Edit Image</label>
              <div class="bg-gray-50 p-4 rounded-xl border border-gray-200 space-y-4">
                <div class="flex gap-2">
                  <button @click="rotateLeft"
                    class="flex-1 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:text-indigo-600 hover:border-indigo-300 transition-colors flex items-center justify-center gap-2">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                    Rotate Left
                  </button>
                  <button @click="rotateRight"
                    class="flex-1 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:text-indigo-600 hover:border-indigo-300 transition-colors flex items-center justify-center gap-2">
                    Rotate Right
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
                    </svg>
                  </button>
                </div>
                <div v-if="rotation !== 0" class="text-center text-xs text-indigo-600 font-medium">
                  Current Rotation: {{ rotation }}°
                </div>

                <div class="pt-2 border-t border-gray-200">
                  <label class="text-xs text-gray-400 mb-2 block uppercase font-bold">Resize</label>
                  <div class="flex bg-white rounded-lg border border-gray-200 p-1 mb-3">
                    <button v-for="mode in ['none', 'percent', 'pixels']" :key="mode" @click="resizeMode = mode"
                      :class="['flex-1 py-1 text-xs font-bold rounded capitalize transition-colors', resizeMode === mode ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:text-gray-700']">{{
                        mode }}</button>
                  </div>

                  <div v-if="resizeMode === 'percent'" class="flex items-center gap-3">
                    <input type="range" v-model="resizePercent" min="1" max="200"
                      class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
                    <span class="w-12 text-right font-mono font-bold text-indigo-600 text-sm">{{ resizePercent
                    }}%</span>
                  </div>

                  <div v-if="resizeMode === 'pixels'" class="space-y-3">
                    <div class="flex items-end gap-2">
                      <div class="flex-1">
                        <label class="text-xs text-gray-500 mb-1 block">W</label>
                        <input type="number" v-model="resizeWidth" placeholder="Auto"
                          class="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
                      </div>
                      <div class="flex-1">
                        <label class="text-xs text-gray-500 mb-1 block">H</label>
                        <input type="number" v-model="resizeHeight" placeholder="Auto"
                          class="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
                      </div>
                    </div>
                    <button @click="lockRatio = !lockRatio"
                      :class="['flex items-center gap-2 text-xs w-full p-2 rounded-lg border transition-colors justify-center', lockRatio ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-gray-200 text-gray-500']">
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      {{ lockRatio ? 'Ratio Locked' : 'Ratio Unlocked' }}
                    </button>
                  </div>
                </div>

              </div>
            </div>

            <div v-if="!makeAnimation">
              <label
                class="flex items-center gap-3 p-3 border border-gray-200 rounded-xl cursor-pointer hover:bg-gray-50 transition-colors">
                <input type="checkbox" v-model="zipOutput"
                  class="h-4 w-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500" />
                <div class="flex-1">
                  <span class="font-medium text-sm text-gray-800">Bundle as ZIP</span>
                </div>
              </label>
            </div>

            <div v-if="errorMessage" class="p-3 bg-red-50 text-red-600 rounded-lg text-sm border border-red-100">{{
              errorMessage }}</div>
          </div>

          <button @click="convertAndDownload" :disabled="!isReady || files.length === 0 || processing"
            class="w-full mt-6 py-4 px-6 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-xl font-bold shadow-lg shadow-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-[0.98] flex items-center justify-center gap-2">
            <span v-if="!isReady">Loading Engine...</span>
            <span v-else-if="processing">Running...</span>
            <span v-else>{{ makeAnimation ? 'Create Animation' : 'Convert Images' }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="processing"
      class="fixed bottom-0 left-0 w-full bg-white border-t border-gray-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-50 p-4 pb-6 transition-transform duration-300 transform translate-y-0">
      <div class="max-w-5xl mx-auto">
        <div class="flex justify-between text-sm font-bold text-gray-700 mb-2">
          <span>{{ progressLabel }}</span>
          <span>{{ Math.round(progress) }}%</span>
        </div>
        <div class="w-full bg-gray-200 rounded-full h-4 overflow-hidden shadow-inner">
          <div
            class="bg-gradient-to-r from-blue-500 to-indigo-600 h-full rounded-full transition-all duration-300 ease-out flex items-center justify-end pr-2"
            :style="{ width: `${progress}%` }">
            <div class="w-2 h-2 bg-white/50 rounded-full animate-pulse"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
