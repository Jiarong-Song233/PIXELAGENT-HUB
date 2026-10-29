import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodeOutput, parseModelObject, parseTestPlanOutput } from './parse.js';
import { inlineDocument, utf8ToBase64, validateFiles } from './inline.js';
import { coderPrompt, STUDIO_CONSTRAINTS } from './prompts.js';

test('model replies parse from a fenced block or bare JSON, and must be one object', () => {
  assert.deepEqual(parseModelObject('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelObject(' {"a":2} '), { a: 2 });
  assert.throws(() => parseModelObject('[1,2]'), /Expected a JSON object/);
});

test('a leading <think> block from a reasoning model is ignored', () => {
  assert.deepEqual(parseModelObject('<think>\nThe user wants {"a": 0}\n</think>\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelObject('<think></think>{"b":2}'), { b: 2 });
});

test('code output tolerates omitted descriptive fields but not missing files', () => {
  assert.deepEqual(parseCodeOutput({ language: 'javascript', files: [{ path: 'index.html', content: '<p>hi</p>' }] }),
    { language: 'javascript', files: [{ path: 'index.html', content: '<p>hi</p>', description: '' }], explanation: '', dependencies: [] });
  assert.throws(() => parseCodeOutput({ language: 'javascript', files: [] }), /The code did not match the expected format: .*files/);
  assert.throws(() => parseTestPlanOutput({ checks: [], limitations: [] }), /The test plan did not match/);
});

test('test plans keep their checks when limitations are malformed', () => {
  const check = { name: 'Adds one', actions: [], selector: '#count', expected: '1' };
  const parsed = parseTestPlanOutput({ checks: [check], isolation: 'fresh', limitations: [{ note: 'canvas' }, 'x'.repeat(400), ...Array(12).fill('more')] });
  assert.equal(parsed.checks.length, 1);
  assert.deepEqual(parsed.limitations[0], '{"note":"canvas"}');
  assert.equal(parsed.limitations[1].length, 300);
  assert.equal(parsed.limitations.length, 10);
  assert.deepEqual(parseTestPlanOutput({ checks: [check] }).limitations, []);
  assert.throws(() => parseTestPlanOutput({ checks: [], limitations: [] }), /did not match/);
});

test('the tester prompt explains how to set selects and asks for self-contained checks', async () => {
  const { testerPrompt } = await import('./prompts.js');
  assert.match(testerPrompt('x').system, /To choose a <select> option, use an input action/);
  assert.match(testerPrompt('x').system, /sets every input and select it depends on/);
});

test('the coder prompt carries the shared constraints unchanged', () => {
  const { user } = coderPrompt('A counter', 'javascript', { constraints: STUDIO_CONSTRAINTS, revisionNotes: [] });
  assert.match(user, /^Task: "A counter"\nLanguage: javascript\nContext: /);
  assert.ok(user.includes(JSON.stringify(STUDIO_CONSTRAINTS)));
  assert.ok(STUDIO_CONSTRAINTS.includes("[hidden] { display: none !important; }"));
  assert.ok(user.includes('"revisionNotes":[]'));
});

test('utf8ToBase64 matches Buffer for multi-byte and large input', () => {
  for (const text of ['', 'é ✓ 漢字 🎮', 'x'.repeat(200_000)]) assert.equal(utf8ToBase64(text), Buffer.from(text).toString('base64'));
});

test('validateFiles rejects unsafe paths and projects without index.html', () => {
  assert.throws(() => validateFiles([{ path: '../evil.js', content: '' }]), /unsafe source path/);
  assert.throws(() => validateFiles([{ path: 'app.js', content: '' }]), /requires index.html/);
});

test('inlineDocument refuses external scripts through any adapter', async () => {
  const doc = { hasEmbeddedDocuments: () => false, scripts: () => [{ src: 'https://cdn.example/x.js', text: '', removeIntegrity() {}, setSrc() {}, setText() {} }], stylesheets: () => [], removeMetaAndLinks() {}, prependToHead() {}, serialize: () => '' };
  await assert.rejects(inlineDocument(doc, new Map(), async (code) => code), /Missing or external script/);
});

test('only real package names count as unsupported dependencies', async () => {
  const { unsupportedDependencies, dependencyNote } = await import('./dependencies.js');
  assert.deepEqual(unsupportedDependencies(['none', 'HTML5', 'CSS3', 'Vanilla JS', 'canvas API', 'localStorage', ' ']), []);
  assert.deepEqual(unsupportedDependencies(['react', 'none', 'lodash@4']), ['react', 'lodash@4']);
  assert.match(dependencyNote(['react']), /Unsupported dependencies: react\..*"dependencies": \[\]/);
});

test('a Tester review only revises a failing check with a valid corrected check of the same name', async () => {
  const { parseTesterReview } = await import('./parse.js');
  const fixed = { name: 'Adds one', trace: 'count starts 0; +1 → 1', actions: [{ type: 'click', selector: '#add' }], selector: '#count', expected: '1' };
  const verdicts = parseTesterReview({ verdicts: [
    { name: 'Adds one', verdict: 'check-wrong', reason: 'never clicked', check: fixed },
    { name: 'Resets', verdict: 'check-wrong', reason: 'no corrected check given' },
    { name: 'Renamed', verdict: 'check-wrong', reason: 'x', check: { ...fixed, name: 'Something else' } },
    { name: 'Not failing', verdict: 'check-wrong', reason: 'ignored', check: { ...fixed, name: 'Not failing' } },
  ] }, ['Adds one', 'Resets', 'Renamed', 'Missing'], 5);
  assert.deepEqual(verdicts.map((item) => item.verdict), ['check-wrong', 'app-wrong', 'app-wrong', 'app-wrong']);
  assert.deepEqual(verdicts[0].check, fixed);
});

test('real-world Tester replies: bad items are dropped or defaulted, not fatal', async () => {
  const { parseTesterReview } = await import('./parse.js');
  const good = { name: 'Win hidden', actions: [], selector: '#win', expected: 'false', assertion: 'visible' };
  // Shapes seen from deepseek-chat: null reasons, null assertions, overlong reasons, invalid checks.
  const verdicts = parseTesterReview({ verdicts: [
    { name: 'Win hidden', verdict: 'check-wrong', reason: null, check: good },
    { name: 'Intro text', verdict: 'check-wrong', reason: 'x'.repeat(900), check: { name: 'Intro text', actions: [], selector: '#intro', expected: 'Hi', assertion: null } },
    { name: 'Broken', verdict: 'check-wrong', reason: 'r', check: { name: 'Broken', actions: [{ type: 'wait' }], selector: '#a', expected: '1' } },
  ] }, ['Win hidden', 'Intro text', 'Broken'], 3);
  assert.deepEqual(verdicts.map((item) => item.verdict), ['check-wrong', 'check-wrong', 'app-wrong']);
  assert.equal(verdicts[1].check?.assertion, undefined);
  assert.equal(verdicts[1].reason.length, 500);
  assert.throws(() => parseTesterReview({ notVerdicts: [] }, ['x'], 1), /no verdicts list/);

  const plan = parseTestPlanOutput({ checks: [good, { name: 'Bad', actions: [{ type: 'wait' }], selector: '#a', expected: '1' }, { ...good, name: 'Null assertion', assertion: null, expected: 'Hi' }], limitations: [] });
  assert.deepEqual(plan.checks.map((check) => check.name), ['Win hidden', 'Null assertion']);
  assert.match(plan.limitations[0], /1 planned check\(s\) were dropped/);
  assert.throws(() => parseTestPlanOutput({ checks: [{ name: 'Bad', actions: [{ type: 'wait' }], selector: '#a', expected: '1' }], limitations: [] }), /did not match/);
  assert.throws(() => parseTestPlanOutput({ checks: [{ ...good, expected: 'shown' }], limitations: [] }), /did not match/);
});

test('count and attribute schemas enforce their expected values and attribute names', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  const check = { name: 'Board', actions: [], selector: '.card', expected: '16', assertion: 'count' };
  for (const expected of ['0', '16', '9999', '0016']) assert.equal(browserCheckSchema.safeParse({ ...check, expected }).success, true);
  for (const expected of ['abc', '-1', '1.5', '10000', '', ' 16']) assert.equal(browserCheckSchema.safeParse({ ...check, expected }).success, false);
  for (const attribute of ['aria-valuenow', 'aria-pressed', 'data-state', 'value', 'class', 'title', 'a'.repeat(50)]) {
    assert.equal(browserCheckSchema.safeParse({ ...check, assertion: 'attribute', attribute }).success, true);
  }
  for (const change of [{ assertion: 'attribute' }, { assertion: 'text', attribute: 'title' }, { attribute: 'title' }, ...['', 'Title', 'aria_value', 'a'.repeat(51)].map((attribute) => ({ assertion: 'attribute', attribute }))]) {
    assert.equal(browserCheckSchema.safeParse({ ...check, ...change }).success, false);
  }
  assert.equal(browserCheckSchema.safeParse({ ...check, assertion: undefined, attribute: 'title' }).success, false);
});

test('null optional check fields are normalised even when every check is valid', () => {
  const check = { name: 'Text', actions: [], selector: '#text', expected: 'Hi' };
  const parsed = parseTestPlanOutput({ checks: [{ ...check, assertion: null, attribute: null }], limitations: [] });
  assert.deepEqual(parsed.checks, [check]);
  assert.throws(() => parseTestPlanOutput({ checks: [{ ...check, assertion: 'attribute', attribute: null }] }), /did not match/);
});

test('repair notes identify the counted selector and the compared attribute', async () => {
  const { browserFailureNotes } = await import('./repair.js');
  const checks = [
    { name: 'Cards', trace: 'board starts with 16 cards; no actions → 16', actions: [], selector: '.card', expected: '16', assertion: 'count' as const },
    { name: 'Hunger', actions: [], selector: '#hungerBar', expected: '90', assertion: 'attribute' as const, attribute: 'aria-valuenow' },
  ];
  const notes = browserFailureNotes(checks, checks.map((check) => ({ name: check.name, status: 'failed', actual: '' })));
  assert.ok(notes.every((note) => !note.includes('trace') && !note.includes(checks[0].trace!)));
  assert.match(notes[0], /selector=".card", assertion="count"/);
  assert.match(notes[1], /assertion="attribute", attribute="aria-valuenow"/);
});

test('unsupported reviews require a reason, ignore passing checks and cap drops in reply order by plan size', async () => {
  const { parseTesterReview } = await import('./parse.js');
  const reply = { verdicts: [
    { name: 'Passing', verdict: 'unsupported', reason: 'ignored' },
    { name: 'Blank', verdict: 'unsupported', reason: '  ' },
    ...['Third', 'Second', 'First'].map((name) => ({ name, verdict: 'unsupported', reason: 'Cannot read canvas pixels' })),
  ] };
  const failing = ['First', 'Second', 'Third', 'Blank'];
  for (const [size, expected] of [[4, ['app-wrong', 'app-wrong', 'unsupported', 'app-wrong']], [6, ['app-wrong', 'unsupported', 'unsupported', 'app-wrong']]] as const) {
    const verdicts = parseTesterReview(reply, failing, size);
    assert.deepEqual(verdicts.map((item) => item.verdict), expected);
    assert.ok(verdicts.every((item) => item.check === undefined));
    assert.ok(!verdicts.some((item) => item.name === 'Passing'));
  }
  assert.equal(parseTesterReview({ verdicts: [reply.verdicts[2]] }, ['Third'], 1)[0].verdict, 'unsupported');
});


test('relative text assertions require actions and empty expected; model values normalise', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  for (const assertion of ['changed', 'unchanged']) {
    const check = { name: assertion, actions: [{ type: 'click', selector: '#generate' }], selector: '#color', assertion, expected: '' };
    assert.equal(browserCheckSchema.safeParse(check).success, true);
    for (const change of [{ actions: [] }, { expected: '__CAPTURED_HEX__' }]) {
      assert.equal(browserCheckSchema.safeParse({ ...check, ...change }).success, false);
    }
    const invalid = browserCheckSchema.safeParse({ ...check, actions: [] });
    assert.ok(!invalid.success && invalid.error.issues.some((issue) => issue.message === 'changed and unchanged need at least one action'));
    const parsed = parseTestPlanOutput({ checks: [{ ...check, expected: '__CAPTURED_HEX__' }], limitations: [] });
    assert.equal(parsed.checks[0].expected, '');
    assert.equal(parsed.checks[0].assertion, assertion);
  }
});

test('matches validates bounded Unicode patterns and nth preserves strict action variants', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  const check = { name: 'Hex', actions: [], selector: '.color', assertion: 'matches', expected: '^#[0-9A-F]{6}$' };
  assert.equal(browserCheckSchema.safeParse(check).success, true);
  for (const change of [{ expected: '[' }, { expected: '(a+)+' }, { expected: '' }, { expected: 'a'.repeat(201) }, { attribute: 'Title' }, { nth: 50 }, { nth: -1 }, { nth: 0.5 }, { assertion: 'count', expected: '2', nth: 0 }]) {
    assert.equal(browserCheckSchema.safeParse({ ...check, ...change }).success, false, JSON.stringify(change));
  }
  for (const action of [{ type: 'click' }, { type: 'input', value: 'a' }, { type: 'key', key: 'Enter' }]) {
    const actions = [{ ...action, selector: '.color', nth: 49 }];
    assert.equal(browserCheckSchema.safeParse({ ...check, nth: 49, actions }).success, true);
    for (const change of [{ nth: 50 }, { nth: -1 }, { nth: 1.5 }, { extra: true }]) assert.equal(browserCheckSchema.safeParse({ ...check, actions: [{ ...actions[0], ...change }] }).success, false);
  }
});

test('null nth is omitted on checks and actions and reason-first reviews parse', async () => {
  const { parseTesterReview } = await import('./parse.js');
  const check = { name: 'Hex', actions: [{ type: 'click', selector: 'button', nth: null }], selector: '.color', nth: null, assertion: 'matches', expected: '^#[0-9A-F]{6}$' };
  const parsed = parseTestPlanOutput({ checks: [check], limitations: [] }).checks[0];
  assert.equal('nth' in parsed, false);
  assert.equal('nth' in parsed.actions[0], false);
  const reply = parseModelObject(JSON.stringify({ verdicts: [{ name: 'Hex', reason: 'The check expects #, but the app displays a full hex code as required.', verdict: 'check-wrong', check }] }));
  const [review] = parseTesterReview(reply, ['Hex'], 1);
  assert.equal(review.verdict, 'check-wrong');
  assert.deepEqual(review.check, parsed);
});


test('review facts derive verdicts, override legacy verdicts and keep unsupported bounded', async () => {
  const { parseTesterReview } = await import('./parse.js');
  const check = { name: 'Fixed', actions: [], selector: '#count', expected: '1' };
  const verdicts = [
    { name: 'Fixed', reason: 'Wrong expectation', correctAppPasses: false, verdict: 'app-wrong', check },
    { name: 'Unsupported', reason: 'No valid correction', correctAppPasses: false },
    { name: 'Capped', reason: 'No valid correction', correctAppPasses: false },
    { name: 'App', reason: 'App fails requirement', correctAppPasses: true, verdict: 'unsupported', check: { ...check, name: 'App' } },
  ];
  assert.deepEqual(parseTesterReview({ verdicts }, verdicts.map((item) => item.name), 4).map((item) => item.verdict), ['check-wrong', 'unsupported', 'app-wrong', 'app-wrong']);
  for (const correction of [undefined, { ...check, name: 'Other' }, { ...check, actions: [{ type: 'wait' }] }]) {
    const item = { name: 'Fixed', reason: 'No valid correction', correctAppPasses: false, check: correction };
    assert.equal(parseTesterReview({ verdicts: [item] }, ['Fixed'], 1)[0].verdict, 'unsupported');
    assert.equal(parseTesterReview({ verdicts: [{ ...item, reason: ' ' }] }, ['Fixed'], 1)[0].verdict, 'app-wrong');
  }
});


test('inline style names are strict and stable allows zero actions with normalised expected', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  const check = { name: 'Stable', actions: [], selector: '#timer', assertion: 'stable', expected: '' };
  assert.equal(browserCheckSchema.safeParse(check).success, true);
  for (const change of [{ expected: '25:00' }]) assert.equal(browserCheckSchema.safeParse({ ...check, ...change }).success, false);
  assert.equal(parseTestPlanOutput({ checks: [{ ...check, expected: '25:00' }], limitations: [] }).checks[0].expected, '');
  for (const attribute of ['style.width', 'style.background-color', 'style.left', 'css.transform', 'css.background-color']) assert.equal(browserCheckSchema.safeParse({ ...check, assertion: 'attribute', attribute }).success, true);
  for (const attribute of ['style.', 'style.Width', 'style.width1', 'style.' + 'a'.repeat(41), 'css.', 'css.Transform', 'css.width1', 'css.' + 'a'.repeat(41)]) assert.equal(browserCheckSchema.safeParse({ ...check, assertion: 'attribute', attribute }).success, false);
});

test('matches accepts optional attributes with the same name rules', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  const check = { name: 'Pattern', actions: [], selector: 'input', assertion: 'matches', expected: '^.+$' };
  for (const attribute of [undefined, 'aria-label', 'value', 'checked', 'style.width']) assert.equal(browserCheckSchema.safeParse({ ...check, attribute }).success, true);
  for (const attribute of ['', 'Title', 'style.Width']) assert.equal(browserCheckSchema.safeParse({ ...check, attribute }).success, false);
});

test('wait actions are bounded, selector-free and normalised to type and ms', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  const check = { name: 'Wait', actions: [{ type: 'wait', ms: 500 }], selector: '#status', expected: 'Ready' };
  assert.equal(browserCheckSchema.safeParse(check).success, true);
  for (const actions of [[{ type: 'wait', ms: 10 }], [{ type: 'wait', ms: 7000 }], [{ type: 'wait', ms: 50.5 }], [{ type: 'wait', ms: 500, selector: '#status' }], [{ type: 'wait', ms: 4500 }, { type: 'wait', ms: 4500 }]]) {
    assert.equal(browserCheckSchema.safeParse({ ...check, actions }).success, false);
  }
  assert.equal(browserCheckSchema.safeParse({ ...check, actions: [{ type: 'wait', ms: 6000 }, { type: 'wait', ms: 2000 }] }).success, true);
  const parsed = parseTestPlanOutput({ checks: [{ ...check, actions: [{ type: 'wait', ms: 500, nth: null, selector: null, value: 'discard' }] }], limitations: [] });
  assert.deepEqual(parsed.checks[0].actions, [{ type: 'wait', ms: 500 }]);
});


test('attribute is optional only for attribute-aware assertions', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  const check = { name: 'State', actions: [{ type: 'click', selector: 'button' }], selector: '#state', expected: '', attribute: 'class' };
  for (const assertion of ['changed', 'unchanged', 'stable']) assert.equal(browserCheckSchema.safeParse({ ...check, assertion }).success, true);
  for (const [assertion, expected] of [['text', ''], ['count', '0'], ['visible', 'true']]) assert.equal(browserCheckSchema.safeParse({ ...check, assertion, expected }).success, false);
});

test('test plans preserve traces and reject traces over 300 characters', () => {
  const check = { name: 'Adds one', trace: 'count starts 0; +1 → 1', actions: [{ type: 'click', selector: '#add' }], selector: '#count', expected: '1' };
  assert.deepEqual(parseTestPlanOutput({ checks: [check] }).checks, [check]);
  assert.equal(parseTestPlanOutput({ checks: [{ ...check, trace: 'x'.repeat(300) }] }).checks[0].trace?.length, 300);
  assert.throws(() => parseTestPlanOutput({ checks: [{ ...check, trace: 'x'.repeat(301) }] }), /did not match/);
});

test('test plans accept 16 actions per check and reject 17', () => {
  const actions = Array.from({ length: 16 }, () => ({ type: 'click', selector: 'button' }));
  const check = { name: 'Sixteen clicks', actions, selector: 'output', expected: '16' };
  assert.equal(parseTestPlanOutput({ checks: [check], limitations: [] }).checks[0].actions.length, 16);
  assert.throws(() => parseTestPlanOutput({ checks: [{ ...check, actions: [...actions, actions[0]] }], limitations: [] }), /did not match/);
});


test('advance has independent bounds and normalises to type and ms', async () => {
  const { browserCheckSchema } = await import('./schemas.js');
  const check = { name: 'Round', actions: [{ type: 'advance', ms: 30000 }], selector: '#status', expected: 'Game over' };
  assert.equal(browserCheckSchema.safeParse(check).success, true);
  for (const actions of [[{ type: 'advance', ms: 50 }], [{ type: 'advance', ms: 700000 }], [{ type: 'advance', ms: 100.5 }], [{ type: 'advance', ms: 30000, selector: '#status' }], [{ type: 'advance', ms: 350000 }, { type: 'advance', ms: 350000 }]]) {
    assert.equal(browserCheckSchema.safeParse({ ...check, actions }).success, false);
  }
  assert.equal(browserCheckSchema.safeParse({ ...check, actions: [{ type: 'advance', ms: 600000 }, { type: 'wait', ms: 6000 }, { type: 'wait', ms: 2000 }] }).success, true);
  const parsed = parseTestPlanOutput({ checks: [{ ...check, actions: [{ type: 'advance', ms: 30000, selector: null, nth: null, value: 'discard' }] }], limitations: [] });
  assert.deepEqual(parsed.checks[0].actions, check.actions);
});
