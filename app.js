import 'dotenv/config';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { rateLimit } from 'express-rate-limit';
import queryString from 'query-string';
import { readFile } from 'fs/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHinglishFeedbackRouter } from './hinglishFeedback.js';

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
    // SDK v3 ≥3.700 attaches x-amz-checksum-crc32 to every PutObject by default; DO Spaces
    // rejects it and the write 500s. Never surfaced before the feedback routes because the
    // music route only presigns (offline crypto, no actual S3 request). WHEN_REQUIRED is the
    // documented setting for S3-compatible providers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
}) : null;

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


// Mounted before the global 1000mb json parser so the router can cap its untrusted body at 2mb.
// Rides the per-class defaultLimiter above (10/min per IP) plus its own daily budgets inside the
// router — with per-class buckets there is no shared limiter for a transcription to starve, so
// no exemption is needed. generateSignedUrl is wrapped in a closure because the const isn't
// initialized until further down this module; by request time it is.
app.use(createHinglishFeedbackRouter({
    s3Client,
    spacesBucket,
    signedUrlExpiration,
    generateSignedUrl: (key) => generateSignedUrl(key),
}));

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

app.listen(port, () => {
    console.log(`Proxy agent started: http://localhost:${port}`)
});
