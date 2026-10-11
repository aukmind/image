import { ImageStage, ImageNav, Icon, ICONS, useOpEditor } from './shared.js';
import { isNeutralAdjust } from '../img/render.js';
import { plural } from '../util.js';

const { defineComponent, inject, reactive, computed } = Vue;

const SLIDERS = [
    { key: 'brightness', label: 'Brightness' },
    { key: 'contrast', label: 'Contrast' },
    { key: 'saturation', label: 'Saturation' },
    { key: 'warmth', label: 'Warmth' },
];
const NEUTRAL = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, grayscale: false };

// Re-adjusting a photo edits its last adjustment instead of stacking another one.
export const AdjustTool = defineComponent({
    components: { ImageStage, ImageNav, Icon },
    setup() {
        const store = inject('store');
        const values = reactive({ ...NEUTRAL });
        // The stage renders exactly what will be saved, a moment after the sliders stop.
        const { items, index, current, go, parts, shown, apply, applyCurrent } = useOpEditor('adjust', {
            load: (last) => {
                const { type, ...saved } = last || {};
                Object.assign(values, NEUTRAL, saved);
            },
            toOp: () => (isNeutralAdjust(values) ? null : { ...values, type: 'adjust' }),
            draft: values,
            delay: 60,
        });

        const changed = computed(() => {
            const last = parts.value.last || NEUTRAL;
            return Object.keys(NEUTRAL).some(k => (last[k] ?? NEUTRAL[k]) !== values[k]);
        });
        const applyThis = () => applyCurrent(item => `Adjusted ${item.name}`);
        const applyAll = () => apply(items.value, n => `Adjusted ${plural(n, 'image')}`);
        const reset = () => Object.assign(values, NEUTRAL);

        return { s: store.state, items, index, current, go, values, shown, changed, applyThis, applyAll, reset, SLIDERS, ICONS };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row">
                    <image-nav v-if="items.length > 1" :items="items" :index="index" @update:index="go"/>
                </div>
                <div class="tool__primary">
                    <n-button quaternary @click="reset">Reset</n-button>
                    <n-button v-if="items.length > 1" :disabled="!!s.busy" @click="applyAll">Apply to all {{ items.length }}</n-button>
                    <n-button type="primary" :disabled="!!s.busy || !current" @click="applyThis">
                        Apply<template v-if="index < items.length - 1"> &amp; next</template>
                    </n-button>
                </div>
            </div>
            <div v-if="current" class="editor">
                <div class="editor__main">
                    <image-stage :item="current" :ops="shown"/>
                </div>
                <aside class="editor__props adjust-panel">
                    <div v-for="sl in SLIDERS" :key="sl.key" class="field">
                        <span class="field__label adjust-panel__label">{{ sl.label }}<b>{{ values[sl.key] > 0 ? '+' : '' }}{{ values[sl.key] }}</b></span>
                        <n-slider v-model:value="values[sl.key]" :min="-100" :max="100" :step="1" :disabled="sl.key === 'saturation' && values.grayscale"
                            :marks="{ 0: '' }" @dblclick="values[sl.key] = 0"/>
                    </div>
                    <label class="inline-switch"><n-switch v-model:value="values.grayscale" size="small"/> Black &amp; white</label>
                    <p class="editor__empty">Double-click a slider to reset it. {{ changed ? 'Not applied yet.' : '' }}</p>
                </aside>
            </div>
        </div>`,
});
