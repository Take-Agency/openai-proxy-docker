// Runs the app's golden instruction-edit cases (copied from shorts-caption
// ShortsCaptionTests/InstructionEditCases.json) through the JS reference applier, so the eval
// scores model output with the same semantics as the app.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadFixture, run, snapshotText, captionText } from './applier.js';
import { FONTS } from './fixtures.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'));
const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
const fixture = loadFixture(golden.fixture);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.011, `${label}: ${actual} vs ${expected}`);
const emphasizedText = (caption) => (Array.isArray(caption.emphasis)
    ? caption.words.slice(caption.emphasis[0], caption.emphasis[1] + 1).map((word) => word.text).join(' ')
    : null);

for (const goldenCase of golden.cases) {
    test(`golden case ${goldenCase.case}: ${goldenCase.instruction}`, () => {
        const start = goldenCase.fixture_style ? { ...fixture, style: { ...fixture.style, ...goldenCase.fixture_style } } : fixture;
        const result = run(goldenCase.calls, start, presets, FONTS);
        assert.deepEqual(result.errors, []);
        const { state, edit } = result;
        const expect = goldenCase.expect;

        // expect.style lists every key that may change (some keep their value, e.g. highlight)
        const changed = Object.keys(start.style).filter((key) => JSON.stringify(state.style[key]) !== JSON.stringify(start.style[key]));
        for (const key of changed) assert.ok(key in (expect.style || {}), `${key} changed`);
        for (const [key, value] of Object.entries(expect.style || {})) assert.deepEqual(state.style[key], value, key);

        if (expect.captions === 'repaced') {
            assert.ok(state.repaced);
        } else {
            assert.ok(!state.repaced);
            const expected = expect.captions || fixture.captions.map(captionText);
            assert.equal(state.captions.length, expected.length, 'caption count');
            expected.forEach((entry, index) => {
                const caption = state.captions[index];
                const spec = typeof entry === 'string' ? { text: entry } : entry;
                assert.equal(captionText(caption), spec.text);
                if ('start' in spec) near(caption.start, spec.start, `c${index} start`);
                if ('end' in spec) near(caption.end, spec.end, `c${index} end`);
                if ('emphasis' in spec) assert.equal(emphasizedText(caption), spec.emphasis, `c${index} emphasis`);
                if (spec.words) {
                    spec.words.forEach(([text, start, end], w) => {
                        assert.equal(caption.words[w].text, text);
                        near(caption.words[w].start, start, `c${index}.${w} start`);
                        near(caption.words[w].end, end, `c${index}.${w} end`);
                    });
                }
            });
        }
        assert.deepEqual(edit.cannotDo.map((entry) => entry.reason), expect.cannot_do || []);
        assert.equal(Boolean(edit.clarification), Boolean(expect.clarification));
    });
}

for (const invalid of golden.invalid) {
    test(`golden invalid: ${invalid.name}`, () => {
        const { errors } = run(invalid.calls, fixture, presets, FONTS);
        assert.ok(errors.some((error) => error.includes(invalid.error)), errors.join(' | '));
    });
}

test('snapshot text matches the app format', () => {
    const lines = snapshotText(fixture).split('\n');
    assert.equal(lines[0], 'rev 7 · duration 10.20s · focus c2');
    assert.equal(lines[3], 'c2 2.60-4.10 | 0 how 1 to 2 like 3 grow 4 your 5 [channel]');
    assert.match(lines.at(-1), /^style \{"caption_bg":"none","case":"none","emphasis":"#00E5FF",/);
});

test('kept words keep their snapshot id; replaced words lose it', () => {
    const { state } = run([{ name: 'replace_words', arguments: { from: 'c4.4', to: 'c4.5', expect: 'no excuses', text: 'no matter what' } }], fixture, presets);
    assert.deepEqual(state.captions[4].words.map((word) => word.src), ['c4.0', 'c4.1', 'c4.2', 'c4.3', null, null, null]);
});

test('every case accept batch is valid and a canonical answer scores as a pass', async () => {
    const { CASES } = await import('./cases.js');
    const { fixtureState } = await import('./fixtures.js');
    const { expectedOutcomes, scoreCase } = await import('./score.js');
    for (const testCase of CASES) {
        const state = fixtureState(testCase.fixture || 'F1');
        if (testCase.deletions) continue;
        const outcomes = expectedOutcomes(testCase, state, presets);
        assert.ok(outcomes.length > 0, `case ${testCase.id}`);
    }
});

test('insert_caption timing v2: a 1 s+ gap takes the line, else `after` makes room', () => {
    const insert = (after, text) => ({ name: 'insert_caption', arguments: { after, text } });
    const times = (caption) => [caption.start, caption.end];
    // after c5: gap 9.5-10.2 (0.7 s) < 1 s; window 7.8-10.2; new line 1 s at the end
    const atEnd = run([insert('c5', 'thanks for watching')], fixture, presets).state.captions;
    assert.deepEqual([times(atEnd[5]), times(atEnd[6]), captionText(atEnd[6])], [[7.8, 9.2], [9.2, 10.2], 'thanks for watching']);
    // after c0: no gap; window 0-1.2; new line = 1.2 - min(0.3, 0.6) = 0.9 s
    const afterFirst = run([insert('c0', 'Subscribe now')], fixture, presets).state.captions;
    assert.deepEqual([times(afterFirst[0]), times(afterFirst[1])], [[0, 0.3], [0.3, 1.2]]);
    // null: mirrored at the head of c0
    const atStart = run([insert(null, 'Hey')], fixture, presets).state.captions;
    assert.deepEqual([captionText(atStart[0]), times(atStart[0]), times(atStart[1])], ['Hey', [0, 0.9], [0.9, 1.2]]);
    // a short last line right before the end (the 80 ms case): the new line still gets most of the window
    const short = structuredClone(fixture);
    short.duration = 9.7;
    const tail = run([insert('c5', 'Follow for more')], short, presets).state.captions;
    assert.ok(tail[6].end - tail[6].start >= 0.9, JSON.stringify(times(tail[6])));
    // the app's pinned edge case: "made" 5.76-5.92, video end 6.1 -> new 5.84-6.1, "made" 5.76-5.84
    const made = { ...structuredClone(fixture), duration: 6.1, captions: [{ start: 5.76, end: 5.92, emphasis: null, words: [{ text: 'made', start: 5.76, end: 5.92, src: 'c0.0' }] }] };
    const edge = run([insert('c0', 'Chicken dinner')], made, presets).state.captions;
    assert.deepEqual([times(edge[0]), times(edge[1])], [[5.76, 5.84], [5.84, 6.1]]);
    // a big gap is used as is, up to 2 s
    const long = structuredClone(fixture);
    long.duration = 14;
    assert.deepEqual(times(run([insert('c5', 'Bye')], long, presets).state.captions[6]), [9.5, 11.5]);
    assert.match(run(Array.from({ length: 6 }, () => insert('c5', 'x')), fixture, presets).errors.join(), /at most 5/);
});

test('a replacement keeps trailing punctuation its expect left out', async () => {
    const { FIXTURES } = await import('./fixtures.js');
    const p2 = loadFixture(FIXTURES.P2);
    const call = (expect, text) => [{ name: 'replace_words', arguments: { from: 'c2.0', to: 'c2.1', expect, text } }];
    assert.equal(captionText(run(call('Number 1', 'Number one'), p2, presets, FONTS).state.captions[2]), 'Number one: hooks, hooks, hooks!');
    // the model's own punctuation wins
    assert.equal(captionText(run(call('Number 1:', 'Number one'), p2, presets, FONTS).state.captions[2]), 'Number one hooks, hooks, hooks!');
    assert.equal(captionText(run(call('Number 1', 'Number one -'), p2, presets, FONTS).state.captions[2]), 'Number one - hooks, hooks, hooks!');
    // removing the punctuation itself is left alone
    assert.equal(captionText(run(call('Number 1', 'Number 1'), p2, presets, FONTS).state.captions[2]), 'Number 1 hooks, hooks, hooks!');
});

test('the looks line matches the app (InstructionEditTests.testSnapshotTextFormat)', () => {
    const lines = snapshotText(fixture).split('\n');
    assert.equal(lines.at(-2), 'looks text: white letters (fill); no box behind words yet (word_bg adds one); word being spoken: cyan letters (emphasis); no box behind captions (caption_bg does nothing in this style)');
});
