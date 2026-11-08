import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setupAudioVisualizer, type AudioBridge, type AudioVisualizer } from './panel/audio.ts';
import type { AudioStatus } from './audio-protocol.ts';

async function verifyReopen(context: TestContext, initialStatusEvent: boolean, previousCapture: boolean = false, initialPermission: unknown = true): Promise<void> {
  context.mock.timers.enable({ apis: ['setInterval'] });
  class Element extends EventTarget {
    disabled: boolean = false;
    hidden: boolean = false;
    checked: boolean = false;
    textContent: string = '';
    dataset: Record<string, string> = {};
    style: { transform: string } = { transform: '' };
    append(): void {}
    focus(): void {}
  }
  const elements: Map<string, Element> = new Map();
  const documentMock: EventTarget & { hidden: boolean; getElementById(id: string): Element; createElement(): Element } = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById(id: string): Element {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id)!;
    },
    createElement(): Element { return new Element(); }
  });
  const originalDocument: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  let status: AudioStatus = previousCapture
    ? { state: 'listening', session: 'previous-panel-session-1234', message: 'Capturing' }
    : { state: 'off', session: null, message: 'Off' };
  let starts: number = 0;
  let failStart: boolean = false;
  let heartbeats: number = 0;
  let permission: unknown = initialPermission;
  let writes: number = 0;
  let delayNextStop: boolean = false;
  let finishStop: (() => void) | undefined;
  let readPermission: (() => Promise<unknown>) | undefined;
  const listeners: Map<string, (value: unknown) => void> = new Map();
  const bridge: AudioBridge = {
    async request(name: string, input?: unknown): Promise<unknown> {
      if (name === 'audio.heartbeat') {
        heartbeats++;
      } else if (name === 'audio.start') {
        starts++;
        if (failStart) throw new Error('Capture permission denied');
        status = { state: 'listening', session: (input as { session: string }).session, message: 'Capturing' };
      } else if (name === 'audio.stop') {
        if (delayNextStop) {
          delayNextStop = false;
          await new Promise<void>((resolve): void => { finishStop = resolve; });
        }
        status = { state: 'off', session: null, message: 'Off' };
      }
      if (name !== 'audio.status' || initialStatusEvent) listeners.get('audio.status')?.(status);
      return status;
    },
    on(event: string, handler: (value: unknown) => void): { dispose(): void } {
      listeners.set(event, handler);
      return { dispose(): void { listeners.delete(event); } };
    }
  };
  let visualizer: AudioVisualizer | undefined;
  async function settle(): Promise<void> { for (let tick: number = 0; tick < 20; tick++) await Promise.resolve(); }
  function visible(value: boolean): void {
    documentMock.hidden = !value;
    documentMock.dispatchEvent(new Event('visibilitychange'));
  }
  try {
    visualizer = setupAudioVisualizer(bridge, false, {
      async call(method: string, params: unknown): Promise<unknown> {
        if (method === 'storage.set') {
          writes++;
          permission = (params as { value: unknown }).value;
          return null;
        }
        return readPermission ? readPermission() : { value: permission };
      }
    });
    await settle();
    if (initialPermission !== true) {
      const automatic: Element = elements.get('audio-autostart')!;
      assert.equal(automatic.checked, false, 'Only literal true grants saved consent.');
      assert.equal(starts, 0);
      automatic.checked = true;
      automatic.dispatchEvent(new Event('change'));
      assert.equal(automatic.checked, false, 'Checking opens consent without granting permission.');
      assert.equal(elements.get('audio-consent')!.hidden, false);
      assert.equal(writes, 0);
      elements.get('audio-cancel')!.dispatchEvent(new Event('click'));
      await settle();
      assert.equal(starts, 0, 'Cancel must not capture.');
      assert.equal(writes, 0, 'Cancel must not persist consent.');
      automatic.checked = true;
      automatic.dispatchEvent(new Event('change'));
      let verifySavedPermission: ((value: unknown) => void) | undefined;
      readPermission = (): Promise<unknown> => new Promise<unknown>((resolve): void => { verifySavedPermission = resolve; });
      elements.get('audio-allow')!.dispatchEvent(new Event('click'));
      await settle();
      assert.equal(starts, 0, 'Allow must wait for saved consent verification.');
      assert.equal(writes, 1);
      verifySavedPermission!({ value: permission });
      readPermission = undefined;
      await settle();
      assert.equal(automatic.checked, true);
    }
    if (previousCapture) {
      assert.equal(starts, 0, 'Reopening must not take over a previous capture.');
      status = { state: 'off', session: null, message: 'Off' };
      listeners.get('audio.status')!(status);
      await settle();
    }
    assert.equal(starts, 1, 'Saved consent must start even when a status event arrives during initialization.');
    context.mock.timers.tick(999);
    assert.equal(heartbeats, 0);
    context.mock.timers.tick(1);
    await settle();
    assert.equal(heartbeats, 1, 'Visible capture must renew its lease every second.');
    context.mock.timers.tick(1000);
    await settle();
    assert.equal(heartbeats, 2, 'Heartbeat renewal must continue after a status response.');
    for (let cycle: number = 1; cycle <= 3; cycle++) {
      if (cycle === 2) {
        visible(false);
        visible(true);
        await settle();
      }
      const startsBefore: number = starts;
      delayNextStop = cycle === 2;
      visible(false);
      if (cycle === 2) {
        visible(true);
        await settle();
        assert.equal(starts, startsBefore, 'A quick reopen must wait for the old capture to stop.');
        finishStop!();
      }
      await settle();
      if (cycle !== 2) assert.equal(status.state, 'off', 'Hiding must stop capture.');
      visible(true);
      await settle();
      assert.equal(starts, startsBefore + 1, 'Each reopen must start exactly once.');
      permission = false;
      visualizer.preferenceChanged('audio.autostart.v1');
      await settle();
      permission = true;
      visualizer.preferenceChanged('audio.autostart.v1');
      await settle();
      visible(true);
      await settle();
      assert.equal(status.state, 'off', 'Restoring consent must stay paused until the next real reopen.');
      assert.equal(starts, startsBefore + 1);
      const heartbeatsBefore: number = heartbeats;
      context.mock.timers.tick(1000);
      await settle();
      assert.equal(heartbeats, heartbeatsBefore, 'Stopped capture must not send heartbeats.');
    }
    let resolvePermission: ((value: unknown) => void) | undefined;
    readPermission = (): Promise<unknown> => new Promise<unknown>((resolve): void => { resolvePermission = resolve; });
    permission = false;
    visualizer.preferenceChanged('audio.autostart.v1');
    visible(false);
    visible(true);
    await settle();
    assert.equal(starts, 5, 'Reopening must wait for a pending permission refresh.');
    resolvePermission!({ value: false });
    readPermission = undefined;
    await settle();
    assert.equal(starts, 5, 'A late revocation must not permit capture.');
    permission = true;
    visualizer.preferenceChanged('audio.autostart.v1');
    await settle();
    readPermission = async (): Promise<unknown> => { throw new Error('Preference unavailable'); };
    visualizer.preferenceChanged('audio.autostart.v1');
    await settle();
    visible(false);
    visible(true);
    await settle();
    assert.equal(starts, 5, 'Unreadable consent must block automatic starts despite cached permission.');
    readPermission = undefined;
    permission = false;
    visualizer.preferenceChanged('audio.autostart.v1');
    await settle();
    visible(false);
    visible(true);
    await settle();
    assert.equal(starts, 5, 'Revoked consent must prevent automatic starts.');
    if (initialPermission === false) {
      const automatic: Element = elements.get('audio-autostart')!;
      status = { state: 'error', session: null, message: 'Previous capture failed' };
      listeners.get('audio.status')!(status);
      failStart = true;
      automatic.checked = true;
      automatic.dispatchEvent(new Event('change'));
      elements.get('audio-allow')!.dispatchEvent(new Event('click'));
      await settle();
      assert.equal(starts, 6, 'New Allow must permit one attempt after a sessionless error.');
      status = { state: 'error', session: null, message: 'Capture permission denied' };
      for (let update: number = 0; update < 3; update++) {
        listeners.get('audio.status')!(status);
        visible(true);
        await settle();
      }
      assert.equal(starts, 6, 'Errors and repeated visible events must not retry a failed attempt.');
      visible(false);
      visible(true);
      await settle();
      assert.equal(starts, 7, 'A genuine reopen must permit one attempt after a sessionless error.');
      listeners.get('audio.status')!({ state: 'off', session: null, message: 'Off' });
      listeners.get('audio.status')!(status);
      await settle();
      assert.equal(starts, 7, 'Status changes after the reopen attempt must not create a retry loop.');
    }
  } finally {
    visualizer?.dispose();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('remembered consent survives panel reopen', (context: TestContext): Promise<void> => verifyReopen(context, false));
test('early status events do not suppress remembered capture on open or reopen', (context: TestContext): Promise<void> => verifyReopen(context, true));
test('quick reopen waits for the previous panel lease to expire before starting', (context: TestContext): Promise<void> => verifyReopen(context, true, true));
for (const permission of [false, null, 'true', 1]) {
  test(`consent UI starts the current panel only after Allow with stored ${JSON.stringify(permission)}`, (context: TestContext): Promise<void> => verifyReopen(context, true, false, permission));
}
