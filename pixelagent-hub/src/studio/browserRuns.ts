import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { testPlanSchema, type TestPlanRecord } from './testPlans.js';
import { writeJsonSnapshot } from './atomicJson.js';
import { appendStudioEvent } from './events.js';
import { browserFailureNotes } from './shared/repair.js';

export type BrowserRun = {
  id: string; projectId: string; testPlanId: string; previewFile: string; previewHash: string; planHash: string;
  jobId: string; source: 'server-browser'; status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  startedAt: string; finishedAt?: string; browserVersion?: string; error?: string;
  viewport: { width: number; height: number };
  checks: { name: string; status: 'passed' | 'failed'; actual: string; error?: string }[];
  errors: string[]; blockedRequests: string[]; screenshots: ('initial.png' | 'final.png')[];
};
/** Text assertions compare text as people read it: trimmed, with runs of whitespace as one space. */
export const collapseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();
export const contentHash = (content: string) => createHash('sha256').update(content).digest('hex');
/** A completed failure in this exact preview/plan can inform code repair; launch failures cannot. */
export function browserRepairErrors(run: BrowserRun, plan: TestPlanRecord | undefined, html: string): string[] {
  const parsed = testPlanSchema.safeParse(plan?.result?.output && { checks: plan.result.output.checks, limitations: plan.result.output.limitations });
  if (run.source !== 'server-browser' || run.status !== 'failed' || run.error || !run.finishedAt || !run.browserVersion
    || !run.screenshots.includes('final.png') || !plan || plan.status !== 'ready' || !parsed.success
    || plan.id !== run.testPlanId || plan.projectId !== run.projectId || plan.previewFile !== run.previewFile
    || run.previewHash !== contentHash(html) || run.planHash !== contentHash(JSON.stringify(parsed.data))
    || run.checks.length !== parsed.data.checks.length || run.checks.some((check, index) => check.name !== parsed.data.checks[index].name)) return [];
  return browserFailureNotes(parsed.data.checks, run.checks, run.errors, run.blockedRequests);
}
export const saveBrowserRun = (root: string, run: BrowserRun) => writeJsonSnapshot(join(root, run.projectId, 'browser-runs', `${run.id}.json`), run);
export async function listBrowserRuns(root: string, projectId: string): Promise<BrowserRun[]> {
  const directory = join(root, projectId, 'browser-runs');
  let entries: string[];
  try { entries = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return (await Promise.all(entries.filter((entry) => /^[a-f0-9-]{36}\.json$/.test(entry)).map(async (entry) => JSON.parse(await readFile(join(directory, entry), 'utf8')) as BrowserRun))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Executes only bounded declarative checks; no model-provided scripts, URLs or paths. */
export async function executeBrowserRun(options: { root: string; run: BrowserRun; html: string; plan: unknown; signal: AbortSignal; executablePath?: string; timeoutMs?: number }): Promise<BrowserRun> {
  const { root, run, signal } = options;
  const plan = testPlanSchema.parse(options.plan);
  const waitMs = plan.checks.reduce((total, check) => total + check.actions.reduce((sum, action) => sum + (action.type === 'wait' ? action.ms : 0), 0), 0);
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const controller = new AbortController();
  const close = () => { if (browser) closing ??= browser.close().catch(() => {}); };
  const abort = () => { controller.abort(signal.reason); close(); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { controller.abort(new Error('Browser check exceeded its time limit')); close(); }, options.timeoutMs ?? (45_000 + waitMs));
  const boundedPush = (array: string[], value: string) => { if (array.length < 20) array.push(value.slice(0, 2000)); };
  run.status = 'running';
  try {
    await saveBrowserRun(root, run);
    signal.throwIfAborted();
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Independent browser checks require Node 20 or later');
    if (contentHash(options.html) !== run.previewHash || contentHash(JSON.stringify(plan)) !== run.planHash) throw new Error('Browser run content hash mismatch');
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: options.executablePath, timeout: 10_000 });
    if (controller.signal.aborted) { close(); controller.signal.throwIfAborted(); }
    run.browserVersion = browser.version();
    // Keep currency, date and time formatting independent of the host machine.
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: run.viewport, serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', async (route) => { boundedPush(run.blockedRequests, route.request().url()); await route.abort(); });
    await context.routeWebSocket('**/*', (socket) => { boundedPush(run.blockedRequests, socket.url()); socket.close(); });
    const page = await context.newPage();
    context.on('page', (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on('pageerror', (error) => boundedPush(run.errors, error.message));
    page.on('console', (message) => { if (message.type() === 'error') boundedPush(run.errors, message.text()); });
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    page.setDefaultTimeout(2000);
    // Opaque sandbox prevents generated code accessing the trusted parent document.
    const useClock = plan.checks.some((check) => check.actions.some((action) => action.type === 'advance'));
    const loadApp = async () => {
      if (useClock) await page.clock.install();
      await page.setContent('<style>html,body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe id="app" sandbox="allow-scripts allow-forms"></iframe>');
      await page.locator('#app').evaluate((element, html) => new Promise<void>((resolve) => {
        element.addEventListener('load', () => resolve(), { once: true });
        (element as HTMLIFrameElement).srcdoc = html;
      }), options.html);
      await frame.locator('css=body').waitFor();
    };
    const frame = page.frameLocator('#app');
    await loadApp();
    const directory = join(root, run.projectId, 'browser-runs', run.id);
    await mkdir(directory, { recursive: true });
    const screenshot = async (name: 'initial.png' | 'final.png') => {
      await page.screenshot({ path: join(directory, name), timeout: 3000, animations: 'disabled' });
      run.screenshots.push(name);
    };
    await screenshot('initial.png');
    for (const [index, check] of plan.checks.entries()) {
      controller.signal.throwIfAborted();
      // Fresh isolation: every check starts from a newly loaded app, independent of earlier checks.
      if (plan.isolation === 'fresh' && index > 0) await loadApp();
      let actual = '';
      try {
        const assertion = check.assertion || 'text';
        const relative = assertion === 'changed' || assertion === 'unchanged';
        const steady = assertion === 'unchanged' || assertion === 'stable';
        const element = async (selector: string, nth?: number) => {
          const locator = frame.locator(`css=${selector}`);
          const count = await locator.count();
          if (nth !== undefined && count <= nth) throw new Error(`Selector matched ${count} elements, no index ${nth}: ${selector}`);
          if (nth === undefined && count !== 1) throw new Error(`Selector must match exactly one element: ${selector}`);
          return nth === undefined ? locator : locator.nth(nth);
        };
        let target = frame.locator(`css=${check.selector}`);
        const deferredBaseline = assertion === 'changed' && await target.count() === 0;
        if (relative && !deferredBaseline) target = await element(check.selector, check.nth);
        const readValue = () => check.attribute ? target.evaluate((element, attribute) => attribute.startsWith('css.') ? getComputedStyle(element).getPropertyValue(attribute.slice(4)).trim() : attribute.startsWith('style.') ? (element as HTMLElement).style.getPropertyValue(attribute.slice(6)).trim() : attribute === 'value' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? (element as HTMLInputElement).value : attribute === 'checked' && element.tagName === 'INPUT' ? String((element as HTMLInputElement).checked) : element.getAttribute(attribute) ?? '', check.attribute) : target.innerText().then(collapseWhitespace);
        // A pattern also matches its own text literally: "rgb(255, 255, 255)" written unescaped means that string.
        const pattern = assertion === 'matches' ? new RegExp(`(?:${check.expected})|^${check.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u') : undefined;
        let expected = relative && !deferredBaseline ? await readValue() : assertion === 'text' ? collapseWhitespace(check.expected) : check.expected;
        for (const action of check.actions) {
          controller.signal.throwIfAborted();
          if (action.type === 'wait') { await page.waitForTimeout(action.ms); continue; }
          if (action.type === 'advance') { await page.clock.runFor(action.ms); continue; }
          const target = await element(action.selector, action.nth);
          if (action.type === 'click') await target.click();
          else if (action.type === 'input') {
            const kind = await target.evaluate((element) => (element as HTMLElement).isContentEditable ? 'contenteditable' : element.tagName === 'INPUT' ? (element as HTMLInputElement).type : element.tagName);
            if (kind === 'checkbox' || kind === 'radio') {
              if (action.value === 'false') await target.uncheck();
              else await target.check();
            } else if (kind === 'SELECT') await target.selectOption(action.value);
            else {
              if (kind !== 'contenteditable' && !await target.evaluate((element) => ['INPUT', 'TEXTAREA'].includes(element.tagName))) throw new Error('Input action requires an input, textarea, select or contenteditable element');
              // Contenteditable text is replaced exactly as the in-page runner does it (fill() keeps old
              // markup around the typed text); inline because evaluate() code runs in the page.
              if (kind === 'contenteditable') await target.evaluate((element, value) => {
                element.replaceChildren(document.createTextNode(value));
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                element.dispatchEvent(new Event('blur'));
              }, action.value);
              else await target.fill(action.value);
            }
          }
          else await target.press(action.key);
        }
        if (assertion !== 'count' && assertion !== 'stable') target = await element(check.selector, check.nth);
        if (deferredBaseline) expected = await readValue();
        if (assertion === 'stable') {
          await new Promise((resolve) => setTimeout(resolve, 100));
          target = await element(check.selector, check.nth);
          expected = await readValue();
        }
        const deadline = Date.now() + (assertion === 'stable' ? 1500 : assertion === 'unchanged' ? 500 : 2000);
        // Text accepts rendered, source or untransformed rendered text; rendered text is reported.
        // Visibility uses Playwright plus no opacity:0 on the element or ancestors.
        let matched = false;
        do {
          controller.signal.throwIfAborted();
          if (relative || assertion === 'stable') target = await element(check.selector, check.nth);
          if (!check.attribute && (assertion === 'text' || pattern || relative || assertion === 'stable')) {
            // Inline on purpose: a named helper inside evaluate() gets a `__name` wrapper from
            // tsx/esbuild that does not exist in the page.
            const [rendered, source, plain] = await target.evaluate((element) => {
              const root = element as HTMLElement;
              const rendered = root.innerText ?? '';
              const elements = [root, ...Array.from(root.querySelectorAll('*')) as HTMLElement[]].filter((item) => item.style);
              const previous = elements.map((item) => [item.style.getPropertyValue('text-transform'), item.style.getPropertyPriority('text-transform')]);
              let plain = rendered;
              try {
                for (const item of elements) item.style.textTransform = 'none';
                plain = root.innerText ?? '';
              } finally {
                elements.forEach((item, index) => {
                  const [value, priority] = previous[index];
                  if (value) item.style.setProperty('text-transform', value, priority);
                  else item.style.removeProperty('text-transform');
                });
              }
              return [rendered, root.textContent ?? '', plain];
            });
            actual = collapseWhitespace(rendered);
            matched = pattern ? pattern.test(actual) || pattern.test(collapseWhitespace(source)) || pattern.test(collapseWhitespace(plain)) : actual === expected || collapseWhitespace(source) === expected || collapseWhitespace(plain) === expected;
            if (assertion === 'changed') matched = !matched;
          } else {
            actual = assertion === 'count' ? String(await target.count())
              : check.attribute ? await readValue()
                : assertion === 'disabled' ? String(await target.evaluate((element) => element.matches(':disabled'))) : String(await target.isVisible() && await target.evaluate((element) => {
                  for (let current: Element | null = element; current; current = current.parentElement) {
                    if (parseFloat(getComputedStyle(current).opacity) === 0) return false;
                  }
                  return true;
                }));
            matched = assertion === 'attribute' && check.attribute === 'class' ? await target.evaluate((element, expected) => expected.trim() ? expected.trim().split(/\s+/).every((token) => element.classList.contains(token)) : element.classList.length === 0, expected) : pattern ? pattern.test(actual) : actual === expected;
            // A style value and the expected value that name the same color match (#00FF00 = rgb(0, 255, 0)).
            // Inline on purpose, as above: canvas normalises both without touching the app's DOM.
            if (!matched && assertion === 'attribute' && /^(style|css)\./.test(check.attribute ?? '')) matched = await target.evaluate((_, values) => {
              const context = document.createElement('canvas').getContext('2d');
              if (!context || !values.every((value) => CSS.supports('color', value))) return false;
              const [a, b] = values.map((value) => { context.fillStyle = '#000'; context.fillStyle = value; return context.fillStyle; });
              return a === b;
            }, [actual, expected]);
            if (assertion === 'changed') matched = !matched;
          }
          if (steady ? !matched : matched) break;
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, assertion === 'stable' ? 100 : 50));
        } while (steady ? matched : !matched);
        if (!matched && assertion === 'stable') throw new Error(`Expected ${check.attribute ? `attribute ${check.attribute}` : 'text'} to stay ${JSON.stringify(expected)} after the actions, observed ${JSON.stringify(actual.slice(0, 300))}`);
        if (!matched && relative) throw new Error(assertion === 'unchanged' ? `Expected ${check.attribute ? `attribute ${check.attribute}` : 'text'} to stay ${JSON.stringify(expected)}, observed ${JSON.stringify(actual.slice(0, 300))}` : `Expected ${check.attribute ? `attribute ${check.attribute}` : 'text'} to change from ${JSON.stringify(expected)}`);
        if (!matched) throw new Error(`Expected ${JSON.stringify(check.expected)}, observed ${JSON.stringify(actual.slice(0, 300))}`);
        run.checks.push({ name: check.name, status: 'passed', actual: actual.slice(0, 300) });
      } catch (error) {
        controller.signal.throwIfAborted();
        run.checks.push({ name: check.name, status: 'failed', actual: actual.slice(0, 300), error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
      }
      const result = run.checks.at(-1)!;
      await appendStudioEvent(root, run.projectId, { type: 'browser_check', data: { runId: run.id, name: result.name, passed: result.status === 'passed', actual: result.actual } });
    }
    await screenshot('final.png');
    controller.signal.throwIfAborted();
    run.status = run.errors.length || run.blockedRequests.length || run.checks.some((check) => check.status === 'failed') ? 'failed' : 'passed';
  } catch (error) {
    run.status = signal.aborted ? 'cancelled' : 'failed';
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    run.error = (reason instanceof Error ? reason.message : String(reason)).slice(0, 2000);
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    close(); await closing;
    run.finishedAt = new Date().toISOString();
    await saveBrowserRun(root, run);
    const passed = run.checks.filter((check) => check.status === 'passed').length;
    await appendStudioEvent(root, run.projectId, { type: 'browser_run_finished', data: { runId: run.id, status: run.status, passed, failed: run.checks.length - passed, error: run.error?.slice(0, 300) } });
  }
  return run;
}
