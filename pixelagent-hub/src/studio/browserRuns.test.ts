import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserRepairErrors, contentHash, executeBrowserRun, listBrowserRuns, saveBrowserRun, type BrowserRun } from './browserRuns.js';
import type { TestPlanRecord } from './testPlans.js';
import { buildStaticProject } from './workspace.js';
import { testPlanSchema } from './testPlans.js';

const html = '<html><body><input aria-label="Name" id="name"><button id="add">Add</button><output>0</output><script>document.querySelector("#add").addEventListener("click",()=>document.querySelector("output").textContent++);document.querySelector("#name").addEventListener("keydown",e=>{if(e.key==="Enter")document.querySelector("output").textContent=e.target.value})</script></body></html>';
const plan = { checks: [
  { name: 'Increment', actions: [{ type: 'click', selector: '#add' }], selector: 'output', expected: '1' },
  { name: 'Enter name', actions: [{ type: 'input', selector: '#name', value: 'Pixel' }, { type: 'key', selector: '#name', key: 'Enter' }], selector: 'output', expected: 'Pixel' },
], limitations: ['Controlled browser fixture; not model quality evidence'] };
const makeRun = (content = html, checks: unknown = plan): BrowserRun => ({ id: randomUUID(), projectId: randomUUID(), testPlanId: randomUUID(), previewFile: 'v1/dist/index.html', previewHash: contentHash(content), planHash: contentHash(JSON.stringify(testPlanSchema.parse(checks))), jobId: randomUUID(), source: 'server-browser', status: 'queued', startedAt: new Date().toISOString(), viewport: { width: 1280, height: 720 }, checks: [], errors: [], blockedRequests: [], screenshots: [] });

test('disabled assertions require booleans as text while legacy plans retain their hash', () => {
  assert.equal(contentHash(JSON.stringify(testPlanSchema.parse(plan))), contentHash(JSON.stringify(plan)));
  const check = { name: 'Locked', actions: [], selector: '#answer', assertion: 'disabled', expected: 'true' };
  assert.equal(testPlanSchema.safeParse({ checks: [check], limitations: [] }).success, true);
  for (const change of [{ expected: '4' }, { expected: '' }, { assertion: 'eval' }, { assertion: 'attribute', code: 'alert(1)' }]) {
    assert.equal(testPlanSchema.safeParse({ checks: [{ ...check, ...change }], limitations: [] }).success, false);
  }
});

test('real browser observes native disabled state without clicking locked controls', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-disabled-'));
  try {
    const content = '<html><body><button id="answer">4</button><button id="reset">Reset</button><script>document.querySelector("#answer").addEventListener("click",e=>e.target.disabled=true);document.querySelector("#reset").addEventListener("click",()=>document.querySelector("#answer").disabled=false)</script></body></html>';
    const checks = { checks: [
      { name: 'Initially enabled', actions: [], selector: '#answer', assertion: 'disabled', expected: 'false' },
      { name: 'Answer locks', actions: [{ type: 'click', selector: '#answer' }], selector: '#answer', assertion: 'disabled', expected: 'true' },
      { name: 'Text differs from state', actions: [], selector: '#answer', expected: '4' },
      { name: 'Incorrect state', actions: [], selector: '#answer', assertion: 'disabled', expected: 'false' },
      { name: 'Reset unlocks', actions: [{ type: 'click', selector: '#reset' }], selector: '#answer', assertion: 'disabled', expected: 'false' },
    ], limitations: [] };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.deepEqual(run.checks.map((check) => check.status), ['passed', 'passed', 'passed', 'failed', 'passed'], JSON.stringify(run));
    assert.deepEqual(run.checks.map((check) => check.actual), ['false', 'true', '4', 'true', 'false']);
    assert.equal(run.status, 'failed'); assert.equal(run.error, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build preserves deferred and module ordering before DOMContentLoaded in a real browser', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-script-order-'));
  try {
    const report = await buildStaticProject([
      { path: 'index.html', content: '<html><head><script src="first.js" defer></script><script src="module.js" type="module"></script><script src="second.js" defer></script></head><body><output id="order"></output><output id="count">0</output><button id="add">Add</button><script>window.order = ["inline"];</script></body></html>' },
      { path: 'first.js', content: 'window.order.push("defer-one"); document.addEventListener("DOMContentLoaded", () => { window.order.push("loaded"); document.querySelector("#order").textContent = window.order.join(","); });' },
      { path: 'module.js', content: 'window.order.push("module");' },
      { path: 'second.js', content: 'window.order.push("defer-two"); document.querySelector("#add").addEventListener("click", () => document.querySelector("#count").textContent = "1");' },
    ], join(root, 'build'));
    assert.equal(report.status, 'passed');
    const preview = await readFile(join(root, 'build/dist/index.html'), 'utf8');
    const checks = { checks: [
      { name: 'Parser scheduling', actions: [], selector: '#order', expected: 'inline,defer-one,module,defer-two,loaded' },
      { name: 'Handler sees parsed button', actions: [{ type: 'click', selector: '#add' }], selector: '#count', expected: '1' },
    ], limitations: ['Controlled scheduling regression'] };
    const run = await executeBrowserRun({ root, run: makeRun(preview, checks), html: preview, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.status, 'passed', JSON.stringify(run));
    assert.deepEqual(run.blockedRequests, []); assert.deepEqual(run.errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser repair binds completed application failures to the exact preview and saved plan', () => {
  const run = makeRun();
  Object.assign(run, { status: 'failed', finishedAt: new Date().toISOString(), browserVersion: 'fixture', screenshots: ['initial.png', 'final.png'], checks: [{ name: 'Increment', status: 'failed', actual: '2', error: 'Expected 1' }, { name: 'Enter name', status: 'passed', actual: 'Pixel' }] });
  const saved: TestPlanRecord = { id: run.testPlanId, projectId: run.projectId, previewFile: run.previewFile, jobId: 'fixture-plan', status: 'ready', startedAt: run.startedAt, result: { taskId: 'fixture', agentId: 'tester', status: 'success', output: plan } };
  const errors = browserRepairErrors(run, saved, html);
  assert.equal(errors.length, 1); assert.match(errors[0], /expected="1", actual="2"/); assert.match(errors[0], /#add/);
  for (const change of [
    { status: 'passed' }, { status: 'running' }, { status: 'cancelled' }, { error: 'Browser executable missing' },
    { previewHash: 'changed' }, { planHash: 'changed' }, { finishedAt: undefined }, { screenshots: ['initial.png'] }, { checks: [] },
  ]) assert.deepEqual(browserRepairErrors({ ...run, ...change } as BrowserRun, saved, html), [], JSON.stringify(change));
  for (const change of [{ status: 'failed' }, { projectId: randomUUID() }, { previewFile: 'v2/dist/index.html' }, { id: randomUUID() }]) {
    assert.deepEqual(browserRepairErrors(run, { ...saved, ...change } as TestPlanRecord, html), []);
  }
  assert.deepEqual(browserRepairErrors(run, saved, html + 'changed'), []);
  assert.deepEqual(browserRepairErrors(run, undefined, html), []);
  const runtime = { ...run, checks: run.checks.map((check) => ({ ...check, status: 'passed' as const })), errors: ['Uncaught fixture error'] };
  assert.match(browserRepairErrors(runtime, saved, html)[0], /Uncaught fixture error/);
});

test('browser evidence is separately persisted with hashes and rejects changed preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-record-'));
  try {
    const run = makeRun(); await saveBrowserRun(root, run);
    assert.deepEqual(await listBrowserRuns(root, run.projectId), [run]);
    const result = await executeBrowserRun({ root, run, html: html + 'changed', plan, signal: new AbortController().signal });
    assert.equal(result.status, 'failed'); assert.match(result.error!, /hash mismatch|Node 20/);
    assert.deepEqual(result.screenshots, []);
    assert.equal((await listBrowserRuns(root, run.projectId))[0].status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real browser uses click, fill and key actions, captures screenshots and detects runtime errors', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-integration-'));
  const execute = (run: BrowserRun, content: string, checks: unknown = plan, signal = new AbortController().signal, timeoutMs?: number) => executeBrowserRun({ root, run, html: content, plan: checks, signal, timeoutMs, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
  try {
    const run = await execute(makeRun(), html);
    assert.equal(run.status, 'passed', JSON.stringify(run));
    assert.deepEqual(run.checks.map((check) => check.actual), ['1', 'Pixel']);
    assert.ok(run.browserVersion); assert.deepEqual(run.screenshots, ['initial.png', 'final.png']);
    const png = await readFile(join(root, run.projectId, 'browser-runs', run.id, 'final.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual(await listBrowserRuns(root, run.projectId), [run]);
    const broken = html.replace('</script>', ';throw new Error("fixture runtime error")</script>');
    const failed = await execute(makeRun(broken), broken);
    assert.equal(failed.status, 'failed'); assert.ok(failed.errors.some((error) => error.includes('fixture runtime error')));
    const mismatch = { checks: [{ name: 'Mismatch', actions: [], selector: 'output', expected: '99' }], limitations: [] };
    const negative = await execute(makeRun(html, mismatch), html, mismatch);
    assert.equal(negative.status, 'failed'); assert.equal(negative.checks[0].actual, '0');
    const network = '<html><body><button>Fetch</button><output>idle</output><script>document.querySelector("button").addEventListener("click",()=>fetch("https://example.invalid/secret").catch(()=>document.querySelector("output").textContent="blocked"))</script></body></html>';
    const networkPlan = { checks: [{ name: 'Network blocked', actions: [{ type: 'click', selector: 'button' }], selector: 'output', expected: 'blocked' }], limitations: [] };
    const blocked = await execute(makeRun(network, networkPlan), network, networkPlan);
    assert.equal(blocked.status, 'failed', JSON.stringify(blocked)); assert.equal(blocked.blockedRequests.length, 1, JSON.stringify(blocked));
    const timeout = await execute(makeRun(html, mismatch), html, mismatch, undefined, 1000);
    assert.equal(timeout.status, 'failed'); assert.match(timeout.error!, /time limit/);
    const controller = new AbortController(); controller.abort();
    const cancelled = await execute(makeRun(), html, plan, controller.signal);
    assert.equal(cancelled.status, 'cancelled');
    const activeController = new AbortController();
    const cancelTimer = setTimeout(() => activeController.abort(new Error('User cancelled browser fixture')), 800);
    try {
      const activeCancelled = await execute(makeRun(html, mismatch), html, mismatch, activeController.signal);
      assert.equal(activeCancelled.status, 'cancelled'); assert.match(activeCancelled.error!, /cancelled browser fixture/);
    } finally { clearTimeout(cancelTimer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fresh isolation reloads the app before every check; shared plans keep their state', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-isolation-'));
  try {
    const content = '<html><body><button id="mode">Focus</button><script>document.querySelector("#mode").addEventListener("click",e=>e.target.textContent=e.target.textContent==="Focus"?"Break":"Focus")</script></body></html>';
    const toggle = { name: 'Toggle to break', actions: [{ type: 'click', selector: '#mode' }], selector: '#mode', expected: 'Break' };
    const checks = (isolation?: 'fresh') => ({ checks: [toggle, { ...toggle, name: 'Toggle again from a fresh page' }], limitations: [], ...(isolation ? { isolation } : {}) });
    const fresh = await executeBrowserRun({ root, run: makeRun(content, checks('fresh')), html: content, plan: checks('fresh'), signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.deepEqual(fresh.checks.map((check) => check.status), ['passed', 'passed'], JSON.stringify(fresh));
    const shared = await executeBrowserRun({ root, run: makeRun(content, checks()), html: content, plan: checks(), signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.deepEqual(shared.checks.map((check) => check.actual), ['Break', 'Focus']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('visible assertions and rendered text match what a person sees', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-visible-'));
  try {
    const content = '<html><body><div id="intro"><p>Use the arrow keys.</p><p>Eat the dot.</p></div><div id="win" style="display:none">You won!</div><button id="toggle" style="text-transform:uppercase">Pause</button><button id="show">Show</button><script>document.querySelector("#show").addEventListener("click",()=>document.querySelector("#win").style.display="block")</script></body></html>';
    const checks = { checks: [
      { name: 'Paragraphs read as separate sentences', actions: [], selector: '#intro', expected: 'Use the arrow keys. Eat the dot.' },
      { name: 'Win message hidden', actions: [], selector: '#win', assertion: 'visible', expected: 'false' },
      { name: 'Win message shown after click', actions: [{ type: 'click', selector: '#show' }], selector: '#win', assertion: 'visible', expected: 'true' },
      { name: 'CSS casing does not change the label', actions: [], selector: '#toggle', expected: 'Pause' },
    ], limitations: [], isolation: 'fresh' };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.deepEqual(run.checks.map((check) => check.status), ['passed', 'passed', 'passed', 'passed'], JSON.stringify(run.checks));
    assert.equal(run.checks[3].actual, 'PAUSE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real browser counts matches and reads exact attributes and live values', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-count-attribute-'));
  try {
    const content = `<html><body>${'<div class="card"></div>'.repeat(15)}<div id="hungerBar" aria-valuenow="100" title="  hungry  now "></div><input id="input" value="initial"><button id="play">Play</button><script>document.querySelector('#play').addEventListener('click',()=>setTimeout(()=>{document.querySelector('#hungerBar').setAttribute('aria-valuenow','90');const card=document.createElement('div');card.className='card';document.body.append(card)},100))</script></body></html>`;
    const checks = { checks: [
      { name: 'Missing card', actions: [], selector: '.card', assertion: 'count', expected: '16' },
      { name: 'Added later', actions: [{ type: 'click', selector: '#play' }], selector: '.card', assertion: 'count', expected: '16' },
      { name: 'Empty', actions: [], selector: '.absent', assertion: 'count', expected: '0' },
      { name: 'Hunger', actions: [], selector: '#hungerBar', assertion: 'attribute', attribute: 'aria-valuenow', expected: '90' },
      { name: 'Exact whitespace', actions: [], selector: '#hungerBar', assertion: 'attribute', attribute: 'title', expected: '  hungry  now ' },
      { name: 'Live value', actions: [{ type: 'input', selector: '#input', value: 'updated' }], selector: '#input', assertion: 'attribute', attribute: 'value', expected: 'updated' },
      { name: 'Missing attribute', actions: [], selector: '#hungerBar', assertion: 'attribute', attribute: 'data-state', expected: 'ready' },
      { name: 'Ambiguous attribute', actions: [], selector: '.card', assertion: 'attribute', attribute: 'class', expected: 'card' },
      { name: 'Ambiguous action', actions: [{ type: 'click', selector: '.card' }], selector: '.card', assertion: 'count', expected: '16' },
    ], limitations: [] };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.checks.map((check) => check.status), ['failed', 'passed', 'passed', 'passed', 'passed', 'passed', 'failed', 'failed', 'failed'], JSON.stringify(run));
    assert.deepEqual(run.checks.slice(0, 7).map((check) => check.actual), ['15', '16', '0', '90', '  hungry  now ', 'updated', '']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real browser visibility includes ancestor opacity and checked reads live state', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-opacity-checked-'));
  try {
    const content = '<html><body><div id="transparent" style="opacity:0">Hidden</div><div style="opacity:0"><div id="child">Hidden child</div></div><div id="partial" style="opacity:0.5">Shown</div><input id="check" type="checkbox"></body></html>';
    const checks = { checks: [
      { name: 'Transparent', actions: [], selector: '#transparent', assertion: 'visible', expected: 'false' },
      { name: 'Ancestor', actions: [], selector: '#child', assertion: 'visible', expected: 'false' },
      { name: 'Partial', actions: [], selector: '#partial', assertion: 'visible', expected: 'true' },
      { name: 'Unchecked', actions: [], selector: '#check', assertion: 'attribute', attribute: 'checked', expected: 'false' },
      { name: 'Checked', actions: [{ type: 'click', selector: '#check' }], selector: '#check', assertion: 'attribute', attribute: 'checked', expected: 'true' },
    ], limitations: [], isolation: 'fresh' };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.status, 'passed', JSON.stringify(run));
    assert.deepEqual(run.checks.map((check) => check.actual), ['false', 'false', 'true', 'false', 'true']);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('real browser compares text before actions and detects delayed changes', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-relative-'));
  try {
    const content = '<html><body><output>A</output><div id="other">0</div><button id="replace">Replace</button><button id="keep">Keep</button><button id="delay">Delay</button><script>document.querySelector("#replace").onclick=()=>document.querySelector("output").outerHTML="<output>B</output>";document.querySelector("#keep").onclick=()=>document.querySelector("#other").textContent="1";document.querySelector("#delay").onclick=()=>setTimeout(()=>document.querySelector("output").textContent="B",200)</script></body></html>';
    const checks = { checks: [
      { name: 'Replaced', actions: [{ type: 'click', selector: '#replace' }], selector: 'output', assertion: 'changed', expected: '' },
      { name: 'Same', actions: [{ type: 'click', selector: '#keep' }], selector: 'output', assertion: 'changed', expected: '' },
      { name: 'Kept', actions: [{ type: 'click', selector: '#keep' }], selector: 'output', assertion: 'unchanged', expected: '' },
      { name: 'Delayed', actions: [{ type: 'click', selector: '#delay' }], selector: 'output', assertion: 'unchanged', expected: '' },
      { name: 'Missing baseline', actions: [{ type: 'click', selector: '#replace' }], selector: '#missing', assertion: 'changed', expected: '' },
    ], limitations: [], isolation: 'fresh' };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.checks.map((check) => check.status), ['passed', 'failed', 'passed', 'failed', 'failed'], JSON.stringify(run));
    assert.deepEqual(run.checks.map((check) => check.actual), ['B', 'A', 'A', 'B', '']);
    assert.equal(run.checks[1].error, 'Expected text to change from "A"');
    assert.equal(run.checks[3].error, 'Expected text to stay "A", observed "B"');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real browser matches formats and selects nth for actions and assertions', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-matches-nth-'));
  try {
    const content = '<html><body><button>First</button><button>Second</button><output>#A2751</output><output>#A2751C</output><script>document.querySelectorAll("button")[1].onclick=()=>document.querySelectorAll("output")[1].textContent="#B2751C"</script></body></html>';
    const checks = { checks: [
      { name: 'Hex', actions: [], selector: 'output', nth: 1, assertion: 'matches', expected: '^#[0-9A-F]{6}$' },
      { name: 'Short', actions: [], selector: 'output', nth: 0, assertion: 'matches', expected: '^#[0-9A-F]{6}$' },
      { name: 'Second click', actions: [{ type: 'click', selector: 'button', nth: 1 }], selector: 'output', nth: 1, assertion: 'changed', expected: '' },
      { name: 'Second text', actions: [], selector: 'output', nth: 1, expected: '#B2751C' },
      { name: 'Missing check', actions: [], selector: 'output', nth: 2, expected: '' },
      { name: 'Missing action', actions: [{ type: 'click', selector: 'button', nth: 2 }], selector: 'output', nth: 1, expected: '' },
    ], limitations: [] };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.checks.map((check) => check.status), ['passed', 'failed', 'passed', 'passed', 'failed', 'failed'], JSON.stringify(run));
    assert.equal(run.checks[4].error, 'Selector matched 2 elements, no index 2: output');
    assert.equal(run.checks[5].error, 'Selector matched 2 elements, no index 2: button');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('real browser input actions select radios and set checkboxes', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-checked-'));
  try {
    const content = '<html><body><input type="radio" name="dice" id="one" value="1" checked><input type="radio" name="dice" id="two" value="2"><input type="checkbox" id="box"></body></html>';
    const actions = [{ type: 'input', selector: '#two', value: '2' }];
    const checks = { checks: [
      { name: 'Radio selected', actions, selector: '#two', assertion: 'attribute', attribute: 'checked', expected: 'true' },
      { name: 'Other radio cleared', actions: [], selector: '#one', assertion: 'attribute', attribute: 'checked', expected: 'false' },
      { name: 'Checkbox selected', actions: [{ type: 'input', selector: '#box', value: 'true' }], selector: '#box', assertion: 'attribute', attribute: 'checked', expected: 'true' },
      { name: 'Checkbox cleared', actions: [{ type: 'input', selector: '#box', value: 'false' }], selector: '#box', assertion: 'attribute', attribute: 'checked', expected: 'false' },
      { name: 'Radio value preserved', actions: [], selector: '#two', assertion: 'attribute', attribute: 'value', expected: '2' },
    ], limitations: [] };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.status, 'passed', JSON.stringify(run));
    assert.equal(run.checks.length, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('real browser reads inline styles, untransformed text and stability after actions', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-stable-style-'));
  try {
    const content = '<html><body><div id="bar" style="width:90%"></div><div id="summary" style="text-transform:uppercase"><div>Min 10</div><div style="text-transform:uppercase">Max 30</div></div><output>25:00</output><button>Pause</button><script>document.querySelector("button").onclick=()=>{document.querySelector("output").textContent="00:30";setTimeout(()=>document.querySelector("output").textContent="00:29",300)}</script></body></html>';
    const checks = { checks: [
      { name: 'Width', actions: [], selector: '#bar', assertion: 'attribute', attribute: 'style.width', expected: '90%' },
      { name: 'Missing', actions: [], selector: '#bar', assertion: 'attribute', attribute: 'style.left', expected: '' },
      { name: 'Case', actions: [], selector: '#summary', expected: 'Min 10 Max 30' },
      { name: 'Pattern', actions: [], selector: '#summary', assertion: 'matches', expected: '^Min 10 Max 30$' },
      { name: 'Static', actions: [], selector: 'output', assertion: 'stable', expected: '' },
      { name: 'Changes', actions: [{ type: 'click', selector: 'button' }], selector: 'output', assertion: 'stable', expected: '' },
    ], limitations: [] };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.checks.map((check) => check.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'failed'], JSON.stringify(run));
    assert.deepEqual(run.checks.map((check) => check.actual), ['90%', '', 'MIN 10 MAX 30', 'MIN 10 MAX 30', '25:00', '00:29']);
    assert.equal(run.checks[5].error, 'Expected text to stay "00:30" after the actions, observed "00:29"');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real browser captures created timers and matches attributes', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-created-pattern-'));
  try {
    const content = '<html><body><button>Add</button><input value="initial" type="checkbox" aria-label="Card 2, revealed" title="  spaced  " style="width:90%">text<script>document.querySelector("button").onclick=()=>{const timer=document.createElement("output");timer.textContent="0";document.body.append(timer);setInterval(()=>timer.textContent=String(Number(timer.textContent)+1),200)}</script></body></html>';
    const actions = [{ type: 'click', selector: 'button' }];
    const checks = { checks: [
      { name: 'Needs baseline', actions, selector: 'output', assertion: 'unchanged', expected: '' },
      { name: 'Created timer', actions, selector: 'output', assertion: 'changed', expected: '' },
      ...[['aria-label', '^Card \\d+, revealed$'], ['value', '^initial$'], ['checked', '^false$'], ['style.width', '^90%$'], ['title', '^  spaced  $'], ['missing', '^$'], ['missing', '^text$']].map(([attribute, expected], index) => ({ name: `Attribute ${index}`, actions: [], selector: 'input', assertion: 'matches', attribute, expected })),
    ], limitations: [], isolation: 'fresh' };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.checks.map(({ status }) => status), ['failed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'failed'], JSON.stringify(run));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real browser waits before observing delayed text', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-wait-'));
  try {
    const content = '<html><body><output id="status">Loading</output><script>setTimeout(()=>document.querySelector("#status").textContent="Ready",1000)</script></body></html>';
    const checks = { checks: [{ name: 'Delayed', actions: [{ type: 'wait', ms: 1200 }], selector: '#status', expected: 'Ready' }], limitations: [] };
    const started = Date.now();
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.status, 'passed', JSON.stringify(run));
    assert.deepEqual(run.checks, [{ name: 'Delayed', status: 'passed', actual: 'Ready' }]);
    assert.ok(Date.now() - started >= 1200);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('real browser checks class membership and attribute changes', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-class-changes-'));
  try {
    const content = '<html><body><div id="bar" class="lamp red on" style="height:10px"></div><button>Shuffle</button><script>document.querySelector("button").onclick=()=>{const bar=document.querySelector("#bar");bar.style.height="20px";const created=document.createElement("div");created.id="created";created.style.height="10px";document.body.append(created);setTimeout(()=>{bar.classList.remove("on");created.style.height="20px"},300)}</script></body></html>';
    const actions = [{ type: 'click', selector: 'button' }];
    const checks = { checks: [
      ...['on', 'on red', 'off', ''].map((expected, index) => ({ name: `Classes ${index}`, actions: [], selector: '#bar', assertion: 'attribute', attribute: 'class', expected })),
      { name: 'Pattern', actions: [], selector: '#bar', assertion: 'matches', attribute: 'class', expected: '^lamp red on$' },
      { name: 'Height', actions, selector: '#bar', assertion: 'changed', attribute: 'style.height', expected: '' },
      { name: 'Class stable', actions, selector: '#bar', assertion: 'stable', attribute: 'class', expected: '' },
      { name: 'Class unchanged', actions, selector: '#bar', assertion: 'unchanged', attribute: 'class', expected: '' },
      { name: 'Created', actions, selector: '#created', assertion: 'changed', attribute: 'style.height', expected: '' },
    ], limitations: [], isolation: 'fresh' };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.checks.map(({ status }) => status), ['passed', 'passed', 'failed', 'failed', 'passed', 'passed', 'failed', 'failed', 'passed'], JSON.stringify(run));
    assert.equal(run.checks[2].actual, 'lamp red on');
    assert.equal(run.checks[5].actual, '20px');
    assert.equal(run.checks[6].error, 'Expected attribute class to stay "lamp red on" after the actions, observed "lamp red"');
    assert.equal(run.checks[8].actual, '20px');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('real browser reads class-driven computed styles and leaves inline styles empty', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-computed-style-'));
  try {
    const content = '<html><head><style>#arrow.open { transform: rotate(180deg); }</style></head><body><div id="arrow">Arrow</div><button>Open</button><script>document.querySelector("button").onclick=()=>document.querySelector("#arrow").classList.toggle("open")</script></body></html>';
    const actions = [{ type: 'click', selector: 'button' }];
    const checks = { checks: [
      { name: 'Rotates', actions, selector: '#arrow', assertion: 'changed', attribute: 'css.transform', expected: '' },
      { name: 'Inline', actions, selector: '#arrow', assertion: 'attribute', attribute: 'style.transform', expected: '' },
      { name: 'Computed', actions, selector: '#arrow', assertion: 'attribute', attribute: 'css.transform', expected: 'matrix(-1, 0, 0, -1, 0, 0)' },
      { name: 'Pattern', actions, selector: '#arrow', assertion: 'matches', attribute: 'css.transform', expected: '^matrix\\(' },
      { name: 'Unchanged', actions: [{ type: 'wait', ms: 50 }], selector: '#arrow', assertion: 'unchanged', attribute: 'css.transform', expected: '' },
      { name: 'Stable', actions, selector: '#arrow', assertion: 'stable', attribute: 'css.transform', expected: '' },
    ], limitations: [], isolation: 'fresh' };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.status, 'passed', JSON.stringify(run));
    assert.deepEqual(run.checks.map(({ actual }) => actual), ['matrix(-1, 0, 0, -1, 0, 0)', '', 'matrix(-1, 0, 0, -1, 0, 0)', 'matrix(-1, 0, 0, -1, 0, 0)', 'none', 'matrix(-1, 0, 0, -1, 0, 0)']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real browser edits contenteditable text and fixes locale and timezone', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-editable-locale-'));
  try {
    const content = `<html><body><div id="note" contenteditable><b>Old note</b></div><output id="events"></output><output id="currency"></output><output id="timezone"></output><div id="plain"></div><button>Count</button><output id="count">0</output><script>
      const note = document.querySelector('#note');
      for (const type of ['input', 'change', 'blur']) note.addEventListener(type, () => { document.querySelector('#events').textContent += type + ' '; });
      document.querySelector('#currency').textContent = new Intl.NumberFormat(undefined, {style:'currency',currency:'USD'}).format(0);
      document.querySelector('#timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
      document.querySelector('button').onclick = () => document.querySelector('#count').textContent++;
    </script></body></html>`;
    const actions = [{ type: 'input', selector: '#note', value: '<b>New note</b>' }];
    const checks = { checks: [
      { name: 'Text', actions, selector: '#note', expected: '<b>New note</b>' },
      { name: 'Events', actions, selector: '#events', expected: 'input change blur' },
      { name: 'Markup removed', actions, selector: '#note b', assertion: 'count', expected: '0' },
      { name: 'Currency', actions: [], selector: '#currency', expected: '$0.00' },
      { name: 'Timezone', actions: [], selector: '#timezone', expected: 'UTC' },
      { name: 'Sixteen clicks', actions: Array.from({ length: 16 }, () => ({ type: 'click', selector: 'button' })), selector: '#count', expected: '16' },
      { name: 'Plain div rejected', actions: [{ type: 'input', selector: '#plain', value: 'No' }], selector: '#plain', expected: 'No' },
    ], limitations: [], isolation: 'fresh' };
    const run = await executeBrowserRun({ root, run: makeRun(content, checks), html: content, plan: checks, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.checks.map(({ status }) => status), ['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'failed'], JSON.stringify(run));
    assert.equal(run.checks[6].error, 'Input action requires an input, textarea, select or contenteditable element');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('real browser advances a thirty second round and preserves plain waits', { skip: process.env.RUN_STUDIO_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-advance-'));
  try {
    const content = '<html><body><output id="status">Playing</output><script>let remaining=30;const timer=setInterval(()=>{if(--remaining===0){document.querySelector("#status").textContent="Game over";clearInterval(timer)}},1000)</script></body></html>';
    for (const advance of [true, false]) {
      const check = { name: 'Round', actions: [{ type: advance ? 'advance' : 'wait', ms: advance ? 31000 : 100 }], selector: '#status', expected: advance ? 'Game over' : 'Playing' };
      const plan = { checks: advance ? [check, { ...check, name: 'Fresh round' }] : [check], isolation: 'fresh', limitations: [] };
      const run = await executeBrowserRun({ root, run: makeRun(content, plan), html: content, plan, signal: new AbortController().signal, executablePath: process.env.STUDIO_BROWSER_EXECUTABLE });
      assert.equal(run.status, 'passed', JSON.stringify(run));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
