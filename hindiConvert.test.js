import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createHindiConvertRouter, chunkWords, validateChunk } from './hindiConvert.js';

const INSTALL_ID = 'test-install-0001';

// Builds a fake OpenAI chat endpoint. `respond({ model, mode, words })` returns the object the
// model would have emitted (or throws / returns a string to exercise the failure paths).
function fakeFetch(respond) {
    const calls = [];
    const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const words = JSON.parse(body.messages[1].content).map(([, word]) => word);
        const mode = body.messages[0].content.startsWith('You romanize') ? 'romanize' : 'translate';
        calls.push({ url, model: body.model, mode, words, request: body });
        const reply = await respond({ model: body.model, mode, words });
        const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
        };
    };
    return { fetch, calls };
}

async function withServer(options, run) {
    const app = express();
    app.use(createHindiConvertRouter({ openaiApiKey: 'sk-test', ...options }));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body, headers = {}) => {
        const response = await fetch(`${base}/hindi/convert`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-install-id': INSTALL_ID, ...headers },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    try {
        await run(post);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

const romanizeWord = (word) => (/^[\x00-\x7F]+$/.test(word) ? word : `r${word.length}`);
const romanize = ({ words }) => ({ words: words.map(romanizeWord) });
// One English word per input word, so `src` is [i] and offsetting is observable per chunk.
const translate = ({ words }) => {
    const en = words.map((word, index) => `e${index}${/[।.]$/.test(word) ? '.' : ''}`);
    return { translation: en.join(' '), words: en.map((word, index) => ({ en: word, src: [index] })) };
};

// 32 words ending a sentence (chunk 1) then 8 more (chunk 2).
const twoSentences = [
    ...Array.from({ length: 31 }, (_, index) => `शब्द${index}`), 'अंत।',
    ...Array.from({ length: 7 }, (_, index) => `word${index}`), 'खत्म।',
];

test('chunks break after a sentence end once past the minimum and hard-split at the maximum', () => {
    assert.deepEqual(chunkWords(twoSentences).map((chunk) => [chunk.offset, chunk.words.length]), [[0, 32], [32, 8]]);
    const run = Array.from({ length: 130 }, (_, index) => `w${index}`);
    assert.deepEqual(chunkWords(run).map((chunk) => [chunk.offset, chunk.words.length]), [[0, 60], [60, 60], [120, 10]]);
    assert.deepEqual(chunkWords(['a', 'b।', 'c']).map((chunk) => chunk.offset), [0]);
});

test('romanize happy path returns one token per input word with loanwords verbatim', async () => {
    const { fetch, calls } = fakeFetch(romanize);
    await withServer({ fetch }, async (post) => {
        const words = ['आज', 'हम', 'feature', 'के', 'बारे', 'में।'];
        const { status, body } = await post({ mode: 'romanize', words });
        assert.equal(status, 200);
        assert.deepEqual(body, {
            success: true, mode: 'romanize', model: 'gpt-5.6-luna',
            words: ['r2', 'r2', 'feature', 'r2', 'r4', 'r4'],
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(calls[0].request.temperature, 0);
        assert.equal(calls[0].request.reasoning_effort, 'none');
        assert.deepEqual(calls[0].request.response_format, { type: 'json_object' });
        assert.deepEqual(JSON.parse(calls[0].request.messages[1].content)[2], [2, 'feature']);
    });
});

test('romanize across two chunks concatenates in order', async () => {
    const { fetch, calls } = fakeFetch(romanize);
    await withServer({ fetch }, async (post) => {
        const { status, body } = await post({ mode: 'romanize', words: twoSentences });
        assert.equal(status, 200);
        assert.equal(body.words.length, twoSentences.length);
        assert.deepEqual(body.words.slice(32, 35), ['word0', 'word1', 'word2']);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map((call) => call.words.length), [32, 8]);
    });
});

test('translate happy path offsets src indices across two chunks', async () => {
    const { fetch, calls } = fakeFetch(translate);
    await withServer({ fetch }, async (post) => {
        const { status, body } = await post({ mode: 'translate', words: twoSentences });
        assert.equal(status, 200);
        assert.equal(body.success, true);
        assert.equal(body.mode, 'translate');
        assert.equal(body.model, 'gpt-5.6-luna');
        assert.equal(calls.length, 2);
        assert.equal(body.words.map((word) => word.en).join(' '), body.translation);
        assert.equal(body.words.length, twoSentences.length);
        // Chunk 2's model-local indices 0..7 must come back as 32..39.
        assert.deepEqual(body.words[32], { en: 'e0', src: [32] });
        assert.deepEqual(body.words[39], { en: 'e7.', src: [39] });
        assert.deepEqual(body.words[31], { en: 'e31.', src: [31] });
        const cited = new Set(body.words.flatMap((word) => word.src));
        assert.equal(cited.size, twoSentences.length);
    });
});

test('word count mismatch on the primary retries the chunk on the fallback model', async () => {
    const { fetch, calls } = fakeFetch(({ model, words }) =>
        (model === 'gpt-5.6-luna' ? { words: words.slice(1).map(romanizeWord) } : romanize({ words })));
    await withServer({ fetch }, async (post) => {
        const { status, body } = await post({ mode: 'romanize', words: ['एक', 'दो', 'तीन'] });
        assert.equal(status, 200);
        assert.equal(body.model, 'gpt-5.6-terra');
        assert.deepEqual(body.words, ['r2', 'r2', 'r3']);
        assert.deepEqual(calls.map((call) => call.model), ['gpt-5.6-luna', 'gpt-5.6-terra']);
    });
});

test('invalid translate output on the primary falls back, and the model list reflects both', async () => {
    const { fetch } = fakeFetch(({ model, words }) => (model === 'gpt-5.6-luna'
        ? { translation: 'one two', words: [{ en: 'one', src: [0] }, { en: 'three', src: [1] }] }
        : translate({ words })));
    await withServer({ fetch }, async (post) => {
        const { status, body } = await post({ mode: 'translate', words: ['एक', 'दो'] });
        assert.equal(status, 200);
        assert.equal(body.model, 'gpt-5.6-terra');
        assert.equal(body.translation, 'e0 e1');
    });
});

test('fallback also failing returns 502 conversion_failed', async () => {
    const { fetch, calls } = fakeFetch(() => 'this is not json');
    await withServer({ fetch }, async (post) => {
        const { status, body } = await post({ mode: 'romanize', words: ['एक', 'दो'] });
        assert.equal(status, 502);
        assert.deepEqual(body, { success: false, error: 'conversion_failed' });
        assert.deepEqual(calls.map((call) => call.model), ['gpt-5.6-luna', 'gpt-5.6-terra']);
    });
});

test('a chunk that times out on both models returns 502', async () => {
    const fetch = (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await withServer({ fetch, chunkTimeoutMs: 20 }, async (post) => {
        const { status, body } = await post({ mode: 'romanize', words: ['एक'] });
        assert.equal(status, 502);
        assert.equal(body.error, 'conversion_failed');
    });
});

test('missing or malformed install id is a 400 before anything is sent upstream', async () => {
    const { fetch, calls } = fakeFetch(romanize);
    await withServer({ fetch }, async (post) => {
        const missing = await post({ mode: 'romanize', words: ['एक'] }, { 'x-install-id': '' });
        assert.equal(missing.status, 400);
        assert.deepEqual(missing.body, { success: false, error: 'install_id_required' });
        const short = await post({ mode: 'romanize', words: ['एक'] }, { 'x-install-id': 'abc' });
        assert.equal(short.status, 400);
        assert.equal(calls.length, 0);
    });
});

test('input validation: invalid mode, empty words, oversized word, too many words', async () => {
    const { fetch, calls } = fakeFetch(romanize);
    await withServer({ fetch }, async (post) => {
        assert.deepEqual((await post({ mode: 'shout', words: ['एक'] })).body, { success: false, error: 'invalid_mode' });
        assert.deepEqual((await post({ mode: 'romanize', words: [] })).body, { success: false, error: 'words_required' });
        assert.deepEqual((await post({ mode: 'romanize', words: ['x'.repeat(65)] })).body, { success: false, error: 'words_required' });
        const tooMany = await post({ mode: 'romanize', words: Array.from({ length: 1501 }, () => 'एक') });
        assert.equal(tooMany.status, 413);
        assert.equal(tooMany.body.error, 'too_many_words');
        assert.equal(calls.length, 0);
    });
});

test('missing OpenAI key is a 503 not_configured', async () => {
    const { fetch, calls } = fakeFetch(romanize);
    await withServer({ fetch, openaiApiKey: undefined }, async (post) => {
        const { status, body } = await post({ mode: 'romanize', words: ['एक'] });
        assert.equal(status, 503);
        assert.deepEqual(body, { success: false, error: 'not_configured' });
        assert.equal(calls.length, 0);
    });
});

test('per-install minute limiter returns the shared rate_limited shape', async () => {
    const { fetch } = fakeFetch(romanize);
    await withServer({ fetch }, async (post) => {
        // Rotate the IP so only the per-install (10/min) limiter is exercised.
        for (let index = 0; index < 10; index += 1) {
            const { status } = await post({ mode: 'romanize', words: ['एक'] }, { 'do-connecting-ip': `10.0.0.${index}` });
            assert.equal(status, 200);
        }
        const { status, body } = await post({ mode: 'romanize', words: ['एक'] }, { 'do-connecting-ip': '10.0.1.1' });
        assert.equal(status, 429);
        assert.deepEqual(body, { success: false, error: 'rate_limited' });
    });
});

test('validateChunk rejects misaligned model output', () => {
    assert.throws(() => validateChunk('romanize', { words: ['a', ''] }, 2), /empty_word/);
    assert.throws(() => validateChunk('romanize', { words: ['a'] }, 2), /word_count_mismatch/);
    assert.throws(() => validateChunk('translate', { translation: 'a b', words: [{ en: 'a', src: [0] }, { en: 'b', src: [2] }] }, 2), /src_out_of_range/);
    assert.throws(() => validateChunk('translate', { translation: 'a  b', words: [{ en: 'a', src: [0] }, { en: 'b', src: [1] }] }, 2), /translation_mismatch/);
    assert.deepEqual(
        validateChunk('translate', { translation: 'a b', words: [{ en: 'a', src: [0, 0] }, { en: 'b', src: [1] }] }, 2),
        { translation: 'a b', words: [{ en: 'a', src: [0] }, { en: 'b', src: [1] }] },
    );
});
