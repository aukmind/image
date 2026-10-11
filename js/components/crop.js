import { ImageStage, ImageNav, Icon, ICONS, startDrag, resizeRect, boxStyle, useKeydown, useImageStepper, aspectOf, sizeOf } from './shared.js';
import { ASPECTS, fittedBox, lockAspect, drawnBox, moveBox, isFullBox } from '../img/crop.js';
import { plural } from '../util.js';

const { defineComponent, inject, ref, reactive, computed, watch } = Vue;

const MIN = 0.03;
const MARGIN = 0.04;

const Neighbor = defineComponent({
    components: { Icon },
    props: { item: Object, label: String, icon: String },
    emits: ['go'],
    setup(props) {
        const store = inject('store');
        const thumb = computed(() => (props.item ? store.thumb(props.item) : null));
        watch([() => props.item, () => props.item?.ops], () => props.item && store.wantThumb(props.item), { immediate: true });
        const aspect = computed(() => (props.item ? aspectOf(props.item) : 1));
        return { thumb, aspect };
    },
    template: `
        <button v-if="item" type="button" class="crop-neighbor" @click="$emit('go')" :title="label + ': ' + item.name">
            <span class="crop-neighbor__sheet" :style="{ aspectRatio: aspect }">
                <img v-if="thumb" :src="thumb" alt="" draggable="false"/>
            </span>
            <span class="crop-neighbor__label"><icon :d="icon" :size="14"/>{{ label }}</span>
        </button>
        <div v-else class="crop-neighbor crop-neighbor--empty"></div>`,
});

// Photo by photo: big current image, the next and previous on the sides. The box (and its shape) carries over.
export const CropTool = defineComponent({
    components: { ImageStage, ImageNav, Neighbor, Icon },
    setup() {
        const store = inject('store');
        const s = store.state;
        const { items, index, current, go } = useImageStepper();
        const shape = ref('free');
        const rect = reactive(fittedBox(null, 1, MARGIN));
        const overlay = ref(null);

        const ratio = computed(() => (current.value ? aspectOf(current.value) : 1));
        const aspectValue = (item = current.value) => {
            const a = ASPECTS.find(x => x.key === shape.value)?.value ?? null;
            return a === 'original' ? (item ? aspectOf(item) : null) : a;
        };
        const reset = () => Object.assign(rect, fittedBox(aspectValue(), ratio.value, shape.value === 'free' ? MARGIN : 0));
        watch(shape, reset);
        // Another photo with a different shape: re-fit a locked box; a free box keeps its place.
        watch(ratio, () => { if (shape.value !== 'free') reset(); });

        const drag = (event, mode) => {
            const orig = { ...rect };
            const a = aspectValue();
            startDrag(event, overlay.value, (p, st) => {
                const dx = p.x - st.x, dy = p.y - st.y;
                if (mode === 'move') Object.assign(rect, moveBox(orig, dx, dy));
                else if (mode === 'new') Object.assign(rect, drawnBox(st, p, a, ratio.value, MIN));
                else Object.assign(rect, lockAspect(resizeRect(orig, mode, dx, dy, MIN), mode, a, ratio.value));
            });
        };

        const sizeLabel = computed(() => {
            const size = current.value && sizeOf(current.value);
            return size ? `${Math.round(rect.w * size.width)} × ${Math.round(rect.h * size.height)}` : '';
        });

        // Same box on every photo; a fixed shape is re-fitted to each photo's proportions.
        const boxFor = (item) => {
            if (shape.value === 'free' || item === current.value) return { ...rect };
            return fittedBox(aspectValue(item), aspectOf(item));
        };
        const crop = (list, summary) => store.addOp(list, item => ({ type: 'crop', ...boxFor(item) }), summary);

        const cropThis = () => {
            const item = current.value;
            if (!item || isFullBox(rect)) return;
            if (!crop([item], `Cropped ${item.name}`)) return;
            if (index.value < items.value.length - 1) go(index.value + 1);
            else store.setTool('convert');
        };
        const cropAll = () => {
            if (crop(items.value, n => `Cropped ${plural(n, 'image')}`)) store.setTool('convert');
        };

        useKeydown((e) => {
            if (e.key !== 'Enter' || s.busy) return;
            e.preventDefault();
            cropThis();
        });

        return { store, s, items, index, current, go, shape, rect, overlay, drag, sizeLabel, cropThis, cropAll, reset, boxStyle, ASPECTS, ICONS };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row">
                    <div class="convert-pick__options aspect-pick" role="group" aria-label="Shape">
                        <button v-for="a in ASPECTS" :key="a.key" type="button"
                            :class="['convert-pick__option', 'convert-pick__option--sm', { 'convert-pick__option--on': shape === a.key }]" @click="shape = a.key">{{ a.label }}</button>
                    </div>
                    <image-nav v-if="items.length > 1" :items="items" :index="index" @update:index="go"/>
                </div>
                <div class="tool__primary">
                    <n-button quaternary @click="reset">Reset box</n-button>
                    <n-button v-if="items.length > 1" :disabled="!!s.busy" @click="cropAll">Crop all {{ items.length }}</n-button>
                    <n-button type="primary" :disabled="!!s.busy || !current" @click="cropThis">
                        Crop<template v-if="index < items.length - 1"> &amp; next</template>
                    </n-button>
                </div>
            </div>
            <div v-if="current" class="crop-flow">
                <neighbor :item="items[index - 1]" label="Previous" :icon="ICONS.left" @go="go(index - 1)"/>
                <div class="crop-flow__main">
                    <image-stage :item="current">
                        <div class="crop" ref="overlay" @pointerdown="drag($event, 'new')">
                            <div class="crop__rect" :style="boxStyle(rect)" @pointerdown="drag($event, 'move')">
                                <span class="crop__size">{{ sizeLabel }}</span>
                                <span v-for="h in ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w']" :key="h" :class="['crop__handle', 'crop__handle--' + h]"
                                      @pointerdown="drag($event, h)"></span>
                            </div>
                        </div>
                    </image-stage>
                    <p class="tool__note">Drag the box or its handles · pinch to zoom · Enter crops and moves to the next</p>
                </div>
                <neighbor :item="items[index + 1]" label="Next" :icon="ICONS.right" @go="go(index + 1)"/>
            </div>
        </div>`,
});
