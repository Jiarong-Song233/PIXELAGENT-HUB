import { expect, it, vi } from 'vitest';
import { readCheckResults, runDOMChecks } from './studioChecks';

it('reads disabled state independently of button text and detects an incorrect state', async () => {
  let disabled = false;
  const button = { textContent: '4', matches: (selector: string) => selector === ':disabled' && disabled, click: () => { disabled = true; } };
  const document = { querySelectorAll: () => [button] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Initially enabled', actions: [], selector: '#answer', assertion: 'disabled', expected: 'false' },
    { name: 'Locked after answering', actions: [{ type: 'click', selector: '#answer' }], selector: '#answer', assertion: 'disabled', expected: 'true' },
    { name: 'Incorrect enabled claim', actions: [], selector: '#answer', assertion: 'disabled', expected: 'false' },
    { name: 'Text still checked normally', actions: [], selector: '#answer', expected: '4' },
  ]);
  expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'failed', 'passed']);
  expect(results.map((result) => result.actual)).toEqual(['false', 'true', 'true', '4']);
});

it('executes sequential DOM actions, distinguishes assertion failures and rejects ambiguous selectors', async () => {
  const output = { textContent: '0' };
  const button = { click: () => { output.textContent = String(Number(output.textContent) + 1); } };
  const document = { querySelectorAll: (selector: string) => selector === '#value' ? [output] : selector === '#add' ? [button] : selector === '.ambiguous' ? [output, button] : [] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Initial', actions: [], selector: '#value', expected: '0' },
    { name: 'Increment', actions: [{ type: 'click', selector: '#add' }], selector: '#value', expected: '1' },
    { name: 'Wrong expected', actions: [], selector: '#value', expected: '2' },
    { name: 'Ambiguous', actions: [], selector: '.ambiguous', expected: '' },
  ]);
  expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'failed', 'failed']);
  expect(results[2].actual).toBe('1');
  expect(results[3].error).toContain('found 2');
});

it('cannot turn truncated observations or runtime faults into passing assertions', async () => {
  let errors = 0;
  const document = { querySelectorAll: (selector: string) => selector === '#value' ? [{ textContent: 'x'.repeat(301) }] : [{ click: () => { errors++; } }] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Long', actions: [], selector: '#value', expected: 'x'.repeat(300) },
    { name: 'Runtime fault', actions: [{ type: 'click', selector: '#fault' }], selector: '#value', expected: 'x'.repeat(301) },
  ], () => errors);
  expect(results.every((result) => result.status === 'failed')).toBe(true);
  expect(results[1].error).toContain('Runtime error');
  expect(readCheckResults(JSON.stringify(results))).toEqual(results);
  expect(readCheckResults('[{"name":"Fake","status":"approved","actual":""}]')).toBeNull();
  expect(readCheckResults('not json')).toBeNull();
});

it('waits up to 2 s for the expected value, like the server browser runs', async () => {
  const output = { textContent: 'Loading' };
  setTimeout(() => { output.textContent = 'Ready'; }, 300);
  const document = { querySelectorAll: () => [output] } as unknown as Document;
  const [result] = await runDOMChecks(document, [{ name: 'Eventually ready', actions: [], selector: '#status', expected: 'Ready' }]);
  expect(result).toMatchObject({ status: 'passed', actual: 'Ready' });
});

it('compares text with runs of whitespace as one space, like the server', async () => {
  const output = { textContent: '  C→F: x×9/5+32  |  F→C:\n (x−32)×5/9 ' };
  const document = { querySelectorAll: () => [output] } as unknown as Document;
  const [result] = await runDOMChecks(document, [{ name: 'Formula', actions: [], selector: '#formula', expected: 'C→F: x×9/5+32 | F→C: (x−32)×5/9' }]);
  expect(result).toMatchObject({ status: 'passed', actual: 'C→F: x×9/5+32 | F→C: (x−32)×5/9' });
});

it('in-page visible assertions follow the element box and visibility, and text prefers innerText', async () => {
  let shown = false;
  const win = { textContent: 'You won!', innerText: 'You won!', getBoundingClientRect: () => ({ width: shown ? 100 : 0, height: shown ? 20 : 0 }), matches: () => false };
  const button = { click: () => { shown = true; } };
  const intro = { textContent: 'Use the arrow keys.Eat the dot.', innerText: 'Use the arrow keys.\n\nEat the dot.' };
  const document = {
    defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
    querySelectorAll: (selector: string) => selector === '#win' ? [win] : selector === '#show' ? [button] : [intro],
  } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Hidden', actions: [], selector: '#win', assertion: 'visible', expected: 'false' },
    { name: 'Shown', actions: [{ type: 'click', selector: '#show' }], selector: '#win', assertion: 'visible', expected: 'true' },
    { name: 'Intro', actions: [], selector: '#intro', expected: 'Use the arrow keys. Eat the dot.' },
  ]);
  expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'passed']);
});

it('text matches the source text when CSS changes how it is rendered (text-transform)', async () => {
  const button = { textContent: 'Pause', innerText: 'PAUSE' };
  const document = { querySelectorAll: () => [button] } as unknown as Document;
  const [result] = await runDOMChecks(document, [{ name: 'Label', actions: [], selector: '#toggle', expected: 'Pause' }]);
  expect(result).toMatchObject({ status: 'passed', actual: 'PAUSE' });
  const [wrong] = await runDOMChecks(document, [{ name: 'Label', actions: [], selector: '#toggle', expected: 'Start' }]);
  expect(wrong.status).toBe('failed');
});

it('counts all matching cards, including zero, and polls for added cards', async () => {
  const cards = Array.from({ length: 16 }, () => ({ textContent: 'Card' }));
  const remove = { click: () => { cards.pop(); } };
  const document = { querySelectorAll: (selector: string) => selector === '.card' ? cards : selector === '#remove' ? [remove] : [] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Full board', actions: [], selector: '.card', assertion: 'count', expected: '16' },
    { name: 'Missing card', actions: [{ type: 'click', selector: '#remove' }], selector: '.card', assertion: 'count', expected: '16' },
    { name: 'Empty', actions: [], selector: '.absent', assertion: 'count', expected: '0' },
    { name: 'Ambiguous action', actions: [{ type: 'click', selector: '.card' }], selector: '.card', assertion: 'count', expected: '15' },
  ]);
  expect(results.map((result) => result.status)).toEqual(['passed', 'failed', 'passed', 'failed']);
  expect(results.slice(0, 3).map((result) => result.actual)).toEqual(['16', '15', '0']);
  expect(results[3].error).toContain('found 15');
  setTimeout(() => cards.push({ textContent: 'Card' }), 100);
  const [added] = await runDOMChecks(document, [{ name: 'Added later', actions: [], selector: '.card', assertion: 'count', expected: '16' }]);
  expect(added).toMatchObject({ status: 'passed', actual: '16' });
});

it('reads exact attributes after clicks, polls updates and reports missing attributes as empty', async () => {
  let hunger = '100';
  const bar = { getAttribute: (name: string) => name === 'aria-valuenow' ? hunger : name === 'title' ? '  hungry  now ' : null };
  const button = { click: () => { setTimeout(() => { hunger = '90'; }, 100); } };
  const document = { querySelectorAll: (selector: string) => selector === '#hungerBar' ? [bar] : [button] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Hunger changes', actions: [{ type: 'click', selector: '#play' }], selector: '#hungerBar', assertion: 'attribute', attribute: 'aria-valuenow', expected: '90' },
    { name: 'Exact whitespace', actions: [], selector: '#hungerBar', assertion: 'attribute', attribute: 'title', expected: '  hungry  now ' },
    { name: 'Missing', actions: [], selector: '#hungerBar', assertion: 'attribute', attribute: 'data-state', expected: 'ready' },
  ]);
  expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'failed']);
  expect(results.map((result) => result.actual)).toEqual(['90', '  hungry  now ', '']);
});

it('reads live input, textarea and select values after input actions', async () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const input = { tagName, value: 'initial', getAttribute: () => 'initial', dispatchEvent: () => true };
    const document = { querySelectorAll: () => [input] } as unknown as Document;
    const [result] = await runDOMChecks(document, [{ name: tagName, actions: [{ type: 'input', selector: '#input', value: '  updated ' }], selector: '#input', assertion: 'attribute', attribute: 'value', expected: '  updated ' }]);
    expect(result).toMatchObject({ status: 'passed', actual: '  updated ' });
  }
});

it.each(['element', 'ancestor', 'partial'])('visibility accounts for %s opacity', async (mode) => {
  const parent = { opacity: mode === 'ancestor' ? '0' : '1', parentElement: null };
  const target = { opacity: mode === 'element' ? '0' : '0.5', parentElement: parent, getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  const document = { querySelectorAll: () => [target], defaultView: { getComputedStyle: (element: { opacity: string }) => ({ visibility: 'visible', opacity: element.opacity }) } } as unknown as Document;
  const [result] = await runDOMChecks(document, [{ name: mode, actions: [], selector: '#overlay', assertion: 'visible', expected: String(mode === 'partial') }]);
  expect(result.status).toBe('passed');
});

it('reads live checked state before and after a checkbox click', async () => {
  const input = { tagName: 'INPUT', checked: false, getAttribute: () => null, click: () => { input.checked = !input.checked; } };
  const document = { querySelectorAll: () => [input] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Before', actions: [], selector: '#check', assertion: 'attribute', attribute: 'checked', expected: 'false' },
    { name: 'After', actions: [{ type: 'click', selector: '#check' }], selector: '#check', assertion: 'attribute', attribute: 'checked', expected: 'true' },
  ]);
  expect(results.map(({ status, actual }) => ({ status, actual }))).toEqual([{ status: 'passed', actual: 'false' }, { status: 'passed', actual: 'true' }]);
});


it('compares text with its baseline before actions and catches delayed changes', async () => {
  let output = { innerText: ' A ', textContent: 'A' };
  const other = { textContent: '0' };
  const buttons = {
    '#replace': { click: () => { output = { innerText: 'B', textContent: 'B' }; } },
    '#other': { click: () => { other.textContent = '1'; } },
    '#delay': { click: () => { setTimeout(() => { output.innerText = output.textContent = 'C'; }, 200); } },
  };
  const document = { querySelectorAll: (selector: string) => selector === '#value' ? [output] : buttons[selector as keyof typeof buttons] ? [buttons[selector as keyof typeof buttons]] : [] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Replaced', actions: [{ type: 'click', selector: '#replace' }], selector: '#value', assertion: 'changed', expected: '' },
    { name: 'Same', actions: [{ type: 'click', selector: '#other' }], selector: '#value', assertion: 'changed', expected: '' },
    { name: 'Kept', actions: [{ type: 'click', selector: '#other' }], selector: '#value', assertion: 'unchanged', expected: '' },
    { name: 'Delayed', actions: [{ type: 'click', selector: '#delay' }], selector: '#value', assertion: 'unchanged', expected: '' },
    { name: 'Missing baseline', actions: [{ type: 'click', selector: '#replace' }], selector: '#missing', assertion: 'changed', expected: '' },
  ]);
  expect(results.map(({ status }) => status)).toEqual(['passed', 'failed', 'passed', 'failed', 'failed']);
  expect(results.map(({ actual }) => actual)).toEqual(['B', 'B', 'B', 'C', '']);
  expect(results[1].error).toBe('Expected text to change from "B"');
  expect(results[3].error).toBe('Expected text to stay "B", observed "C"');
  expect(results[4].error).toContain('found 0');
  expect(output.textContent).toBe('B'); // Missing changed baselines now allow the actions to run.
});

it('relative assertions accept source text and reject missing or ambiguous later matches', async () => {
  for (const assertion of ['changed', 'unchanged'] as const) {
    let targets = [{ innerText: ' A  B ', textContent: 'A B' }];
    const button = { click: () => { targets = [{ innerText: 'A B', textContent: 'A B' }]; setTimeout(() => { targets = []; }, 100); } };
    const document = { querySelectorAll: (selector: string) => selector === '#value' ? targets : [button] } as unknown as Document;
    const [result] = await runDOMChecks(document, [{ name: assertion, actions: [{ type: 'click', selector: '#button' }], selector: '#value', assertion, expected: '' }]);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('found 0');
    targets = [{ innerText: 'A', textContent: 'A' }, { innerText: 'A', textContent: 'A' }];
    const [ambiguous] = await runDOMChecks(document, [{ name: assertion, actions: [{ type: 'click', selector: '#button' }], selector: '#value', assertion, expected: '' }]);
    expect(ambiguous.error).toContain('found 2');
  }
  const output = { innerText: 'A B', textContent: 'A B' };
  const button = { click: () => { output.innerText = 'A\n\nB'; } };
  const document = { querySelectorAll: (selector: string) => selector === '#value' ? [output] : [button] } as unknown as Document;
  const [result] = await runDOMChecks(document, [{ name: 'Whitespace', actions: [{ type: 'click', selector: '#button' }], selector: '#value', assertion: 'unchanged', expected: '' }]);
  expect(result.status).toBe('passed');
  button.click = () => { output.innerText = 'A B!'; };
  const [source] = await runDOMChecks(document, [{ name: 'Source fallback', actions: [{ type: 'click', selector: '#button' }], selector: '#value', assertion: 'unchanged', expected: '' }]);
  expect(source).toMatchObject({ status: 'passed', actual: 'A B!' });
});

it('matches hex formats against rendered or source text and rejects short values', async () => {
  const document = { querySelectorAll: (selector: string) => [{ innerText: selector === '#source' ? '#a2751c' : selector === '#short' ? '#A2751' : '  #A2751C  ', textContent: selector === '#short' ? '#A2751' : '#A2751C' }] } as unknown as Document;
  const results = await runDOMChecks(document, ['#valid', '#source', '#short'].map((selector) => ({ name: selector, actions: [], selector, assertion: 'matches', expected: '^#[0-9A-F]{6}$' })));
  expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'failed']);
});

it('a pattern also matches its own text literally, so unescaped parentheses still mean that string', async () => {
  const document = { querySelectorAll: (selector: string) => [{ innerText: selector === '#same' ? 'rgb(255, 255, 255)' : 'rgb(1, 2, 3)', textContent: '' }] } as unknown as Document;
  const results = await runDOMChecks(document, ['#same', '#other'].map((selector) => ({ name: selector, actions: [], selector, assertion: 'matches', expected: 'rgb(255, 255, 255)' })));
  expect(results.map((result) => result.status)).toEqual(['passed', 'failed']);
});

it('selects nth for actions and checks, including relative checks and out-of-range errors', async () => {
  const buttons = [{ textContent: 'First', click: () => { throw new Error('Wrong button'); } }, { textContent: 'Second', click: () => { buttons[1].textContent = 'Clicked'; } }];
  const document = { querySelectorAll: () => buttons } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Second text', actions: [], selector: 'button', nth: 1, expected: 'Second' },
    { name: 'Second click', actions: [{ type: 'click', selector: 'button', nth: 1 }], selector: 'button', nth: 1, assertion: 'changed', expected: '' },
    { name: 'Clicked text', actions: [], selector: 'button', nth: 1, expected: 'Clicked' },
    { name: 'Kept', actions: [{ type: 'click', selector: 'button', nth: 1 }], selector: 'button', nth: 1, assertion: 'unchanged', expected: '' },
    { name: 'Missing check', actions: [], selector: 'button', nth: 2, expected: '' },
    { name: 'Missing action', actions: [{ type: 'click', selector: 'button', nth: 2 }], selector: 'button', nth: 0, expected: '' },
  ]);
  expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'failed', 'failed']);
  expect(results.slice(4).map((result) => result.error)).toEqual(Array(2).fill('Selector matched 2 elements, no index 2: button'));
});


it.each(['radio', 'checkbox'])('input clicks a %s into the wanted checked state and leaves its value alone', async (type) => {
  const clicks: boolean[] = [];
  // A native click toggles the state (and fires click, input and change itself).
  const input = { tagName: 'INPUT', type, checked: false, value: '2', click() { this.checked = !this.checked; clicks.push(this.checked); } };
  const document = { querySelectorAll: () => [input] } as unknown as Document;
  for (const value of ['2', 'true', 'false', 'false', '']) {
    const [result] = await runDOMChecks(document, [{ name: 'State', actions: [{ type: 'input', selector: '#input', value }], selector: '#input', assertion: 'attribute', attribute: 'checked', expected: String(value !== 'false') }]);
    expect(result.status).toBe('passed');
    expect(input.value).toBe('2');
  }
  // Clicked only when the state had to change: on, (already on), off, (already off), on.
  expect(clicks).toEqual([true, false, true]);
});


it('reads trimmed inline style values and missing properties', async () => {
  const bar = { style: { getPropertyValue: (name: string) => name === 'width' ? ' 90% ' : '' } };
  const document = { querySelectorAll: () => [bar] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Width', actions: [], selector: '#bar', assertion: 'attribute', attribute: 'style.width', expected: '90%' },
    { name: 'Missing', actions: [], selector: '#bar', assertion: 'attribute', attribute: 'style.left', expected: '' },
  ]);
  expect(results.map(({ status, actual }) => ({ status, actual }))).toEqual([{ status: 'passed', actual: '90%' }, { status: 'passed', actual: '' }]);
});

it('accepts untransformed rendered text and restores inline values and priorities', async () => {
  const style = (value: string, priority = '') => ({ textTransform: value, priority, getPropertyValue() { return this.textTransform; }, getPropertyPriority() { return this.priority; }, setProperty(_name: string, value: string, priority: string) { this.textTransform = value; this.priority = priority; }, removeProperty() { this.textTransform = ''; } });
  const child = { style: style('uppercase', 'important') };
  const output = { style: style(''), querySelectorAll: () => [child], textContent: 'Min 10Max 30', get innerText() { return this.style.textTransform === 'none' && child.style.textTransform === 'none' ? 'Min 10 Max 30' : 'MIN 10 MAX 30'; } };
  const document = { querySelectorAll: () => [output] } as unknown as Document;
  for (const assertion of ['text', 'matches'] as const) {
    const [result] = await runDOMChecks(document, [{ name: 'Case', actions: [], selector: '#summary', assertion, expected: assertion === 'text' ? 'Min 10 Max 30' : '^Min 10 Max 30$' }]);
    expect(result).toMatchObject({ status: 'passed', actual: 'MIN 10 MAX 30' });
    expect(output.style.textTransform).toBe('');
    expect(child.style.textTransform).toBe('uppercase');
    expect(child.style.priority).toBe('important');
  }
});

it('stable captures after actions, accepts static text and fails on a delayed change', async () => {
  const output = { textContent: '25:00' };
  const button = { click: () => { output.textContent = '00:30'; setTimeout(() => { output.textContent = '00:29'; }, 300); } };
  const document = { querySelectorAll: (selector: string) => selector === '#timer' ? [output] : [button] } as unknown as Document;
  const results = await runDOMChecks(document, [
    { name: 'Static', actions: [], selector: '#timer', assertion: 'stable', expected: '' },
    { name: 'Changes', actions: [{ type: 'click', selector: '#pause' }], selector: '#timer', assertion: 'stable', expected: '' },
  ]);
  expect(results[0]).toMatchObject({ status: 'passed', actual: '25:00' });
  expect(results[1]).toMatchObject({ status: 'failed', actual: '00:29', error: 'Expected text to stay "00:30" after the actions, observed "00:29"' });
});

it.each([false, true])('changed captures a newly created element; unchanged needs it before (advances: %s)', async (advances) => {
  const output = { textContent: '0' };
  let created = false;
  const button = { click: () => { created = true; if (advances) setTimeout(() => { output.textContent = '1'; }, 100); } };
  const document = { querySelectorAll: (selector: string) => selector === 'button' ? [button] : created ? [output] : [] } as unknown as Document;
  const actions = [{ type: 'click' as const, selector: 'button' }];
  const results = await runDOMChecks(document, [
    { name: 'Requires baseline', actions, selector: 'output', assertion: 'unchanged', expected: '' },
    { name: 'Created timer advances', actions, selector: 'output', assertion: 'changed', expected: '' },
  ]);
  expect(results.map(({ status }) => status)).toEqual(['failed', advances ? 'passed' : 'failed']);
  expect(results[1].actual).toBe(advances ? '1' : '0');
});

it('matches reads exact attributes and live properties without falling back to text', async () => {
  const input = { tagName: 'INPUT', value: 'live', checked: true, textContent: 'text', getAttribute: (name: string) => name === 'aria-label' ? 'Card 2, revealed' : name === 'title' ? '  spaced  ' : null, style: { getPropertyValue: () => ' 90% ' } };
  const document = { querySelectorAll: () => [input] } as unknown as Document;
  for (const [attribute, expected, actual] of [['aria-label', '^Card \\d+, revealed$', 'Card 2, revealed'], ['value', '^live$', 'live'], ['checked', '^true$', 'true'], ['style.width', '^90%$', '90%'], ['title', '^  spaced  $', '  spaced  '], ['missing', '^$', '']]) {
    const [result] = await runDOMChecks(document, [{ name: attribute, actions: [], selector: 'input', assertion: 'matches', attribute, expected }]);
    expect(result).toMatchObject({ status: 'passed', actual });
  }
  const [result] = await runDOMChecks(document, [{ name: 'No text fallback', actions: [], selector: 'input', assertion: 'matches', attribute: 'missing', expected: '^text$' }]);
  expect(result).toMatchObject({ status: 'failed', actual: '' });
});

it('waits the full action duration before checking delayed text', async () => {
  vi.useFakeTimers();
  try {
    const output = { textContent: 'Loading' };
    const document = { querySelectorAll: () => [output] } as unknown as Document;
    setTimeout(() => { output.textContent = 'Ready'; }, 200);
    const started = Date.now();
    let finished = false;
    const pending = runDOMChecks(document, [{ name: 'Delayed', actions: [{ type: 'wait', ms: 300 }], selector: '#status', expected: 'Ready' }]).then((results) => { finished = true; return results; });
    await vi.advanceTimersByTimeAsync(299);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ name: 'Delayed', status: 'passed', actual: 'Ready' }]);
    expect(Date.now() - started).toBe(300);
  } finally { vi.useRealTimers(); }
});


it('checks class membership while reporting and matching the full string', async () => {
  vi.useFakeTimers();
  try {
    let classes = 'lamp red on';
    const target = { getAttribute: () => classes, classList: { contains: (token: string) => classes.split(/\s+/).includes(token), get length() { return classes.trim() ? classes.trim().split(/\s+/).length : 0; } } };
    const document = { querySelectorAll: () => [target] } as unknown as Document;
    const pending = runDOMChecks(document, ['on', 'on red', 'off', ''].map((expected) => ({ name: expected || 'Empty', actions: [], selector: '#lamp', assertion: 'attribute', attribute: 'class', expected })));
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(results.map(({ status }) => status)).toEqual(['passed', 'passed', 'failed', 'failed']);
    expect(results.every(({ actual }) => actual === classes)).toBe(true);
    classes = '';
    expect((await runDOMChecks(document, [{ name: 'Empty', actions: [], selector: '#lamp', assertion: 'attribute', attribute: 'class', expected: '' }]))[0].status).toBe('passed');
    classes = 'lamp red on';
    expect((await runDOMChecks(document, [{ name: 'Pattern', actions: [], selector: '#lamp', assertion: 'matches', attribute: 'class', expected: '^lamp red on$' }]))[0].status).toBe('passed');
  } finally { vi.useRealTimers(); }
});

it('compares attribute baselines and samples including created elements', async () => {
  vi.useFakeTimers();
  try {
    let height = '10px', classes = 'lamp red on', created = false;
    const target = { textContent: '', style: { getPropertyValue: () => height }, getAttribute: () => classes };
    const button = { click: () => { height = '20px'; created = true; setTimeout(() => { classes = 'lamp red'; height = '30px'; }, 300); } };
    const document = { querySelectorAll: (selector: string) => selector === 'button' ? [button] : selector === '#created' && !created ? [] : [target] } as unknown as Document;
    const actions = [{ type: 'click' as const, selector: 'button' }];
    const pending = runDOMChecks(document, [
      { name: 'Height', actions, selector: '#bar', assertion: 'changed', attribute: 'style.height', expected: '' },
      { name: 'Class', actions, selector: '#bar', assertion: 'stable', attribute: 'class', expected: '' },
      { name: 'Unchanged', actions: [{ type: 'wait', ms: 50 }], selector: '#bar', assertion: 'unchanged', attribute: 'style.height', expected: '' },
    ]);
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(results.map(({ status }) => status)).toEqual(['passed', 'failed', 'passed']);
    expect(results[0].actual).toBe('20px');
    expect(results[1].error).toBe('Expected attribute class to stay "lamp red on" after the actions, observed "lamp red"');
    created = false;
    const deferred = runDOMChecks(document, [{ name: 'Created', actions, selector: '#created', assertion: 'changed', attribute: 'style.height', expected: '' }]);
    await vi.runAllTimersAsync();
    expect((await deferred)[0]).toMatchObject({ status: 'passed', actual: '30px' });
  } finally { vi.useRealTimers(); }
});


it('reads computed styles and compares class-driven changes and stable samples', async () => {
  vi.useFakeTimers();
  try {
    const target = { className: '', style: { getPropertyValue: () => '' } };
    const button = { click: () => { target.className = target.className ? '' : 'open'; } };
    const document = { querySelectorAll: (selector: string) => selector === 'button' ? [button] : [target], defaultView: { getComputedStyle: (element: typeof target) => ({ getPropertyValue: (name: string) => name === 'transform' ? ' matrix(-1, 0, 0, -1, 0, 0) ' : element.className === 'open' ? ' rgb(255, 0, 0) ' : ' rgb(0, 0, 0) ' }) } } as unknown as Document;
    const pending = runDOMChecks(document, [
      { name: 'Transform', actions: [], selector: '#arrow', assertion: 'attribute', attribute: 'css.transform', expected: 'matrix(-1, 0, 0, -1, 0, 0)' },
      { name: 'Inline', actions: [], selector: '#arrow', assertion: 'attribute', attribute: 'style.transform', expected: '' },
      { name: 'Colour', actions: [{ type: 'click', selector: 'button' }], selector: '#arrow', assertion: 'changed', attribute: 'css.background-color', expected: '' },
      { name: 'Pattern', actions: [], selector: '#arrow', assertion: 'matches', attribute: 'css.background-color', expected: '^rgb\\(255, ' },
      { name: 'Unchanged', actions: [{ type: 'wait', ms: 50 }], selector: '#arrow', assertion: 'unchanged', attribute: 'css.background-color', expected: '' },
      { name: 'Stable', actions: [], selector: '#arrow', assertion: 'stable', attribute: 'css.background-color', expected: '' },
    ]);
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(results.map(({ status }) => status)).toEqual(Array(6).fill('passed'));
    expect(results.map(({ actual }) => actual)).toEqual(['matrix(-1, 0, 0, -1, 0, 0)', '', ...Array(4).fill('rgb(255, 0, 0)')]);
  } finally { vi.useRealTimers(); }
});

it('inputs replace contenteditable text and fire input, change and blur, but reject plain divs', async () => {
  const events: Event[] = [];
  const node = { textContent: '<b>Updated note</b>' };
  const target = { tagName: 'DIV', isContentEditable: true, textContent: 'Old note', replaceChildren: vi.fn((child: typeof node) => { target.textContent = child.textContent; }), dispatchEvent: (event: Event) => { events.push(event); } };
  const document = { querySelectorAll: () => [target], createTextNode: vi.fn(() => node) } as unknown as Document;
  const check = { name: 'Edit note', actions: [{ type: 'input' as const, selector: 'div', value: node.textContent }], selector: 'div', expected: node.textContent };
  expect(await runDOMChecks(document, [check])).toEqual([{ name: 'Edit note', status: 'passed', actual: node.textContent }]);
  expect(document.createTextNode).toHaveBeenCalledWith(node.textContent);
  expect(target.replaceChildren).toHaveBeenCalledWith(node);
  expect(events.map(({ type }) => type)).toEqual(['input', 'change', 'blur']);
  expect(events.slice(0, 2).every(({ bubbles }) => bubbles)).toBe(true);
  target.isContentEditable = false;
  events.length = 0;
  expect((await runDOMChecks(document, [check]))[0]).toMatchObject({ status: 'failed', error: 'Input action requires an input, textarea, select or contenteditable element' });
  expect(events).toEqual([]);
});


it('requires the clock for advance and calls it before the assertion', async () => {
  const output = { textContent: 'Playing' };
  const clock = { runFor: vi.fn(async () => { output.textContent = 'Game over'; }) };
  const document = { defaultView: {}, querySelectorAll: () => [output] } as unknown as Document;
  const check = { name: 'Round', actions: [{ type: 'advance' as const, ms: 31000 }], selector: '#status', expected: 'Game over' };
  expect((await runDOMChecks(document, [check]))[0].error).toContain('advance needs the virtual clock');
  Object.assign(document.defaultView!, { __studioClock: clock });
  expect((await runDOMChecks(document, [check]))[0].status).toBe('passed');
  expect(clock.runFor).toHaveBeenCalledWith(31000);
});
