/**
 * PLAY LIVE benchmark: the fixed benchmark cases run through the real built static site in Chromium,
 * exactly as a visitor would run them (Tester-written plans, fresh isolation, one repair round).
 * The page holds a test key; requests to api.deepseek.com are forwarded with DEEPSEEK_API_KEY, so the
 * real key never enters the page. Each run uses a fresh browser profile; its recorded events are saved.
 *
 *   npx tsx scripts/benchmark-live.ts <dist> <out-dir> [--strategy manager-coder|coder-only] [--runs 3] [--model deepseek-chat] [--tester-model deepseek-reasoner] [--only counter,todo] [--cases file.json]
 *   --arms "model=deepseek-chat;model=deepseek-reasoner" interleaves arms, rotating the first arm each run.
 *
 * Calls the paid model.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { parseArms, rotateArms } from '../src/studio/benchmarkArms.js';

const [distArg, outArg] = process.argv.slice(2);
const baseUrl = process.argv.includes('--base-url') ? process.argv[process.argv.indexOf('--base-url') + 1] : undefined;
if (!distArg || !outArg || (!baseUrl && !process.env.DEEPSEEK_API_KEY)) throw new Error('Usage: DEEPSEEK_API_KEY=… benchmark-live.ts <dist> <out-dir> [--strategy manager-coder|coder-only] [--runs N] [--model M] [--tester-model M] [--only ids] [--base-url http://localhost:8787/v1] [--arms "strategy=manager-coder;strategy=coder-only"]');
const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const strategy = argument('--strategy') ?? 'manager-coder';
if (!['manager-coder', 'coder-only'].includes(strategy)) throw new Error('--strategy must be manager-coder or coder-only');
const runs = Number(argument('--runs') || 3);
const model = argument('--model') || 'deepseek-chat';
const testerModel = argument('--tester-model') || '';
const explicitArms = process.argv.includes('--arms');
if (explicitArms && (!argument('--arms') || argument('--arms')!.startsWith('--'))) throw new Error('--arms requires settings');
const arms = parseArms(argument('--arms'), { strategy, model, testerModel, dist: distArg });
for (const arm of arms) if (!['manager-coder', 'coder-only'].includes(arm.strategy)) throw new Error(`Arm ${arm.arm}: strategy must be manager-coder or coder-only`);
const only = argument('--only')?.split(',');
const out = resolve(outArg);
const base = '/PIXELAGENT-HUB/';
const cases = (JSON.parse(await readFile(resolve(argument('--cases') || 'config/studio-benchmark.json'), 'utf8')) as { id: string; title: string; description: string }[]).filter((item) => !only || only.includes(item.id));
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const servers = new Map<string, { server: ReturnType<typeof createServer>; origin: string }>();
for (const dist of new Set(arms.map((arm) => arm.dist))) {
  const server = createServer(async (req, res) => {
    let file = join(dist, decodeURIComponent(new URL(req.url!, 'http://x').pathname).slice(base.length));
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  servers.set(dist, { server, origin });
}
const browser = await chromium.launch();
type Event = { seq: number; at: string; type: string; round?: number; data?: Record<string, unknown> };
const results = [];
await mkdir(out, { recursive: true });
for (const arm of arms) if (explicitArms) await mkdir(join(out, arm.arm), { recursive: true });
if (explicitArms) await writeFile(join(out, 'arms.json'), JSON.stringify(arms.map(({ arm, ...settings }) => ({ arm, settings, directory: arm })), null, 2));
try {
  for (const testCase of cases) for (let run = 1; run <= runs; run++) for (const arm of rotateArms(arms, run)) {
    const directory = explicitArms ? join(out, arm.arm) : out;
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    let tokens = 0;
    // With --base-url the page talks to a local OpenAI-compatible server (no key); otherwise to DeepSeek with the real key.
    await page.route(baseUrl ? `${baseUrl.replace(/\/$/, '')}/**` : 'https://api.deepseek.com/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'POST, OPTIONS' } });
      const upstream = await fetch(baseUrl ? `${baseUrl.replace(/\/$/, '')}/chat/completions` : 'https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(baseUrl ? {} : { authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }) }, body: route.request().postData() || '{}' });
      const body = Buffer.from(await upstream.arrayBuffer());
      for (const match of body.toString('utf8').matchAll(/"total_tokens":(\d+)/g)) tokens += Number(match[1]);
      await route.fulfill({ status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'access-control-allow-origin': '*' }, body });
    });
    const started = Date.now();
    await page.goto(`${servers.get(arm.dist)!.origin}${base}#/studio?idea=${encodeURIComponent(testCase.description)}&strategy=${arm.strategy}`);
    await page.waitForSelector('.studio-stage');
    await page.getByRole('button', { name: /BUILD LIVE/ }).click();
    if (baseUrl) {
      await page.locator('#live-provider').selectOption('custom');
      await page.locator('#live-base-url').fill(baseUrl);
    } else {
      await page.locator('#live-provider').selectOption('deepseek');
      await page.locator('#live-key').fill('sk-benchmark-0000000000000000000000000000');
    }
    await page.locator('#live-model').fill(arm.model);
    await page.locator('#live-tester-model').fill(arm.testerModel);
    await page.getByRole('button', { name: /SAVE & BUILD/ }).click();
    await page.waitForURL(/studio\/live-/, { timeout: 15_000 });
    await page.waitForFunction(() => /Built\. Ready to play|Repair made it worse; kept the earlier build|Run failed|Run cancelled/.test(document.body.innerText), null, { timeout: 1_800_000, polling: 1000 });
    const record = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((done) => { const request = indexedDB.open('pixelagent-live', 1); request.onsuccess = () => done(request.result); });
      const all = await new Promise<any[]>((done) => { const request = db.transaction('projects').objectStore('projects').getAll(); request.onsuccess = () => done(request.result); });
      const entry = all[0];
      return { managerTokens: entry.project.plan?.output?.llmUsage?.total_tokens || 0, project: { status: entry.project.status, error: entry.project.error, rounds: entry.project.rounds.map((round: any) => ({ round: round.round, build: round.build?.status, errors: round.build?.errors })) }, events: entry.events, plan: entry.plan?.result?.output, files: entry.files };
    });
    const events = record.events as Event[];
    const browserRuns = events.filter((event) => event.type === 'browser_run_finished').map((event) => ({ status: String(event.data?.status), passed: Number(event.data?.passed), failed: Number(event.data?.failed) }));
    const compileFailures = events.filter((event) => event.type === 'build_failed').length;
    const reviews = events.filter((event) => event.type === 'test_plan_ready' && event.data?.review);
    const entry = {
      caseId: testCase.id, run, ...(explicitArms ? { arm: arm.arm } : {}), strategy: arm.strategy, dist: arm.dist, managerTokens: record.managerTokens, model: arm.model, testerModel: arm.testerModel, status: record.project.status, error: record.project.error,
      coderRounds: record.project.rounds.length, compileFailures,
      firstChecks: browserRuns[0] ? `${browserRuns[0].passed}/${browserRuns[0].passed + browserRuns[0].failed}` : null,
      finalChecks: browserRuns.at(-1) ? `${browserRuns.at(-1)!.passed}/${browserRuns.at(-1)!.passed + browserRuns.at(-1)!.failed}` : null,
      reviewTriggered: reviews.length > 0,
      checksDropped: reviews.reduce((sum, event) => sum + (Number(event.data?.dropped) || 0), 0),
      checksRevised: reviews.reduce((sum, event) => sum + (Number(event.data?.revised) || 0), 0),
      coderRepair: record.project.rounds.length > 1 + compileFailures,
      checkRuns: browserRuns.map((run) => `${run.passed}/${run.passed + run.failed}`),
      repairTriggered: browserRuns.length > 1,
      repairReverted: events.some((event) => event.type === 'ready_for_review' && event.data?.repairReverted === true),
      fullPass: record.project.status === 'ready_for_review' && browserRuns.at(-1)?.status === 'passed',
      rescuedByRepair: browserRuns.length > 1 && browserRuns.at(-1)?.status === 'passed',
      elapsedSeconds: Math.round((Date.now() - started) / 1000), reportedTokens: tokens,
    };
    results.push(entry);
    console.log(JSON.stringify(entry));
    await writeFile(join(directory, `${testCase.id}-run${run}.json`), JSON.stringify({ ...entry, events, plan: record.plan, rounds: record.project.rounds, files: record.files }, null, 2));
    await context.close();
  }
} finally {
  await browser.close();
  for (const { server } of servers.values()) server.close();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '';
  for (const arm of arms) await writeFile(join(explicitArms ? join(out, arm.arm) : out, 'summary.json'), JSON.stringify({ recordedAt: new Date().toISOString(), sourceRevision: revision, sourceDirty: dirty, model: arm.model, runsPerCase: runs, results: explicitArms ? results.filter((entry) => entry.arm === arm.arm) : results }, null, 2));
}
