import { callCli } from './cli.ts';
import { agentState, record, rosterFromCli, terminalHandle, type AgentRow, type LiveAgentTerminal, type Roster } from './model.ts';
import { AudioCapture } from './audio-capture.ts';
import { audioSession, audioStartRequest, type AudioCapabilities, type AudioFrame, type AudioStartRequest, type AudioStatus } from './audio-protocol.ts';

// Local structural contract: this Orca build's `plugin types` command lacks its packaged declarations.
export interface WorkerApi {
  panels: {
    handle(name: string, handler: (input: unknown) => Promise<unknown>): unknown;
  };
}

interface CachedLookup {
  signature: string;
  at: number;
  found: LiveAgentTerminal[];
}

export function registerPanel(orca: WorkerApi, run: typeof callCli, now: () => number = Date.now): void {
  const lookupCache: Map<string, CachedLookup> = new Map();
  let current: Roster = { agents: [], partial: false };
  let rosterQueue: Promise<void> = Promise.resolve();
  let focusQueue: Promise<void> = Promise.resolve();
  orca.panels.handle('roster', async (input: unknown): Promise<Roster> => {
    const force: boolean = typeof input === 'object' && input !== null && (input as { force?: unknown }).force === true;
    const query: Promise<Roster> = rosterQueue.then(async (): Promise<Roster> => {
      const snapshot: unknown = await run(['worktree', 'ps', '--limit', '10000']);
      const result: Record<string, unknown> = record(snapshot);
      const worktrees: unknown[] = Array.isArray(result.worktrees) ? result.worktrees : [];
      const liveAgentTerminals: LiveAgentTerminal[] = [];
      let terminalLookupPartial: boolean = false;
      let terminalLookupFailure: string = '';
      const lookup: (rawWorkspace: unknown) => Promise<void> = async (rawWorkspace: unknown): Promise<void> => {
        const workspace: Record<string, unknown> = record(rawWorkspace);
        if (typeof workspace.worktreeId !== 'string') return;
        const workspaceState: ReturnType<typeof agentState> = agentState(workspace.status) !== 'unknown'
          ? agentState(workspace.status)
          : agentState(workspace.sidebarStatus) !== 'unknown'
            ? agentState(workspace.sidebarStatus)
            : 'waiting';
        try {
          const signature: string = JSON.stringify([workspace.status, workspace.sidebarStatus,
            Array.isArray(workspace.agents) ? workspace.agents.map((agent: unknown): unknown[] => {
              const item: Record<string, unknown> = record(agent);
              return [item.paneKey, item.state, item.hasLivePty];
            }) : null]);
          const cached: CachedLookup | undefined = lookupCache.get(workspace.worktreeId);
          if (!force && cached && cached.signature === signature && now() - cached.at < 5000) {
            // Same worktree status moments ago: reuse its terminals instead of starting another CLI process.
            for (const terminal of cached.found) liveAgentTerminals.push(cached.found.length === 1 ? { ...terminal, state: workspaceState } : terminal);
            return;
          }
          const terminalList: unknown = await run(['terminal', 'list', '--worktree', `id:${workspace.worktreeId}`, '--limit', '10000']);
          const terminalResult: Record<string, unknown> = record(terminalList);
          if (terminalResult.truncated === true || !Array.isArray(terminalResult.terminals)) {
            terminalLookupPartial = true;
            terminalLookupFailure ||= 'Orca returned a truncated terminal list.';
            return;
          }
          const found: LiveAgentTerminal[] = [];
          for (const rawTerminal of terminalResult.terminals as unknown[]) {
            const terminal: Record<string, unknown> = record(rawTerminal);
            if (terminal.orphaned === true || terminal.worktreeId !== workspace.worktreeId ||
                typeof terminal.tabId !== 'string' || typeof terminal.leafId !== 'string') continue;
            if (typeof terminal.agentIdentity !== 'string' || !terminal.agentIdentity.trim()) continue;
            found.push({
              worktreeId: workspace.worktreeId,
              paneKey: `${terminal.tabId}:${terminal.leafId}`,
              title: typeof terminal.title === 'string' && terminal.title ? terminal.title : 'Agent',
              agent: terminal.agentIdentity,
              state: workspaceState
            });
          }
          // One shared workspace status only describes a terminal when it is the sole agent there.
          const described: LiveAgentTerminal[] = found.map((terminal: LiveAgentTerminal): LiveAgentTerminal => found.length === 1 ? terminal : { ...terminal, state: 'unknown' });
          lookupCache.set(workspace.worktreeId, { signature, at: now(), found: described });
          liveAgentTerminals.push(...described);
        } catch (error: unknown) {
          terminalLookupPartial = true;
          terminalLookupFailure ||= error instanceof Error ? error.message : String(error);
        }
      };
      let nextWorkspace: number = 0;
      const lookups: Promise<void>[] = Array.from({ length: Math.min(4, worktrees.length) }, async (): Promise<void> => {
        while (nextWorkspace < worktrees.length) await lookup(worktrees[nextWorkspace++]);
      });
      await Promise.all(lookups);
      const present: Set<unknown> = new Set(worktrees.map((item: unknown): unknown => record(item).worktreeId));
      for (const id of lookupCache.keys()) if (!present.has(id)) lookupCache.delete(id);
      const next: Roster = rosterFromCli(snapshot, liveAgentTerminals, terminalLookupPartial);
      if (next.partial && terminalLookupFailure) next.partialReason = terminalLookupFailure.slice(0, 300);
      current = next;
      return next;
    });
    // Each refresh needs a snapshot started after its request, including across panels.
    rosterQueue = query.then((): void => {}, (): void => {});
    return query;
  });
  orca.panels.handle('focus', async (input: unknown): Promise<{ focused: true }> => {
    const data: Record<string, unknown> = record(input);
    const row: AgentRow | undefined = current.agents.find((agent: AgentRow): boolean => agent.id === data.id);
    if (!row) throw new Error('Unknown agent. Refresh the panel before focusing.');
    const operation: Promise<{ focused: true }> = focusQueue.then(async (): Promise<{ focused: true }> => {
      const terminals: unknown = await run(['terminal', 'list', '--worktree', `id:${row.workspaceId}`, '--limit', '10000']);
      const handle: string = terminalHandle(terminals, row);
      const result: Record<string, unknown> = record(await run(['terminal', 'switch', '--terminal', handle]));
      const focus: Record<string, unknown> = record(result.focus ?? {});
      if (focus.navigated !== true || focus.handle !== handle) {
        throw new Error('Orca could not focus the agent in this window.');
      }
      return { focused: true };
    });
    // A failed click must not block later clicks; its caller still receives the error.
    focusQueue = operation.then((): void => {}, (): void => {});
    return operation;
  });
}

export interface AudioWorkerApi {
  panels: {
    handle(name: string, handler: (input: unknown) => Promise<unknown>): unknown;
    post(event: string, payload: AudioStatus | AudioFrame): void | Promise<void>;
  };
}

export function registerAudio(orca: AudioWorkerApi, capture: AudioCapture): void {
  orca.panels.handle('audio.capabilities', async (): Promise<AudioCapabilities> => capture.capabilities());
  orca.panels.handle('audio.status', async (): Promise<AudioStatus> => capture.status());
  orca.panels.handle('audio.start', async (input: unknown): Promise<AudioStatus> => {
    const request: AudioStartRequest = audioStartRequest(input);
    return capture.start(request.session, request.scope);
  });
  orca.panels.handle('audio.stop', async (input: unknown): Promise<AudioStatus> => capture.stop(audioSession(input)));
  orca.panels.handle('audio.heartbeat', async (input: unknown): Promise<AudioStatus> => capture.heartbeat(audioSession(input)));
}

let activeCapture: AudioCapture | null = null;

function forceCaptureExit(): void { void activeCapture?.dispose(true); }

export async function deactivate(): Promise<void> {
  const capture: AudioCapture | null = activeCapture;
  await capture?.dispose();
  if (activeCapture === capture) activeCapture = null;
  process.off('exit', forceCaptureExit);
}

export default function activate(orca: WorkerApi & AudioWorkerApi): void {
  registerPanel(orca, callCli);
  activeCapture = new AudioCapture((event, payload): void | Promise<void> => orca.panels.post(event, payload));
  registerAudio(orca, activeCapture);
  process.once('exit', forceCaptureExit);
}
