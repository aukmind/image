<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import {
  initializeImageMagick,
  ImageMagick,
  MagickFormat,
  MagickGeometry
} from '@imagemagick/magick-wasm';
import JSZip from 'jszip';

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

// --- Editor State ---
const resizeMode = ref('none');
const resizePercent = ref(50);
const resizeWidth = ref(null);
const resizeHeight = ref(null);
const lockRatio = ref(true);
const quality = ref(90);
const rotation = ref(0);

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
  // 'HEIC': MagickFormat.Heic, // Fails in Firefox
  'AVIF': MagickFormat.Avif,
  'DDS': MagickFormat.Dds
};

const isMoreSelected = computed(() => {
  return Object.values(extraFormats).includes(targetFormat.value);
});

const currentMoreLabel = computed(() => {
  return Object.keys(extraFormats).find(key => extraFormats[key] === targetFormat.value);
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

watch(() => files.value.length, (newCount) => {
  if (newCount > 1) zipOutput.value = true;
});

// Click outside directive logic (simplified for setup)
const closeDropdown = () => { showMoreDropdown.value = false; };

// --- File Handling ---
const addFiles = (fileList) => {
  const newFiles = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  const filesWithPreviews = newFiles.map(f => ({
    file: f,
    id: Math.random().toString(36).substr(2, 9),
    preview: URL.createObjectURL(f)
  }));
  files.value = [...files.value, ...filesWithPreviews];
  errorMessage.value = '';
};

const removeFile = (id) => {
  files.value = files.value.filter(f => f.id !== id);
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
    const zip = new JSZip();
    const processedFiles = [];
    const totalFiles = files.value.length;

    // Get extension string
    let ext = 'dat';
    // Check quick formats
    const quickKey = Object.keys(quickFormats).find(key => quickFormats[key] === targetFormat.value);
    if (quickKey) ext = quickKey.toLowerCase();
    // Check extra formats
    const extraKey = Object.keys(extraFormats).find(key => extraFormats[key] === targetFormat.value);
    if (extraKey) ext = extraKey.toLowerCase();

    // Fix: Jpeg extension usually jpg
    if (ext === 'jpeg') ext = 'jpg';

    for (let i = 0; i < totalFiles; i++) {
      const item = files.value[i];
      progressLabel.value = `Converting ${item.file.name}...`;

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

  } catch (e) {
    console.error(e);
    errorMessage.value = "Conversion failed. " + e.message;
  } finally {
    setTimeout(() => {
      processing.value = false;
      progress.value = 0;
      progressLabel.value = '';
    }, 500);
  }
};

const processSingleImage = async (file) => {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  return new Promise((resolve, reject) => {
    try {
      ImageMagick.read(bytes, (image) => {
        // Rotation
        if (rotation.value !== 0) {
          image.rotate(rotation.value);
        }

        // Resizing
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

        // Format & Quality
        image.format = targetFormat.value;
        image.quality = quality.value;

        image.write((data) => {
          resolve(new Blob([data], { type: `image/${targetFormat.value}` })); // Mimetype approx
        });
      });
    } catch (err) {
      reject(err);
    }
  });
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
      class="w-full max-w-5xl bg-white shadow-2xl rounded-3xl overflow-hidden flex flex-col md:flex-row min-h-[600px] relative z-10">

      <div class="md:w-1/2 p-8 bg-gray-100/50 border-r border-gray-200 flex flex-col">
        <h2 class="text-xl font-bold text-slate-700 mb-4 flex items-center gap-2">
          <span class="w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center text-sm">1</span>
          Input Images
        </h2>

        <div @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false" @drop="onDrop" :class="[
          'flex-1 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center transition-all p-6 text-center cursor-pointer relative',
          isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-white'
        ]">
          <input type="file" multiple @change="(e) => addFiles(e.target.files)"
            class="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />

          <div v-if="files.length === 0" class="pointer-events-none">
            <div class="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
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
              <img :src="file.preview" class="w-full h-full object-cover" />
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
        <h2 class="text-xl font-bold text-slate-700 mb-6 flex items-center gap-2">
          <span class="w-8 h-8 bg-indigo-600 text-white rounded-lg flex items-center justify-center text-sm">2</span>
          Output Settings
        </h2>

        <div class="flex-1 space-y-6">

          <div>
            <label class="block text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Format &
              Quality</label>
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
                    <span>
                      {{ isMoreSelected ? 'Selected: ' + currentMoreLabel : 'More Formats...' }}
                    </span>
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

              <div class="flex items-center gap-3 px-1 pt-2 border-t border-gray-100">
                <span class="text-xs text-gray-500 font-medium w-12">Quality</span>
                <input type="range" v-model="quality" min="1" max="100"
                  class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
                <span class="w-8 text-right font-mono font-bold text-indigo-600 text-sm">{{ quality }}</span>
              </div>
            </div>
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
                  <span class="w-12 text-right font-mono font-bold text-indigo-600 text-sm">{{ resizePercent }}%</span>
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

          <div>
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
          <span v-else>Convert Images</span>
        </button>
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
