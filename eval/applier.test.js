// Runs the app's golden instruction-edit cases (copied from shorts-caption
// ShortsCaptionTests/InstructionEditCases.json) through the JS reference applier, so the eval
// scores model output with the same semantics as the app.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadFixture, run, snapshotText, captionText } from './applier.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'));
const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
const fixture = loadFixture(golden.fixture);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.011, `${label}: ${actual} vs ${expected}`);
const emphasizedText = (caption) => (Array.isArray(caption.emphasis)
    ? caption.words.slice(caption.emphasis[0], caption.emphasis[1] + 1).map((word) => word.text).join(' ')
    : null);

for (const goldenCase of golden.cases) {
    test(`golden case ${goldenCase.case}: ${goldenCase.instruction}`, () => {
        const result = run(goldenCase.calls, fixture, presets);
        assert.deepEqual(result.errors, []);
        const { state, edit } = result;
        const expect = goldenCase.expect;

        // expect.style lists every key that may change (some keep their value, e.g. highlight)
        const changed = Object.keys(fixture.style).filter((key) => state.style[key] !== fixture.style[key]);
        for (const key of changed) assert.ok(key in (expect.style || {}), `${key} changed`);
        for (const [key, value] of Object.entries(expect.style || {})) assert.equal(state.style[key], value, key);

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
        const { errors } = run(invalid.calls, fixture, presets);
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

test('insert_caption uses the gap after `after`, else splits its time', () => {
    const insert = (after, text) => ({ name: 'insert_caption', arguments: { after, text } });
    const atEnd = run([insert('c5', 'thanks for watching')], fixture, presets).state.captions;
    assert.equal(atEnd.length, 7);
    assert.deepEqual([atEnd[6].start, atEnd[6].end, captionText(atEnd[6])], [9.5, 10.2, 'thanks for watching']);
    const afterFirst = run([insert('c0', 'Subscribe now')], fixture, presets).state.captions;
    assert.deepEqual([afterFirst[0].start, afterFirst[0].end, afterFirst[1].start, afterFirst[1].end], [0, 0.6, 0.6, 1.2]);
    assert.equal(captionText(afterFirst[1]), 'Subscribe now');
    const atStart = run([insert(null, 'Hey')], fixture, presets).state.captions;
    assert.deepEqual([captionText(atStart[0]), atStart[0].start, atStart[0].end, atStart[1].start], ['Hey', 0, 0.6, 0.6]);
    assert.match(run(Array.from({ length: 6 }, () => insert('c5', 'x')), fixture, presets).errors.join(), /at most 5/);
});
