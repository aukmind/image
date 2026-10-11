import { ImageStage, ImageNav, Icon, ICONS, useOpEditor, useKeydown, startDrag, pointIn, resizeRect, boxStyle } from './shared.js';
import { drawnBox, moveBox } from '../img/crop.js';
import { plural } from '../util.js';

const { defineComponent, inject, ref, watch } = Vue;

const MIN = 0.02;

// Boxes that blur or pixelate what's under them. The stage shows the real result, so nothing peeks through.
export const BlurTool = defineComponent({
    components: { ImageStage, ImageNav, Icon },
    setup() {
        const store = inject('store');
        const rects = ref([]);
        const kind = ref('blur');
        const shape = ref('rect');
        const strength = ref(6);
        const active = ref(-1);
        const overlay = ref(null);
        // Dragging shows the box only; the blur catches up when the finger lifts.
        const dragging = ref(false);
        const { items, index, current, go, shown, applyCurrent } = useOpEditor('blur', {
            load: (last) => {
                rects.value = last ? last.rects.map(r => ({ ...r })) : [];
                if (last) {
                    kind.value = last.kind;
                    strength.value = last.strength;
                }
                active.value = -1;
            },
            toOp: () => (rects.value.length ? { type: 'blur', kind: kind.value, strength: strength.value, rects: rects.value.map(r => ({ ...r })) } : null),
            draft: [rects, kind, strength],
            paused: dragging,
        });

        const drag = (event, mode, i = -1) => {
            const el = overlay.value;
            if (mode === 'new') {
                const at = pointIn(event, el);
                rects.value.push({ x: at.x, y: at.y, w: 0, h: 0, shape: shape.value });
                i = rects.value.length - 1;
            }
            active.value = i;
            const orig = { ...rects.value[i] };
            dragging.value = true;
            startDrag(event, el, (p, st) => {
                const dx = p.x - st.x, dy = p.y - st.y;
                const r = rects.value[i];
                if (mode === 'new') Object.assign(r, drawnBox(st, p, null, 1, 0));
                else if (mode === 'move') Object.assign(r, moveBox(orig, dx, dy));
                else Object.assign(r, resizeRect(orig, mode, dx, dy, MIN));
            }, () => {
                dragging.value = false;
                const r = rects.value[i];
                // A tap without a drag makes a sensible default box there.
                if (mode === 'new' && r && (r.w < MIN || r.h < MIN)) Object.assign(r, { x: Math.max(0, Math.min(0.88, r.x - 0.06)), y: Math.max(0, Math.min(0.92, r.y - 0.04)), w: 0.12, h: 0.08 });
            });
        };
        // The shape picker sets new areas, and reshapes the selected one.
        const setShape = (v) => {
            shape.value = v;
            if (active.value >= 0) rects.value[active.value].shape = v;
        };
        watch(active, (i) => { if (i >= 0) shape.value = rects.value[i].shape || 'rect'; });

        const removeActive = () => {
            if (active.value < 0) return;
            rects.value.splice(active.value, 1);
            active.value = -1;
        };
        useKeydown((e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && active.value >= 0) removeActive();
        });

        const apply = () => applyCurrent(item => (rects.value.length
            ? `Blurred ${plural(rects.value.length, 'area')} in ${item.name}` : `Removed the blur from ${item.name}`));

        return { s: store.state, items, index, current, go, rects, kind, shape, setShape, strength, active, overlay, shown, dragging, drag, removeActive, apply, boxStyle, plural, ICONS };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row">
                    <n-radio-group :value="shape" @update:value="setShape" size="small" aria-label="Shape">
                        <n-radio-button value="rect">Box</n-radio-button>
                        <n-radio-button value="ellipse">Circle</n-radio-button>
                    </n-radio-group>
                    <n-radio-group v-model:value="kind" size="small">
                        <n-radio-button value="blur">Blur</n-radio-button>
                        <n-radio-button value="pixelate">Pixelate</n-radio-button>
                    </n-radio-group>
                    <label class="field field--grow blur-strength"><span class="field__label">Strength</span>
                        <n-slider v-model:value="strength" :min="2" :max="10" :step="1"/></label>
                    <image-nav v-if="items.length > 1" :items="items" :index="index" @update:index="go"/>
                </div>
                <div class="tool__primary">
                    <n-button quaternary :disabled="active < 0" @click="removeActive"><template #icon><icon :d="ICONS.trash"/></template>Remove area</n-button>
                    <n-button type="primary" :disabled="!!s.busy || !current" @click="apply">
                        Apply<template v-if="index < items.length - 1"> &amp; next</template>
                    </n-button>
                </div>
            </div>
            <div v-if="current" class="tool__canvas">
                <image-stage :item="current" :ops="shown">
                    <div class="blur-layer" ref="overlay" @pointerdown="drag($event, 'new')">
                        <div v-for="(r, i) in rects" :key="i" :class="['blur-box', { 'blur-box--on': i === active, 'blur-box--ellipse': r.shape === 'ellipse' }]" :style="boxStyle(r)"
                             @pointerdown="drag($event, 'move', i)">
                            <span v-for="h in ['nw', 'ne', 'sw', 'se']" :key="h" :class="['crop__handle', 'crop__handle--' + h]" @pointerdown="drag($event, h, i)"></span>
                        </div>
                    </div>
                </image-stage>
                <p class="tool__note">Drag over a face, plate or address (or tap it) · drag an area to move it · {{ plural(rects.length, 'area') }}</p>
            </div>
        </div>`,
});
