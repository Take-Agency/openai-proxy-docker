// Hinglish transcription feedback (see shorts-caption docs/hinglish_feedback_plan.md).
// Collects real problem clips for Hindi/Urdu transcription, keyed by what the user said was wrong.
// Thumbs-down submits only: thumbs-up is an Amplitude event and never reaches the backend, so a
// record's existence means "confirmed problem". Amplitude is the source of truth for rates; this
// bucket is the source of truth for fixtures (and transcript evidence when audio was declined).
//
// Storage is bucket-only:
//   hinglish-feedback/records/<id>.json                  source of truth (full record + transcript)
//   hinglish-feedback/media/<date>/<id>.m4a
//   hinglish-feedback/by-issue/<issue>/<date>/<id>.json  pointer, one per selected issue
// There is no upload-status field — the media key is deterministic, so object existence IS the
// status. The by-issue index is rebuildable from records/ if pointer writes ever partially fail.

import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID, timingSafeEqual } from 'node:crypto';

// Two credentials on purpose. The client secret ships inside the app binary and is extractable
// with `strings`, so it only deters drive-by traffic — POST abuse is really bounded by the IP
// limiter and the signed size cap. The admin secret gates listing (full transcripts + presigned
// audio URLs) and must never ship in a client or share a value with the client secret.
const feedbackSecret = process.env.HINGLISH_FEEDBACK_SECRET;
const feedbackAdminSecret = process.env.HINGLISH_FEEDBACK_ADMIN_SECRET;
const feedbackMaxAudioBytes = parseInt(process.env.HINGLISH_FEEDBACK_MAX_AUDIO_BYTES || '52428800', 10); // 50 MiB
const FEEDBACK_PREFIX = 'hinglish-feedback';
// Allowlisted so a client can never invent prefixes and scatter objects through the bucket.
const FEEDBACK_ISSUES = ['urdu_script', 'eng_in_hindi', 'missing_eng', 'other'];
const FEEDBACK_LANGUAGES = ['hi', 'ur'];

// The submit route carries its own daily budget (below) and must be exempted from the app's
// global limiter, which ElevenLabs transcription would otherwise trip moments before a feedback
// POST. Exact match on method+path only: a prefix match would hand any /hinglish-feedback* path
// an unlimited lane through the proxy catch-all, and GET must stay under the global limiter so
// the admin secret can't be brute-forced faster than it allows.
export const isFeedbackSubmit = (req) => req.method === 'POST' && req.path === '/hinglish-feedback';

const DAY_MS = 24 * 60 * 60 * 1000;

// Politeness guard, NOT an abuse control: x-install-id is client-supplied and trivially rotated,
// so this only bounds honest clients (e.g. a retry loop bug). Keyed on install id rather than IP
// because India is heavily CGNAT'd on mobile carriers and a tight per-IP cap would block real
// users. The app also caps asks via hinglish_feedback_max_asks_per_30d.
const feedbackLimiter = rateLimit({
    windowMs: DAY_MS,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-install-id'] || req.headers['do-connecting-ip'] || req.ip,
    message: { success: false, error: 'rate_limited' },
});

// The actual ceiling, since it's keyed on something the client can't choose. Kept above plausible
// CGNAT collision (only thumbs-down submits, and the app caps asks per user) — an attacker with
// the app's secret is bounded by this, not by the limiter above. Note x-feedback-secret ships in
// the app binary and is extractable; this is defense in depth against casual abuse, not a hard
// security boundary. That would need App Attest.
const feedbackIpLimiter = rateLimit({
    windowMs: DAY_MS,
    limit: 50,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['do-connecting-ip'] || req.ip,
    message: { success: false, error: 'rate_limited' },
});

function safeEqual(a, b) {
    const ab = Buffer.from(String(a ?? ''));
    const bb = Buffer.from(String(b ?? ''));
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requireFeedbackSecret(req, res, next) {
    if (!feedbackSecret) {
        return res.status(503).send({ success: false, error: 'feedback_not_configured' });
    }
    if (!safeEqual(req.headers['x-feedback-secret'], feedbackSecret)) {
        return res.status(401).send({ success: false, error: 'unauthorized' });
    }
    next();
}

function requireFeedbackAdminSecret(req, res, next) {
    // Refuse to run with a shared or missing admin secret — falling back to the client secret here
    // would silently let anyone who extracted the app binary list user audio.
    if (!feedbackAdminSecret || feedbackAdminSecret === feedbackSecret) {
        return res.status(503).send({ success: false, error: 'feedback_admin_not_configured' });
    }
    if (!safeEqual(req.headers['x-feedback-admin-secret'], feedbackAdminSecret)) {
        return res.status(401).send({ success: false, error: 'unauthorized' });
    }
    next();
}

const isDateString = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// The S3 client, bucket, and signed-GET helper belong to app.js (they predate this module and the
// music route shares them), so they're injected rather than imported.
export function createHinglishFeedbackRouter({ s3Client, spacesBucket, signedUrlExpiration, generateSignedUrl }) {
    async function putJson(key, value) {
        await s3Client.send(new PutObjectCommand({
            Bucket: spacesBucket,
            Key: key,
            Body: JSON.stringify(value),
            ContentType: 'application/json',
        }));
    }

    async function readJson(key) {
        try {
            const output = await s3Client.send(new GetObjectCommand({ Bucket: spacesBucket, Key: key }));
            return JSON.parse(await output.Body.transformToString());
        } catch (error) {
            console.error(`Error reading ${key}:`, error);
            return null;
        }
    }

    async function postHinglishFeedback(req, res) {
        if (!s3Client || !spacesBucket) {
            return res.status(503).json({ success: false, error: 'storage_not_configured' });
        }

        const body = req.body || {};
        const { language } = body;
        const issues = Array.isArray(body.issues) ? [...new Set(body.issues)] : [];

        if (!FEEDBACK_LANGUAGES.includes(language)) {
            return res.status(400).json({ success: false, error: 'invalid_language' });
        }
        if (issues.some((issue) => !FEEDBACK_ISSUES.includes(issue))) {
            return res.status(400).json({ success: false, error: 'invalid_issue' });
        }
        // Submits are thumbs-down by definition — thumbs-up is an Amplitude event only and never
        // reaches this endpoint — so a record without issues has nothing to say.
        if (issues.length === 0) {
            return res.status(400).json({ success: false, error: 'issues_required' });
        }

        // Size is signed into the presigned PUT below, so the client must declare it up front.
        // This is the only hard cap available: a presigned PUT can't carry a content-length-range
        // policy the way a presigned POST can, and without it any holder of the app's secret could
        // upload arbitrarily large objects onto our storage bill.
        const audioConsented = body.audioConsented === true;
        const audioBytes = body.audioBytes;
        if (audioConsented) {
            if (!Number.isInteger(audioBytes) || audioBytes <= 0) {
                return res.status(400).json({ success: false, error: 'audio_bytes_required' });
            }
            if (audioBytes > feedbackMaxAudioBytes) {
                return res.status(413).json({
                    success: false,
                    error: 'audio_too_large',
                    maxAudioBytes: feedbackMaxAudioBytes,
                });
            }
        }

        const feedbackId = randomUUID();
        const createdAt = new Date();
        const date = createdAt.toISOString().slice(0, 10);
        // Deterministic, so object existence IS the upload status — no callback to lose, and no
        // orphan records if the app is killed mid-upload.
        const mediaKey = audioConsented ? `${FEEDBACK_PREFIX}/media/${date}/${feedbackId}.m4a` : null;

        const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
        const record = {
            feedbackId,
            createdAt: createdAt.toISOString(),
            issues,
            language,
            model: str(body.model, 64),
            audioConsented,
            mediaKey,
            audioBytes: audioConsented ? audioBytes : null,
            transcript: body.transcript ?? null,
            appVersion: str(body.appVersion, 32),
            region: str(body.region, 8),
            locale: str(body.locale, 32),
            durationSec: typeof body.durationSec === 'number' ? body.durationSec : null,
        };

        try {
            await putJson(`${FEEDBACK_PREFIX}/records/${feedbackId}.json`, record);
            // One pointer per issue — issues are multi-select, so a record can appear under
            // several. The date sits in the key so a listing can range-filter without object reads.
            await Promise.all(issues.map((issue) => putJson(
                `${FEEDBACK_PREFIX}/by-issue/${issue}/${date}/${feedbackId}.json`,
                { feedbackId, createdAt: record.createdAt, mediaKey },
            )));

            // ContentLength is part of the signature, so the upload only succeeds at exactly the
            // size declared and validated above — the client can't inflate it after the fact.
            const putUrl = audioConsented
                ? await getSignedUrl(s3Client, new PutObjectCommand({
                    Bucket: spacesBucket,
                    Key: mediaKey,
                    ContentType: 'audio/m4a',
                    ContentLength: audioBytes,
                }), { expiresIn: signedUrlExpiration })
                : null;

            return res.status(200).json({
                success: true,
                feedbackId,
                mediaKey,
                putUrl,
                maxAudioBytes: feedbackMaxAudioBytes,
            });
        } catch (error) {
            console.error('Error in postHinglishFeedback:', error);
            return res.status(500).json({ success: false, error: 'failed to store feedback' });
        }
    }

    async function listHinglishFeedback(req, res) {
        if (!s3Client || !spacesBucket) {
            return res.status(503).json({ success: false, error: 'storage_not_configured' });
        }

        const { issue, from, to } = req.query;
        if (issue !== undefined && !FEEDBACK_ISSUES.includes(issue)) {
            return res.status(400).json({ success: false, error: 'invalid_issue' });
        }
        if ((from !== undefined && !isDateString(from)) || (to !== undefined && !isDateString(to))) {
            return res.status(400).json({ success: false, error: 'invalid_date' });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);

        // The crucial query — "every clip where English came out in Devanagari" — is one prefix
        // list. Without an issue we fall back to listing records/, a scan but fine at this volume.
        const prefix = issue
            ? `${FEEDBACK_PREFIX}/by-issue/${issue}/`
            : `${FEEDBACK_PREFIX}/records/`;

        try {
            const entries = [];
            let token;
            do {
                const page = await s3Client.send(new ListObjectsV2Command({
                    Bucket: spacesBucket,
                    Prefix: prefix,
                    ContinuationToken: token,
                }));
                for (const object of page.Contents || []) {
                    const parts = object.Key.slice(prefix.length).split('/');
                    // In by-issue mode the date is in the key; in scan mode fall back to
                    // LastModified so from/to filtering behaves the same either way.
                    const date = issue ? parts[0] : (object.LastModified?.toISOString().slice(0, 10) ?? '');
                    entries.push({
                        feedbackId: parts[parts.length - 1].replace(/\.json$/, ''),
                        date,
                        sortKey: issue ? date : (object.LastModified?.toISOString() ?? ''),
                    });
                }
                token = page.IsTruncated ? page.NextContinuationToken : undefined;
            } while (token);

            const matched = entries.filter((entry) =>
                (!from || entry.date >= from) && (!to || entry.date <= to));
            matched.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

            const records = await Promise.all(matched.slice(0, limit).map(async (entry) => {
                const record = await readJson(`${FEEDBACK_PREFIX}/records/${entry.feedbackId}.json`);
                if (!record) return null;
                return {
                    ...record,
                    mediaUrl: record.mediaKey ? await generateSignedUrl(record.mediaKey) : null,
                };
            }));

            const found = records.filter(Boolean);
            return res.status(200).json({
                success: true,
                total: matched.length,
                returned: found.length,
                records: found,
            });
        } catch (error) {
            console.error('Error in listHinglishFeedback:', error);
            return res.status(500).json({ success: false, error: 'failed to list feedback' });
        }
    }

    const router = express.Router();
    // Submit carries its own json parser so the untrusted body is capped at 2mb — the router must
    // be mounted before the app's global 1000mb parser for that to matter.
    router.post(
        '/hinglish-feedback',
        feedbackIpLimiter,
        feedbackLimiter,
        requireFeedbackSecret,
        express.json({ limit: '2mb' }),
        postHinglishFeedback,
    );
    router.get('/hinglish-feedback', requireFeedbackAdminSecret, listHinglishFeedback);
    return router;
}
