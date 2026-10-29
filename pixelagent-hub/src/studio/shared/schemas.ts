import { z } from 'zod';

/**
 * Output contracts shared by the Node agents and the in-browser Studio (dashboard PLAY LIVE).
 * Keep this module free of Node APIs.
 */
export const planSchema = z.object({
  projectName: z.string().min(1), goal: z.string().min(1),
  phases: z.array(z.object({ id: z.string(), name: z.string(), tasks: z.array(z.string()), assignee: z.string(), priority: z.enum(['high', 'medium', 'low']) })).min(1),
  estimatedRounds: z.number().positive(), risks: z.array(z.string()),
});

// Descriptive fields default to empty: some models omit them, and nothing downstream needs them.
export const codeSchema = z.object({
  language: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), content: z.string().min(1), description: z.string().default('') })).min(1),
  explanation: z.string().default(''), dependencies: z.array(z.string()).default([]),
});

const selector = z.string().min(1).max(160);
const nth = z.number().int().min(0).max(49).optional();
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('advance'), ms: z.number().int().min(100).max(600000) }).strict(),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(50).max(6000) }).strict(),
  z.object({ type: z.literal('click'), selector, nth }).strict(),
  z.object({ type: z.literal('input'), selector, nth, value: z.string().max(300) }).strict(),
  z.object({ type: z.literal('key'), selector, nth, key: z.string().min(1).max(32) }).strict(),
]);
// changed/unchanged: text or attribute relative to before actions; text: rendered text; disabled: native :disabled state; visible: shown; count: matches; attribute: exact attribute or live value.
export const browserCheckSchema = z.object({ name: z.string().min(1).max(120), trace: z.string().max(300).optional(), actions: z.array(action).max(16), selector, nth, expected: z.string().max(300), assertion: z.enum(['text', 'matches', 'disabled', 'visible', 'count', 'attribute', 'changed', 'unchanged', 'stable']).optional(), attribute: z.string().regex(/^(?:[a-z][a-z0-9-]{0,49}|(?:style|css)\.[a-z][a-z-]{0,39})$/).optional() }).strict()
  .refine((check) => check.actions.reduce((total, action) => total + (action.type === 'wait' ? action.ms : 0), 0) <= 8000, 'Waits must total at most 8000 ms per check')
  .refine((check) => check.actions.reduce((total, action) => total + (action.type === 'advance' ? action.ms : 0), 0) <= 600000, 'Advances must total at most 600000 ms per check')
  .refine((check) => check.assertion !== 'count' || check.nth === undefined, 'Count forbids nth')
  .refine((check) => {
    if (check.assertion !== 'matches') return true;
    if (check.expected.length < 1 || check.expected.length > 200 || /\([^)]*[+*][^)]*\)[+*{]/.test(check.expected)) return false;
    try { new RegExp(check.expected, 'u'); return true; } catch { return false; }
  }, 'Matches requires a valid 1–200 character Unicode pattern without nested group quantifiers')
  .refine((check) => !['disabled', 'visible'].includes(check.assertion || 'text') || ['true', 'false'].includes(check.expected), 'Disabled and visible assertions require expected "true" or "false"')
  .refine((check) => !['changed', 'unchanged', 'stable'].includes(check.assertion || '') || check.expected === '', 'Changed, unchanged and stable require expected empty')
  .refine((check) => !['changed', 'unchanged'].includes(check.assertion || '') || check.actions.length > 0, 'changed and unchanged need at least one action')
  .refine((check) => check.actions.reduce((total, action) => total + (action.type === 'advance' ? action.ms : 0), 0) <= 600000, 'Advances must total at most 600000 ms per check')
  .refine((check) => check.assertion !== 'count' || /^\d{1,4}$/.test(check.expected), 'Count assertions require expected to be 1–4 digits')
  .refine((check) => check.assertion === 'attribute' ? check.attribute !== undefined : check.attribute === undefined || ['matches', 'changed', 'unchanged', 'stable'].includes(check.assertion || ''), 'Attribute is required for attribute assertions and optional for matches, changed, unchanged and stable');
// isolation: 'shared' (default; saved and fixed plans) runs checks in order on one page; 'fresh' reloads the app before each check.
export const testPlanSchema = z.object({ checks: z.array(browserCheckSchema).min(1).max(10), limitations: z.array(z.string().max(300)).max(10), isolation: z.enum(['shared', 'fresh']).optional() }).strict().refine((plan) => new Set(plan.checks.map((check) => check.name)).size === plan.checks.length, 'Check names must be unique');

export const filesSchema = z.array(z.object({ path: z.string(), content: z.string() })).min(1).max(40);
export type SourceFile = z.infer<typeof filesSchema>[number];

export const testerReviewSchema = z.object({
  verdicts: z.array(z.object({
    name: z.string().min(1).max(120),
    verdict: z.enum(['check-wrong', 'app-wrong']),
    reason: z.string().max(500).default(''),
    check: browserCheckSchema.optional(),
  })).max(10),
});
