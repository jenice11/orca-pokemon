type AgentState = 'working' | 'blocked' | 'waiting' | 'done' | 'unknown';

export interface AgentRow {
  id: string;
  workspaceId: string;
  workspace: string;
  projectId: string;
  projectName: string;
  paneKey: string;
  title: string;
  agent: string;
  state: AgentState;
}

export interface Roster {
  agents: AgentRow[];
  partial: boolean;
  partialReason?: string;
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Orca returned an invalid object.');
  }
  return value as Record<string, unknown>;
}

export function agentState(value: unknown): AgentState {
  return value === 'working' || value === 'blocked' || value === 'waiting' || value === 'done'
    ? value : 'unknown';
}

export interface LiveAgentTerminal {
  worktreeId: string;
  paneKey: string;
  title: string;
  agent: string;
  state: AgentState;
}

export function rosterFromCli(value: unknown, liveAgentTerminals: readonly LiveAgentTerminal[] = [], terminalLookupPartial: boolean = false): Roster {
  const result: Record<string, unknown> = record(value);
  if (!Array.isArray(result.worktrees)) throw new Error('Orca did not return a workspace roster.');
  const agents: AgentRow[] = [];
  for (const rawWorkspace of result.worktrees as unknown[]) {
    const workspace: Record<string, unknown> = record(rawWorkspace);
    if (typeof workspace.worktreeId !== 'string' || !Array.isArray(workspace.agents)) {
      throw new Error('Orca returned an invalid workspace roster.');
    }
    const workspaceName: string = typeof workspace.displayName === 'string' ? workspace.displayName : 'Workspace';
    const identity: unknown = workspace.identity;
    const executionHostId: unknown = identity !== null && typeof identity === 'object' && !Array.isArray(identity)
      ? (identity as Record<string, unknown>).executionHostId : undefined;
    const hostId: string = typeof executionHostId === 'string' && executionHostId ? executionHostId
      : typeof workspace.hostId === 'string' && workspace.hostId ? workspace.hostId : 'local';
    const projectId: string = typeof workspace.repoId === 'string' && workspace.repoId
      ? JSON.stringify([hostId, 'repo', workspace.repoId])
      : JSON.stringify([hostId, 'workspace', workspace.worktreeId]);
    for (const rawAgent of workspace.agents as unknown[]) {
      const agent: Record<string, unknown> = record(rawAgent);
      // Only proven live PTYs: the CLI also returns historical agent records.
      if (typeof agent.paneKey !== 'string') continue;
      const liveFromTerminal: boolean = liveAgentTerminals.some((terminal: LiveAgentTerminal): boolean =>
        terminal.worktreeId === workspace.worktreeId && terminal.paneKey === agent.paneKey);
      if (agent.hasLivePty !== true && !liveFromTerminal) continue;
      const liveTerminal: LiveAgentTerminal | undefined = liveAgentTerminals.find((terminal: LiveAgentTerminal): boolean =>
        terminal.worktreeId === workspace.worktreeId && terminal.paneKey === agent.paneKey);
      const title: unknown = agent.conversationName ?? agent.displayName ?? agent.taskTitle;
      agents.push({
        id: JSON.stringify([workspace.worktreeId, agent.paneKey]),
        workspaceId: workspace.worktreeId,
        workspace: workspaceName,
        projectId,
        projectName: typeof workspace.repo === 'string' && workspace.repo ? workspace.repo : workspaceName,
        paneKey: agent.paneKey,
        title: typeof title === 'string' && title ? title : String(agent.agentType ?? 'Agent'),
        agent: typeof agent.agentType === 'string' ? agent.agentType : 'Agent',
        state: agentState(agent.state) === 'unknown' ? liveTerminal?.state ?? 'unknown' : agentState(agent.state)
      });
    }
    for (const terminal of liveAgentTerminals) {
      if (terminal.worktreeId !== workspace.worktreeId) continue;
      if (agents.some((agent: AgentRow): boolean =>
        agent.workspaceId === workspace.worktreeId && agent.paneKey === terminal.paneKey)) continue;
      agents.push({
        id: JSON.stringify([workspace.worktreeId, terminal.paneKey]),
        workspaceId: workspace.worktreeId,
        workspace: workspaceName,
        projectId,
        projectName: typeof workspace.repo === 'string' && workspace.repo ? workspace.repo : workspaceName,
        paneKey: terminal.paneKey,
        title: terminal.title,
        agent: terminal.agent,
        state: terminal.state
      });
    }
  }
  const scope: Record<string, unknown> = record(result.hostScope);
  return {
    agents,
    partial: result.truncated === true || terminalLookupPartial ||
      (Array.isArray(scope.omittedHostIds) && scope.omittedHostIds.length > 0)
  };
}

export function terminalHandle(value: unknown, row: AgentRow): string {
  const result: Record<string, unknown> = record(value);
  if (!Array.isArray(result.terminals) || result.truncated === true) {
    throw new Error('Orca returned an incomplete terminal list. Refresh and try again.');
  }
  const matches: Record<string, unknown>[] = (result.terminals as unknown[]).map(record).filter(
    (terminal: Record<string, unknown>): boolean => terminal.worktreeId === row.workspaceId &&
      `${terminal.tabId}:${terminal.leafId}` === row.paneKey && terminal.orphaned !== true
  );
  if (matches.length !== 1 || typeof matches[0].handle !== 'string' ||
      !/^term_[a-zA-Z0-9_-]+$/.test(matches[0].handle)) {
    throw new Error('This agent no longer has a unique live terminal. Refresh the panel.');
  }
  return matches[0].handle;
}

export async function choiceKey(id: string): Promise<string> {
  const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  const hex: string = [...new Uint8Array(digest)].map((byte: number): string => byte.toString(16).padStart(2, '0')).join('');
  return `pokemon.v1:${hex}`;
}

export function defaultPokemon(id: string, count: number): number {
  let hash: number = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % count;
}
