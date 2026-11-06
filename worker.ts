import { callCli } from './cli.ts';
import { record, rosterFromCli, terminalHandle, type AgentRow, type Roster } from './model.ts';

// Local structural contract: this Orca build's `plugin types` command lacks its packaged declarations.
export interface WorkerApi {
  panels: {
    handle(name: string, handler: (input: unknown) => Promise<unknown>): unknown;
  };
}

export function registerPanel(orca: WorkerApi, run: typeof callCli): void {
  let current: Roster = { agents: [], partial: false };
  let pending: Promise<Roster> | null = null;
  orca.panels.handle('roster', async (): Promise<Roster> => {
    if (pending) return pending;
    pending = (async (): Promise<Roster> => {
      const next: Roster = rosterFromCli(await run(['worktree', 'ps', '--limit', '10000']));
      current = next;
      return next;
    })();
    try { return await pending; }
    finally { pending = null; }
  });
  orca.panels.handle('focus', async (input: unknown): Promise<{ focused: true }> => {
    const data: Record<string, unknown> = record(input);
    const row: AgentRow | undefined = current.agents.find((agent: AgentRow): boolean => agent.id === data.id);
    if (!row) throw new Error('Unknown agent. Refresh the panel before focusing.');
    const terminals: unknown = await run(['terminal', 'list', '--worktree', `id:${row.workspaceId}`, '--limit', '10000']);
    const handle: string = terminalHandle(terminals, row);
    const result: Record<string, unknown> = record(await run(['terminal', 'switch', '--terminal', handle]));
    const focus: Record<string, unknown> = record(result.focus ?? {});
    if (focus.navigated !== true || focus.handle !== handle) {
      throw new Error('Orca could not focus the agent in this window.');
    }
    return { focused: true };
  });
}

export default function activate(orca: WorkerApi): void {
  registerPanel(orca, callCli);
}
