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

test('stores requested output and exposure without claiming conversion', async () => {
    const selection = { output: 'romanizedHindi', selectorOpened: true, selectorManuallyOpened: false };
    const record = await storedRecord({ hindiCaptionOutput: selection, hindiOutputConversionApplied: false });
    assert.deepEqual(record.hindiCaptionOutput, selection);
    assert.equal(record.hindiOutputConversionApplied, false);
});

test('old clients remain distinguishable from an unopened selector', async () => {
    const oldRecord = await storedRecord();
    assert.equal(oldRecord.hindiCaptionOutput, null);
    assert.equal(oldRecord.hindiOutputConversionApplied, null);
    const selection = { output: 'hinglish', selectorOpened: false, selectorManuallyOpened: false };
    assert.deepEqual((await storedRecord({ hindiCaptionOutput: selection })).hindiCaptionOutput, selection);
});

test('ignores unknown output and Hindi fields on Urdu feedback', async () => {
    assert.equal((await storedRecord({ hindiCaptionOutput: { output: 'unexpected' } })).hindiCaptionOutput, null);
    const record = await storedRecord({
        language: 'ur',
        hindiCaptionOutput: { output: 'english', selectorOpened: true },
        hindiOutputConversionApplied: false,
    });
    assert.equal(record.hindiCaptionOutput, null);
    assert.equal(record.hindiOutputConversionApplied, null);
});
