import { readCheckResults, type BrowserCheck, type BrowserCheckResult } from '../studioChecks';
import { prepareStudioPreview, readPreviewMessage } from '../studioPreview';

/**
 * PLAY LIVE checks: runs the Tester's declarative checks inside a hidden sandboxed iframe
 * (scripts only, no same-origin access) using the same bridge as the dashboard's Quick checks.
 * These are in-page checks, not the server's independent Chromium runs.
 */
type InPageRun = { results: BrowserCheckResult[]; errors: string[] };

/** Fresh isolation (the Tester's default) loads the app anew for every check, as the server does. */
export async function runInPageChecks(html: string, checks: BrowserCheck[], signal?: AbortSignal, isolation: 'shared' | 'fresh' = 'shared'): Promise<InPageRun> {
  if (isolation === 'shared') {
    const waitMs = checks.reduce((total, check) => total + check.actions.reduce((sum, action) => sum + (action.type === 'wait' ? action.ms : 0), 0), 0);
    return runInFrame(html, checks, signal, 30_000 + waitMs);
  }
  const run: InPageRun = { results: [], errors: [] };
  for (const check of checks) {
    const { results, errors } = await runInFrame(html, [check], signal, 20_000);
    run.results.push(...results);
    for (const error of errors) if (run.errors.length < 20 && !run.errors.includes(error)) run.errors.push(error);
  }
  return run;
}

async function runInFrame(html: string, checks: BrowserCheck[], signal?: AbortSignal, timeoutMs = 30_000): Promise<InPageRun> {
  const nonce = crypto.randomUUID();
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // In the viewport but transparent: an off-screen or hidden cross-origin frame is throttled,
  // which freezes CSS transitions and slows timers to about 1 Hz, so checks saw a different app.
  frame.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;border:0;opacity:0;pointer-events:none;z-index:-1';
  const errors: string[] = [];
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(() => resolve({ results: checks.map((check) => ({ name: check.name, status: 'failed', actual: '', error: `In-page checks did not finish within ${timeoutMs / 1000} seconds` })), errors })), timeoutMs);
      const abort = () => finish(() => reject(signal?.reason));
      const finish = (done: () => void) => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort); done(); };
      const receive = (event: MessageEvent) => {
        const message = readPreviewMessage(event, frame.contentWindow, nonce);
        if (!message) return;
        if (message.kind === 'error' && errors.length < 20) errors.push(message.message);
        // Let deferred scripts and first paint settle before acting on the page.
        if (message.kind === 'loaded') setTimeout(() => frame.contentWindow?.postMessage({ channel: 'studio-checks', nonce, checks }, '*'), 300);
        if (message.kind === 'checks') {
          const results = readCheckResults(message.message);
          if (results && results.length === checks.length && results.every((result, index) => result.name === checks[index].name)) finish(() => resolve({ results, errors }));
        }
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      window.addEventListener('message', receive);
      frame.srcdoc = prepareStudioPreview(html, nonce, { clock: checks.some((check) => check.actions.some((action) => action.type === 'advance')) });
      document.body.append(frame);
    });
  } finally {
    frame.remove();
  }
}
