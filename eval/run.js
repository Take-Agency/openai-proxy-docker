// Runs the instruction-editing eval against a /edit/instruct endpoint and writes a markdown report
// (§5.3). Requests go out one at a time, as the app sends them, so latency is per request.
//
//   node eval/run.js --url https://…/edit/instruct --runs 5 [--cases 1-10,19] [--label name]
//                    [--rate 18] [--log /path/to/server.log] [--out dir] [--no-repair] [--local]
//
// --rate      requests per minute (default 18: under the proxy's 20/min per-IP limit)
// --log       the proxy's stdout when running it locally: its count-only line per request gives
//             token usage (cost) and the per-attempt failure codes behind a 502 or a fallback
// --local     localhost only: sends a synthetic do-connecting-ip per request so the per-IP limit
//             doesn't throttle a local run. Never used against staging.
// --no-repair score the first response only (by default an invalid batch gets the app's one
//             repair turn, and task success is scored on the result)
// Install ids rotate over five synthetic `eval-<label>-<n>` ids, keeping each under the
// per-install limits (10/min, 150/day).

import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run as applyCalls, snapshotText, presetCatalog } from './applier.js';
import { CASES } from './cases.js';
import { fixtureState, FONTS } from './fixtures.js';

const run = (calls, state, catalog) => applyCalls(calls, state, catalog, FONTS);
import { scoreCase } from './score.js';
import { SYSTEM_PROMPT } from '../editInstruct.js';
import { EDIT_TOOLS } from '../editInstructTools.js';

const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
const PRESETS = presetCatalog(presets);
const CLIENT_TIMEOUT_MS = 15_000; // the app's
// $ per 1M tokens: input / cached input / output (docs/instruction_editing_plan.md §2.2)
const PRICES = { 'gpt-6-luna': [0.10, 0.01, 0.50], 'gpt-5.6-luna': [0.10, 0.01, 0.50] };
const PRICE_NOTE = 'gpt-6-luna list price from the plan (§2.2); gpt-5.6-luna priced the same (not verified)';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const args = { runs: 1, rate: 18, label: 'eval', repair: true, local: false };
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index].replace(/^--/, '');
        if (key === 'no-repair') args.repair = false;
        else if (key === 'local') args.local = true;
        else args[key] = argv[++index];
    }
    if (!args.url) throw new Error('--url is required');
    args.runs = Number(args.runs);
    args.rate = Number(args.rate);
    if (args.local && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(args.url)) throw new Error('--local is for localhost only');
    return args;
}

function selectCases(spec) {
    if (!spec) return CASES;
    const ids = new Set(spec.split(',').flatMap((part) => {
        const [from, to] = part.split('-').map(Number);
        return Array.from({ length: (to || from) - from + 1 }, (_, index) => from + index);
    }));
    return CASES.filter((testCase) => ids.has(testCase.id));
}

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
        const line = buffer.toString('utf8').split('\n').filter((entry) => entry.startsWith('edit/instruct ')).at(-1);
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
}

// ---------------------------------------------------------------- requests

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(args, body, sequence) {
    const headers = { 'content-type': 'application/json', 'x-install-id': `eval-${args.label}-${sequence % 5}`.padEnd(8, '0') };
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
    : /:(bad_arguments|unknown_tool|no_tool_calls|too_many_calls|clarification_mixed)$/.test(code) ? 'schema'
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

function report(args, results, requests, startedAt) {
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
    lines.push(`- Prompt + tools hash (local files): \`${createHash('sha256').update(SYSTEM_PROMPT + JSON.stringify(EDIT_TOOLS)).digest('hex').slice(0, 10)}\` · repair turn: ${args.repair ? 'on' : 'off'}`);
    lines.push(`- Started ${new Date(startedAt).toISOString()}, ${requests.length} requests, ${((Date.now() - startedAt) / 60000).toFixed(1)} min`, '');

    lines.push('## Summary', '', '| Metric | Value | Ship bar |', '|---|---|---|');
    lines.push(`| Valid, first response (schema + app validator) | ${pct(results.filter((entry) => entry.validFirst).length, results.length)} | ≥ 99% |`);
    lines.push(`| Valid after the repair turn | ${pct(results.filter((entry) => entry.validFinal).length, results.length)} | |`);
    lines.push(`| Task success, in scope (1–41) | ${successRate(inScope)} | ≥ 90% ${inScopeRate >= 0.9 ? 'PASS' : 'FAIL'} |`);
    lines.push(`| Correct abstention (42–50) | ${successRate(abstain)} | ≥ 95% ${abstainRate >= 0.95 ? 'PASS' : 'FAIL'} |`);
    lines.push(`| Collateral damage (runs, 1–50) | ${pct(collateralRuns, plan.length)} | ≤ 1% ${collateralRuns / (plan.length || 1) <= 0.01 ? 'PASS' : 'FAIL'} |`);
    lines.push(`| Precision / recall, case 19 (fillers) | ${pr(19)} | |`);
    lines.push(`| Precision / recall, case 27 (F2 "like") | ${pr(27)} | ≥ 0.9 / ≥ 0.8 |`);
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cases = selectCases(args.cases);
    const outDir = args.out || join(process.cwd(), 'eval-results');
    mkdirSync(outDir, { recursive: true });
    const tail = logTail(args.log);
    const minInterval = 60_000 / args.rate;
    const results = [];
    const requests = [];
    const startedAt = Date.now();
    let sequence = 0;
    let lastSent = 0;

    const send = async (body, meta) => {
        for (let attempt = 0; ; attempt += 1) {
            const wait = lastSent + minInterval - Date.now();
            if (wait > 0) await sleep(wait);
            lastSent = Date.now();
            const response = await post(args, body, sequence);
            sequence += 1;
            await sleep(30); // let the proxy flush its log line
            const log = tail();
            // a 429 is the harness going too fast, not a model failure: back off and resend
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

    for (let runIndex = 0; runIndex < args.runs; runIndex += 1) {
        for (const testCase of cases) {
            const fixture = fixtureState(testCase.fixture || 'F1');
            const body = {
                instruction: testCase.instruction,
                snapshot: snapshotText(fixture),
                presets: PRESETS,
                fonts: FONTS.join('\n'),
                revision: String(fixture.revision),
                locale: testCase.locale || 'en',
            };
            const { response, request } = await send(body, { caseId: testCase.id, run: runIndex, repair: false });
            const calls = response.json.tool_calls || [];
            let result = response.status === 200 ? run(calls, fixture, presets) : { errors: [`http ${response.status}`] };
            request.validatorErrors = response.status === 200 ? result.errors : [];
            const validFirst = response.status === 200 && result.errors.length === 0;
            let finalCalls = calls;
            if (!validFirst && response.status === 200 && args.repair && calls.length) {
                const repairBody = { ...body, repair: { tool_calls: calls, errors: result.errors.slice(0, 20).map((error) => error.slice(0, 500)) } };
                const repaired = await send(repairBody, { caseId: testCase.id, run: runIndex, repair: true });
                if (repaired.response.status === 200) {
                    finalCalls = repaired.response.json.tool_calls || [];
                    result = run(finalCalls, fixture, presets);
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
    }

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
