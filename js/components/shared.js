import { Icon, ICONS } from '/shared/icons.js';
import { usePinchZoom } from '/shared/zoom.js';
import { useWindowListener, useKeydown, useObjectUrls, useSortable } from '/shared/dom.js';
import { splitLast } from '../img/ops.js';
import { outputGeometry } from '../img/render.js';
import { formatSize } from '../img/encode.js';

const { defineComponent, inject, provide, computed, ref, shallowRef, watch, nextTick, onMounted, onBeforeUnmount } = Vue;

export { Icon, ICONS };
export { useWindowListener, useKeydown, pickFiles, useObjectUrls, clamp01, pointIn, boxStyle, resizeRect, startDrag } from '/shared/dom.js';

// Aspect ratio of an image once its ops are applied (1 while its size isn't known yet).
export function sizeOf(item, ops = item.ops) {
    return item.width ? outputGeometry(ops, item.width, item.height) : null;
}

// Aspect ratio of an image once its ops are applied (1 while its size isn't known yet).
export function aspectOf(item, ops = item.ops) {
    const g = sizeOf(item, ops);
    return g ? g.width / g.height : 1;
}

// Android's back button closes an open panel or viewer instead of leaving the app.
export function useBackClose(isOpen, close) {
    let pushed = false;
    const onPop = () => {
        if (!pushed) return;
        pushed = false;
        close();
    };
    watch(isOpen, (open) => {
        if (open && !pushed) {
            history.pushState({ sheet: true }, '');
            pushed = true;
        } else if (!open && pushed) {
            pushed = false;
            history.back();
        }
    });
    useWindowListener('popstate', onPop);
}

const ZoomSlider = defineComponent({
    components: { Icon },
    setup() {
        return { store: inject('store'), ICONS };
    },
    template: `
        <label class="zoom" title="Thumbnail size">
            <icon :d="ICONS.grid"/>
            <n-slider :value="store.state.thumbSize" @update:value="store.setThumbSize" :min="90" :max="360" :step="10" :tooltip="false" class="zoom__slider"/>
            <icon :d="ICONS.image" :size="20"/>
        </label>`,
});

export const SelectionBar = defineComponent({
    components: { ZoomSlider },
    props: {
        items: { type: Array, required: true },
        selected: { type: Array, required: true },
    },
    emits: ['update:selected'],
    setup(props, { emit }) {
        const all = () => emit('update:selected', props.items.map(i => i.id));
        const none = () => emit('update:selected', []);
        const invert = () => {
            const set = new Set(props.selected);
            emit('update:selected', props.items.filter(i => !set.has(i.id)).map(i => i.id));
        };
        return { all, none, invert };
    },
    template: `
        <div class="selbar">
            <div class="selbar__main">
                <n-button-group size="small">
                    <n-button @click="all">All</n-button>
                    <n-button @click="invert" class="selbar__extra">Invert</n-button>
                    <n-button @click="none" :disabled="!selected.length">None</n-button>
                </n-button-group>
                <span class="selbar__count">{{ selected.length ? selected.length + ' of ' + items.length + ' selected' : 'Tap photos to pick some · none picked = all' }}</span>
            </div>
            <zoom-slider/>
        </div>`,
});

// One card per image so a thumbnail arriving only re-renders its own card.
const ImageCard = defineComponent({
    components: { Icon },
    props: {
        item: { type: Object, required: true },
        label: { type: [Number, String], required: true },
        selected: Boolean,
        selectable: Boolean,
        caption: { type: String, default: null },
    },
    emits: ['pick', 'preview'],
    setup(props) {
        const store = inject('store');
        const observer = inject('cardObserver');
        const el = ref(null);
        // Near the screen: only then does a changed photo get a new thumbnail. Off it, the last one stays and a
        // render still waiting in the queue is dropped.
        const visible = ref(false);
        const seen = ref(false);
        onMounted(() => observer.watch(el.value, (near) => {
            visible.value = near;
            if (near) seen.value = true;
            else store.dropThumb(props.item);
        }));
        onBeforeUnmount(() => observer.unwatch(el.value));
        const thumb = computed(() => (seen.value ? store.thumb(props.item) : null));
        watch([visible, () => props.item.ops, () => props.item.status], () => { if (visible.value) store.wantThumb(props.item); });
        const sheetStyle = computed(() => ({ aspectRatio: aspectOf(props.item) }));
        const size = computed(() => {
            const s = sizeOf(props.item);
            return s ? `${s.width}×${s.height}` : '';
        });
        return { el, seen, thumb, sheetStyle, size, formatSize, ICONS };
    },
    template: `
        <div ref="el" :class="['page-card', 'image-card', { 'page-card--selected': selectable && selected, 'page-card--static': !selectable }]"
             @click="$emit('pick', $event)">
            <div class="page-card__sheet image-card__sheet" :style="sheetStyle">
                <img v-if="thumb" :src="thumb" class="page-card__img image-card__img" decoding="async" draggable="false" :alt="item.name"/>
                <div v-if="item.status !== 'ready'" class="page-card__loading image-card__loading"><n-spin size="small"/></div>
                <slot v-if="seen" name="overlay"></slot>
                <span v-if="selectable" class="page-card__check"><icon :d="ICONS.check" :size="14"/></span>
                <div class="page-card__tools" @click.stop>
                    <slot name="actions"></slot>
                    <button class="page-card__tool" type="button" title="Preview" @click="$emit('preview')"><icon :d="ICONS.zoom" :size="16"/></button>
                </div>
            </div>
            <span class="page-card__label image-card__label" :title="item.name">
                <b>{{ label }}</b><span class="image-card__name">{{ item.name }}</span>
            </span>
            <span :class="['image-card__meta', { 'image-card__meta--caption': caption != null }]">{{ caption ?? (size + (size ? ' · ' : '') + formatSize(item.size)) }}</span>
        </div>`,
});

export const ImageGrid = defineComponent({
    components: { ImageCard },
    props: {
        items: { type: Array, required: true },
        selected: { type: Array, default: () => [] },
        selectable: { type: Boolean, default: true },
        sortable: { type: Boolean, default: false },
        captions: { type: Object, default: null },
    },
    emits: ['update:selected', 'pick'],
    setup(props, { emit }) {
        const store = inject('store');
        const grid = ref(null);
        const selectedSet = computed(() => new Set(props.selected));
        const position = computed(() => new Map(store.state.images.map((img, i) => [img.id, i + 1])));
        let anchor = null;

        const callbacks = new Map();
        const io = new IntersectionObserver((entries) => {
            for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
        }, { rootMargin: '400px' });
        provide('cardObserver', {
            watch: (el, cb) => { callbacks.set(el, cb); io.observe(el); },
            unwatch: (el) => { callbacks.delete(el); io.unobserve(el); },
        });
        onBeforeUnmount(() => io.disconnect());

        const onPick = (index, event) => {
            emit('pick', props.items[index], index);
            if (!props.selectable) return;
            const next = new Set(props.selected);
            const id = props.items[index].id;
            const anchorIndex = anchor === null ? -1 : props.items.findIndex(i => i.id === anchor);
            if (event.shiftKey && anchorIndex !== -1) {
                const select = next.has(anchor);
                const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
                for (let i = from; i <= to; i++) select ? next.add(props.items[i].id) : next.delete(props.items[i].id);
            } else {
                next.has(id) ? next.delete(id) : next.add(id);
                anchor = id;
            }
            emit('update:selected', props.items.filter(i => next.has(i.id)).map(i => i.id));
        };

        const preview = (index) => store.openViewer(props.items.map(i => i.id), index);
        if (props.sortable) useSortable(grid, (from, to) => store.reorder(from, to));

        return { store, grid, selectedSet, position, onPick, preview };
    },
    template: `
        <div class="page-grid image-grid" ref="grid" :style="{ '--thumb-size': store.state.thumbSize + 'px' }">
            <image-card v-for="(item, i) in items" :key="item.id" :item="item" :label="position.get(item.id) || i + 1"
                :selected="selectedSet.has(item.id)" :selectable="selectable" :caption="captions ? captions[item.id] : null"
                @pick="onPick(i, $event)" @preview="preview(i)">
                <template #overlay><slot name="overlay" :item="item" :index="i"></slot></template>
                <template #actions><slot name="actions" :item="item" :index="i"></slot></template>
            </image-card>
        </div>`,
});

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const MAX_STAGE_SIDE = 4096;

// One image, as large as fits, with its own zoom (pinch, ctrl/⌘ + wheel or the buttons) re-rendered sharp.
// ops: what to show (defaults to the image's own); the default slot is an overlay in the same box.
export const ImageStage = defineComponent({
    components: { Icon },
    props: {
        item: { type: Object, required: true },
        ops: { type: Array, default: null },
    },
    setup(props) {
        const store = inject('store');
        const wrap = ref(null);
        const scroller = ref(null);
        const boxWidth = ref(0);
        const fitHeight = ref(0);
        const zoom = ref(1);
        const image = useObjectUrls();
        let rendered = { ops: null, side: 0 };

        const ops = computed(() => props.ops || props.item.ops);
        const aspect = computed(() => aspectOf(props.item, ops.value));

        const render = async () => {
            if (!boxWidth.value || props.item.status !== 'ready') return;
            const dpr = window.devicePixelRatio || 1;
            const side = Math.min(MAX_STAGE_SIDE, Math.ceil(Math.max(boxWidth.value, boxWidth.value / aspect.value) * dpr / 256) * 256);
            const current = ops.value;
            if (rendered.ops === current && side <= rendered.side) return;
            const keep = rendered.ops === current || !!image.value.value;
            try {
                if (await image.load(() => store.previewUrl(props.item, current, side), { keep })) rendered = { ops: current, side };
            } catch (err) {
                console.error(err);
                store.message.error(`Couldn't show ${props.item.name}: ${err.message}`);
            }
        };
        let timer = null;
        const renderSoon = (delay = 150) => {
            clearTimeout(timer);
            timer = setTimeout(render, delay);
        };

        const measure = () => {
            if (!wrap.value) return;
            const maxH = Math.max(280, Math.min(window.innerHeight * 0.72, window.innerHeight - 220));
            const fit = Math.min(wrap.value.clientWidth, maxH * aspect.value);
            fitHeight.value = Math.ceil(fit / aspect.value);
            boxWidth.value = Math.floor(fit * zoom.value);
        };

        const setZoom = async (next, point = null) => {
            next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
            if (Math.abs(next - zoom.value) < 0.001) return;
            const sc = scroller.value;
            const rect = sc.getBoundingClientRect();
            const px = point ? point.clientX - rect.left : sc.clientWidth / 2;
            const py = point ? point.clientY - rect.top : sc.clientHeight / 2;
            const fx = (sc.scrollLeft + px) / sc.scrollWidth;
            const fy = (sc.scrollTop + py) / sc.scrollHeight;
            zoom.value = next;
            measure();
            await nextTick();
            sc.scrollLeft = fx * sc.scrollWidth - px;
            sc.scrollTop = fy * sc.scrollHeight - py;
            renderSoon();
        };
        const step = (factor) => setZoom(Math.round(zoom.value * factor * 4) / 4);
        usePinchZoom(scroller, { get: () => zoom.value, set: setZoom });

        let resizeObserver;
        onMounted(() => {
            resizeObserver = new ResizeObserver(() => { measure(); renderSoon(50); });
            resizeObserver.observe(wrap.value);
            measure();
            render();
        });
        onBeforeUnmount(() => {
            resizeObserver?.disconnect();
            clearTimeout(timer);
        });
        watch(() => props.item, () => {
            rendered = { ops: null, side: 0 };
            image.clear();
            zoom.value = 1;
            measure();
            render();
        });
        watch(ops, () => { measure(); renderSoon(0); });
        watch(() => props.item.status, () => { measure(); render(); });

        return { wrap, scroller, boxWidth, fitHeight, zoom, url: image.value, aspect, step, setZoom, ICONS, MIN_ZOOM, MAX_ZOOM };
    },
    template: `
        <div class="stage" ref="wrap">
            <div ref="scroller" :class="['stage__scroll', { 'stage__scroll--zoomed': zoom > 1 }]" :style="zoom > 1 ? { height: fitHeight + 'px' } : null">
                <div class="stage__page image-stage__page" :style="{ width: boxWidth + 'px', aspectRatio: aspect }">
                    <img v-if="url" :src="url" class="stage__img" draggable="false" alt=""/>
                    <div v-else class="stage__spin"><n-spin/></div>
                    <slot :width="boxWidth"></slot>
                </div>
            </div>
            <div class="stage__zoom" role="group" aria-label="Zoom">
                <button type="button" title="Zoom out" :disabled="zoom <= MIN_ZOOM" @click="step(1 / 1.25)"><icon :d="ICONS.minus" :size="14"/></button>
                <button type="button" class="stage__zoom-level" title="Fit" @click="setZoom(1)">{{ Math.round(zoom * 100) }}%</button>
                <button type="button" title="Zoom in (or pinch)" :disabled="zoom >= MAX_ZOOM" @click="step(1.25)"><icon :d="ICONS.plus" :size="14"/></button>
            </div>
        </div>`,
});

// Previous/next through a list of images, labelled with their real position in the workspace.
export const ImageNav = defineComponent({
    components: { Icon },
    props: {
        items: { type: Array, required: true },
        index: { type: Number, required: true },
    },
    emits: ['update:index'],
    setup(props) {
        const store = inject('store');
        const position = computed(() => store.state.images.indexOf(props.items[props.index]) + 1);
        return { position, ICONS, store };
    },
    template: `
        <div class="pagenav">
            <n-button size="small" circle :disabled="index <= 0" @click="$emit('update:index', index - 1)" title="Previous photo (←)"><icon :d="ICONS.left"/></n-button>
            <span class="pagenav__label">Photo {{ position }}<template v-if="items.length < store.state.images.length"> · {{ index + 1 }} of {{ items.length }} picked</template><template v-else> of {{ items.length }}</template></span>
            <n-button size="small" circle :disabled="index >= items.length - 1" @click="$emit('update:index', index + 1)" title="Next photo (→)"><icon :d="ICONS.right"/></n-button>
        </div>`,
});

// For 'each' tools: the picked images (or all), the current one, and keyboard/arrow navigation.
export function useImageStepper() {
    const store = inject('store');
    const items = computed(() => store.targets());
    const index = ref(0);
    watch(() => items.value.length, (n) => { if (index.value >= n) index.value = Math.max(0, n - 1); });
    const current = computed(() => items.value[index.value] || null);
    const go = (i) => { if (i >= 0 && i < items.value.length) index.value = i; };
    useKeydown((e) => {
        if (e.key === 'ArrowLeft') go(index.value - 1);
        else if (e.key === 'ArrowRight') go(index.value + 1);
    });
    return { items, index, current, go };
}

// Editors that own one kind of op on the photo in front of them (Adjust, Blur, Annotate):
// - `parts`: the photo's other ops (`base`) and its own op of that type (`last`);
// - load(last) refills the draft when the photo changes, or on Apply or Undo;
// - `shown`: base + the draft op, a moment after the draft stops changing (`draft` is watched; `paused` holds it);
// - apply(list, summary) replaces the op (or removes it when toOp() is null); applyCurrent also moves to the next photo.
export function useOpEditor(type, { load, toOp, draft, paused = null, delay = 80 }) {
    const store = inject('store');
    const stepper = useImageStepper();
    const { items, index, current, go } = stepper;
    const parts = computed(() => (current.value ? splitLast(current.value.ops, type) : { base: [], last: null }));
    watch([current, () => parts.value.last], () => load(parts.value.last), { immediate: true });

    const shown = shallowRef(null);
    const compose = () => {
        const op = toOp();
        shown.value = op ? [...parts.value.base, op] : parts.value.base;
    };
    let timer = null;
    const refresh = () => {
        clearTimeout(timer);
        if (!paused?.value) timer = setTimeout(compose, delay);
    };
    if (draft) watch(draft, refresh, { deep: true });
    if (paused) watch(paused, refresh);
    watch(parts, compose, { immediate: true });
    onBeforeUnmount(() => clearTimeout(timer));

    const apply = (list, summary) => {
        const op = toOp();
        return store.edit(list, (item, ops) => {
            const { base } = splitLast(ops, type);
            return op ? [...base, op] : base;
        }, summary);
    };
    const applyCurrent = (summary) => {
        const item = current.value;
        if (item && apply([item], typeof summary === 'function' ? summary(item) : summary) && index.value < items.value.length - 1) go(index.value + 1);
    };
    return { ...stepper, parts, shown, apply, applyCurrent };
}
