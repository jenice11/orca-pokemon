import type { AgentRow } from '../model.ts';

declare const fixture: {
  agents: AgentRow[];
  failRoster: boolean;
  calls: { name?: string; method?: string; params?: { key: string } }[];
  emit(event: string, payload: unknown): void;
};
declare const orca: { host: { call(method: string, params: unknown): Promise<unknown> } };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(condition: () => boolean): Promise<void> {
  for (let frame: number = 0; frame < 150; frame++) {
    if (condition()) return;
    await new Promise<number>(requestAnimationFrame);
  }
  throw new Error('View test did not settle within 150 frames.');
}

function element<T extends HTMLElement>(id: string): T {
  const node: HTMLElement | null = document.getElementById(id);
  check(node, `Missing ${id}.`);
  return node as T;
}

function cards(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.agent-card'));
}

function groups(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#agents > .project-group'));
}

function keys(nodes: HTMLElement[]): string[] {
  return nodes.map((node: HTMLElement): string => node.dataset.orderKey!);
}

function same(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value: unknown, index: number): boolean => value === right[index]);
}

function select(id: string, value: string): void {
  const control: HTMLSelectElement = element(id);
  control.value = value;
  control.dispatchEvent(new Event('change'));
}

function move(node: HTMLElement, selector: string, key: string): void {
  const grip: HTMLButtonElement = node.querySelector(selector)!;
  grip.focus();
  grip.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
  check(document.activeElement === grip, 'Keyboard moves must retain grip focus.');
}

async function refresh(): Promise<void> {
  const button: HTMLButtonElement = element('refresh');
  await until((): boolean => !button.disabled);
  button.click();
  await until((): boolean => !button.disabled);
}

async function checkSaved(key: string, expected: string[]): Promise<void> {
  await new Promise<number>(requestAnimationFrame);
  const result: unknown = await orca.host.call('storage.get', { key });
  check(result !== null && typeof result === 'object' && 'value' in result && Array.isArray(result.value), `${key} must store the full order.`);
  check(same(result.value.filter((token: unknown): boolean => typeof token === 'string' && expected.includes(token)), expected), `${key} must retain hidden members in DOM order.`);
}

function writes(): number {
  return fixture.calls.filter((call: { method?: string }): boolean => call.method === 'storage.set').length;
}

export async function run(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'View tests require the mock preview.');
  await until((): boolean => cards().length === 4 && !element<HTMLButtonElement>('view-options-button').disabled);
  const passed: string[] = [];
  const view: HTMLButtonElement = element('view-options-button');
  const popup: HTMLElement = element('view-options');
  const filter: HTMLSelectElement = element('agent-filter');
  const roster: HTMLElement = element('agents');
  const clear: HTMLButtonElement = element('clear-filter');
  const active: HTMLElement = element('active-filter-label');
  const refreshButton: HTMLButtonElement = element('refresh');
  check(refreshButton.getAttribute('aria-label') === 'Refresh' && refreshButton.querySelector('svg') && !refreshButton.textContent!.trim(), 'Refresh must retain its handler ID and expose an accessible icon only.');
  check(clear.hidden && clear.closest('.toolbar-actions') && clear.contains(active) && clear.querySelector('svg'), 'All statuses must hide the toolbar clear button with its status label and close icon.');
  check(clear.getAttribute('aria-label')?.toLowerCase().includes('clear'), 'Clear filter must have an explicit accessible name.');
  check(view.querySelector('svg') && !view.textContent!.trim() && view.getAttribute('aria-label'), 'View options must use an accessible icon without a text toolbar row.');
  check(popup.getAttribute('popover') === 'auto' && popup.getAttribute('role') === 'dialog' && popup.getAttribute('aria-labelledby'), 'View options must be a named native auto-popover dialog.');
  check(popup.contains(filter) && popup.contains(element('agent-sort')) && filter.labels?.length === 1, 'Status and existing sort controls must live in the popup with a status label.');
  check(same(Array.from(filter.options, (option: HTMLOptionElement): string => option.value), ['all', 'working', 'blocked', 'idle']), 'Status options must combine Waiting / Done without offering Unknown.');
  check(same(Array.from(element<HTMLSelectElement>('agent-sort').options, (option: HTMLOptionElement): string => option.value), ['manual', 'attention', 'name']), 'Existing sort options must remain available.');
  check(!popup.matches(':popover-open') && popup.getClientRects().length === 0, 'Closed options must take no layout space.');
  const before: DOMRect = roster.getBoundingClientRect();
  view.click();
  await until((): boolean => popup.matches(':popover-open') && view.getAttribute('aria-expanded') === 'true');
  const after: DOMRect = roster.getBoundingClientRect();
  check(before.top === after.top && before.width === after.width && before.height === after.height, 'Opening options must not move or resize the roster.');
  check(popup.getBoundingClientRect().left >= 0 && popup.getBoundingClientRect().right <= innerWidth, 'Options must fit narrow viewports.');
  for (const control of [filter, element<HTMLSelectElement>('agent-sort')]) {
    const label: HTMLLabelElement = control.labels![0];
    const labelBounds: DOMRect = label.getBoundingClientRect();
    const controlBounds: DOMRect = control.getBoundingClientRect();
    check(controlBounds.height === 24 && getComputedStyle(control).fontSize === '11px',
      'Popup dropdowns must stay 24px high without shrinking their text.');
    check(label.textContent!.endsWith(':') && labelBounds.right <= controlBounds.left &&
      Math.abs(labelBounds.top + labelBounds.height / 2 - controlBounds.top - controlBounds.height / 2) <= 1,
    'Each options label must end with a colon and sit beside its dropdown on one row.');
  }
  view.click();
  await until((): boolean => !popup.matches(':popover-open') && view.getAttribute('aria-expanded') === 'false');
  passed.push('icon popup is labeled, toggles from its icon, and takes no roster space');

  const baseline: AgentRow = fixture.agents[0];
  const states: AgentRow['state'][] = ['working', 'blocked', 'waiting', 'done', 'unknown'];
  fixture.agents = states.map((state: AgentRow['state'], index: number): AgentRow => ({
    ...baseline, id: `view-${index}`, paneKey: `tab:view-${index}`,
    title: ['Zulu', 'Bravo', 'Alpha', 'Delta', 'Unknown'][index],
    projectId: index === 4 ? 'view-unknown' : 'view-main',
    projectName: index === 4 ? 'Unknown project' : 'Main project', state
  }));
  await refresh();
  await until((): boolean => cards().length === 5 && !cards()[0].querySelector<HTMLButtonElement>('.drag-grip')!.disabled);
  select('agent-sort', 'manual');
  const main: HTMLElement = groups()[0];
  const unknown: HTMLElement = groups()[1];
  move(cards(main)[0], '.drag-grip', 'ArrowDown');
  await checkSaved('cards.order.v1', keys(cards(main)));
  const manual: HTMLElement[] = cards();
  const projects: HTMLElement[] = groups();
  const writeCount: number = writes();
  const filters: { value: string; states: AgentRow['state'][]; label: string }[] = [
    { value: 'working', states: ['working'], label: 'Working' },
    { value: 'blocked', states: ['blocked'], label: 'Needs help' },
    { value: 'idle', states: ['waiting', 'done'], label: 'Waiting / Done' }
  ];
  for (const status of filters) {
    select('agent-filter', status.value);
    check(same(cards(), manual) && same(groups(), projects), 'Filtering must retain every existing card and project in the same DOM order.');
    check(cards().every((card: HTMLElement): boolean => card.hidden === !status.states.some((state: AgentRow['state']): boolean => card.dataset.state === state)), `${status.label} must show only matching cards.`);
    check(cards().filter((card: HTMLElement): boolean => card.getClientRects().length > 0).length === status.states.length, 'Hidden cards must take no layout space.');
    check(element('summary').textContent === `${status.states.length}/5 companions`, 'Filtered summary must include shown/total without repeating the chip status.');
    check(!clear.hidden && active.textContent === status.label, 'Each active filter must expose its selected status in the clear chip.');
    check(!main.hidden && unknown.hidden, 'Specific filters must not misclassify agents with unreported status.');
    check(main.querySelector('.project-count')!.textContent === `${status.states.length}/4`, 'Project counts must include hidden members.');
    check(unknown.querySelector('.project-count')!.textContent === '0/1', 'Unreported project must remain in the full roster.');
    check(element('filter-empty').hidden, 'A matching filter must not show the empty notice.');
    clear.focus();
    clear.click();
    check(filter.value === 'all' && clear.hidden && document.activeElement === view, 'Clearing each status must select All, hide the chip, and focus view options.');
    check(same(cards(), manual) && same(groups(), projects) && !unknown.hidden && cards().every((card: HTMLElement): boolean => !card.hidden), 'Clearing must restore all cards, including unreported agents, without replacing or reordering any DOM nodes.');
  }
  select('agent-filter', 'idle');
  const waiting: AgentRow = fixture.agents[2];
  const waitingCard: HTMLElement = cards().find((card: HTMLElement): boolean => card.dataset.state === 'waiting')!;
  for (const state of ['done', 'waiting', 'working', 'blocked', 'unknown', 'waiting'] as const) {
    waiting.state = state;
    fixture.emit('agent.status.changed', { workspaceId: waiting.workspaceId, paneKey: waiting.paneKey, state });
    check(waitingCard.dataset.state === state && waitingCard.hidden === (state !== 'waiting' && state !== 'done'),
      'Combined filtering must follow live state changes without merging card statuses.');
  }
  await refresh();
  check(element<HTMLSelectElement>('agent-filter').value === 'idle' && element('summary').textContent === '2/5 companions' &&
    same(fixture.agents.map((row: AgentRow): AgentRow['state'] => row.state), states),
  'Refresh must preserve the combined filter and distinct Waiting / Done model states.');
  clear.click();
  unknown.querySelector<HTMLButtonElement>('.project-toggle')!.click();
  select('agent-filter', 'working');
  check(unknown.hidden && unknown.querySelector<HTMLElement>('.project-agents')!.hidden, 'Filtering out an unreported project must preserve its collapsed list.');
  check(unknown.querySelector('.project-toggle')!.getAttribute('aria-expanded') === 'false', 'Filtering must preserve collapse accessibility state.');
  clear.click();
  check(!unknown.hidden && unknown.querySelector<HTMLElement>('.project-agents')!.hidden && cards(unknown).every((card: HTMLElement): boolean => !card.hidden), 'All must restore the unreported project without clearing collapse.');
  unknown.querySelector<HTMLButtonElement>('.project-toggle')!.click();
  await new Promise<number>(requestAnimationFrame);
  check(writes() === writeCount, 'Filtering and collapse must not write storage.');
  passed.push('all status filters retain DOM order, shown/total counts, unknown projects, and collapse state without writes');

  select('agent-filter', 'working');
  const working: AgentRow = fixture.agents[0];
  const owner: HTMLElement = cards().find((card: HTMLElement): boolean => card.dataset.state === 'working')!;
  owner.querySelector<HTMLButtonElement>('.agent-icon')!.focus();
  check(!element('workspace-tooltip').hidden, 'Focused owner must show its tooltip before filtering.');
  select('agent-filter', 'blocked');
  check(owner.hidden && element('workspace-tooltip').hidden && document.activeElement === view, 'Hiding a focused card must close its tooltip and focus the view icon.');
  select('agent-filter', 'working');
  const species: HTMLButtonElement = owner.querySelector('.species-picker')!;
  await until((): boolean => !species.disabled);
  species.click();
  await until((): boolean => element('species-panel').matches(':popover-open'));
  element<HTMLInputElement>('species-search').focus();
  select('agent-filter', 'blocked');
  check(!element('species-panel').matches(':popover-open') && document.activeElement === view, 'Hiding a popup owner must close species UI and restore focus to the view icon.');
  select('agent-filter', 'working');
  species.focus();
  working.state = 'done';
  fixture.emit('agent.status.changed', { paneKey: working.paneKey, state: 'done' });
  check(owner.hidden && document.activeElement === view && !element('filter-empty').hidden, 'Status events must immediately hide nonmatches, restore focus, and show the empty notice.');
  check(element('summary').textContent === '0/5 companions' && groups().every((group: HTMLElement): boolean => group.hidden), 'No matches must hide all groups without losing the roster.');
  check(cards().length === 5 && same(cards(), manual), 'Live filtering must retain all card instances and manual order.');
  await refresh();
  check(owner.hidden && !element('filter-empty').hidden, 'Refresh must preserve the active no-match filter.');
  clear.click();
  check(filter.value === 'all' && element('filter-empty').hidden && cards().every((card: HTMLElement): boolean => !card.hidden) && document.activeElement === view, 'Clear must recover from no matches and restore view-button focus.');
  select('agent-filter', 'working');
  working.state = 'working';
  fixture.emit('agent.status.changed', { paneKey: working.paneKey, state: 'working' });
  check(!owner.hidden && element('filter-empty').hidden && element('summary').textContent === '1/5 companions', 'Matching live status must immediately restore its existing card.');
  await refresh();
  check(same(cards(), manual), 'Status events and refresh must not reshuffle manual order.');
  passed.push('focused hidden owners close tooltips and species UI; live status and no-match refresh update immediately');

  const newcomer: AgentRow = { ...working, id: 'view-new', paneKey: 'tab:view-new', title: 'Echo' };
  const third: AgentRow = { ...working, id: 'view-third', paneKey: 'tab:view-third', title: 'Foxtrot', projectId: 'view-third', projectName: 'Third project' };
  fixture.agents.push(newcomer, third);
  await refresh();
  check(cards().length === 7 && cards(main).at(-1)!.querySelector('h2')!.textContent === 'Echo', 'New arrivals must append in manual order while filtering.');
  check(element('summary').textContent === '3/7 companions' && element('filter-empty').hidden, 'New matching arrivals must update the active filter and summary.');
  const fullManual: string[] = keys(cards());
  select('agent-sort', 'name');
  const names: string[] = cards(main).map((card: HTMLElement): string => card.querySelector('h2')!.textContent!);
  check(same(names, [...names].sort((left: string, right: string): number => left.localeCompare(right))), 'Explicit name sorting must include hidden cards.');
  const named: string[] = keys(cards());
  const sortedWrites: number = writes();
  select('agent-filter', 'idle');
  select('agent-filter', 'working');
  check(same(keys(cards()), named) && writes() === sortedWrites, 'Filter changes must not rerun sorting or persist derived order.');
  select('agent-sort', 'attention');
  check(cards(main)[0].dataset.state === 'blocked', 'Explicit attention sorting must include hidden blocked cards.');
  select('agent-sort', 'manual');
  check(same(keys(cards()), fullManual), 'Manual must restore the full sequence after filtered sorts.');
  for (const mode of ['manual', 'attention', 'name']) {
    select('agent-sort', mode);
    await new Promise<number>(requestAnimationFrame);
    const ordered: HTMLElement[] = cards();
    const orderedGroups: HTMLElement[] = groups();
    const savedCards: unknown = await orca.host.call('storage.get', { key: 'cards.order.v1' });
    const savedProjects: unknown = await orca.host.call('storage.get', { key: 'projects.order.v1' });
    const beforeClear: number = writes();
    select('agent-filter', 'blocked');
    clear.click();
    await new Promise<number>(requestAnimationFrame);
    check(element<HTMLSelectElement>('agent-sort').value === mode && same(cards(), ordered) && same(groups(), orderedGroups), 'Clear must retain each sort mode and complete card/project DOM order.');
    check(writes() === beforeClear && JSON.stringify(await orca.host.call('storage.get', { key: 'cards.order.v1' })) === JSON.stringify(savedCards) && JSON.stringify(await orca.host.call('storage.get', { key: 'projects.order.v1' })) === JSON.stringify(savedProjects), 'Clear must not write storage or alter either saved order.');
    check(document.activeElement === view && clear.hidden, 'Clear in each sort mode must hide the chip and focus view options.');
  }
  select('agent-sort', 'manual');
  select('agent-filter', 'working');
  main.querySelector<HTMLButtonElement>('.project-toggle')!.click();
  fixture.failRoster = true;
  await refresh();
  const staleError: string = element('error').textContent!;
  check(!clear.hidden && active.textContent === 'Working' && element('summary').textContent === '3/7 companions · stale', 'Stale filtered rosters must retain both selected-status chip and stale summary.');
  check(!element('error').hidden && staleError.length > 0, 'Stale clear regression needs a visible roster error.');
  const staleWrites: number = writes();
  clear.focus();
  clear.click();
  check(element('summary').textContent!.includes('stale') && !element('error').hidden && element('error').textContent === staleError, 'Clear must not dismiss errors or clear stale state.');
  check(main.querySelector<HTMLElement>('.project-agents')!.hidden && main.querySelector('.project-toggle')!.getAttribute('aria-expanded') === 'false', 'Clear must preserve collapsed groups and their accessibility state.');
  check(document.activeElement === view && writes() === staleWrites && same(keys(cards()), fullManual), 'Stale clear must preserve focus, storage, and complete manual order.');
  fixture.failRoster = false;
  await refresh();
  main.querySelector<HTMLButtonElement>('.project-toggle')!.click();
  select('agent-filter', 'working');
  passed.push('clear chip retains every sort, saved order, collapsed group, error and stale state without storage writes');
  passed.push('new arrivals respect the active filter and explicit sorts retain hidden cards and saved manual order');

  const beforeMove: HTMLElement[] = cards(main);
  const visible: HTMLElement[] = beforeMove.filter((card: HTMLElement): boolean => !card.hidden);
  check(visible.length === 2 && beforeMove.indexOf(visible[1]) - beforeMove.indexOf(visible[0]) > 1, 'Keyboard fixture must contain hidden siblings between visible cards.');
  move(visible[0], '.drag-grip', 'ArrowDown');
  const expected: HTMLElement[] = beforeMove.filter((card: HTMLElement): boolean => card !== visible[0]);
  expected.splice(expected.indexOf(visible[1]) + 1, 0, visible[0]);
  check(same(cards(main), expected), 'Arrow Down must skip hidden siblings and retain them in full order.');
  check(element('order-announcement').textContent!.includes('position 2 of 2'), 'Filtered card movement must announce visible position.');
  await Promise.all(groups().map((group: HTMLElement): Promise<void> => checkSaved('cards.order.v1', keys(cards(group)))));
  move(visible[0], '.drag-grip', 'ArrowUp');
  check(cards(main).filter((card: HTMLElement): boolean => !card.hidden)[0] === visible[0], 'Arrow Up must skip hidden siblings.');
  const projectBefore: HTMLElement[] = groups();
  check(projectBefore.length === 3 && projectBefore[1].hidden, 'Project keyboard fixture must contain a hidden middle group.');
  move(main, '.project-grip', 'ArrowDown');
  check(same(groups(), [projectBefore[1], projectBefore[2], main]), 'Project keyboard moves must skip hidden groups without dropping them.');
  check(element('order-announcement').textContent!.includes('position 2 of 2'), 'Filtered project movement must announce visible position.');
  await checkSaved('projects.order.v1', keys(groups()));
  move(main, '.project-grip', 'ArrowUp');
  check(groups().filter((group: HTMLElement): boolean => !group.hidden)[0] === main, 'Project Arrow Up must skip hidden groups.');
  await checkSaved('projects.order.v1', keys(groups()));
  const movedCards: string[] = keys(cards());
  const movedGroups: string[] = keys(groups());
  select('agent-filter', 'all');
  await refresh();
  check(cards().every((card: HTMLElement): boolean => !card.hidden) && same(keys(cards()), movedCards) && same(keys(groups()), movedGroups), 'Clearing filters and refreshing must preserve complete moved orders.');
  await Promise.all(groups().map((group: HTMLElement): Promise<void> => checkSaved('cards.order.v1', keys(cards(group)))));
  passed.push('filtered keyboard moves skip hidden cards and projects while saving complete orders');

  const extra: AgentRow[] = Array.from({ length: 16 }, (_: unknown, index: number): AgentRow => ({
    ...working, id: `view-scroll-${index}`, paneKey: `tab:view-scroll-${index}`, title: `Scroll agent ${index}`
  }));
  fixture.agents.push(...extra);
  await refresh();
  const scroller: HTMLElement = document.querySelector('main')!;
  check(scroller.scrollHeight > scroller.clientHeight, 'Scroll regression requires a roster taller than the viewport.');
  scroller.scrollTop = 0;
  view.click();
  await until((): boolean => popup.matches(':popover-open'));
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise<number>(requestAnimationFrame);
  check(scroller.scrollTop > 0, 'Scroll regression must start below the toolbar.');
  const previousScroll: number = scroller.scrollTop;
  select('agent-filter', 'idle');
  await new Promise<number>(requestAnimationFrame);
  await new Promise<number>(requestAnimationFrame);
  check(scroller.scrollTop < previousScroll && popup.matches(':popover-open'), 'Shrinking filtered results and clamping scroll must not dismiss view options.');
  const popupBounds: DOMRect = popup.getBoundingClientRect();
  check(popupBounds.top >= 0 && popupBounds.bottom <= innerHeight, 'Options must remain within the viewport after scroll clamps.');
  view.click();
  await until((): boolean => !popup.matches(':popover-open'));
  select('agent-filter', 'all');
  const offscreenOwner: HTMLElement = cards(main).at(-1)!;
  const offscreenControl: HTMLButtonElement = offscreenOwner.querySelector('.drag-grip')!;
  offscreenControl.scrollIntoView();
  offscreenControl.focus();
  check(view.getBoundingClientRect().bottom <= 0, 'Focus regression must start with the toolbar above the viewport.');
  select('agent-filter', 'idle');
  await new Promise<number>(requestAnimationFrame);
  const focusBounds: DOMRect = view.getBoundingClientRect();
  check(document.activeElement === view && focusBounds.top >= 0 && focusBounds.bottom <= innerHeight, 'Hiding an offscreen focused owner must restore visible focus to the view icon.');
  select('agent-filter', 'all');
  passed.push('scroll-clamped filtering keeps options open and hidden offscreen owners restore visible icon focus');
  const sprite: HTMLElement = owner.querySelector('.sprite')!;
  const toggle: HTMLButtonElement = main.querySelector('.project-toggle')!;
  const motion: HTMLButtonElement = element('motion');
  const audioCalls: () => string[] = (): string[] => fixture.calls
    .filter((call: { name?: string }): boolean => call.name === 'audio.start' || call.name === 'audio.stop')
    .map((call: { name?: string }): string => call.name!);
  const beforeMotionAudio: string[] = audioCalls();
  await until((): boolean => sprite.getAnimations().length > 0);
  check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'running'), 'Visible sprites must start running when global motion is enabled.');
  for (const hiddenBy of ['filter', 'collapse']) {
    if (hiddenBy === 'filter') select('agent-filter', 'idle');
    else toggle.click();
    check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'paused'), `${hiddenBy} must pause hidden sprite WAAPI animations.`);
    const previous: Animation = sprite.getAnimations()[0];
    await orca.host.call('storage.set', { key: owner.dataset.orderKey!, value: hiddenBy === 'filter' ? 25 : 133 });
    await until((): boolean => sprite.getAnimations().length > 0 && sprite.getAnimations()[0] !== previous);
    check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'paused'), `Species reload while hidden by ${hiddenBy} must create paused animations.`);
    if (hiddenBy === 'filter') clear.click();
    else toggle.click();
    check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'running'), `Clearing ${hiddenBy} must resume visible sprite animations.`);
  }
  const hiddenDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(document, 'hidden');
  let pageHidden: boolean = true;
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: (): boolean => pageHidden });
    document.dispatchEvent(new Event('visibilitychange'));
    check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'paused'), 'Hidden documents must pause sprite animations.');
    pageHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'running'), 'Visible documents must resume eligible sprites.');
  } finally {
    if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
    else Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  }
  motion.click();
  check(motion.getAttribute('aria-pressed') === 'true', 'Global pause must be active for visibility regression.');
  select('agent-filter', 'idle');
  clear.click();
  check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'paused'), 'Clearing a filter during global pause must not resume sprites.');
  toggle.click();
  toggle.click();
  check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'paused'), 'Expanding a group during global pause must not resume sprites.');
  motion.click();
  check(sprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'running'), 'Explicit resume must restart visible sprites after filtering and collapse.');
  check(same(audioCalls(), beforeMotionAudio), 'Filter, collapse, species reload and global motion controls must not start or stop audio capture.');
  passed.push('hidden sprites pause, hidden species reload stays paused, clear/expand respects global pause, and audio lifecycle stays unchanged');
  return passed;
}
