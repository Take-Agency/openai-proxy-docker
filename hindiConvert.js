// Hindi caption output conversion (see shorts-caption docs/hindi_caption_output.md).
// The app transcribes Hindi speech to Devanagari and lets the user pick how captions render:
// Devanagari as-is, romanized "Hinglish" (Latin as Indians type it), or an English translation.
// The conversion is an LLM call, so it lives here behind the proxy's key and rate limits.
//
// The contract is word-aligned on purpose: the client owns per-word timings from the STT pass,
// so it needs the output as word units that map back onto input indices (1:1 for romanize,
// many:many via `src` for translate) rather than a free-text blob it would have to re-align.
// Every chunk is validated against that alignment before it's returned; a chunk that fails
// validation or times out is retried once on the fallback model, and if that also fails the
// whole request 502s and the app keeps Devanagari.

import express from 'express';
import { rateLimit } from 'express-rate-limit';

const PRIMARY_MODEL = process.env.HINDI_CONVERT_MODEL || 'gpt-5.6-luna';
const FALLBACK_MODEL = process.env.HINDI_CONVERT_FALLBACK_MODEL || 'gpt-5.6-terra';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

const MODES = ['romanize', 'translate'];
const MAX_WORDS = 1500;
const MAX_WORD_CHARS = 64;
const BODY_LIMIT = '256kb';

// Chunking: sentence-aligned around ~50 words so a sentence isn't cut mid-way (which would make
// a translation chunk's `src` map cross a boundary it can't see). Break after a sentence-final
// word once the chunk is at least MIN, hard-split at MAX regardless.
const CHUNK_MIN_WORDS = 30;
const CHUNK_MAX_WORDS = 60;
const SENTENCE_END = /[।.?!]["'”’)\]]*$/;

const MAX_CONCURRENCY = 8;
const CHUNK_TIMEOUT_MS = 12_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const ROMANIZE_SYSTEM_PROMPT = `You romanize Hindi transcript words into casual Hinglish — Latin script the way Indians type Hindi on their phones (e.g. hum, mein, karenge, nayi, aap, kya, hai, nahi).
You receive a JSON array of words, each as [index, word]. Return a JSON object {"words": [...]} containing EXACTLY as many strings as input words, in the same order, one Latin-script token per input word.
Rules:
- Words already in Latin script (English loanwords, names, numbers) must be returned VERBATIM, unchanged.
- Never merge or split words; never add, drop, or reorder entries.
- Keep any trailing punctuation attached to the same word. Replace the Devanagari danda "।" with a period ".".
- Use natural, widely used spellings rather than strict scholarly transliteration; do not use diacritics.
- Output only the JSON object, nothing else.`;

const TRANSLATE_SYSTEM_PROMPT = `You translate Hindi (Devanagari, possibly mixed with English loanwords) transcript words into natural, fluent English.
You receive a JSON array of words, each as [index, word]. Return a JSON object:
{"translation": "<the full English translation>", "words": [{"en": "<one English word>", "src": [<input indices>]}, ...]}
Rules:
- "words" is the translation split on single spaces, in order, so that joining every "en" with a single space reproduces "translation" exactly. Each "en" contains no spaces.
- "src" lists the 0-based input indices that each English word is translated from. Every input index must appear in at least one "src". An English word may cite several indices, and an index may be cited by several English words.
- Keep names and English loanwords as they are. Preserve sentence-final punctuation on the English side (replace the Devanagari danda "।" with a period).
- Output only the JSON object, nothing else.`;

export function chunkWords(words) {
    const chunks = [];
    let start = 0;
    for (let i = 0; i < words.length; i += 1) {
        const size = i - start + 1;
        const sentenceEnd = SENTENCE_END.test(words[i]);
        if ((size >= CHUNK_MIN_WORDS && sentenceEnd) || size >= CHUNK_MAX_WORDS || i === words.length - 1) {
            chunks.push({ offset: start, words: words.slice(start, i + 1) });
            start = i + 1;
        }
    }
    return chunks;
}

// Simple counting semaphore: bounds in-flight OpenAI calls when a long transcript fans out into
// many chunks, so one request can't open dozens of upstream sockets at once.
function makeSemaphore(limit) {
    let active = 0;
    const waiting = [];
    const release = () => {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
    };
    return async function run(task) {
        if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
        active += 1;
        try {
            return await task();
        } finally {
            release();
        }
    };
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

// Returns the validated, normalized chunk result or throws with a reason. Output shape must line
// up with the input word count so the client can map timings back; anything else is a failure.
export function validateChunk(mode, parsed, count) {
    if (!parsed || typeof parsed !== 'object') throw new Error('not_an_object');
    if (mode === 'romanize') {
        const { words } = parsed;
        if (!Array.isArray(words) || words.length !== count) throw new Error('word_count_mismatch');
        if (!words.every(isNonEmptyString)) throw new Error('empty_word');
        return { words: words.map((word) => word.trim()) };
    }
    const { translation, words } = parsed;
    if (!isNonEmptyString(translation)) throw new Error('empty_translation');
    if (!Array.isArray(words) || words.length === 0) throw new Error('words_missing');
    for (const entry of words) {
        if (!entry || !isNonEmptyString(entry.en) || /\s/.test(entry.en)) throw new Error('bad_en');
        if (!Array.isArray(entry.src) || entry.src.length === 0) throw new Error('bad_src');
        if (!entry.src.every((index) => Number.isInteger(index) && index >= 0 && index < count)) {
            throw new Error('src_out_of_range');
        }
    }
    if (words.map((entry) => entry.en).join(' ') !== translation) throw new Error('translation_mismatch');
    return { translation, words: words.map((entry) => ({ en: entry.en, src: [...new Set(entry.src)] })) };
}

// The key and fetch are injected so tests can run the router without env or network, matching
// how app.js injects storage into the feedback router.
export function createHindiConvertRouter({
    openaiApiKey,
    fetch = globalThis.fetch,
    primaryModel = PRIMARY_MODEL,
    fallbackModel = FALLBACK_MODEL,
    chunkTimeoutMs = CHUNK_TIMEOUT_MS,
} = {}) {
    // Per-IP is the real ceiling (the client can't choose its IP); per-install bounds an honest
    // client's retry loops without a shared CGNAT IP starving real users, as in hinglishFeedback.
    const ipLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 6,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: (req) => req.headers['do-connecting-ip'] || req.ip,
        message: { success: false, error: 'rate_limited' },
    });
    const installMinuteLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: (req) => req.headers['x-install-id'] || req.headers['do-connecting-ip'] || req.ip,
        message: { success: false, error: 'rate_limited' },
    });
    const installDayLimiter = rateLimit({
        windowMs: DAY_MS,
        limit: 60,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: (req) => req.headers['x-install-id'] || req.headers['do-connecting-ip'] || req.ip,
        message: { success: false, error: 'rate_limited' },
    });

    function requireInstallId(req, res, next) {
        const installId = req.headers['x-install-id'];
        if (typeof installId !== 'string' || installId.length < 8 || installId.length > 64) {
            return res.status(400).json({ success: false, error: 'install_id_required' });
        }
        next();
    }

    async function callModel({ model, mode, words, signal }) {
        const indexed = words.map((word, index) => [index, word]);
        const response = await fetch(OPENAI_CHAT_URL, {
            method: 'POST',
            signal,
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${openaiApiKey}`,
            },
            body: JSON.stringify({
                model,
                temperature: 0,
                reasoning_effort: 'none',
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: mode === 'romanize' ? ROMANIZE_SYSTEM_PROMPT : TRANSLATE_SYSTEM_PROMPT },
                    { role: 'user', content: JSON.stringify(indexed) },
                ],
            }),
        });
        if (!response.ok) throw new Error(`upstream_${response.status}`);
        const json = await response.json();
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('no_content');
        return {
            result: validateChunk(mode, JSON.parse(content), words.length),
            usage: json.usage || {},
        };
    }

    // One attempt on the primary, one retry on the fallback. Timeouts and validation failures
    // are treated alike — both mean "this model didn't produce an aligned answer".
    async function convertChunk({ mode, chunk, stats }) {
        let lastError;
        for (const model of [primaryModel, fallbackModel]) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), chunkTimeoutMs);
            try {
                const { result, usage } = await callModel({ model, mode, words: chunk.words, signal: controller.signal });
                stats.models.add(model);
                stats.promptTokens += usage.prompt_tokens || 0;
                stats.completionTokens += usage.completion_tokens || 0;
                return result;
            } catch (error) {
                lastError = error;
                stats.failures.push(`${model}:${error.name === 'AbortError' ? 'timeout' : error.message}`);
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastError;
    }

    async function postHindiConvert(req, res) {
        if (!openaiApiKey) {
            return res.status(503).json({ success: false, error: 'not_configured' });
        }
        const body = req.body || {};
        const { mode, words } = body;
        if (!MODES.includes(mode)) {
            return res.status(400).json({ success: false, error: 'invalid_mode' });
        }
        if (!Array.isArray(words) || words.length === 0
            || !words.every((word) => isNonEmptyString(word) && word.length <= MAX_WORD_CHARS)) {
            return res.status(400).json({ success: false, error: 'words_required' });
        }
        if (words.length > MAX_WORDS) {
            return res.status(413).json({ success: false, error: 'too_many_words', maxWords: MAX_WORDS });
        }

        const startedAt = Date.now();
        const chunks = chunkWords(words);
        const stats = { models: new Set(), promptTokens: 0, completionTokens: 0, failures: [] };
        const runLimited = makeSemaphore(MAX_CONCURRENCY);
        const log = (outcome) => console.log(
            `hindi/convert ${outcome} mode=${mode} models=${[...stats.models].join('+') || '-'} chunks=${chunks.length} `
            + `words=${words.length} latencyMs=${Date.now() - startedAt} promptTokens=${stats.promptTokens} `
            + `completionTokens=${stats.completionTokens}${stats.failures.length ? ` failures=${stats.failures.join(',')}` : ''}`,
        );

        let results;
        try {
            results = await Promise.all(chunks.map((chunk) => runLimited(() => convertChunk({ mode, chunk, stats }))));
        } catch (error) {
            log('failed');
            return res.status(502).json({ success: false, error: 'conversion_failed' });
        }

        // Model names are reported joined so a fallback-assisted response says so.
        const model = [...stats.models].join('+');
        log('ok');
        if (mode === 'romanize') {
            return res.status(200).json({ success: true, mode, model, words: results.flatMap((result) => result.words) });
        }
        // Chunk-local `src` indices are offset back onto the full input array here, so the client
        // never has to know the transcript was chunked.
        return res.status(200).json({
            success: true,
            mode,
            model,
            translation: results.map((result) => result.translation).join(' '),
            words: results.flatMap((result, chunkIndex) => result.words.map((entry) => ({
                en: entry.en,
                src: entry.src.map((index) => index + chunks[chunkIndex].offset),
            }))),
        });
    }

    const router = express.Router();
    // Carries its own json parser so the untrusted body is capped at 256kb — the router must be
    // mounted before the app's global 1000mb parser for that to matter.
    router.post(
        '/hindi/convert',
        ipLimiter,
        requireInstallId,
        installMinuteLimiter,
        installDayLimiter,
        express.json({ limit: BODY_LIMIT }),
        postHindiConvert,
    );
    return router;
}
