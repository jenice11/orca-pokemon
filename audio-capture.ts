import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioFrame, type AudioCapabilities, type AudioCaptureScope, type AudioFrame, type AudioStatus } from './audio-protocol.ts';

type PublishAudio = (event: 'audio.status' | 'audio.frame', payload: AudioStatus | AudioFrame) => void | Promise<void>;
type LaunchAudio = (scope: AudioCaptureScope) => ChildProcessWithoutNullStreams;
const processLoopbackMinimumBuild: number = 20348;

export function supportsWindowsProcessLoopback(version: string): boolean {
  const [major, minor, build]: number[] = version.split('.').map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(build) &&
    (major > 10 || major === 10 && minor === 0 && build >= processLoopbackMinimumBuild);
}

function launchHelper(scope: AudioCaptureScope): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') {
    const powershell: string = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script: string = fileURLToPath(new URL('./native/SpotifyAudioHelper.Windows.ps1', import.meta.url));
    const mode: string = scope === 'spotify' ? '--capture-spotify' : '--capture-all-app';
    return spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-MTA', '-File', script, mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  const executable: string = fileURLToPath(new URL('./native/SpotifyAudioHelper.app/Contents/MacOS/SpotifyAudioHelper', import.meta.url));
  return spawn(executable, ['--capture-spotify'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

export class AudioCapture {
  private child: ChildProcessWithoutNullStreams | null = null;
  private current: AudioStatus = { state: 'off', message: 'Audio capture off.', session: null };
  private buffer: string = '';
  private lease: ReturnType<typeof setTimeout> | undefined;
  private startup: ReturnType<typeof setTimeout> | undefined;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private termination: ReturnType<typeof setTimeout> | undefined;
  private lastFrameAt: number = 0;
  private stderrTail: string = '';
  private disposed: boolean = false;
  private generation: number = 0;
  private framePostPending: boolean = false;
  private terminalPostPending: boolean = false;
  private readonly pendingPosts: Set<ReturnType<typeof setTimeout>> = new Set();
  private readonly publish: PublishAudio;
  private readonly launch: LaunchAudio;
  private readonly platform: NodeJS.Platform;
  private readonly windowsProcessLoopbackSupported: boolean;
  private currentScope: AudioCaptureScope = 'spotify';

  constructor(
    publish: PublishAudio,
    launch: LaunchAudio = launchHelper,
    platform: NodeJS.Platform = process.platform,
    windowsProcessLoopbackSupported: boolean = platform === 'win32' && supportsWindowsProcessLoopback(osRelease())
  ) {
    this.publish = publish;
    this.launch = launch;
    this.platform = platform;
    this.windowsProcessLoopbackSupported = windowsProcessLoopbackSupported;
  }

  status(): AudioStatus { return { ...this.current }; }

  capabilities(): AudioCapabilities {
    if (this.platform === 'darwin' || this.platform === 'win32' && this.windowsProcessLoopbackSupported) return { scope: 'spotify', message: '' };
    if (this.platform === 'win32') return {
      scope: 'all-app',
      message: 'Spotify-only capture is unavailable on this Windows release. You can choose shared audio from the default output device instead.'
    };
    return { scope: 'unsupported', message: 'Audio capture is supported on macOS and compatible Windows releases.' };
  }

  start(session: string, scope: AudioCaptureScope = 'spotify'): AudioStatus {
    if (this.disposed) throw new Error('Audio controller is closed.');
    const capabilities: AudioCapabilities = this.capabilities();
    if (capabilities.scope !== scope) throw new Error(capabilities.scope === 'unsupported'
      ? capabilities.message
      : 'Requested audio capture scope does not match the available capture mode.');
    if (this.child) {
      if (this.current.session === session && this.current.state !== 'stopping' && this.current.state !== 'error') return this.status();
      throw new Error('Audio capture is active or stopping in another panel. Close that panel first.');
    }
    this.buffer = '';
    this.stderrTail = '';
    this.generation++;
    this.terminalPostPending = false;
    this.framePostPending = false;
    this.lastFrameAt = 0;
    this.current = { state: 'starting', message: 'Starting audio capture…', session };
    this.currentScope = scope;
    this.emit('audio.status', this.status());
    if (this.current.state === 'error') return this.status();
    try {
      const child: ChildProcessWithoutNullStreams = this.launch(scope);
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string): void => { if (this.child === child) this.receive(chunk); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string): void => { if (this.child === child) this.stderrTail = (this.stderrTail + chunk).slice(-300); });
      child.stdin.on('error', (): void => { if (this.child === child) this.fail('Audio helper connection closed. Close and reopen the panel to retry.'); });
      child.once('error', (error: NodeJS.ErrnoException): void => {
        if (this.child !== child) return;
        this.fail(error.code === 'ENOENT'
          ? this.platform === 'win32' ? 'Windows PowerShell or its audio helper is missing.' : 'Audio helper is missing. Run sh tools/build-audio-helper.sh on this Mac.'
          : `Audio helper could not start (${error.code ?? 'unknown error'}).`);
      });
      child.once('close', (code: number | null): void => {
        if (this.child !== child) return;
        this.child = null;
        this.clearTimers();
        this.buffer = '';
        if (this.disposed) return;
        this.current = this.current.state === 'error'
          ? { ...this.current, session: null }
          : this.current.state === 'stopping'
            ? { state: 'off', message: 'Audio capture off.', session: null }
            : { state: 'error', message: `Audio helper exited (${code ?? 'signal'}).${this.helperDiagnostic()} Close and reopen the panel to retry.`, session: null };
        this.emit('audio.status', this.status());
      });
      this.startup = setTimeout((): void => this.fail(this.platform === 'win32'
        ? `Audio capture did not start.${this.helperDiagnostic()} Close and reopen the panel to retry.`
        : `Audio capture did not start.${this.helperDiagnostic()} Check System Settings → Privacy & Security → Screen & System Audio Recording, then close and reopen the panel to retry.`), 120000);
      this.startup.unref();
      this.heartbeat(session);
    } catch (error: unknown) {
      this.current = { state: 'error', message: error instanceof Error ? error.message : 'Audio helper failed to start.', session: null };
      this.emit('audio.status', this.status());
    }
    return this.status();
  }

  heartbeat(session: string): AudioStatus {
    if (!this.child || this.current.session !== session || (this.current.state !== 'starting' && this.current.state !== 'listening')) return this.status();
    clearTimeout(this.lease);
    this.lease = setTimeout((): void => { this.stop(session); }, 5000);
    this.lease.unref();
    return this.status();
  }

  stop(session: string): AudioStatus {
    if (!this.child || this.current.session !== session) return this.status();
    this.current = { state: 'stopping', message: 'Stopping audio capture…', session };
    this.emit('audio.status', this.status());
    this.terminate();
    return this.status();
  }

  dispose(force: boolean = false): Promise<void> {
    this.disposed = true;
    this.terminalPostPending = false;
    this.generation++;
    const child: ChildProcessWithoutNullStreams | null = this.child;
    if (!child) { this.clearTimers(); return Promise.resolve(); }
    if (force) {
      child.kill('SIGKILL');
      child.stdin.destroy();
      this.clearTimers();
      return Promise.resolve();
    }
    const closed: Promise<void> = new Promise<void>((resolveClosed): void => { child.once('close', (): void => resolveClosed()); });
    this.terminate();
    return closed;
  }

  private receive(chunk: string): void {
    if (this.current.state !== 'starting' && this.current.state !== 'listening') return;
    this.buffer += chunk;
    let newline: number = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line: string = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        if (line.length > 8192) throw new Error('Oversized audio message.');
        const message: unknown = JSON.parse(line);
        if (message === null || typeof message !== 'object' || !('type' in message)) throw new Error('Invalid audio message.');
        if (message.type === 'ready' && this.current.state === 'starting') {
          clearTimeout(this.startup);
          this.current = { ...this.current, state: 'listening', message: this.currentScope === 'spotify' ? 'Capturing Spotify output.' : 'Capturing all-app audio output.' };
          this.emit('audio.status', this.status());
          this.expectFrame();
        } else if (message.type === 'frame' && this.current.state === 'listening') {
          const frame: AudioFrame = audioFrame(message);
          this.expectFrame();
          const now: number = Date.now();
          // Keep well below Orca's 200 posts per 10 seconds, including status messages.
          if (now - this.lastFrameAt >= 95) { this.lastFrameAt = now; this.emit('audio.frame', frame); }
        } else if (message.type === 'error') {
          const detail: unknown = 'message' in message ? message.message : null;
          this.fail(typeof detail === 'string' ? detail.slice(0, 400) : 'Audio capture failed.');
          return;
        } else { throw new Error('Unexpected audio message.'); }
      } catch { this.fail('Audio helper returned invalid visualization data. Capture stopped.'); return; }
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > 8192) this.fail('Audio helper exceeded its message limit.');
  }

  private helperDiagnostic(): string {
    const text: string = this.stderrTail.replace(/[\r\n\t]+/g, ' ').trim();
    return text ? ` ${text}` : '';
  }

  private expectFrame(): void {
    clearTimeout(this.silence);
    this.silence = setTimeout((): void => this.fail('Audio stream stopped responding. Close and reopen the panel to retry.'), 8000);
    this.silence.unref();
  }

  private fail(message: string): void {
    if (this.disposed || this.current.state === 'error' || this.current.state === 'stopping') return;
    this.current = { ...this.current, state: 'error', message };
    this.emit('audio.status', this.status());
    this.terminate();
  }

  private terminate(): void {
    if (this.termination !== undefined) return;
    this.clearTimers();
    const child: ChildProcessWithoutNullStreams | null = this.child;
    if (!child) return;
    child.stdin.end();
    if (this.platform !== 'win32') child.kill('SIGTERM');
    this.termination = setTimeout((): void => { if (this.child === child) child.kill('SIGKILL'); }, 1000);
    this.termination.unref();
  }

  private clearTimers(): void {
    clearTimeout(this.lease);
    clearTimeout(this.startup);
    clearTimeout(this.silence);
    clearTimeout(this.termination);
    this.termination = undefined;
    for (const deadline of this.pendingPosts) clearTimeout(deadline);
    this.framePostPending = false;
  }

  private emit(event: 'audio.status' | 'audio.frame', payload: AudioStatus | AudioFrame): void {
    if (this.disposed || (event === 'audio.frame' && this.framePostPending)) return;
    const generation: number = this.generation;
    const session: string | null = this.current.session;
    const failed: () => void = (): void => {
      if (this.disposed || generation !== this.generation || session !== this.current.session) return;
      if (this.current.state !== 'error') this.current = { state: 'error', session: this.child ? this.current.session : null, message: 'Panel connection lost. Capture stopped. Reopen the panel; if this persists, reload the plugin.' };
      this.terminate();
    };
    // Include old sessions in this cap until their bridge promises settle.
    if (this.pendingPosts.size >= 4) {
      if (event === 'audio.status' && (this.current.state === 'off' || this.current.state === 'error')) this.terminalPostPending = true;
      else failed();
      return;
    }
    try {
      const publication: void | Promise<void> = this.publish(event, payload);
      if (publication === undefined) return;
      if (event === 'audio.frame') this.framePostPending = true;
      const deadline: ReturnType<typeof setTimeout> = setTimeout(failed, 5000);
      deadline.unref();
      this.pendingPosts.add(deadline);
      const delivered: () => void = (): void => {
        clearTimeout(deadline);
        this.pendingPosts.delete(deadline);
        if (generation === this.generation && event === 'audio.frame') this.framePostPending = false;
        if (this.terminalPostPending && !this.disposed) {
          this.terminalPostPending = false;
          this.emit('audio.status', this.status());
        }
      };
      void publication.then(delivered, (): void => { failed(); delivered(); });
    } catch { failed(); }
  }
}
