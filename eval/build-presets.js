// Builds eval/presets.json from the app's style catalog, so the eval sends the same
// `id|name|category` lines the app does (InstructionEditService.presetCatalog) and the reference
// applier knows what each preset sets.
//
//   node eval/build-presets.js ~/dev/take-agency/shorts-caption/ShortsCaption/Model/TextStyleDefinitions.swift
//
// Per preset: id, name, first category, and the style fields it brings (presetColors,
// presetFontSize, presetPacing, presetOverflowMode, caseTransform, highlightType). A field the
// preset leaves out is omitted; the applier then keeps the current value, as the app's
// `currentStyle ?? preset ?? project` resolution falls through to the project override.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) {
    console.error('usage: node eval/build-presets.js <TextStyleDefinitions.swift>');
    process.exit(1);
}

const COLOR_KEYS = { fill: 'fill', emphasis: 'emphasis', captionBackground: 'caption_bg', wordBackground: 'word_bg' };
const HIGHLIGHT = { none: 'none', static: 'static', spokenWord: 'spoken_word' };
const OVERFLOW = { none: 'none', resizeToFit: 'resize_to_fit', wrap: 'wrap' };

const byte = (value) => Math.round(Math.min(Math.max(Number(value), 0), 1) * 255).toString(16).padStart(2, '0').toUpperCase();

function parseStyle(block) {
    const field = (name) => block.match(new RegExp(`\\n\\s*${name}:\\s*([^\\n]+?),?\\n`))?.[1];
    const id = block.match(/\bid:\s*"([^"]+)"/)?.[1];
    if (!id) return null;
    const preset = {
        id,
        name: block.match(/\bname:\s*"([^"]*)"/)[1],
        category: block.match(/categoryIds:\s*\[\s*\.(\w+)/)?.[1] || '',
        // TextStyle's init defaults: caseTransform .none, highlightType .static
        case: field('caseTransform')?.replace('.', '') || 'none',
        highlight: HIGHLIGHT[field('highlightType')?.replace('.', '') || 'static'],
    };
    const colors = block.match(/presetColors:\s*\[([^\n]*)\]/)?.[1] || '';
    for (const match of colors.matchAll(/\.(\w+):\s*UIColor\(red:\s*([\d.]+),\s*green:\s*([\d.]+),\s*blue:\s*([\d.]+),\s*alpha:\s*([\d.]+)\)/g)) {
        const [, role, red, green, blue, alpha] = match;
        if (!COLOR_KEYS[role]) continue;
        preset[COLOR_KEYS[role]] = Number(alpha) > 0 ? `#${byte(red)}${byte(green)}${byte(blue)}` : 'none';
    }
    const size = field('presetFontSize');
    if (size) preset.size = Math.round(Number(size));
    const pacing = field('presetPacing');
    if (pacing) preset.pacing = pacing.replace('.', '');
    const overflow = field('presetOverflowMode');
    if (overflow) preset.overflow = OVERFLOW[overflow.replace('.', '')];
    return preset;
}

const text = readFileSync(source, 'utf8');
const presets = text.split(/\bTextStyle\(\s*\n/).slice(1).map(parseStyle).filter(Boolean);
const out = fileURLToPath(new URL('./presets.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(presets, null, 1)}\n`);
console.log(`wrote ${presets.length} presets to ${out}`);
