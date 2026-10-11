import { ImageStage, ImageNav, Icon, ICONS, useImageStepper, pickFiles, aspectOf } from './shared.js';
import { FontSelect, fontCss } from '/shared/fonts.js';
import { BUILTIN_FONTS, drawWatermark } from '../img/render.js';
import { splitLast } from '../img/ops.js';
import { readStored, writeStored, plural } from '../util.js';

const { defineComponent, inject, reactive, ref, shallowRef, computed, watch, markRaw, onMounted, onBeforeUnmount } = Vue;

const POSITIONS = [
    { key: 'tl', label: 'Top left' }, { key: 'top', label: 'Top' }, { key: 'tr', label: 'Top right' },
    { key: 'center', label: 'Centre' },
    { key: 'bl', label: 'Bottom left' }, { key: 'bottom', label: 'Bottom' }, { key: 'br', label: 'Bottom right' },
];
const COLORS = ['#ffffff', '#111827', '#e11d48', '#2563eb'];

// The watermark drawn live over the stage with the same code that renders the saved file, so sliders follow the finger.
const MarkOverlay = defineComponent({
    props: { op: { type: Object, default: null }, width: { type: Number, required: true }, aspect: { type: Number, required: true } },
    setup(props) {
        const canvas = ref(null);
        let frame = 0;
        const draw = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const c = canvas.value;
                if (!c || !props.width) return;
                const dpr = Math.min(2, window.devicePixelRatio || 1);
                const w = Math.round(props.width * dpr), h = Math.round((props.width / props.aspect) * dpr);
                // Resizing reallocates the backing store: only when the stage size changed, not on every slider frame.
                if (c.width !== w || c.height !== h) Object.assign(c, { width: w, height: h });
                const ctx = c.getContext('2d');
                ctx.clearRect(0, 0, c.width, c.height);
                if (!props.op) return;
                drawWatermark(ctx, c.width, c.height, props.op, { [props.op.font]: fontCss(props.op.font, BUILTIN_FONTS) });
            });
        };
        watch(() => [props.op, props.width, props.aspect], draw, { deep: true });
        onMounted(() => {
            draw();
            document.fonts?.ready.then(draw);
        });
        onBeforeUnmount(() => cancelAnimationFrame(frame));
        return { canvas };
    },
    template: `<canvas ref="canvas" class="wm-overlay"></canvas>`,
});

// One look for the whole batch, checked on any photo, then applied to the selection (or all) — or applied and saved at once.
export const WatermarkTool = defineComponent({
    components: { ImageStage, ImageNav, Icon, FontSelect, MarkOverlay },
    setup() {
        const store = inject('store');
        const s = store.state;
        const { items, index, current, go } = useImageStepper();
        const mark = reactive({
            text: '© ', font: 'sans', bold: true, color: '#ffffff', size: 0.06, opacity: 0.5, angle: 0,
            position: 'br', tile: false, lines: false, spacing: 1, ...readStored('image.watermark', {}), content: 'text',
        });
        // The logo file isn't remembered across visits, so neither is a logo choice.
        watch(mark, () => writeStored('image.watermark', { ...mark, content: undefined }), { deep: true });
        const logo = shallowRef(null);
        const logoBitmap = shallowRef(null);
        const logoUrl = ref(null);
        onBeforeUnmount(() => logoUrl.value && URL.revokeObjectURL(logoUrl.value));

        const pickLogo = async () => {
            const [file] = await pickFiles({ accept: 'image/png,image/webp,image/jpeg' });
            if (!file) return;
            try {
                logoBitmap.value = markRaw(await createImageBitmap(file));
            } catch {
                store.message.error(`${file.name} isn't an image this browser can read`);
                return;
            }
            logo.value = markRaw(file);
            if (logoUrl.value) URL.revokeObjectURL(logoUrl.value);
            logoUrl.value = URL.createObjectURL(file);
            if (mark.content === 'text') mark.content = 'logo';
        };

        const useText = computed(() => mark.content !== 'logo' && !!mark.text.trim());
        const useLogo = computed(() => mark.content !== 'text' && !!logo.value);
        const ready = computed(() => useText.value || useLogo.value);
        const settings = () => ({
            type: 'watermark', font: mark.font, bold: mark.bold, color: mark.color, size: mark.size, opacity: mark.opacity,
            angle: mark.angle, position: mark.position, tile: mark.tile, lines: mark.tile && mark.lines, spacing: mark.spacing,
            text: useText.value ? mark.text : null,
        });
        // The overlay draws the decoded logo; the saved op carries the file (the worker decodes it).
        const overlayOp = computed(() => (ready.value ? { ...settings(), image: useLogo.value ? logoBitmap.value : null } : null));
        const op = () => ({ ...settings(), imageBlob: useLogo.value ? logo.value : null });

        const base = computed(() => (current.value ? splitLast(current.value.ops, 'watermark').base : []));
        const aspect = computed(() => (current.value ? aspectOf(current.value, base.value) : 1));

        const targets = computed(() => store.targets());
        const apply = () => {
            if (!ready.value) return false;
            return store.edit(targets.value, (item, ops) => [...splitLast(ops, 'watermark').base, op()], n => `Watermarked ${plural(n, 'image')}`);
        };
        const applyAndSave = async () => {
            const list = targets.value;
            if (apply()) await store.save('files', { items: list });
        };
        const removeAll = () => {
            const marked = targets.value.filter(i => splitLast(i.ops, 'watermark').last);
            if (marked.length) store.edit(marked, (item, ops) => splitLast(ops, 'watermark').base, 'Removed the watermark');
        };
        const hasMark = computed(() => targets.value.some(i => splitLast(i.ops, 'watermark').last));

        return { plural, store, s, items, index, current, go, mark, logo, logoUrl, pickLogo, ready, overlayOp, base, aspect, targets, apply, applyAndSave, removeAll, hasMark, POSITIONS, COLORS, BUILTIN_FONTS, ICONS };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row">
                    <image-nav v-if="items.length > 1" :items="items" :index="index" @update:index="go"/>
                    <span class="tool__count">Applies to {{ s.selected.length ? s.selected.length + ' selected' : 'all ' + plural(s.images.length, 'image') }}</span>
                </div>
                <div class="tool__primary">
                    <n-button quaternary :disabled="!hasMark" @click="removeAll">Remove</n-button>
                    <n-button :disabled="!ready || !!s.busy" @click="apply">Apply</n-button>
                    <n-button type="primary" :disabled="!ready || !!s.busy" @click="applyAndSave">
                        <template #icon><icon :d="ICONS.download"/></template>Watermark &amp; save{{ targets.length > 1 ? ' all ' + targets.length : '' }}
                    </n-button>
                </div>
            </div>
            <div v-if="current" class="editor">
                <div class="editor__main">
                    <image-stage :item="current" :ops="base">
                        <template #default="{ width }"><mark-overlay :op="overlayOp" :width="width" :aspect="aspect"/></template>
                    </image-stage>
                </div>
                <aside class="editor__props">
                    <n-radio-group v-model:value="mark.content" size="small">
                        <n-radio-button value="text">Text</n-radio-button>
                        <n-radio-button value="logo">Logo</n-radio-button>
                        <n-radio-button value="both">Text + logo</n-radio-button>
                    </n-radio-group>
                    <template v-if="mark.content !== 'logo'">
                        <n-input v-model:value="mark.text" placeholder="© Your name" size="small"/>
                        <div class="field"><span class="field__label">Font</span><font-select v-model:value="mark.font" :builtins="BUILTIN_FONTS"/></div>
                    </template>
                    <div v-if="mark.content !== 'text'" class="props-row">
                        <img v-if="logoUrl" :src="logoUrl" class="wm-logo" alt=""/>
                        <n-button size="small" @click="pickLogo"><template #icon><icon :d="ICONS.image"/></template>{{ logo ? 'Change logo' : 'Choose a logo' }}</n-button>
                    </div>
                    <div class="props-row">
                        <div class="swatches">
                            <button v-for="c in COLORS" :key="c" type="button" :class="['swatch', { 'swatch--on': mark.color === c }]" :style="{ background: c }" @click="mark.color = c"></button>
                            <input type="color" class="swatch swatch--custom" v-model="mark.color" title="Other colour"/>
                        </div>
                        <label v-if="mark.content !== 'logo'" class="inline-switch"><n-switch v-model:value="mark.bold" size="small"/> Bold</label>
                    </div>
                    <div class="field"><span class="field__label">Size</span><n-slider v-model:value="mark.size" :min="0.015" :max="0.25" :step="0.001" :tooltip="false"/></div>
                    <div class="field"><span class="field__label">Opacity {{ Math.round(mark.opacity * 100) }}%</span><n-slider v-model:value="mark.opacity" :min="0.05" :max="1" :step="0.01" :tooltip="false"/></div>
                    <div class="field"><span class="field__label">Angle {{ mark.angle }}°</span><n-slider v-model:value="mark.angle" :min="-180" :max="180" :step="1" :marks="{ 0: '' }" @dblclick="mark.angle = 0"/></div>
                    <label class="inline-switch"><n-switch v-model:value="mark.tile" size="small"/> Repeat across the photo</label>
                    <template v-if="mark.tile">
                        <label class="inline-switch"><n-switch v-model:value="mark.lines" size="small"/> Grid lines between marks</label>
                        <div class="field"><span class="field__label">Spacing</span><n-slider v-model:value="mark.spacing" :min="0.3" :max="3" :step="0.05" :tooltip="false"/></div>
                    </template>
                    <div v-else class="field">
                        <span class="field__label">Position</span>
                        <div class="wm-positions">
                            <button v-for="p in POSITIONS" :key="p.key" type="button" :title="p.label"
                                :class="['wm-positions__cell', 'wm-positions__cell--' + p.key, { 'wm-positions__cell--on': mark.position === p.key }]" @click="mark.position = p.key"></button>
                        </div>
                    </div>
                </aside>
            </div>
        </div>`,
});
