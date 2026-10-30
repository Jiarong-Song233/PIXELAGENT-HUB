import { strToU8, zipSync } from 'fflate';
import { coderPrompt, invalidCodeReplyNote, invalidPlanFeedback, invalidReviewFeedback, isInvalidPlanError, isInvalidReplyError, managerPrompt, testerPrompt, testerReviewPrompt, REPAIR_INSTRUCTIONS, STUDIO_CONSTRAINTS, STUDIO_DELIVERABLE, type Prompt } from '@studio-shared/prompts';
import { UNCHANGED_REPAIR_NOTE, browserFailureNotes, unchangedFiles } from '@studio-shared/repair';
import { dependencyNote, unsupportedDependencies } from '@studio-shared/dependencies';
import type { BrowserCheck, BrowserCheckResult } from '../studioChecks';
import { parseCodeOutput, parseModelObject, parsePlanOutput, parseTestPlanOutput, parseTesterReview } from '@studio-shared/parse';
import type { StudioDiagnostic, StudioEvent, StudioEventType, StudioProject, StudioSummary, StudioTestPlan } from '../../types/studio';
import { customEndpoint, DEFAULT_CUSTOM_BASE_URL, liveChat, liveProvider, type LlmUsage } from './llm';
import { buildInBrowser } from './build';
import { runInPageChecks } from './checks';
import { liveCredentials } from './key';
import { decodeSharedRun, encodeSharedRun, shareId, type SharedRun } from './share';

/**
 * PLAY LIVE: the Studio loop of src/studio/softwareStudio.ts, run in the visitor's browser with
 * their own DeepSeek key. It emits the same events as the server, so the squad, sounds and result
 * panels work unchanged. Projects are stored per visitor in IndexedDB (best effort).
 */
export const LIVE_PREFIX = 'live-';
export const SHARED_PREFIX = 'shared-';
/** Runs started in this tab (live-) or opened from a share link (shared-): answered in the browser. */
export const isLiveProject = (projectId?: string) => !!projectId && (projectId.startsWith(LIVE_PREFIX) || projectId.startsWith(SHARED_PREFIX));
export const isLiveRun = (projectId?: string) => !!projectId?.startsWith(LIVE_PREFIX);
export const isSharedProject = (projectId?: string) => !!projectId?.startsWith(SHARED_PREFIX);
export const LIVE_CODER_TIMEOUT_MS = 300_000;
const AGENT_TIMEOUT_MS = 180_000;
export const LOCAL_AGENT_TIMEOUT_MS = 1_200_000;
const TERMINAL = new Set<StudioEventType>(['ready_for_review', 'failed', 'cancelled']);

type Files = { path: string; content: string; description?: string }[];
type Entry = { project: StudioProject; events: StudioEvent[]; html?: string; files?: Files; plan?: StudioTestPlan; diagnostics: StudioDiagnostic[] };
const entries = new Map<string, Entry>();
const controllers = new Map<string, AbortController>();
const listeners = new Map<string, Set<(event: StudioEvent) => void>>();

const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

// ---- persistence (IndexedDB; the page still works for this tab when it is unavailable) ----
const DB = 'pixelagent-live';
let database: Promise<IDBDatabase | null> | undefined;
const openDatabase = () => (database ??= new Promise((resolve) => {
  try {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  } catch { resolve(null); }
}));
const persist = async (entry: Entry) => {
  try {
    const db = await openDatabase();
    db?.transaction('projects', 'readwrite').objectStore('projects').put(structuredClone(entry), entry.project.projectId);
  } catch { /* per-visitor convenience only */ }
};
let loaded: Promise<void> | undefined;
const ready = () => (loaded ??= (async () => {
  try {
    const db = await openDatabase();
    if (!db) return;
    const all = await new Promise<Entry[]>((resolve) => {
      const request = db.transaction('projects').objectStore('projects').getAll();
      request.onsuccess = () => resolve(request.result as Entry[]);
      request.onerror = () => resolve([]);
    });
    for (const entry of all) {
      if (entries.has(entry.project.projectId)) continue;
      entries.set(entry.project.projectId, entry);
      // A run cannot survive a page reload: its requests died with the page.
      if (['queued', 'running'].includes(entry.project.status)) finishFailed(entry, 'The page was closed or reloaded during this run', 'failed');
      if (entry.plan && ['queued', 'running'].includes(entry.plan.status)) { entry.plan.status = 'failed'; entry.plan.error = 'The page was closed or reloaded during test planning'; }
    }
  } catch { /* start empty */ }
})());

// ---- events ----
function emit(entry: Entry, type: StudioEventType, data?: Record<string, unknown>, round?: number) {
  const event: StudioEvent = { seq: entry.events.length + 1, at: now(), type, ...(round !== undefined ? { round } : {}), ...(data ? { data } : {}) };
  entry.events.push(event);
  void persist(entry);
  for (const listener of listeners.get(entry.project.projectId) || []) listener(event);
}
const summarizeErrors = (errors: string[]) => errors.slice(0, 3).map((error) => error.slice(0, 300));

function finishFailed(entry: Entry, error: string, status: 'failed' | 'cancelled') {
  const { project } = entry;
  project.stoppedPhase = project.phase;
  project.status = status;
  project.phase = status;
  project.error = error;
  project.finishedAt = now();
  emit(entry, status, { stoppedPhase: project.stoppedPhase, error: error.slice(0, 300) });
}

// ---- agents ----
type AgentReply<T> = { output: T & { llmUsage?: LlmUsage; llmModel: string; llmProvider: string } };
async function ask<T>(agent: string, prompt: Prompt, parse: (object: unknown) => T, signal: AbortSignal, timeoutMs: number, options: { model?: string; temperature?: number } = {}): Promise<AgentReply<T>> {
  const credentials = liveCredentials();
  if (!credentials) throw new Error('Add a model key to build live.');
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  // Local servers are free but often run on a CPU: give them far longer before giving up (STOP still works).
  const limit = liveProvider(credentials.provider).custom ? Math.max(timeoutMs, LOCAL_AGENT_TIMEOUT_MS) : timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error(`${agent} exceeded its ${limit / 1000} s limit`)), limit);
  try {
    const reply = await liveChat({ ...credentials, model: options.model || credentials.model }, prompt, controller.signal, { json: true, temperature: options.temperature ?? 0.7 });
    return { output: { ...parse(parseModelObject(reply.content)), llmUsage: reply.usage, llmModel: reply.model, llmProvider: credentials.provider } };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

function metrics(entry: Entry): StudioProject['generationMetrics'] {
  const { project } = entry;
  const tasks = [project.plan, ...project.rounds.map((round) => round.code)].filter(Boolean) as { output?: { llmUsage?: LlmUsage; llmModel?: string; llmProvider?: string } }[];
  const usage = tasks.map((task) => task.output?.llmUsage).filter(Boolean) as LlmUsage[];
  return {
    elapsedMs: project.finishedAt ? Date.parse(project.finishedAt) - Date.parse(project.startedAt) : null,
    buildAttempts: project.rounds.filter((round) => round.build).length,
    failedBuilds: project.rounds.filter((round) => round.build?.status === 'failed').length,
    agentTasks: tasks.length, reportedUsageTasks: usage.length, missingUsageTasks: tasks.length - usage.length,
    reportedTokens: usage.reduce((sum, item) => sum + (item.total_tokens || 0), 0),
    models: [...new Set(tasks.flatMap((task) => task.output?.llmModel ? [`${task.output.llmProvider || 'model'}/${task.output.llmModel}`] : []))],
    costUsd: null,
  };
}

// ---- the loop ----
/** Coder rounds in one run, compile repairs and the browser repair together. */
export const LIVE_MAX_ROUNDS = 4;

/** Code → build until it compiles; returns the passing round's files. */
async function codeUntilBuilt(entry: Entry, signal: AbortSignal, phase: (name: string, round?: number) => void, start: { previousFiles: Files; revisionNotes: string[]; maxRounds: number }) {
  const { project } = entry;
  let { previousFiles, revisionNotes } = start;
  const limit = Math.min(LIVE_MAX_ROUNDS, project.rounds.length + start.maxRounds);
  while (project.rounds.length < limit) {
    const round = project.rounds.length + 1;
    phase('coding', round);
    let code;
    try {
      code = await ask('Coder', coderPrompt(project.description, 'javascript', { language: 'javascript', constraints: STUDIO_CONSTRAINTS, plan: project.plan?.output, previousFiles, revisionNotes }), parseCodeOutput, signal, LIVE_CODER_TIMEOUT_MS);
    } catch (error) {
      // An unusable reply goes back to the Coder like a compile error; timeouts and provider errors end the run.
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted || !(error instanceof SyntaxError || isInvalidReplyError(message))) throw error;
      const note = invalidCodeReplyNote(message);
      project.rounds.push({ round, code: { status: 'failed', reasoning: message }, build: { status: 'failed', errors: [note], checkedFiles: [], browserVerified: false } });
      emit(entry, 'build_failed', { errors: summarizeErrors([note]) }, round);
      revisionNotes = [...start.revisionNotes.filter((item) => item === REPAIR_INSTRUCTIONS), note];
      continue;
    }
    const attempt: StudioProject['rounds'][number] = { round, code: { status: 'success', output: code.output } };
    project.rounds.push(attempt);
    project.generationMetrics = metrics(entry);
    emit(entry, 'code_ready', { files: code.output.files.length }, round);
    // A repair that returns every file unchanged cannot fix a check: say so and ask once more.
    if (start.previousFiles.length && unchangedFiles(code.output.files, start.previousFiles)) {
      attempt.build = { status: 'failed', errors: [UNCHANGED_REPAIR_NOTE], checkedFiles: [], browserVerified: false };
      emit(entry, 'build_failed', { errors: summarizeErrors([UNCHANGED_REPAIR_NOTE]) }, round);
      revisionNotes = [...start.revisionNotes, UNCHANGED_REPAIR_NOTE];
      continue;
    }
    // Real packages are unsupported; like a compile error, the reason goes back to the Coder.
    const dependencies = unsupportedDependencies(code.output.dependencies);
    phase('building', round);
    const build = dependencies.length
      ? { status: 'failed' as const, errors: [dependencyNote(dependencies)], checkedFiles: [] as string[], html: undefined }
      : await buildInBrowser(code.output.files, signal);
    attempt.build = { status: build.status, errors: build.errors, checkedFiles: build.checkedFiles, browserVerified: false };
    emit(entry, build.status === 'passed' ? 'build_passed' : 'build_failed', build.status === 'passed' ? undefined : { errors: summarizeErrors(build.errors) }, round);
    if (build.status === 'passed') {
      entry.html = build.html; entry.files = code.output.files; project.previewFile = `v${round}/dist/index.html`;
      return code.output.files;
    }
    previousFiles = code.output.files;
    revisionNotes = [...start.revisionNotes.filter((note) => note === REPAIR_INSTRUCTIONS), ...build.errors];
  }
  throw new Error(`Build failed after ${limit} attempts`);
}

/**
 * Plan → code/build (compile errors go back to the Coder) → Tester plan → in-page checks →
 * one repair round from failed checks → recheck → ready. Unlike the server, checks run before the
 * single terminal event, so a live run ends only when its checks (and repair) are done.
 */
async function generate(entry: Entry, signal: AbortSignal) {
  const { project } = entry;
  const description = project.description;
  let repairReverted = false;
  const phase = (name: string, round?: number) => {
    project.phase = name; project.status = 'running';
    emit(entry, 'phase', { phase: name }, round);
  };
  try {
    if (project.strategy !== 'coder-only') {
      phase('planning');
      const plan = await ask('Manager', managerPrompt(description, { constraints: STUDIO_CONSTRAINTS, deliverable: STUDIO_DELIVERABLE }), parsePlanOutput, signal, AGENT_TIMEOUT_MS);
      project.plan = { status: 'success', output: plan.output };
      project.generationMetrics = metrics(entry);
      emit(entry, 'plan_ready', { projectName: plan.output.projectName });
    }
    const files = await codeUntilBuilt(entry, signal, phase, { previousFiles: [], revisionNotes: [], maxRounds: 3 });
    const checks = await planChecks(entry, signal);
    if (checks) {
      let plan = checks;
      let outcome = await runChecks(entry, plan, signal);
      // The Tester can be wrong too: before blaming the Coder, it re-examines its failing checks once.
      if (outcome.failed && !outcome.errors.length) {
        const review = await reviewChecks(entry, plan, outcome.results, signal);
        if (review.revised || review.dropped) {
          plan = review.checks;
          outcome = await runChecks(entry, plan, signal);
        }
      }
      if (outcome.failed && project.rounds.length < LIVE_MAX_ROUNDS) {
        const beforeRepair = outcome;
        const good = { html: entry.html, files: entry.files, previewFile: project.previewFile };
        const notes = [REPAIR_INSTRUCTIONS, ...browserFailureNotes(plan, outcome.results, outcome.errors)];
        try {
          await codeUntilBuilt(entry, signal, phase, { previousFiles: files, revisionNotes: notes, maxRounds: 2 });
          outcome = await runChecks(entry, plan, signal);
          repairReverted = outcome.passed < beforeRepair.passed || outcome.errors.length > beforeRepair.errors.length;
        } catch (error) {
          if (signal.aborted) throw error;
          repairReverted = true;
        }
        if (repairReverted) {
          // Keep the repair rounds as history, but serve and recheck the earlier build.
          Object.assign(entry, { html: good.html, files: good.files }); project.previewFile = good.previewFile;
          await runChecks(entry, plan, signal);
        }
      }
    }
    project.status = 'ready_for_review'; project.phase = 'ready_for_review'; project.archiveFile = 'source.zip'; project.finishedAt = now();
    project.generationMetrics = metrics(entry);
    emit(entry, 'ready_for_review', { previewFile: project.previewFile, ...(repairReverted ? { repairReverted: true } : {}) });
  } catch (error) {
    const cancelled = signal.aborted;
    finishFailed(entry, cancelled ? 'Cancelled by you' : error instanceof Error ? error.message : String(error), cancelled ? 'cancelled' : 'failed');
    project.generationMetrics = metrics(entry);
  }
}

/** The Tester writes a plan for the working build; `null` when planning fails (the app still ships). */
async function planChecks(entry: Entry, signal: AbortSignal) {
  const { project } = entry;
  const plan: StudioTestPlan = { id: crypto.randomUUID(), projectId: project.projectId, previewFile: project.previewFile!, jobId: `live-tests-${project.projectId}`, status: 'running' };
  entry.plan = plan;
  project.phase = 'testing';
  emit(entry, 'test_plan_started', { planId: plan.id });
  try {
    let result;
    // Like a compile error for the Coder: a plan the schema rejects goes back to the Tester once.
    for (let attempt = 1; ; attempt++) {
      try {
        result = await ask('Tester', testerPrompt(project.description, { files: entry.files, changeRequests: [], ...(plan.error ? { invalidPlanFeedback: invalidPlanFeedback(plan.error) } : {}) }), parseTestPlanOutput, signal, AGENT_TIMEOUT_MS, { model: liveCredentials()?.testerModel, temperature: 0.2 });
        if (attempt > 1) plan.error = undefined;
        break;
      } catch (error) {
        const invalid = error instanceof SyntaxError || (error instanceof Error && isInvalidPlanError(error.message));
        if (signal.aborted || !invalid || attempt >= 2) throw error;
        plan.error = error.message.slice(0, 500);
      }
    }
    plan.status = 'ready';
    plan.result = { status: 'success', output: result.output };
    emit(entry, 'test_plan_ready', { planId: plan.id, checks: result.output.checks.length });
    return result.output.checks;
  } catch (error) {
    if (signal.aborted) { plan.status = 'cancelled'; plan.error = 'Cancelled by you'; throw error; }
    plan.status = 'failed';
    plan.error = error instanceof Error ? error.message : String(error);
    emit(entry, 'test_plan_failed', { planId: plan.id, status: plan.status, error: plan.error.slice(0, 300) });
    return null;
  }
}

/**
 * One second look at failing checks: a check the Tester judges wrong is replaced by its corrected
 * version (same name, same requirement); unsupported checks are dropped unless none would remain.
 * A failed review changes nothing.
 */
async function reviewChecks(entry: Entry, checks: BrowserCheck[], results: BrowserCheckResult[], signal: AbortSignal): Promise<{ checks: BrowserCheck[]; revised: number; dropped: number }> {
  const { project } = entry;
  const failing = results.filter((result) => result.status === 'failed');
  const planId = entry.plan?.id;
  project.phase = 'testing';
  emit(entry, 'test_plan_started', { planId, review: true });
  try {
    const failures = failing.map((result) => ({ check: checks.find((check) => check.name === result.name), actual: result.actual, error: result.error }));
    let reply;
    let feedback;
    for (let attempt = 1; ; attempt++) {
      try {
        reply = await ask('Tester', testerReviewPrompt(project.description, { files: entry.files, failures, ...(feedback ? { invalidReviewFeedback: feedback } : {}) }), (object) => ({ verdicts: parseTesterReview(object, failing.map((result) => result.name), checks.length) }), signal, AGENT_TIMEOUT_MS, { model: liveCredentials()?.testerModel, temperature: 0.2 });
        break;
      } catch (error) {
        const invalid = error instanceof SyntaxError || (error instanceof Error && isInvalidReplyError(error.message));
        if (signal.aborted || !invalid || attempt >= 2) throw error;
        feedback = invalidReviewFeedback(error.message);
      }
    }
    const { verdicts } = reply.output;
    const unsupported = verdicts.filter((verdict) => verdict.verdict === 'unsupported');
    const removed = checks.some((check) => !unsupported.some((verdict) => verdict.name === check.name)) ? unsupported : [];
    const dropped = removed.length;
    const revisedChecks = checks.filter((check) => !removed.some((verdict) => verdict.name === check.name)).map((check) => verdicts.find((verdict) => verdict.name === check.name && verdict.check)?.check || check);
    const revised = verdicts.filter((verdict) => verdict.verdict === 'check-wrong').length;
    if (entry.plan?.result && (revised || dropped)) entry.plan.result.output = { ...entry.plan.result.output, checks: revisedChecks, limitations: [...entry.plan.result.output.limitations, ...removed.map(({ name, reason }) => `Not checked: ${name}: ${reason.slice(0, 200)}`)] };
    emit(entry, 'test_plan_ready', { planId, checks: revisedChecks.length, review: true, revised, dropped, llmModel: reply.output.llmModel, llmUsage: reply.output.llmUsage, verdicts: verdicts.map(({ name, verdict, reason }) => ({ name, verdict, reason: reason.slice(0, 200) })) });
    return { checks: revisedChecks, revised, dropped };
  } catch (error) {
    if (signal.aborted) throw error;
    emit(entry, 'test_plan_ready', { planId, checks: checks.length, review: true, revised: 0, dropped: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    return { checks, revised: 0, dropped: 0 };
  }
}

async function runChecks(entry: Entry, checks: BrowserCheck[], signal: AbortSignal) {
  const { project } = entry;
  const runId = crypto.randomUUID();
  project.phase = 'testing';
  emit(entry, 'browser_run_started', { runId, testPlanId: entry.plan?.id, checks: checks.length, source: 'in-page' });
  const { results, errors } = await runInPageChecks(entry.html!, checks, signal, entry.plan?.result?.output.isolation ?? 'shared');
  for (const result of results) emit(entry, 'browser_check', { runId, name: result.name, passed: result.status === 'passed', actual: result.actual });
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = passed !== results.length || errors.length > 0;
  entry.diagnostics.unshift({ id: runId, savedAt: now(), source: 'browser-client', previewFile: project.previewFile!, loaded: true, errors, testPlanId: entry.plan?.id, checks: results });
  emit(entry, 'browser_run_finished', { runId, status: failed ? 'failed' : 'passed', passed, failed: results.length - passed, source: 'in-page', ...(errors.length ? { error: errors[0].slice(0, 300) } : {}) });
  return { passed, failed, results, errors };
}

const providerLabel = (credentials: { provider: string; baseUrl?: string }) => {
  const provider = liveProvider(credentials.provider);
  if (!provider.custom) return provider.label;
  try { return new URL(customEndpoint(credentials.baseUrl || DEFAULT_CUSTOM_BASE_URL)).host; } catch { return provider.label; }
};

function start(description: string, strategy: StudioProject['strategy'] = 'manager-coder'): { projectId: string; jobId: string } {
  const credentials = liveCredentials();
  if (!credentials) throw httpError('Add a model key to build live.', 401);
  const text = description.trim();
  if (!text || text.length > 4000) throw httpError('Provide a project description of 1–4000 characters', 400);
  const projectId = `${LIVE_PREFIX}${crypto.randomUUID()}`;
  const entry: Entry = { project: { projectId, description: text, status: 'queued', startedAt: now(), strategy, rounds: [] }, events: [], diagnostics: [] };
  entries.set(projectId, entry);
  emit(entry, 'queued', { strategy, repair: false, revision: false, retry: false, source: 'browser', provider: providerLabel(credentials), model: credentials.model, ...(credentials.testerModel && credentials.testerModel !== credentials.model ? { testerModel: credentials.testerModel } : {}) });
  const controller = new AbortController();
  controllers.set(projectId, controller);
  void generate(entry, controller.signal).finally(() => { controllers.delete(projectId); void persist(entry); });
  return { projectId, jobId: `live-${projectId}` };
}

const summary = ({ project }: Entry): StudioSummary => ({ projectId: project.projectId, description: project.description, status: project.status, startedAt: project.startedAt, phase: project.phase });

/** Live projects for the project list, newest first. */
export async function liveSummaries(): Promise<StudioSummary[]> {
  await ready();
  return [...entries.values()].filter((entry) => isLiveRun(entry.project.projectId)).map(summary).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Answers a dashboard API call for live projects; `undefined` means "not a live request". */
async function findEntry(projectId: string): Promise<Entry> {
  await ready();
  let entry = entries.get(projectId);
  if (!entry && isSharedProject(projectId)) {
    try {
      const encoded = sessionStorage.getItem(`pixelagent:shared:${projectId}`);
      if (encoded) { importSharedRun(encoded); entry = entries.get(projectId); }
    } catch { /* fall through to 404 */ }
  }
  if (!entry) throw httpError(isSharedProject(projectId) ? 'Open the original share link again to view this run.' : 'This live run is not stored in this browser.', 404);
  return entry;
}

// ---- share links ----
/** A link that replays this finished run anywhere: everything travels in the URL fragment. */
export async function shareLink(projectId: string, origin = `${location.origin}${location.pathname}`): Promise<string> {
  const entry = await findEntry(projectId);
  const { project } = entry;
  if (project.status !== 'ready_for_review' || !entry.html || !entry.files) throw httpError('Only a finished run can be shared.', 409);
  const queued = entry.events.find((event) => event.type === 'queued')?.data || {};
  const round = Number(project.previewFile?.match(/^v(\d+)\//)?.[1]) || project.rounds.length || 1;
  const run: SharedRun = {
    v: 1, description: project.description, provider: String(queued.provider || 'model'), model: String(queued.model || ''), ...(queued.testerModel ? { testerModel: String(queued.testerModel) } : {}),
    projectName: project.plan?.output?.projectName, startedAt: project.startedAt, finishedAt: project.finishedAt, round,
    events: entry.events, html: entry.html, files: entry.files.map(({ path, content }) => ({ path, content })),
    checks: entry.plan?.result?.output.checks,
  };
  return `${origin}#/s/${encodeSharedRun(run)}`;
}

/** Opens a share link as a read-only recorded run; returns its project id. */
export function importSharedRun(encoded: string): string {
  const run = decodeSharedRun(encoded);
  const projectId = `${SHARED_PREFIX}${shareId(encoded)}`;
  try { sessionStorage.setItem(`pixelagent:shared:${projectId}`, encoded); } catch { /* this tab only */ }
  const previewFile = `v${run.round}/dist/index.html`;
  const strategy = run.events.find((event) => event.type === 'queued')?.data?.strategy === 'coder-only' ? 'coder-only' : 'manager-coder';
  entries.set(projectId, {
    project: {
      projectId, description: run.description, status: 'ready_for_review', phase: 'ready_for_review', startedAt: run.startedAt, finishedAt: run.finishedAt,
      strategy, plan: strategy === 'coder-only' ? undefined : { status: 'success', output: { projectName: run.projectName } }, previewFile, archiveFile: 'source.zip',
      rounds: [{ round: run.round, code: { status: 'success', output: { files: run.files, llmProvider: run.provider, llmModel: run.model } }, build: { status: 'passed', errors: [], checkedFiles: run.files.map((file) => file.path), browserVerified: false } }],
    },
    events: run.events as StudioEvent[], html: run.html, files: run.files, diagnostics: [],
    plan: run.checks ? { id: `${projectId}-plan`, projectId, previewFile, jobId: projectId, status: 'ready', result: { status: 'success', output: { checks: run.checks as unknown as BrowserCheck[], limitations: [] } } } : undefined,
  });
  return projectId;
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export async function liveRequest(method: string, path: string, body?: string): Promise<unknown> {
  if (method === 'POST' && path === '/api/studio/projects') {
    const input = JSON.parse(body || '{}');
    return start(input.description || '', input.strategy === 'coder-only' ? 'coder-only' : 'manager-coder');
  }
  const match = path.match(/^\/api\/studio\/projects\/([^/?]+)(?:\/([a-z-]+))?(?:\?(.*))?$/);
  if (!match || !isLiveProject(decodeURIComponent(match[1]))) return undefined;
  const projectId = decodeURIComponent(match[1]);
  const entry = await findEntry(projectId);
  const action = match[2] || '';
  const route = `${method} ${action}`;
  switch (route) {
    case 'GET ': return { project: entry.project };
    case 'GET events': {
      const after = Number(new URLSearchParams(match[3] || '').get('after') || 0);
      if (isSharedProject(projectId) && after === 0) return { events: [], derived: false };
      return { events: entry.events.filter((event) => event.seq > after), derived: false };
    }
    case 'GET preview': if (!entry.html) throw httpError('No preview yet', 409); return { html: entry.html };
    case 'POST cancel': controllers.get(projectId)?.abort(new DOMException('Cancelled by you', 'AbortError')); return { project: entry.project };
    case 'POST retry': return start(entry.project.description);
    case 'GET versions': return { rootProjectId: projectId, selectedProjectId: projectId, versions: [summary(entry)] };
    case 'GET test-plans': return { plans: entry.plan ? [entry.plan] : [] };
    case 'GET browser-runs': return { enabled: false, runs: [] };
    case 'GET diagnostics': return { reports: entry.diagnostics };
    case 'GET reviews': return { reviews: [], current: null };
    default: throw httpError('That action is not available for live browser runs. Clone the repo to use the full Studio.', 405);
  }
}

/** Live counterpart of the SSE stream: replays events after `after`, then follows until the run ends. */
export async function liveEventStream(projectId: string, after: number, onEvent: (event: StudioEvent) => void, signal: AbortSignal): Promise<void> {
  const entry = await findEntry(projectId);
  if (isSharedProject(projectId)) {
    // Recorded gaps, clamped to 0.25–1.6 s like the static replay, so a shared run is watchable.
    let previous: StudioEvent | undefined;
    for (const event of entry.events.filter((item) => item.seq > after)) {
      await pause(previous ? Math.min(1600, Math.max(250, Date.parse(event.at) - Date.parse(previous.at))) : 400, signal);
      if (signal.aborted) return;
      onEvent(event);
      previous = event;
    }
    return;
  }
  for (const event of entry.events.filter((item) => item.seq > after)) onEvent(event);
  if (entry.events.some((event) => TERMINAL.has(event.type))) return;
  await new Promise<void>((resolve) => {
    const set = listeners.get(projectId) || new Set();
    listeners.set(projectId, set);
    const done = () => { set.delete(listener); signal.removeEventListener('abort', done); resolve(); };
    const listener = (event: StudioEvent) => { onEvent(event); if (TERMINAL.has(event.type)) done(); };
    set.add(listener);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Same layout as the server's source.zip. */
export async function liveArchive(projectId: string): Promise<Blob> {
  const entry = await findEntry(projectId);
  if (!entry.html || !entry.files) throw httpError('No build to download yet', 409);
  const build = entry.project.rounds.find((round) => `v${round.round}/dist/index.html` === entry.project.previewFile)?.build;
  const zip: Record<string, Uint8Array> = {};
  for (const file of entry.files) zip[`source/${file.path}`] = strToU8(file.content);
  zip['preview/index.html'] = strToU8(entry.html);
  zip['build-report.json'] = strToU8(JSON.stringify(build, null, 2));
  zip['RUNNING.md'] = strToU8('# Run this project\n\nOpen preview/index.html in a modern browser. No installation is required.\n\nSource files are in source/. Built live in the browser by PixelAgent Hub PLAY LIVE. Build success is not browser interaction verification.\n');
  return new Blob([zipSync(zip)], { type: 'application/zip' });
}

/** Test hook: forget in-memory runs. */
export function resetLiveStudioForTests() { entries.clear(); controllers.clear(); listeners.clear(); loaded = Promise.resolve(); }
