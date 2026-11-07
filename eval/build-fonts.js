// Builds eval/fonts.txt, the `fonts` catalog the eval sends, as the app builds it
// (EditSnapshot.fontCatalog): "System", then the sorted set of the bundled fonts' names
// (FontRegistryService.registeredFontNames: every face of each bundled family) and every preset's
// fontName.
//
//   node eval/build-fonts.js <FontRegistryService.swift> <TextStyleDefinitions.swift> <names.txt>
//
// names.txt maps font files to names, one "file|postscript|full name|family" per line, from
// CoreText (CGFont.postScriptName, CTFontCopyFullName, CTFontCopyFamilyName) over
// Resources/Fonts. UIFont lists a family's faces by PostScript name, so those are used.

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

const families = new Set(registered.map((file) => byFile.get(file)?.family).filter(Boolean));
const faces = names.filter((entry) => families.has(entry.family)).map((entry) => entry.postscript);
const display = (name) => (name.startsWith('.System-') ? 'System' : name);
const out = ['System', ...[...new Set([...faces, ...presetFonts].map(display))].filter((name) => name !== 'System').sort()];

const path = fileURLToPath(new URL('./fonts.txt', import.meta.url));
writeFileSync(path, `${out.join('\n')}\n`);
console.log(`wrote ${out.length} fonts to ${path} (${registered.length} registered files, ${presetFonts.length} preset fonts)`);
