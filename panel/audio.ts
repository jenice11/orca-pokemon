import { AUDIO_BANDS, audioFrame, audioStatus, type AudioFrame, type AudioStatus } from '../audio-protocol.ts';
import { POKEMON, type Pokemon, type SpriteAnimation } from './sprites.ts';

export interface AudioBridge {
  request(name: string, input?: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): { dispose(): void };
}

export interface AudioVisualizer {
  refresh(): void;
  setMotionPaused(paused: boolean): void;
  preferenceChanged(key: string): void;
  dispose(): void;
}

export interface AudioPreferenceHost {
  call(method: string, params: unknown): Promise<unknown>;
}

const autoStartKey: string = 'audio.autostart.v1';

export function setupAudioVisualizer(bridge: AudioBridge, initiallyPaused: boolean, host: AudioPreferenceHost): AudioVisualizer {
  const card: HTMLElement = document.getElementById('audio-card')!;
  const label: HTMLElement = document.getElementById('audio-status')!;
  const display: HTMLElement = document.getElementById('audio-bands')!;
  const loader: HTMLElement = document.getElementById('audio-loader')!;
  const idle: HTMLElement = document.getElementById('audio-idle')!;
  const idleSprite: HTMLElement = document.getElementById('audio-idle-sprite')!;
  const snorlax: Pokemon = POKEMON.find((species: Pokemon): boolean => species.id === 143)!;
  const sheet: SpriteAnimation = snorlax.animations.sleep;
  const idleDuration: number = sheet.durations.reduce((sum: number, duration: number): number => sum + duration, 0);
  const idleFrames: Keyframe[] = [];
  let elapsed: number = 0;
  const scale: number = Math.min(1.15625, 64 / sheet.width, 37 / sheet.height);
  const width: number = sheet.width * scale;
  const height: number = sheet.height * scale;
  // Both sleeping frames share opaque bounds (5, 0)–(38, 19) in their 40×24 canvas.
  idleSprite.style.transform = `translate(${-1.5 * scale}px, ${2.5 * scale}px)`;
  for (let index: number = 0; index < sheet.columns; index++) {
    idleFrames.push({ width: `${width}px`, height: `${height}px`, backgroundImage: `url("${sheet.path}")`, backgroundSize: `${width * sheet.columns}px auto`, backgroundPosition: `${-index * width}px ${-sheet.row * height}px`, offset: elapsed / idleDuration, easing: 'steps(1, end)' });
    elapsed += sheet.durations[index];
  }
  idleFrames.push({ ...idleFrames[idleFrames.length - 1], offset: 1 });
  let idleAnimation: Animation | undefined;
  const enable: HTMLButtonElement = document.getElementById('audio-enable') as HTMLButtonElement;
  const disable: HTMLButtonElement = document.getElementById('audio-disable') as HTMLButtonElement;
  const consent: HTMLDialogElement = document.getElementById('audio-consent') as HTMLDialogElement;
  const consentError: HTMLElement = document.getElementById('audio-consent-error')!;
  const allow: HTMLButtonElement = document.getElementById('audio-allow') as HTMLButtonElement;
  const cancel: HTMLButtonElement = document.getElementById('audio-cancel') as HTMLButtonElement;
  const preferenceNote: HTMLElement = document.getElementById('audio-preference-status')!;
  const session: string = crypto.randomUUID();
  const bars: HTMLElement[] = [];
  let status: AudioStatus = { state: 'off', message: 'Audio capture off.', session: null };
  let revision: number = 0;
  let paused: boolean = initiallyPaused;
  let disposed: boolean = false;
  let heartbeatPending: symbol | null = null;
  let captureIntent: boolean = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let staleFrame: ReturnType<typeof setTimeout> | undefined;
  let automaticStartPending: boolean = false;
  let captureRefresh: 'stopping' | 'starting' | null = null;
  let savedAutoStart: boolean = false;
  let startupCancelled: boolean = false;
  let preferenceVersion: number = 0;
  let preferenceSaving: boolean = false;
  let panelHidden: boolean = document.hidden;
  let pageExited: boolean = false;
  let initialized: boolean = false;
  let preferenceVerified: boolean = false;
  let receivedFrame: boolean = false;
  let audible: boolean = false;

  function paintPermission(): void {
    card.hidden = !savedAutoStart || !preferenceVerified;
    enable.hidden = savedAutoStart && preferenceVerified;
    disable.hidden = !savedAutoStart && status.session !== session;
    enable.disabled = disable.disabled = allow.disabled = cancel.disabled = preferenceSaving || !initialized;
  }

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

  function canHeartbeat(): boolean {
    return captureIntent && initialized && preferenceVerified && savedAutoStart && !preferenceSaving &&
      !disposed && !pageExited && !document.hidden && status.session === session &&
      (status.state === 'starting' || status.state === 'listening');
  }

  function paint(): void {
    paintPermission();
    const owner: boolean = status.session === session;
    const active: boolean = status.state === 'starting' || status.state === 'listening' || status.state === 'stopping';
    const waiting: boolean = (automaticStartPending || captureRefresh === 'stopping') && active;
    const loading: boolean = !initialized || waiting || (owner && (status.state === 'starting' || (status.state === 'listening' && !receivedFrame)));
    const sleeping: boolean = !loading && (status.state === 'off' || (owner && status.state === 'listening' && receivedFrame && !audible));
    loader.hidden = !loading;
    idle.hidden = !sleeping;
    display.hidden = loading || sleeping;
    if (sleeping && !card.hidden && !document.hidden && !pageExited && !disposed) {
      idleAnimation ??= idleSprite.animate(idleFrames, { duration: idleDuration, iterations: Infinity });
      if (paused) idleAnimation.pause();
      else idleAnimation.play();
    } else {
      idleAnimation?.cancel();
      idleAnimation = undefined;
    }
    label.dataset.quiet = String(waiting || (owner && status.state === 'listening'));
    label.textContent = waiting ? 'Waiting for previous capture to stop…' : active && !owner ? 'Capture active in another panel. Close that panel first.' :
      status.state === 'listening' && paused ? 'Capturing Spotify · display paused.' : status.message;
    label.dataset.state = status.state;
    if (status.state !== 'listening' || paused || !owner) flatten();
    if (!canHeartbeat()) {
      clearInterval(heartbeat);
      heartbeat = undefined;
      return;
    }
    if (heartbeat !== undefined) return;
    heartbeat = setInterval((): void => {
      if (heartbeatPending || !canHeartbeat()) return;
      const requestToken: symbol = Symbol();
      heartbeatPending = requestToken;
      const requestRevision: number = revision;
      void bridge.request('audio.heartbeat', { session }).then((result: unknown): void => {
        if (!disposed && revision === requestRevision) apply(result);
      }).catch((): void => {
        if (disposed || revision !== requestRevision) return;
        apply({ state: 'error', session, message: 'Audio connection lost. Capture expires within 5 seconds.' });
      }).finally((): void => { if (heartbeatPending === requestToken) heartbeatPending = null; });
    }, 1000);
  }

  function apply(value: unknown): void {
    if (disposed) return;
    status = audioStatus(value);
    if ((status.session !== null && status.session !== session) || (captureRefresh === 'starting' && (status.state === 'listening' || status.state === 'error'))) captureRefresh = null;
    if (status.state !== 'listening' || status.session !== session) receivedFrame = false;
    revision++;
    paint();
    maybeStartAutomatically();
  }

  async function stop(): Promise<void> {
    captureIntent = false;
    heartbeatPending = null;
    captureRefresh = null;
    startupCancelled = true;
    automaticStartPending = false;
    paint();
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

  async function start(): Promise<void> {
    if (disposed || pageExited || document.hidden || !initialized || !preferenceVerified || !savedAutoStart || preferenceSaving || (status.state !== 'off' && status.state !== 'error') || status.session !== null) return;
    automaticStartPending = false;
    startupCancelled = true;
    captureIntent = true;
    heartbeatPending = null;
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
    paint();
    if ((!automaticStartPending && captureRefresh !== 'stopping') || !initialized || !preferenceVerified || !savedAutoStart || preferenceSaving || disposed || pageExited || document.hidden) return;
    if (captureRefresh === 'stopping') {
      if (status.session !== null || (status.state !== 'off' && status.state !== 'error')) return;
      captureRefresh = 'starting';
      automaticStartPending = false;
      void start();
      return;
    }
    if (status.state === 'starting' || status.state === 'listening' || status.state === 'stopping') {
      return;
    }
    automaticStartPending = false;
    if ((status.state === 'off' || status.state === 'error') && status.session === null) void start();
  }

  function hide(): void {
    if (document.hidden === panelHidden || pageExited) return;
    panelHidden = document.hidden;
    if (panelHidden) {
      captureRefresh = null;
      automaticStartPending = false;
      if (status.session === session) void stop();
    } else {
      startupCancelled = false;
      automaticStartPending = savedAutoStart && !preferenceSaving;
      maybeStartAutomatically();
    }
    paint();
  }
  function pageExit(): void {
    captureIntent = false;
    heartbeatPending = null;
    captureRefresh = null;
    pageExited = true;
    idleAnimation?.cancel();
    idleAnimation = undefined;
    automaticStartPending = false;
    startupCancelled = true;
    revision++;
    if (status.session === session) void bridge.request('audio.stop', { session }).catch((): void => {});
    clearInterval(heartbeat);
    heartbeat = undefined;
    flatten();
  }

  async function saveAutomaticStart(enabled: boolean): Promise<void> {
    const restoreFocus: boolean = document.activeElement === allow || document.activeElement === disable;
    captureRefresh = null;
    preferenceSaving = true;
    preferenceVerified = false;
    preferenceVersion++;
    automaticStartPending = false;
    paint();
    if (!enabled) void stop();
    try {
      await host.call('storage.set', { key: autoStartKey, value: enabled });
      if (disposed) return;
      automaticStartPending = enabled && !document.hidden && !pageExited;
      consent.close();
      consent.hidden = true;
      preferenceNote.textContent = '';
    } catch {
      if (disposed) return;
      preferenceNote.textContent = enabled ? 'Could not save permission. Automatic start was not enabled.' :
        'Could not save this change. Future panels may still start automatically; choose Disable visualizer again to retry.';
      consentError.textContent = preferenceNote.textContent;
    } finally {
      if (!disposed) {
        preferenceSaving = false;
        paintPermission();
        refreshPreference(++preferenceVersion, restoreFocus);
      }
    }
  }

  function refreshPreference(version: number, restoreFocus: boolean = false): void {
    preferenceVerified = false;
    paint();
    void host.call('storage.get', { key: autoStartKey }).then((stored: unknown): void => {
      if (disposed || version !== preferenceVersion) return;
      preferenceVerified = true;
      savedAutoStart = stored !== null && typeof stored === 'object' && 'value' in stored && stored.value === true;
      paint();
      if (!savedAutoStart) void stop();
      else maybeStartAutomatically();
    }).catch((): void => {
      if (disposed || version !== preferenceVersion) return;
      void stop();
      paintPermission();
      preferenceNote.textContent = 'Could not verify saved permission. Capture is stopped here, but future panels may still start automatically.';
    }).finally((): void => {
      if (disposed || version !== preferenceVersion) return;
      if (restoreFocus && (document.activeElement === document.body || document.activeElement === allow || document.activeElement === disable)) {
        (consent.open ? allow : enable.hidden ? disable : enable).focus({ preventScroll: true });
      }
    });
  }

  function requestPermission(): void {
    captureRefresh = null;
    startupCancelled = true;
    automaticStartPending = false;
    consent.hidden = false;
    consentError.textContent = '';
    if (!consent.open) consent.showModal();
    allow.focus();
  }
  function revokePermission(): void { void saveAutomaticStart(false); }
  function allowAutomaticStart(): void { void saveAutomaticStart(true); }
  function cancelAutomaticStart(): void { consent.close(); consent.hidden = true; enable.focus(); }
  function cancelConsent(event: Event): void {
    event.preventDefault();
    if (!preferenceSaving) cancelAutomaticStart();
  }

  const statuses: { dispose(): void } = bridge.on('audio.status', (value: unknown): void => {
    try { apply(value); }
    catch { void stop(); label.dataset.quiet = 'false'; label.textContent = 'Invalid audio status. Capture stopped or will expire within 5 seconds.'; }
  });
  const frames: { dispose(): void } = bridge.on('audio.frame', (value: unknown): void => {
    if (disposed || document.hidden || status.state !== 'listening' || status.session !== session) return;
    try {
      const frame: AudioFrame = audioFrame(value);
      const nextAudible: boolean = frame.bands.some((band: number): boolean => band > 0);
      const changed: boolean = !receivedFrame || audible !== nextAudible;
      receivedFrame = true;
      audible = nextAudible;
      if (changed) paint();
      if (paused) return;
      for (let index: number = 0; index < bars.length; index++) bars[index].style.transform = `scaleY(${frame.bands[index]})`;
      clearTimeout(staleFrame);
      staleFrame = setTimeout(flatten, 1500);
    } catch { void stop(); label.dataset.quiet = 'false'; label.textContent = 'Invalid audio levels. Capture stopped or will expire within 5 seconds.'; }
  });

  enable.addEventListener('click', requestPermission);
  disable.addEventListener('click', revokePermission);
  allow.addEventListener('click', allowAutomaticStart);
  cancel.addEventListener('click', cancelAutomaticStart);
  consent.addEventListener('cancel', cancelConsent);
  document.addEventListener('visibilitychange', hide);
  window.addEventListener('pagehide', pageExit);
  paint();
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
    }
    initialized = true;
    paintPermission();
    automaticStartPending = savedAutoStart && preferenceUnchanged && !startupCancelled;
    maybeStartAutomatically();
  }).catch((error: unknown): void => {
    if (disposed) return;
    initialized = true;
    paintPermission();
    preferenceNote.textContent = 'Could not load automatic-start permission. Capture will not start automatically.';
    if (revision === initialRevision) apply({ state: 'error', session: null, message: error instanceof Error ? error.message : 'Audio helper unavailable.' });
    paint();
  });

  return {
    refresh(): void {
      if (captureRefresh !== null || disposed || pageExited || document.hidden || !initialized || !preferenceVerified || !savedAutoStart || preferenceSaving || (status.session !== null && status.session !== session)) return;
      void stop();
      captureRefresh = 'stopping';
      maybeStartAutomatically();
    },
    setMotionPaused(value: boolean): void { paused = value; paint(); },
    preferenceChanged(key: string): void {
      if (key !== autoStartKey || disposed) return;
      captureRefresh = null;
      const version: number = ++preferenceVersion;
      startupCancelled = true;
      if (!preferenceSaving) refreshPreference(version);
    },
    dispose(): void {
      pageExit();
      disposed = true;
      statuses.dispose();
      frames.dispose();
      enable.removeEventListener('click', requestPermission);
      disable.removeEventListener('click', revokePermission);
      allow.removeEventListener('click', allowAutomaticStart);
      cancel.removeEventListener('click', cancelAutomaticStart);
      consent.removeEventListener('cancel', cancelConsent);
      consent.close();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', pageExit);
    }
  };
}
