// Reference applier for the eval: the 21 edit tools applied to a plain-JSON caption state, with
// the semantics of the app's EditValidator / EditApplier (shorts-caption,
// ShortsCaption/Service/InstructionEditing, branch instruction-edit/5-edit-validator).
// eval/applier.test.js runs the app's own golden cases (eval/fixtures/golden.json) through it.
//
// State:
//   { id, language, duration, focus, revision, repaced,
//     style: { preset, size, fill, emphasis, caption_bg, word_bg, position, case, highlight, pacing, overflow },
//     captions: [{ start, end, emphasis: [first, last] | null | 'auto', words: [{ text, start, end, src }] }] }
// `src` is the word's snapshot id while the word is untouched (replaced or retyped words have
// none), so scoring can tell kept words from rewritten ones. Emphasis is a word range rather
// than the app's character range; 'auto' marks a line retyped with set_caption_text, which the
// app re-emphasizes automatically.
//
// set_style's position_y / outline / shadow / font and insert_caption are the server's newer
// tools (PR #15); the iOS side mirrors them. Style keys y, outline, shadow, font and
// caps_only_font are only in states whose fixture has them.
//
// Not modelled: re-pacing. A preset that changes pacing, or set_pacing, rebuilds every line in
// the app (createCombinedSegments needs text measurement); here it sets `repaced` and keeps the
// lines, and scoring doesn't compare lines of a repaced state. set_caption_text re-tokenizes on
// whitespace (the app uses NLTokenizer) and times words by character position, as setText does.

export const FONT_SIZES = [40, 120];
export const MAX_OPERATIONS = 50;
export const MAX_REPLACEMENTS = 200;
export const MAX_SHIFT_MS = 5000;
export const MAX_INSERTS = 5;
// TextPlacement's presets as normalizedTextY (snapshot "y"); anything else is "custom"
export const POSITIONS = { bottom: 0.2, center: 0.5, top: 0.9 };
const Y_RANGE = [0.05, 0.95];
const DEFAULT_OUTLINE = { color: '#000000', width: 4 };
const MAX_OUTLINE_WIDTH = 50;
// insert_caption timing (v2, from the app's staging re-check): see step 6b in apply()
const INSERT_GAP_S = 1;
const INSERT_MAX_S = 2;
const INSERT_SHORT_S = 1;
const INSERT_KEEP_S = 0.3;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Swift String.count counts grapheme clusters; Devanagari needs this to match.
const length = (text) => [...segmenter.segment(text)].length;
const round = (value) => Math.round(value * 1e6) / 1e6;

// ---------------------------------------------------------------- state

export function loadFixture(fixture) {
    return {
        id: fixture.id,
        language: fixture.language || 'en',
        duration: fixture.duration,
        focus: fixture.focus == null ? null : Number(String(fixture.focus).replace(/^c/, '')),
        revision: fixture.revision,
        repaced: false,
        style: { ...fixture.style },
        captions: fixture.captions.map((caption, c) => ({
            start: caption.start ?? caption.words[0][1],
            end: caption.end ?? caption.words.at(-1)[2],
            emphasis: caption.emphasis ? [...caption.emphasis] : null,
            words: caption.words.map(([text, start, end], w) => ({ text, start, end, src: `c${c}.${w}` })),
        })),
        // which boxes the style can draw at all (a box color does nothing without one); the
        // golden fixture's Mosy has a box behind the spoken word and none behind captions
        boxes: { word: fixture.boxes?.word ?? true, caption: fixture.boxes?.caption ?? false },
    };
}

const clone = (value) => structuredClone(value);
export const captionText = (caption) => caption.words.map((word) => word.text).join(' ');

const seconds = (value) => value.toFixed(2);

// The snapshot as EditSnapshot.text renders it (§4.2).
export function snapshotText(state) {
    let header = `rev ${state.revision} · duration ${seconds(state.duration)}s`;
    if (state.focus != null) header += ` · focus c${state.focus}`;
    const lines = state.captions.map((caption, c) => {
        const [first, last] = Array.isArray(caption.emphasis) ? caption.emphasis : [-1, -2];
        const words = caption.words.map((word, w) => `${w} ${w >= first && w <= last ? `[${word.text}]` : word.text}`).join(' ');
        return `c${c} ${seconds(caption.start)}-${seconds(caption.end)} | ${words}`;
    });
    const style = Object.fromEntries(Object.keys(state.style).sort().map((key) => [key, state.style[key]]));
    return [header, ...lines, `looks ${looksText(state.style, state.boxes)}`, `style ${JSON.stringify(style)}`].join('\n');
}

// StyleChangeRow.colorName in English: a hue name from hue and lightness ("dark purple")
export function colorName(hex) {
    if (!hex || hex === 'none') return 'none';
    const value = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    const lightness = (high + low) / 2;
    const delta = high - low;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    if (saturation < 0.18 || delta < 0.08) return lightness > 0.88 ? 'white' : lightness < 0.13 ? 'black' : 'gray';
    let hue;
    if (high === r) hue = 60 * (((g - b) / delta) % 6);
    else if (high === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
    const name = hue < 15 ? 'red' : hue < 40 ? 'orange' : hue < 65 ? 'yellow' : hue < 170 ? 'green' : hue < 200 ? 'cyan'
        : hue < 255 ? 'blue' : hue < 290 ? 'purple' : hue < 335 ? 'pink' : 'red';
    // a light red is pink
    if (name === 'red' && lightness > 0.7) return 'pink';
    return lightness < 0.3 ? `dark ${name}` : lightness > 0.78 ? `light ${name}` : name;
}

// EditSnapshot.looks: what the user sees, part by part, with the field that sets each
export function looksText(style, boxes = { word: true, caption: false }) {
    const parts = [`text: ${colorName(style.fill)} letters (fill)`];
    if (boxes.word && style.word_bg !== 'none') parts.push(`word being spoken: ${colorName(style.word_bg)} box behind it (word_bg)`);
    else if (boxes.word) parts.push('no box behind words yet (word_bg adds one)');
    else parts.push('no box behind words (word_bg does nothing in this style)');
    if (style.highlight === 'spoken_word') parts.push(`word being spoken: ${colorName(style.emphasis)} letters (emphasis)`);
    else if (style.highlight === 'static') parts.push(`[bracketed] words: ${colorName(style.emphasis)} letters (emphasis)`);
    else parts.push('no colored words (emphasis does nothing while highlight is none)');
    if (boxes.caption && style.caption_bg !== 'none') parts.push(`${colorName(style.caption_bg)} box behind each caption (caption_bg)`);
    else if (boxes.caption) parts.push('no box behind captions yet (caption_bg adds one)');
    else parts.push('no box behind captions (caption_bg does nothing in this style)');
    return parts.join('; ');
}

// What the app sends as `presets` (InstructionEditService.presetCatalog).
export const presetCatalog = (presets) => presets.map((preset) => `${preset.id}|${preset.name}|${preset.category}`).join('\n');

// ---------------------------------------------------------------- decoding

export const SCHEMAS = {
    set_style: {
        fill_color: 'string?', emphasis_color: 'string?', caption_background_color: 'string?', word_background_color: 'string?',
        font_size: 'int?', position: ['bottom', 'center', 'top', null], case: ['none', 'uppercase', 'capitalized', null],
        highlight: ['none', 'static', 'spoken_word', null], overflow: ['none', 'resize_to_fit', 'wrap', null],
        position_y: 'number?', outline_color: 'string?', outline_width: 'number?', shadow: ['none', 'soft', 'strong', null], font: 'string?',
    },
    apply_preset: { preset_id: 'string' },
    set_pacing: { pacing: ['fast', 'standard', 'relaxed'] },
    replace_words: { from: 'string', to: 'string', expect: 'string', text: 'string' },
    delete_words: { words: 'refs' },
    find_replace: { find: 'string', replace: 'string', whole_word: 'bool', match_case: 'bool' },
    set_caption_text: { caption: 'string', expect: 'string', text: 'string' },
    split_caption: { caption: 'string', before: 'string' },
    merge_captions: { first: 'string', second: 'string' },
    delete_captions: { captions: 'refs' },
    insert_caption: { after: 'string?', text: 'string' },
    shift_timing: { from: 'string?', to: 'string?', offset_ms: 'int' },
    set_caption_timing: { caption: 'string', start_s: 'number?', end_s: 'number?' },
    set_emphasis: { caption: 'string', from: 'string?', to: 'string?' },
    ask_clarification: { question: 'string', options: 'strings' },
    // bulk tools: the model names what to change, the app finds every target
    split_in_half: { captions: 'ids?' },
    change_letters: { captions: 'ids?', mode: ['lowercase', 'capitalize_first_word'] },
    merge_short_captions: { max_words: 'int' },
    delete_all: { word: 'string', occurrences: 'refs?' },
    rewrite_sentence: { first: 'string', last: 'string', expect: 'string', text: 'string' },
    cannot_do: { reason: ['per_word_style', 'translate', 'cut_audio', 'emoji', 'horizontal_position', 'retranscribe', 'other'], message: 'string' },
};
export const TOOL_NAMES = Object.keys(SCHEMAS);

function typeOk(type, value) {
    if (Array.isArray(type)) return type.includes(value);
    const optional = type.endsWith('?');
    if (value === null || value === undefined) return optional;
    switch (type.replace('?', '')) {
    case 'string': return typeof value === 'string';
    case 'int': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'bool': return typeof value === 'boolean';
    case 'strings':
    case 'ids': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'refs': return Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.expect === 'string');
    default: return false;
    }
}

// Like EditTool.init: returns { name, args } or throws { message }.
function decode(call) {
    const schema = SCHEMAS[call.name];
    if (!schema) throw new Error(`unknown tool "${call.name}"`);
    let args = call.arguments;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            throw new Error(`${call.name}: arguments aren't valid JSON`);
        }
    }
    if (!args || typeof args !== 'object') throw new Error(`${call.name}: arguments aren't valid JSON`);
    for (const [key, type] of Object.entries(schema)) {
        const optional = Array.isArray(type) ? type.includes(null) : type.endsWith('?');
        if (!(key in args) && !optional) throw new Error(`${call.name}: missing field ${key}`);
        if (!typeOk(type, args[key] ?? null)) throw new Error(`${call.name}: field ${key} has the wrong type`);
    }
    return { name: call.name, args };
}

// ---------------------------------------------------------------- validation

// Case-, punctuation- and whitespace-insensitive (EditValidator.normalized).
export const normalized = (text) => text.toLowerCase().replace(/[\p{P}\s]/gu, '');

const trimPunctuation = (text) => text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isHex = (value) => /^#[0-9A-Fa-f]{6}$/.test(value);

function captionIndex(state, id) {
    const match = /^c(\d+)$/.exec(id ?? '');
    const index = match ? Number(match[1]) : -1;
    return index >= 0 && index < state.captions.length ? index : null;
}

function wordIndex(state, id) {
    const parts = String(id ?? '').split('.');
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return null;
    const caption = captionIndex(state, parts[0]);
    const word = Number(parts[1]);
    if (caption == null || word >= state.captions[caption].words.length) return null;
    return { caption, word };
}

const spanText = (caption, from, to) => caption.words.slice(from, to + 1).map((word) => word.text).join(' ');

// Constants.Behavior.languagesWithoutWordSpaces
export const NO_SPACE_LANGUAGES = new Set(['zh', 'ja', 'th', 'km', 'lo', 'my', 'jw', 'bo']);
const hasWordSpaces = (state) => !NO_SPACE_LANGUAGES.has(state.language);
const pieces = (text) => text.trim().split(/\s+/).filter(Boolean);
export const MAX_REWRITE_CAPTIONS = 6;
export const MAX_SHORT_WORDS = 5;
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u;

// replace_words whose ids are off: the one span of the same caption whose text is `expect`.
function snapSpan(state, caption, expect) {
    const size = pieces(expect).length;
    const target = normalized(expect);
    if (!hasWordSpaces(state) || !size || !target) return null;
    const found = [];
    for (let from = 0; from + size <= caption.words.length; from += 1) {
        if (normalized(spanText(caption, from, from + size - 1)) === target) found.push(from);
    }
    return found.length === 1 ? { from: found[0], to: found[0] + size - 1 } : null;
}

// delete_words with an id that's off: the word of the same caption that is `expect`, nearest the id.
function snapWord(caption, word, expect) {
    const target = normalized(expect);
    if (!target) return null;
    const found = caption.words.map((entry, index) => index).filter((index) => normalized(caption.words[index].text) === target);
    if (!found.length) return null;
    const distance = (index) => Math.abs(index - word);
    const nearest = Math.min(...found.map(distance));
    const closest = found.filter((index) => distance(index) === nearest);
    return closest.length === 1 ? closest[0] : null;
}

// A replacement that only drops words ("every single" -> "every"): the dropped words' offsets,
// so they're deleted and the kept words keep their timing. null for any other replacement.
function droppedWords(words, text) {
    const kept = pieces(text);
    if (!kept.length || kept.length >= words.length) return null;
    const keep = new Set();
    let next = 0;
    words.forEach((word, index) => {
        if (next < kept.length && word.text === kept[next]) {
            keep.add(index);
            next += 1;
        }
    });
    return next === kept.length ? words.map((_, index) => index).filter((index) => !keep.has(index)) : null;
}

// "Number 1:" replaced with "Number one" by an expect without the colon: the colon stays.
const TRAILING_PUNCTUATION = /[\p{P}]+$/u;
function keepTrailingPunctuation(actual, expect, text) {
    const mark = actual.match(TRAILING_PUNCTUATION)?.[0];
    // an edit that only changes punctuation ("views." -> "views") means it
    if (normalized(text) === normalized(actual)) return text;
    if (!mark || TRAILING_PUNCTUATION.test(expect.trim()) || TRAILING_PUNCTUATION.test(text.trim())) return text;
    return `${text.trim()}${mark}`;
}

const capitalizeFirstLetter = (text) => text.replace(/\p{L}/u, (letter) => letter.toUpperCase());

// rewrite_sentence: the new text's words (characters without word spaces) spread over the
// captions in proportion to how many each held, so each line keeps its own time.
export function distribute(text, counts, spaced = true) {
    const units = spaced ? pieces(text) : [...segmenter.segment(text.trim())].map((segment) => segment.segment);
    const total = Math.max(counts.reduce((sum, count) => sum + count, 0), 1);
    const bounds = [0];
    let cumulative = 0;
    counts.forEach((count, index) => {
        cumulative += count;
        bounds.push(index === counts.length - 1 ? units.length : Math.max(Math.round(units.length * cumulative / total), bounds.at(-1)));
    });
    return counts.map((_, index) => units.slice(bounds[index], bounds[index + 1]).join(spaced ? ' ' : ''));
}

// find_replace as the app runs it: each match is a run of whole words (shortest first), and its
// replacement keeps the punctuation around the matched text.
function findMatches(state, find, replace, wholeWord, matchCase) {
    const needle = find.trim();
    const flags = matchCase ? 'g' : 'gi';
    const maxRun = Math.max(needle.split(/\s+/).filter(Boolean).length, 1);
    const matches = [];
    state.captions.forEach((caption, c) => {
        let start = 0;
        while (start < caption.words.length) {
            let matchedEnd = null;
            for (let end = start; end < Math.min(start + maxRun, caption.words.length); end += 1) {
                const run = spanText(caption, start, end);
                const isMatch = wholeWord
                    ? (matchCase ? trimPunctuation(run) === needle : trimPunctuation(run).toLowerCase() === needle.toLowerCase())
                    : new RegExp(escape(needle), matchCase ? '' : 'i').test(run);
                if (isMatch) {
                    matchedEnd = end;
                    matches.push({ caption: c, from: start, to: end, text: run.replace(new RegExp(escape(needle), flags), () => replace) });
                    break;
                }
            }
            start = (matchedEnd ?? start) + 1;
        }
    });
    return matches;
}

const CONFLICTS = [
    ['delete_captions', '*'],
    ['split_caption', 'merge_captions'],
    ['split_caption', 'replace_words'], ['split_caption', 'delete_words'], ['split_caption', 'find_replace'], ['split_caption', 'set_caption_text'],
    ['set_emphasis', 'replace_words'], ['set_emphasis', 'delete_words'], ['set_emphasis', 'find_replace'], ['set_emphasis', 'set_caption_text'],
    ['set_caption_timing', 'split_caption'], ['set_caption_timing', 'merge_captions'],
    // insert_caption may retime `after` (splitting its time), so nothing else may retime or restructure it
    ['insert_caption', 'split_caption'], ['insert_caption', 'merge_captions'], ['insert_caption', 'set_caption_timing'],
];

// Bulk tools resolve into the primitives above and conflict as them.
const CATEGORY = {
    split_in_half: 'split_caption', change_letters: 'replace_words', merge_short_captions: 'merge_captions',
    delete_all: 'delete_words', rewrite_sentence: 'set_caption_text',
};

// Returns { errors: [] , edit } like EditValidator.validate. `presets` is the catalog array.
// `fonts` is the font catalog (array of names); without it set_style font is rejected.
export function validate(calls, state, presets, fonts = []) {
    if (!calls.length) return { errors: ['no tool calls'] };
    if (calls.length > MAX_OPERATIONS) return { errors: [`${calls.length} edits in one batch; the limit is ${MAX_OPERATIONS}`] };

    const errors = [];
    const tools = [];
    for (const call of calls) {
        try {
            tools.push(decode(call));
        } catch (error) {
            errors.push(error.message);
        }
    }
    if (errors.length) return { errors };

    const edit = {
        preset: null, styles: [], wordEdits: new Map(), emphasis: new Map(), splits: new Map(), merges: [],
        deletions: new Set(), inserts: [], shifts: [], timings: [], pacing: null, clarification: null, cannotDo: [],
    };
    const wordOwners = new Map();
    const notFound = [];
    let findReplaceMatched = false;
    const captionUses = new Map();
    const merged = new Set();
    const use = (caption, name) => captionUses.set(caption, [...(captionUses.get(caption) || []), CATEGORY[name] || name]);
    const touch = (caption, word, name) => {
        const key = `c${caption}.${word}`;
        if (wordOwners.has(key)) errors.push(`${name}: word ${key} is already edited by ${wordOwners.get(key)}; edit each word once`);
        wordOwners.set(key, name);
        use(caption, name);
    };
    const checkExpect = (expect, actual, id, name) => {
        if (normalized(expect) !== normalized(actual)) errors.push(`${name}: ${id} is "${actual}", not "${expect}"`);
    };
    const addWordEdit = (caption, wordEdit) => edit.wordEdits.set(caption, [...(edit.wordEdits.get(caption) || []), wordEdit]);

    if (tools.length > 1 && tools.some((tool) => tool.name === 'ask_clarification')) {
        errors.push("ask_clarification can't be combined with other tools");
    }

    for (const { name, args } of tools) {
        switch (name) {
        case 'set_style': {
            const fields = Object.keys(SCHEMAS.set_style);
            if (fields.every((key) => args[key] == null)) errors.push('set_style: set at least one field');
            for (const color of [args.fill_color, args.emphasis_color].filter((value) => value != null)) {
                if (!isHex(color)) errors.push(`set_style: "${color}" isn't a #RRGGBB color`);
            }
            for (const color of [args.caption_background_color, args.word_background_color].filter((value) => value != null)) {
                if (color !== 'none' && !isHex(color)) errors.push(`set_style: "${color}" isn't a #RRGGBB color or "none"`);
            }
            if (args.font_size != null && (args.font_size < FONT_SIZES[0] || args.font_size > FONT_SIZES[1])) {
                errors.push(`set_style: font_size ${args.font_size} is out of range ${FONT_SIZES[0]}–${FONT_SIZES[1]}`);
            }
            if (args.outline_color != null && args.outline_color !== 'none' && !isHex(args.outline_color)) {
                errors.push(`set_style: "${args.outline_color}" isn't a #RRGGBB color or "none"`);
            }
            if (args.position_y != null && (args.position_y < Y_RANGE[0] || args.position_y > Y_RANGE[1])) {
                errors.push(`set_style: position_y ${args.position_y} is out of range ${Y_RANGE[0]}–${Y_RANGE[1]}`);
            }
            if (args.position != null && args.position_y != null) errors.push('set_style: set position or position_y, not both');
            if (args.outline_width != null && args.outline_width < 0) errors.push('set_style: outline_width must be 0 or more');
            if (args.font != null && !fonts.includes(args.font)) errors.push(`set_style: font "${args.font}" isn't in the fonts list`);
            edit.styles.push(args);
            break;
        }
        case 'apply_preset': {
            if (edit.preset) errors.push('apply_preset: only one preset per batch');
            const preset = presets.find((entry) => entry.id === args.preset_id);
            if (preset) edit.preset = preset;
            else errors.push(`apply_preset: no preset with id "${args.preset_id}"`);
            break;
        }
        case 'set_pacing':
            if (edit.pacing) errors.push('set_pacing: only one pacing per batch');
            edit.pacing = args.pacing;
            break;
        case 'replace_words': {
            let start = wordIndex(state, args.from);
            let end = wordIndex(state, args.to);
            if (!start || !end) {
                errors.push(`${name}: no word ${start ? args.to : args.from}`);
                break;
            }
            if (start.caption !== end.caption || start.word > end.word) {
                errors.push(`${name}: ${args.from}…${args.to} must be one caption, first word first`);
                break;
            }
            const caption = state.captions[start.caption];
            if (normalized(args.expect) !== normalized(spanText(caption, start.word, end.word))) {
                const snapped = snapSpan(state, caption, args.expect);
                if (snapped) {
                    start = { caption: start.caption, word: snapped.from };
                    end = { caption: start.caption, word: snapped.to };
                }
            }
            // no change: dropped, not an error (EditValidator)
            if (args.text.trim() === spanText(caption, start.word, end.word)) break;
            checkExpect(args.expect, spanText(caption, start.word, end.word), `${args.from}…${args.to}`, name);
            if (!args.text.trim()) errors.push(`${name}: text is empty; use delete_words to remove words`);
            const text = keepTrailingPunctuation(spanText(caption, start.word, end.word), args.expect, args.text);
            const dropped = hasWordSpaces(state) ? droppedWords(caption.words.slice(start.word, end.word + 1), text) : null;
            if (dropped) {
                for (const offset of dropped) {
                    touch(start.caption, start.word + offset, name);
                    addWordEdit(start.caption, { type: 'delete', word: start.word + offset });
                }
                break;
            }
            for (let word = start.word; word <= end.word; word += 1) touch(start.caption, word, name);
            addWordEdit(start.caption, { type: 'replace', from: start.word, to: end.word, text });
            break;
        }
        case 'delete_words':
            if (!args.words.length) errors.push(`${name}: no words given`);
            for (const ref of args.words) {
                const index = wordIndex(state, ref.id);
                if (!index) {
                    errors.push(`${name}: no word ${ref.id}`);
                    continue;
                }
                const caption = state.captions[index.caption];
                if (normalized(ref.expect) !== normalized(caption.words[index.word].text)) {
                    const snapped = snapWord(caption, index.word, ref.expect);
                    if (snapped != null) index.word = snapped;
                }
                checkExpect(ref.expect, caption.words[index.word].text, ref.id, name);
                touch(index.caption, index.word, name);
                addWordEdit(index.caption, { type: 'delete', word: index.word });
            }
            break;
        case 'find_replace': {
            if (!args.find.trim()) {
                errors.push(`${name}: find is empty`);
                break;
            }
            const matches = findMatches(state, args.find, args.replace, args.whole_word, args.match_case);
            // one term of several missing (";" in "remove all the punctuation") isn't an error
            if (!matches.length) notFound.push(`${name}: "${args.find}" not found`);
            else findReplaceMatched = true;
            if (matches.length > MAX_REPLACEMENTS) errors.push(`${name}: ${matches.length} matches; the limit is ${MAX_REPLACEMENTS}`);
            for (const match of matches) {
                for (let word = match.from; word <= match.to; word += 1) touch(match.caption, word, name);
                addWordEdit(match.caption, { type: 'replace', from: match.from, to: match.to, text: match.text });
            }
            break;
        }
        case 'set_caption_text': {
            const index = captionIndex(state, args.caption);
            if (index == null) {
                errors.push(`${name}: no caption ${args.caption}`);
                break;
            }
            const caption = state.captions[index];
            if (args.text.trim() === captionText(caption).trim()) break;
            checkExpect(args.expect, captionText(caption), args.caption, name);
            if (!args.text.trim()) errors.push(`${name}: text is empty; use delete_captions to remove a caption`);
            caption.words.forEach((_, word) => touch(index, word, name));
            use(index, name);
            addWordEdit(index, { type: 'setText', text: args.text });
            break;
        }
        case 'split_caption': {
            const index = captionIndex(state, args.caption);
            if (index == null) {
                errors.push(`${name}: no caption ${args.caption}`);
                break;
            }
            const word = wordIndex(state, args.before);
            if (!word || word.caption !== index) {
                errors.push(`${name}: ${args.before} isn't a word in ${args.caption}`);
                break;
            }
            if (word.word === 0) {
                errors.push(`${name}: can't split before the first word of ${args.caption}`);
                break;
            }
            if (edit.splits.get(index)?.includes(word.word)) errors.push(`${name}: ${args.caption} is already split before ${args.before}`);
            use(index, name);
            edit.splits.set(index, [...(edit.splits.get(index) || []), word.word]);
            break;
        }
        case 'merge_captions': {
            const first = captionIndex(state, args.first);
            const second = captionIndex(state, args.second);
            if (first == null || second == null) {
                errors.push(`${name}: no caption ${first == null ? args.first : args.second}`);
                break;
            }
            if (first === second) {
                errors.push(`${name}: first and second are both ${args.first}; merge a caption with the one right after it`);
                break;
            }
            if (second !== first + 1) {
                errors.push(`${name}: ${args.first} and ${args.second} aren't adjacent and in order`);
                break;
            }
            for (const index of [first, second]) {
                if (merged.has(index)) errors.push(`${name}: c${index} is in two merges; merge each caption once`);
                merged.add(index);
                use(index, name);
            }
            edit.merges.push([first, second]);
            break;
        }
        case 'delete_captions':
            if (!args.captions.length) errors.push(`${name}: no captions given`);
            for (const ref of args.captions) {
                const index = captionIndex(state, ref.id);
                if (index == null) {
                    errors.push(`${name}: no caption ${ref.id}`);
                    continue;
                }
                checkExpect(ref.expect, captionText(state.captions[index]), ref.id, name);
                use(index, name);
                edit.deletions.add(index);
            }
            break;
        case 'insert_caption': {
            const index = args.after == null ? -1 : captionIndex(state, args.after);
            if (index == null) {
                errors.push(`${name}: no caption ${args.after}`);
                break;
            }
            if (!args.text.trim()) errors.push(`${name}: text is empty`);
            if (edit.inserts.length === MAX_INSERTS) errors.push(`${name}: at most ${MAX_INSERTS} new captions per batch`);
            if (index >= 0) use(index, name);
            edit.inserts.push({ after: index, text: args.text.trim() });
            break;
        }
        case 'shift_timing': {
            if (Math.abs(args.offset_ms) > MAX_SHIFT_MS || args.offset_ms === 0) {
                errors.push(`${name}: offset_ms ${args.offset_ms} must be non-zero and within ±${MAX_SHIFT_MS}`);
                break;
            }
            const lower = args.from == null ? 0 : captionIndex(state, args.from);
            const upper = args.to == null ? state.captions.length - 1 : captionIndex(state, args.to);
            if (lower == null || upper == null || lower > upper) {
                errors.push(`${name}: from ${args.from ?? 'null'} to ${args.to ?? 'null'} isn't a range of captions`);
                break;
            }
            edit.shifts.push({ from: lower, to: upper, offset: args.offset_ms / 1000 });
            break;
        }
        case 'set_caption_timing': {
            const index = captionIndex(state, args.caption);
            if (index == null) {
                errors.push(`${name}: no caption ${args.caption}`);
                break;
            }
            if (args.start_s == null && args.end_s == null) errors.push(`${name}: set start_s, end_s or both`);
            for (const value of [args.start_s, args.end_s].filter((entry) => entry != null)) {
                if (value < 0 || value > state.duration) errors.push(`${name}: ${value}s is outside the video (0–${state.duration}s)`);
            }
            if (args.start_s != null && args.end_s != null && args.start_s >= args.end_s) errors.push(`${name}: start_s must be before end_s`);
            const current = state.captions[index];
            if (Math.abs((args.start_s ?? current.start) - current.start) < 0.005 && Math.abs((args.end_s ?? current.end) - current.end) < 0.005) break;
            if (edit.timings.some((timing) => timing.caption === index)) errors.push(`${name}: ${args.caption} is retimed twice`);
            use(index, name);
            edit.timings.push({ caption: index, start: args.start_s, end: args.end_s });
            break;
        }
        case 'set_emphasis': {
            const index = captionIndex(state, args.caption);
            if (index == null) {
                errors.push(`${name}: no caption ${args.caption}`);
                break;
            }
            if (edit.emphasis.has(index)) errors.push(`${name}: ${args.caption} has one emphasized range; set it once`);
            // already emphasized like that (or already clear): dropped
            const currentEmphasis = Array.isArray(state.captions[index].emphasis) ? state.captions[index].emphasis : null;
            if (args.from == null && args.to == null && !currentEmphasis) break;
            const fromWord = wordIndex(state, args.from);
            const toWord = wordIndex(state, args.to);
            if (fromWord && toWord && fromWord.caption === index && toWord.caption === index && currentEmphasis
                && currentEmphasis[0] === fromWord.word && currentEmphasis[1] === Math.max(fromWord.word, toWord.word)) break;
            use(index, name);
            if (args.from == null && args.to == null) {
                edit.emphasis.set(index, null);
            } else if (args.from != null && args.to != null) {
                const from = wordIndex(state, args.from);
                const to = wordIndex(state, args.to);
                if (!from || !to || from.caption !== index || to.caption !== index || from.word > to.word) {
                    errors.push(`${name}: ${args.from}…${args.to} isn't a range of words in ${args.caption}`);
                    break;
                }
                edit.emphasis.set(index, [from.word, to.word]);
            } else {
                errors.push(`${name}: set both from and to, or neither to clear`);
            }
            break;
        }
        case 'split_in_half': {
            if (args.captions && !args.captions.length) errors.push(`${name}: no captions given`);
            const ids = args.captions ?? state.captions.map((_, index) => `c${index}`);
            for (const id of ids) {
                const index = captionIndex(state, id);
                if (index == null) {
                    errors.push(`${name}: no caption ${id}`);
                    continue;
                }
                const count = state.captions[index].words.length;
                if (count < 2) {
                    if (args.captions) errors.push(`${name}: ${id} has one word`);
                    continue;
                }
                const middle = Math.floor((count + 1) / 2);
                if (edit.splits.get(index)?.includes(middle)) errors.push(`${name}: ${id} is already split there`);
                use(index, name);
                edit.splits.set(index, [...(edit.splits.get(index) || []), middle]);
            }
            break;
        }
        case 'change_letters': {
            if (args.captions && !args.captions.length) errors.push(`${name}: no captions given`);
            const ids = args.captions ?? state.captions.map((_, index) => `c${index}`);
            for (const id of ids) {
                const index = captionIndex(state, id);
                if (index == null) {
                    errors.push(`${name}: no caption ${id}`);
                    continue;
                }
                const words = state.captions[index].words;
                const targets = args.mode === 'lowercase' ? words.map((_, word) => word) : (words.length ? [0] : []);
                for (const word of targets) {
                    const text = words[word].text;
                    const changed = args.mode === 'lowercase' ? text.toLowerCase() : capitalizeFirstLetter(text);
                    if (changed === text) continue;
                    touch(index, word, name);
                    addWordEdit(index, { type: 'replace', from: word, to: word, text: changed });
                }
            }
            break;
        }
        case 'merge_short_captions': {
            if (args.max_words < 1 || args.max_words > MAX_SHORT_WORDS) {
                errors.push(`${name}: max_words must be 1–${MAX_SHORT_WORDS}`);
                break;
            }
            const count = state.captions.length;
            const free = (index) => index >= 0 && index < count && !merged.has(index);
            const endsSentence = (index) => SENTENCE_END.test(state.captions[index].words.at(-1)?.text ?? '');
            for (let index = 0; index < count; index += 1) {
                if (merged.has(index) || state.captions[index].words.length > args.max_words) continue;
                // the line before, unless it ends a sentence; else the line after
                let pair = null;
                if (free(index - 1) && !endsSentence(index - 1)) pair = [index - 1, index];
                else if (free(index + 1)) pair = [index, index + 1];
                else if (free(index - 1)) pair = [index - 1, index];
                if (!pair) continue;
                for (const caption of pair) {
                    merged.add(caption);
                    use(caption, name);
                }
                edit.merges.push(pair);
            }
            break;
        }
        case 'delete_all': {
            const target = normalized(args.word);
            if (!target || pieces(args.word).length !== 1) {
                errors.push(`${name}: word must be one word`);
                break;
            }
            const isTarget = (caption, word) => normalized(state.captions[caption].words[word].text) === target;
            const targets = [];
            if (args.occurrences == null) {
                state.captions.forEach((caption, c) => caption.words.forEach((_, w) => {
                    if (isTarget(c, w)) targets.push([c, w]);
                }));
                if (!targets.length) errors.push(`${name}: "${args.word}" not found`);
            } else {
                // only that word can go: an id one word off moves to the nearest occurrence in its
                // caption, any other id is dropped
                for (const ref of args.occurrences) {
                    const index = wordIndex(state, ref.id);
                    if (!index) continue;
                    const word = isTarget(index.caption, index.word) ? index.word : snapWord(state.captions[index.caption], index.word, args.word);
                    if (word != null && !targets.some(([c, w]) => c === index.caption && w === word)) targets.push([index.caption, word]);
                }
            }
            if (targets.length > MAX_REPLACEMENTS) errors.push(`${name}: ${targets.length} matches; the limit is ${MAX_REPLACEMENTS}`);
            for (const [caption, word] of targets) {
                touch(caption, word, name);
                addWordEdit(caption, { type: 'delete', word });
            }
            break;
        }
        case 'rewrite_sentence': {
            const first = captionIndex(state, args.first);
            const last = captionIndex(state, args.last);
            if (first == null || last == null) {
                errors.push(`${name}: no caption ${first == null ? args.first : args.last}`);
                break;
            }
            if (last < first || last - first + 1 > MAX_REWRITE_CAPTIONS) {
                errors.push(`${name}: ${args.first}…${args.last} must be 1–${MAX_REWRITE_CAPTIONS} captions in order`);
                break;
            }
            const indexes = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
            const spaced = hasWordSpaces(state);
            const current = indexes.map((index) => captionText(state.captions[index])).join(spaced ? ' ' : '');
            if (args.text.trim() === current.trim()) break;
            checkExpect(args.expect, current, `${args.first}…${args.last}`, name);
            if (!args.text.trim()) {
                errors.push(`${name}: text is empty; use delete_captions to remove captions`);
                break;
            }
            const counts = indexes.map((index) => (spaced ? state.captions[index].words.length : length(captionText(state.captions[index]))));
            const texts = distribute(args.text, counts, spaced);
            indexes.forEach((index, offset) => {
                const caption = state.captions[index];
                caption.words.forEach((_, word) => touch(index, word, name));
                if (!texts[offset]) {
                    edit.deletions.add(index);
                } else if (texts[offset] !== captionText(caption)) {
                    addWordEdit(index, { type: 'setText', text: texts[offset] });
                }
            });
            break;
        }
        case 'ask_clarification':
            if (!args.question.trim()) errors.push(`${name}: question is empty`);
            // the app adds its own "Keep as is", so one option (a font, say) is enough
            if (args.options.length < 1 || args.options.length > 3) errors.push(`${name}: give 1 to 3 options`);
            edit.clarification = { question: args.question, options: args.options };
            break;
        case 'cannot_do':
            if (!args.message.trim()) errors.push(`${name}: message is empty`);
            edit.cannotDo.push({ reason: args.reason, message: args.message });
            break;
        default:
            break;
        }
    }

    if (!findReplaceMatched) errors.push(...notFound);

    // lowercase letters only show once the style stops forcing capitals
    const lowercases = tools.some((tool) => tool.name === 'change_letters' && tool.args.mode === 'lowercase');
    if (lowercases && state.style.case && state.style.case !== 'none' && !edit.styles.some((style) => style.case != null)) {
        edit.styles.push({ case: 'none' });
    }

    // a caption can't be edited by two tools that would make each other's ids stale
    for (const [index, uses] of [...captionUses].sort((a, b) => a[0] - b[0])) {
        const names = new Set(uses);
        for (const [a, b] of CONFLICTS) {
            if (!names.has(a)) continue;
            const others = b === '*' ? [...names].filter((other) => other !== a) : (names.has(b) ? [b] : []);
            const other = others.sort()[0];
            if (other) errors.push(`c${index} is changed by both ${a} and ${other}; do one or the other`);
        }
    }

    return errors.length ? { errors } : { errors: [], edit };
}

// ---------------------------------------------------------------- caption operations

function replaceTokens(caption, from, to, text) {
    const pieces = text.split(/\s+/).filter(Boolean);
    const spanStart = caption.words[from].start;
    const spanEnd = caption.words[to].end;
    const total = Math.max(pieces.reduce((sum, piece) => sum + length(piece), 0), 1);
    let elapsed = 0;
    const words = pieces.map((piece, index) => {
        const start = spanStart + (spanEnd - spanStart) * (elapsed / total);
        elapsed += length(piece);
        const end = index === pieces.length - 1 ? spanEnd : spanStart + (spanEnd - spanStart) * (elapsed / total);
        return { text: piece, start: round(start), end: round(end), src: null };
    });
    if (Array.isArray(caption.emphasis)) {
        const [first, last] = caption.emphasis;
        if (last < from) {
            // before the span: unchanged
        } else if (first > to) {
            const delta = words.length - (to - from + 1);
            caption.emphasis = [first + delta, last + delta];
        } else {
            caption.emphasis = null;
        }
    }
    caption.words.splice(from, to - from + 1, ...words);
}

function removeTokens(caption, indexes) {
    if (Array.isArray(caption.emphasis)) {
        const [first, last] = caption.emphasis;
        if ([...indexes].some((index) => index >= first && index <= last)) {
            caption.emphasis = null;
        } else {
            const before = [...indexes].filter((index) => index < first).length;
            caption.emphasis = [first - before, last - before];
        }
    }
    caption.words = caption.words.filter((_, index) => !indexes.has(index));
}

// Caption.setText: new words timed by character position across the line.
function setText(caption, text) {
    if (text === captionText(caption)) return;
    const total = length(text);
    const duration = caption.end - caption.start;
    let searchFrom = 0;
    const chars = [...segmenter.segment(text)].map((segment) => segment.segment);
    caption.words = text.split(/\s+/).filter(Boolean).map((piece) => {
        const pieceChars = length(piece);
        let location = searchFrom;
        while (location < chars.length && chars.slice(location, location + pieceChars).join('') !== piece) location += 1;
        searchFrom = location + pieceChars;
        return {
            text: piece,
            start: round(caption.start + duration * (location / total)),
            end: round(caption.start + duration * ((location + pieceChars) / total)),
            src: null,
        };
    });
    caption.emphasis = 'auto';
}

function splitCaption(caption, index) {
    const boundary = caption.words[index].start;
    const emphasis = caption.emphasis;
    const first = { start: caption.start, end: boundary, words: caption.words.slice(0, index), emphasis: null };
    const second = { start: boundary, end: caption.end, words: caption.words.slice(index), emphasis: null };
    if (emphasis === 'auto') {
        first.emphasis = 'auto';
        second.emphasis = 'auto';
    } else if (Array.isArray(emphasis)) {
        if (emphasis[1] < index) first.emphasis = emphasis;
        else if (emphasis[0] >= index) second.emphasis = [emphasis[0] - index, emphasis[1] - index];
    }
    return [first, second];
}

function mergeCaptions(first, second) {
    let emphasis = null;
    if (first.emphasis) emphasis = first.emphasis;
    else if (Array.isArray(second.emphasis)) emphasis = second.emphasis.map((index) => index + first.words.length);
    else if (second.emphasis) emphasis = second.emphasis;
    return {
        start: Math.min(first.start, second.start),
        end: Math.max(first.end, second.end),
        words: [...first.words, ...second.words],
        emphasis,
    };
}

function shiftCaption(caption, offset) {
    caption.start = round(caption.start + offset);
    caption.end = round(caption.end + offset);
    caption.words.forEach((word) => {
        word.start = round(word.start + offset);
        word.end = round(word.end + offset);
    });
}

// Caption.setTimeRange: words stretch with the line.
function setTimeRange(caption, start, end) {
    if (start === caption.start && end === caption.end) return;
    const ratio = (end - start) / Math.max(caption.end - caption.start, 0.001);
    const oldStart = caption.start;
    caption.words.forEach((word) => {
        const duration = word.end - word.start;
        word.start = round(start + (word.start - oldStart) * ratio);
        word.end = round(word.start + duration * ratio);
    });
    caption.start = round(start);
    caption.end = round(end);
}

// EditApplier.applyShift: the offset is limited so the run doesn't overlap its neighbours, then
// a line pushed past either end of the video is clipped to it.
function applyShift(offset, from, to, groups, duration) {
    const targets = groups.slice(from, to + 1).flat();
    if (!targets.length) return;
    const firstStart = Math.min(...targets.map((caption) => caption.start));
    const lastEnd = Math.max(...targets.map((caption) => caption.end));
    let lowerLimit = -Infinity;
    let upperLimit = Infinity;
    const previous = groups.slice(0, from).flat().at(-1);
    const next = groups.slice(to + 1).flat()[0];
    if (previous) lowerLimit = Math.min(previous.end - firstStart, 0);
    if (next) upperLimit = Math.max(next.start - lastEnd, 0);
    const clamped = Math.min(Math.max(offset, lowerLimit), upperLimit);
    for (const caption of targets) {
        shiftCaption(caption, clamped);
        if (caption.start < 0 || caption.end > duration) {
            const clippedStart = Math.min(Math.max(caption.start, 0), duration - 0.05);
            const clippedEnd = Math.max(Math.min(caption.end, duration), clippedStart + 0.05);
            setTimeRange(caption, clippedStart, clippedEnd);
        }
    }
}

// EditApplier.applyTiming: the timeline's drag rules.
function applyTiming(start, end, caption, captions, duration) {
    const position = captions.indexOf(caption);
    if (position < 0) return;
    const earliestStart = position > 0 ? captions[position - 1].end : 0;
    const latestEnd = position + 1 < captions.length ? captions[position + 1].start : duration;
    const minimum = caption.end - caption.start >= 0.2 ? 0.2 : 0.05;
    let newStart = caption.start;
    let newEnd = caption.end;
    if (start != null) {
        newStart = Math.max(start, 0);
        if (newEnd - newStart < minimum) newStart = newEnd - minimum;
        newStart = Math.max(newStart, earliestStart);
    }
    if (end != null) {
        newEnd = end;
        if (newEnd - newStart < minimum) newEnd = newStart + minimum;
        newEnd = Math.min(newEnd, latestEnd);
    }
    setTimeRange(caption, newStart, newEnd);
}

const firstWord = (wordEdit) => (wordEdit.type === 'replace' ? wordEdit.from : wordEdit.type === 'delete' ? wordEdit.word : Infinity);

// EditApplier.apply, in the §3.4 order. Pure: returns a new state.
export function apply(edit, original) {
    const state = clone(original);
    const pacingBefore = state.style.pacing;

    // 1. preset: replaces the preset's own fields; others fall through to the project override
    if (edit.preset) {
        const { id, name, category, ...fields } = edit.preset;
        state.style = { ...state.style, ...fields, preset: id };
        if ('preset_name' in state.style) state.style.preset_name = name;
        for (const key of ['font', 'shadow']) if (!(key in original.style)) delete state.style[key];
    }

    // 2. style
    for (const args of edit.styles) {
        const color = (value) => (value === 'none' ? 'none' : value.toUpperCase());
        if (args.fill_color != null) state.style.fill = color(args.fill_color);
        if (args.emphasis_color != null) state.style.emphasis = color(args.emphasis_color);
        if (args.caption_background_color != null) state.style.caption_bg = color(args.caption_background_color);
        if (args.word_background_color != null) state.style.word_bg = color(args.word_background_color);
        if (args.font_size != null) state.style.size = args.font_size;
        if (args.overflow != null) state.style.overflow = args.overflow;
        if (args.position != null) {
            state.style.position = args.position;
            if ('y' in state.style) state.style.y = POSITIONS[args.position];
        }
        if (args.position_y != null) {
            state.style.y = args.position_y;
            state.style.position = Object.keys(POSITIONS).find((key) => Math.abs(POSITIONS[key] - args.position_y) < 0.001) || 'custom';
        }
        // as the app: width first (clamped to 0-50), then color, so outline_color "none" wins
        const current = () => (state.style.outline === 'none' || !state.style.outline ? DEFAULT_OUTLINE : state.style.outline);
        if (args.outline_width != null) state.style.outline = { ...current(), width: Math.min(Math.max(args.outline_width, 0), MAX_OUTLINE_WIDTH) };
        if (args.outline_color != null) {
            state.style.outline = args.outline_color === 'none' ? 'none' : { ...current(), color: args.outline_color.toUpperCase() };
        }
        if (args.shadow != null) state.style.shadow = args.shadow;
        if (args.font != null) state.style.font = args.font;
        if (args.case != null) state.style.case = args.case;
        if (args.highlight != null) state.style.highlight = args.highlight;
    }

    // each snapshot caption becomes a group, so snapshot indexes stay valid
    const groups = state.captions.map((caption) => [caption]);

    // 3. word edits, last word first
    for (const [index, edits] of edit.wordEdits) {
        const caption = groups[index][0];
        const ordered = [...edits].sort((a, b) => firstWord(b) - firstWord(a));
        for (const wordEdit of ordered) {
            if (wordEdit.type === 'replace') replaceTokens(caption, wordEdit.from, wordEdit.to, wordEdit.text);
            else if (wordEdit.type === 'delete') removeTokens(caption, new Set([wordEdit.word]));
            else setText(caption, wordEdit.text);
        }
        if (!caption.words.length && edits.some((wordEdit) => wordEdit.type === 'delete')) groups[index] = [];
    }

    // 4. emphasis
    for (const [index, words] of edit.emphasis) {
        const caption = groups[index][0];
        if (caption) caption.emphasis = words ? [...words] : null;
    }

    // 5. splits, then merges
    for (const [index, words] of edit.splits) {
        if (groups[index].length !== 1) continue;
        let parts = groups[index];
        for (const word of [...words].sort((a, b) => b - a)) {
            if (word > 0 && word < parts[0].words.length) parts = [...splitCaption(parts[0], word), ...parts.slice(1)];
        }
        groups[index] = parts;
    }
    for (const [first, second] of edit.merges) {
        if (groups[first].length === 1 && groups[second].length === 1) {
            groups[first] = [mergeCaptions(groups[first][0], groups[second][0])];
            groups[second] = [];
        }
    }

    // 6. deletes
    for (const index of edit.deletions) groups[index] = [];

    // 6b. new captions (timing v2). The window is the gap after `after` (to the next caption or
    // the video end; for null, from 0 to the first caption) plus `after`'s own time. A gap of
    // INSERT_GAP_S or more takes the new line (up to INSERT_MAX_S). Otherwise the new line gets
    // min(1 s, window - min(0.3 s, half of `after`)) at the window's end, and `after` is shortened
    // from its end to make room; for null, the new line takes the head of the first caption.
    if (edit.inserts.length) groups.unshift([]); // group 0 = before the first caption
    for (const insert of edit.inserts) {
        const group = insert.after + 1;
        const previous = groups.slice(0, group + 1).flat().at(-1);
        const next = groups.slice(group + 1).flat()[0];
        const gapStart = previous ? previous.end : 0;
        const gapEnd = next ? next.start : state.duration;
        const gap = gapEnd - gapStart;
        let start;
        let end;
        if (gap >= INSERT_GAP_S || !(previous || next)) {
            start = gapStart;
            end = gapStart + Math.min(INSERT_MAX_S, gap);
        } else if (previous) {
            const window = gapEnd - previous.start;
            const length = Math.min(INSERT_SHORT_S, window - Math.min(INSERT_KEEP_S, (previous.end - previous.start) / 2));
            end = gapEnd;
            start = round(gapEnd - length);
            if (start < previous.end) setTimeRange(previous, previous.start, start);
        } else {
            const window = next.end;
            const length = Math.min(INSERT_SHORT_S, window - Math.min(INSERT_KEEP_S, (next.end - next.start) / 2));
            start = 0;
            end = round(length);
            if (end > next.start) setTimeRange(next, end, next.end);
        }
        const caption = { start: round(start), end: round(end), words: [], emphasis: null };
        caption.words = [{ text: '', start: caption.start, end: caption.end, src: null }];
        setText(caption, insert.text);
        caption.emphasis = null;
        groups[group].push(caption);
    }

    // 7. timing
    const offset = edit.inserts.length ? 1 : 0; // the leading insert group shifts snapshot indexes
    for (const shift of edit.shifts) applyShift(shift.offset, shift.from + offset, shift.to + offset, groups, state.duration);
    const flat = groups.flat();
    for (const timing of edit.timings) {
        if (groups[timing.caption + offset].length === 1) applyTiming(timing.start, timing.end, groups[timing.caption + offset][0], flat, state.duration);
    }

    // 8. pacing
    let repace = Boolean(edit.preset) && state.style.pacing !== pacingBefore;
    if (edit.pacing && edit.pacing !== state.style.pacing) {
        state.style.pacing = edit.pacing;
        repace = true;
    }
    state.captions = flat;
    state.repaced = original.repaced || (repace && flat.length > 0);
    return state;
}

// Validate and apply. Returns { errors } or { state, edit }.
export function run(calls, state, presets, fonts = []) {
    const { errors, edit } = validate(calls, state, presets, fonts);
    if (errors.length) return { errors };
    return { errors: [], edit, state: apply(edit, state) };
}
