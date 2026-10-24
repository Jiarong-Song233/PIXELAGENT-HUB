export type BrowserCheck = { name: string; trace?: string; actions: ({ type: 'click'; selector: string; nth?: number } | { type: 'input'; selector: string; nth?: number; value: string } | { type: 'key'; selector: string; nth?: number; key: string } | { type: 'wait'; ms: number })[]; selector: string; nth?: number; expected: string; assertion?: 'text' | 'matches' | 'disabled' | 'visible' | 'count' | 'attribute' | 'changed' | 'unchanged' | 'stable'; attribute?: string };
export type BrowserCheckResult = { name: string; status: 'passed' | 'failed'; actual: string; error?: string };

// This function is serialized into the sandbox. Keep all helpers local; no eval or model code.
export async function runDOMChecks(document: Document, checks: BrowserCheck[], errorCount: () => number = () => 0): Promise<BrowserCheckResult[]> {
  const results: BrowserCheckResult[] = [];
  const element = (selector: string, nth?: number): HTMLElement => {
    const matches = document.querySelectorAll(selector);
    if (nth !== undefined && matches.length <= nth) throw new Error(`Selector matched ${matches.length} elements, no index ${nth}: ${selector}`);
    if (nth === undefined && matches.length !== 1) throw new Error(`Selector must match exactly one element: ${selector} (found ${matches.length})`);
    return matches[nth ?? 0] as HTMLElement;
  };
  const untransformed = (element: HTMLElement) => {
    const elements = [element, ...Array.from(element.querySelectorAll?.('*') ?? []) as HTMLElement[]].filter((item) => item.style);
    const previous = elements.map((item) => [item.style.getPropertyValue('text-transform'), item.style.getPropertyPriority('text-transform')]);
    try {
      for (const item of elements) item.style.textTransform = 'none';
      return element.innerText ?? element.textContent ?? '';
    } finally {
      elements.forEach((item, index) => {
        const [value, priority] = previous[index];
        if (value) item.style.setProperty('text-transform', value, priority);
        else item.style.removeProperty('text-transform');
      });
    }
  };
  for (const check of checks) {
    let actual = '';
    try {
      const previousErrors = errorCount();
      const assertion = check.assertion || 'text';
      const relative = assertion === 'changed' || assertion === 'unchanged';
      const steady = assertion === 'unchanged' || assertion === 'stable';
      const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
      const readAttribute = (element: HTMLElement, attribute: string) => attribute.startsWith('css.') ? document.defaultView!.getComputedStyle(element).getPropertyValue(attribute.slice(4)).trim() : attribute.startsWith('style.') ? (element as HTMLElement).style.getPropertyValue(attribute.slice(6)).trim() : attribute === 'value' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? (element as HTMLInputElement).value : attribute === 'checked' && element.tagName === 'INPUT' ? String((element as HTMLInputElement).checked) : element.getAttribute(attribute) ?? '';
      const baseline = relative && !(assertion === 'changed' && document.querySelectorAll(check.selector).length === 0) ? element(check.selector, check.nth) : undefined;
      let expected = baseline ? check.attribute ? readAttribute(baseline, check.attribute) : collapse(baseline.innerText ?? baseline.textContent ?? '') : assertion === 'text' ? collapse(check.expected) : check.expected;
      for (const action of check.actions) {
        if (action.type === 'wait') { await new Promise((resolve) => setTimeout(resolve, action.ms)); continue; }
        const target = element(action.selector, action.nth);
        if (action.type === 'click') target.click();
        else if (action.type === 'input') {
          if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) throw new Error('Input action requires an input, textarea, select or contenteditable element');
          // Checkboxes and radios are clicked into the wanted state (click, input and change fire
          // natively), like Playwright's check()/uncheck() on the server.
          if (target.tagName === 'INPUT' && ['checkbox', 'radio'].includes((target as HTMLInputElement).type)) {
            if ((target as HTMLInputElement).checked !== (action.value !== 'false')) target.click();
          } else {
            if (target.isContentEditable) target.replaceChildren(document.createTextNode(action.value));
            else (target as HTMLInputElement).value = action.value;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            if (target.isContentEditable) target.dispatchEvent(new Event('blur'));
          }
        } else if (action.type === 'key') {
          target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }));
        } else throw new Error('Unsupported check action');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      let target = assertion === 'count' || assertion === 'stable' ? undefined : element(check.selector, check.nth);
      // Same rules as the server's browser runs: rendered text with runs of whitespace as one space,
      // visibility like Playwright plus no opacity:0 on the element or ancestors, and up to 2 s for the
      // expected value to appear (timers, transitions).
      const visible = () => {
        const box = target!.getBoundingClientRect?.();
        const style = document.defaultView?.getComputedStyle?.(target!);
        for (let element = target; element; element = element.parentElement ?? undefined) {
          if (parseFloat(document.defaultView?.getComputedStyle(element).opacity ?? '') === 0) return false;
        }
        return !!box && box.width > 0 && box.height > 0 && style?.visibility !== 'hidden';
      };
      // Text accepts rendered, source or untransformed rendered text; rendered text is reported.
      const read = () => assertion === 'count' ? String(document.querySelectorAll(check.selector).length)
        : check.attribute ? readAttribute(target!, check.attribute)
        : assertion === 'disabled' ? String(target!.matches(':disabled'))
        : assertion === 'visible' ? String(visible())
          : collapse(target!.innerText ?? target!.textContent ?? '');
      if (assertion === 'changed' && !baseline) expected = read();
      // A pattern also matches its own text literally: "rgb(255, 255, 255)" written unescaped means that string.
      const pattern = assertion === 'matches' ? new RegExp(`(?:${check.expected})|^${check.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u') : undefined;
      const matches = (observed: string) => assertion === 'attribute' && check.attribute === 'class' ? (expected.trim() ? expected.trim().split(/\s+/).every((token) => target!.classList.contains(token)) : target!.classList.length === 0) : pattern ? pattern.test(observed) || (!check.attribute && (pattern.test(collapse(target!.textContent ?? '')) || pattern.test(collapse(untransformed(target!))))) : observed === expected || (!check.attribute && (assertion === 'text' || relative || assertion === 'stable') && (collapse(target!.textContent ?? '') === expected || collapse(untransformed(target!)) === expected));
      if (assertion === 'stable') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        target = element(check.selector, check.nth);
        expected = read();
      }
      let observed = '';
      let matched = false;
      const deadline = Date.now() + (assertion === 'stable' ? 1500 : assertion === 'unchanged' ? 500 : 2000);
      do {
        if (relative || assertion === 'stable') target = element(check.selector, check.nth);
        observed = read();
        actual = observed.slice(0, 300);
        matched = assertion === 'changed' ? !matches(observed) : matches(observed);
        if (steady ? !matched : matched) break;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, assertion === 'stable' ? 100 : 50));
      } while (steady ? matched : !matched);
      if (errorCount() > previousErrors) throw new Error('Runtime error observed during this check');
      if (!matched && assertion === 'stable') throw new Error(`Expected ${check.attribute ? `attribute ${check.attribute}` : 'text'} to stay ${JSON.stringify(expected)} after the actions, observed ${JSON.stringify(actual)}`);
      if (!matched && relative) throw new Error(assertion === 'unchanged' ? `Expected ${check.attribute ? `attribute ${check.attribute}` : 'text'} to stay ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}` : `Expected ${check.attribute ? `attribute ${check.attribute}` : 'text'} to change from ${JSON.stringify(expected)}`);
      if (!matched) throw new Error(`Expected ${JSON.stringify(check.expected)}, observed ${JSON.stringify(actual)}`);
      results.push({ name: check.name, status: 'passed', actual });
    } catch (error) {
      results.push({ name: check.name, status: 'failed', actual, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
    }
  }
  return results;
}

export function readCheckResults(message: string): BrowserCheckResult[] | null {
  try {
    const results = JSON.parse(message);
    if (!Array.isArray(results) || results.length < 1 || results.length > 10 || results.some((result) => !result
      || typeof result.name !== 'string' || result.name.length > 120 || !['passed', 'failed'].includes(result.status)
      || typeof result.actual !== 'string' || result.actual.length > 300
      || (result.error !== undefined && (typeof result.error !== 'string' || result.error.length > 2000)))) return null;
    return results;
  } catch { return null; }
}
