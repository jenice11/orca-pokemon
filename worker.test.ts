import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPanel, type WorkerApi } from './worker.ts';
import { rosterFromCli, type Roster } from './model.ts';
import { fixture } from './test/fixture.ts';

test('worker validates focus IDs and resolves a fresh handle before switching', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  const calls: string[][] = [];
  const api: WorkerApi = { panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } };
  registerPanel(api, async (args: readonly string[]): Promise<unknown> => {
    calls.push([...args]);
    if (args[0] === 'worktree') return fixture();
    if (args[1] === 'list') return { terminals: [{ worktreeId: 'project::/project', tabId: 'tab', leafId: 'pane', handle: 'term_fresh' }] };
    return { focus: { navigated: true, handle: 'term_fresh' } };
  });
  await assert.rejects(handlers.get('focus')!({ id: 'untrusted' }), /Unknown agent/);
  assert.equal(calls.length, 0);
  const roster: Roster = await handlers.get('roster')!(null) as Roster;
  assert.deepEqual(await handlers.get('focus')!({ id: roster.agents[0].id }), { focused: true });
  assert.deepEqual(calls, [
    ['worktree', 'ps', '--limit', '10000'],
    ['terminal', 'list', '--worktree', 'id:project::/project', '--limit', '10000'],
    ['terminal', 'list', '--worktree', 'id:project::/project', '--limit', '10000'],
    ['terminal', 'switch', '--terminal', 'term_fresh']
  ]);
});

test('closed terminal never triggers a switch; failed navigation is not success', async (): Promise<void> => {
  for (const closed of [true, false]) {
    const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
    const calls: string[][] = [];
    registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (args: readonly string[]): Promise<unknown> => {
      calls.push([...args]);
      if (args[0] === 'worktree') return fixture();
      if (args[1] === 'list') return { terminals: closed ? [] : [{ worktreeId: 'project::/project', tabId: 'tab', leafId: 'pane', handle: 'term_live' }] };
      return { focus: { navigated: false, handle: 'term_live' } };
    });
    await handlers.get('roster')!(null);
    await assert.rejects(handlers.get('focus')!({ id: rosterFromCli(fixture()).agents[0].id }));
    assert.equal(calls.length, closed ? 3 : 4);
  }
});

test('queued roster requests get fresh snapshots and recover after failures', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  let count: number = 0;
  let releaseFirst: ((value: unknown) => void) | undefined;
  registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (args: readonly string[]): Promise<unknown> => {
    if (args[0] === 'terminal') return { terminals: [] };
    count++;
    if (count === 1) return new Promise<unknown>((resolve): void => { releaseFirst = resolve; });
    if (count === 3) throw new Error('Roster unavailable');
    return {
      worktrees: [{ worktreeId: 'fresh-workspace', agents: [{ paneKey: 'tab:pane', state: 'blocked', hasLivePty: true }] }],
      hostScope: {}
    };
  });
  const first: Promise<unknown> = handlers.get('roster')!(null);
  await Promise.resolve();
  const second: Promise<unknown> = handlers.get('roster')!(null);
  assert.equal(count, 1);
  releaseFirst!(fixture());
  assert.equal((await first as Roster).agents[0].state, 'working');
  assert.equal((await second as Roster).agents[0].state, 'blocked', 'A later panel request must not inherit the older snapshot.');
  assert.equal(count, 2);
  await assert.rejects(handlers.get('roster')!(null), /Roster unavailable/);
  assert.equal((await handlers.get('roster')!(null) as Roster).agents[0].state, 'blocked');
});

test('focus requests switch in click order and recover after a failed request', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  const switches: string[] = [];
  let releaseFirst: ((value: unknown) => void) | undefined;
  let finishFirstSwitch: (() => void) | undefined;
  let lists: number = 0;
  registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (args: readonly string[]): Promise<unknown> => {
    if (args[0] === 'worktree') return {
      worktrees: [{ worktreeId: 'workspace', agents: ['A', 'B'].map((name: string): { paneKey: string; hasLivePty: boolean } => ({ paneKey: `tab:${name}`, hasLivePty: true })) }],
      hostScope: {}
    };
    if (args[1] === 'list') {
      lists++;
      if (lists === 1) return { terminals: [
        { worktreeId: 'workspace', tabId: 'tab', leafId: 'A', handle: 'term_A' },
        { worktreeId: 'workspace', tabId: 'tab', leafId: 'B', handle: 'term_B' }
      ] };
      if (lists === 2) return new Promise<unknown>((resolve): void => { releaseFirst = resolve; });
      if (lists === 4) throw new Error('Lookup failed');
      return { terminals: [{ worktreeId: 'workspace', tabId: 'tab', leafId: 'B', handle: 'term_B' }] };
    }
    switches.push(args[3]);
    if (args[3] === 'term_A') await new Promise<void>((resolve): void => { finishFirstSwitch = resolve; });
    return { focus: { navigated: true, handle: args[3] } };
  });
  const roster: Roster = await handlers.get('roster')!(null) as Roster;
  const first: Promise<unknown> = handlers.get('focus')!({ id: roster.agents[0].id });
  const second: Promise<unknown> = handlers.get('focus')!({ id: roster.agents[1].id });
  await Promise.resolve();
  assert.equal(lists, 2, 'A second lookup must wait for the earlier focus operation.');
  releaseFirst!({ terminals: [{ worktreeId: 'workspace', tabId: 'tab', leafId: 'A', handle: 'term_A' }] });
  for (let tick: number = 0; tick < 10 && !finishFirstSwitch; tick++) await Promise.resolve();
  assert.equal(lists, 2, 'The next lookup must also wait for the earlier switch to finish.');
  assert.deepEqual(switches, ['term_A']);
  assert.ok(finishFirstSwitch);
  finishFirstSwitch();
  await Promise.all([first, second]);
  assert.deepEqual(switches, ['term_A', 'term_B']);
  await assert.rejects(handlers.get('focus')!({ id: roster.agents[0].id }), /Lookup failed/);
  await handlers.get('focus')!({ id: roster.agents[1].id });
  assert.deepEqual(switches, ['term_A', 'term_B', 'term_B']);
});

test('roster looks up terminals at most four at a time', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  let running: number = 0;
  let peak: number = 0;
  registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (args: readonly string[]): Promise<unknown> => {
    if (args[0] === 'worktree') {
      return { worktrees: Array.from({ length: 10 }, (_: unknown, index: number): unknown => ({ worktreeId: `w${index}`, agents: [] })), hostScope: {} };
    }
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>((resolve): void => { setTimeout(resolve, 5); });
    running--;
    return { terminals: [] };
  });
  await handlers.get('roster')!(null);
  assert.equal(peak, 4);
});

test('terminal-only agents share a workspace state only when they are alone there', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  const terminal = (leafId: string): unknown => ({ worktreeId: 'w', tabId: 't', leafId, agentIdentity: 'codex', title: leafId });
  for (const [terminals, expected] of [[[terminal('a')], 'working'], [[terminal('a'), terminal('b')], 'unknown']] as const) {
    registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (args: readonly string[]): Promise<unknown> => {
      if (args[0] === 'worktree') return { worktrees: [{ worktreeId: 'w', status: 'working', agents: [] }], hostScope: {} };
      return { terminals };
    });
    const roster: Roster = await handlers.get('roster')!(null) as Roster;
    assert.deepEqual(roster.agents.map((agent): string => agent.state), terminals.map((): string => expected));
  }
});

test('roster reuses terminal lookups for an unchanged worktree until the cache expires or a refresh is forced', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  let terminalCalls: number = 0;
  let status: string = 'working';
  let clock: number = 1000;
  registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (args: readonly string[]): Promise<unknown> => {
    if (args[0] === 'worktree') return { worktrees: [{ worktreeId: 'w', status, agents: [] }], hostScope: {} };
    terminalCalls++;
    return { terminals: [] };
  }, (): number => clock);
  const roster = handlers.get('roster')!;
  await roster(null);
  await roster(null);
  assert.equal(terminalCalls, 1, 'an unchanged worktree must reuse its terminals');
  status = 'blocked';
  await roster(null);
  assert.equal(terminalCalls, 2, 'a status change must look terminals up again');
  await roster({ force: true });
  assert.equal(terminalCalls, 3, 'a forced refresh must bypass the cache');
  clock += 5001;
  await roster(null);
  assert.equal(terminalCalls, 4, 'cached terminals must expire');
});

test('roster explains why it is partial', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (args: readonly string[]): Promise<unknown> => {
    if (args[0] === 'worktree') return { worktrees: [{ worktreeId: 'w', status: 'working', agents: [] }], hostScope: {} };
    throw new Error('Orca CLI terminal failed (timeout).');
  });
  const roster: Roster = await handlers.get('roster')!(null) as Roster;
  assert.equal(roster.partial, true);
  assert.equal(roster.partialReason, 'Orca CLI terminal failed (timeout).');
});
