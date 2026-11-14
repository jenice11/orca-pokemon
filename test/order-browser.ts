import type { AgentRow } from '../model.ts';

declare const fixture: {
  agents: AgentRow[];
  failStorage: boolean;
  calls: { name?: string; method?: string; params?: { key: string } }[];
  emit(event: string, payload: unknown): void;
};
declare const orca: { host: { call(method: string, params: unknown): Promise<unknown> } };

const orderKey: string = 'cards.order.v1';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(condition: () => boolean): Promise<void> {
  for (let frame: number = 0; frame < 150; frame++) {
    if (condition()) return;
    await new Promise<number>(requestAnimationFrame);
  }
  throw new Error('Ordering test did not settle within 150 frames.');
}

function cards(): HTMLElement[] { return Array.from(document.querySelectorAll<HTMLElement>('.agent-card')); }
function keys(): string[] { return cards().map((card: HTMLElement): string => card.dataset.orderKey!); }
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

async function saved(): Promise<string[]> {
  const result: unknown = await orca.host.call('storage.get', { key: orderKey });
  check(result !== null && typeof result === 'object' && 'value' in result && Array.isArray(result.value), 'Manual order must be stored as an array.');
  return result.value as string[];
}

export async function run(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'Ordering tests require the mock preview.');
  const passed: string[] = [];
  await until((): boolean => cards().length === 4 && !document.querySelector<HTMLButtonElement>('.drag-grip')!.disabled);
  sort('manual');
  const original: string[] = keys();
  check(JSON.stringify((await saved()).filter((key: string): boolean => original.includes(key))) === JSON.stringify(original), 'Discovery order must be persisted before any manual move.');
  const first: HTMLElement = cards()[0];
  check(!first.querySelector('.move-up, .move-down'), 'Agent card must not contain move buttons.');
  const down: HTMLButtonElement = first.querySelector('.drag-grip')!;
  down.focus();
  down.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  check(cards()[1] === first && document.activeElement === down, 'Keyboard move must change DOM order and retain focus.');
  down.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
  check(cards()[0] === first && document.activeElement === down, 'Arrow Up must move the card back and retain focus.');
  down.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  const moved: string[] = keys();
  await until((): boolean => fixture.calls.some((call): boolean => call.method === 'storage.set' && call.params?.key === orderKey));
  check(JSON.stringify((await saved()).filter((key: string): boolean => moved.includes(key))) === JSON.stringify(moved), 'Manual order must be saved using hashed identities.');
  await refresh();
  check(JSON.stringify(keys()) === JSON.stringify(moved), 'Refresh must preserve manual order.');
  fixture.agents.reverse();
  await refresh();
  check(JSON.stringify(keys()) === JSON.stringify(moved), 'Discovery order changes must not override manual order.');
  passed.push('keyboard moves preserve focus and saved manual order across refreshes');

  const newcomer: AgentRow = { ...fixture.agents[0], id: 'order-new-agent', paneKey: 'tab:order-new', title: 'New agent' };
  fixture.agents.push(newcomer);
  await refresh();
  check(cards()[cards().length - 1].querySelector('h2')!.textContent === 'New agent', 'New agents must append to manual order.');
  fixture.agents.pop();
  await refresh();
  check(JSON.stringify(keys()) === JSON.stringify(moved), 'Removing an agent must preserve survivor order.');

  sort('attention');
  check(cards()[0].dataset.state === 'blocked', 'Needs attention first must put blocked agents first.');
  check(cards().every((card: HTMLElement): boolean => card.querySelector<HTMLButtonElement>('.drag-grip')!.disabled), 'Derived sorts must disable manual drag.');
  const sortedBeforeStatus: string[] = keys();
  const update: AgentRow = fixture.agents.find((row: AgentRow): boolean => row.state === 'done')!;
  const rosterCalls: number = fixture.calls.filter((call): boolean => call.name === 'roster').length;
  update.state = 'blocked';
  fixture.emit('agent.status.changed', { paneKey: update.paneKey, state: 'blocked' });
  await until((): boolean => fixture.calls.filter((call): boolean => call.name === 'roster').length > rosterCalls);
  await until((): boolean => !(document.getElementById('refresh') as HTMLButtonElement).disabled);
  check(JSON.stringify(keys()) === JSON.stringify(sortedBeforeStatus), 'Status events and automatic refresh must not move cards.');
  sort('name');
  const names: string[] = cards().map((card: HTMLElement): string => card.querySelector('h2')!.textContent!);
  check(JSON.stringify(names) === JSON.stringify([...names].sort((left: string, right: string): number => left.localeCompare(right))), 'Name sort must use displayed agent titles.');
  sort('manual');
  check(JSON.stringify(keys()) === JSON.stringify(moved), 'Returning to Manual must restore the saved sequence.');
  passed.push('new agents append and derived sorts never overwrite or automatically reshuffle manual order');

  const source: HTMLElement = cards()[cards().length - 1];
  const target: HTMLElement = cards()[0];
  const transfer: DataTransfer = new DataTransfer();
  const focusCalls: number = fixture.calls.filter((call): boolean => call.name === 'focus').length;
  source.querySelector('.drag-grip')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: target.getBoundingClientRect().top + 1 }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: target.getBoundingClientRect().top + 1 }));
  source.querySelector('.drag-grip')!.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  check(cards()[0] === source, 'Header drag must move the existing card before its target.');
  check(fixture.calls.filter((call): boolean => call.name === 'focus').length === focusCalls, 'Rearranging must not focus the agent terminal.');
  const draggedOrder: string[] = keys();
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  check(JSON.stringify(keys()) === JSON.stringify(draggedOrder), 'External drops must not reorder agents.');
  check(document.getElementById('order-announcement')!.textContent!.includes('position 1'), 'Moves must be announced to screen readers.');
  passed.push('grip drag reorders cards without triggering focus and rejects external drops');

  fixture.failStorage = true;
  source.querySelector<HTMLButtonElement>('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  await until((): boolean => document.getElementById('error')!.textContent!.includes('could not be saved'));
  const unsavedOrder: string[] = keys();
  await refresh();
  check(JSON.stringify(keys()) === JSON.stringify(unsavedOrder) && !document.getElementById('error')!.hidden, 'Failed saves must preserve local order and remain visible after refresh.');
  fixture.failStorage = false;
  source.querySelector<HTMLButtonElement>('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  await until((): boolean => !document.getElementById('error')!.textContent!.includes('could not be saved'));
  check(JSON.stringify(keys()) !== JSON.stringify(original), 'Ordering checks must exercise a non-default sequence.');
  passed.push('save failures preserve local changes and support retry');
  return passed;
}

export async function verifyReload(): Promise<string> {
  await until((): boolean => cards().length === 4 && !document.querySelector<HTMLButtonElement>('.drag-grip')!.disabled);
  const current: string[] = keys();
  const expected: string[] = (await saved()).filter((key: string): boolean => current.includes(key));
  check(JSON.stringify(current) === JSON.stringify(expected), 'Reload must restore saved manual order.');
  return 'reload restores saved manual agent order';
}

export async function runRaces(): Promise<string[]> {
  await until((): boolean => cards().length === 4 && !document.querySelector<HTMLButtonElement>('.drag-grip')!.disabled);
  sort('manual');
  await new Promise<number>(requestAnimationFrame);
  const passed: string[] = [];
  const call: typeof orca.host.call = orca.host.call;
  let releaseWrite: (() => void) | undefined;
  let writes: number = 0;
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.set' && (params as { key: string }).key === orderKey) {
      writes++;
      if (writes === 1) await new Promise<void>((resolve): void => { releaseWrite = resolve; });
    }
    return call(method, params);
  };
  try {
    const source: HTMLElement = cards()[0];
    source.querySelector<HTMLButtonElement>('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    source.querySelector<HTMLButtonElement>('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    check(writes === 1 && releaseWrite !== undefined, 'Rapid moves must not write concurrently.');
    const latest: string[] = keys();
    releaseWrite();
    await until((): boolean => writes === 2);
    await new Promise<number>(requestAnimationFrame);
    check(JSON.stringify((await saved()).filter((key: string): boolean => latest.includes(key))) === JSON.stringify(latest), 'Serialized saves must finish with the newest order.');
    passed.push('rapid moves serialize storage writes and persist the newest order');
  } finally { orca.host.call = call; }

  let releaseRead: ((value: unknown) => void) | undefined;
  let delayedRead: boolean = false;
  const stale: string[] = [...keys()].reverse();
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.get' && (params as { key: string }).key === orderKey && !delayedRead) {
      delayedRead = true;
      return new Promise<unknown>((resolve): void => { releaseRead = resolve; });
    }
    return call(method, params);
  };
  try {
    await call('storage.set', { key: orderKey, value: stale });
    await until((): boolean => releaseRead !== undefined);
    cards()[0].querySelector<HTMLButtonElement>('.drag-grip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    const local: string[] = keys();
    releaseRead!({ value: stale });
    await new Promise<number>(requestAnimationFrame);
    check(JSON.stringify(keys()) === JSON.stringify(local), 'Late external reads must not overwrite a newer local move.');
    passed.push('late storage reads cannot overwrite newer manual changes');
  } finally { orca.host.call = call; }

  releaseRead = undefined;
  delayedRead = false;
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.get' && (params as { key: string }).key === orderKey && !delayedRead) {
      delayedRead = true;
      return new Promise<unknown>((resolve): void => { releaseRead = resolve; });
    }
    return call(method, params);
  };
  try {
    const beforeRead: string[] = keys();
    const externalRead: string[] = [...beforeRead].reverse();
    await call('storage.set', { key: orderKey, value: externalRead });
    await until((): boolean => releaseRead !== undefined);
    const active: HTMLElement = cards()[0];
    const activeTransfer: DataTransfer = new DataTransfer();
    active.querySelector('.drag-grip')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: activeTransfer }));
    releaseRead!({ value: externalRead });
    await new Promise<number>(requestAnimationFrame);
    check(JSON.stringify(keys()) === JSON.stringify(beforeRead), 'A storage read started before dragging must not reorder an active drag.');
    active.querySelector('.drag-grip')!.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: activeTransfer }));
    await until((): boolean => JSON.stringify(keys()) === JSON.stringify(externalRead));
    passed.push('storage reads already in flight also wait for an active drag to finish');
  } finally { orca.host.call = call; }

  const source: HTMLElement = cards()[0];
  const transfer: DataTransfer = new DataTransfer();
  source.querySelector('.drag-grip')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  const before: string[] = keys();
  const external: string[] = [...before].reverse();
  await call('storage.set', { key: orderKey, value: external });
  check(JSON.stringify(keys()) === JSON.stringify(before), 'An external order change must not interrupt an active drag.');
  source.querySelector('.drag-grip')!.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  await until((): boolean => JSON.stringify(keys()) === JSON.stringify(external));
  passed.push('cancelled drags reconcile deferred external order changes');

  const removed: HTMLElement = cards()[0];
  const target: HTMLElement = cards()[1];
  const removedTitle: string = removed.querySelector('h2')!.textContent!;
  const originalAgents: AgentRow[] = fixture.agents;
  removed.querySelector('.drag-grip')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: target.getBoundingClientRect().top + 1 }));
  check(target.classList.contains('drop-before'), 'Drag test must establish a visible drop target.');
  fixture.agents = fixture.agents.filter((row: AgentRow): boolean => row.title !== removedTitle);
  await refresh();
  check(document.querySelector('.drop-before, .drop-after, .dragging') === null, 'Removing a dragged agent must clear all drag markers.');
  fixture.agents = originalAgents;
  await refresh();
  passed.push('removing a dragged agent cancels the drag and clears drop markers');
  return passed;
}
