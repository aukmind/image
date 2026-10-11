import { ImageGrid, SelectionBar, Icon, ICONS } from './shared.js';
import { withRotation, withFlip } from '../img/ops.js';
import { plural } from '../util.js';

const { defineComponent, inject, computed } = Vue;

export const RotateTool = defineComponent({
    components: { ImageGrid, SelectionBar, Icon },
    setup() {
        const store = inject('store');
        const s = store.state;
        const targets = computed(() => store.targets());
        const rotate = (items, deg) => store.edit(items, (item, ops) => withRotation(ops, deg),
            items.length === 1 ? `Turned ${items[0].name}` : n => `Turned ${plural(n, 'image')}`);
        const flip = (items, axis) => store.edit(items, (item, ops) => withFlip(ops, axis),
            items.length === 1 ? `Mirrored ${items[0].name}` : n => `Mirrored ${plural(n, 'image')}`);

        return { store, s, targets, rotate, flip, ICONS };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row">
                    <div class="tool__actions rotate-actions">
                        <n-button size="small" @click="rotate(targets, -90)"><template #icon><icon :d="ICONS.rotateLeft"/></template>Left</n-button>
                        <n-button size="small" @click="rotate(targets, 90)"><template #icon><icon :d="ICONS.rotateRight"/></template>Right</n-button>
                        <n-button size="small" @click="rotate(targets, 180)">180°</n-button>
                        <n-button size="small" @click="flip(targets, 'h')"><template #icon><icon :d="ICONS.flipH"/></template>Mirror</n-button>
                        <n-button size="small" @click="flip(targets, 'v')"><template #icon><icon :d="ICONS.flipV"/></template>Flip</n-button>
                    </div>
                    <span class="tool__count">{{ s.selected.length ? s.selected.length + ' selected' : 'All ' + s.images.length + ' images' }} · each photo also has its own buttons</span>
                </div>
                <selection-bar :items="s.images" v-model:selected="s.selected"/>
            </div>
            <image-grid :items="s.images" v-model:selected="s.selected">
                <template #actions="{ item }">
                    <button class="page-card__tool" type="button" title="Turn left" @click="rotate([item], -90)"><icon :d="ICONS.rotateLeft" :size="16"/></button>
                    <button class="page-card__tool" type="button" title="Turn right" @click="rotate([item], 90)"><icon :d="ICONS.rotateRight" :size="16"/></button>
                </template>
            </image-grid>
        </div>`,
});
