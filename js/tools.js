import { ICONS } from '/shared/icons.js';

export const TOOLS = [
    { id: 'convert', group: 'Convert', label: 'Convert',
      hint: 'Save as JPG, PNG, WEBP or PDF. HEIC photos from phones work too.',
      icon: 'M4 7h13l-3-3M20 17H7l3 3' },
    { id: 'compress', group: 'Convert', label: 'Compress',
      hint: 'Make files smaller: pick a quality, or a size each file must stay under.',
      icon: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7' },
    { id: 'resize', group: 'Convert', label: 'Resize',
      hint: 'Change the size in pixels or percent, or cap the longest side.',
      icon: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7' },

    { id: 'crop', group: 'Edit', label: 'Crop',
      hint: 'Drag the box to keep part of the photo. Pick a shape, or crop freely.',
      icon: ICONS.crop },
    { id: 'rotate', group: 'Edit', label: 'Rotate',
      hint: 'Turn or mirror photos: one with its own buttons, or the selection at once.',
      icon: ICONS.rotateRight },
    { id: 'adjust', group: 'Edit', label: 'Adjust',
      hint: 'Brightness, contrast, colour and warmth, or black & white.',
      icon: ICONS.sliders },
    { id: 'annotate', group: 'Edit', label: 'Annotate',
      hint: 'Add text, arrows, boxes, highlights or drawing.',
      icon: ICONS.pencil },

    { id: 'blur', group: 'Privacy', label: 'Blur',
      hint: 'Hide faces, plates or addresses: drag a box or circle to blur or pixelate them.',
      icon: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11zM9 14h.01M12 17h.01M15 14h.01M12 11h.01' },
    { id: 'metadata', group: 'Privacy', label: 'Metadata',
      hint: 'See what your photos reveal (location, camera, date). It is all removed when you save.',
      icon: ICONS.info },
    { id: 'watermark', group: 'Privacy', label: 'Watermark',
      hint: 'Stamp text or a logo across photos.',
      icon: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z' },
];

export const TOOL_GROUPS = [...new Set(TOOLS.map(t => t.group))].map(name => ({ name, tools: TOOLS.filter(t => t.group === name) }));

export function toolById(id) {
    return TOOLS.find(t => t.id === id) || TOOLS[0];
}
