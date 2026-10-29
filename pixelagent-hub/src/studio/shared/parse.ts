import { z } from 'zod';
import { browserCheckSchema, codeSchema, planSchema, testPlanSchema } from './schemas.js';

/** A model reply as one JSON object: the first fenced block if present, otherwise the whole reply. */
export function parseModelObject(raw: string): Record<string, unknown> {
  // Reasoning models (qwen3, R1-style) may prefix their reply with a <think> block.
  const trimmed = raw.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
  const text = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? trimmed;
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch (error) {
    // Some models drop the opening quote of a key (`"actions":[],selector":"#count"`; 23% of
    // gemini-3.8-flash replies). Retry once with those keys quoted; otherwise keep the real error.
    try { object = JSON.parse(text.replace(/([{,[]\s*)([A-Za-z_][\w-]*)"\s*:/g, '$1"$2":')); } catch { throw error; }
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Expected a JSON object');
  return object as Record<string, unknown>;
}

/** Schema failures read as one short sentence instead of a raw issue dump. */
function parseWith<T>(schema: z.ZodType<T>, object: unknown, what: string): T {
  const result = schema.safeParse(object);
  if (result.success) return result.data;
  throw new Error(`The ${what} did not match the expected format: ${z.prettifyError(result.error).replace(/\s*\n\s*/g, '; ').slice(0, 500)}`);
}

export const parsePlanOutput = (object: unknown) => {
  const { projectName, goal, phases, estimatedRounds, risks } = parseWith(planSchema, object, 'plan');
  return { projectName, goal, phases, estimatedRounds, risks };
};

export const parseCodeOutput = (object: unknown) => {
  const { language, files, explanation, dependencies } = parseWith(codeSchema, object, 'code');
  return { language, files, explanation, dependencies };
};

/** Model-written checks: null optional assertion/attribute/nth fields mean omitted. */
const normaliseCheck = (check: unknown) => {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return check;
  const { assertion, attribute, nth, actions, ...rest } = check as Record<string, unknown>;
  const normalisedActions = Array.isArray(actions) ? actions.map((action) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
    if (action.type === 'wait' || action.type === 'advance') return { type: action.type, ms: action.ms };
    const { nth, ...rest } = action;
    return { ...rest, ...(nth == null ? {} : { nth }) };
  }) : actions;
  return { ...rest, actions: normalisedActions, ...(nth == null ? {} : { nth }), ...(['changed', 'unchanged', 'stable'].includes(String(assertion)) ? { expected: '' } : {}), ...(assertion == null ? {} : { assertion }), ...(attribute == null ? {} : { attribute }) };
};

/**
 * Descriptive fields are normalised (limitations: strings, ≤300 chars, ≤10 items) and a check that
 * does not match the check format is dropped, with a note, instead of sinking the whole plan.
 */
const normalisePlan = (object: unknown) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return object;
  const { limitations, checks, ...rest } = object as Record<string, unknown>;
  const notes = (Array.isArray(limitations) ? limitations : limitations === undefined || limitations === null ? [] : [limitations])
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)).slice(0, 300));
  let list = checks;
  if (Array.isArray(checks)) {
    const valid = checks.map(normaliseCheck).filter((check) => browserCheckSchema.safeParse(check).success);
    if (valid.length) list = valid;
    if (valid.length && valid.length < checks.length) {
      notes.unshift(`${checks.length - valid.length} planned check(s) were dropped because they did not match the check format.`);
    }
  }
  return { ...rest, checks: list, limitations: notes.slice(0, 10) };
};

export const parseTestPlanOutput = (object: unknown) => parseWith(testPlanSchema, normalisePlan(object), 'test plan');

/**
 * Tester review, validated verdict by verdict: a "check-wrong" verdict counts only for a check that
 * actually failed and only with a valid corrected check of the same name; anything else leaves the
 * failure standing, except bounded unsupported verdicts with a reason. Only a reply without a verdicts list is rejected.
 */
export const parseTesterReview = (object: unknown, failing: readonly string[], planSize: number) => {
  const raw = object && typeof object === 'object' && !Array.isArray(object) ? (object as { verdicts?: unknown }).verdicts : undefined;
  if (!Array.isArray(raw)) throw new Error('The test review did not match the expected format: no verdicts list');
  const verdicts = raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const check = value.check ? browserCheckSchema.safeParse(normaliseCheck(value.check)) : undefined;
    const verdict = typeof value.correctAppPasses === 'boolean'
      ? value.correctAppPasses ? 'app-wrong' : check?.success && check.data.name === value.name ? 'check-wrong' : 'unsupported'
      : value.verdict;
    return [{
      name: typeof value.name === 'string' ? value.name : '',
      verdict: verdict === 'check-wrong' ? 'check-wrong' as const : verdict === 'unsupported' ? 'unsupported' as const : 'app-wrong' as const,
      reason: (typeof value.reason === 'string' ? value.reason : value.reason == null ? '' : JSON.stringify(value.reason)).slice(0, 500),
      hasReason: typeof value.reason === 'string' && !!value.reason.trim(),
      check: check?.success ? check.data : undefined,
    }];
  });
  const unsupported = new Set<string>();
  const seen = new Set<string>();
  for (const item of verdicts) {
    if (!failing.includes(item.name) || seen.has(item.name)) continue;
    seen.add(item.name);
    if (item.verdict === 'unsupported' && item.hasReason && unsupported.size < Math.max(1, Math.floor(planSize / 3))) unsupported.add(item.name);
  }
  return failing.map((name) => {
    const verdict = verdicts.find((item) => item.name === name);
    const corrected = verdict?.verdict === 'check-wrong' && verdict.check?.name === name ? verdict.check : undefined;
    return { name, verdict: corrected ? 'check-wrong' as const : unsupported.has(name) ? 'unsupported' as const : 'app-wrong' as const, reason: verdict?.reason || '', check: corrected };
  });
};
