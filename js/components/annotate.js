import { ImageStage, ImageNav, Icon, ICONS, useOpEditor, useKeydown, startDrag, pointIn, resizeRect, sizeOf } from './shared.js';
import { FontSelect, fontCss } from '/shared/fonts.js';
import { BUILTIN_FONTS, arrowHead } from '../img/render.js';
import { drawnBox } from '../img/crop.js';

const { defineComponent, inject, ref, reactive, computed, nextTick } = Vue;

const MODES = [
    { key: 'select', label: 'Select', icon: ICONS.pointer },
    { key: 'text', label: 'Text', icon: ICONS.text },
    { key: 'arrow', label: 'Arrow', icon: ICONS.arrow },
    { key: 'line', label: 'Line', icon: ICONS.line },
    { key: 'rect', label: 'Box', icon: ICONS.square },
    { key: 'ellipse', label: 'Circle', icon: ICONS.circle },
    { key: 'pen', label: 'Draw', icon: ICONS.pencil },
    { key: 'highlight', label: 'Highlight', icon: ICONS.highlight },
];
const COLORS = ['#e11d48', '#f59e0b', '#16a34a', '#2563eb', '#111827', '#ffffff'];
const HIGHLIGHT = '#facc15';
const NAMES = { text: 'Text', arrow: 'Arrow', line: 'Line', rect: 'Box', ellipse: 'Circle', pen: 'Drawing', highlight: 'Highlight' };
const isBox = (el) => el.kind === 'rect' || el.kind === 'ellipse';
let nextId = 1;

// One annotation in the SVG layer (w × h = the photo's output size). Its own component, so editing one
// element (a pen stroke, a keystroke in its text) re-renders only that element.
const AnnotItem = defineComponent({
    props: { el: { type: Object, required: true }, w: Number, h: Number, unit: Number, active: Boolean },
    emits: ['grab'],
    setup(props) {
        const lines = computed(() => String(props.el.text || '').split('\n'));
        const stroke = computed(() => Math.max(1, (props.el.stroke || 0) * props.unit));
        const points = computed(() => (props.el.points || []).map(([x, y]) => `${x * props.w},${y * props.h}`).join(' '));
        const head = computed(() => {
            const el = props.el;
            return arrowHead(el.x1 * props.w, el.y1 * props.h, el.x2 * props.w, el.y2 * props.h, stroke.value * 4).map(p => p.join(',')).join(' ');
        });
        const font = computed(() => fontCss(props.el.font, BUILTIN_FONTS));
        // An estimate for the label background; the saved file measures the real text.
        const textWidth = computed(() => Math.max(...lines.value.map(l => l.length)) * props.el.size * props.unit * 0.55);
        return { lines, stroke, points, head, font, textWidth };
    },
    template: `
        <g :class="['annot__item', { 'annot__item--on': active }]" @pointerdown.stop="$emit('grab', $event)">
            <template v-if="el.kind === 'text'">
                <rect v-if="el.background" :x="el.x * w - el.size * unit * 0.2" :y="el.y * h - el.size * unit * 0.1"
                    :width="textWidth + el.size * unit * 0.4" :height="lines.length * el.size * unit * 1.2 + el.size * unit * 0.1" :fill="el.background"/>
                <text :x="el.x * w" :y="el.y * h" :font-size="el.size * unit" :font-family="font"
                    :font-weight="el.bold || el.font === 'impact' ? 700 : 400" :fill="el.color" dominant-baseline="text-before-edge">
                    <tspan v-for="(line, i) in lines" :key="i" :x="el.x * w" :dy="i ? el.size * unit * 1.2 : 0">{{ line || ' ' }}</tspan>
                </text>
            </template>
            <rect v-else-if="el.kind === 'rect'" :x="el.x * w" :y="el.y * h" :width="el.w * w" :height="el.h * h"
                :fill="el.fill ? el.color : 'transparent'" :stroke="el.color" :stroke-width="stroke" stroke-linejoin="round"/>
            <ellipse v-else-if="el.kind === 'ellipse'" :cx="(el.x + el.w / 2) * w" :cy="(el.y + el.h / 2) * h"
                :rx="el.w * w / 2" :ry="el.h * h / 2" :fill="el.fill ? el.color : 'transparent'" :stroke="el.color" :stroke-width="stroke"/>
            <template v-else-if="el.kind === 'line' || el.kind === 'arrow'">
                <line :x1="el.x1 * w" :y1="el.y1 * h" :x2="el.x2 * w" :y2="el.y2 * h" :stroke="el.color" :stroke-width="stroke" stroke-linecap="round"/>
                <polyline v-if="el.kind === 'arrow'" :points="head" fill="none" :stroke="el.color" :stroke-width="stroke" stroke-linecap="round" stroke-linejoin="round"/>
                <line class="annot__hit" :x1="el.x1 * w" :y1="el.y1 * h" :x2="el.x2 * w" :y2="el.y2 * h" :stroke-width="unit * 0.04"/>
            </template>
            <template v-else>
                <polyline :points="points" fill="none" :stroke="el.color" :stroke-width="stroke"
                    :stroke-linecap="el.kind === 'highlight' ? 'butt' : 'round'" stroke-linejoin="round" :class="{ 'annot__highlight': el.kind === 'highlight' }"/>
                <polyline class="annot__hit" :points="points" fill="none" :stroke-width="Math.max(unit * 0.03, stroke)"/>
            </template>
        </g>`,
});

// Text, arrows, boxes and drawing. Re-annotating a photo edits its last annotation layer.
export const AnnotateTool = defineComponent({
    components: { ImageStage, ImageNav, Icon, FontSelect, AnnotItem },
    setup() {
        const store = inject('store');
        const mode = ref('text');
        const elements = ref([]);
        const active = ref(null);
        const style = reactive({ color: COLORS[0], stroke: 0.006, size: 0.05, font: 'sans', bold: true, fill: false, background: false });
        const overlay = ref(null);
        const textBox = ref(null);

        const clean = () => elements.value.filter(e => e.kind !== 'text' || String(e.text).trim())
            .map(({ id, ...rest }) => ({ ...rest, points: rest.points?.map(p => [...p]) }));
        const { items, index, current, go, parts, applyCurrent } = useOpEditor('annotate', {
            load: (last) => {
                elements.value = last ? last.elements.map(e => ({ ...e, id: nextId++, points: e.points?.map(p => [...p]) })) : [];
                active.value = null;
            },
            toOp: () => {
                const list = clean();
                return list.length ? { type: 'annotate', elements: list } : null;
            },
        });

        const size = computed(() => (current.value && sizeOf(current.value, parts.value.base)) || { width: 1000, height: 1000 });
        const unit = computed(() => Math.min(size.value.width, size.value.height));
        const selected = computed(() => elements.value.find(e => e.id === active.value) || null);
        const editing = computed(() => selected.value || style);

        // Style changes apply to the selected element and become the default for new ones.
        const setStyle = (key, value) => {
            style[key] = value;
            if (selected.value && key in selected.value) selected.value[key] = value;
        };

        const add = (el) => {
            elements.value.push({ id: nextId++, color: mode.value === 'highlight' ? HIGHLIGHT : style.color, ...el });
            const item = elements.value.at(-1);
            active.value = item.id;
            return item;
        };

        const focusText = () => nextTick(() => {
            const area = textBox.value?.$el?.querySelector('textarea');
            area?.focus();
            area?.select();
        });

        const onDown = (event) => {
            const el = overlay.value;
            const p = pointIn(event, el);
            if (mode.value === 'select') {
                active.value = null;
                return;
            }
            if (mode.value === 'text') {
                event.preventDefault();
                add({ kind: 'text', x: p.x, y: p.y, text: 'Text', size: style.size, font: style.font, bold: style.bold, background: style.background ? '#ffffff' : null });
                focusText();
                return;
            }
            if (mode.value === 'pen' || mode.value === 'highlight') {
                const stroke = mode.value === 'highlight' ? Math.max(style.stroke * 4, 0.025) : style.stroke;
                const line = add({ kind: mode.value, points: [[p.x, p.y]], stroke });
                // Pointer events outrun the screen: points join the stroke once per frame.
                let pending = [], frame = 0;
                const flush = () => {
                    frame = 0;
                    line.points.push(...pending);
                    pending = [];
                };
                startDrag(event, el, (q) => {
                    pending.push([q.x, q.y]);
                    frame ||= requestAnimationFrame(flush);
                }, () => {
                    cancelAnimationFrame(frame);
                    flush();
                });
                return;
            }
            const kind = mode.value;
            const shape = add(isBox({ kind })
                ? { kind, x: p.x, y: p.y, w: 0, h: 0, stroke: style.stroke, fill: style.fill }
                : { kind, x1: p.x, y1: p.y, x2: p.x, y2: p.y, stroke: style.stroke });
            startDrag(event, el, (q, st) => {
                if (isBox(shape)) Object.assign(shape, drawnBox(st, q, null, 1, 0));
                else Object.assign(shape, { x2: q.x, y2: q.y });
            }, () => {
                // A tap places a sensible default-sized shape.
                const tiny = isBox(shape) ? shape.w < 0.01 && shape.h < 0.01 : Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 0.01;
                if (!tiny) return;
                const r = size.value.width / size.value.height;
                if (isBox(shape)) Object.assign(shape, { w: 0.2 / Math.max(1, r), h: 0.2 * Math.min(1, r) });
                else Object.assign(shape, { x1: Math.max(0, p.x - 0.15), y1: Math.max(0, p.y - 0.1), x2: p.x, y2: p.y });
            });
        };

        const moveEl = (event, el) => {
            active.value = el.id;
            const orig = JSON.parse(JSON.stringify(el));
            startDrag(event, overlay.value, (q, st) => {
                const dx = q.x - st.x, dy = q.y - st.y;
                if ('x' in orig) Object.assign(el, { x: orig.x + dx, y: orig.y + dy });
                if ('x1' in orig) Object.assign(el, { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
                if (orig.points) el.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
            });
            if (el.kind === 'text') focusText();
        };

        const handle = (event, el, which) => {
            const orig = { ...el };
            startDrag(event, overlay.value, (q, st) => {
                if (which === 'p1') Object.assign(el, { x1: q.x, y1: q.y });
                else if (which === 'p2') Object.assign(el, { x2: q.x, y2: q.y });
                else Object.assign(el, resizeRect(orig, which, q.x - st.x, q.y - st.y, 0.01));
            });
        };

        const removeActive = () => {
            elements.value = elements.value.filter(e => e.id !== active.value);
            active.value = null;
        };
        useKeydown((e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && active.value) removeActive();
            if (e.key === 'Escape') active.value = null;
        });

        const apply = () => applyCurrent(item => (clean().length ? `Annotated ${item.name}` : `Removed the annotations from ${item.name}`));

        return {
            s: store.state, items, index, current, go, parts, mode, elements, active, selected, editing, style, setStyle, overlay, textBox, size, unit,
            onDown, moveEl, handle, removeActive, apply, isBox, NAMES, MODES, COLORS, BUILTIN_FONTS, ICONS,
        };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row">
                    <div class="palette" role="group" aria-label="Tool">
                        <button v-for="m in MODES" :key="m.key" type="button" :title="m.label"
                            :class="['palette__btn', { 'palette__btn--on': mode === m.key }]" @click="mode = m.key; active = null">
                            <icon :d="m.icon"/><span>{{ m.label }}</span>
                        </button>
                    </div>
                    <image-nav v-if="items.length > 1" :items="items" :index="index" @update:index="go"/>
                </div>
                <div class="tool__primary">
                    <n-button type="primary" :disabled="!!s.busy || !current" @click="apply">
                        Apply<template v-if="index < items.length - 1"> &amp; next</template>
                    </n-button>
                </div>
            </div>
            <div v-if="current" class="editor">
                <div class="editor__main">
                    <image-stage :item="current" :ops="parts.base">
                        <div :class="['annot', 'annot--' + mode]" ref="overlay" @pointerdown="onDown">
                            <svg class="annot__svg" :viewBox="'0 0 ' + size.width + ' ' + size.height" preserveAspectRatio="none">
                                <annot-item v-for="el in elements" :key="el.id" :el="el" :w="size.width" :h="size.height" :unit="unit"
                                    :active="el.id === active" @grab="moveEl($event, el)"/>
                            </svg>
                            <template v-if="selected && isBox(selected)">
                                <span class="annot__handle" :style="{ left: selected.x * 100 + '%', top: selected.y * 100 + '%' }" @pointerdown.stop="handle($event, selected, 'nw')"></span>
                                <span class="annot__handle" :style="{ left: (selected.x + selected.w) * 100 + '%', top: (selected.y + selected.h) * 100 + '%' }" @pointerdown.stop="handle($event, selected, 'se')"></span>
                            </template>
                            <template v-if="selected && (selected.kind === 'line' || selected.kind === 'arrow')">
                                <span class="annot__handle" :style="{ left: selected.x1 * 100 + '%', top: selected.y1 * 100 + '%' }" @pointerdown.stop="handle($event, selected, 'p1')"></span>
                                <span class="annot__handle" :style="{ left: selected.x2 * 100 + '%', top: selected.y2 * 100 + '%' }" @pointerdown.stop="handle($event, selected, 'p2')"></span>
                            </template>
                        </div>
                    </image-stage>
                    <p class="tool__note">{{ mode === 'text' ? 'Tap to place text, then type it in the panel' : mode === 'select' ? 'Tap an item to change it · drag to move' : 'Drag on the photo to draw' }} · Delete removes the selected item</p>
                </div>
                <aside class="editor__props">
                    <div class="editor__title">{{ selected ? NAMES[selected.kind] : 'Style for new items' }}</div>
                    <n-input v-if="selected && selected.kind === 'text'" ref="textBox" v-model:value="selected.text" type="textarea" :autosize="{ minRows: 1, maxRows: 5 }" placeholder="Type here"/>
                    <div class="field">
                        <span class="field__label">Colour</span>
                        <div class="swatches">
                            <button v-for="c in COLORS" :key="c" type="button" :class="['swatch', { 'swatch--on': editing.color === c }]" :style="{ background: c }" :title="c" @click="setStyle('color', c)"></button>
                            <input type="color" class="swatch swatch--custom" :value="editing.color" @input="setStyle('color', $event.target.value)" title="Other colour"/>
                        </div>
                    </div>
                    <template v-if="!selected || selected.kind === 'text'">
                        <div class="field"><span class="field__label">Text size</span>
                            <n-slider :value="editing.size" @update:value="v => setStyle('size', v)" :min="0.015" :max="0.2" :step="0.005" :tooltip="false"/></div>
                        <div class="field"><span class="field__label">Font</span>
                            <font-select :value="editing.font" @update:value="v => setStyle('font', v)" :builtins="BUILTIN_FONTS"/></div>
                        <div class="props-row">
                            <label class="inline-switch"><n-switch :value="editing.bold" @update:value="v => setStyle('bold', v)" size="small"/> Bold</label>
                            <label class="inline-switch"><n-switch :value="!!editing.background" @update:value="v => setStyle('background', v ? '#ffffff' : null)" size="small"/> Label</label>
                        </div>
                    </template>
                    <template v-if="!selected || selected.kind !== 'text'">
                        <div class="field"><span class="field__label">Line width</span>
                            <n-slider :value="editing.stroke" @update:value="v => setStyle('stroke', v)" :min="0.002" :max="0.03" :step="0.001" :tooltip="false"/></div>
                        <label v-if="!selected || selected.kind === 'rect' || selected.kind === 'ellipse'" class="inline-switch">
                            <n-switch :value="editing.fill" @update:value="v => setStyle('fill', v)" size="small"/> Filled shapes</label>
                    </template>
                    <div class="props-actions">
                        <n-button v-if="selected" size="small" @click="removeActive"><template #icon><icon :d="ICONS.trash"/></template>Delete</n-button>
                    </div>
                </aside>
            </div>
        </div>`,
});
