# OpenAI Proxy Docker
openai-proxy-docker provides an OpenAI API proxy server image by [Docker](https://hub.docker.com/r/shawnai/openai-proxy-docker)


## How to use
Just:

```shell
sudo docker run -d -p 9017:9017 shawnai/openai-proxy-docker:latest
```

Then, you can use it by ```YOURIP:9017```

> For example, the proxied OpenAI Chat Completion API will be: ```YOURIP:9017/v1/chat/completions```
> 
> It should be the same as ```api.openai.com/v1/chat/completions```

For detailed usage of OpenAI API, please check: [API Reference](https://platform.openai.com/docs/api-reference/introduction)

You can change default port and default target by setting `-e` in docker, which means that you can use it for any backend followed by OpenAPI format:
| Parameter | Default Value |
| ----- | ----- |
| PORT | 9017 |
| TARGET | https://api.openai.com |

If you want to check detailed about API, you can star my another repo [OpenApiWiki](https://github.com/k8rw/openapi-wiki) and [Demo](https://www.openapi.wiki/openai)

## Hinglish transcription feedback

Collects real problem clips for Hindi/Urdu transcription from the Auto Caption app, keyed by what
the user said was wrong, so they can become regression fixtures for `BatchProcessorCLI`.
Full design: `shorts-caption/docs/hinglish_feedback_plan.md`.

Auth is split on purpose. `POST` takes `x-feedback-secret`, which ships inside the app binary and
is therefore extractable — treat it as a deterrent, not a boundary; abuse is bounded by the IP
limiter and the signed size cap. `GET` returns full transcripts and presigned audio URLs, so it
takes a separate `x-feedback-admin-secret` that must never ship in a client. The route refuses to
serve (503) if the admin secret is unset or equal to the client secret.

### `POST /hinglish-feedback`

Stores a thumbs-down record and returns a presigned PUT for the audio. Thumbs-up is an Amplitude
event only and never reaches the backend — a record's existence means "confirmed problem", and
Amplitude is the source of truth for overall rates.

```jsonc
// request
{ "language": "hi", "issues": ["eng_in_hindi"],
  "audioConsented": true, "audioBytes": 812340, "model": "elevenLabs", "transcript": { … },
  "appVersion": "3.6.1", "region": "IN", "locale": "hi_IN", "durationSec": 42.1 }

// response
{ "success": true, "feedbackId": "…", "mediaKey": "…", "putUrl": "…", "maxAudioBytes": 52428800 }
```

`language` ∈ `hi|ur`, `issues` ⊆ `urdu_script|eng_in_hindi|missing_eng|other` — allowlisted so a
client can't invent object prefixes. `issues` is required and non-empty. Records are stored with
or without consent (a declined-consent record still carries the transcript, which shows
`eng_in_hindi` on its own); `mediaKey`/`putUrl` are null without it.
When `audioConsented` is true, `audioBytes` is required, capped at
`HINGLISH_FEEDBACK_MAX_AUDIO_BYTES` (413 above it), and **signed into the presigned PUT as
`ContentLength`** — the upload only succeeds at exactly the declared size, so the size cap is
enforced, not advisory. Send `x-install-id` so the daily budget is keyed per install rather than
per IP.

Hindi clients may also send `hindiCaptionOutput` with `output` (`hinglish`,
`romanizedHindi`, or `english`), `selectorOpened`, and `selectorManuallyOpened`.
`hindiOutputConversionApplied` records whether conversion actually ran; the initial
client-only selector sends `false`. These fields are stored with the record without
changing questions or eligibility. Missing fields remain null for older clients;
explicit false distinguishes an unopened selector. Urdu ignores Hindi metadata.

Run the storage compatibility tests with `node --test hinglishFeedback.test.js`.

### `GET /hinglish-feedback?issue=&from=&to=&limit=`

Returns matching records, each with a presigned `mediaUrl`. With `issue` this is a single prefix
list; without it, a scan of `records/`.

### Storage layout

```
hinglish-feedback/
  records/<feedbackId>.json                 full record + transcript
  media/<yyyy-mm-dd>/<feedbackId>.m4a
  by-issue/<issue>/<yyyy-mm-dd>/<id>.json   pointer, one per selected issue
```

Issues are multi-select, so a record appears under each one it matched. The date sits in the
pointer key so range filtering needs no object reads. There is no upload-status field — the media
key is deterministic, so object existence *is* the status.

### Rate limits

Both routes ride the app's per-class `defaultLimiter` (10/min per IP) — with per-class buckets
there is no shared limiter for a transcription to starve, so no exemption is needed, and the
admin secret can't be brute-forced faster than 10/min. On top of that, POST has two 24h windows:

| Limiter | Key | Limit |
| ----- | ----- | ----- |
| per install | `x-install-id`, falling back to IP | 5 |
| per IP | `do-connecting-ip` | 50 |

The per-install budget is a politeness guard for honest clients only — `x-install-id` is
client-supplied and trivially rotated. The per-IP ceiling is the actual abuse bound, since it's
keyed on something the client can't choose; it's kept above plausible CGNAT collision (India's
mobile carriers share egress IPs heavily, and only thumbs-down submits reach this route) but low
enough to bound a secret-extracting attacker. Note the limiter store is in-memory, so counters
reset on redeploy.

### Environment

| Parameter | Default |
| ----- | ----- |
| HINGLISH_FEEDBACK_SECRET | *(required — POST returns 503 without it)* |
| HINGLISH_FEEDBACK_ADMIN_SECRET | *(required for GET — 503 if unset or equal to the client secret)* |
| HINGLISH_FEEDBACK_MAX_AUDIO_BYTES | 52428800 |
| FEEDBACK_SPACES_BUCKET | falls back to `DO_SPACES_BUCKET` |
| FEEDBACK_SPACES_ACCESS_KEY_ID | falls back to the main key |
| FEEDBACK_SPACES_SECRET_ACCESS_KEY | falls back to the main key |

Feedback storage lives in its own bucket with its own scoped read/write key so the main
`DO_SPACES_*` key can stay **read-only** (it only presigns music GETs) — a proxy-side bug can
never touch music assets, and feedback abuse is jailed to a bucket containing nothing else.
Endpoint/region are shared with the main config.

## How to maintain
Use PM2 to scale up this proxy application accross CPU(s):
- Listing managed processes
> ```shell
> docker exec -it <container-id> pm2 list
> ```
- Monitoring CPU/Usage of each process
> ```shell
> docker exec -it <container-id> pm2 monit
> ```
- 0sec downtime reload all applications
> ```shell
> docker exec -it <container-id> pm2 reload all
> ```

## How to dev

It can be easily modified by Github codespaces:
1. Fork this repo and create a codespace;
2. Wait for env ready in your browser;
3. `npm install ci`
4. `npm start`

And then, the codespace will provide a forward port (default 9017) for you to check the running.

If everything is OK, check the docker by:
```
docker build .
```

## Hindi caption conversion

Converts a Hindi (Devanagari) transcript's word list into romanized Hinglish or an English
translation for the Auto Caption app's Hindi caption output selector. Word-aligned so the client
can keep its per-word timings. Models: `HINDI_CONVERT_MODEL` (default `gpt-5.6-luna`) with one
retry per chunk on `HINDI_CONVERT_FALLBACK_MODEL` (default `gpt-5.6-terra`) when the output
fails alignment validation or times out (12s). Words are chunked server-side (~50, sentence
aligned) and run in parallel (max 8).

### `POST /hindi/convert`

Headers: `content-type: application/json`, `x-install-id` (8–64 chars, required).
Body: `{ "mode": "romanize" | "translate", "words": string[] }` — 1..1500 words, ≤64 chars each,
256kb body cap.

```jsonc
// romanize → one Latin token per input word, Latin-script input returned verbatim
{ "success": true, "mode": "romanize", "model": "gpt-5.6-luna", "words": ["aaj", "hum", …] }

// translate → words are the translation split on spaces; src = 0-based input indices
{ "success": true, "mode": "translate", "model": "gpt-5.6-luna",
  "translation": "Today we will …", "words": [{ "en": "Today", "src": [0] }, …] }
```

Errors: 400 `install_id_required` / `invalid_mode` / `words_required`, 413 `too_many_words`,
429 `rate_limited` (6/min per IP, 10/min and 60/day per install), 502 `conversion_failed`
(both models failed — the app keeps Devanagari), 503 `not_configured` (no `OPENAI_API_KEY`).
Logs one line per request (mode, models, chunks, words, latency, tokens); never transcript content.
