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
  assert.equal(roster.agents[0].projectName, 'project');
  assert.equal(roster.agents[0].projectId, JSON.stringify(['local', 'repo', 'project-repo']));
  assert.equal(roster.agents[0].id, JSON.stringify(['project::/project', 'tab:pane']));
  assert.deepEqual(Object.keys(roster.agents[0]).sort(), ['agent', 'id', 'paneKey', 'projectId', 'projectName', 'state', 'title', 'workspace', 'workspaceId']);
});

test('project identity joins worktrees by repo ID, never by display or repo name', (): void => {
  const workspace: Record<string, unknown> = {
    worktreeId: 'first', displayName: 'First branch', repo: 'shared-name', repoId: 'repo-a', hostId: 'host-a',
    agents: [{ paneKey: 'tab:pane', hasLivePty: true }]
  };
  const roster: Roster = rosterFromCli({
    worktrees: [workspace, { ...workspace, worktreeId: 'second', displayName: 'Second branch' },
      { ...workspace, worktreeId: 'third', repoId: 'repo-b' },
      { ...workspace, worktreeId: 'fourth', hostId: 'host-b' },
      { ...workspace, worktreeId: 'fifth', hostId: 'transport', identity: { executionHostId: 'host-a' } }],
    hostScope: {}
  });
  assert.equal(roster.agents[0].projectId, JSON.stringify(['host-a', 'repo', 'repo-a']));
  assert.equal(roster.agents[0].projectId, roster.agents[1].projectId);
  assert.notEqual(roster.agents[0].id, roster.agents[1].id);
  assert.notEqual(roster.agents[0].projectId, roster.agents[2].projectId);
  assert.notEqual(roster.agents[0].projectId, roster.agents[3].projectId);
  assert.equal(roster.agents[0].projectId, roster.agents[4].projectId);
  assert.equal(roster.agents[1].projectName, 'shared-name');
  assert.equal(roster.agents[1].workspace, 'Second branch');
});

test('legacy and malformed metadata use host-qualified workspace fallbacks', (): void => {
  const workspace: Record<string, unknown> = {
    worktreeId: 'first', displayName: 'Same name', agents: [{ paneKey: 'tab:pane', hasLivePty: true }]
  };
  const roster: Roster = rosterFromCli({
    worktrees: [workspace, { ...workspace, worktreeId: 'second' },
      { ...workspace, repoId: 'first' },
      { ...workspace, repoId: 42, repo: null, hostId: 'remote', identity: { executionHostId: 42 } },
      { ...workspace, displayName: null, hostId: 42, identity: [] },
      { ...workspace, repoId: '', repo: '', hostId: '', identity: { executionHostId: '' } }],
    hostScope: {}
  });
  assert.equal(roster.agents[0].projectId, JSON.stringify(['local', 'workspace', 'first']));
  assert.notEqual(roster.agents[0].projectId, roster.agents[1].projectId);
  assert.notEqual(roster.agents[0].projectId, roster.agents[2].projectId);
  assert.equal(roster.agents[3].projectId, JSON.stringify(['remote', 'workspace', 'first']));
  assert.equal(roster.agents[3].projectName, 'Same name');
  assert.equal(roster.agents[4].projectId, roster.agents[0].projectId);
  assert.equal(roster.agents[4].projectName, 'Workspace');
  assert.equal(roster.agents[5].projectId, roster.agents[0].projectId);
  assert.equal(roster.agents[5].projectName, 'Same name');
});

test('unknown state is never represented as done or successful', (): void => {
  assert.equal(agentState('new-state'), 'unknown');
  assert.equal(agentState('done'), 'done');
});

test('resumed Copilot sessions with a live terminal remain in the roster', (): void => {
  const roster: Roster = rosterFromCli({
    worktrees: [{
      worktreeId: 'resumed-workspace', displayName: 'Resumed', repo: 'project', repoId: 'project-repo',
      hostId: 'local',
      agents: [{
        paneKey: 'tab:pane', agentType: 'copilot',
        conversationName: 'Resumed Copilot session', state: 'waiting'
      }]
    }],
    hostScope: {}
  }, [{ worktreeId: 'resumed-workspace', paneKey: 'tab:pane', title: 'Resumed Copilot session', agent: 'copilot', state: 'working' }]);
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.agents[0].agent, 'copilot');
  assert.equal(roster.agents[0].paneKey, 'tab:pane');
});

test('resumed workspaces synthesize an agent from a live terminal identity', (): void => {
  const roster: Roster = rosterFromCli({
    worktrees: [{
      worktreeId: 'resumed-workspace', displayName: 'Resumed', repo: 'project',
      repoId: 'project-repo', hostId: 'local', agents: []
    }],
    hostScope: {}
  }, [{
    worktreeId: 'resumed-workspace',
    paneKey: 'resumed-tab:resumed-pane',
    title: 'Update Spotify Capture - GitHub Copilot',
    agent: 'copilot',
    state: 'working'
  }]);
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.agents[0].agent, 'copilot');
  assert.equal(roster.agents[0].state, 'working');
  assert.equal(roster.agents[0].title, 'Update Spotify Capture - GitHub Copilot');
});

test('live terminal status replaces unknown metadata for an existing resumed agent', (): void => {
  const roster: Roster = rosterFromCli({
    worktrees: [{
      worktreeId: 'resumed-workspace', displayName: 'Resumed', agents: [{
        paneKey: 'tab:pane', agentType: 'copilot', state: 'unknown', hasLivePty: false
      }]
    }],
    hostScope: {}
  }, [{ worktreeId: 'resumed-workspace', paneKey: 'tab:pane', title: 'Copilot', agent: 'copilot', state: 'waiting' }]);
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.agents[0].state, 'waiting');
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
