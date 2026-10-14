import assert from 'node:assert/strict';
import test from 'node:test';
import { createHinglishFeedbackRouter } from './hinglishFeedback.js';

async function storedRecord(fields = {}) {
    const writes = [];
    const router = createHinglishFeedbackRouter({
        s3Client: { send: async (command) => { writes.push(command.input); } },
        spacesBucket: 'test-feedback',
        signedUrlExpiration: 60,
        generateSignedUrl: async () => '',
    });
    const route = router.stack.find((layer) => layer.route?.methods.post).route;
    const handle = route.stack.at(-1).handle;
    let status;
    await handle({ body: { language: 'hi', issues: ['want_romanized'], ...fields } }, {
        status(value) { status = value; return this; },
        json() {},
    });
    assert.equal(status, 200);
    return JSON.parse(writes.find((entry) => entry.Key.includes('/records/')).Body);
}

test('stores requested caption language and exposure without claiming conversion', async () => {
    const selection = { primary: 'romanized', selectorOpened: true, selectorManuallyOpened: false };
    const record = await storedRecord({ captionLanguages: selection, captionConversionApplied: false });
    assert.deepEqual(record.captionLanguages, selection);
    assert.equal(record.captionConversionApplied, false);
});

test('old clients remain distinguishable from an unopened selector', async () => {
    const oldRecord = await storedRecord();
    assert.equal(oldRecord.captionLanguages, null);
    assert.equal(oldRecord.captionConversionApplied, null);
    const selection = { primary: 'asSpoken', selectorOpened: false, selectorManuallyOpened: false };
    assert.deepEqual((await storedRecord({ captionLanguages: selection })).captionLanguages, selection);
});

test('accepts translated targets and urdu, rejects unknown caption languages', async () => {
    const translated = { primary: 'translated:en', selectorOpened: true, selectorManuallyOpened: true };
    const urdu = await storedRecord({ language: 'ur', captionLanguages: translated, captionConversionApplied: true });
    assert.deepEqual(urdu.captionLanguages, translated);
    assert.equal(urdu.captionConversionApplied, true);
    assert.equal((await storedRecord({ captionLanguages: { primary: 'unexpected' } })).captionLanguages, null);
    assert.equal((await storedRecord({ captionLanguages: { primary: 'translated:' } })).captionLanguages, null);
    // Pre-rename clients sent `hindiCaptionOutput`; it is no longer read.
    const legacy = await storedRecord({ hindiCaptionOutput: { output: 'english' }, hindiOutputConversionApplied: true });
    assert.equal(legacy.captionLanguages, null);
    assert.equal(legacy.captionConversionApplied, null);
});
