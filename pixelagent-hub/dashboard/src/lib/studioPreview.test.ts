import { describe, expect, it } from 'vitest';
import { prepareStudioPreview, readPreviewMessage } from './studioPreview';

describe('sandbox preview diagnostics', () => {
  it('installs listeners before generated scripts and escapes script-closing tokens', () => {
    const html = prepareStudioPreview('<html><head><script>throw Error("broken")</script></head></html>', '</script>');
    expect(html.indexOf("addEventListener('error'")).toBeLessThan(html.indexOf('throw Error'));
    expect(html).toContain('nonce:"\\u003c/script>"');
    expect(html).toContain("addEventListener('unhandledrejection'");
  });

  it('accepts only bounded messages from the current iframe and current preview', () => {
    const frame = {} as Window;
    const data = { channel: 'studio-preview', nonce: 'current', kind: 'error', message: 'Runtime failed' };
    const event = (source: Window, payload: unknown) => ({ source, data: payload }) as MessageEvent;
    expect(readPreviewMessage(event(frame, data), frame, 'current')).toEqual(data);
    expect(readPreviewMessage(event({} as Window, data), frame, 'current')).toBeNull();
    expect(readPreviewMessage(event(frame, data), frame, 'previous')).toBeNull();
    expect(readPreviewMessage(event(frame, { ...data, kind: 'approved' }), frame, 'current')).toBeNull();
    expect(readPreviewMessage(event(frame, { ...data, message: 'x'.repeat(2001) }), frame, 'current')).toBeNull();
    expect(readPreviewMessage(event(frame, null), frame, 'current')).toBeNull();
  });
});


it('advances intervals, nested timeouts, dates and animation frames in due order', async () => {
  const { runInNewContext } = await import('node:vm');
  const { studioClockScript } = await import('./studioClock');
  let real = 0;
  const pumps: (() => void)[] = [];
  const scope = { Date, performance: { now: () => real }, setTimeout: (fn: () => void) => { pumps.push(fn); }, MessageChannel: class {
    port1 = { onmessage: () => {} };
    port2 = { postMessage: () => queueMicrotask(() => this.port1.onmessage()) };
  } };
  const world = { ...scope, window: scope };
  runInNewContext(studioClockScript.replace(/^<script>|<\/script>$/g, ''), world);
  const clock = scope as unknown as Window & { __studioClock: { runFor(ms: number): Promise<void> }; Date: DateConstructor };
  const before = clock.Date.now();
  const perf = clock.performance.now();
  let ticks = 0;
  const interval = clock.setInterval(() => ticks++, 1000);
  const order: string[] = [];
  clock.setTimeout(() => { order.push('outer'); clock.setTimeout(() => order.push('inner'), 500); }, 100);
  clock.requestAnimationFrame((timestamp) => { order.push('frame'); expect(timestamp).toBe(16); });
  await clock.__studioClock.runFor(30000);
  expect(ticks).toBe(30);
  expect(clock.Date.now() - before).toBe(30000);
  expect(clock.performance.now() - perf).toBe(30000);
  expect(order).toEqual(['frame', 'outer', 'inner']);
  clock.clearInterval(interval);
  await clock.__studioClock.runFor(1000);
  expect(ticks).toBe(30);
  let nestedAt = 0;
  clock.setTimeout(() => clock.setTimeout(() => { nestedAt = clock.performance.now(); }, 0), 100);
  await clock.__studioClock.runFor(200);
  expect(nestedAt).toBe(31101);
  let zeroTicks = 0;
  const zeroInterval = clock.setInterval(() => { if (++zeroTicks === 3) clock.clearInterval(zeroInterval); }, 0);
  await clock.__studioClock.runFor(100);
  expect(zeroTicks).toBe(3);
  expect(new clock.Date(2020, 0, 1).getFullYear()).toBe(2020);
  expect(new clock.Date().getTime()).toBe(clock.Date.now());
  expect(clock.Date.parse('2020-01-01')).toBe(Date.parse('2020-01-01'));
  expect(clock.Date.UTC(2020, 0, 1)).toBe(Date.UTC(2020, 0, 1));
  expect(Object.keys(clock)).not.toContain('__studioClock');
  clock.setTimeout(() => order.push('natural'), 100);
  real += 100;
  pumps[0]();
  expect(order.at(-1)).toBe('natural');
  const html = '<html><head><script>app()</script></head></html>';
  expect(prepareStudioPreview(html, 'test')).not.toContain('const NativeDate');
  const injected = prepareStudioPreview(html, 'test', { clock: true });
  expect(injected.indexOf('const NativeDate')).toBeLessThan(injected.indexOf('app()'));
  expect(injected.indexOf('const NativeDate')).toBeGreaterThan(injected.indexOf("addEventListener('message'"));
});
