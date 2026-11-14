import { choiceKey, type AgentRow } from '../model.ts';

declare const fixture: {
  agents: AgentRow[];
  calls: { name?: string; method?: string; params?: { key: string } }[];
  emit(event: string, payload: unknown): void;
};
declare const orca: { host: { call(method: string, params: unknown): Promise<unknown> } };

const projectOrderKey: string = 'projects.order.v1';
const cardOrderKey: string = 'cards.order.v1';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(condition: () => boolean): Promise<void> {
  for (let frame: number = 0; frame < 150; frame++) {
    if (condition()) return;
    await new Promise<number>(requestAnimationFrame);
  }
  throw new Error('Project test did not settle within 150 frames.');
}

function groups(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#agents > .project-group'));
}

function keys(elements: HTMLElement[] = groups()): string[] {
  return elements.map((element: HTMLElement): string => element.dataset.orderKey!);
}

function cards(group: HTMLElement): HTMLElement[] {
  return Array.from(group.querySelectorAll<HTMLElement>('.project-agents > .agent-card'));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sort(mode: string): void {
  const control: HTMLSelectElement = document.getElementById('agent-sort') as HTMLSelectElement;
  control.value = mode;
  control.dispatchEvent(new Event('change'));
}

async function refresh(): Promise<void> {
  const button: HTMLButtonElement = document.getElementById('refresh') as HTMLButtonElement;
  await until((): boolean => !button.disabled);
  button.click();
  await until((): boolean => !button.disabled);
}

async function saved(key: string): Promise<string[]> {
  const result: unknown = await orca.host.call('storage.get', { key });
  check(result !== null && typeof result === 'object' && 'value' in result && Array.isArray(result.value), `${key} must store an array.`);
  check(result.value.every((token: unknown): boolean => typeof token === 'string' && /^pokemon\.v1:[a-f0-9]{64}$/.test(token)), `${key} must contain only hashed identity tokens.`);
  return result.value as string[];
}

async function checkSaved(key: string, expected: string[]): Promise<void> {
  // Let the existing serialized storage writer drain before reading its result.
  await new Promise<number>(requestAnimationFrame);
  const stored: string[] = await saved(key);
  check(same(stored.filter((token: string): boolean => expected.includes(token)), expected), `${key} must preserve the live order.`);
}

function customRows(): AgentRow[] {
  const baseline: AgentRow = fixture.agents[0];
  check(baseline !== undefined, 'Project tests require an existing fixture agent.');
  return Array.from({ length: 6 }, (_: unknown, index: number): AgentRow => ({
    ...baseline,
    id: `project-test-agent-${index}`,
    paneKey: `tab:project-test-${index}`,
    workspaceId: `project-test-workspace-${index}`,
    workspace: `Project workspace ${index}`,
    projectId: `project-test-${Math.floor(index / 2)}`,
    projectName: index < 4 ? 'Shared project name' : 'Other project',
    title: `${index % 2 === 0 ? 'Zulu' : 'Alpha'} agent ${index}`,
    agent: index % 2 === 0 ? 'claude' : 'codex',
    state: index % 2 === 0 ? 'done' : 'blocked'
  }));
}

async function install(rows: AgentRow[]): Promise<void> {
  fixture.agents = rows;
  fixture.emit('workspace.changed', {});
  await refresh();
  await until((): boolean => groups().length === new Set(rows.map((row: AgentRow): string => row.projectId)).size &&
    document.querySelectorAll('.agent-card').length === rows.length);
}

function drag(source: Element, target: HTMLElement, transfer: DataTransfer): void {
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  for (const type of ['dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: target.getBoundingClientRect().top + 1 }));
  }
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
}

export async function run(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'Project tests require the mock preview.');
  const passed: string[] = [];
  await until((): boolean => document.querySelectorAll('.agent-card').length === 4);
  check(groups().length === 1, 'Initial four agents must share one project.');
  const rows: AgentRow[] = customRows();
  await install(rows);
  sort('manual');
  const expectedKeys: string[] = await Promise.all([0, 1, 2].map((index: number): Promise<string> => choiceKey(`project:project-test-${index}`)));
  check(same([...keys()].sort(), [...expectedKeys].sort()), 'Projects must use hashed project IDs, not their possibly shared names.');
  for (const group of groups()) {
    const members: HTMLElement[] = cards(group);
    check(members.length === 2, 'Each project must contain both workspace agents.');
    const index: number = expectedKeys.indexOf(group.dataset.orderKey!);
    check(group.querySelector('.project-heading .project-name')!.textContent === rows[index * 2].projectName, 'Heading must display project name.');
    check(/\b2\b/.test(group.querySelector('.project-count')!.textContent!), 'Heading must count project agents.');
    check(group.querySelector<HTMLElement>('.project-grip')!.draggable, 'Project grip must be draggable.');
    for (const card of members) {
      const row: AgentRow = rows.find((candidate: AgentRow): boolean => candidate.title === card.querySelector('h2')!.textContent)!;
      const agentIcon: HTMLButtonElement = card.querySelector('.agent-icon')!;
      check(agentIcon.getAttribute('aria-label')!.includes(row.agent) && card.querySelector('.identity p') === null, 'Agent type must use an accessible icon instead of a header text row.');
      agentIcon.focus();
      const tooltip: HTMLElement = document.getElementById('workspace-tooltip')!;
      check(!tooltip.hidden && tooltip.textContent === row.agent, 'Agent icon tooltip must show only the agent name.');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    members[0].querySelector('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
    members[1].querySelector('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    check(cards(group)[0] === members[0] && cards(group)[1] === members[1], 'Card move boundaries must stop at their project.');
  }
  passed.push('project IDs separate duplicate names; headings count workspace agents and cards retain workspace tooltips');

  const collapsedKey: string = keys()[0];
  groups()[0].querySelector<HTMLButtonElement>('.project-toggle')!.click();
  await refresh();
  const collapsed: HTMLElement = groups().find((group: HTMLElement): boolean => group.dataset.orderKey === collapsedKey)!;
  check(collapsed.querySelector('.project-toggle')!.getAttribute('aria-expanded') === 'false', 'Collapsed project must survive refresh.');
  check(collapsed.querySelector<HTMLElement>('.project-agents')!.getClientRects().length === 0, 'Collapsed project agents must be hidden.');
  collapsed.querySelector<HTMLButtonElement>('.project-toggle')!.click();
  passed.push('project collapse survives roster refresh');

  const originalProjects: string[] = keys();
  const manual: string[][] = groups().map((group: HTMLElement): string[] => keys(cards(group)));
  sort('name');
  check(same(keys(), originalProjects), 'Name sort must not move projects.');
  for (const group of groups()) {
    const names: string[] = cards(group).map((card: HTMLElement): string => card.querySelector('h2')!.textContent!);
    check(same(names, [...names].sort((left: string, right: string): number => left.localeCompare(right))), 'Name sort must apply within every project.');
  }
  sort('attention');
  check(same(keys(), originalProjects) && groups().every((group: HTMLElement): boolean => cards(group)[0].dataset.state === 'blocked'), 'Attention sort must apply only within projects.');
  const beforeStatus: string[][] = groups().map((group: HTMLElement): string[] => keys(cards(group)));
  const rosterCalls: number = fixture.calls.filter((call): boolean => call.name === 'roster').length;
  rows[0].state = 'blocked';
  fixture.emit('agent.status.changed', { paneKey: rows[0].paneKey, state: 'blocked' });
  await until((): boolean => fixture.calls.filter((call): boolean => call.name === 'roster').length > rosterCalls);
  await until((): boolean => !(document.getElementById('refresh') as HTMLButtonElement).disabled);
  check(same(keys(), originalProjects) && same(groups().map((group: HTMLElement): string[] => keys(cards(group))), beforeStatus), 'Automatic status refresh must not jump agents or projects.');
  sort('manual');
  check(same(groups().map((group: HTMLElement): string[] => keys(cards(group))), manual), 'Manual mode must restore independent card order.');
  passed.push('name and attention sort within projects without status-event jumps or manual-order loss');

  const source: HTMLElement = cards(groups()[0])[1];
  const beforeCross: string[][] = groups().map((group: HTMLElement): string[] => keys(cards(group)));
  drag(source.querySelector('.drag-grip')!, cards(groups()[1])[0], new DataTransfer());
  check(same(groups().map((group: HTMLElement): string[] => keys(cards(group))), beforeCross), 'Cross-project card drops must be rejected.');
  drag(source.querySelector('.drag-grip')!, cards(groups()[0])[0], new DataTransfer());
  check(cards(groups()[0])[0] === source, 'Same-project card drag must reorder siblings.');
  for (const group of groups()) await checkSaved(cardOrderKey, keys(cards(group)));
  passed.push('card drag rejects cross-project drops and persists same-project moves');

  const moved: HTMLElement = groups()[0];
  check(!document.querySelector('.project-actions'), 'Projects must not contain redundant move menus.');
  const down: HTMLButtonElement = moved.querySelector('.project-grip')!;
  down.focus();
  down.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  check(groups()[1] === moved && document.activeElement === down, 'Project keyboard move must retain focus.');
  down.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
  check(groups()[0] === moved && document.activeElement === down, 'Arrow Up must move the project back and retain focus.');
  down.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
  check(groups()[0] === moved, 'Arrow Up must stop at the first project.');
  const finalProject: HTMLElement = groups()[groups().length - 1];
  finalProject.querySelector('.project-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  check(groups()[groups().length - 1] === finalProject, 'Arrow Down must stop at the last project.');
  down.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  await checkSaved(projectOrderKey, keys());
  const last: HTMLElement = groups()[2];
  drag(last.querySelector('.project-grip')!, groups()[0], new DataTransfer());
  check(groups()[0] === last, 'Project grip drag must reorder whole groups.');
  const movedProjects: string[] = keys();
  await checkSaved(projectOrderKey, movedProjects);
  for (const mode of ['name', 'attention', 'manual']) {
    sort(mode);
    check(same(keys(), movedProjects), 'Project order must remain independent of card sort mode.');
  }
  await refresh();
  check(same(keys(), movedProjects), 'Refresh must preserve moved project order.');
  passed.push('project keyboard and synthetic grip moves persist independently of card sort modes');

  const removedKey: string = movedProjects[1];
  const removedId: string = `project-test-${expectedKeys.indexOf(removedKey)}`;
  await install(rows.filter((row: AgentRow): boolean => row.projectId !== removedId));
  check(same(keys(), movedProjects.filter((key: string): boolean => key !== removedKey)), 'Removing a project must preserve survivor order.');
  await install(rows);
  check(same(keys(), movedProjects), 'Reappearing project must recover its saved position.');
  passed.push('removed projects retain their position when they reappear');

  const removed: HTMLElement = groups()[0];
  const target: HTMLElement = groups()[1];
  const grip: HTMLElement = removed.querySelector('.project-grip')!;
  const transfer: DataTransfer = new DataTransfer();
  grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: target.getBoundingClientRect().top + 1 }));
  check(document.querySelector('.drop-before, .drop-after') !== null, 'Project drag must establish a visible drop target.');
  const draggedId: string = `project-test-${expectedKeys.indexOf(removed.dataset.orderKey!)}`;
  await install(rows.filter((row: AgentRow): boolean => row.projectId !== draggedId));
  check(document.querySelector('.drop-before, .drop-after, .dragging') === null, 'Removing dragged project must clear drag markers.');
  const survivors: string[] = keys();
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  check(same(keys(), survivors), 'Late drop from a removed project must not move survivors.');
  await install(rows);
  check(same(keys(), movedProjects), 'Cancelled project drag must not corrupt saved order.');
  await checkSaved(projectOrderKey, movedProjects);
  passed.push('removing a dragged project clears markers and rejects its late drop');

  const sourceGroup: HTMLElement = groups()[0];
  const destination: HTMLElement = groups()[1];
  const focusedCard: HTMLElement = cards(sourceGroup)[0];
  const focusedTitle: string = focusedCard.querySelector('h2')!.textContent!;
  const movingRow: AgentRow = rows.find((row: AgentRow): boolean => row.title === focusedTitle)!;
  const previousProjectId: string = movingRow.projectId;
  const previousProjectName: string = movingRow.projectName;
  const destinationRow: AgentRow = rows.find((row: AgentRow): boolean => row.title === cards(destination)[0].querySelector('h2')!.textContent)!;
  const control: HTMLButtonElement = focusedCard.querySelector('.species-picker')!;
  control.focus();
  movingRow.projectId = destinationRow.projectId;
  movingRow.projectName = destinationRow.projectName;
  await refresh();
  check(document.activeElement === control && destination.contains(focusedCard), 'Repository metadata updates must move the existing card without losing keyboard focus.');
  movingRow.projectId = previousProjectId;
  movingRow.projectName = previousProjectName;
  await refresh();
  destination.querySelector<HTMLButtonElement>('.project-toggle')!.click();
  control.focus();
  movingRow.projectId = destinationRow.projectId;
  movingRow.projectName = destinationRow.projectName;
  await refresh();
  check(document.activeElement === destination.querySelector('.project-toggle'), 'Moving a focused agent into a collapsed project must focus that project heading.');
  movingRow.projectId = previousProjectId;
  movingRow.projectName = previousProjectName;
  await refresh();
  destination.querySelector<HTMLButtonElement>('.project-toggle')!.click();
  passed.push('project membership updates preserve keyboard focus and respect collapsed destinations');
  return passed;
}

export async function verifyReload(): Promise<string> {
  await until((): boolean => fixture.agents.length > 0 && !(document.getElementById('refresh') as HTMLButtonElement).disabled);
  const stored: string[] = await saved(projectOrderKey);
  await install(customRows());
  const live: string[] = keys();
  const expected: string[] = stored.filter((key: string): boolean => live.includes(key));
  check(expected.length === 3 && same(live, expected), 'Reload must restore saved custom project order.');
  await refresh();
  check(same(keys(), expected), 'Refresh after reload must retain saved project order.');
  return 'reload restores saved project order after reinstalling the matching custom fixture';
}

export async function verifyPartialReadFailure(): Promise<string> {
  const failedKey: string | null = new URL(location.href).searchParams.get('fail-order-read');
  check(failedKey === projectOrderKey || failedKey === cardOrderKey, 'Use a fail-order-read preview URL for this test.');
  await until((): boolean => document.querySelectorAll('.agent-card').length === 4);
  const persisted: Map<string, unknown> = new Map(JSON.parse(sessionStorage.getItem('pokemon-preview-storage') ?? '[]'));
  const original: unknown = persisted.get(failedKey);
  await install(customRows());
  sort('manual');
  const readableKey: string = failedKey === cardOrderKey ? projectOrderKey : cardOrderKey;
  const readableOrder: unknown = persisted.get(readableKey);
  if (Array.isArray(readableOrder)) {
    const sequences: string[][] = readableKey === cardOrderKey ? groups().map((group: HTMLElement): string[] => keys(cards(group))) : [keys()];
    for (const sequence of sequences) {
      check(same(sequence.filter((key: string): boolean => readableOrder.includes(key)), readableOrder.filter((key: unknown): boolean => typeof key === 'string' && sequence.includes(key))), 'A successful order read must not be discarded because the other order read failed.');
    }
  }
  if (failedKey === cardOrderKey) groups()[0].querySelector<HTMLButtonElement>('.project-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  else cards(groups()[0])[0].querySelector<HTMLButtonElement>('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  await new Promise<number>(requestAnimationFrame);
  await new Promise<number>(requestAnimationFrame);
  const after: Map<string, unknown> = new Map(JSON.parse(sessionStorage.getItem('pokemon-preview-storage') ?? '[]'));
  check(same(after.get(failedKey), original), 'Moving one order must not overwrite a different order whose initial read failed.');
  check(document.getElementById('error')!.textContent!.includes('Could not load saved'), 'Unresolved load failures must remain visible after unrelated successful saves.');
  return `${failedKey} load failure preserves its saved value during unrelated moves`;
}
