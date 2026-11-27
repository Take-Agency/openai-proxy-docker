// AI Edit "Report a problem" (shorts-caption #192). A user flags a bad AI Edit answer and says
// why; the app sends the last few messages of the conversation and the captions involved, so a
// failure can be read and fixed instead of guessed at.
//
// Storage is bucket-only, in the feedback bucket next to hinglish-feedback:
//   ai-edit-reports/<date>/<id>.json   one record per report
//
// The client authenticates with the same x-feedback-secret as Hinglish feedback (it ships in the
// app binary, so it only deters drive-by traffic); the real bounds are the per-install and per-IP
// daily limits and the body cap.

import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const REPORT_PREFIX = 'ai-edit-reports';
const DAY_MS = 24 * 60 * 60 * 1000;
// Dennis: at most 10 messages, so a long conversation isn't uploaded whole.
const MAX_CONVERSATION = 10;
const MAX_LINE_CHARS = 2000;
const MAX_NOTE_CHARS = 2000;
const MAX_CONTACT_CHARS = 200;
const MAX_SNAPSHOT_CHARS = 40_000;

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

function safeEqual(a, b) {
    const ab = Buffer.from(String(a ?? ''));
    const bb = Buffer.from(String(b ?? ''));
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createAIEditReportRouter({ s3Client, spacesBucket, feedbackSecret = process.env.HINGLISH_FEEDBACK_SECRET }) {
    const router = express.Router();

    // Politeness guard keyed on the install (client-chosen, so not an abuse control) and the
    // real ceiling keyed on the IP, as in hinglishFeedback.js.
    const installLimiter = rateLimit({
        windowMs: DAY_MS,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: (req) => req.headers['x-install-id'] || req.headers['do-connecting-ip'] || req.ip,
        message: { success: false, error: 'rate_limited' },
    });
    const ipLimiter = rateLimit({
        windowMs: DAY_MS,
        limit: 50,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: (req) => req.headers['do-connecting-ip'] || req.ip,
        message: { success: false, error: 'rate_limited' },
    });

    function requireSecret(req, res, next) {
        if (!feedbackSecret) return res.status(503).json({ success: false, error: 'feedback_not_configured' });
        if (!safeEqual(req.headers['x-feedback-secret'], feedbackSecret)) {
            return res.status(401).json({ success: false, error: 'unauthorized' });
        }
        next();
    }

    const arms = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const entries = Object.entries(value)
            .filter(([name, arm]) => /^[a-z0-9_]{1,40}$/.test(name) && typeof arm === 'string' && arm.length <= 40)
            .slice(0, 10);
        return entries.length ? Object.fromEntries(entries) : null;
    };

    async function postReport(req, res) {
        if (!s3Client || !spacesBucket) {
            return res.status(503).json({ success: false, error: 'storage_not_configured' });
        }
        const body = req.body || {};
        const { conversation } = body;
        const validConversation = Array.isArray(conversation) && conversation.length > 0
            && conversation.length <= MAX_CONVERSATION
            && conversation.every((line) => typeof line === 'string' && line.length > 0 && line.length <= MAX_LINE_CHARS);
        if (!validConversation) return res.status(400).json({ success: false, error: 'invalid_conversation' });
        if (body.note != null && (typeof body.note !== 'string' || body.note.length > MAX_NOTE_CHARS)) {
            return res.status(400).json({ success: false, error: 'invalid_note' });
        }
        if (body.contact != null && (typeof body.contact !== 'string' || body.contact.length > MAX_CONTACT_CHARS)) {
            return res.status(400).json({ success: false, error: 'invalid_contact' });
        }
        if (body.snapshot != null && (typeof body.snapshot !== 'string' || body.snapshot.length > MAX_SNAPSHOT_CHARS)) {
            return res.status(400).json({ success: false, error: 'invalid_snapshot' });
        }

        const reportId = randomUUID();
        const createdAt = new Date();
        const key = `${REPORT_PREFIX}/${createdAt.toISOString().slice(0, 10)}/${reportId}.json`;
        const record = {
            reportId,
            createdAt: createdAt.toISOString(),
            installId: str(req.headers['x-install-id'], 128),
            note: body.note?.trim() || null,
            contact: body.contact?.trim() || null,
            // the reported answer is the last line
            conversation,
            snapshot: body.snapshot ?? null,
            model: str(body.model, 64),
            appVersion: str(body.appVersion, 32),
            locale: str(body.locale, 32),
            // the A/B arms the reporter is in ({ ai_edit_start_tool: 'style' }), so feedback can be
            // read per arm; anything that isn't a few short strings is left out, not an error
            arms: arms(body.arms),
        };
        try {
            await s3Client.send(new PutObjectCommand({
                Bucket: spacesBucket,
                Key: key,
                Body: JSON.stringify(record),
                ContentType: 'application/json',
            }));
        } catch (error) {
            console.error(`edit/report store_failed ${reportId}:`, error);
            return res.status(502).json({ success: false, error: 'store_failed' });
        }
        // never the text: ids and sizes only
        console.log(`edit/report ok id=${reportId} lines=${conversation.length} note=${record.note ? record.note.length : 0} contact=${record.contact ? 1 : 0} snapshotChars=${record.snapshot ? record.snapshot.length : 0}`);
        return res.status(200).json({ success: true, reportId });
    }

    router.post('/edit/report', express.json({ limit: '96kb' }), requireSecret, installLimiter, ipLimiter, postReport);
    return router;
}
