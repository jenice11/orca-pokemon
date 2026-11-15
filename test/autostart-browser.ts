declare const fixture: {
  failStorage: boolean;
  resolveAutoRead: ((value: unknown) => void) | null;
  notifyStorage(key: string): void;
  audio: { state: string };
  calls: { name?: string; method?: string; params?: { key: string; value?: unknown } }[];
};
declare const orca: { host: { call(method: string, params: unknown): Promise<unknown> } };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function entry(): HTMLButtonElement { return button('audio-enable'); }
function approved(): boolean { return !button('audio-disable').hidden; }
function button(id: string): HTMLButtonElement { return document.getElementById(id) as HTMLButtonElement; }
function confirmation(): HTMLElement { return document.getElementById('audio-consent')!; }
function starts(): number { return fixture.calls.filter((call): boolean => call.name === 'audio.start').length; }
function preferenceWrites(): unknown[] {
  return fixture.calls.filter((call): boolean => call.method === 'storage.set' && call.params?.key === 'audio.autostart.v1').map((call): unknown => call.params!.value);
}

async function until(condition: () => boolean): Promise<void> {
  for (let frame: number = 0; frame < 150; frame++) {
    if (condition()) return;
    await new Promise<number>(requestAnimationFrame);
  }
  throw new Error('Automatic-start test did not settle within 150 frames.');
}

export async function consent(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'Consent tests require the mock preview.');
  await until((): boolean => !entry().disabled);
  check(document.getElementById('audio-start') === null, 'Capture must not expose a Start button.');
  check(!approved() && starts() === 0, 'Default must be off.');
  entry().click();
  check(!confirmation().hidden && !approved(), 'Entry control must ask permission, not grant it.');
  check(preferenceWrites().length === 0 && starts() === 0, 'Opening consent must not save or capture.');
  button('audio-cancel').click();
  check(confirmation().hidden && preferenceWrites().length === 0, 'Cancel must write nothing.');

  fixture.failStorage = true;
  entry().click();
  button('audio-allow').click();
  await until((): boolean => !entry().disabled);
  check(!approved() && starts() === 0, 'Failed permission save must not enable automatic capture.');
  check(document.getElementById('audio-preference-status')!.textContent!.includes('Could not save'), 'Save failure must remain visible.');
  fixture.failStorage = false;
  button('audio-cancel').click();

  const call: typeof orca.host.call = orca.host.call;
  let resolveOldRead: ((value: unknown) => void) | undefined;
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.get' && (params as { key: string }).key === 'audio.autostart.v1') {
      return new Promise<unknown>((resolve): void => { resolveOldRead = resolve; });
    }
    return call(method, params);
  };
  fixture.notifyStorage('audio.autostart.v1');
  await until((): boolean => resolveOldRead !== undefined);
  orca.host.call = call;
  entry().click();
  button('audio-allow').click();
  await until((): boolean => !entry().disabled && approved());
  check(confirmation().hidden && preferenceWrites().includes(true), 'Allow must persist consent.');
  resolveOldRead!({ value: false });
  await new Promise<number>(requestAnimationFrame);
  check(approved(), 'An old preference read must not hide newly saved consent.');
  check(starts() === 1, 'Verified saved consent must start the current visible idle panel exactly once.');
  await until((): boolean => fixture.audio.state === 'starting');
  window.dispatchEvent(new Event('pagehide'));
  await until((): boolean => fixture.audio.state === 'off');
  check(approved() && !preferenceWrites().includes(false), 'Closing the panel must retain remembered consent.');
  return ['default off', 'confirmation required', 'Cancel writes nothing', 'failed save stays off', 'Allow persists consent', 'closing retains consent'];
}

export async function remembered(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'Remembered-consent tests require the mock preview.');
  await until((): boolean => !entry().disabled && fixture.audio.state === 'starting');
  check(approved() && entry().hidden && confirmation().hidden && starts() === 1, 'Remembered consent must start exactly once without another prompt.');
  window.dispatchEvent(new Event('pagehide'));
  await until((): boolean => fixture.audio.state === 'off');
  window.dispatchEvent(new Event('pageshow'));
  await new Promise<number>(requestAnimationFrame);
  check(starts() === 1 && approved(), 'Page exit must not trigger an automatic restart.');

  fixture.failStorage = true;
  button('audio-disable').click();
  await until((): boolean => !entry().disabled);
  check(approved() && document.getElementById('audio-preference-status')!.textContent!.includes('Future panels may still start'), 'Failed revoke must warn about persisted consent.');
  fixture.failStorage = false;
  button('audio-disable').click();
  await until((): boolean => !entry().disabled && !approved());
  check(preferenceWrites().includes(false) && fixture.audio.state === 'off', 'Disable visualizer must persist revocation.');
  return ['reload uses saved consent exactly once', 'page exit never loops', 'failed revocation warns', 'disable saves false'];
}

export async function delayedRead(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'Deferred-read tests require the mock preview.');
  await until((): boolean => fixture.resolveAutoRead !== null);
  window.dispatchEvent(new Event('pagehide'));
  fixture.resolveAutoRead!({ value: true });
  await until((): boolean => !entry().disabled);
  window.dispatchEvent(new Event('pageshow'));
  check(starts() === 0 && fixture.audio.state === 'off', 'Late saved consent must not capture after page exit.');
  return ['late preference response cannot defeat page exit'];
}

export async function failedRead(): Promise<string[]> {
  check(typeof fixture !== 'undefined', 'Read-failure tests require the mock preview.');
  await until((): boolean => !entry().disabled);
  check(starts() === 0 && !approved(), 'Unreadable preferences must fail closed.');
  return ['failed preference read never starts capture'];
}
