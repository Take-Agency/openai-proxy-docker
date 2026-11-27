// Runs the instruction-editing eval against a /edit/instruct endpoint and writes a markdown report
// (§5.3). Requests go out one at a time, as the app sends them, so latency is per request.
//
//   node eval/run.js --url https://…/edit/instruct --runs 5 [--cases 1-10,19] [--label name]
//                    [--rate 18] [--log /path/to/server.log] [--out dir] [--no-repair] [--local]
//   node eval/run.js --inproc --runs 5 [--groups look,pop] [--sentinel] [--concurrency 6]
//
// --inproc    runs the proxy's router in this process (no deploy, no shared rate limit): the same
//             prompt, tools and OpenAI request as staging, with the key from
//             EDIT_INSTRUCT_OPENAI_API_KEY. Records each request's token usage. Latency includes
//             this machine's network, so quote latency from staging runs.
//               EDIT_INSTRUCT_OPENAI_API_KEY="$(security find-generic-password -s autocaption-edit-instruct-openai -w)" \
//                 node eval/run.js --inproc --groups look --sentinel --runs 5 --label try-1
// --concurrency  requests in flight at once (default 6 with --inproc, else 1)
// --groups    only the cases in these groups (cases.js), e.g. look,pop,abstain
// --sentinel  adds the cases that fail most often (SENTINEL_CASES) to the selection
// --model / --fallback-model  with --inproc: the router's models (default: the router's own
//             defaults, as staging uses unless its env overrides them). Reasoning effort comes
//             from EDIT_INSTRUCT_REASONING, as on the server.
//
// --rate      requests per minute (default 18: under the proxy's 20/min per-IP limit)
// --log       the proxy's stdout when running it locally: its count-only line per request gives
//             token usage (cost) and the per-attempt failure codes behind a 502 or a fallback
// --local     localhost only: sends a synthetic do-connecting-ip per request so the per-IP limit
//             doesn't throttle a local run. Never used against staging.
// --no-repair score the first response only (by default an invalid batch gets the app's one
//             repair turn, and task success is scored on the result)
// --rescore   re-score a finished run (<out>/<label>.jsonl + .requests.jsonl) with the current
//             cases and scorer, without sending requests
// Install ids rotate over five synthetic ids per run (`eval-<label>-<run token>-<n>`), keeping each
// under the per-install minute limit; the run token keeps reruns of a label from sharing the
// 5-hour and weekly caps. A 429 for those caps stops the run instead of scoring false failures.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { run as applyCalls, snapshotText, presetCatalog } from './applier.js';
import { CASES } from './cases.js';
import { fixtureState, FONTS } from './fixtures.js';

const run = (calls, state, catalog) => applyCalls(calls, state, catalog, FONTS);
import { scoreCase } from './score.js';
import { SYSTEM_PROMPT, appToolsPrompt } from '../editInstruct.js';
import { EDIT_TOOLS, APP_TOOLS } from '../editInstructTools.js';

// The tools 4.0 (6) lists: what the app can open, and the waitlists.
const EVAL_APP_TOOLS = {
    open: ['remove_silences', 'restore_silences', 'cleanup_audio', 'undo_cleanup_audio', 'add_music', 'remove_music'],
    coming_soon: ['remove_filler', 'ai_zooms', 'ai_b_roll'],
    // the tools whose settings the app applies itself (their button runs the tool at once)
    settings: ['remove_silences', 'cleanup_audio'],
};

const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
// the app's own catalog text, looks included (InstructionEditTests.testPresetCatalog writes it);
// the id|name|category lines built here are the fallback
const CATALOG_FILE = new URL('./preset-catalog.txt', import.meta.url);
const PRESETS = existsSync(CATALOG_FILE) ? readFileSync(CATALOG_FILE, 'utf8').trim() : presetCatalog(presets);
const CLIENT_TIMEOUT_MS = 15_000; // the app's
// $ per 1M tokens: input / cached input / output (docs/instruction_editing_plan.md §2.2)
const PRICES = { 'gpt-6-luna': [0.10, 0.01, 0.50], 'gpt-5.6-luna': [0.10, 0.01, 0.50] };
const PRICE_NOTE = 'gpt-6-luna list price from the plan (§2.2); gpt-5.6-luna priced the same (not verified)';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const args = { runs: 1, rate: 18, label: 'eval', repair: true, local: false, rescore: false, inproc: false, sentinel: false };
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index].replace(/^--/, '');
        if (key === 'no-repair') args.repair = false;
        else if (key === 'local') args.local = true;
        else if (key === 'rescore') args.rescore = true;
        else if (key === 'inproc') args.inproc = true;
        else if (key === 'sentinel') args.sentinel = true;
        else args[key] = argv[++index];
    }
    if (!args.url && !args.rescore && !args.inproc) throw new Error('--url or --inproc is required');
    if (args.url && args.inproc) throw new Error('--url and --inproc are exclusive');
    args.runs = Number(args.runs);
    // in process there's no shared limit to stay under
    args.rate = args.inproc && args.rate === 18 ? Infinity : Number(args.rate);
    args.concurrency = Number(args.concurrency || (args.inproc ? 6 : 1));
    if (args.local && args.url && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(args.url)) throw new Error('--local is for localhost only');
    return args;
}

// The cases that fail most often across past runs (eval-results history, 2026-11-27): added by
// --sentinel to a group run so a change elsewhere in the prompt still meets them.
export const SENTINEL_CASES = [13, 23, 65, 91, 96, 98, 142, 149];

function selectCases({ cases: spec, groups, sentinel }) {
    if (!spec && !groups) return CASES;
    const ids = new Set(spec ? spec.split(',').flatMap((part) => {
        const [from, to] = part.split('-').map(Number);
        return Array.from({ length: (to || from) - from + 1 }, (_, index) => from + index);
    }) : []);
    const wanted = new Set(groups ? groups.split(',').map((group) => group.trim()) : []);
    const unknown = [...wanted].filter((group) => !CASES.some((testCase) => testCase.group === group));
    if (unknown.length) throw new Error(`unknown group: ${unknown.join(', ')} (groups: ${[...new Set(CASES.map((testCase) => testCase.group))].join(', ')})`);
    if (sentinel) SENTINEL_CASES.forEach((id) => ids.add(id));
    return CASES.filter((testCase) => ids.has(testCase.id) || wanted.has(testCase.group));
}

// ---------------------------------------------------------------- in process

// Mounts the proxy's router on a local port. Each request's count-only log line is caught by the
// request it belongs to (AsyncLocalStorage), so token usage is recorded with requests in parallel.
async function startInproc(args) {
    const key = process.env.EDIT_INSTRUCT_OPENAI_API_KEY;
    if (!key) throw new Error('--inproc needs EDIT_INSTRUCT_OPENAI_API_KEY (see the usage at the top)');
    const { default: express } = await import('express');
    const { createEditInstructRouter } = await import('../editInstruct.js');
    const context = new AsyncLocalStorage();
    const lines = new Map();
    const original = console.log;
    console.log = (...parts) => {
        const store = context.getStore();
        const text = parts.join(' ');
        if (store && text.startsWith('edit/instruct ')) lines.set(store, text);
        else original(...parts);
    };
    const unlimited = { fiveHour: Number.MAX_SAFE_INTEGER, week: Number.MAX_SAFE_INTEGER };
    const options = { openaiApiKey: key, planLimits: { free: unlimited, trial: unlimited, paid: unlimited } };
    if (args.model) options.primaryModel = args.model;
    if (args['fallback-model']) options.fallbackModel = args['fallback-model'];
    const app = express();
    // parsed here, outside the context: the router's own parser then skips it (req._body), so
    // nothing after this point runs in a stream callback that would lose the context
    app.use(express.json({ limit: '64kb' }));
    app.use((req, res, next) => context.run(req.headers['x-eval-sequence'], next));
    app.use(createEditInstructRouter(options));
    const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    args.url = `http://127.0.0.1:${server.address().port}/edit/instruct`;
    args.local = true;
    return {
        line: (sequence) => { const text = lines.get(String(sequence)); lines.delete(String(sequence)); return text; },
        close: () => { console.log = original; server.close(); },
    };
}

const parseLogLine = (line) => {
    if (!line) return null;
    const field = (name) => line.match(new RegExp(`\\b${name}=(\\S+)`))?.[1];
    return {
        outcome: line.split(' ')[1],
        model: field('model'),
        inputTokens: Number(field('inputTokens') || 0),
        cachedTokens: Number(field('cachedTokens') || 0),
        outputTokens: Number(field('outputTokens') || 0),
        serverLatencyMs: Number(field('latencyMs') || 0),
        failures: field('failures')?.split(',') || [],
    };
};

// ---------------------------------------------------------------- server log

// Reads the lines the proxy appended since the last call (requests are sequential, so each
// request adds exactly one `edit/instruct` line).
function logTail(path) {
    let offset = path ? statSync(path).size : 0;
    return () => {
        if (!path) return null;
        const size = statSync(path).size;
        if (size <= offset) return null;
        const buffer = Buffer.alloc(size - offset);
        const fd = openSync(path, 'r');
        readSync(fd, buffer, 0, buffer.length, offset);
        closeSync(fd);
        offset = size;
        return parseLogLine(buffer.toString('utf8').split('\n').filter((entry) => entry.startsWith('edit/instruct ')).at(-1));
    };
}

// ---------------------------------------------------------------- requests

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_TOKEN = randomBytes(3).toString('hex');

async function post(args, body, sequence) {
    // in process every request gets its own install, so nothing is throttled
    const install = args.inproc ? `eval-${RUN_TOKEN}-${sequence}` : `eval-${args.label}-${RUN_TOKEN}-${sequence % 5}`;
    const headers = { 'content-type': 'application/json', 'x-install-id': install.slice(0, 64).padEnd(8, '0'), 'x-eval-sequence': String(sequence) };
    if (args.local) headers['do-connecting-ip'] = `10.99.${Math.floor(sequence / 250) % 250}.${sequence % 250}`;
    const startedAt = Date.now();
    try {
        const response = await fetch(args.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) });
        const json = await response.json().catch(() => ({}));
        return { status: response.status, json, latencyMs: Date.now() - startedAt };
    } catch (error) {
        return { status: error.name === 'TimeoutError' ? 'client_timeout' : 'network', json: {}, latencyMs: Date.now() - startedAt };
    }
}

// Upstream failure codes from the proxy's log: timeout vs schema check vs upstream HTTP/status.
const failureKind = (code) => (code.endsWith(':timeout') ? 'timeout'
    : /:(bad_arguments|unknown_tool|no_tool_calls|too_many_calls|clarification_mixed|bad_undo)$/.test(code) ? 'schema'
        : 'upstream');

// ---------------------------------------------------------------- stats

const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : 'n/a');
const sec = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const fixed = (value, digits = 2) => (value == null ? 'n/a' : value.toFixed(digits));

function costOf(usage, model) {
    const [input, cached, output] = PRICES[model] || PRICES['gpt-6-luna'];
    return ((usage.inputTokens - usage.cachedTokens) * input + usage.cachedTokens * cached + usage.outputTokens * output) / 1e6;
}

function correlation(xs, ys) {
    const mx = mean(xs);
    const my = mean(ys);
    const cov = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0);
    const vx = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0));
    const vy = Math.sqrt(ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
    return vx && vy ? cov / (vx * vy) : null;
}

// ---------------------------------------------------------------- report

function report(args, results, requests, startedAt, finishedAt = Date.now()) {
    const planCase = (id) => id <= 50;
    const inScope = results.filter((entry) => entry.caseId <= 41);
    const abstain = results.filter((entry) => entry.caseId >= 42 && entry.caseId <= 50);
    const plan = results.filter((entry) => planCase(entry.caseId));
    const regression = results.filter((entry) => !planCase(entry.caseId));
    const successRate = (entries) => pct(entries.filter((entry) => entry.success).length, entries.length);
    const passAll = (entries) => {
        const byCase = new Map();
        for (const entry of entries) byCase.set(entry.caseId, (byCase.get(entry.caseId) ?? true) && entry.success);
        return `${[...byCase.values()].filter(Boolean).length}/${byCase.size}`;
    };
    const first = requests.filter((entry) => !entry.repair);
    const latencies = first.map((entry) => entry.latencyMs);
    const status502 = requests.filter((entry) => entry.status === 502).length;
    const withUsage = requests.filter((entry) => entry.log);
    const totalCost = withUsage.reduce((sum, entry) => sum + costOf(entry.log, entry.log.model), 0);
    const costPerEdit = withUsage.length ? totalCost / first.filter((entry) => entry.log).length : null;
    const models = [...new Set(requests.map((entry) => entry.json?.model).filter(Boolean))];
    const pr = (id) => {
        const entries = results.filter((entry) => entry.caseId === id && entry.precision != null);
        return entries.length ? `${fixed(mean(entries.map((entry) => entry.precision)))} / ${fixed(mean(entries.map((entry) => entry.recall)))}` : 'n/a';
    };
    const collateralRuns = plan.filter((entry) => entry.collateral.length).length;
    const inScopeRate = inScope.filter((entry) => entry.success).length / (inScope.length || 1);
    const abstainRate = abstain.filter((entry) => entry.success).length / (abstain.length || 1);
    const p95 = percentile(latencies, 95);

    const lines = [];
    lines.push(`# Instruction edit eval: ${args.label}`, '');
    lines.push(`- Endpoint: \`${args.url}\``);
    lines.push(`- Models answering: ${models.join(', ') || 'n/a'} · runs per case: ${args.runs} · cases: ${new Set(results.map((entry) => entry.caseId)).size}`);
    lines.push(`- Prompt + tools hash (local files): \`${createHash('sha256').update(SYSTEM_PROMPT + appToolsPrompt({ ...EVAL_APP_TOOLS, comingSoon: EVAL_APP_TOOLS.coming_soon, state: {} }) + JSON.stringify([...EDIT_TOOLS, ...APP_TOOLS])).digest('hex').slice(0, 10)}\` · repair turn: ${args.repair ? 'on' : 'off'}`);
    lines.push(`- Started ${new Date(startedAt).toISOString()}, ${requests.length} requests, ${((finishedAt - startedAt) / 60000).toFixed(1)} min`, '');

    lines.push('## Summary', '', '| Metric | Value | Ship bar |', '|---|---|---|');
    lines.push(`| Valid, first response (schema + app validator), 1–50 / all | ${pct(plan.filter((entry) => entry.validFirst).length, plan.length)} / ${pct(results.filter((entry) => entry.validFirst).length, results.length)} | ≥ 99% |`);
    lines.push(`| Valid after the repair turn, 1–50 / all | ${pct(plan.filter((entry) => entry.validFinal).length, plan.length)} / ${pct(results.filter((entry) => entry.validFinal).length, results.length)} | |`);
    lines.push(`| Task success, in scope (1–41) | ${successRate(inScope)} | ≥ 90% ${inScopeRate >= 0.9 ? 'PASS' : 'FAIL'} |`);
    lines.push(`| Correct abstention (42–50) | ${successRate(abstain)} | ≥ 95% ${abstainRate >= 0.95 ? 'PASS' : 'FAIL'} |`);
    lines.push(`| Collateral damage (runs, 1–50) | ${pct(collateralRuns, plan.length)} | ≤ 1% ${collateralRuns / (plan.length || 1) <= 0.01 ? 'PASS' : 'FAIL'} |`);
    lines.push(`| Precision / recall, case 19 (fillers) | ${pr(19)} | |`);
    lines.push(`| Precision / recall, case 27 (F2 "like") | ${pr(27)} | ≥ 0.9 / ≥ 0.8 |`);
    lines.push(`| Over-asking (ask_clarification where the case accepts none), all cases | ${pct(results.filter((entry) => entry.overAsked).length, results.length)} (${results.filter((entry) => entry.overAsked).length}) | |`);
    lines.push(`| pass^${args.runs}, in scope / abstention | ${passAll(inScope)} / ${passAll(abstain)} | |`);
    for (const group of [...new Set(regression.map((entry) => CASES.find((item) => item.id === entry.caseId).group))]) {
        const entries = regression.filter((entry) => CASES.find((item) => item.id === entry.caseId).group === group);
        lines.push(`| Added cases: ${group} (${[...new Set(entries.map((entry) => entry.caseId))].join(', ')}) | ${successRate(entries)} | |`);
    }
    lines.push(`| Latency p50 / p95 / max (client, first request) | ${sec(percentile(latencies, 50))} / ${sec(p95)} / ${sec(Math.max(...latencies))} | p95 ≤ 5s ${p95 != null && p95 <= 5000 ? 'PASS' : 'FAIL'} |`);
    lines.push(`| 502 rate (both models failed) | ${pct(status502, requests.length)} (${status502}) | |`);
    lines.push(`| Answered by the fallback model | ${pct(requests.filter((entry) => entry.log?.outcome === 'ok' && entry.log.failures.length).length, withUsage.length)} | |`);
    lines.push(`| Cost per edit (mean, incl. repairs) / per 100k edits | ${costPerEdit == null ? 'n/a (no server log)' : `$${(costPerEdit).toFixed(6)} / $${(costPerEdit * 1e5).toFixed(2)}`} | |`);
    lines.push(`| Total cost of this run | ${withUsage.length ? `$${totalCost.toFixed(4)}` : 'n/a'} | |`);
    lines.push('');
    if (withUsage.length) {
        lines.push(`Tokens per request (mean): input ${fixed(mean(withUsage.map((entry) => entry.log.inputTokens)), 0)}, cached ${fixed(mean(withUsage.map((entry) => entry.log.cachedTokens)), 0)}, output ${fixed(mean(withUsage.map((entry) => entry.log.outputTokens)), 0)}. ${PRICE_NOTE}.`, '');
    }

    // failure codes
    const codes = new Map();
    for (const entry of requests) {
        const add = (code) => codes.set(code, (codes.get(code) || 0) + 1);
        if (entry.status !== 200) add(`http_${entry.status}`);
        for (const code of entry.log?.failures || []) add(`${failureKind(code)} (${code})`);
        if (entry.status === 200 && entry.validatorErrors?.length) add('app validator rejected');
    }
    lines.push('## Failure codes (per request)', '');
    if (codes.size) {
        lines.push('| Code | Count |', '|---|---|');
        for (const [code, count] of [...codes].sort((a, b) => b[1] - a[1])) lines.push(`| ${code} | ${count} |`);
    } else lines.push('None.');
    lines.push('', 'Upstream attempt codes come from the proxy log (local runs only); staging reports only the HTTP status.', '');

    // latency by tool
    lines.push('## Latency by tool', '', '| Tool | Requests | p50 | p95 | max | mean output tokens |', '|---|---|---|---|---|---|');
    const tools = new Map();
    for (const entry of first.filter((request) => request.status === 200)) {
        for (const name of new Set(entry.tools)) tools.set(name, [...(tools.get(name) || []), entry]);
    }
    for (const [name, entries] of [...tools].sort((a, b) => percentile(b[1].map((e) => e.latencyMs), 95) - percentile(a[1].map((e) => e.latencyMs), 95))) {
        const ms = entries.map((entry) => entry.latencyMs);
        const out = entries.filter((entry) => entry.log).map((entry) => entry.log.outputTokens);
        lines.push(`| ${name} | ${entries.length} | ${sec(percentile(ms, 50))} | ${sec(percentile(ms, 95))} | ${sec(Math.max(...ms))} | ${out.length ? fixed(mean(out), 0) : 'n/a'} |`);
    }
    const timed = first.filter((entry) => entry.log && entry.status === 200);
    if (timed.length > 2) {
        const r = correlation(timed.map((entry) => entry.log.outputTokens), timed.map((entry) => entry.log.serverLatencyMs));
        lines.push('', `Correlation of server latency with output tokens: r = ${fixed(r)} (n = ${timed.length}).`);
    }
    lines.push('', '### Slowest requests', '', '| Case | Latency | Tools (calls) | Output tokens | Status |', '|---|---|---|---|---|');
    for (const entry of [...requests].sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 10)) {
        lines.push(`| ${entry.caseId}${entry.repair ? ' (repair)' : ''} | ${sec(entry.latencyMs)} | ${[...new Set(entry.tools)].join(', ') || '-'} (${entry.tools.length}) | ${entry.log?.outputTokens ?? 'n/a'} | ${entry.status}${entry.log?.failures.length ? ` ${entry.log.failures.join(',')}` : ''} |`);
    }
    lines.push('');

    // patterns
    const multiStyle = results.filter((entry) => entry.finalTools.filter((name) => name === 'set_style').length > 1).length;
    const spurious = results.filter((entry) => entry.reasons.some((reason) => reason.startsWith('unexpected cannot_do'))).length;
    lines.push('## Patterns', '');
    lines.push(`- Batches with more than one set_style: ${multiStyle}`);
    lines.push(`- Runs failed by an unexpected cannot_do: ${spurious}`);
    lines.push(`- Runs whose question or message was in the wrong language: ${results.filter((entry) => entry.reasons.includes('failed check replyLanguage')).length}`);
    lines.push(`- Runs with no-op edits (dropped by the app, not failed): ${results.filter((entry) => entry.noOps?.length).length}`);
    lines.push(`- Runs that needed the repair turn: ${results.filter((entry) => !entry.validFirst).length} (fixed by it: ${results.filter((entry) => !entry.validFirst && entry.validFinal).length})`, '');

    // per case
    lines.push('## Per case', '', '| # | Instruction | Pass | Collateral | Invalid first | Failure (most common) |', '|---|---|---|---|---|---|');
    const ids = [...new Set(results.map((entry) => entry.caseId))].sort((a, b) => a - b);
    for (const id of ids) {
        const entries = results.filter((entry) => entry.caseId === id);
        const testCase = CASES.find((entry) => entry.id === id);
        const reasons = new Map();
        for (const entry of entries.filter((item) => !item.success)) {
            const key = entry.reasons.slice(0, 3).join('; ') || 'unknown';
            reasons.set(key, (reasons.get(key) || 0) + 1);
        }
        const top = [...reasons].sort((a, b) => b[1] - a[1])[0];
        lines.push(`| ${id} | ${testCase.instruction.replace(/\|/g, '\\|')} | ${entries.filter((entry) => entry.success).length}/${entries.length} | ${entries.filter((entry) => entry.collateral.length).length} | ${entries.filter((entry) => !entry.validFirst).length} | ${top ? `${top[0].replace(/\|/g, '\\|').slice(0, 160)} (×${top[1]})` : ''} |`);
    }
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------- main

function rescore(args, outDir) {
    const read = (name) => readFileSync(join(outDir, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const requests = read(`${args.label}.requests.jsonl`);
    const results = read(`${args.label}.jsonl`).filter((entry) => CASES.some((item) => item.id === entry.caseId)).map((entry) => {
        const testCase = CASES.find((item) => item.id === entry.caseId);
        const fixture = fixtureState(testCase.fixture || 'F1');
        const result = entry.validFinal ? run(entry.calls, fixture, presets) : { errors: ['invalid'] };
        return { ...entry, ...scoreCase(testCase, fixture, presets, result, { systemPrompt: SYSTEM_PROMPT, calls: entry.calls }) };
    });
    const meta = JSON.parse(readFileSync(join(outDir, `${args.label}.meta.json`), 'utf8'));
    const markdown = report({ ...args, ...meta, label: args.label }, results, requests, meta.startedAt, meta.finishedAt);
    writeFileSync(join(outDir, `${args.label}.md`), markdown);
    writeFileSync(join(outDir, `${args.label}.jsonl`), `${results.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    console.log(`rescored: ${join(outDir, `${args.label}.md`)}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.rescore) return rescore(args, args.out || join(process.cwd(), 'eval-results'));
    const cases = selectCases(args);
    if (!cases.length) throw new Error('no cases selected');
    const outDir = args.out || join(process.cwd(), 'eval-results');
    mkdirSync(outDir, { recursive: true });
    const inproc = args.inproc ? await startInproc(args) : null;
    const tail = logTail(args.log);
    const minInterval = 60_000 / args.rate;
    const results = [];
    const requests = [];
    const startedAt = Date.now();
    let sequence = 0;
    let lastSent = 0;

    const send = async (body, meta) => {
        for (let attempt = 0; ; attempt += 1) {
            if (minInterval > 0) {
                const wait = lastSent + minInterval - Date.now();
                lastSent = Math.max(Date.now(), lastSent + minInterval);
                if (wait > 0) await sleep(wait);
            }
            const mine = sequence;
            sequence += 1;
            const response = await post(args, body, mine);
            let log;
            if (inproc) {
                log = parseLogLine(inproc.line(mine));
            } else {
                await sleep(30); // let the proxy flush its log line
                log = tail();
            }
            // a 5-hour or weekly cap won't lift during the run: stop rather than score false failures
            if (response.status === 429 && response.json.window && response.json.window !== 'minute') {
                throw new Error(`stopped: the proxy's ${response.json.window} limit for eval installs was hit (retry in ${response.json.retryAfterSeconds}s, or rerun: install ids are new each run)`);
            }
            // a minute-limit 429 is the harness going too fast, not a model failure: back off and resend
            if (response.status === 429 && attempt < 3) {
                await sleep(15_000);
                continue;
            }
            const tools = (response.json.tool_calls || []).map((call) => call.name);
            const request = { ...meta, status: response.status, latencyMs: response.latencyMs, json: { model: response.json.model }, tools, log };
            requests.push(request);
            return { response, request };
        }
    };

    const evaluate = async (runIndex, testCase) => {
        {
            const fixture = fixtureState(testCase.fixture || 'F1');
            const body = {
                instruction: testCase.instruction,
                snapshot: snapshotText(fixture),
                presets: PRESETS,
                fonts: FONTS.join('\n'),
                revision: String(fixture.revision),
                locale: testCase.locale || 'en',
                // as 4.0 (6) and later send it: the build's own tools and the clip's state
                app_tools: EVAL_APP_TOOLS,
                app_state: { silences_removed: false, audio_cleaned: false, music_added: false, ...testCase.appState },
                // as builds that read typed question options send it
                typed_options: true,
            };
            // a follow-up turn: the user's answer to the model's earlier question
            if (testCase.clarification) body.clarification = testCase.clarification;
            // a follow-up: the previous instruction, its calls and whether it's still applied
            if (testCase.previous) body.previous = testCase.previous;
            // the conversation before this instruction, as the app sends it
            if (testCase.history) body.history = testCase.history;
            const { response, request } = await send(body, { caseId: testCase.id, run: runIndex, repair: false });
            const calls = response.json.tool_calls || [];
            let result = response.status === 200 ? run(calls, fixture, presets, [], body.app_state) : { errors: [`http ${response.status}`] };
            request.validatorErrors = response.status === 200 ? result.errors : [];
            const validFirst = response.status === 200 && result.errors.length === 0;
            let finalCalls = calls;
            if (!validFirst && response.status === 200 && args.repair && calls.length) {
                const repairBody = { ...body, repair: { tool_calls: calls, errors: result.errors.slice(0, 20).map((error) => error.slice(0, 500)) } };
                const repaired = await send(repairBody, { caseId: testCase.id, run: runIndex, repair: true });
                if (repaired.response.status === 200) {
                    finalCalls = repaired.response.json.tool_calls || [];
                    result = run(finalCalls, fixture, presets, [], body.app_state);
                    repaired.request.validatorErrors = result.errors;
                }
            }
            const scored = scoreCase(testCase, fixture, presets, result, { systemPrompt: SYSTEM_PROMPT, calls: finalCalls });
            const entry = {
                caseId: testCase.id, run: runIndex, status: response.status, validFirst, validFinal: result.errors.length === 0,
                firstErrors: validFirst ? [] : request.validatorErrors, finalTools: finalCalls.map((call) => call.name),
                ...scored, calls: finalCalls,
            };
            results.push(entry);
            process.stdout.write(`run ${runIndex + 1}/${args.runs} case ${testCase.id}: ${entry.success ? 'pass' : `FAIL ${entry.reasons.slice(0, 2).join('; ').slice(0, 140)}`} (${sec(request.latencyMs)})\n`);
        }
    };

    // runs are the outer loop, as before; with --concurrency several cases are in flight at once
    const jobs = [];
    for (let runIndex = 0; runIndex < args.runs; runIndex += 1) for (const testCase of cases) jobs.push([runIndex, testCase]);
    let next = 0;
    try {
        await Promise.all(Array.from({ length: Math.min(args.concurrency, jobs.length) }, async () => {
            while (next < jobs.length) {
                const [runIndex, testCase] = jobs[next];
                next += 1;
                await evaluate(runIndex, testCase);
            }
        }));
    } finally {
        inproc?.close();
    }
    const order = new Map(cases.map((testCase, index) => [testCase.id, index]));
    results.sort((a, b) => a.run - b.run || order.get(a.caseId) - order.get(b.caseId));

    writeFileSync(join(outDir, `${args.label}.meta.json`), JSON.stringify({ url: args.inproc ? 'in process' : args.url, runs: args.runs, repair: args.repair, startedAt, finishedAt: Date.now() }));
    const markdown = report(args, results, requests, startedAt);
    writeFileSync(join(outDir, `${args.label}.md`), markdown);
    // tool calls hold fixture text only (synthetic / internal corpus)
    writeFileSync(join(outDir, `${args.label}.jsonl`), `${results.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    writeFileSync(join(outDir, `${args.label}.requests.jsonl`), `${requests.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    console.log(`\nreport: ${join(outDir, `${args.label}.md`)}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
