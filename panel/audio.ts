import { AUDIO_BANDS, audioFrame, audioStatus, type AudioFrame, type AudioStatus } from '../audio-protocol.ts';

export interface AudioBridge {
  request(name: string, input?: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): { dispose(): void };
}

export interface AudioVisualizer {
  setMotionPaused(paused: boolean): void;
  preferenceChanged(key: string): void;
  dispose(): void;
}

export interface AudioPreferenceHost {
  call(method: string, params: unknown): Promise<unknown>;
}

const autoStartKey: string = 'audio.autostart.v1';

export function setupAudioVisualizer(bridge: AudioBridge, initiallyPaused: boolean, host: AudioPreferenceHost): AudioVisualizer {
  const label: HTMLElement = document.getElementById('audio-status')!;
  const display: HTMLElement = document.getElementById('audio-bands')!;
  const autoStart: HTMLInputElement = document.getElementById('audio-autostart') as HTMLInputElement;
  const consent: HTMLElement = document.getElementById('audio-consent')!;
  const allow: HTMLButtonElement = document.getElementById('audio-allow') as HTMLButtonElement;
  const cancel: HTMLButtonElement = document.getElementById('audio-cancel') as HTMLButtonElement;
  const preferenceNote: HTMLElement = document.getElementById('audio-preference-status')!;
  const startButton: HTMLButtonElement = document.getElementById('audio-start') as HTMLButtonElement;
  const stopButton: HTMLButtonElement = document.getElementById('audio-stop') as HTMLButtonElement;
  const session: string = crypto.randomUUID();
  const bars: HTMLElement[] = [];
  let status: AudioStatus = { state: 'off', message: 'Off · Spotify is not playing.', session: null };
  let revision: number = 0;
  let paused: boolean = initiallyPaused;
  let disposed: boolean = false;
  let heartbeatPending: boolean = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let staleFrame: ReturnType<typeof setTimeout> | undefined;
  let automaticStartPending: boolean = false;
  let savedAutoStart: boolean = false;
  let startupCancelled: boolean = false;
  let preferenceVersion: number = 0;
  let preferenceSaving: boolean = false;
  let panelHidden: boolean = document.hidden;
  let pageExited: boolean = false;
  let initialized: boolean = false;
  let preferenceVerified: boolean = false;

  for (let index: number = 0; index < AUDIO_BANDS; index++) {
    const bar: HTMLElement = document.createElement('span');
    bar.style.transform = 'scaleY(0)';
    display.append(bar);
    bars.push(bar);
  }

  function flatten(): void {
    clearTimeout(staleFrame);
    for (const bar of bars) bar.style.transform = 'scaleY(0)';
  }

  function paint(): void {
    const owner: boolean = status.session === session;
    const active: boolean = status.state === 'starting' || status.state === 'listening' || status.state === 'stopping';
    label.textContent = active && !owner ? 'Capture active in another panel. Close that panel first.' :
      status.state === 'listening' && paused ? 'Capturing Spotify · display paused.' : status.message;
    label.dataset.state = status.state;
    startButton.disabled = !initialized || active || status.session !== null;
    stopButton.disabled = !owner || !active || status.state === 'stopping';
    if (status.state !== 'listening' || paused || !owner) flatten();
    clearInterval(heartbeat);
    if (!owner || document.hidden || !['starting', 'listening'].includes(status.state)) return;
    heartbeat = setInterval((): void => {
      if (heartbeatPending || disposed) return;
      heartbeatPending = true;
      const requestRevision: number = revision;
      void bridge.request('audio.heartbeat', { session }).then((result: unknown): void => {
        if (!disposed && revision === requestRevision) apply(result);
      }).catch((): void => {
        if (disposed || revision !== requestRevision) return;
        apply({ state: 'error', session, message: 'Audio connection lost. Capture expires within 5 seconds.' });
      }).finally((): void => { heartbeatPending = false; });
    }, 1000);
  }

  function apply(value: unknown): void {
    if (disposed) return;
    status = audioStatus(value);
    revision++;
    paint();
    maybeStartAutomatically();
  }

  async function stop(): Promise<void> {
    startupCancelled = true;
    automaticStartPending = false;
    if (disposed || status.session !== session || status.state === 'stopping') return;
    apply({ state: 'stopping', session, message: 'Stopping audio capture…' });
    const requestRevision: number = revision;
    try {
      const result: unknown = await bridge.request('audio.stop', { session });
      if (!disposed && revision === requestRevision) apply(result);
    } catch {
      if (!disposed && revision === requestRevision) apply({ state: 'error', session, message: 'Could not stop capture. Capture expires within 5 seconds.' });
    }
  }

  async function start(manual: boolean = false): Promise<void> {
    if (disposed || pageExited || document.hidden || !initialized || (!manual && (!preferenceVerified || !savedAutoStart || preferenceSaving)) || (status.state !== 'off' && status.state !== 'error') || status.session !== null) return;
    automaticStartPending = false;
    startupCancelled = true;
    apply({ state: 'starting', session, message: 'Starting · approve system-audio access if macOS asks.' });
    const requestRevision: number = revision;
    try {
      const result: unknown = await bridge.request('audio.start', { session });
      if (!disposed && revision === requestRevision) apply(result);
    } catch (error: unknown) {
      if (disposed || revision !== requestRevision) return;
      void bridge.request('audio.stop', { session }).catch((): void => {});
      apply({ state: 'error', session: null, message: error instanceof Error ? error.message : 'Could not start audio capture.' });
    }
  }

  function maybeStartAutomatically(): void {
    if (!automaticStartPending || !initialized || !preferenceVerified || !savedAutoStart || preferenceSaving || disposed || pageExited || document.hidden) return;
    if (status.state === 'starting' || status.state === 'listening' || status.state === 'stopping') {
      if (status.session !== session) label.textContent = 'Waiting for previous capture to stop…';
      return;
    }
    automaticStartPending = false;
    if ((status.state === 'off' || status.state === 'error') && status.session === null) void start();
  }

  function hide(): void {
    if (document.hidden === panelHidden || pageExited) return;
    panelHidden = document.hidden;
    if (panelHidden) {
      automaticStartPending = false;
      if (status.session === session) void stop();
    } else {
      startupCancelled = false;
      automaticStartPending = savedAutoStart && !preferenceSaving;
      maybeStartAutomatically();
    }
  }
  function pageExit(): void {
    pageExited = true;
    automaticStartPending = false;
    startupCancelled = true;
    revision++;
    if (status.session === session) void bridge.request('audio.stop', { session }).catch((): void => {});
    clearInterval(heartbeat);
    flatten();
  }

  async function saveAutomaticStart(enabled: boolean): Promise<void> {
    preferenceSaving = true;
    preferenceVerified = false;
    preferenceVersion++;
    automaticStartPending = false;
    autoStart.disabled = allow.disabled = cancel.disabled = true;
    if (!enabled) void stop();
    try {
      await host.call('storage.set', { key: autoStartKey, value: enabled });
      if (disposed) return;
      automaticStartPending = enabled && !document.hidden && !pageExited;
      consent.hidden = true;
      preferenceNote.textContent = '';
    } catch {
      if (disposed) return;
      autoStart.checked = savedAutoStart;
      preferenceNote.textContent = enabled ? 'Could not save permission. Automatic start was not enabled.' :
        'Could not save this change. Future panels may still start automatically; uncheck again to retry.';
    } finally {
      if (!disposed) {
        preferenceSaving = false;
        autoStart.disabled = allow.disabled = cancel.disabled = false;
        refreshPreference(++preferenceVersion);
      }
    }
  }

  function refreshPreference(version: number): void {
    preferenceVerified = false;
    void host.call('storage.get', { key: autoStartKey }).then((stored: unknown): void => {
      if (disposed || version !== preferenceVersion) return;
      preferenceVerified = true;
      savedAutoStart = stored !== null && typeof stored === 'object' && 'value' in stored && stored.value === true;
      autoStart.checked = savedAutoStart;
      if (!savedAutoStart) void stop();
      else maybeStartAutomatically();
    }).catch((): void => {
      if (disposed || version !== preferenceVersion) return;
      void stop();
      preferenceNote.textContent = 'Could not verify saved permission. Capture is stopped here, but future panels may still start automatically.';
    });
  }

  function automaticStartChanged(): void {
    startupCancelled = true;
    automaticStartPending = false;
    if (autoStart.checked) {
      autoStart.checked = savedAutoStart;
      consent.hidden = false;
      allow.focus();
    } else { void saveAutomaticStart(false); }
  }
  function allowAutomaticStart(): void { void saveAutomaticStart(true); }
  function cancelAutomaticStart(): void { consent.hidden = true; autoStart.checked = savedAutoStart; autoStart.focus(); }

  const statuses: { dispose(): void } = bridge.on('audio.status', (value: unknown): void => {
    try { apply(value); }
    catch { void stop(); label.textContent = 'Invalid audio status. Capture stopped or will expire within 5 seconds.'; }
  });
  const frames: { dispose(): void } = bridge.on('audio.frame', (value: unknown): void => {
    if (disposed || paused || document.hidden || status.state !== 'listening' || status.session !== session) return;
    try {
      const frame: AudioFrame = audioFrame(value);
      for (let index: number = 0; index < bars.length; index++) bars[index].style.transform = `scaleY(${frame.bands[index]})`;
      clearTimeout(staleFrame);
      staleFrame = setTimeout(flatten, 1500);
    } catch { void stop(); label.textContent = 'Invalid audio levels. Capture stopped or will expire within 5 seconds.'; }
  });

  function manualStart(): void { void start(true); }
  function manualStop(): void { void stop(); }
  startButton.addEventListener('click', manualStart);
  stopButton.addEventListener('click', manualStop);
  autoStart.addEventListener('change', automaticStartChanged);
  allow.addEventListener('click', allowAutomaticStart);
  cancel.addEventListener('click', cancelAutomaticStart);
  document.addEventListener('visibilitychange', hide);
  window.addEventListener('pagehide', pageExit);
  const initialRevision: number = revision;
  const initialPreferenceVersion: number = preferenceVersion;
  void Promise.all([
    bridge.request('audio.status'),
    host.call('storage.get', { key: autoStartKey })
  ]).then(([result, stored]: unknown[]): void => {
    if (disposed) return;
    const unchanged: boolean = revision === initialRevision;
    if (unchanged) apply(result);
    const preferenceUnchanged: boolean = preferenceVersion === initialPreferenceVersion;
    if (preferenceUnchanged) {
      preferenceVerified = true;
      savedAutoStart = stored !== null && typeof stored === 'object' && 'value' in stored && stored.value === true;
      autoStart.checked = savedAutoStart;
    }
    autoStart.disabled = false;
    initialized = true;
    paint();
    automaticStartPending = savedAutoStart && preferenceUnchanged && !startupCancelled;
    maybeStartAutomatically();
  }).catch((error: unknown): void => {
    if (disposed) return;
    initialized = true;
    paint();
    autoStart.disabled = false;
    preferenceNote.textContent = 'Could not load automatic-start permission. Capture will not start automatically.';
    if (revision === initialRevision) apply({ state: 'error', session: null, message: error instanceof Error ? error.message : 'Audio helper unavailable.' });
  });

  return {
    setMotionPaused(value: boolean): void { paused = value; paint(); },
    preferenceChanged(key: string): void {
      if (key !== autoStartKey || disposed) return;
      const version: number = ++preferenceVersion;
      automaticStartPending = false;
      startupCancelled = true;
      if (!preferenceSaving) refreshPreference(version);
    },
    dispose(): void {
      pageExit();
      disposed = true;
      statuses.dispose();
      frames.dispose();
      startButton.removeEventListener('click', manualStart);
      stopButton.removeEventListener('click', manualStop);
      autoStart.removeEventListener('change', automaticStartChanged);
      allow.removeEventListener('click', allowAutomaticStart);
      cancel.removeEventListener('click', cancelAutomaticStart);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', pageExit);
    }
  };
}
