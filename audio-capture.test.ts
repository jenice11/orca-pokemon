import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AudioCapture } from './audio-capture.ts';
import { AUDIO_BANDS, audioFrame, audioSession, audioStatus, type AudioFrame, type AudioStatus } from './audio-protocol.ts';
import { registerAudio, type AudioWorkerApi } from './worker.ts';

function childFixture(): { child: ChildProcessWithoutNullStreams; signals: (NodeJS.Signals | number | undefined)[] } {
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  const child: ChildProcessWithoutNullStreams = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal?: NodeJS.Signals | number): boolean { signals.push(signal); return true; }
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, signals };
}

const session: string = 'test-audio-session-1234';
const frame: AudioFrame = { bands: Array<number>(AUDIO_BANDS).fill(0.5), level: 0.4 };

test('audio protocol validates finite bounded levels and sessions', (): void => {
  assert.deepEqual(audioFrame(frame), frame);
  for (const value of [null, {}, { bands: [0], level: 0 }, { bands: Array(24).fill(NaN), level: 0 }, { ...frame, level: Infinity }, { ...frame, bands: Array(24).fill(2) }]) {
    assert.throws((): AudioFrame => audioFrame(value));
  }
  assert.equal(audioSession({ session }), session);
  assert.throws((): string => audioSession({ session: '../../helper' }));
  assert.throws((): AudioStatus => audioStatus({ state: 'fake', message: '', session: null }));
});

test('controller and worker registration never start audio during initialization or status requests', async (): Promise<void> => {
  let launches: number = 0;
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => { launches++; return fixture.child; }, 'darwin');
  const handlers: Map<string, (input: unknown) => Promise<unknown>> = new Map();
  const api: AudioWorkerApi = { panels: {
    handle(name: string, handler: (input: unknown) => Promise<unknown>): void { handlers.set(name, handler); },
    post(): void {}
  } };
  registerAudio(api, capture);
  await handlers.get('audio.status')!(null);
  await handlers.get('audio.heartbeat')!({ session });
  await handlers.get('audio.stop')!({ session });
  await assert.rejects(handlers.get('audio.start')!({ session: 'invalid' }), /Invalid audio session/);
  assert.equal(launches, 0);
  capture.dispose();
});

test('explicit start is single-flight, streams validated frames, and stop closes capture', (context: TestContext): void => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const events: { name: string; payload: AudioStatus | AudioFrame }[] = [];
  let launches: number = 0;
  const capture: AudioCapture = new AudioCapture((name, payload): void => { events.push({ name, payload }); }, (): ChildProcessWithoutNullStreams => { launches++; return fixture.child; }, 'darwin');
  assert.equal(capture.start(session).state, 'starting');
  capture.start(session);
  assert.equal(launches, 1);
  assert.throws((): AudioStatus => capture.start('another-audio-session'), /another panel/);
  fixture.child.stdout.emit('data', '{"type":"rea');
  fixture.child.stdout.emit('data', 'dy"}\n');
  assert.equal(capture.status().state, 'listening');
  fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
  fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
  assert.equal(events.filter((event): boolean => event.name === 'audio.frame').length, 1);
  assert.equal(capture.stop('another-audio-session').state, 'listening');
  assert.equal(capture.stop(session).state, 'stopping');
  assert.deepEqual(fixture.signals, ['SIGTERM']);
  assert.ok(fixture.child.stdin.writableEnded);
  context.mock.timers.tick(1000);
  assert.deepEqual(fixture.signals, ['SIGTERM', 'SIGKILL']);
  fixture.child.emit('close', 0);
  assert.equal(capture.status().state, 'off');
  assert.equal(capture.status().session, null);
  capture.dispose();
});

test('valid audio messages can arrive in one large stdout chunk', (): void => {
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  try {
    capture.start(session);
    const line: string = JSON.stringify({ type: 'frame', ...frame }) + '\n';
    const chunk: string = '{"type":"ready"}\n' + line.repeat(Math.ceil(32769 / line.length));
    assert.ok(chunk.length > 32768);
    fixture.child.stdout.emit('data', chunk);
    assert.equal(capture.status().state, 'listening');
    assert.deepEqual(fixture.signals, []);
  } finally {
    void capture.dispose(true);
  }
});

test('lease expiry, stalled streams, and invalid data fail closed', (context: TestContext): void => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  for (const mode of ['lease', 'stalled', 'invalid', 'oversize', 'oversize-line', 'oversize-remainder']) {
    const fixture: ReturnType<typeof childFixture> = childFixture();
    const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
    capture.start(session);
    if (mode !== 'lease') fixture.child.stdout.emit('data', '{"type":"ready"}\n');
    if (mode === 'lease') {
      context.mock.timers.tick(4999);
      assert.equal(capture.status().state, 'starting');
      context.mock.timers.tick(1);
    }
    if (mode === 'stalled') {
      context.mock.timers.tick(4000);
      capture.heartbeat(session);
      context.mock.timers.tick(4001);
      assert.match(capture.status().message, /reopen the panel/i);
    }
    if (mode === 'invalid') fixture.child.stdout.emit('data', '{"type":"frame","bands":[],"level":0}\n');
    if (mode === 'oversize') fixture.child.stdout.emit('data', 'x'.repeat(33000));
    if (mode === 'oversize-line') fixture.child.stdout.emit('data', 'x'.repeat(8193) + '\n');
    if (mode === 'oversize-remainder') fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n' + 'x'.repeat(8193));
    assert.ok(fixture.signals.includes('SIGTERM'), mode);
    assert.equal(capture.status().state, mode === 'lease' ? 'stopping' : 'error');
    fixture.child.emit('close', 0);
    capture.dispose();
  }
});

test('connection, exit, and startup errors describe an available recovery action', (context: TestContext): void => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['connection', 'exit', 'startup']) {
    const fixture: ReturnType<typeof childFixture> = childFixture();
    const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
    try {
      capture.start(session);
      if (mode === 'connection') fixture.child.stdin.emit('error', new Error('Connection closed'));
      if (mode === 'exit') fixture.child.emit('close', 1);
      if (mode === 'startup') {
        for (let renewal: number = 0; renewal < 29; renewal++) {
          context.mock.timers.tick(4000);
          capture.heartbeat(session);
        }
        context.mock.timers.tick(4000);
      }
      assert.equal(capture.status().state, 'error', mode);
      assert.match(capture.status().message, /close and reopen the panel/i, mode);
      assert.doesNotMatch(capture.status().message, /press Start/i, mode);
    } finally {
      void capture.dispose(true);
    }
  }
});

test('heartbeats renew the lease without starting or restarting capture', (context: TestContext): void => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fixture: ReturnType<typeof childFixture> = childFixture();
  let launches: number = 0;
  const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => { launches++; return fixture.child; }, 'darwin');
  capture.start(session);
  context.mock.timers.tick(4000);
  capture.heartbeat(session);
  context.mock.timers.tick(4999);
  assert.equal(capture.status().state, 'starting');
  context.mock.timers.tick(1);
  assert.equal(capture.status().state, 'stopping');
  assert.equal(launches, 1);
  capture.dispose();
});

test('spawn failures, helper errors, and worker teardown keep capture stopped', (): void => {
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  capture.start(session);
  fixture.child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  fixture.child.emit('close', -2);
  assert.match(capture.status().message, /helper is missing/);
  assert.equal(capture.status().state, 'error');
  capture.dispose();
  const unsupported: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => { throw new Error('must not launch'); }, 'linux');
  assert.throws((): AudioStatus => unsupported.start(session), /macOS 26/);
  unsupported.dispose();
  const live: ReturnType<typeof childFixture> = childFixture();
  const active: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => live.child, 'darwin');
  active.start(session);
  active.dispose();
  assert.ok(live.child.stdin.writableEnded);
  assert.deepEqual(live.signals, ['SIGTERM']);
  assert.throws((): AudioStatus => active.start(session), /closed/);
});

test('post failures stop the helper without leaking raw audio or retrying', async (): Promise<void> => {
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const capture: AudioCapture = new AudioCapture(async (): Promise<void> => { throw new Error('bridge closed'); }, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  capture.start(session);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(capture.status().state, 'error');
  assert.ok(fixture.signals.includes('SIGTERM'));
  fixture.child.emit('close', 0);
  capture.dispose();
  let launches: number = 0;
  const disconnected: AudioCapture = new AudioCapture((): void => { throw new Error('bridge closed'); }, (): ChildProcessWithoutNullStreams => { launches++; return fixture.child; }, 'darwin');
  assert.equal(disconnected.start(session).state, 'error');
  assert.equal(disconnected.status().session, null);
  assert.equal(launches, 0);
  void disconnected.dispose();
});

test('a rejected post from an old capture cannot stop a newer capture', async (): Promise<void> => {
  const first: ReturnType<typeof childFixture> = childFixture();
  const second: ReturnType<typeof childFixture> = childFixture();
  let rejectOld: ((reason: Error) => void) | undefined;
  let launches: number = 0;
  let posts: number = 0;
  const capture: AudioCapture = new AudioCapture((): void | Promise<void> => {
    posts++;
    if (posts === 1) return new Promise<void>((_, reject): void => { rejectOld = reject; });
  }, (): ChildProcessWithoutNullStreams => ++launches === 1 ? first.child : second.child, 'darwin');
  capture.start(session);
  capture.stop(session);
  first.child.emit('close', 0);
  capture.start(session);
  rejectOld!(new Error('old bridge failed'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(capture.status().state, 'starting');
  assert.deepEqual(second.signals, []);
  void capture.dispose(true);
});

test('deactivation waits for shutdown and preserves forced termination', async (context: TestContext): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  capture.start(session);
  capture.stop(session);
  const closed: Promise<void> = capture.dispose();
  context.mock.timers.tick(1001);
  assert.equal(fixture.signals.at(-1), 'SIGKILL');
  fixture.child.emit('close', 0);
  await closed;
  const exitFixture: ReturnType<typeof childFixture> = childFixture();
  const exiting: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => exitFixture.child, 'darwin');
  exiting.start(session);
  await exiting.dispose(true);
  assert.deepEqual(exitFixture.signals, ['SIGKILL']);
});
