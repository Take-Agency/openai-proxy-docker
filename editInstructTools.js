// The 16 strict function tools for /edit/instruct, as Responses API function tools.
// Source of truth: shorts-caption docs/instruction_editing_plan.md §3.2, plus insert_caption. Kept as plain data in its
// own module so it can be diffed against (or exported to) the iOS decoder's fixture.
//
// Strict mode: every property is required, optional ones are nullable (`["X", "null"]`), and
// every object has `additionalProperties: false`. Numeric ranges and array lengths (font size
// 40–120, offset ±5000 ms, 2–3 options, position_y, outline width, font names in the catalog)
// are left to the app's validator, as §3.2 specifies.

const CAP_ID = '^c\\d+$';
const WORD_ID = '^c\\d+\\.\\d+$';
const HEX = '^#[0-9A-Fa-f]{6}$';
const HEX_OR_NONE = '^(#[0-9A-Fa-f]{6}|none)$';

const capId = { type: 'string', pattern: CAP_ID };
const wordId = { type: 'string', pattern: WORD_ID };
const nullableCapId = { type: ['string', 'null'], pattern: CAP_ID };
const nullableWordId = { type: ['string', 'null'], pattern: WORD_ID };
const nullableEnum = (values) => ({ type: ['string', 'null'], enum: [...values, null] });

function tool(name, description, properties) {
    return {
        type: 'function',
        name,
        description,
        strict: true,
        parameters: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
        },
    };
}

export const EDIT_TOOLS = [
    tool('set_style', 'Change global caption style. Call it at most once per instruction, with every field to change. Set only the fields the user asked to change; null leaves a field as is. At least one field must be set. font_size is absolute (40-120), computed from the current size in the snapshot. case: "capitalized" = Every Word Capitalized, "none" = as written. position is one of three presets; position_y is any height.', {
        fill_color: { type: ['string', 'null'], pattern: HEX },
        emphasis_color: { type: ['string', 'null'], pattern: HEX },
        caption_background_color: { type: ['string', 'null'], pattern: HEX_OR_NONE },
        word_background_color: { type: ['string', 'null'], pattern: HEX_OR_NONE },
        font_size: { type: ['integer', 'null'] },
        position: nullableEnum(['bottom', 'center', 'top']),
        case: nullableEnum(['none', 'uppercase', 'capitalized']),
        highlight: nullableEnum(['none', 'static', 'spoken_word']),
        overflow: nullableEnum(['none', 'resize_to_fit', 'wrap']),
        position_y: { type: ['number', 'null'], description: 'Vertical position, 0 = bottom edge, 1 = top edge (the style line\'s y; the bottom/center/top presets are about 0.2/0.5/0.9). For "a bit higher/lower" move 0.08-0.12 from the current y. Keep within 0.05-0.95.' },
        outline_color: { type: ['string', 'null'], pattern: HEX_OR_NONE, description: '"none" removes the outline.' },
        outline_width: { type: ['number', 'null'], description: 'Without an outline yet: thin about 2, medium about 4, thick about 8. With one, relative words move from the current width (outline.width in the style line).' },
        shadow: nullableEnum(['none', 'soft', 'strong']),
        font: { type: ['string', 'null'], description: 'Exactly one name from <fonts>.' },
    }),
    tool('apply_preset', 'Apply a style preset by its id from the presets list. Resets style overrides, so it is applied before set_style.', {
        preset_id: { type: 'string' },
    }),
    tool('set_pacing', 'Change how many words each caption line holds. Rebuilds every line; applied after all other edits.', {
        pacing: { type: 'string', enum: ['fast', 'standard', 'relaxed'] },
    }),
    tool('replace_words', 'Replace a contiguous span of words inside ONE caption, keeping word timing. Use for spelling fixes and word changes. expect is the exact current text of the span.', {
        from: wordId,
        to: wordId,
        expect: { type: 'string' },
        text: { type: 'string' },
    }),
    tool('delete_words', 'Delete words from the captions only (the audio is not cut). Each expect is the exact current word.', {
        words: {
            type: 'array',
            items: {
                type: 'object',
                properties: { id: wordId, expect: { type: 'string' } },
                required: ['id', 'expect'],
                additionalProperties: false,
            },
        },
    }),
    tool('find_replace', 'Replace every occurrence of a word or phrase across all captions. Use for global fixes instead of listing ids.', {
        find: { type: 'string' },
        replace: { type: 'string' },
        whole_word: { type: 'boolean' },
        match_case: { type: 'boolean' },
    }),
    tool('set_caption_text', 'Rewrite one whole caption line. Last resort: word timings in the line are lost. expect is the whole current line.', {
        caption: capId,
        expect: { type: 'string' },
        text: { type: 'string' },
    }),
    tool('split_caption', 'Split a caption into two lines, starting the second line at the word `before` (not the first word).', {
        caption: capId,
        before: wordId,
    }),
    tool('merge_captions', 'Merge two different, adjacent captions (first, then the one right after it) into one line.', {
        first: capId,
        second: capId,
    }),
    tool('delete_captions', 'Delete whole caption lines. Each expect is the whole current line.', {
        captions: {
            type: 'array',
            items: {
                type: 'object',
                properties: { id: capId, expect: { type: 'string' } },
                required: ['id', 'expect'],
                additionalProperties: false,
            },
        },
    }),
    tool('insert_caption', 'Insert a NEW caption line with the given text after caption `after` (null = before the first caption). The app times it automatically: it uses the gap after `after`, or splits that caption\'s time. Use it whenever the user asks to add or insert a new line or caption. At most 5 per instruction.', {
        after: nullableCapId,
        text: { type: 'string' },
    }),
    tool('shift_timing', 'Shift caption timing by offset_ms (within +-5000; positive = later). from/to null means every caption.', {
        from: nullableCapId,
        to: nullableCapId,
        offset_ms: { type: 'integer' },
    }),
    tool('set_caption_timing', 'Set one caption\'s start and/or end time in seconds; null keeps the current value.', {
        caption: capId,
        start_s: { type: ['number', 'null'] },
        end_s: { type: ['number', 'null'] },
    }),
    tool('set_emphasis', 'Set the one emphasized word range of a caption (from..to, same caption). from and to null clears it. Emphasized words share one global color.', {
        caption: capId,
        from: nullableWordId,
        to: nullableWordId,
    }),
    tool('ask_clarification', 'Ask the user to choose between 2-3 readings of the instruction. Never combined with other calls.', {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
    }),
    tool('cannot_do', 'Say that (part of) the instruction is not possible, and offer what is. May be combined with edits.', {
        reason: { type: 'string', enum: ['per_word_style', 'translate', 'cut_audio', 'emoji', 'horizontal_position', 'retranscribe', 'other'] },
        message: { type: 'string' },
    }),
];

export const TOOL_NAMES = EDIT_TOOLS.map((entry) => entry.name);

// name -> sorted top-level argument keys, for the server-side shape re-check.
export const TOOL_ARGUMENT_KEYS = new Map(
    EDIT_TOOLS.map((entry) => [entry.name, Object.keys(entry.parameters.properties).sort()]),
);
