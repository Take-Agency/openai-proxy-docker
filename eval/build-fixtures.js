// Builds eval/fixtures/F2.json and F3.json from the internal Transcription Cases corpus (no user
// data). The output is committed, so the eval runs without the corpus.
//
//   node eval/build-fixtures.js "/Users/dennis/dev/take-agency/Transcription Cases/ground_truth"
//
// F2 (English, ~560 words, case 27): the corpus has no English clip with word timings, so F2 is
// the English reference translation of GERMAN (GERMAN.en.txt) with synthesized timings: the
// clip's real duration spread over the words by length, plus a short pause after each sentence.
// The translation has no filler words, so ten filler "like"s are inserted by hand at the spots
// listed in FILLER_LIKES (each is labelled `filler`). The five "like"s already in the text are
// labelled `notFiller`, except "much more, like for example", which reads either way and is
// `optional` (deleting it or not both pass).
//
// F3 (Hinglish, 124 words, case 28): HINDI_HINGLISH.json's own word timings (audio events and
// spacing dropped). It contains no name, so one is planted: the first "सर," (sir) becomes the
// misspelled name "अंकीत," (Ankit; correct Devanagari is "अंकित").
//
// Lines are grouped as the app's standard pacing roughly would: up to 6 words, a break after
// sentence punctuation, after a comma once a line has 3 words, and at pauses over 0.6 s.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const corpus = process.argv[2];
if (!corpus) {
    console.error('usage: node eval/build-fixtures.js <Transcription Cases/ground_truth>');
    process.exit(1);
}

// [words before the insertion point, as they appear in the text]: "like" goes after them.
export const FILLER_LIKES = [
    'I was just asked',
    'best if you have',
    "That's actually",
    'I asked a person to',
    "That's the best learning you can do to learn a language. I just wrote the German sentence on one side and the other language on the other side. I always had",
    'I could',
    'I usually',
    'while I sleep, for',
    'Through reading you',
    'It goes',
];

const STYLE = {
    preset: '6voux0', size: 90, fill: '#FFFFFF', emphasis: '#00E5FF', caption_bg: 'none', word_bg: 'none',
    position: 'bottom', case: 'none', highlight: 'spoken_word', pacing: 'standard', overflow: 'resize_to_fit',
};

const round = (value) => Math.round(value * 1000) / 1000;
const SENTENCE_END = /[.!?:।…"]$/;

function groupLines(words) {
    const captions = [];
    let line = [];
    words.forEach((word, index) => {
        line.push(word);
        const next = words[index + 1];
        const text = word[0];
        const pause = next ? next[1] - word[2] : 0;
        if (!next || line.length >= 6 || SENTENCE_END.test(text) || (text.endsWith(',') && line.length >= 3) || pause > 0.6) {
            captions.push({ words: line, emphasis: null });
            line = [];
        }
    });
    return captions;
}

function insertFillers(text) {
    const tokens = text.split(/\s+/).filter(Boolean);
    const labels = new Map(); // token index -> label
    let cursor = 0;
    for (const anchor of FILLER_LIKES) {
        const anchorTokens = anchor.split(/\s+/);
        let found = -1;
        for (let start = cursor; start <= tokens.length - anchorTokens.length; start += 1) {
            if (anchorTokens.every((token, offset) => tokens[start + offset] === token)) {
                found = start;
                break;
            }
        }
        if (found < 0) throw new Error(`anchor not found: ${anchor}`);
        const at = found + anchorTokens.length;
        // shift the labels after the insertion point
        for (const [index, label] of [...labels].sort((a, b) => b[0] - a[0])) {
            if (index >= at) {
                labels.delete(index);
                labels.set(index + 1, label);
            }
        }
        tokens.splice(at, 0, 'like');
        labels.set(at, 'filler');
        cursor = at + 1;
    }
    tokens.forEach((token, index) => {
        if (/^like\b/i.test(token) && !labels.has(index)) {
            labels.set(index, tokens[index - 1] === 'more,' ? 'optional' : 'notFiller');
        }
    });
    return { tokens, labels };
}

function buildF2() {
    const text = readFileSync(join(corpus, 'GERMAN.en.txt'), 'utf8');
    const { duration } = { duration: JSON.parse(readFileSync(join(corpus, 'GERMAN.json'), 'utf8')).audio_duration_secs };
    const { tokens, labels } = insertFillers(text);
    const pause = 0.25;
    const sentenceEnds = tokens.filter((token) => SENTENCE_END.test(token)).length;
    const weights = tokens.map((token) => token.length + 2);
    const perUnit = (duration - 0.2 - pause * sentenceEnds) / weights.reduce((sum, weight) => sum + weight, 0);
    let time = 0.1;
    const words = tokens.map((token, index) => {
        const start = time;
        time += weights[index] * perUnit;
        const word = [token, round(start), round(time)];
        if (SENTENCE_END.test(token)) time += pause;
        return word;
    });
    const captions = groupLines(words);
    // labels by snapshot id
    const ids = new Map();
    let flat = 0;
    captions.forEach((caption, captionIndex) => caption.words.forEach((_, wordIndex) => {
        if (labels.has(flat)) ids.set(`c${captionIndex}.${wordIndex}`, labels.get(flat));
        flat += 1;
    }));
    const byLabel = (label) => [...ids].filter(([, value]) => value === label).map(([id]) => id);
    return {
        id: 'F2',
        source: 'Transcription Cases/ground_truth/GERMAN.en.txt (English reference translation), synthesized timings, 10 filler "like"s inserted',
        language: 'en',
        duration: round(duration),
        focus: null,
        revision: 12,
        style: STYLE,
        captions,
        labels: { filler: byLabel('filler'), optional: byLabel('optional'), notFiller: byLabel('notFiller') },
    };
}

function buildF3() {
    const json = JSON.parse(readFileSync(join(corpus, 'HINDI_HINGLISH.json'), 'utf8'));
    let planted = false;
    const words = json.words.filter((word) => word.type === 'word').map((word) => {
        let text = word.text;
        if (!planted && text === 'सर,') {
            text = 'अंकीत,';
            planted = true;
        }
        return [text, round(word.start), round(word.end)];
    });
    const captions = groupLines(words);
    const nameId = captions.flatMap((caption, c) => caption.words.map((word, w) => [word[0], `c${c}.${w}`])).find(([text]) => text === 'अंकीत,')[1];
    return {
        id: 'F3',
        source: 'Transcription Cases/ground_truth/HINDI_HINGLISH.json word timings; misspelled name planted',
        language: 'hi',
        duration: round(json.audio_duration_secs),
        focus: null,
        revision: 31,
        style: STYLE,
        captions,
        labels: { name: nameId, correct: 'अंकित' },
    };
}

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
for (const fixture of [buildF2(), buildF3()]) {
    writeFileSync(join(dir, `${fixture.id}.json`), `${JSON.stringify(fixture)}\n`);
    const words = fixture.captions.reduce((sum, caption) => sum + caption.words.length, 0);
    console.log(`${fixture.id}: ${fixture.captions.length} captions, ${words} words, labels ${JSON.stringify(Object.fromEntries(Object.entries(fixture.labels).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])))}`);
}
