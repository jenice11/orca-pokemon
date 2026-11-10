import type { AudioStatus } from '../audio-protocol.ts';

declare const fixture: {
  failAudioStart: boolean;
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

function automatic(): HTMLInputElement { return document.getElementById('audio-autostart') as HTMLInputElement; }
async function start(): Promise<void> {
  await until((): boolean => !automatic().disabled);
  check(!automatic().checked, 'Each new capture must request consent after revocation.');
  automatic().click();
  check(!document.getElementById('audio-consent')!.hidden, 'Checking must open consent.');
  (document.getElementById('audio-allow') as HTMLButtonElement).click();
  await until((): boolean => !automatic().disabled && automatic().checked);
}
async function stop(): Promise<void> {
  const automatic: HTMLInputElement = document.getElementById('audio-autostart') as HTMLInputElement;
  await until((): boolean => !automatic.disabled);
  if (!automatic.checked) {
    automatic.click();
    (document.getElementById('audio-allow') as HTMLButtonElement).click();
    await until((): boolean => !automatic.disabled && automatic.checked);
  }
  automatic.click();
  await until((): boolean => !automatic.disabled);
}
function bars(): HTMLElement[] { return Array.from(document.querySelectorAll<HTMLElement>('#audio-bands span')); }
function label(): HTMLElement { return document.getElementById('audio-status')!; }
function ready(): void {
  fixture.post('audio.status', { state: 'listening', message: 'Spotify playing.', session: fixture.audio.session });
}

export async function run(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'Audio tests require the mock preview; never run against real capture.');
  const passed: string[] = [];
  await until((): boolean => !automatic().disabled);
  check(document.getElementById('audio-start') === null && document.getElementById('audio-stop') === null, 'Capture must not expose Start or Stop buttons.');
  check(fixture.calls.every((call): boolean => call.name !== 'audio.start'), 'Panel load must not request capture.');
  check(bars().length === 24 && bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Stopped display must be flat.');
  passed.push('capture remains off on load, with 24 flat spectrum bars');

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
  fixture.post('audio.frame', { bands: Array<number>(24).fill(0.6), level: 0.5 });
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0.6)'), 'Bars must reflect real input levels.');
  fixture.post('audio.frame', { bands: Array<number>(24).fill(0), level: 0 });
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Silence must be flat, not simulated.');
  (document.getElementById('motion') as HTMLButtonElement).click();
  fixture.post('audio.frame', { bands: Array<number>(24).fill(0.9), level: 0.8 });
  check(bars().every((bar: HTMLElement): boolean => bar.style.transform === 'scaleY(0)'), 'Motion pause must prevent bar updates.');
  check(label().textContent!.includes('display paused'), 'Paused display must disclose capture remains active.');
  (document.getElementById('motion') as HTMLButtonElement).click();
  await stop();
  await until((): boolean => !automatic().disabled);
  check(fixture.audio.state === 'off', 'Unchecking Always start must request capture shutdown.');
  passed.push('verified consent starts capture, input levels, silence, motion pause, and revocation');

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
