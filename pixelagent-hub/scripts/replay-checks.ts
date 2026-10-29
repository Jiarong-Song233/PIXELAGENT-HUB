/**
 * npm run checks:replay -- [dir ...] [--out report.json] [--only substring] [--limit N]
 * Offline PLAY LIVE replay: bundles live/checks.ts and its preview bridge without a dashboard build.
 * Rebuilds source with the replay export's Studio builder; only loopback navigation is allowed.
 * Direction totals count stable changes. Flaky means the two replay verdicts disagree, not actual-only drift.
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { buildStaticProject } from '../src/studio/workspace.js';
import { discoverCheckRecords, lastCheckVerdicts, compareVerdicts, verdictScore, type Verdict } from '../src/studio/replayChecks.js';
import type { BrowserCheck } from '../dashboard/src/lib/studioChecks.js';

const directories: string[] = [];
let out: string | undefined;
let only = '';
let limit = Infinity;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (['--out', '--only', '--limit'].includes(arg)) {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--out') out = value;
    if (arg === '--only') only = value;
    if (arg === '--limit') {
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
    }
  } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  else directories.push(arg);
}

type Run = { results: Verdict[]; errors: string[] };
type Result = {
  path: string; status: 'skipped' | 'identical' | 'changed' | 'flaky'; reason?: string; detail?: string;
  recordedScore?: string; replayedScore?: string; savedScore?: string; recorded?: Verdict[];
  replay?: Run; secondReplay?: Run; changes?: ReturnType<typeof compareVerdicts>;
};

async function main() {
  const started = Date.now();
  const paths = await discoverCheckRecords(directories.length ? directories : ['docs/software-studio/benchmark-results'], only, limit);
  // Bundle the real entry point rather than copying its DOM runner, frame styling or budgets.
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../dashboard/src/lib/live/checks.ts', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'replayChecks', target: 'es2022',
  });
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><title>Offline checks</title></head><body></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing replay server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'checks-replay-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const results: Result[] = new Array(paths.length);
    let next = 0;
    let completed = 0;
    async function replay(html: string, checks: BrowserCheck[], isolation: 'fresh' | 'shared'): Promise<Run> {
      const context = await browser!.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
      try {
        await context.route('**/*', (route) => route.request().url() === `${origin}/` && route.request().isNavigationRequest()
          ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.goto(origin);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        return await page.evaluate(async ({ html, checks, isolation }) => {
          const runner = (window as unknown as { replayChecks: { runInPageChecks(html: string, checks: BrowserCheck[], signal: undefined, isolation: string): Promise<Run> } }).replayChecks;
          return runner.runInPageChecks(html, checks, undefined, isolation);
        }, { html, checks, isolation });
      } finally { await context.close(); }
    }
    async function record(path: string, index: number): Promise<Result> {
      const base = { path: relative(process.cwd(), path) };
      const skip = (reason: string, detail?: string): Result => ({ ...base, status: 'skipped', reason, detail });
      let saved;
      try { saved = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { return skip('invalid record', String(error)); }
      if (!saved || !Array.isArray(saved.files) || !saved.files.length) return skip('no files');
      if (!Array.isArray(saved.plan?.checks) || !saved.plan.checks.length) return skip('no plan');
      const checks: BrowserCheck[] = saved.plan.checks;
      const recorded = lastCheckVerdicts(Array.isArray(saved.events) ? saved.events : []);
      const names = new Set(checks.map((check) => check.name));
      if (names.size !== checks.length || recorded.length !== checks.length || new Set(recorded.map((check) => check.name)).size !== names.size
        || recorded.some((check) => !names.has(check.name))) return skip('missing or ambiguous last-run verdicts');
      const directory = join(root, String(index));
      try {
        // Same builder used by scripts/lib/replay-live.ts to rebuild final saved source.
        const report = await buildStaticProject(saved.files, directory);
        if (report.status !== 'passed') return skip('build failure', report.errors.join('; '));
      } catch (error) { return skip('build failure', String(error)); }
      const html = await readFile(join(directory, 'dist/index.html'), 'utf8');
      const isolation = saved.plan.isolation ?? 'shared';
      const first = await replay(html, checks, isolation);
      const changes = compareVerdicts(recorded, first.results);
      const second = changes.length ? await replay(html, checks, isolation) : undefined;
      return { ...base, status: second && compareVerdicts(first.results, second.results).length ? 'flaky' : changes.length ? 'changed' : 'identical',
        recordedScore: verdictScore(recorded), replayedScore: verdictScore(first.results), savedScore: saved.checkRuns?.at(-1),
        recorded, replay: first, secondReplay: second, changes };
    }
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (next < paths.length) {
        const index = next++;
        const result = await record(paths[index], index);
        results[index] = result;
        console.log(`[${++completed}/${paths.length}] ${result.path}: ${result.status === 'skipped' ? `skipped (${result.reason})` : `${result.recordedScore} -> ${result.replayedScore} ${result.status}`} ${result.changes?.map((change) => `${JSON.stringify(change.name)} ${change.recorded?.status} (${JSON.stringify(change.recorded?.actual)}) -> ${change.replayed?.status} (${JSON.stringify(change.replayed?.actual)})`).join('; ') ?? ''}`);
      }
    }));
    const summary = {
      recordsReplayed: results.filter((result) => result.status !== 'skipped').length,
      identical: results.filter((result) => result.status === 'identical').length,
      changed: results.filter((result) => result.status === 'changed').length,
      flaky: results.filter((result) => result.status === 'flaky').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      skipReasons: results.filter((result) => result.status === 'skipped').reduce<Record<string, number>>((counts, result) => {
        counts[result.reason!] = (counts[result.reason!] ?? 0) + 1; return counts;
      }, {}),
      // Stable changes only; flaky first-replay differences remain in each record's report.
      failedToPassed: results.filter((result) => result.status === 'changed').flatMap((result) => result.changes!).filter((change) => change.recorded?.status === 'failed' && change.replayed?.status === 'passed').length,
      passedToFailed: results.filter((result) => result.status === 'changed').flatMap((result) => result.changes!).filter((change) => change.recorded?.status === 'passed' && change.replayed?.status === 'failed').length,
      durationSeconds: (Date.now() - started) / 1000,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (out) await writeFile(resolve(out), JSON.stringify({ summary, records: results }, null, 2));
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // root is the exact directory returned by mkdtemp, never an input record directory.
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
