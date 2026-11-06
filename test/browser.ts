import type { AgentRow, Roster } from '../model.ts';

interface Fixture {
  agents: AgentRow[];
  failStorage: boolean;
  failRoster: boolean;
  calls: { name?: string; method?: string; params?: { key: string } }[];
  emit(event: string, payload: unknown): void;
}

declare const fixture: Fixture;
declare const orca: {
  plugin: { request(name: string, input?: unknown): Promise<unknown> };
  host: { call(method: string, params: unknown): Promise<unknown> };
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(condition: () => boolean): Promise<void> {
  for (let frame: number = 0; frame < 120; frame++) {
    if (condition()) return;
    await new Promise<number>(requestAnimationFrame);
  }
  throw new Error('Browser test did not settle within 120 frames.');
}

function button(id: string): HTMLButtonElement { return document.getElementById(id) as HTMLButtonElement; }
function select(): HTMLSelectElement { return document.querySelector('select')!; }
function firstCard(): HTMLElement { return document.querySelector('.agent-card')!; }
async function refresh(): Promise<void> {
  await until((): boolean => !button('refresh').disabled);
  button('refresh').click();
  await until((): boolean => !button('refresh').disabled);
}

export async function run(): Promise<string[]> {
  const passed: string[] = [];
  await until((): boolean => document.querySelectorAll('.agent-card').length === 4 && !select().disabled);
  check(document.getAnimations().length >= 4, 'Sprite and status animations must run.');
  check(document.documentElement.scrollWidth <= innerWidth, 'Panel must not overflow horizontally.');
  passed.push('four states render with animations and no horizontal overflow');

  select().value = '25';
  select().dispatchEvent(new Event('change'));
  await until((): boolean => !select().disabled);
  await refresh();
  check(select().value === '25', 'Species choice must survive refresh.');
  check(fixture.calls.filter((call): boolean => call.method === 'storage.set').every((call): boolean => call.params!.key.length <= 256), 'Storage keys must be bounded.');
  (document.querySelector('.habitat') as HTMLButtonElement).click();
  await until((): boolean => !(document.querySelector('.habitat') as HTMLButtonElement).disabled);
  check(fixture.calls.some((call): boolean => call.name === 'focus'), 'Sprite click must request focus.');
  passed.push('species persistence and click-to-focus bridge');

  button('motion').click();
  check(document.body.classList.contains('paused'), 'Pause must stop motion.');
  check(document.getAnimations().length === 0, 'Pause must cancel sprite and CSS animations.');
  button('motion').click();
  passed.push('pause and resume all motion');

  const request: typeof orca.plugin.request = orca.plugin.request;
  let resolveRoster: ((roster: Roster) => void) | undefined;
  const oldRoster: Roster = { agents: fixture.agents.map((agent: AgentRow): AgentRow => ({ ...agent })), partial: false };
  orca.plugin.request = async (name: string, input?: unknown): Promise<unknown> => {
    if (name === 'roster' && !resolveRoster) return new Promise<Roster>((resolve): void => { resolveRoster = resolve; });
    return request(name, input);
  };
  button('refresh').click();
  await until((): boolean => resolveRoster !== undefined);
  fixture.agents[0].state = 'blocked';
  fixture.emit('agent.status.changed', { paneKey: 'tab:0', state: 'blocked' });
  resolveRoster!(oldRoster);
  await until((): boolean => !button('refresh').disabled);
  check(firstCard().dataset.state === 'blocked', 'Late roster must not overwrite a newer status event.');
  orca.plugin.request = request;
  passed.push('newer status wins over a deferred roster response');

  fixture.failStorage = true;
  select().value = '133';
  select().dispatchEvent(new Event('change'));
  await until((): boolean => !select().disabled);
  await refresh();
  check(!document.getElementById('error')!.hidden, 'Roster refresh must not hide save failure.');
  check(select().value === '25', 'Failed save must restore previous choice.');
  fixture.failStorage = false;
  passed.push('save failure remains visible after successful roster refresh');

  fixture.failRoster = true;
  await refresh();
  fixture.emit('agent.status.changed', { paneKey: 'tab:0', state: 'working' });
  check(document.getElementById('summary')!.textContent!.includes('stale'), 'Status event must not hide stale roster.');
  fixture.failRoster = false;
  await refresh();
  passed.push('failed roster remains stale during live events');

  const call: typeof orca.host.call = orca.host.call;
  let resolveChoice: ((value: unknown) => void) | undefined;
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.get') return new Promise<unknown>((resolve): void => { resolveChoice = resolve; });
    return call(method, params);
  };
  fixture.agents.push({ ...fixture.agents[0], id: 'late-choice', paneKey: 'tab:late' });
  await refresh();
  await until((): boolean => resolveChoice !== undefined);
  const removed: HTMLElement = document.querySelector('.agent-card:last-child .sprite')!;
  fixture.agents.pop();
  await refresh();
  resolveChoice!({ value: 25 });
  await new Promise<number>(requestAnimationFrame);
  check(!removed.isConnected && removed.getAnimations().length === 0, 'Removed sprite must not restart after late storage read.');
  orca.host.call = call;
  passed.push('late storage response cannot revive removed sprite animations');

  fixture.agents = [];
  await refresh();
  check(!document.getElementById('empty')!.hidden && document.querySelectorAll('.agent-card').length === 0, 'Empty crew must show empty state.');
  passed.push('empty roster removes old cards');
  return passed;
}
