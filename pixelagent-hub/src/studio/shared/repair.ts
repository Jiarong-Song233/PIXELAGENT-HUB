import type { z } from 'zod';
import type { browserCheckSchema } from './schemas.js';

/**
 * Repair notes from a failed browser-check run: the exact text the Coder receives, shared by the
 * server (repair from a saved browser run) and PLAY LIVE (automatic repair round).
 */
type PlannedCheck = { name: string; selector: string; nth?: number; expected: string; assertion?: 'text' | 'matches' | 'disabled' | 'visible' | 'count' | 'attribute' | 'changed' | 'unchanged' | 'stable'; attribute?: string; actions: z.infer<typeof browserCheckSchema>['actions'] };
type CheckResult = { name: string; status: 'passed' | 'failed'; actual: string; error?: string; page?: string };

/**
 * `pages` adds the markup captured at up to three failures. It is off in the pipeline: an offline A/B on
 * 38 failing apps (docs/software-studio/benchmark-results/2026-10-30-repair-context) found no gain.
 */
export function browserFailureNotes(planned: PlannedCheck[], results: CheckResult[], runtimeErrors: string[] = [], blockedRequests: string[] = [], { pages = false } = {}): string[] {
  const failed = results.filter((check) => check.status === 'failed');
  return [
    ...failed.map((check) => {
      const plan = planned.find((item) => item.name === check.name)!;
      return `Browser check ${JSON.stringify(check.name)}: selector=${JSON.stringify(plan.selector)}, assertion=${JSON.stringify(plan.assertion || 'text')}${plan.attribute ? `, attribute=${JSON.stringify(plan.attribute)}` : ''}${plan.nth === undefined ? '' : `, nth=${plan.nth}`}, ${plan.assertion === 'matches' ? 'pattern' : 'expected'}=${JSON.stringify(plan.expected)}, actual=${JSON.stringify(check.actual)}, failure=${JSON.stringify(check.error || 'Assertion failed')}, actions=${JSON.stringify(plan.actions)}`;
    }),
    ...(pages ? failed : []).filter((check) => check.page).slice(0, 3).map((check) => `Page markup when browser check ${JSON.stringify(check.name)} failed (scripts and styles removed): ${check.page}`),
    ...runtimeErrors.map((error) => `Browser runtime/console error: ${error}`),
    ...blockedRequests.map((request) => `Blocked network request from offline app: ${request}`),
  ].slice(0, 20).map((note) => note.slice(0, 2000));
}

type SourceFiles = readonly { path: string; content: string }[];

/** True when a repair returned exactly the files it was asked to repair: it cannot change any check. */
export function unchangedFiles(next: SourceFiles, previous: SourceFiles): boolean {
  return next.length === previous.length && next.every((file) => previous.some((old) => old.path === file.path && old.content === file.content));
}

export const UNCHANGED_REPAIR_NOTE = 'Your previous repair returned every file unchanged, so the same browser checks would fail again. Find the code that causes the failures above and change it.';

