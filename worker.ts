import { callCli } from './cli.ts';
import { record, rosterFromCli, terminalHandle, type AgentRow, type Roster } from './model.ts';
import { AudioCapture } from './audio-capture.ts';
import { audioSession, audioStartRequest, type AudioCapabilities, type AudioFrame, type AudioStartRequest, type AudioStatus } from './audio-protocol.ts';

// Local structural contract: this Orca build's `plugin types` command lacks its packaged declarations.
export interface WorkerApi {
  panels: {
    handle(name: string, handler: (input: unknown) => Promise<unknown>): unknown;
  };
}

export function registerPanel(orca: WorkerApi, run: typeof callCli): void {
  let current: Roster = { agents: [], partial: false };
  let rosterQueue: Promise<void> = Promise.resolve();
  let focusQueue: Promise<void> = Promise.resolve();
  orca.panels.handle('roster', async (): Promise<Roster> => {
    const query: Promise<Roster> = rosterQueue.then(async (): Promise<Roster> => {
      const next: Roster = rosterFromCli(await run(['worktree', 'ps', '--limit', '10000']));
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
