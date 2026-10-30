/**
 * npm run repair:replay -- --base-url http://localhost:8788/v1 --model M [dir ...] [--out report.json] [--limit N] [--only substring]
 * Offline paired A/B of the Coder's repair round. Each saved record whose checks still fail is rebuilt and
 * checked in the real in-page runner; then the same failing app is repaired twice from the same failures:
 * arm "base" gets the pipeline's repair notes, arm "page" also gets the markup captured when each check
 * failed (`browserFailureNotes(..., { pages: true })`). Both repairs are rebuilt and rechecked with the record's own check plan.
 * Talks only to an OpenAI-compatible local endpoint (e.g. npm run agy:chat); there is no API key path.
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { buildStaticProject } from '../src/studio/workspace.js';
import { discoverCheckRecords } from '../src/studio/replayChecks.js';
import { browserFailureNotes } from '../src/studio/shared/repair.js';
import { parseModelObject, parseCodeOutput } from '../src/studio/shared/parse.js';
import { REPAIR_INSTRUCTIONS, STUDIO_CONSTRAINTS, coderPrompt } from '../src/studio/shared/prompts.js';
import type { BrowserCheck, BrowserCheckResult } from '../dashboard/src/lib/studioChecks.js';

const args = process.argv.slice(2);
const directories: string[] = [];
const option: Record<string, string> = {};
for (let index = 0; index < args.length; index++) {
  if (['--base-url', '--model', '--out', '--limit', '--only'].includes(args[index])) {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${args[index - 1]}`);
    option[args[index - 1].slice(2)] = value;
  } else if (args[index].startsWith('--')) throw new Error(`Unknown option: ${args[index]}`);
  else directories.push(args[index]);
}
const baseUrl = option['base-url'];
if (!baseUrl || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(baseUrl)) throw new Error('--base-url must be a local endpoint, e.g. http://localhost:8788/v1');
const model = option.model || 'gemini-3.8-flash-low';
const limit = option.limit ? Number(option.limit) : Infinity;

type Run = { results: BrowserCheckResult[]; errors: string[] };
type Files = { path: string; content: string; description?: string }[];
const score = (run: Run) => run.results.filter((result) => result.status === 'passed').length;

// Ideas by case id, from every pre-registered case file.
const ideas = new Map<string, string>();
for (const name of (await readdir('config')).filter((file) => file.endsWith('.json'))) {
  try {
    const cases = JSON.parse(await readFile(join('config', name), 'utf8'));
    if (Array.isArray(cases)) for (const item of cases) if (item?.id && item?.description) ideas.set(item.id, item.description);
  } catch { /* not a case file */ }
}

async function coder(description: string, files: Files, notes: string[]) {
  const prompt = coderPrompt(description, 'javascript', { language: 'javascript', constraints: STUDIO_CONSTRAINTS, previousFiles: files, revisionNotes: notes });
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.7, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] }),
  });
  const body = await response.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!response.ok) throw new Error(`Coder ${response.status}: ${body.error?.message ?? ''}`);
  return parseCodeOutput(parseModelObject(body.choices?.[0]?.message?.content ?? '')).files as Files;
}

async function main() {
  const paths = (await discoverCheckRecords(directories.length ? directories : ['docs/software-studio/benchmark-results'], option.only ?? '', Infinity)).sort();
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../dashboard/src/lib/live/checks.ts', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'replayChecks', target: 'es2022',
  });
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Repair replay</title></head><body></body></html>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'repair-replay-'));
  const browser = await chromium.launch({ headless: true });
  const check = async (html: string, checks: BrowserCheck[], isolation: string): Promise<Run> => {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    try {
      await context.route('**/*', (route) => route.request().url() === `${origin}/` && route.request().isNavigationRequest() ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(origin);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      return await page.evaluate(({ html, checks, isolation }) => (window as unknown as { replayChecks: { runInPageChecks(html: string, checks: BrowserCheck[], signal: undefined, isolation: string): Promise<Run> } }).replayChecks.runInPageChecks(html, checks, undefined, isolation), { html, checks, isolation });
    } finally { await context.close(); }
  };
  let built = 0;
  const buildAndCheck = async (files: Files, checks: BrowserCheck[], isolation: string) => {
    const directory = join(root, String(built++));
    const report = await buildStaticProject(files, directory);
    if (report.status !== 'passed') return { built: false as const, errors: report.errors };
    return { built: true as const, run: await check(await readFile(join(directory, 'dist/index.html'), 'utf8'), checks, isolation) };
  };
  const out: unknown[] = [];
  let cases = 0;
  try {
    for (const path of paths) {
      if (cases >= limit) break;
      const saved = JSON.parse(await readFile(path, 'utf8'));
      const description = ideas.get(saved.caseId);
      const checks: BrowserCheck[] | undefined = saved.plan?.checks;
      if (!description || !Array.isArray(saved.files) || !saved.files.length || !checks?.length) continue;
      const isolation = saved.plan.isolation ?? 'shared';
      const before = await buildAndCheck(saved.files, checks, isolation);
      if (!before.built || before.run.results.every((result) => result.status === 'passed')) continue;
      cases++;
      const failures = before.run.results.filter((result) => result.status === 'failed');
      const arms = cases % 2 ? ['base', 'page'] as const : ['page', 'base'] as const;
      const entry: Record<string, unknown> = { path: relative(process.cwd(), path), caseId: saved.caseId, before: `${score(before.run)}/${checks.length}`, failing: failures.map((result) => result.name), withPage: failures.filter((result) => result.page).length };
      for (const arm of arms) {
        const notes = [REPAIR_INSTRUCTIONS, ...browserFailureNotes(checks, before.run.results, before.run.errors, [], { pages: arm === 'page' })];
        try {
          const files = await coder(description, saved.files, notes);
          const after = await buildAndCheck(files, checks, isolation);
          entry[arm] = after.built ? `${score(after.run)}/${checks.length}` : 'build failed';
        } catch (error) { entry[arm] = `error: ${String((error as Error).message ?? error).slice(0, 120)}`; }
      }
      out.push(entry);
      console.log(JSON.stringify(entry));
      if (option.out) await writeFile(option.out, JSON.stringify(out, null, 2));
    }
  } finally {
    await browser.close(); server.close(); await rm(root, { recursive: true, force: true });
  }
}

await main();
