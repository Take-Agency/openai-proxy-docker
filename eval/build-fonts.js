// Builds eval/fonts.txt, the `fonts` catalog the eval sends: one display name per line, from the
// app's bundled fonts (FontRegistryService.fontFiles) plus the fonts the presets use, deduped.
//
//   node eval/build-fonts.js <FontRegistryService.swift> <TextStyleDefinitions.swift> <names.txt>
//
// names.txt maps font files to names, one "file|postscript|full name|family" per line, from
// CoreText (CGFont.postScriptName, CTFontCopyFullName, CTFontCopyFamilyName) over
// Resources/Fonts. Display name = the full name. A preset font is matched to a bundled file by
// PostScript, full or family name; one that isn't bundled (a system font) is listed as written.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [registry, definitions, namesFile] = process.argv.slice(2);
if (!namesFile) {
    console.error('usage: node eval/build-fonts.js <FontRegistryService.swift> <TextStyleDefinitions.swift> <names.txt>');
    process.exit(1);
}

const names = readFileSync(namesFile, 'utf8').trim().split('\n').map((line) => {
    const [file, postscript, full, family] = line.split('|');
    return { file, postscript, full, family };
});
const byFile = new Map(names.map((entry) => [entry.file, entry]));
const registered = [...readFileSync(registry, 'utf8').matchAll(/^\s*"([^"]+\.(?:ttf|otf))"/gm)].map((match) => match[1]);
const presetFonts = [...new Set([...readFileSync(definitions, 'utf8').matchAll(/fontName:\s*"([^"]+)"/g)].map((match) => match[1]))];

const out = [];
const add = (name) => {
    if (name && !out.includes(name)) out.push(name);
};
for (const file of registered) add(byFile.get(file)?.full);
for (const font of presetFonts) {
    const match = names.find((entry) => [entry.postscript, entry.full, entry.family].includes(font));
    add(match ? match.full : font);
}

const path = fileURLToPath(new URL('./fonts.txt', import.meta.url));
writeFileSync(path, `${out.join('\n')}\n`);
console.log(`wrote ${out.length} fonts to ${path} (${registered.length} registered files, ${presetFonts.length} preset fonts)`);
