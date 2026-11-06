import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentState, choiceKey, defaultPokemon, rosterFromCli, terminalHandle, type Roster } from './model.ts';

import { fixture } from './test/fixture.ts';

test('roster keeps only proven live agents and does not copy conversation content', (): void => {
  const roster: Roster = rosterFromCli(fixture());
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.agents[0].title, '<script>hostile</script>');
  assert.equal(roster.agents[0].state, 'working');
  assert.equal(roster.partial, false);
  assert.deepEqual(Object.keys(roster.agents[0]).sort(), ['agent', 'id', 'paneKey', 'state', 'title', 'workspace', 'workspaceId']);
});

test('unknown state is never represented as done or successful', (): void => {
  assert.equal(agentState('new-state'), 'unknown');
  assert.equal(agentState('done'), 'done');
});

test('truncation and omitted hosts make the roster partial', (): void => {
  const input: Record<string, unknown> = fixture() as Record<string, unknown>;
  assert.equal(rosterFromCli({ ...input, truncated: true }).partial, true);
  assert.equal(rosterFromCli({ ...input, hostScope: { omittedHostIds: ['remote'] } }).partial, true);
});

test('invalid CLI responses fail visibly', (): void => {
  for (const input of [null, [], {}, { worktrees: [{}] }]) assert.throws((): Roster => rosterFromCli(input));
});

test('focus joins exact workspace and pane to a runtime terminal handle', (): void => {
  const roster: Roster = rosterFromCli(fixture());
  const terminal: Record<string, unknown> = { worktreeId: 'project::/project', tabId: 'tab', leafId: 'pane', handle: 'term_fresh', orphaned: false };
  assert.equal(terminalHandle({ terminals: [terminal], truncated: false }, roster.agents[0]), 'term_fresh');
  for (const result of [
    { terminals: [] },
    { terminals: [terminal], truncated: true },
    { terminals: [terminal, terminal] },
    { terminals: [{ ...terminal, orphaned: true }] },
    { terminals: [{ ...terminal, worktreeId: 'other' }] },
    { terminals: [{ ...terminal, handle: '--enter' }] }
  ]) assert.throws((): string => terminalHandle(result, roster.agents[0]));
});

test('species assignment is deterministic and keys remain bounded for long workspace paths', async (): Promise<void> => {
  assert.equal(defaultPokemon('agent', 12), defaultPokemon('agent', 12));
  assert.ok(defaultPokemon('🐉agent', 12) >= 0 && defaultPokemon('🐉agent', 12) < 12);
  assert.notEqual(await choiceKey('workspace-a:pane'), await choiceKey('workspace-b:pane'));
  assert.equal((await choiceKey('workspace/'.repeat(1000))).length, 75);
  assert.equal(await choiceKey('agent'), await choiceKey('agent'));
});
