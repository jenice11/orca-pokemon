import type { AudioStatus } from '../audio-protocol.ts';

declare const fixture: {
  failAudioStart: boolean;
  failStorage: boolean;
  audio: AudioStatus;
  calls: { name?: string; input?: { session: string } }[];
  post(event: string, payload: unknown): void;
  emit(event: string, payload: unknown): void;
};
declare const orca: { plugin: { request(name: string, input?: unknown): Promise<unknown> } };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(condition: () => boolean): Promise<void> {
  for (let frame: number = 0; frame < 150; frame++) {
    if (condition()) return;
    await new Promise<number>(requestAnimationFrame);
  }
  throw new Error('Audio browser test did not settle within 150 frames.');
}

function automatic(): HTMLButtonElement { return document.getElementById('audio-enable') as HTMLButtonElement; }
async function start(): Promise<void> {
  await until((): boolean => !automatic().disabled);
  check(!automatic().hidden, 'Each new capture must request consent after revocation.');
  automatic().click();
  const dialog: HTMLDialogElement = document.getElementById('audio-consent') as HTMLDialogElement;
  check(dialog.open && dialog.matches(':modal'), 'Allow Spotify visualizer must open modal consent.');
  document.getElementById('audio-allow')!.scrollIntoView({ block: 'nearest' });
  const allowBounds: DOMRect = document.getElementById('audio-allow')!.getBoundingClientRect();
  check(allowBounds.top >= 0 && allowBounds.bottom <= innerHeight, 'Modal consent controls must remain reachable in short panels.');
  (document.getElementById('audio-allow') as HTMLButtonElement).click();
  await until((): boolean => !automatic().disabled && automatic().hidden);
}
async function stop(): Promise<void> {
  const disable: HTMLButtonElement = document.getElementById('audio-disable') as HTMLButtonElement;
  await until((): boolean => !disable.disabled);
  // A failed owned shutdown remains retryable even after consent was revoked.
  if (disable.hidden && fixture.audio.session === null) return;
  disable.click();
  await until((): boolean => !disable.disabled);
}
function bars(): HTMLElement[] { return Array.from(document.querySelectorAll<HTMLElement>('#audio-bands span')); }
function label(): HTMLElement { return document.getElementById('audio-status')!; }
function ready(): void {
  fixture.post('audio.status', { state: 'listening', message: 'Capturing Spotify output.', session: fixture.audio.session });
}

export async function run(): Promise<string[]> {
  const enableControl: HTMLElement = document.getElementById('audio-enable')!;
  const disableControl: HTMLElement = document.getElementById('audio-disable')!;
  check(enableControl.parentElement === disableControl.parentElement && !enableControl.closest('.audio-card'), 'Enable and Disable must share controls outside the visualizer.');
  check(document.getElementById('audio-card')!.hidden, 'Disabled visualizer must not occupy space.');
  check(typeof fixture !== 'undefined', 'Audio tests require the mock preview; never run against real capture.');
  const passed: string[] = [];
  await until((): boolean => !automatic().disabled);
  check(document.getElementById('audio-start') === null && document.getElementById('audio-stop') === null, 'Capture must not expose Start or Stop buttons.');
  check(fixture.calls.every((call): boolean => call.name !== 'audio.start'), 'Panel load must not request capture.');
  check(bars().length === 24 && bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Stopped display must be flat.');
  passed.push('capture remains off on load, with 24 flat spectrum bars');
  automatic().click();
  const consent: HTMLDialogElement = document.getElementById('audio-consent') as HTMLDialogElement;
  const allowConsent: HTMLButtonElement = document.getElementById('audio-allow') as HTMLButtonElement;
  fixture.failStorage = true;
  allowConsent.focus();
  allowConsent.click();
  await until((): boolean => !allowConsent.disabled && Boolean(document.getElementById('audio-consent-error')!.textContent));
  check(consent.open && document.activeElement === allowConsent, 'Failed consent save must keep error and keyboard focus inside the popup.');
  fixture.failStorage = false;
  (document.getElementById('audio-cancel') as HTMLButtonElement).click();
  check(!consent.open && document.activeElement === automatic(), 'Cancel must close popup and restore Enable focus.');

  const root: HTMLElement = document.documentElement;
  const card: HTMLElement = document.querySelector('.audio-card')!;
  const tokens: string[] = ['--orca-primary', '--orca-ring', '--orca-background'];
  const previous: string[] = tokens.map((token: string): string => root.style.getPropertyValue(token));
  const audioCallsBefore: number = fixture.calls.filter((call): boolean => call.name === 'audio.start' || call.name === 'audio.stop').length;
  try {
    for (const theme of [
      { primary: '#808080', ring: '#c800c8', background: '#0a0a0a', expected: 'hsl(300 78% 65%)' },
      { primary: '#00c800', ring: '#c800c8', background: '#0a0a0a', expected: 'hsl(120 78% 65%)' },
      { primary: '#808080', ring: '#808080', background: '#0a1e1e', expected: 'hsl(180 78% 65%)' },
      { primary: '#808080', ring: '#808080', background: '#fafafa', expected: 'hsl(220 78% 42%)' }
    ]) {
      root.style.setProperty('--orca-primary', theme.primary);
      root.style.setProperty('--orca-ring', theme.ring);
      root.style.setProperty('--orca-background', theme.background);
      fixture.emit('theme', { colorScheme: theme.background === '#fafafa' ? 'light' : 'dark' });
      check(card.style.getPropertyValue('--audio-middle') === theme.expected, 'Palette must follow the active theme tokens.');
      check(getComputedStyle(bars()[0]).backgroundImage.includes('linear-gradient'), 'Bars must render their theme gradient.');
    }
  } finally {
    for (let index: number = 0; index < tokens.length; index++) {
      if (previous[index]) root.style.setProperty(tokens[index], previous[index]);
      else root.style.removeProperty(tokens[index]);
    }
    fixture.emit('theme', {});
  }
  check(fixture.calls.filter((call): boolean => call.name === 'audio.start' || call.name === 'audio.stop').length === audioCallsBefore, 'Theme changes must not start or stop capture.');
  passed.push('theme accents, neutral fallback, and live light/dark changes leave capture untouched');

  await start();
  await until((): boolean => fixture.audio.state === 'starting');
  ready();
  check(label().textContent === '' && label().dataset.state === 'listening', 'Readiness must stay quiet while tracking active capture.');
  fixture.failStorage = true;
  await stop();
  const preferenceNote: HTMLElement = document.getElementById('audio-preference-status')!;
  check(preferenceNote.textContent!.includes('Future panels may still start automatically'), 'Failed revocation must explain that permission remains enabled.');
  for (const animation of preferenceNote.getAnimations()) animation.finish();
  await new Promise<number>(requestAnimationFrame);
  check(getComputedStyle(preferenceNote).visibility === 'visible', 'Permission warnings must remain visible after toast expiry.');
  await stop();
  check(getComputedStyle(preferenceNote).visibility === 'visible', 'Repeated revocation failures must remain visible.');
  fixture.failStorage = false;
  await stop();
  check(preferenceNote.textContent === '', 'Successful revocation must clear its warning.');
  await start();
  ready();
  passed.push('failed permission revocation stays visible through expiration and retries until saved');
  fixture.post('audio.frame', { bands: Array<number>(24).fill(0.6), level: 0.5 });
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0.6)'), 'Bars must reflect real input levels.');
  check(document.getElementById('audio-idle')!.hidden, 'Audible input must hide resting Snorlax.');
  fixture.post('audio.frame', { bands: Array<number>(24).fill(0), level: 0 });
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Silence must be flat, not simulated.');
  check(!document.getElementById('audio-idle')!.hidden && document.getElementById('audio-bands')!.hidden, 'Silence must replace the bars with resting Snorlax.');
  const idleSprite: HTMLElement = document.getElementById('audio-idle-sprite')!;
  const cycle: Animation = idleSprite.getAnimations()[0];
  check(cycle !== undefined, 'Silence must start the Snorlax cycle.');
  cycle.pause();
  cycle.currentTime = 0;
  await new Promise<number>(requestAnimationFrame);
  check(getComputedStyle(idleSprite).backgroundImage.includes('0143/Sleep-Anim.png'), 'Cycle must begin with Sleep.');
  cycle.currentTime = 1200;
  await new Promise<number>(requestAnimationFrame);
  check(getComputedStyle(idleSprite).backgroundImage.includes('0143/Sleep-Anim.png'), 'Snorlax must keep sleeping when the animation loops.');
  cycle.play();
  check(label().textContent === '', 'Silent capture must not show a routine status popup.');
  (document.getElementById('motion') as HTMLButtonElement).click();
  check(idleSprite.getAnimations().every((animation: Animation): boolean => animation.playState === 'paused'), 'Motion pause must stop the resting animation.');
  fixture.post('audio.frame', { bands: Array<number>(24).fill(0.9), level: 0.8 });
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Motion pause must prevent bar updates.');
  check(label().textContent === '' && label().dataset.state === 'listening', 'Motion pause must keep capture active without a routine status popup.');
  (document.getElementById('motion') as HTMLButtonElement).click();
  await stop();
  await until((): boolean => !automatic().disabled);
  check(fixture.audio.state === 'off', 'Disable visualizer must request capture shutdown.');
  check(document.getElementById('audio-card')!.hidden && !automatic().hidden, 'Disabling must hide the card while keeping Enable outside it.');
  passed.push('verified consent starts capture, input levels, silence, motion pause, and revocation');

  await start();
  await until((): boolean => fixture.audio.state === 'starting');
  ready();
  const startsBeforeRefresh: number = fixture.calls.filter((call): boolean => call.name === 'audio.start').length;
  const rostersBeforeRefresh: number = fixture.calls.filter((call): boolean => call.name === 'roster').length;
  fixture.emit('workspace.changed', {});
  await until((): boolean => fixture.calls.filter((call): boolean => call.name === 'roster').length > rostersBeforeRefresh);
  check(fixture.calls.filter((call): boolean => call.name === 'audio.start').length === startsBeforeRefresh, 'Automatic roster refresh must not restart audio.');
  const refresh: HTMLButtonElement = document.getElementById('refresh') as HTMLButtonElement;
  await until((): boolean => !refresh.disabled);
  refresh.click();
  await until((): boolean => fixture.calls.filter((call): boolean => call.name === 'audio.start').length === startsBeforeRefresh + 1);
  check(label().dataset.state === 'starting', 'Manual Refresh must restart permitted capture.');
  check(!document.getElementById('audio-loader')!.hidden, 'Refreshed capture must show its startup loader.');
  ready();
  await stop();
  passed.push('manual Refresh restarts capture while automatic roster refresh leaves it untouched');

  const request: typeof orca.plugin.request = orca.plugin.request;
  orca.plugin.request = async (name: string, input?: unknown): Promise<unknown> => {
    const result: unknown = await request(name, input);
    if (name === 'audio.start') ready();
    return result;
  };
  await start();
  await until((): boolean => label().dataset.state === 'listening');
  await new Promise<number>(requestAnimationFrame);
  check(label().dataset.state === 'listening', 'A stale Start response must not replace the ready event.');
  orca.plugin.request = request;
  await stop();
  await until((): boolean => !automatic().disabled);
  passed.push('ready event wins over a stale Start response');

  let rejectOldStart: ((reason: Error) => void) | undefined;
  orca.plugin.request = async (name: string, input?: unknown): Promise<unknown> => {
    if (name === 'audio.start' && !rejectOldStart) {
      await request(name, input);
      return new Promise<unknown>((_, reject): void => { rejectOldStart = reject; });
    }
    return request(name, input);
  };
  await start();
  await until((): boolean => rejectOldStart !== undefined);
  await stop();
  await until((): boolean => !automatic().disabled);
  await start();
  await until((): boolean => fixture.audio.state === 'starting');
  ready();
  const stopsBefore: number = fixture.calls.filter((call): boolean => call.name === 'audio.stop').length;
  rejectOldStart!(new Error('Old Start timed out'));
  await new Promise<number>(requestAnimationFrame);
  check(fixture.calls.filter((call): boolean => call.name === 'audio.stop').length === stopsBefore && label().dataset.state === 'listening', 'Old Start failure must not stop a newer capture.');
  orca.plugin.request = request;
  await stop();
  await until((): boolean => !automatic().disabled);
  passed.push('late Start failure cannot stop a newer capture');

  fixture.failAudioStart = true;
  await start();
  await until((): boolean => label().dataset.state === 'error');
  check(label().textContent!.includes('permission denied'), 'Capture failure must remain visible.');
  check(fixture.audio.state === 'off', 'Failed start must not acquire capture.');
  fixture.failAudioStart = false;
  const failedStarts: number = fixture.calls.filter((call): boolean => call.name === 'audio.start').length;
  fixture.post('audio.status', { state: 'off', message: 'Off', session: null });
  await new Promise<number>(requestAnimationFrame);
  check(fixture.calls.filter((call): boolean => call.name === 'audio.start').length === failedStarts, 'Failed capture must not retry on idle status.');
  await stop();
  passed.push('permission failures are visible and do not start capture');

  await start();
  await until((): boolean => fixture.audio.state === 'starting');
  ready();
  orca.plugin.request = async (name: string, input?: unknown): Promise<unknown> => {
    if (name === 'audio.stop') throw new Error('Fixture disconnect');
    return request(name, input);
  };
  await stop();
  await until((): boolean => label().dataset.state === 'error');
  check(label().textContent!.includes('5 seconds'), 'Failed shutdown must explain watchdog expiry.');
  orca.plugin.request = request;
  await stop();
  await until((): boolean => !automatic().disabled);
  passed.push('revocation failure discloses watchdog shutdown and permits retry');

  fixture.post('audio.status', { state: 'listening', message: 'Capturing elsewhere', session: 'other-audio-session-1234' });
  fixture.post('audio.frame', { bands: Array<number>(24).fill(1), level: 1 });
  const peerStartsBefore: number = fixture.calls.filter((call): boolean => call.name === 'audio.start').length;
  const peerStopsBefore: number = fixture.calls.filter((call): boolean => call.name === 'audio.stop').length;
  await start();
  await stop();
  check(fixture.calls.filter((call): boolean => call.name === 'audio.start').length === peerStartsBefore, 'A second panel cannot take over another session.');
  check(fixture.calls.filter((call): boolean => call.name === 'audio.stop').length === peerStopsBefore, 'Revocation must not stop a peer session.');
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Other sessions must not animate this display.');
  fixture.post('audio.status', { state: 'off', message: 'Off', session: null });
  passed.push('peer capture sessions are read-only');

  await start();
  await until((): boolean => fixture.audio.state === 'starting');
  ready();
  fixture.post('audio.frame', { bands: [NaN], level: 2 });
  await until((): boolean => fixture.audio.state === 'off');
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Invalid input must clear bars and stop capture.');
  passed.push('invalid audio frames stop capture instead of faking output');
  await stop();
  await start();
  await until((): boolean => fixture.audio.state === 'starting');
  ready();
  window.dispatchEvent(new Event('pagehide'));
  await until((): boolean => fixture.audio.state === 'off');
  window.dispatchEvent(new Event('pageshow'));
  check(fixture.audio.state === 'off', 'Page restoration must not restart capture.');
  passed.push('page exit stops capture; restoring it never auto-starts');
  return passed;
}
