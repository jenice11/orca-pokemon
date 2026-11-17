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

test('repeated stop and teardown preserve the first forced-kill deadline', async (context: TestContext): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const capture: AudioCapture = new AudioCapture((): void => {}, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  capture.start(session);
  capture.stop(session);
  context.mock.timers.tick(600);
  capture.stop(session);
  capture.heartbeat(session);
  const closed: Promise<void> = capture.dispose();
  context.mock.timers.tick(399);
  assert.deepEqual(fixture.signals, ['SIGTERM']);
  context.mock.timers.tick(1);
  assert.deepEqual(fixture.signals, ['SIGTERM', 'SIGKILL']);
  fixture.child.emit('close', 0);
  await closed;
});

test('ready capture with silent frames never claims Spotify playback', (context: TestContext): void => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const statuses: AudioStatus[] = [];
  const frames: AudioFrame[] = [];
  const capture: AudioCapture = new AudioCapture((name, payload): void => {
    if (name === 'audio.status') statuses.push(payload as AudioStatus);
    else frames.push(payload as AudioFrame);
  }, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  try {
    capture.start(session);
    fixture.child.stdout.emit('data', '{"type":"ready"}\n');
    assert.equal(capture.status().message, 'Capturing Spotify output.');
    const silent: AudioFrame = { bands: Array<number>(AUDIO_BANDS).fill(0), level: 0 };
    for (let second: number = 0; second < 10; second++) {
      context.mock.timers.tick(1000);
      capture.heartbeat(session);
      fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...silent }) + '\n');
    }
    assert.equal(capture.status().state, 'listening');
    assert.equal(capture.status().message, 'Capturing Spotify output.');
    assert.equal(frames.length, 10);
    assert.ok(frames.every((value): boolean => value.level === 0 && value.bands.every((band): boolean => band === 0)));
    assert.ok(statuses.every((value): boolean => !/playing/i.test(value.message)));
    capture.stop(session);
    fixture.child.emit('close', 0);
    assert.equal(capture.status().message, 'Audio capture off.');
  } finally {
    void capture.dispose(true);
  }
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

test('stalled posts stop capture despite continuing frames and heartbeats', async (context: TestContext): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  for (const stalledEvent of ['audio.frame', 'audio.status'] as const) {
    const fixture: ReturnType<typeof childFixture> = childFixture();
    let framePosts: number = 0;
    let releasePost: (() => void) | undefined;
    const capture: AudioCapture = new AudioCapture((event): void | Promise<void> => {
      if (event === 'audio.frame') framePosts++;
      if (event === stalledEvent) return new Promise<void>((resolve): void => { releasePost = resolve; });
    }, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
    try {
      capture.start(session);
      fixture.child.stdout.emit('data', '{"type":"ready"}\n');
      fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
      for (let second: number = 0; second < 4; second++) {
        context.mock.timers.tick(1000);
        capture.heartbeat(session);
        fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
      }
      assert.equal(capture.status().state, 'listening');
      if (stalledEvent === 'audio.frame') assert.equal(framePosts, 1, 'Only one frame publication may remain pending.');
      context.mock.timers.tick(1000);
      assert.equal(capture.status().state, 'error', 'Delivery must have its own deadline, independent of heartbeats.');
      assert.deepEqual(fixture.signals, ['SIGTERM']);
      releasePost!();
      await Promise.resolve();
      context.mock.timers.tick(1000);
      assert.deepEqual(fixture.signals, ['SIGTERM', 'SIGKILL']);
    } finally { await capture.dispose(true); }
  }
});

test('frame delivery completion permits the next frame without leaving a timeout', async (context: TestContext): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fixture: ReturnType<typeof childFixture> = childFixture();
  let framePosts: number = 0;
  let releasePost: (() => void) | undefined;
  const capture: AudioCapture = new AudioCapture((event): void | Promise<void> => {
    if (event !== 'audio.frame') return;
    framePosts++;
    if (framePosts === 1) return new Promise<void>((resolve): void => { releasePost = resolve; });
  }, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  try {
    capture.start(session);
    fixture.child.stdout.emit('data', '{"type":"ready"}\n');
    fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
    releasePost!();
    await Promise.resolve();
    for (let second: number = 0; second < 6; second++) {
      context.mock.timers.tick(1000);
      capture.heartbeat(session);
      fixture.child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
    }
    assert.equal(framePosts, 7);
    assert.equal(capture.status().state, 'listening');
    assert.deepEqual(fixture.signals, []);
  } finally { await capture.dispose(true); }
});

test('shutdown status waits for post capacity and publishes when delivery resumes', async (): Promise<void> => {
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const deliveries: (() => void)[] = [];
  const events: (AudioStatus | AudioFrame)[] = [];
  const capture: AudioCapture = new AudioCapture((event, payload): Promise<void> => {
    events.push(payload);
    return new Promise<void>((resolve): void => { deliveries.push(resolve); });
  }, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  try {
    capture.start(session);
    fixture.child.stdout.emit('data', '{"type":"ready"}\n' + JSON.stringify({ type: 'frame', ...frame }) + '\n');
    capture.stop(session);
    fixture.child.emit('close', 0);
    assert.equal(events.length, 4, 'Shutdown must not exceed the unresolved post limit.');
    assert.equal(capture.status().state, 'off', 'Healthy delayed posts must not turn shutdown into an error.');
    deliveries[0]();
    await Promise.resolve();
    assert.equal(events.length, 5);
    assert.deepEqual(events[4], capture.status(), 'Capacity must deliver the sessionless shutdown status.');
    for (const deliver of deliveries.slice(1)) deliver();
    await Promise.resolve();
    assert.equal(events.length, 5, 'Each final status must publish only once.');
  } finally { await capture.dispose(true); }
});

test('deferred shutdown status cannot publish after a new start or disposal', async (): Promise<void> => {
  for (const action of ['start', 'dispose'] as const) {
    const fixture: ReturnType<typeof childFixture> = childFixture();
    const deliveries: (() => void)[] = [];
    const capture: AudioCapture = new AudioCapture((): Promise<void> =>
      new Promise<void>((resolve): void => { deliveries.push(resolve); }),
    (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
    try {
      capture.start(session);
      fixture.child.stdout.emit('data', '{"type":"ready"}\n' + JSON.stringify({ type: 'frame', ...frame }) + '\n');
      capture.stop(session);
      fixture.child.emit('close', 0);
      if (action === 'start') assert.equal(capture.start(session).state, 'error');
      else await capture.dispose(true);
      for (const deliver of deliveries) deliver();
      await Promise.resolve();
      assert.equal(deliveries.length, 4, 'An obsolete deferred status must not publish.');
    } finally { await capture.dispose(true); }
  }
});

test('deferred helper errors retain their diagnostic when a rejected post releases capacity', async (): Promise<void> => {
  const fixture: ReturnType<typeof childFixture> = childFixture();
  const deliveries: { resolve(): void; reject(reason: Error): void }[] = [];
  const events: (AudioStatus | AudioFrame)[] = [];
  const capture: AudioCapture = new AudioCapture((event, payload): Promise<void> => {
    events.push(payload);
    return new Promise<void>((resolve, reject): void => { deliveries.push({ resolve, reject }); });
  }, (): ChildProcessWithoutNullStreams => fixture.child, 'darwin');
  try {
    capture.start(session);
    fixture.child.stdout.emit('data', '{"type":"ready"}\n' + JSON.stringify({ type: 'frame', ...frame }) + '\n');
    fixture.child.stdout.emit('data', '{"type":"error","message":"Spotify permission denied."}\n');
    fixture.child.emit('close', 1);
    assert.equal(events.length, 4);
    deliveries[0].reject(new Error('Old starting post rejected'));
    await Promise.resolve();
    assert.deepEqual(events[4], { state: 'error', session: null, message: 'Spotify permission denied.' });
    for (const delivery of deliveries.slice(1)) delivery.resolve();
    await Promise.resolve();
    assert.equal(events.length, 5);
  } finally { await capture.dispose(true); }
});

test('deferred helper errors survive current-generation rejection before helper close', async (): Promise<void> => {
  const children: ReturnType<typeof childFixture>[] = [childFixture(), childFixture()];
  const deliveries: { resolve(): void; reject(reason: Error): void }[] = [];
  const events: (AudioStatus | AudioFrame)[] = [];
  let launches: number = 0;
  const capture: AudioCapture = new AudioCapture((event, payload): Promise<void> => {
    events.push(payload);
    return new Promise<void>((resolve, reject): void => { deliveries.push({ resolve, reject }); });
  }, (): ChildProcessWithoutNullStreams => children[launches++].child, 'darwin');
  try {
    capture.start(session);
    capture.stop(session);
    children[0].child.emit('close', 0);
    deliveries[1].resolve();
    deliveries[2].resolve();
    await Promise.resolve();
    assert.equal(capture.start(session).state, 'starting');
    children[1].child.stdout.emit('data', '{"type":"ready"}\n' + JSON.stringify({ type: 'frame', ...frame }) + '\n');
    children[1].child.stdout.emit('data', '{"type":"error","message":"Spotify permission denied."}\n');
    assert.equal(events.length, 6, 'The error must wait while all four publication slots are occupied.');
    deliveries[3].reject(new Error('Current starting post rejected'));
    await Promise.resolve();
    assert.deepEqual(events[6], { state: 'error', session, message: 'Spotify permission denied.' });
    children[1].child.emit('close', 1);
    deliveries[0].resolve();
    await Promise.resolve();
    assert.deepEqual(events[7], { state: 'error', session: null, message: 'Spotify permission denied.' });
    for (const delivery of deliveries.slice(4)) delivery.resolve();
    await Promise.resolve();
    assert.equal(events.length, 8, 'Old posts must only release capacity, never replay old status.');
  } finally { await capture.dispose(true); }
});

test('unresolved posts remain bounded across capture restarts', async (context: TestContext): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const children: ReturnType<typeof childFixture>[] = [childFixture(), childFixture()];
  let launches: number = 0;
  let posts: number = 0;
  const capture: AudioCapture = new AudioCapture((): Promise<void> => {
    posts++;
    return new Promise<void>((): void => {});
  }, (): ChildProcessWithoutNullStreams => children[launches++].child, 'darwin');
  try {
    capture.start(session);
    capture.stop(session);
    children[0].child.emit('close', 0);
    capture.start(session);
    capture.stop(session);
    children[1].child.emit('close', 0);
    assert.equal(capture.start(session).state, 'error');
    assert.equal(launches, 2, 'An exhausted bridge must fail before launching another helper.');
    assert.equal(posts, 4, 'Unresolved publications must not accumulate across restarts.');
  } finally { await capture.dispose(true); }
});

test('an old frame completion cannot release a newer pending frame', async (context: TestContext): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const children: ReturnType<typeof childFixture>[] = [childFixture(), childFixture()];
  const deliveries: (() => void)[] = [];
  let launches: number = 0;
  const capture: AudioCapture = new AudioCapture((event): void | Promise<void> => {
    if (event === 'audio.frame') return new Promise<void>((resolve): void => { deliveries.push(resolve); });
  }, (): ChildProcessWithoutNullStreams => children[launches++].child, 'darwin');
  try {
    capture.start(session);
    children[0].child.stdout.emit('data', '{"type":"ready"}\n' + JSON.stringify({ type: 'frame', ...frame }) + '\n');
    capture.stop(session);
    children[0].child.emit('close', 0);
    capture.start(session);
    children[1].child.stdout.emit('data', '{"type":"ready"}\n' + JSON.stringify({ type: 'frame', ...frame }) + '\n');
    assert.equal(deliveries.length, 2);
    deliveries[0]();
    await Promise.resolve();
    context.mock.timers.tick(110);
    children[1].child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
    assert.equal(deliveries.length, 2, 'Old completion must leave the newer frame pending.');
    deliveries[1]();
    await Promise.resolve();
    context.mock.timers.tick(110);
    children[1].child.stdout.emit('data', JSON.stringify({ type: 'frame', ...frame }) + '\n');
    assert.equal(deliveries.length, 3);
    assert.equal(capture.status().state, 'listening');
  } finally { await capture.dispose(true); }
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
