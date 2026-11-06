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
    assert.equal(calls.length, closed ? 2 : 3);
  }
});

test('simultaneous roster requests share a single CLI query', async (): Promise<void> => {
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  let count: number = 0;
  registerPanel({ panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); } } }, async (): Promise<unknown> => { count++; return fixture(); });
  await Promise.all([handlers.get('roster')!(null), handlers.get('roster')!(null)]);
  assert.equal(count, 1);
});
