import type { AgentRow } from '../model.ts';

declare const fixture: { agents: AgentRow[]; failRoster: boolean };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function element<T extends HTMLElement>(selector: string): T {
  const node: T | null = document.querySelector<T>(selector);
  check(node, `Missing ${selector}.`);
  return node;
}

async function frame(): Promise<void> {
  await new Promise<number>(requestAnimationFrame);
}

async function refresh(): Promise<void> {
  const button: HTMLButtonElement = element('#refresh');
  button.click();
  for (let count: number = 0; count < 150; count++) {
    await frame();
    if (!button.disabled) return;
  }
  throw new Error('Layout roster refresh did not settle.');
}

function insideViewport(node: HTMLElement): void {
  const bounds: DOMRect = node.getBoundingClientRect();
  check(bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.right <= innerWidth + 1 &&
    bounds.top >= -1 && bounds.bottom <= innerHeight + 1, `${node.id || node.tagName} must fit the viewport: ${JSON.stringify(bounds.toJSON())}.`);
}

function textFitsVertically(node: HTMLElement): void {
  const bounds: DOMRect = node.getBoundingClientRect();
  const range: Range = document.createRange();
  range.selectNodeContents(node);
  const text: DOMRect = range.getBoundingClientRect();
  check(text.height > 0 && text.top >= bounds.top - 1 && text.bottom <= bounds.bottom + 1,
    `${node.id || node.tagName} clips text vertically: text=${text.height}, box=${bounds.height}.`);
}

export async function prepare(): Promise<void> {
  check(typeof fixture !== 'undefined', 'Layout tests require the mock preview.');
  const baseline: AgentRow = fixture.agents[0];
  fixture.agents = Array.from({ length: 24 }, (_: unknown, index: number): AgentRow => ({
    ...baseline, id: `layout-${index}`, paneKey: `tab:layout-${index}`,
    title: `Layout companion ${index}`, state: index % 2 === 0 ? 'blocked' : 'working'
  }));
  await refresh();
  const filter: HTMLSelectElement = element('#agent-filter');
  filter.value = 'blocked';
  filter.dispatchEvent(new Event('change'));
  fixture.failRoster = true;
  await refresh();
}

export async function run(): Promise<string[]> {
  const main: HTMLElement = element('main');
  const toolbar: HTMLElement = element('.toolbar');
  const clear: HTMLButtonElement = element('#clear-filter');
  const label: HTMLElement = element('#active-filter-label');
  const summary: HTMLElement = element('#summary');
  const error: HTMLElement = element('#error');
  const view: HTMLButtonElement = element('#view-options-button');
  const popup: HTMLElement = element('#view-options');
  main.scrollTop = 0;
  await frame();
  const projectToggle: HTMLButtonElement = element('.project-toggle');
  const projectStyle: CSSStyleDeclaration = getComputedStyle(projectToggle);
  const arrowStyle: CSSStyleDeclaration = getComputedStyle(projectToggle, '::before');
  check(parseFloat(projectStyle.paddingLeft) >= 6 && parseFloat(projectStyle.paddingRight) >= 6 &&
    arrowStyle.flexShrink === '0' && arrowStyle.textAlign === 'center',
  'Project arrows must stay centered in a non-shrinking slot inset from the rounded hover edges.');
  const projectName: HTMLElement = element('.project-name');
  const expandedNameLeft: number = projectName.getBoundingClientRect().left;
  projectToggle.click();
  check(projectName.getBoundingClientRect().left === expandedNameLeft, 'Collapsing projects must not shift their label horizontally.');
  projectToggle.click();
  check(!clear.hidden && clear.getAttribute('aria-label')?.toLowerCase().includes('clear') &&
    label.textContent === 'Needs help' && clear.querySelector('svg[aria-hidden="true"]'), 'Active clear chip must remain named with its selected status and decorative close icon.');
  check(summary.getAttribute('role') === 'status' && summary.textContent === '12/24 companions · stale', 'Stale summary must remain accessible without repeating selected status.');
  check(!error.hidden && error.getAttribute('role') === 'alert' && error.textContent!.length > 0, 'Roster errors must remain accessible with an active chip.');
  for (const selector of ['#usage-help', '#refresh']) {
    const button: HTMLButtonElement = element(selector);
    const bounds: DOMRect = button.getBoundingClientRect();
    check(bounds.width === 32 && (parseFloat(getComputedStyle(button).fontSize) > 13 ? bounds.height >= 32 : bounds.height === 32), `${selector} header icon must retain its original 32px size, allowing enlarged text to grow vertically.`);
    insideViewport(button);
  }
  const toolbarBounds: DOMRect = toolbar.getBoundingClientRect();
  for (const node of [summary, clear, view, element<HTMLElement>('#motion')]) {
    const bounds: DOMRect = node.getBoundingClientRect();
    insideViewport(node);
    check(Math.abs(bounds.top + bounds.height / 2 - toolbarBounds.top - toolbarBounds.height / 2) <= 1, 'Summary, active chip and toolbar icons must share one row.');
  }
  textFitsVertically(label);
  const labelBounds: DOMRect = label.getBoundingClientRect();
  const clearBounds: DOMRect = clear.getBoundingClientRect();
  check(labelBounds.top >= clearBounds.top && labelBounds.bottom <= clearBounds.bottom, 'Clear button must grow with its enlarged status label instead of clipping it.');
  textFitsVertically(summary);
  check(clear.getBoundingClientRect().height >= 24 && clear.getBoundingClientRect().width <= 96, 'Clear chip must preserve its minimum height and bounded width.');
  check(getComputedStyle(label).textOverflow === 'ellipsis' && getComputedStyle(label).overflowX === 'hidden', 'Chip text must ellipsize rather than displace toolbar icons.');
  check(main.clientHeight > 0 && main.scrollHeight > main.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(main).overflowY), 'Main roster must remain independently scrollable at short heights.');
  main.scrollTop = main.scrollHeight;
  await frame();
  check(main.scrollTop > 0, 'Main scroll must reach lower companions.');
  error.scrollIntoView({ block: 'start' });
  await frame();
  insideViewport(error);
  textFitsVertically(error);
  main.scrollTop = 0;
  view.focus();
  view.click();
  await frame();
  check(popup.matches(':popover-open'), 'View options must open in short layouts.');
  insideViewport(popup);
  check(popup.scrollWidth <= popup.clientWidth + 1, 'Popup must not overflow horizontally.');
  for (const selector of ['#view-options-title', 'label[for="agent-filter"]', '#agent-filter', 'label[for="agent-sort"]', '#agent-sort']) {
    const control: HTMLElement = element(selector);
    control.scrollIntoView({ block: 'nearest' });
    await frame();
    const bounds: DOMRect = control.getBoundingClientRect();
    const popupBounds: DOMRect = popup.getBoundingClientRect();
    check(bounds.top >= popupBounds.top && bounds.bottom <= popupBounds.bottom && bounds.left >= popupBounds.left && bounds.right <= popupBounds.right, `${selector} must be reachable inside the viewport-bounded popup.`);
    if (control instanceof HTMLSelectElement) {
      const style: CSSStyleDeclaration = getComputedStyle(control);
      const contentHeight: number = control.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const lineHeight: number = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      check(bounds.height >= 24 && contentHeight >= lineHeight - 1, `${selector} must fit text: content=${contentHeight}px, line=${lineHeight}px.`);
      control.focus();
      check(document.activeElement === control, `${selector} must remain keyboard reachable.`);
    } else {
      textFitsVertically(control);
    }
  }
  check(document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth &&
    main.scrollWidth <= main.clientWidth + 1, 'Page and main must not overflow horizontally.');
  return ['short viewport, enlarged text, one-row toolbar, scrollable roster, accessible stale errors and reachable popup controls'];
}
