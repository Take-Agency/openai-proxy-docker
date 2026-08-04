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

Stores the record and returns a presigned PUT for the audio.

```jsonc
// request
{ "rating": "down", "language": "hi", "issues": ["eng_in_hindi"],
  "audioConsented": true, "audioBytes": 812340, "model": "elevenLabs", "transcript": { … },
  "appVersion": "3.6.1", "region": "IN", "locale": "hi_IN", "durationSec": 42.1 }

// response
{ "success": true, "feedbackId": "…", "mediaKey": "…", "putUrl": "…", "maxAudioBytes": 52428800 }
```

`rating` ∈ `up|down`, `language` ∈ `hi|ur`, `issues` ⊆ `urdu_script|eng_in_hindi|missing_eng|other`
— all allowlisted so a client can't invent object prefixes. `issues` is required when rating is
`down` and forbidden when it is `up` (keeps the by-issue index meaning "confirmed problems").
When `audioConsented` is true, `audioBytes` is required, capped at
`HINGLISH_FEEDBACK_MAX_AUDIO_BYTES` (413 above it), and **signed into the presigned PUT as
`ContentLength`** — the upload only succeeds at exactly the declared size, so the size cap is
enforced, not advisory. Send `x-install-id` so the daily budget is keyed per install rather than
per IP.

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

`POST /hinglish-feedback` (exact method + path) is exempt from the global 3/min limiter, which
ElevenLabs transcription would otherwise trip moments before a feedback submit. `GET` deliberately
stays under the global limiter so the admin secret can't be brute-forced faster than 3/min. The
POST exemption is replaced by two 24h windows:

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

Reuses the existing `DO_SPACES_*` configuration.

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