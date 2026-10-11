import { ImageGrid, SelectionBar, Icon, ICONS, sizeOf } from './shared.js';
import { resizeTarget } from '../img/render.js';
import { readStored, writeStored, plural } from '../util.js';

const { defineComponent, inject, computed, reactive, watch } = Vue;

const PRESETS = [1080, 1280, 1920, 2048, 3840];

// A resize op sets the final size: applying again replaces the previous one instead of compounding.
export const ResizeTool = defineComponent({
    components: { ImageGrid, SelectionBar, Icon },
    setup() {
        const store = inject('store');
        const s = store.state;
        const opt = reactive({ mode: 'longest', percent: 50, side: 2048, width: null, height: null, lock: true, ...readStored('image.resize', {}) });
        if (opt.mode === 'box') opt.mode = 'pixels'; // the name it was first stored under
        watch(opt, () => writeStored('image.resize', { ...opt }), { deep: true });

        const op = computed(() => ({ type: 'resize', ...opt }));
        const valid = computed(() => (opt.mode === 'percent' ? opt.percent > 0 : opt.mode === 'longest' ? opt.side > 0 : opt.width > 0 || opt.height > 0));
        const targets = computed(() => store.targets());

        const without = (ops) => ops.filter(o => o.type !== 'resize');
        const captions = computed(() => {
            const out = {};
            for (const item of s.images) {
                const now = sizeOf(item);
                if (!now) continue;
                const base = sizeOf(item, without(item.ops));
                const next = valid.value ? resizeTarget(op.value, base.width, base.height) : base;
                const picked = !s.selected.length || s.selected.includes(item.id);
                out[item.id] = picked && (next.width !== now.width || next.height !== now.height)
                    ? `${now.width}×${now.height} → ${next.width}×${next.height}`
                    : `${now.width}×${now.height}`;
            }
            return out;
        });

        const apply = () => {
            store.edit(targets.value, (item, ops) => [...without(ops), { ...op.value }], n => `Resized ${plural(n, 'image')}`);
        };
        const resized = computed(() => targets.value.filter(i => i.ops.some(o => o.type === 'resize')));
        const reset = () => store.edit(resized.value, (item, ops) => without(ops), 'Back to the original size');

        return { plural, s, opt, valid, captions, apply, reset, resized, targets, PRESETS, ICONS };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row options">
                    <div class="field">
                        <span class="field__label">Resize by</span>
                        <n-radio-group v-model:value="opt.mode" size="small">
                            <n-radio-button value="longest">Longest side</n-radio-button>
                            <n-radio-button value="percent">Percent</n-radio-button>
                            <n-radio-button value="pixels">Width × height</n-radio-button>
                        </n-radio-group>
                    </div>
                    <div class="field resize-inputs">
                        <span class="field__label">{{ opt.mode === 'longest' ? 'Longest side (px)' : opt.mode === 'percent' ? 'Percent of current size' : (opt.lock ? 'Fit inside (px)' : 'Exact size (px)') }}</span>
                        <div v-if="opt.mode === 'longest'" class="size-target">
                            <n-input-number v-model:value="opt.side" :min="16" :max="20000" size="small" class="field__control--sm" :show-button="false"/>
                            <n-button-group size="small">
                                <n-button v-for="p in PRESETS" :key="p" :type="opt.side === p ? 'primary' : 'default'" @click="opt.side = p">{{ p >= 3840 ? '4K' : p }}</n-button>
                            </n-button-group>
                        </div>
                        <div v-else-if="opt.mode === 'percent'" class="size-target">
                            <n-input-number v-model:value="opt.percent" :min="1" :max="400" size="small" class="field__control--sm" :show-button="false"><template #suffix>%</template></n-input-number>
                            <n-button-group size="small">
                                <n-button v-for="p in [25, 50, 75]" :key="p" :type="opt.percent === p ? 'primary' : 'default'" @click="opt.percent = p">{{ p }}%</n-button>
                            </n-button-group>
                        </div>
                        <div v-else class="size-target">
                            <n-input-number v-model:value="opt.width" :min="1" :max="20000" size="small" placeholder="Width" class="field__control--sm" :show-button="false"/>
                            <span>×</span>
                            <n-input-number v-model:value="opt.height" :min="1" :max="20000" size="small" placeholder="Height" class="field__control--sm" :show-button="false"/>
                            <label class="inline-switch"><n-checkbox v-model:checked="opt.lock"/> Keep proportions</label>
                        </div>
                    </div>
                </div>
                <selection-bar :items="s.images" v-model:selected="s.selected"/>
                <div class="tool__primary">
                    <n-button quaternary :disabled="!resized.length" @click="reset">Original size</n-button>
                    <n-button type="primary" :disabled="!valid || !!s.busy" @click="apply">
                        Resize {{ plural(targets.length, 'image') }}
                    </n-button>
                </div>
            </div>
            <image-grid :items="s.images" v-model:selected="s.selected" :captions="captions"/>
        </div>`,
});
