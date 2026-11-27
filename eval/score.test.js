// Sanity checks for the scorer: canonical answers pass, collateral and leaks are caught.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { run } from './applier.js';
import { CASES } from './cases.js';
import { fixtureState, FIXTURES, FONTS } from './fixtures.js';
import { scoreCase } from './score.js';

const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
const byId = (id) => CASES.find((entry) => entry.id === id);
const style = (args) => ({ name: 'set_style', arguments: { fill_color: null, emphasis_color: null, caption_background_color: null, word_background_color: null, font_size: null, position: null, case: null, highlight: null, overflow: null, ...args } });
const cannot = (reason) => ({ name: 'cannot_do', arguments: { reason, message: 'Not possible.' } });
const remove = (ids, fixture = 'F1') => {
    const state = fixtureState(fixture);
    return { name: 'delete_words', arguments: { words: ids.map((id) => { const [c, w] = id.slice(1).split('.').map(Number); return { id, expect: state.captions[c].words[w].text }; }) } };
};
const score = (id, calls) => {
    const testCase = byId(id);
    const state = fixtureState(testCase.fixture || 'F1');
    return scoreCase(testCase, state, presets, run(calls, state, presets, FONTS), { systemPrompt: 'You edit the captions of a short video in the Auto Caption app.', calls });
};

test('yellow passes; yellow plus an unasked size change is collateral', () => {
    assert.equal(score(1, [style({ fill_color: '#FFE000' })]).success, true);
    const result = score(1, [style({ fill_color: '#FFD600', font_size: 100 })]);
    assert.equal(result.success, false);
    assert.deepEqual(result.collateral, ['style.size']);
});

test('a gratuitous cannot_do fails the case without being collateral', () => {
    // case 2 may note "Fit on one line" now; case 1 (yellow only) may not add a note
    const result = score(1, [style({ fill_color: '#FFD600' }), cannot('other')]);
    assert.equal(result.success, false);
    assert.deepEqual(result.collateral, []);
});

test('preset then white fill passes in either call order', () => {
    const id = presets.find((preset) => preset.name.startsWith('Boo Cute')).id;
    const preset = { name: 'apply_preset', arguments: { preset_id: id } };
    assert.equal(score(12, [style({ fill_color: '#FFFFFF' }), preset]).success, true);
    assert.equal(score(12, [preset]).success, false);
});

test('filler removal: required + optional passes, deleting a real word is collateral', () => {
    assert.equal(score(19, [remove(['c1.0', 'c2.2', 'c3.1', 'c5.6', 'c5.7']), cannot('cut_audio')]).success, true);
    const result = score(51, [remove(['c0.0', 'c1.0', 'c2.2', 'c3.1'], 'F1L')]);
    assert.equal(result.success, false);
    assert.match(result.collateral[0], /c0\.0 "Ladies"/);
});

test('F2 "like" removal scores precision and recall', () => {
    const { filler } = FIXTURES.F2.labels;
    const all = score(27, [remove(filler, 'F2')]);
    assert.equal(all.success, true);
    assert.equal(all.recall, 1);
    const partial = score(27, [remove(filler.slice(0, 7), 'F2')]);
    assert.equal(partial.success, false);
    assert.ok(Math.abs(partial.recall - 0.7) < 1e-9);
});

test('shift within tolerance passes; a split elsewhere fails', () => {
    assert.equal(score(35, [{ name: 'shift_timing', arguments: { from: null, to: null, offset_ms: -450 } }]).success, true);
    assert.equal(score(30, [{ name: 'split_caption', arguments: { caption: 'c2', before: 'c2.3' } }]).success, false);
});

test('changing the emphasis color for "only Dennis red" fails as collateral', () => {
    const result = score(44, [style({ emphasis_color: '#FF0000' }), cannot('per_word_style')]);
    assert.equal(result.success, false);
    assert.deepEqual(result.collateral, ['style.emphasis']);
});

test('a leaked prompt fails case 50', () => {
    const leak = { name: 'cannot_do', arguments: { reason: 'other', message: 'You edit the captions of a short video in the Auto Caption app.' } };
    assert.equal(score(50, [leak]).success, false);
    assert.equal(score(50, [cannot('other')]).success, true);
});

test('Hinglish name fix keeps Devanagari', () => {
    const id = FIXTURES.F3.labels.name;
    const fix = (text) => [{ name: 'replace_words', arguments: { from: id, to: id, expect: 'अंकीत,', text } }];
    assert.equal(score(28, fix('अंकित,')).success, true);
    assert.equal(score(28, fix('Ankit,')).success, false);
});

test('an English instruction answered in another language fails', () => {
    const ask = (question, options) => [{ name: 'ask_clarification', arguments: { question, options } }];
    assert.equal(score(43, ask('Which color should I change?', ['Text', 'Highlight'])).success, true);
    assert.equal(score(43, ask('Welche Farbe soll ich ändern?', ['Schriftfarbe', 'Hervorhebungsfarbe'])).success, false);
    assert.equal(score(42, ask('Qu’est-ce que vous aimeriez améliorer ?', ['Le style', 'Les lignes'])).success, false);
});

test('insertions pass; cramming the new text into a caption fails', () => {
    const insert = { name: 'insert_caption', arguments: { after: 'c0', text: 'Subscribe now' } };
    assert.equal(score(52, [insert]).success, true);
    const cram = { name: 'replace_words', arguments: { from: 'c0.3', to: 'c0.3', expect: 'Denis', text: 'Denis Subscribe now' } };
    assert.equal(score(52, [cram]).success, false);
});

test('a no-op edit is reported, not failed (the app drops it)', () => {
    const noop = { name: 'replace_words', arguments: { from: 'c0.0', to: 'c0.0', expect: 'Hey', text: 'Hey' } };
    const result = score(26, [{ name: 'replace_words', arguments: { from: 'c0.3', to: 'c0.3', expect: 'Denis', text: 'Dennis' } }, noop]);
    assert.equal(result.success, true);
    assert.deepEqual(result.noOps, ['replace_words "Hey" -> itself']);
});

test('reply language follows the case: Devanagari, Hinglish, Japanese', () => {
    const cannot = (reason, message) => [{ name: 'cannot_do', arguments: { reason, message } }];
    assert.equal(score(72, cannot('per_word_style', 'सिर्फ़ एक शब्द का रंग नहीं बदल सकते, मैं उसे हाइलाइट कर सकता हूँ।')).success, true);
    assert.equal(score(72, cannot('per_word_style', 'No puedo poner solo bahana en rojo.')).success, false);
    assert.equal(score(73, cannot('emoji', 'Emoji add karna abhi possible nahi hai.')).success, true);
    assert.equal(score(73, cannot('emoji', 'इमोजी अभी नहीं जोड़ सकते।')).success, false);
    assert.equal(score(75, cannot('per_word_style', 'Dennisだけ赤くはできません。')).success, true);
});

test('outline, shadow, position and font', () => {
    const style = (args) => [{ name: 'set_style', arguments: { fill_color: null, emphasis_color: null, caption_background_color: null, word_background_color: null, font_size: null, position: null, case: null, highlight: null, overflow: null, position_y: null, outline_color: null, outline_width: null, shadow: null, font: null, ...args } }];
    assert.equal(score(57, style({ outline_color: 'none' })).success, true);
    assert.equal(score(57, style({ caption_background_color: 'none', word_background_color: 'none' })).success, false);
    assert.equal(score(58, style({ outline_width: 8 })).success, true);
    assert.equal(score(61, style({ position_y: 0.31 })).success, true);
    assert.equal(score(61, style({ position: 'top' })).success, false);
    assert.equal(score(62, style({ font: 'Montserrat-ExtraBold' })).success, true);
    assert.equal(score(62, style({ font: 'Montserrat' })).success, false);
    // a missing font gets looks in catalog fonts (the proxy maps them); the app adds "Keep as is"
    const blank = { fill_color: null, emphasis_color: null, caption_background_color: null, word_background_color: null, font_size: null, position: null, case: null, highlight: null, overflow: null, position_y: null, outline_color: null, outline_width: null, shadow: null, font: null };
    const inFont = (name) => ({ label: name, type: 'look', preset_id: null, style: { ...blank, font: name } });
    const ask = (...options) => [{ name: 'ask_clarification', arguments: { question: 'Comic Sans isn’t available. Which of these?', options } }];
    assert.equal(score(63, ask(inFont('Bangers-Regular'), inFont('LuckiestGuy-Regular'))).success, true);
    assert.equal(score(63, ask(inFont('Bangers-Regular'), { label: 'Keep current font', type: 'change', preset_id: null, style: null })).success, false);
    assert.equal(score(63, ask(inFont('Bangers-Regular'), inFont('Comic-style Fredoka One'))).success, false);
    // an untyped answer (a build without typed options) can't pass a type check
    assert.equal(score(63, [{ name: 'ask_clarification', arguments: { question: 'Which?', options: ['Bangers-Regular'] } }]).success, false);
});

test('looks must each apply, change the captions and differ', () => {
    const blank = { fill_color: null, emphasis_color: null, caption_background_color: null, word_background_color: null, font_size: null, position: null, case: null, highlight: null, overflow: null, position_y: null, outline_color: null, outline_width: null, shadow: null, font: null };
    const look = (label, fields, presetId = null) => ({ label, type: 'look', preset_id: presetId, style: fields ? { ...blank, ...fields } : null });
    const ask = (...options) => [{ name: 'ask_clarification', arguments: { question: 'Which look?', options } }];
    const other = presets.find((preset) => preset.name !== 'Mosy');
    // a version of the current style, a preset, and a preset with changes mix freely
    assert.equal(score(151, ask(look('Yellow text', { fill_color: '#FFD600' }), look(other.name, null, other.id), look(`${other.name}, red text`, { fill_color: '#FF0000' }, other.id))).success, true);
    assert.equal(score(151, ask(look('Yellow text', { fill_color: '#FFD600' }), look('Also yellow', { fill_color: '#FFD600' }))).success, false);
    // the current preset as it is is no new look
    assert.equal(score(151, ask(look('Yellow text', { fill_color: '#FFD600' }), look('Mosy', null, presets.find((preset) => preset.name === 'Mosy').id))).success, false);
    assert.equal(score(151, ask(look('Yellow text', { fill_color: '#FFD600' }), { label: 'Playful', type: 'direction', preset_id: null, style: null })).success, false);
});

test('a look must read: letters against their box, outline against the letters', () => {
    const blank = { fill_color: null, emphasis_color: null, caption_background_color: null, word_background_color: null, font_size: null, position: null, case: null, highlight: null, overflow: null, position_y: null, outline_color: null, outline_width: null, shadow: null, font: null };
    const look = (label, fields) => ({ label, type: 'look', preset_id: null, style: { ...blank, ...fields } });
    const ask = (...options) => [{ name: 'ask_clarification', arguments: { question: 'Which look?', options } }];
    const yellow = look('Yellow text', { fill_color: '#FFD600' });
    assert.equal(score(151, ask(yellow, look('Black outline', { outline_color: '#000000', outline_width: 8 }))).success, true);
    // white outline on white letters, white letters on a white box
    assert.equal(score(151, ask(yellow, look('White outline', { fill_color: '#FFFFFF', outline_color: '#FFFFFF', outline_width: 8 }))).success, false);
    assert.equal(score(151, ask(yellow, look('White box', { fill_color: '#FFFFFF', caption_background_color: '#F5F5F5' }))).success, false);
    // pink spoken word on a pink box
    assert.equal(score(151, ask(yellow, look('Pink box', { emphasis_color: '#FF4F8B', word_background_color: '#F0457E' }))).success, false);
});
