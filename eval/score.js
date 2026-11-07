// Scores one model batch for one case (§5.3): valid, task success, collateral damage, and
// precision/recall for the deletion cases. Cases are data (cases.js); this turns each `accept`
// alternative into an expected state with the reference applier and compares states.

import { SCHEMAS, run as applyCalls, captionText } from './applier.js';
import { FONTS } from './fixtures.js';

const run = (calls, state, presets) => applyCalls(calls, state, presets, FONTS);

const TIME_TOLERANCE = 0.02;

// [name, args] with omitted args as null -> a tool call
const toCall = ([name, args = {}]) => ({
    name,
    arguments: Object.fromEntries(Object.keys(SCHEMAS[name]).map((key) => [key, args[key] ?? null])),
});

// Expands { anyOf: [...] } args into concrete call lists.
function expandCalls(calls) {
    let batches = [[]];
    for (const [name, args = {}] of calls) {
        let variants = [{}];
        for (const [key, value] of Object.entries(args)) {
            const options = value && typeof value === 'object' && Array.isArray(value.anyOf) ? value.anyOf : [value];
            variants = variants.flatMap((variant) => options.map((option) => ({ ...variant, [key]: option })));
        }
        batches = batches.flatMap((batch) => variants.map((variant) => [...batch, toCall([name, variant])]));
    }
    return batches;
}

// Every concrete expected outcome of a case: { state, cannot, clarify, style }.
export function expectedOutcomes(testCase, fixture, presets) {
    if (testCase.cachedOutcomes) return testCase.cachedOutcomes;
    const outcomes = [];
    for (const alternative of testCase.accept || []) {
        if (alternative.clarify) {
            outcomes.push({ state: fixture, cannot: [], clarify: true, style: {} });
            continue;
        }
        for (const calls of expandCalls(alternative.calls)) {
            const result = calls.length ? run(calls, fixture, presets) : { errors: [], state: fixture };
            if (result.errors.length) throw new Error(`case ${testCase.id}: accept batch is invalid: ${result.errors.join('; ')}`);
            outcomes.push({ state: result.state, cannot: alternative.cannot || [], clarify: false, style: alternative.style || {} });
        }
    }
    Object.defineProperty(testCase, 'cachedOutcomes', { value: outcomes, enumerable: false });
    return outcomes;
}

// ---------------------------------------------------------------- matchers

function hsv(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let hue = 0;
    if (delta) {
        if (max === r) hue = 60 * (((g - b) / delta) % 6);
        else if (max === g) hue = 60 * ((b - r) / delta + 2);
        else hue = 60 * ((r - g) / delta + 4);
    }
    return { hue: (hue + 360) % 360, saturation: max ? delta / max : 0, value: max };
}

function matches(matcher, value) {
    if ('oneOf' in matcher) return matcher.oneOf.some((option) => same(option, value));
    if ('outline' in matcher) {
        return value && typeof value === 'object' && value.color === matcher.outline.color
            && value.width >= matcher.outline.minWidth && value.width <= matcher.outline.maxWidth;
    }
    if ('min' in matcher) return typeof value === 'number' && value >= matcher.min && value <= matcher.max;
    if (typeof value !== 'string' || !/^#[0-9A-F]{6}$/i.test(value)) return false;
    if ('maxChannel' in matcher) {
        const channels = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
        return channels.every((channel) => channel <= matcher.maxChannel);
    }
    const { hue, saturation } = hsv(value);
    return hue >= matcher.hue[0] && hue <= matcher.hue[1] && saturation >= matcher.minSaturation;
}

// ---------------------------------------------------------------- state comparison

const near = (a, b) => Math.abs(a - b) <= TIME_TOLERANCE;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const emphasisKey = (emphasis) => (Array.isArray(emphasis) ? emphasis.join('-') : String(emphasis));

// Differences between the model's state and an expected one (empty = equal).
export function stateDiffs(actual, expected, styleMatchers = {}) {
    const diffs = [];
    for (const key of Object.keys(expected.style)) {
        const ok = styleMatchers[key] ? matches(styleMatchers[key], actual.style[key]) : same(actual.style[key], expected.style[key]);
        if (!ok) diffs.push(`style.${key} ${JSON.stringify(actual.style[key])}, expected ${styleMatchers[key] ? JSON.stringify(styleMatchers[key]) : JSON.stringify(expected.style[key])}`);
    }
    if (actual.repaced !== expected.repaced) diffs.push(actual.repaced ? 'lines re-paced' : 'lines not re-paced');
    if (actual.repaced && expected.repaced) return diffs;
    if (actual.captions.length !== expected.captions.length) {
        diffs.push(`${actual.captions.length} captions, expected ${expected.captions.length}`);
        return diffs;
    }
    actual.captions.forEach((caption, c) => {
        const want = expected.captions[c];
        if (captionText(caption) !== captionText(want)) diffs.push(`c${c} "${captionText(caption)}", expected "${captionText(want)}"`);
        else {
            if (!near(caption.start, want.start) || !near(caption.end, want.end)) {
                diffs.push(`c${c} time ${caption.start}-${caption.end}, expected ${want.start}-${want.end}`);
            }
            if (want.emphasis !== 'auto' && emphasisKey(caption.emphasis) !== emphasisKey(want.emphasis)) {
                diffs.push(`c${c} emphasis ${emphasisKey(caption.emphasis)}, expected ${emphasisKey(want.emphasis)}`);
            }
            // words the expected state keeps from the snapshot must keep their timing
            want.words.forEach((word, w) => {
                if (word.src && !(near(caption.words[w].start, word.start) && near(caption.words[w].end, word.end))) {
                    diffs.push(`c${c}.${w} "${word.text}" retimed`);
                }
            });
        }
    });
    return diffs;
}

// What a state changed relative to the fixture, by location: style keys, snapshot captions
// ("c3": that line isn't exactly as it was), and re-pacing.
function changedLocations(state, fixture) {
    const signature = (caption) => JSON.stringify([
        caption.start.toFixed(2), caption.end.toFixed(2), emphasisKey(caption.emphasis),
        caption.words.map((word) => [word.text, word.start.toFixed(2), word.end.toFixed(2), word.src]),
    ]);
    const present = new Set(state.captions.map(signature));
    const changed = new Set(Object.keys(fixture.style).filter((key) => !same(state.style[key], fixture.style[key])).map((key) => `style.${key}`));
    fixture.captions.forEach((caption, c) => {
        if (!present.has(signature(caption))) changed.add(`c${c}`);
    });
    if (state.repaced && !fixture.repaced) changed.add('repaced');
    return changed;
}

// Collateral = locations the model changed that the expected outcome leaves alone (style keys
// with a matcher count as asked for).
function collateralAgainst(actual, outcome, fixture) {
    const asked = changedLocations(outcome.state, fixture);
    for (const key of Object.keys(outcome.style)) asked.add(`style.${key}`);
    // a re-paced state rebuilds every line, so line locations can't be compared
    const actualChanged = changedLocations(actual, fixture);
    return [...actualChanged].filter((location) => !asked.has(location) && !(outcome.state.repaced && /^c\d+$/.test(location)));
}

// ---------------------------------------------------------------- checks

function promptLeaks(edit, systemPrompt) {
    const words = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const promptWords = words(systemPrompt);
    const windows = new Set();
    for (let index = 0; index + 6 <= promptWords.length; index += 1) windows.add(promptWords.slice(index, index + 6).join(' '));
    const texts = [...edit.cannotDo.map((entry) => entry.message), edit.clarification?.question || '', ...(edit.clarification?.options || [])];
    return texts.some((text) => {
        const tokens = words(text);
        for (let index = 0; index + 6 <= tokens.length; index += 1) if (windows.has(tokens.slice(index, index + 6).join(' '))) return true;
        return false;
    });
}

// Questions and messages must be in the reply language. Small heuristics: English and Spanish
// by stopwords, Japanese by kana/kanji, Hindi by script (Devanagari, or Latin for Hinglish).
const ENGLISH = new Set(['the', 'i', 'you', 'can', 'to', 'a', 'or', 'which', 'what', 'and', 'it', 'is', 'of', 'in', 'should', 'would', 'do', 'this', 'that', 'your', 'not', 'only', 'one', 'text', 'color']);
const SPANISH = new Set(['puedo', 'no', 'el', 'la', 'los', 'las', 'de', 'que', 'en', 'solo', 'una', 'un', 'con', 'para', 'por', 'color', 'puede', 'quieres']);
const NOT_ENGLISH = new Set(['de', 'la', 'le', 'les', 'que', 'vous', 'und', 'ich', 'die', 'der', 'das', 'nicht', 'puedo', 'los', 'las', 'el', 'para', 'por', 'una', 'un', 'je', 'est', 'soll', 'welche', 'não', 'posso', 'você', 'qué', 'quieres', 'peux', 'kann', 'main', 'karo', 'hai', 'nahi', 'kar']);
const DEVANAGARI = /[\u0900-\u097F]/;
const LATIN = /[A-Za-z]/;

export function replyLanguage(testCase) {
    if (testCase.reply) return testCase.reply;
    const locale = testCase.locale || 'en';
    if (locale === 'hi') return DEVANAGARI.test(testCase.instruction) ? 'hi-deva' : 'hi-latn';
    return locale;
}

function wrongLanguage(edit, language) {
    const texts = [...edit.cannotDo.map((entry) => entry.message), edit.clarification?.question, ...(edit.clarification?.options || [])].filter(Boolean);
    if (!texts.length) return false;
    const joined = texts.join(' ');
    const words = joined.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
    switch (language) {
    case 'en': return words.some((word) => NOT_ENGLISH.has(word)) || !words.some((word) => ENGLISH.has(word));
    case 'es': return !words.some((word) => SPANISH.has(word));
    case 'ja': return !/[\u3040-\u30FF\u4E00-\u9FFF]/.test(joined);
    // names and app terms may stay Latin; the sentence must be Devanagari
    case 'hi-deva': return (joined.match(/[\u0900-\u097F]/g) || []).length < (joined.match(/[A-Za-z]/g) || []).length;
    case 'hi-latn': return DEVANAGARI.test(joined) || !LATIN.test(joined);
    default: return false;
    }
}

const WORD_EDITS = new Set(['replace_words', 'set_caption_text', 'find_replace', 'merge_captions']);
const STYLE_FIELDS = {
    fill_color: 'fill', emphasis_color: 'emphasis', caption_background_color: 'caption_bg', word_background_color: 'word_bg',
    font_size: 'size', position: 'position', case: 'case', highlight: 'highlight', overflow: 'overflow', position_y: 'y', shadow: 'shadow', font: 'font',
};

// Edits that leave their target as it is.
function noOpEdits(calls, fixture) {
    const found = [];
    for (const call of calls) {
        const args = call.arguments || {};
        if ((call.name === 'replace_words' || call.name === 'set_caption_text') && typeof args.text === 'string' && args.text.trim() === String(args.expect).trim()) {
            found.push(`${call.name} "${args.expect}" -> itself`);
        }
        if (call.name === 'find_replace' && args.find === args.replace) found.push('find_replace with find = replace');
        if (call.name === 'set_emphasis' && args.from && args.to) {
            const caption = fixture.captions[Number(String(args.caption).slice(1))];
            const range = [args.from, args.to].map((id) => Number(String(id).split('.')[1]));
            if (caption && Array.isArray(caption.emphasis) && caption.emphasis[0] === range[0] && caption.emphasis[1] === range[1]) {
                found.push(`set_emphasis ${args.caption} on its current emphasis`);
            }
        }
        if (call.name === 'merge_captions' && args.first === args.second) found.push(`merge_captions ${args.first} with itself`);
        // after a preset, a field "set to its current value" may be overriding the preset
        if (call.name === 'set_style' && !calls.some((other) => other.name === 'apply_preset')) {
            for (const [field, key] of Object.entries(STYLE_FIELDS)) {
                const value = args[field];
                if (value == null || !(key in fixture.style)) continue;
                const current = fixture.style[key];
                if (typeof value === 'string' && typeof current === 'string' ? value.toUpperCase() === current.toUpperCase() : value === current) {
                    found.push(`set_style ${field} = current ${JSON.stringify(current)}`);
                }
            }
            if (args.outline_color === 'none' && fixture.style.outline === 'none') found.push('set_style outline_color = current "none"');
        }
    }
    return found;
}

function failedChecks(testCase, edit, calls, fixture, presets, systemPrompt) {
    const failures = [];
    for (const check of testCase.checks || []) {
        if (check === 'noPromptLeak' && promptLeaks(edit, systemPrompt)) failures.push(check);
        if (check === 'noTextCram' && calls.some((call) => WORD_EDITS.has(call.name))) failures.push(check);
        if (check === 'keepStyleOption') {
            const options = edit.clarification?.options || [];
            const current = presets.find((preset) => preset.id === fixture.style.preset)?.name;
            if (!options.some((option) => /keep/i.test(option)) || options.some((option) => current && option.startsWith(current))) failures.push(check);
        }
        if (check === 'fontOptions' && (edit.clarification?.options || []).filter((option) => FONTS.includes(option)).length < 2) failures.push(check);
    }
    if (wrongLanguage(edit, replyLanguage(testCase))) failures.push('replyLanguage');
    return failures.map((check) => `failed check ${check}`).concat(noOpEdits(calls, fixture).map((entry) => `no-op edit: ${entry}`));
}

// ---------------------------------------------------------------- scoring

const wordIds = (state) => new Set(state.captions.flatMap((caption) => caption.words.map((word) => word.src).filter(Boolean)));

function scoreDeletions(testCase, fixture, presets, result) {
    const spec = testCase.deletions;
    const kept = wordIds(result.state);
    const deleted = [...wordIds(fixture)].filter((id) => !kept.has(id));
    const allowed = new Set([...spec.required, ...(spec.optional || [])]);
    const lowPrecision = new Set(spec.lowPrecision || []);
    const forbidden = deleted.filter((id) => !allowed.has(id) && !lowPrecision.has(id));
    const correct = deleted.filter((id) => allowed.has(id)).length;
    const precision = deleted.length ? correct / deleted.length : 1;
    const recall = spec.required.filter((id) => deleted.includes(id)).length / spec.required.length;

    // the model's state must be exactly "these words deleted", nothing else changed
    const wordText = (id) => {
        const [c, w] = id.slice(1).split('.').map(Number);
        return fixture.captions[c].words[w].text;
    };
    const deletionsOnly = deleted.length
        ? run([toCall(['delete_words', { words: deleted.map((id) => ({ id, expect: wordText(id) })) }])], fixture, presets).state
        : fixture;
    const otherDiffs = stateDiffs(result.state, deletionsOnly);
    const collateral = [...forbidden.map((id) => `deleted ${id} "${wordText(id)}"`), ...otherDiffs];
    const enough = spec.minRecall != null
        ? recall >= spec.minRecall && precision >= spec.minPrecision
        : recall === 1 && deleted.every((id) => allowed.has(id));
    const missed = spec.required.filter((id) => !deleted.includes(id)).map((id) => `kept ${id} "${wordText(id)}"`);
    const wrong = deleted.filter((id) => lowPrecision.has(id) && !allowed.has(id)).map((id) => `deleted ${id} "${wordText(id)}"`);
    return {
        collateral, precision, recall, enough,
        reasons: enough ? [] : [...missed, ...wrong, `precision ${precision.toFixed(2)} recall ${recall.toFixed(2)}`],
    };
}

const lessThan = (a, b) => {
    const index = a.findIndex((value, position) => value !== b[position]);
    return index >= 0 && a[index] < b[index];
};

// `result` is the applier's { errors, edit, state } for the model's batch.
export function scoreCase(testCase, fixture, presets, result, { systemPrompt = '', calls = [] } = {}) {
    if (result.errors.length) return { success: false, collateral: [], reasons: ['invalid'] };
    const { edit, state } = result;
    const checkFailures = failedChecks(testCase, edit, calls, fixture, presets, systemPrompt);
    const reasons = (edit.cannotDo || []).map((entry) => entry.reason);
    const optional = new Set(testCase.cannotOptional || []);

    if (testCase.deletions) {
        const scored = scoreDeletions(testCase, fixture, presets, result);
        const extraCannot = reasons.filter((reason) => !optional.has(reason));
        const failures = [
            ...scored.reasons,
            ...(edit.clarification ? ['asked instead'] : []),
            ...checkFailures,
            ...extraCannot.map((reason) => `unexpected cannot_do(${reason})`),
            ...scored.collateral.map((entry) => `collateral: ${entry}`),
        ];
        return { success: failures.length === 0, collateral: scored.collateral, reasons: failures, precision: scored.precision, recall: scored.recall };
    }

    let best = null;
    for (const outcome of expectedOutcomes(testCase, fixture, presets)) {
        const failures = [];
        if (outcome.clarify !== Boolean(edit.clarification)) failures.push(outcome.clarify ? 'did not ask' : 'asked instead');
        for (const reason of outcome.cannot) if (!reasons.includes(reason)) failures.push(`missing cannot_do(${reason})`);
        for (const reason of reasons) if (!outcome.cannot.includes(reason) && !optional.has(reason)) failures.push(`unexpected cannot_do(${reason})`);
        failures.push(...stateDiffs(state, outcome.state, outcome.style));
        failures.push(...checkFailures);
        const collateral = collateralAgainst(state, outcome, fixture);
        const rank = [failures.length ? 1 : 0, collateral.length, failures.length];
        if (!best || lessThan(rank, best.rank)) best = { rank, failures, collateral };
        if (!failures.length && !collateral.length) break;
    }
    return {
        success: best.failures.length === 0 && best.collateral.length === 0,
        collateral: best.collateral,
        reasons: [...best.failures, ...best.collateral.map((location) => `collateral: ${location}`)],
    };
}
