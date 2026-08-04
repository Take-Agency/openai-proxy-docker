import 'dotenv/config';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { rateLimit } from 'express-rate-limit';
import queryString from 'query-string';
import { readFile } from 'fs/promises';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const allowedTargets = [
    'https://api.openai.com/',
    'https://api.elevenlabs.io/',
    'https://api.cleanvoice.ai/',
    'https://openapi-proxy-zmg9c.ondigitalocean.app/',
];

const app = express();
const port = process.env.PORT || 9017;
const target = process.env.TARGET || 'https://api.openai.com';
const openaiApiKey = process.env.OPENAI_API_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const cleanvoiceApiKey = process.env.CLEANVOICE_API_KEY;

// DigitalOcean Spaces configuration
const spacesEndpoint = process.env.DO_SPACES_ENDPOINT; // e.g., 'nyc3.digitaloceanspaces.com'
const spacesRegion = process.env.DO_SPACES_REGION || 'nyc3';
const spacesAccessKeyId = process.env.DO_SPACES_ACCESS_KEY_ID;
const spacesSecretAccessKey = process.env.DO_SPACES_SECRET_ACCESS_KEY;
const spacesBucket = process.env.DO_SPACES_BUCKET;
const signedUrlExpiration = parseInt(process.env.DO_SIGNED_URL_EXPIRATION || '3600', 10); // Default 1 hour

// Initialize S3 client for DigitalOcean Spaces
const s3Client = spacesEndpoint && spacesAccessKeyId && spacesSecretAccessKey ? new S3Client({
    endpoint: `https://${spacesEndpoint}`,
    region: spacesRegion,
    credentials: {
        accessKeyId: spacesAccessKeyId,
        secretAccessKey: spacesSecretAccessKey,
    },
    forcePathStyle: false, // DigitalOcean Spaces uses virtual-hosted-style URLs
}) : null;

// Hinglish transcription feedback (see shorts-caption docs/hinglish_feedback_plan.md).
// Collects real problem clips for Hindi/Urdu transcription, keyed by what the user said was wrong.
const feedbackSecret = process.env.HINGLISH_FEEDBACK_SECRET;
const feedbackMaxAudioBytes = parseInt(process.env.HINGLISH_FEEDBACK_MAX_AUDIO_BYTES || '52428800', 10); // 50 MiB
const FEEDBACK_PREFIX = 'hinglish-feedback';
// Allowlisted so a client can never invent prefixes and scatter objects through the bucket.
const FEEDBACK_ISSUES = ['urdu_script', 'eng_in_hindi', 'missing_eng', 'other'];
const FEEDBACK_LANGUAGES = ['hi', 'ur'];
const FEEDBACK_RATINGS = ['up', 'down'];

// Helper function to get target URL from request
const getTargetUrl = (req) => req.headers['x-target-url'] || target;

// Per-request-class rate limits (each per-IP, 1-minute window, independent counters).
// A single global bucket meant one feature's burst starved every other feature — e.g. a
// Cleanup Audio run (two POSTs) plus an import's title generation emptied the music list.
// Separate buckets keep each request class abuse-protected on its own budget.
const makeLimiter = (limit) => rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-7', // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
    keyGenerator: (req, res) => req.headers['do-connecting-ip'] || req.ip,
});

const sttLimiter = makeLimiter(3);        // ElevenLabs speech-to-text — the most expensive call
const chatLimiter = makeLimiter(6);       // OpenAI title generation (imports get double-tapped)
const cleanvoiceLimiter = makeLimiter(6); // Cleanup Audio: one run = upload-url POST + create-edit POST
const musicLimiter = makeLimiter(20);     // our own static catalog; cheap but not free
const defaultLimiter = makeLimiter(10);   // anything unclassified

const limiterFor = (req) => {
    const targetUrl = getTargetUrl(req);
    // Cleanvoice edit-status polling (GET /v2/edits/:id) fires every ~2s while a job runs;
    // it's a cheap read against our own edit, so it is never counted.
    if (req.method === 'GET' && targetUrl.includes('api.cleanvoice.ai') && req.path.startsWith('/v2/edits/')) {
        return null;
    }
    if (targetUrl.includes('api.cleanvoice.ai')) return cleanvoiceLimiter;
    if (targetUrl.includes('api.elevenlabs.io')) return sttLimiter;
    if (req.method === 'GET' && req.path === '/music') return musicLimiter;
    if (req.path === '/v1/chat/completions') return chatLimiter;
    return defaultLimiter;
};

// Apply the class-appropriate rate limiter to every request.
app.use((req, res, next) => {
    const limiter = limiterFor(req);
    if (!limiter) return next();
    return limiter(req, res, next);
});

const DAY_MS = 24 * 60 * 60 * 1000;

// The real throttle for feedback submits. Keyed on install id, NOT IP: India is heavily CGNAT'd
// on mobile carriers, so a per-IP daily cap would silently block legitimate feedback in exactly
// the market this serves. The app also caps asks client-side; this is the server-side backstop.
// The per-class defaultLimiter above still applies per-IP per-minute on top of these.
const feedbackLimiter = rateLimit({
    windowMs: DAY_MS,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-install-id'] || req.headers['do-connecting-ip'] || req.ip,
    message: { success: false, error: 'rate_limited' },
});

// Abuse ceiling only — deliberately loose so shared mobile egress IPs don't collide.
const feedbackIpLimiter = rateLimit({
    windowMs: DAY_MS,
    limit: 200,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['do-connecting-ip'] || req.ip,
    message: { success: false, error: 'rate_limited' },
});

// Feedback routes are registered before the global 1000mb json parser so they can enforce a much
// tighter body cap — they're the only routes reachable with an untrusted body.
app.post(
    '/hinglish-feedback',
    feedbackIpLimiter,
    feedbackLimiter,
    requireFeedbackSecret,
    express.json({ limit: '2mb' }),
    postHinglishFeedback,
);
app.get('/hinglish-feedback', requireFeedbackSecret, listHinglishFeedback);

// parse json bodies
app.use(express.json({ limit: '1000mb' }));

// app.get('/ip', (req, res) => res.send({
//     'do-connecting-ip': req.headers['do-connecting-ip'],
//     'ip': req.ip,
// }));

app.use('/', (req, res, next) => {
    // Get the target URL from the request
    const targetUrl = getTargetUrl(req);

    // TODO: uncomment this once the app uses trailing slashes
    // TODO: looks like the proxy middleware does not like the trailing slash but we need it to prevent malicious domains, will need to strip the slash
    // const isAllowedTarget = allowedTargets.some(allowedTarget => targetUrl.startsWith(allowedTarget));
    // if (!isAllowedTarget) {
    //     return res.status(403).send({ success: false, error: 'forbidden' });
    // }

    if (targetUrl.includes('api.openai.com') && req.body.model !== 'gpt-4o') {
        console.log('suspicious OpenAI API request', req.method, req.path, req.query, req.body);
        return res.status(403).send({ success: false, error: 'forbidden' });
    }

    if (targetUrl.includes('openapi-proxy-zmg9c.ondigitalocean.app')) {
        if (req.url === '/music') {
            return getMusic(req, res);
        }
        return res.status(404).send({ success: false, error: 'not found' });
    }

    next();
}, createProxyMiddleware({
    router: getTargetUrl,
    changeOrigin: true,
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.removeHeader('x-forwarded-for');
        proxyReq.removeHeader('x-real-ip');
        proxyReq.removeHeader('x-target-url'); // Remove the custom header after using it

        // Get the target URL from the request
        const targetUrl = getTargetUrl(req);

        // Add the appropriate API key based on the target domain
        if (targetUrl.includes('api.openai.com') && openaiApiKey) {
            proxyReq.setHeader('Authorization', `Bearer ${openaiApiKey}`);
        } else if (targetUrl.includes('api.elevenlabs.io') && elevenLabsApiKey) {
            proxyReq.setHeader('xi-api-key', elevenLabsApiKey);
        } else if (targetUrl.includes('api.cleanvoice.ai') && cleanvoiceApiKey) {
            proxyReq.setHeader('X-API-Key', cleanvoiceApiKey);
        }

        // we need to restream parsed body before proxying
        if (!req.body || !Object.keys(req.body).length) {
            return;
        }

        var contentType = proxyReq.getHeader('Content-Type');
        var bodyData;

        if (contentType === 'application/json') {
            bodyData = JSON.stringify(req.body);
        }

        if (contentType === 'application/x-www-form-urlencoded') {
            bodyData = queryString.stringify(req.body);
        }

        if (bodyData) {
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
        }
    },
    onProxyRes: function (proxyRes, req, res) {
        proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    }
}));

const getMusic = async (req, res) => {
    try {
        // Read and parse the music index JSON
        const musicIndexJson = await readFile('./music_index.json', 'utf8');
        const musicData = JSON.parse(musicIndexJson);

        // If S3 client is configured, generate signed URLs for all tracks
        if (s3Client && spacesBucket && musicData.tracks) {
            // Generate all signed URLs in parallel for better performance
            const urlPromises = musicData.tracks.flatMap(track => {
                const promises = [];
                if (track.audio_url) {
                    promises.push(
                        generateSignedUrl(track.audio_url).then(url => { track.audio_url = url; })
                    );
                }
                if (track.cover_url) {
                    promises.push(
                        generateSignedUrl(track.cover_url).then(url => { track.cover_url = url; })
                    );
                }
                if (track.detail_url) {
                    promises.push(
                        generateSignedUrl(track.detail_url).then(url => { track.detail_url = url; })
                    );
                }
                return promises;
            });

            await Promise.all(urlPromises);
        }

        return res.status(200).json(musicData);
    } catch (error) {
        console.error('Error in getMusic:', error);
        return res.status(500).json({ success: false, error: 'failed to load music data' });
    }
}

const generateSignedUrl = async (key) => {
    if (!s3Client || !spacesBucket) {
        return key; // Return original path if S3 is not configured
    }

    try {
        const command = new GetObjectCommand({
            Bucket: spacesBucket,
            Key: key,
        });
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: signedUrlExpiration });
        return signedUrl;
    } catch (error) {
        console.error(`Error generating signed URL for ${key}:`, error);
        return key; // Return original path on error
    }
}

// --- Hinglish transcription feedback ---------------------------------------------------------
// Handlers are function declarations (not const arrows) because they're referenced by the route
// registrations near the top of the file, which evaluate at module load.

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

const isDateString = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

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
    const { rating, language } = body;
    const issues = Array.isArray(body.issues) ? [...new Set(body.issues)] : [];

    if (!FEEDBACK_RATINGS.includes(rating)) {
        return res.status(400).json({ success: false, error: 'invalid_rating' });
    }
    if (!FEEDBACK_LANGUAGES.includes(language)) {
        return res.status(400).json({ success: false, error: 'invalid_language' });
    }
    if (issues.some((issue) => !FEEDBACK_ISSUES.includes(issue))) {
        return res.status(400).json({ success: false, error: 'invalid_issue' });
    }
    if (rating === 'down' && issues.length === 0) {
        return res.status(400).json({ success: false, error: 'issues_required' });
    }

    const feedbackId = randomUUID();
    const createdAt = new Date();
    const date = createdAt.toISOString().slice(0, 10);
    const audioConsented = body.audioConsented === true;
    // Deterministic, so object existence IS the upload status — no callback to lose, and no orphan
    // records if the app is killed mid-upload.
    const mediaKey = audioConsented ? `${FEEDBACK_PREFIX}/media/${date}/${feedbackId}.m4a` : null;

    const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
    const record = {
        feedbackId,
        createdAt: createdAt.toISOString(),
        rating,
        issues,
        language,
        model: str(body.model, 64),
        audioConsented,
        mediaKey,
        transcript: body.transcript ?? null,
        appVersion: str(body.appVersion, 32),
        region: str(body.region, 8),
        locale: str(body.locale, 32),
        durationSec: typeof body.durationSec === 'number' ? body.durationSec : null,
    };

    try {
        await putJson(`${FEEDBACK_PREFIX}/records/${feedbackId}.json`, record);
        // One pointer per issue — issues are multi-select, so a record can appear under several.
        // The date sits in the key so a listing can range-filter without reading any objects.
        await Promise.all(issues.map((issue) => putJson(
            `${FEEDBACK_PREFIX}/by-issue/${issue}/${date}/${feedbackId}.json`,
            { feedbackId, createdAt: record.createdAt, mediaKey },
        )));

        const putUrl = audioConsented
            ? await getSignedUrl(s3Client, new PutObjectCommand({
                Bucket: spacesBucket,
                Key: mediaKey,
                ContentType: 'audio/m4a',
            }), { expiresIn: signedUrlExpiration })
            : null;

        return res.status(200).json({
            success: true,
            feedbackId,
            mediaKey,
            putUrl,
            // Advisory: a presigned PUT can't enforce a size cap the way a POST policy can, so the
            // client self-limits. Oversized objects are caught by the reaper, not at upload time.
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

    // The crucial query — "every clip where English came out in Devanagari" — is one prefix list.
    // Without an issue we fall back to listing records/, which is a scan but fine at this volume.
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
                entries.push({
                    feedbackId: parts[parts.length - 1].replace(/\.json$/, ''),
                    date: issue ? parts[0] : null,
                    sortKey: issue ? parts[0] : (object.LastModified?.toISOString() ?? ''),
                });
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);

        const matched = entries.filter((entry) => !issue
            || ((!from || entry.date >= from) && (!to || entry.date <= to)));
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

app.listen(port, () => {
    console.log(`Proxy agent started: http://localhost:${port}`)
});
