import { createStore } from './store.js';
import { TOOL_GROUPS, toolById } from './tools.js';
import { Icon, ICONS, useObjectUrls, useWindowListener, useBackClose, aspectOf } from './components/shared.js';
import { useFileDrop } from '/shared/dom.js';
import { formatSize, formatLabel } from './img/encode.js';
import { isIOS, plural } from './util.js';
import { ConvertTool } from './components/convert.js';
import { ResizeTool } from './components/resize.js';
import { RotateTool } from './components/rotate.js';
import { CropTool } from './components/crop.js';
import { AdjustTool } from './components/adjust.js';
import { AnnotateTool } from './components/annotate.js';
import { BlurTool } from './components/blur.js';
import { MetadataTool } from './components/metadata.js';
import { WatermarkTool } from './components/watermark.js';
import { useNaiveTheme, useNaiveOverrides } from '/shared/theme.js';

const { createApp, defineComponent, provide, inject, computed, ref, watch, nextTick, onMounted, h } = Vue;
const naive = window.naive;

const TOOL_VIEWS = {
    convert: () => h(ConvertTool, { mode: 'convert' }),
    compress: () => h(ConvertTool, { mode: 'compress' }),
    resize: () => h(ResizeTool),
    crop: () => h(CropTool),
    rotate: () => h(RotateTool),
    adjust: () => h(AdjustTool),
    annotate: () => h(AnnotateTool),
    blur: () => h(BlurTool),
    metadata: () => h(MetadataTool),
    watermark: () => h(WatermarkTool),
};

const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

// The workspace: what's open, undo, save (split button), close.
const WorkspaceBar = defineComponent({
    components: { Icon },
    setup() {
        const store = inject('store');
        const s = store.state;
        const menuOpen = ref(false);
        const targets = computed(() => (s.selected.length ? s.selected.length : s.images.length));
        const saveAs = computed(() => formatLabel(s.save.format) || 'original format');
        // iOS saves downloads to Files, so Share (→ Save to Photos) leads there; Android/desktop download first.
        const shareFirst = computed(() => isIOS && s.caps.share);
        const options = computed(() => [
            shareFirst.value
                ? { key: 'files', label: 'Download', icon: ICONS.download }
                : s.caps.share && { key: 'share', label: 'Share…', icon: ICONS.share },
            { key: 'zip', label: 'Download ZIP', icon: ICONS.zip },
            { key: 'pdf', label: 'Make a PDF', icon: ICONS.file },
            { key: 'pdfeditor', label: 'Open in PDF Editor', icon: ICONS.page },
        ].filter(Boolean));
        const choose = (key) => {
            menuOpen.value = false;
            store.save(key);
        };
        const primary = () => store.save(shareFirst.value ? 'share' : 'files');
        return { store, s, menuOpen, targets, saveAs, shareFirst, options, choose, primary, formatSize, plural, ICONS };
    },
    template: `
        <div v-if="s.images.length" class="docbar">
            <icon :d="ICONS.image" :size="16" class="docbar__icon"/>
            <span class="docbar__meta">{{ plural(s.images.length, 'image') }}<span class="docbar__size"> · {{ formatSize(store.totalSize) }}</span></span>
            <div class="docbar__actions">
                <n-button size="small" quaternary :disabled="!s.undoCount || !!s.busy" @click="store.undo()" title="Undo the last change">
                    <template #icon><icon :d="ICONS.undo"/></template><span class="docbar__undo-label">Undo change</span>
                </n-button>
                <n-button-group size="small" class="docbar__download">
                    <n-button type="primary" secondary :disabled="!!s.busy" @click="primary" :title="'Save ' + targets + ' as ' + saveAs">
                        <template #icon><icon :d="shareFirst ? ICONS.share : ICONS.download"/></template><span class="docbar__download-label">{{ shareFirst ? 'Save' : 'Download' }}</span>
                    </n-button>
                    <n-popover trigger="click" placement="bottom-end" :show="menuOpen" @update:show="v => menuOpen = v" raw :show-arrow="false">
                        <template #trigger>
                            <n-button type="primary" secondary title="More ways to save" aria-label="More ways to save" :aria-expanded="menuOpen"><icon :d="ICONS.down" :size="14"/></n-button>
                        </template>
                        <div class="save-menu" role="menu">
                            <button v-for="o in options" :key="o.key" type="button" role="menuitem" class="save-menu__item" @click="choose(o.key)">
                                <icon :d="o.icon" :size="16"/>{{ o.label }}
                            </button>
                        </div>
                    </n-popover>
                </n-button-group>
                <n-button size="small" quaternary :disabled="!!s.busy" @click="store.clear()" title="Close all images">
                    <template #icon><icon :d="ICONS.close"/></template>
                </n-button>
            </div>
        </div>`,
});

// Vertical rail on desktop, a strip at the bottom of the screen on phones. Every tool keeps a visible label.
const ToolRail = defineComponent({
    components: { Icon },
    setup() {
        const store = inject('store');
        const rail = ref(null);
        const reveal = () => nextTick(() => {
            const active = rail.value?.querySelector('.rail__item--active');
            if (!active) return;
            const r = rail.value;
            r.scrollLeft += active.offsetLeft - r.offsetLeft - (r.clientWidth - active.offsetWidth) / 2;
        });
        watch(() => store.state.tool, reveal);
        onMounted(reveal);
        return { store, groups: TOOL_GROUPS, rail };
    },
    template: `
        <nav class="rail" ref="rail" aria-label="Tools">
            <section v-for="g in groups" :key="g.name" class="rail__group" :aria-label="g.name">
                <h3 class="rail__title">{{ g.name }}</h3>
                <button v-for="t in g.tools" :key="t.id" type="button" :title="t.hint"
                    :class="['rail__item', { 'rail__item--active': store.state.tool === t.id }]"
                    :aria-current="store.state.tool === t.id ? 'page' : null"
                    @click="store.setTool(t.id)">
                    <icon :d="t.icon" :size="20"/><span>{{ t.label }}</span>
                </button>
            </section>
        </nav>`,
});

const Viewer = defineComponent({
    components: { Icon },
    setup() {
        const store = inject('store');
        const v = store.state.viewer;
        const image = useObjectUrls();
        const current = computed(() => store.state.images.find(i => i.id === v.ids[v.index]) || null);
        watch(() => [v.show, current.value, current.value?.ops, current.value?.status], () => {
            const item = current.value;
            if (!v.show || !item || item.status !== 'ready') return image.clear();
            // The longest side the photo can show at in this viewport, in device pixels.
            const a = aspectOf(item), dpr = window.devicePixelRatio || 1;
            const side = Math.min(4096, Math.ceil(Math.min(window.innerWidth * Math.max(1, 1 / a), window.innerHeight * Math.max(1, a)) * dpr));
            image.load(() => store.previewUrl(item, item.ops, side), { keep: true }).catch(err => console.error(err));
        });
        const step = (d) => {
            const next = v.index + d;
            if (next >= 0 && next < v.ids.length) v.index = next;
        };
        // Captured first: while the viewer is open its keys are its own, so tools under it never see them.
        useWindowListener('keydown', (e) => {
            if (!v.show) return;
            if (e.key === 'ArrowLeft') step(-1);
            else if (e.key === 'ArrowRight') step(1);
            else return;
            e.stopPropagation();
        }, true);
        useBackClose(computed(() => v.show), () => { v.show = false; });
        const position = computed(() => store.state.images.indexOf(current.value) + 1);
        return { v, url: image.value, step, current, position, ICONS };
    },
    template: `
        <n-modal v-model:show="v.show" :auto-focus="false">
            <div class="viewer" @click.self="v.show = false">
                <div class="viewer__bar">
                    <span class="viewer__title">{{ position }} · {{ current?.name }}</span>
                    <div class="viewer__actions">
                        <button class="viewer__close" type="button" @click="v.show = false" title="Close"><icon :d="ICONS.close" :size="20"/></button>
                    </div>
                </div>
                <div class="viewer__stage" @click.self="v.show = false">
                    <button class="viewer__nav viewer__nav--prev" type="button" :disabled="v.index <= 0" @click="step(-1)" title="Previous (←)"><icon :d="ICONS.left" :size="26"/></button>
                    <img v-if="url" :src="url" class="viewer__img viewer__img--photo" alt=""/>
                    <n-spin v-else/>
                    <button class="viewer__nav viewer__nav--next" type="button" :disabled="v.index >= v.ids.length - 1" @click="step(1)" title="Next (→)"><icon :d="ICONS.right" :size="26"/></button>
                </div>
                <p class="viewer__keys">← → to browse · Esc to close</p>
            </div>
        </n-modal>`,
});

const Landing = defineComponent({
    components: { Icon },
    props: { tool: { type: Object, default: null } },
    setup() {
        const store = inject('store');
        return { store, groups: TOOL_GROUPS, touch, ICONS };
    },
    template: `
        <div class="landing">
            <section class="landing__hero">
                <h2 v-if="tool">{{ tool.label }}</h2>
                <h2 v-else>Every image tool, private by design</h2>
                <p>{{ tool ? tool.hint : 'Convert HEIC to JPG, compress, resize, crop, blur and more — right in your browser.' }}</p>
                <div class="landing__ctas">
                    <n-button type="primary" size="large" class="landing__cta" @click="store.pick()">
                        <template #icon><icon :d="ICONS.upload" :size="20"/></template>
                        Choose photos
                    </n-button>
                    <n-button v-if="touch" size="large" class="landing__cta landing__cta--secondary" @click="store.pickCamera()">
                        <template #icon><icon :d="ICONS.camera" :size="20"/></template>
                        Take a photo
                    </n-button>
                </div>
                <span class="landing__or">or drop images and PDFs anywhere on this page · HEIC, JPG, PNG, WEBP, AVIF, GIF</span>
                <span class="landing__privacy"><icon :d="ICONS.lock" :size="14"/> Photos never leave your device — nothing is uploaded.</span>
            </section>
            <section v-for="g in groups" :key="g.name" class="landing__group">
                <h3>{{ g.name }}</h3>
                <div class="landing__grid">
                    <button v-for="t in g.tools" :key="t.id" type="button"
                        :class="['tool-card', { 'tool-card--active': tool && tool.id === t.id }]" @click="store.setTool(t.id)">
                        <span class="tool-card__icon"><icon :d="t.icon" :size="22"/></span>
                        <span class="tool-card__text"><strong>{{ t.label }}</strong><small>{{ t.hint }}</small></span>
                    </button>
                </div>
            </section>
        </div>`,
});

const AppShell = defineComponent({
    components: { Icon, WorkspaceBar, ToolRail, Viewer, Landing },
    setup() {
        const store = createStore(naive.useMessage());
        provide('store', store);
        const s = store.state;

        const tool = computed(() => toolById(s.tool));
        watch(() => tool.value.id, () => { s.viewer.show = false; });
        const ToolView = () => TOOL_VIEWS[tool.value.id]();
        const fileDrag = useFileDrop(files => store.addFiles(files), { paste: true });

        const landing = computed(() => !s.images.length);
        return { store, s, tool, ToolView, fileDrag, landing, touch, ICONS };
    },
    template: `
        <div :class="['app', { 'app--landing': landing, 'app--camera': touch }]">
            <header class="topbar">
                <div class="topbar__brand">
                    <span class="topbar__logo"><icon :d="ICONS.image" :size="18"/></span>
                    <h1>Image Toolbox</h1>
                    <p>Every image tool, right in your browser</p>
                </div>
                <span class="privacy-badge">
                    <icon :d="ICONS.lock" :size="14"/>
                    <span>100% local<span class="privacy-badge__long"> · photos never leave your device</span></span>
                </span>
                <div v-if="s.busy" class="topbar__progress">
                    <div class="topbar__progress-bar" :style="s.busy.progress != null ? { width: (s.busy.progress * 100) + '%' } : null"
                         :class="{ 'topbar__progress-bar--indeterminate': s.busy.progress == null }"></div>
                </div>
            </header>

            <div :class="['layout', { 'layout--empty': landing }]">
                <main class="workspace">
                    <landing v-if="landing" :tool="s.toolChosen ? tool : null"/>
                    <template v-else>
                        <header class="workhead">
                            <div class="toolhead">
                                <span class="toolhead__icon"><icon :d="tool.icon" :size="18"/></span>
                                <h2>{{ tool.label }}</h2>
                                <p :title="tool.hint">{{ tool.hint }}</p>
                            </div>
                            <workspace-bar/>
                        </header>
                        <component :is="ToolView" :key="tool.id"/>
                    </template>
                </main>
                <tool-rail v-if="!landing"/>
            </div>

            <viewer/>

            <div v-if="!landing" class="fabs">
                <button v-if="touch" type="button" class="fab fab--small" title="Take a photo" @click="store.pickCamera()">
                    <icon :d="ICONS.camera" :size="22"/>
                </button>
                <button type="button" class="fab" title="Add images — or drop them anywhere" @click="store.pick()">
                    <icon :d="ICONS.plus" :size="26"/>
                </button>
            </div>

            <div v-if="s.notice && !s.busy" class="busy-toast" role="status">
                {{ s.notice.text }}
                <button v-if="s.notice.action" type="button" class="busy-toast__action" @click="s.notice.action()">{{ s.notice.actionLabel }}</button>
            </div>

            <div v-if="s.busy" class="busy-toast" role="status">
                <n-spin size="small"/> {{ s.busy.label }}…
                <span v-if="s.busy.progress != null">{{ Math.round(s.busy.progress * 100) }}%</span>
            </div>

            <div v-if="fileDrag" class="drop-overlay">
                <div class="drop-overlay__box">
                    <icon :d="ICONS.upload" :size="44"/>
                    <strong>Drop images or PDFs to add them</strong>
                </div>
            </div>
        </div>`,
});

const app = createApp({
    components: { AppShell },
    setup() {
        const naiveTheme = useNaiveTheme();
        return { naiveTheme, naiveOverrides: useNaiveOverrides(naiveTheme) };
    },
    template: `
        <n-config-provider :theme="naiveTheme" :theme-overrides="naiveOverrides">
            <n-message-provider placement="top">
                <app-shell/>
            </n-message-provider>
        </n-config-provider>`,
});

app.use(naive);
app.mount('#app');
