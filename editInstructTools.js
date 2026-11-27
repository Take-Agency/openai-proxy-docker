// The 23 strict function tools for /edit/instruct, as Responses API function tools.
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
const nullableCaptionList = { type: ['array', 'null'], items: capId };
const wordRefs = {
    type: 'array',
    items: {
        type: 'object',
        properties: { id: wordId, expect: { type: 'string' } },
        required: ['id', 'expect'],
        additionalProperties: false,
    },
};

// set_style's fields; a change option carries the same fields as its style.
const STYLE_FIELDS = {
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
};

// One answer the user can tap in a question: a change that isn't about the look (sent back to you
// and applied), or a direction that narrows to the next question. Looks are suggest_looks.
const CLARIFICATION_OPTION = {
    type: 'object',
    properties: {
        label: { type: 'string', description: 'What the user sees, in the reply language.' },
        type: { type: 'string', enum: ['change', 'direction'] },
    },
    required: ['label', 'type'],
    additionalProperties: false,
};

// A version in suggest_looks: changes to the current style, or to a preset. style is required, so a
// version is always a real change the app can preview.
const LOOK_VERSION = {
    type: 'object',
    properties: {
        label: { type: 'string', description: 'What the look is, in the reply language ("Bright yellow text, red spoken word").' },
        preset_id: { type: ['string', 'null'], description: 'The preset it starts from, an id from <presets>; null starts from the current style.' },
        style: { type: 'object', properties: STYLE_FIELDS, required: Object.keys(STYLE_FIELDS), additionalProperties: false, description: 'The set_style fields it changes (null leaves a field as is). At least one is set.' },
    },
    required: ['label', 'preset_id', 'style'],
    additionalProperties: false,
};

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
    tool('set_style', 'Change global caption style. Call it at most once per instruction, with every field to change. Set only the fields the user asked to change; null leaves a field as is. At least one field must be set. font_size is absolute (40-120), computed from the current size in the snapshot. fill_color is the text color; emphasis_color is the highlight color (the spoken or emphasized word, "highlight the word being spoken in green"). case: "capitalized" = Every Word Capitalized, "none" = as written. position is one of three presets; position_y is any height.', STYLE_FIELDS),
    tool('apply_preset', 'Apply a style preset by its id from the presets list. Resets style overrides, so it is applied before set_style. When the user also asks for changes to the preset ("X but with white text"), also call set_style with those changes in the same batch.', {
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
    // Bulk tools: the model says what to change; the app finds every target, so it can't skip,
    // miscount or add one.
    tool('split_in_half', 'Split captions into two lines each, near the middle. null = every caption with 2 or more words. Use for "split every line in half" instead of one split_caption per line.', {
        captions: nullableCaptionList,
    }),
    tool('change_letters', 'Change the letters of the caption text itself (a text edit the user reviews). lowercase = every letter lowercase; capitalize_first_word = capitalize the first letter of the first word of each caption. null = every caption. Words that already look like that are left alone. Only for these two: all caps and Every Word Capitalized are set_style case, never change_letters.', {
        captions: nullableCaptionList,
        mode: { type: 'string', enum: ['lowercase', 'capitalize_first_word'] },
    }),
    tool('merge_short_captions', 'Merge every caption with max_words words or fewer into a neighbour (the caption before it, unless that one ends a sentence). "Merge the short lines" = max_words 2. The app counts the words.', {
        max_words: { type: 'integer' },
    }),
    tool('delete_all', 'Delete one word (case and punctuation ignored) from the captions: every occurrence (occurrences null), or only the listed occurrences of it. Only that word can be deleted, so use it whenever the user names the word ("remove every like", "remove the ums"). For a word that is only sometimes a filler ("like"), list the filler occurrences. Captions only; the audio is not cut.', {
        word: { type: 'string' },
        occurrences: { ...wordRefs, type: ['array', 'null'] },
    }),
    tool('rewrite_sentence', 'Replace the text of consecutive captions first..last (a sentence that runs across lines) with new text. The app spreads the new words over those captions in order, keeping each caption\'s time. expect is the current text of those captions joined by spaces.', {
        first: capId,
        last: capId,
        expect: { type: 'string' },
        text: { type: 'string' },
    }),
    tool('save_style', 'Save the current look (after the other edits in this batch) as one of the user\'s styles under this name. If the current style is already one of theirs, it is renamed. Use it when the user asks to save or name the style.', {
        name: { type: 'string' },
    }),
    tool('undo_last_edit', 'Undo the previous edit because the new instruction corrects it. Only when <previous> says it is applied. The app undoes it and sends you both instructions again. Never combined with other calls.', {}),
    tool('ask_clarification', 'Ask the user one question with 2-4 options (see Asking). The app adds a "Keep as is" option itself, so never add a keep, cancel or "none of these" option. Never combined with other calls.', {
        question: { type: 'string' },
        options: { type: 'array', items: CLARIFICATION_OPTION },
        offer_presets: { type: 'boolean', description: 'true only when asking how to improve the look: the app then adds its own "A different preset" option, so never add one yourself.' },
    }),
    tool('suggest_looks', 'Show the user looks to pick from, each previewed on their captions and applied when tapped (see Asking). Never combined with other calls.', {
        question: { type: 'string' },
        versions: { type: 'array', items: LOOK_VERSION, description: 'Versions of the current style, or presets with changes.' },
        presets: { type: 'array', items: { type: 'string' }, description: 'Presets as they are: ids from <presets>, never the current one.' },
    }),
    tool('cannot_do', 'Say that (part of) the instruction is not possible, and offer what is, or answer a question that asks for no change. May be combined with edits. Never a confirmation of edits you made.', {
        reason: { type: 'string', enum: ['per_word_style', 'translate', 'cut_audio', 'emoji', 'horizontal_position', 'retranscribe', 'other'] },
        message: { type: 'string' },
        suggestion: {
            type: ['string', 'null'],
            description: 'One change you can make that gets the user what they are after, worded as an instruction they could send ("Turn off Fit on one line"). The app shows it as a button. Null when there is none.',
        },
    }),
];

// The app's own tools outside the caption editor. Each build lists the ones it has in
// app_tools.open (a button that opens the tool) and app_tools.coming_soon (a waitlist button),
// and only those are offered. A new tool is a new catalog entry here plus the build that lists
// it; older builds never see it, and a feature that ships moves from a build's coming_soon list
// to its open list without breaking the builds that still have the waitlist.
export const APP_TOOL_CATALOG = {
    // button: the title the app shows on the button (the Tools tab's names, not translated)
    // now: what the button does for this clip, for rule 23's description of its state
    remove_silences: { label: 'remove silences', button: 'Remove Silences', now: 'cuts them', does: 'cuts the silent pauses out of the video and its audio', asks: '"remove the pauses", "cut the dead air"' },
    restore_silences: { label: 'restore silences', button: 'Restore Silences', now: 'puts them back', does: 'puts back the pauses that removing silences cut', asks: '"un-remove the silences", "put the pauses back"' },
    cleanup_audio: { label: 'clean up audio', button: 'Cleanup Audio', now: 'cleans it up', does: 'removes background noise and makes the voice clearer', asks: '"get rid of the background noise"' },
    undo_cleanup_audio: { label: 'undo audio cleanup', button: 'Undo Audio Cleanup', now: 'brings back the original recording', does: 'puts back the audio from before it was cleaned up', asks: '"undo the audio cleanup", "the cleaned audio sounds weird"' },
    add_music: { label: 'add music', button: 'Add Music', now: 'adds or changes it', does: 'adds background music, or changes the music already added', asks: '"add a song", "change the music"' },
    remove_music: { label: 'remove music', button: 'Remove Music', now: 'takes it out', does: 'removes the background music', asks: '"remove the music", "no music"' },
    remove_filler: { label: 'cutting filler words out of the audio', does: 'cuts filler words (um, uh) out of the audio' },
    ai_zooms: { label: 'automatic zoom-ins', does: 'adds automatic zoom-ins' },
    ai_b_roll: { label: 'b-roll', does: 'adds b-roll footage' },
};

// What 4.0 (6) dev builds sent as app_tools: true, before builds listed their tools.
export const LEGACY_APP_TOOLS = {
    open: ['remove_silences', 'cleanup_audio', 'add_music'],
    comingSoon: ['remove_filler', 'ai_zooms', 'ai_b_roll'],
};

// Settings a build can apply itself (app_tools.settings), so its button runs the tool at once
// instead of opening the tool's screen. Null leaves a setting at the app's default; each set only
// applies to its own tool and is null for every other.
const SILENCE_SETTINGS = {
    min_gap_ms: { type: ['integer', 'null'], description: 'remove_silences only: the shortest pause that gets cut, 50-500 ms (default 100). Longer means only long pauses go ("only cut the long pauses": 300-500).' },
    padding_ms: { type: ['integer', 'null'], description: 'remove_silences only: how much of each pause to keep around speech, 0-500 ms (default 60). More keeps it natural and less rushed ("keep it natural": 120-200; "tight", "fast-paced": 0-40).' },
    aggressiveness: { type: ['number', 'null'], description: 'remove_silences only: how quiet a moment must be to count as silence, 0.1-0.9 (default 0.5). Higher cuts more, including quiet breaths; lower keeps soft speech safe.' },
};
const CLEANUP_SETTINGS = {
    preset: { type: ['string', 'null'], enum: ['studio_sound', 'remove_noise', null], description: 'cleanup_audio only: studio_sound polishes the voice itself to studio quality ("sound professional", "like a podcast"); remove_noise clears steady background noise (a fan, hum, traffic, wind) and rebalances the audio. Default studio_sound.' },
    breath_control: { type: ['boolean', 'null'], description: 'cleanup_audio only: soften loud breath sounds (default on).' },
    mouth_noises: { type: ['boolean', 'null'], description: 'cleanup_audio only: remove clicks and smacks (default on).' },
    mastering: { type: ['boolean', 'null'], description: 'cleanup_audio only: even out overall loudness (default on).' },
};

export function appToolDefinitions({ open, comingSoon, settings = [] }) {
    const describe = (names) => names.map((name) => `${name} ${APP_TOOL_CATALOG[name].does}.`).join(' ');
    const definitions = [];
    if (open.length) {
        const silences = settings.includes('remove_silences') && open.includes('remove_silences');
        const cleanup = settings.includes('cleanup_audio') && open.includes('cleanup_audio');
        const runs = [silences && 'remove_silences', cleanup && 'cleanup_audio'].filter(Boolean);
        const runNote = runs.length
            ? ` For ${runs.join(' and ')} the button runs the tool at once with the settings you pass (the user taps it to confirm), so pick them from what the user asked and say them in plain words in message ("I'll cut pauses longer than 0.3 seconds and keep a little room around each sentence"); the app lists them under it.`
            : '';
        definitions.push(tool('open_tool', `Offer one of the app's own tools. The app shows message as your reply, with a button under it that opens the tool, and the user confirms there. ${describe(open)} message answers the user in a full sentence and names the button, e.g. "Yes, I can put back the pauses that were removed. Tap ${APP_TOOL_CATALOG[open[0]].button} below."${runNote} May be combined with edits.`, {
            tool: { type: 'string', enum: open },
            message: { type: 'string' },
            ...(silences ? SILENCE_SETTINGS : {}),
            ...(cleanup ? CLEANUP_SETTINGS : {}),
        }));
    }
    if (comingSoon.length) {
        definitions.push(tool('coming_soon', `Say that a feature the app is building isn't available yet. The app shows message with a button to join its waitlist. ${describe(comingSoon)} May be combined with edits.`, {
            feature: { type: 'string', enum: comingSoon },
            message: { type: 'string' },
        }));
    }
    return definitions;
}

// Every catalog entry offered, for the schema test and the argument-key re-check.
export const APP_TOOLS = appToolDefinitions({
    open: ['remove_silences', 'restore_silences', 'cleanup_audio', 'undo_cleanup_audio', 'add_music', 'remove_music'],
    comingSoon: ['remove_filler', 'ai_zooms', 'ai_b_roll'],
    settings: ['remove_silences', 'cleanup_audio'],
});
export const APP_TOOL_NAMES = APP_TOOLS.map((entry) => entry.name);

export const TOOL_NAMES = EDIT_TOOLS.map((entry) => entry.name);
// name -> sorted top-level argument keys, for the server-side shape re-check.
export const TOOL_ARGUMENT_KEYS = new Map(
    [...EDIT_TOOLS, ...APP_TOOLS].map((entry) => [entry.name, Object.keys(entry.parameters.properties).sort()]),
);
