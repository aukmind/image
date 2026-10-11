import { ImageGrid, SelectionBar, Icon, ICONS } from './shared.js';
import { useMedia } from '/shared/dom.js';
import { isLossy, formatLabel } from '../img/encode.js';
import { plural } from '../util.js';

const { defineComponent, inject, computed, ref } = Vue;

const SIZE_PRESETS = [100, 200, 500, 1000];

// Convert (format + quality) and Compress (quality or a size limit) share the grid and the save settings.
export const ConvertTool = defineComponent({
    components: { ImageGrid, SelectionBar, Icon },
    props: { mode: { type: String, default: 'convert' } },
    setup(props) {
        const store = inject('store');
        const s = store.state;
        const compress = computed(() => props.mode === 'compress');

        const formats = computed(() => [
            { value: 'original', label: 'Same', title: 'Keep each file\'s format (HEIC becomes JPG)' },
            { value: 'jpeg', label: 'JPG' },
            { value: 'png', label: 'PNG' },
            { value: 'webp', label: 'WEBP', disabled: !s.caps.webp },
            ...(s.caps.avif ? [{ value: 'avif', label: 'AVIF' }] : []),
            { value: 'pdf', label: 'PDF', title: 'One PDF, a page per image' },
        ]);

        const sizeMode = ref(s.save.target ? 'size' : 'quality');
        const setSizeMode = (m) => {
            sizeMode.value = m;
            store.setSave({ target: m === 'size' ? (s.save.target || 500) : null });
        };

        const targets = computed(() => store.targets());
        // Quality matters only when some output is lossy; PNG ignores it.
        const lossy = computed(() => s.save.format === 'pdf' || targets.value.some(i => isLossy(store.formatFor(i))));
        const pngOnly = computed(() => compress.value && targets.value.length && targets.value.every(i => store.formatFor(i) === 'png'));
        const actionLabel = computed(() => {
            const what = plural(targets.value.length, 'image');
            const as = formatLabel(s.save.format);
            if (compress.value) return `Compress & save ${what}`;
            return as ? `Save ${what} as ${as}` : `Save ${what}`;
        });
        const heicCount = computed(() => s.images.filter(i => i.proxy).length);

        // Phones show the format and Save; the rest waits behind "Options" (in Compress, only Highest resolution does).
        const phone = useMedia('(max-width: 700px)');
        const moreOpen = ref(false);
        const showMore = computed(() => !phone.value || moreOpen.value);
        const moreSummary = computed(() => [
            !compress.value && lossy.value && `${s.save.quality}%`,
            s.save.highest && heicCount.value && 'full size',
        ].filter(Boolean).join(' · '));

        const save = () => store.save('files', { items: targets.value });
        const removeOne = (item) => store.remove([item.id], `Removed ${item.name}`);

        return { store, s, compress, formats, sizeMode, setSizeMode, lossy, pngOnly, actionLabel, heicCount, phone, moreOpen, showMore, moreSummary, save, removeOne, SIZE_PRESETS, ICONS };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="convert-pick convert-pick--bar">
                    <span class="convert-pick__label">{{ compress ? 'Save as' : 'Format' }}</span>
                    <div class="convert-pick__options">
                        <button v-for="f in formats" :key="f.value" type="button" :title="f.title" :disabled="f.disabled"
                            :class="['convert-pick__option', { 'convert-pick__option--on': s.save.format === f.value }]"
                            @click="store.setSave({ format: f.value })">{{ f.label }}</button>
                    </div>
                </div>
                <div class="tool__row options">
                    <div v-if="compress" class="field">
                        <span class="field__label">Compress by</span>
                        <n-radio-group :value="sizeMode" @update:value="setSizeMode" size="small">
                            <n-radio-button value="quality">Quality</n-radio-button>
                            <n-radio-button value="size">File size</n-radio-button>
                        </n-radio-group>
                    </div>
                    <n-button v-if="phone && (!compress || heicCount)" size="small" class="more-toggle" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">
                        Options<span v-if="moreSummary && !moreOpen" class="more-toggle__summary">{{ moreSummary }}</span>
                        <icon :d="ICONS.down" :size="14" :class="['options-toggle__chevron', { 'options-toggle__chevron--open': moreOpen }]"/>
                    </n-button>
                    <div v-if="(!compress && showMore) || (compress && sizeMode === 'quality')" class="field field--grow quality-field">
                        <span class="field__label">Quality {{ s.save.quality }}%<em v-if="!lossy"> · PNG is lossless</em></span>
                        <n-slider :value="s.save.quality" @update:value="v => store.setSave({ quality: v })" :min="10" :max="100" :step="1" :disabled="!lossy"/>
                    </div>
                    <div v-else-if="compress" class="field">
                        <span class="field__label">Each file under</span>
                        <div class="size-target">
                            <n-input-number :value="s.save.target" @update:value="v => store.setSave({ target: v || null })" :min="10" :step="50" size="small" class="field__control--md">
                                <template #suffix>KB</template>
                            </n-input-number>
                            <n-button-group size="small">
                                <n-button v-for="kb in SIZE_PRESETS" :key="kb" :type="s.save.target === kb ? 'primary' : 'default'" @click="store.setSave({ target: kb })">{{ kb >= 1000 ? kb / 1000 + ' MB' : kb + ' KB' }}</n-button>
                            </n-button-group>
                        </div>
                    </div>
                    <label v-if="showMore" class="inline-switch highest" :title="heicCount ? 'HEIC photos are edited from a fast copy (up to 24 MP, JPEG 95%). This renders the saved files from the originals instead.' : 'Only matters for HEIC photos'">
                        <n-checkbox :checked="s.save.highest" @update:checked="v => store.setSave({ highest: v })" :disabled="!heicCount"/>
                        Highest resolution
                        <small class="highest__hint">{{ heicCount ? 'full size from the original HEIC · slower' : 'only changes HEIC photos' }}</small>
                    </label>
                </div>
                <p v-if="pngOnly" class="notice notice--info">PNG files only get smaller as JPG or WEBP: pick one above.</p>
                <selection-bar :items="s.images" v-model:selected="s.selected"/>
                <div class="tool__primary">
                    <n-button type="primary" :disabled="!!s.busy || !s.images.length" @click="save">
                        <template #icon><icon :d="ICONS.download"/></template>{{ actionLabel }}
                    </n-button>
                </div>
            </div>
            <image-grid :items="s.images" v-model:selected="s.selected" sortable>
                <template #actions="{ item }">
                    <button class="page-card__tool page-card__tool--danger" type="button" title="Remove" @click="removeOne(item)"><icon :d="ICONS.trash" :size="16"/></button>
                </template>
            </image-grid>
            <p class="tool__note tool__note--aside">Drag to reorder (it sets the page order of a PDF) · metadata such as location is removed when you save</p>
        </div>`,
});
