import { ImageGrid, SelectionBar, Icon, ICONS } from './shared.js';
import { TAGS, TAG, parseTagValue, formatTagValue } from '../img/meta.js';
import { policyTags, SOFTWARE } from '../store.js';
import { mapLimit, plural } from '../util.js';

const { defineComponent, inject, reactive, ref, computed, watch } = Vue;

const PIN = 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z';
const PRESETS = [
    { key: 'none', label: 'Remove all', pick: () => false },
    { key: 'date', label: 'Keep dates', pick: t => t.group === 'date' },
    { key: 'safe', label: 'Keep all but location', pick: t => t.group !== 'location' },
    { key: 'all', label: 'Keep all', pick: () => true },
];
// The remembered default for photos not edited here: the presets that make sense for every photo.
const DEFAULTS = PRESETS.filter(p => p.key !== 'date').map(p => ({ value: p.key, label: p.label }));

// View, keep or remove, and edit metadata. With several photos picked, every tag any of them has is listed with
// the values of the focused photo (the last one tapped, else the first); a change applies to all picked photos.
export const MetadataTool = defineComponent({
    components: { ImageGrid, SelectionBar, Icon },
    setup() {
        const store = inject('store');
        const s = store.state;
        const metas = reactive({}); // id -> what the file carries (null: nothing); missing while it's read
        const focusId = ref(null);
        const drafts = reactive({});
        const errors = reactive({});
        const added = ref([]);
        const showOther = ref(false);

        watch(() => s.images.map(i => i.id).join(), () => {
            mapLimit(s.images.filter(i => !(i.id in metas)), 2, async (item) => { metas[item.id] = await store.readMeta(item); });
        }, { immediate: true });

        const targets = computed(() => store.targets());
        const focus = computed(() => targets.value.find(i => i.id === focusId.value) || targets.value[0] || null);
        const original = (item) => metas[item.id]?.tags || {};
        const loading = computed(() => targets.value.some(i => !(i.id in metas)));
        // What a photo is saved with: its own edits here, else the default setting applied to its tags.
        const savedTags = (item) => item.meta || policyTags(original(item), s.save.metaDefault);

        // Every editable tag any picked photo has (in the file or kept/added), in catalogue order, with the focused
        // photo's value.
        const rows = computed(() => {
            const photos = targets.value.map(item => ({ item, saved: savedTags(item), orig: original(item) }));
            const keys = new Set([...added.value, 'Software']);
            for (const p of photos) Object.keys({ ...p.orig, ...p.saved }).forEach(k => keys.add(k));
            const shownValue = (p, key) => formatTagValue(key, p.saved[key] ?? p.orig[key]);
            const focused = photos.find(p => p.item === focus.value);
            return TAGS.filter(t => keys.has(t.key)).map((t) => {
                if (t.key === 'Software') return { ...t, value: SOFTWARE, keep: true, mixed: false, differs: false, fixed: true };
                const kept = photos.filter(p => t.key in p.saved).length;
                return {
                    ...t,
                    value: focused ? shownValue(focused, t.key) : '',
                    keep: kept === photos.length, mixed: kept > 0 && kept < photos.length,
                    differs: new Set(photos.map(p => shownValue(p, t.key))).size > 1,
                };
            });
        });
        const varies = computed(() => rows.value.some(r => r.differs));
        const missing = computed(() => TAGS.filter(t => !rows.value.some(r => r.key === t.key)).map(t => ({ label: t.label, value: t.key })));
        watch(focus, () => { Object.keys(drafts).forEach(k => delete drafts[k]); Object.keys(errors).forEach(k => delete errors[k]); });

        const count = computed(() => targets.value.length);
        // Summaries name what was actually changed (images still loading are left out).
        const what = (n) => (n === 1 && count.value === 1 ? targets.value[0].name : plural(n, 'photo'));
        // An empty tag set still counts: it means "removed", whatever the default setting says.
        const setTags = (fn, summary) => store.editMeta(targets.value, item => fn(item, { ...savedTags(item) }), summary);

        const toggle = (row, keep) => setTags((item, tags) => {
            if (!keep) delete tags[row.key];
            else if (tags[row.key] == null && original(item)[row.key] != null) tags[row.key] = original(item)[row.key];
            return tags;
        }, n => `${keep ? 'Keeping' : 'Removing'} ${row.label.toLowerCase()} · ${what(n)}`);

        const commit = (row) => {
            if (!(row.key in drafts)) return;
            let value;
            try {
                value = parseTagValue(row.key, drafts[row.key]);
            } catch (err) {
                errors[row.key] = err.message;
                return;
            }
            delete errors[row.key];
            delete drafts[row.key];
            setTags((item, tags) => {
                if (value === '') delete tags[row.key];
                else tags[row.key] = value;
                return tags;
            }, n => `Set ${row.label.toLowerCase()} · ${what(n)}`);
        };

        const preset = (p) => setTags(item => Object.fromEntries(Object.entries(original(item)).filter(([k]) => p.pick(TAG[k]))), n => `${p.label} · ${what(n)}`);
        const addTag = (key) => { if (key && !added.value.includes(key)) added.value = [...added.value, key]; };

        const located = computed(() => s.images.filter(i => original(i).latitude != null).length);
        const captions = computed(() => Object.fromEntries(s.images.map((i) => {
            const has = !(i.id in metas) ? 'Reading…' : metas[i.id] ? `${metas[i.id].count} tags` : 'No metadata';
            const kept = Object.keys(savedTags(i)).length;
            return [i.id, `${has} · ${kept ? `keeps ${kept}` : 'all removed'}${i.meta ? ' (edited)' : ''}`];
        })));
        const unwritable = computed(() => targets.value.some(i => !['jpeg', 'png'].includes(store.formatFor(i))));
        const other = computed(() => (focus.value && metas[focus.value.id]?.other) || []);
        const mapUrl = computed(() => {
            const t = focus.value && { ...original(focus.value), ...savedTags(focus.value) };
            return t?.latitude != null && t?.longitude != null ? `https://www.openstreetmap.org/?mlat=${t.latitude.toFixed(6)}&mlon=${t.longitude.toFixed(6)}#map=16/${t.latitude.toFixed(5)}/${t.longitude.toFixed(5)}` : null;
        });

        return {
            DEFAULTS, plural, store, s, metas, focusId, focus, targets, count, loading, rows, varies, missing, drafts, errors, toggle, commit, preset, addTag,
            located, captions, unwritable, other, showOther, mapUrl, PRESETS, PIN, ICONS,
        };
    },
    template: `
        <div class="tool">
            <div class="tool__bar">
                <div class="tool__row">
                    <p :class="['notice', located ? 'notice--warning' : 'notice--info', 'meta-summary']">
                        <icon :d="located ? PIN : ICONS.lock" :size="16"/>
                        <span class="notice__text" v-if="located">{{ located }} of {{ plural(s.images.length, 'photo') }} reveal{{ located === 1 ? 's' : '' }} where {{ located === 1 ? 'it was' : 'they were' }} taken{{ s.save.metaDefault === 'all' ? ' — and "Keep all" saves the location' : ' — saving removes it' }}.</span>
                        <span class="notice__text" v-else>Pick what happens to metadata when you save, or keep and edit tags photo by photo.</span>
                    </p>
                </div>
                <div class="tool__row">
                    <span class="field__label">Photos not edited here, on save:</span>
                    <n-radio-group :value="s.save.metaDefault" @update:value="v => store.setSave({ metaDefault: v })" size="small">
                        <n-radio-button v-for="d in DEFAULTS" :key="d.value" :value="d.value">{{ d.label }}</n-radio-button>
                    </n-radio-group>
                    <span class="tool__count">remembered on this device</span>
                </div>
                <selection-bar :items="s.images" v-model:selected="s.selected"/>
            </div>
            <div class="editor meta-editor">
                <div class="editor__main">
                    <image-grid :items="s.images" v-model:selected="s.selected" :captions="captions" @pick="item => focusId = item.id">
                        <template #overlay="{ item }">
                            <span v-if="metas[item.id]?.tags.latitude != null" class="meta-pin" title="Has a location"><icon :d="PIN" :size="14"/></span>
                        </template>
                    </image-grid>
                </div>
                <aside class="editor__props meta-panel">
                    <div class="editor__title">{{ count === 1 ? focus?.name : count + ' photos · showing ' + focus?.name }}</div>
                    <div class="meta-presets">
                        <n-button v-for="p in PRESETS" :key="p.key" size="tiny" :disabled="loading" @click="preset(p)">{{ p.label }}</n-button>
                    </div>
                    <p v-if="loading" class="editor__empty"><n-spin size="small"/> Reading…</p>
                    <table v-else-if="rows.length" class="meta-table">
                        <tbody>
                            <tr v-for="row in rows" :key="row.key" :class="{ 'meta-table__row--removed': !row.keep && !row.mixed }">
                                <td class="meta-table__keep">
                                    <n-checkbox :checked="row.keep" :indeterminate="row.mixed" :disabled="row.fixed" @update:checked="v => toggle(row, v)" :title="row.fixed ? 'Always set' : row.keep ? 'Kept on save' : 'Removed on save'"/>
                                </td>
                                <th scope="row" :class="{ 'meta-table__warn': row.group === 'location' }">{{ row.label }}</th>
                                <td>
                                    <n-input size="tiny" :disabled="row.fixed" :value="row.key in drafts ? drafts[row.key] : row.value" :placeholder="row.differs ? 'varies' : (row.type === 'date' ? '2024:05:31 14:05:00' : '')"
                                        :status="errors[row.key] ? 'error' : undefined" @update:value="v => drafts[row.key] = v" @change="commit(row)" @keyup.enter="commit(row)"/>
                                    <small v-if="errors[row.key]" class="meta-table__error">{{ errors[row.key] }}</small>
                                    <small v-else-if="row.fixed" class="meta-table__hint">always written into saved JPG and PNG files</small>
                                    <small v-else-if="row.differs" class="meta-table__hint">varies</small>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <p v-else class="editor__empty">No editable tags. Add one below to write it into {{ count === 1 ? 'this photo' : 'these photos' }}.</p>
                    <p v-if="varies" class="editor__empty">"varies": the picked photos differ; a change sets it on all {{ count }}.</p>
                    <n-select size="small" :options="missing" placeholder="Add a tag…" :value="null" @update:value="addTag" filterable/>
                    <a v-if="mapUrl" :href="mapUrl" target="_blank" rel="noopener" class="meta-map"><icon :d="PIN" :size="14"/> Show the location on a map</a>
                    <p v-if="unwritable" class="editor__empty meta-panel__warn">WEBP and AVIF files are saved without metadata: pick JPG or PNG in Convert to keep it.</p>
                    <div v-if="other.length" class="meta-other">
                        <button type="button" class="meta-other__toggle" @click="showOther = !showOther">
                            <icon :d="ICONS.down" :size="14" :class="['options-toggle__chevron', { 'options-toggle__chevron--open': showOther }]"/>
                            {{ other.length }} other tags · always removed
                        </button>
                        <dl v-if="showOther" class="meta-list">
                            <template v-for="[k, v] in other" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
                        </dl>
                    </div>
                </aside>
            </div>
        </div>`,
});
