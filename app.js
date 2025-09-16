import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { rateLimit } from 'express-rate-limit';

const allowedTargets = [
    'https://api.openai.com/',
    'https://api.elevenlabs.io/',
];

const app = express();
const port = process.env.PORT || 9017;
const target = process.env.TARGET || 'https://api.openai.com/';
const openaiApiKey = process.env.OPENAI_API_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;

// Helper function to get target URL from request
const getTargetUrl = (req) => req.headers['x-target-url'] || target;

const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minutes
    limit: 3, // Limit each IP to 100 requests per `window` (here, per 1 minute).
    standardHeaders: 'draft-7', // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
    // store: ... , // Redis, Memcached, etc. See below.
    keyGenerator: (req, res) => req.headers['do-connecting-ip'] || req.ip,
});

// Apply the rate limiting middleware to all requests.
app.use(limiter);
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
    // const isAllowedTarget = allowedTargets.some(allowedTarget => targetUrl.startsWith(allowedTarget));
    // if (!isAllowedTarget) {
    //     return res.status(403).send({ success: false, error: 'forbidden' });
    // }

    if (targetUrl.includes('api.openai.com')) {
        console.log('OpenAI API request', req.method, req.path, req.query, req.body);
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
        }
    },
    onProxyRes: function (proxyRes, req, res) {
        proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    }
}));

app.listen(port, () => {
    console.log(`Proxy agent started: http://localhost:${port}`)
});
