import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { setupAudioVisualizer, type AudioBridge, type AudioVisualizer } from './panel/audio.ts';
import type { AudioStatus } from './audio-protocol.ts';

test('footer power controls stay accessible and credits exclude usage instructions', (): void => {
  const html: string = readFileSync(new URL('./panel/index.html', import.meta.url), 'utf8');
  const css: string = readFileSync(new URL('./panel/style.css', import.meta.url), 'utf8');
  assert.match(html, /Spotify and its child processes on supported Windows releases/);
  assert.match(html, /id="audio-enable"[^>]*aria-label="Allow Spotify visualizer"[^>]*aria-pressed="false"[^>]*><svg/);
  assert.match(html, /id="audio-disable"[^>]*aria-label="Disable visualizer"[^>]*aria-pressed="true"[^>]*><svg/);
  const offButton: string = html.match(/<button id="audio-enable"[\s\S]*?<\/button>/)![0];
  const onButton: string = html.match(/<button id="audio-disable"[\s\S]*?<\/button>/)![0];
  assert.match(offButton, /<circle/);
  assert.match(offButton, /class="spotify-slash"/);
  assert.match(onButton, /<circle/);
  assert.doesNotMatch(onButton, /spotify-slash/);
  const credits: string = html.match(/<div id="credits-popup"[\s\S]*?<\/div>/)![0];
  assert.match(credits, /popover="auto" role="dialog" aria-labelledby="credits-title"/);
  assert.match(credits, /popovertarget="credits-popup" popovertargetaction="hide"/);
  assert.doesNotMatch(credits, /Refresh after|Click a Pokémon/);
  const header: string = html.match(/<header>[\s\S]*?<\/header>/)![0];
  const footer: string = html.match(/<footer class="bottom-bar">[\s\S]*?<\/footer>/)![0];
  assert.match(header, /id="usage-help"[^>]*popovertarget="usage-tooltip"[^>]*aria-label="How to use"/);
  assert.match(header, /id="usage-tooltip" popover="auto"/);
  assert.match(header, /Click a Pokémon|Refresh after an agent exits/);
  assert.doesNotMatch(footer, /Click a Pokémon|Refresh after an agent exits/);
  assert.match(css, /footer \{[^}]*font-size: 12px;/);
  assert.match(html, /class="audio-dock">\s*<section id="audio-card"[\s\S]*?<\/section>\s*<div class="audio-notices">[\s\S]*?<\/div>\s*<\/div>\s*<footer class="bottom-bar">/);
  assert.doesNotMatch(footer, /id="audio-status"|id="audio-preference-status"/);
  assert.match(footer, /id="audio-enable"/);
  assert.match(footer, /id="audio-disable"/);
  assert.match(footer, /id="credits-button"[^>]*popovertarget="credits-popup"/);
  assert.doesNotMatch(html.match(/<main>[\s\S]*?<\/main>/)![0], /id="audio-enable"|id="credits-button"/);
  assert.match(css, /\.bottom-bar-controls \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.bottom-bar-controls > button\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.audio-controls \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.audio-controls button \{[^}]*width: 100%;/);
  assert.match(offButton, /<\/svg><span[^>]*>Spotify<\/span>/);
  assert.match(onButton, /<\/svg><span[^>]*>Spotify<\/span>/);
  assert.match(footer, /id="credits-button"[\s\S]*?<\/svg><span>About<\/span>/);
  assert.match(css, /#credits-popup \{[^}]*position: fixed;/);
  assert.match(html, /id="audio-status" role="status" data-state="off"><\/p>/);
  assert.match(css, /#audio-status\[data-state="off"\] \{ display: none; \}/);
  assert.match(css, /\.audio-dock \{ position: relative;/);
  assert.match(css, /\.audio-notices \{ position: absolute;[^}]*bottom: calc\(100% \+ 8px\);/);
  assert.match(css, /background: color-mix\(in srgb, var\(--orca-card, #20232a\) 80%, transparent\)/);
  assert.match(css, /#audio-status \{[^}]*animation: audio-toast 5s forwards;/);
  assert.doesNotMatch(css, /(?:\.audio-notices > p|#audio-preference-status) \{[^}]*animation:/);
  assert.doesNotMatch(css, /#audio-status\[data-quiet="true"\]/);
  assert.match(css, /@keyframes audio-toast[^}]*\} 100% \{ opacity: 0; visibility: hidden;/);
});

test('native permission and recovery text names existing panel controls', (): void => {
  const source: string = readFileSync(new URL('./native/SpotifyAudioHelper.swift', import.meta.url), 'utf8');
  const plist: string = readFileSync(new URL('./native/Info.plist', import.meta.url), 'utf8');
  const windowsScript: string = readFileSync(new URL('./native/SpotifyAudioHelper.Windows.ps1', import.meta.url), 'utf8');
  const windowsHelper: string = readFileSync(new URL('./native/SpotifyAudioHelper.Windows.cs', import.meta.url), 'utf8');
  assert.doesNotMatch(source + plist, /\b(?:click|press) Start\b/i);
  assert.match(source, /then click Refresh in the panel/);
  assert.match(plist, /after you allow automatic capture in the panel/);
  assert.match(windowsScript, /Add-Type -TypeDefinition/);
  assert.match(windowsHelper, /LoopbackFlag = 0x00020000/);
  assert.match(windowsHelper, /ActivateAudioInterfaceAsync/);
  assert.match(windowsHelper, /SpotifyProcessTreeRoots/);
  assert.match(windowsHelper, /ProcessIdToSessionId/);
  assert.match(windowsHelper, /GetDefaultAudioEndpoint/);
  assert.match(windowsHelper, /allApps && spotifySupported/);
  assert.match(windowsHelper, /WatchInput/);
});

interface MockAnimation {
  playState: string;
  pause(): void;
  play(): void;
  cancel(): void;
}

async function verifyReopen(context: TestContext, initialStatusEvent: boolean, previousCapture: boolean = false, initialPermission: unknown = true, refreshScenario?: string, scope: 'spotify' | 'all-app' | 'unsupported' | 'failure' = 'spotify', initialAllAppPermission: unknown = false): Promise<void> {
  context.mock.timers.enable({ apis: ['setInterval'] });
  class Element extends EventTarget {
    animation: MockAnimation | undefined;
    animationFrames: Keyframe[] = [];
    animationOptions: KeyframeAnimationOptions = {};
    animate(frames: Keyframe[], options: KeyframeAnimationOptions): MockAnimation {
      this.animationFrames = frames;
      this.animationOptions = options;
      const animation: MockAnimation = {
        playState: 'running',
        pause(): void { this.playState = 'paused'; },
        play(): void { this.playState = 'running'; },
        cancel(): void { this.playState = 'idle'; }
      };
      this.animation = animation;
      return animation;
    }
    disabled: boolean = false;
    hidden: boolean = false;
    open: boolean = false;
    showModal(): void { this.open = true; }
    close(): void { this.open = false; }
    textContent: string = '';
    title: string = '';
    ariaLabel: string = '';
    dataset: Record<string, string> = {};
    style: { transform: string } = { transform: '' };
    setAttribute(name: string, value: string): void { if (name === 'aria-label') this.ariaLabel = value; }
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
  const pendingHeartbeats: ((error?: Error) => void)[] = [];
  let spotifyPermission: unknown = initialPermission;
  let allAppsPermission: unknown = initialAllAppPermission;
  let permission: unknown = scope === 'all-app' ? initialAllAppPermission : initialPermission;
  let writes: number = 0;
  let delayNextStop: boolean = false;
  let stopReturnsStopping: boolean = false;
  let finishStop: (() => void) | undefined;
  let readPermission: (() => Promise<unknown>) | undefined;
  const startedScopes: unknown[] = [];
  const listeners: Map<string, (value: unknown) => void> = new Map();
  const bridge: AudioBridge = {
    async request(name: string, input?: unknown): Promise<unknown> {
      if (name === 'audio.capabilities') {
        if (scope === 'failure') throw new Error('Capability lookup failed.');
        return { scope, message: scope === 'all-app'
          ? 'Spotify-only capture is unavailable on this Windows release. You can choose shared audio from the default output device instead.'
          : scope === 'unsupported' ? 'Spotify-only audio capture is unavailable on this Windows release.' : '' };
      }
      if (name === 'audio.heartbeat') {
        heartbeats++;
        if (refreshScenario?.startsWith('pending-heartbeat') && heartbeats <= 2) {
          const reply: AudioStatus = { ...status };
          await new Promise<void>((resolve, reject): void => {
            pendingHeartbeats.push((error?: Error): void => { if (error) reject(error); else resolve(); });
          });
          return reply;
        }
      } else if (name === 'audio.start') {
        starts++;
        startedScopes.push((input as { scope: unknown }).scope);
        if (failStart) throw new Error('Capture permission denied');
        status = { state: 'listening', session: (input as { session: string }).session, message: 'Capturing' };
      } else if (name === 'audio.stop') {
        if (stopReturnsStopping) {
          status = { state: 'stopping', session: status.session, message: 'Stopping' };
          listeners.get('audio.status')?.(status);
          return status;
        }
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
        if (initialPermission instanceof Error) throw initialPermission;
        if (method === 'storage.set') {
          writes++;
          const key: string = (params as { key: string; value: unknown }).key;
          const value: unknown = (params as { key: string; value: unknown }).value;
          if (key === 'audio.all-app-autostart.v1') allAppsPermission = value;
          else spotifyPermission = value;
          if (key === (scope === 'all-app' ? 'audio.all-app-autostart.v1' : 'audio.autostart.v1')) permission = value;
          return null;
        }
        const key: string = (params as { key: string }).key;
        if (key === 'audio.all-app-autostart.v1') return readPermission ? readPermission() : { value: allAppsPermission };
        return readPermission ? readPermission() : { value: permission };
      }
    });
    assert.equal(elements.get('audio-loader')!.hidden, false, 'Initialization must show a loader before saved permission resolves.');
    assert.equal(elements.get('audio-bands')!.hidden, true);
    assert.equal(elements.get('audio-idle')!.hidden, true, 'Loading must not show an idle sprite.');
    await settle();
    if (scope === 'unsupported') {
      assert.equal(starts, 0, 'Unsupported Windows releases must not start capture, even with saved permission.');
      assert.equal(elements.get('audio-card')!.hidden, true);
      assert.equal(elements.get('audio-enable')!.disabled, true);
      assert.match(elements.get('audio-preference-status')!.textContent, /unavailable on this Windows release/);
      assert.match(elements.get('audio-enable')!.title, /unavailable on this Windows release/);
      return;
    }
    if (scope === 'failure') {
      assert.equal(starts, 0, 'Unverified capture support must not start capture.');
      assert.equal(elements.get('audio-card')!.hidden, true);
      assert.equal(elements.get('audio-enable')!.disabled, true);
      assert.match(elements.get('audio-preference-status')!.textContent, /Could not verify audio capture support/);
      return;
    }
    if (scope === 'all-app') {
      assert.equal(elements.get('audio-title')!.textContent, 'All-app audio');
      assert.equal(elements.get('audio-bands')!.ariaLabel, 'All-app output frequency spectrum');
      assert.match(elements.get('audio-consent-description')!.textContent, /visualizer analyzes audio from all apps/);
      assert.match(elements.get('audio-preference-status')!.textContent, /unavailable on this Windows release/);
      assert.match(elements.get('audio-enable')!.title, /Spotify-only capture is unavailable/);
      assert.equal(elements.get('audio-enable-label')!.textContent, 'All apps');
      assert.equal(elements.get('audio-allow')!.textContent, 'Allow');
      assert.equal(elements.get('audio-cancel')!.textContent, 'No');
    }
    if (initialPermission instanceof Error) {
      assert.equal(elements.get('audio-card')!.hidden, true, 'Unverified permission must keep the visualizer hidden.');
      assert.equal(starts, 0);
      visualizer.refresh();
      await settle();
      assert.equal(starts, 0, 'Refresh must not grant capture permission.');
      assert.equal(elements.get('audio-loader')!.hidden, true, 'A failed permission load must finish initialization despite an early status event.');
      assert.match(elements.get('audio-preference-status')!.textContent, /Could not load/);
      return;
    }
    assert.equal(elements.has('audio-stop'), false, 'The visualizer must not require a Stop button.');
    assert.equal(elements.has('audio-start'), false, 'Capture eligibility must not depend on a Start button.');
    assert.equal(elements.has('audio-autostart'), false, 'Saved consent must not depend on a checkbox.');
    if (permission === true) {
      assert.equal(elements.get('audio-card')!.hidden, false, 'Remembered enable must show the visualizer.');
      assert.equal(elements.get('audio-enable')!.hidden, true, 'Saved permission must hide the entry control.');
      assert.equal(elements.get('audio-disable')!.hidden, false, 'Saved permission must expose revocation.');
    }
    if (permission !== true) {
      assert.equal(elements.get('audio-card')!.hidden, true, 'Disabled visualizer must disappear.');
      const automatic: Element = elements.get('audio-enable')!;
      assert.equal(automatic.hidden, false, 'Only literal true grants saved consent.');
      assert.equal(starts, 0);
      visualizer.refresh();
      await settle();
      assert.equal(starts, 0, 'Refresh must not enable capture without saved consent.');
      automatic.dispatchEvent(new Event('click'));
      assert.equal(automatic.hidden, false, 'Opening consent does not grant permission.');
      assert.equal(elements.get('audio-consent')!.hidden, false);
      assert.equal(elements.get('audio-consent')!.open, true, 'Consent must open as a popup.');
      assert.equal(elements.get('audio-card')!.hidden, true, 'Opening consent must not reveal the visualizer.');
      assert.equal(writes, 0);
      elements.get('audio-consent')!.dispatchEvent(new Event('cancel', { cancelable: true }));
      await settle();
      assert.equal(starts, 0, 'Cancel must not capture.');
      assert.equal(elements.get('audio-consent')!.open, false, 'Escape must close consent without granting permission.');
      assert.equal(writes, 0, 'Cancel must not persist consent.');
      automatic.dispatchEvent(new Event('click'));
      let verifySavedPermission: ((value: unknown) => void) | undefined;
      readPermission = (): Promise<unknown> => new Promise<unknown>((resolve): void => { verifySavedPermission = resolve; });
      elements.get('audio-allow')!.dispatchEvent(new Event('click'));
      await settle();
      assert.equal(starts, 0, 'Allow must wait for saved consent verification.');
      assert.equal(elements.get('audio-card')!.hidden, true, 'Pending verification must keep the card hidden.');
      assert.equal(writes, 1);
      verifySavedPermission!({ value: permission });
      readPermission = undefined;
      await settle();
      assert.equal(automatic.hidden, true);
      assert.equal(elements.get('audio-card')!.hidden, false, 'Verified consent must reveal the visualizer.');
      if (scope === 'all-app') {
        assert.equal(allAppsPermission, true, 'All-app approval must use its own stored permission.');
        assert.equal(spotifyPermission, initialPermission, 'All-app approval must not alter Spotify-only permission.');
      }
    }
    if (previousCapture) {
      assert.equal(starts, 0, 'Reopening must not take over a previous capture.');
      assert.equal(elements.get('audio-loader')!.hidden, false, 'Waiting for an old capture must show the loader.');
      assert.equal(elements.get('audio-bands')!.hidden, true);
      assert.equal(elements.get('audio-status')!.dataset.quiet, 'true');
      status = { state: 'off', session: null, message: 'Off' };
      listeners.get('audio.status')!(status);
      await settle();
    }
    assert.equal(starts, 1, 'Saved consent must start even when a status event arrives during initialization.');
    assert.deepEqual(startedScopes, [scope === 'all-app' ? 'all-app' : 'spotify']);
    if (scope === 'all-app') {
      elements.get('audio-disable')!.dispatchEvent(new Event('click'));
      await settle();
      assert.equal(allAppsPermission, false, 'Disable must revoke the all-app permission only.');
      assert.equal(spotifyPermission, initialPermission, 'All-app revocation must preserve Spotify-only permission.');
      assert.equal(status.state, 'off');
      return;
    }
    if (refreshScenario?.startsWith('pending-heartbeat')) {
      context.mock.timers.tick(1000);
      await settle();
      assert.equal(heartbeats, 1);
      visualizer.refresh();
      await settle();
      assert.equal(starts, 2);
      context.mock.timers.tick(1000);
      await settle();
      assert.equal(heartbeats, 2, 'An old pending heartbeat must not block replacement capture.');
      pendingHeartbeats[0](refreshScenario === 'pending-heartbeat-error' ? new Error('Old heartbeat failed') : undefined);
      await settle();
      assert.equal(elements.get('audio-status')!.dataset.state, 'listening', 'An old heartbeat reply must not replace current status.');
      context.mock.timers.tick(1000);
      await settle();
      assert.equal(heartbeats, 2, 'Old completion must not clear the replacement heartbeat lock.');
      pendingHeartbeats[1]();
      await settle();
      context.mock.timers.tick(1000);
      await settle();
      assert.equal(heartbeats, 3, 'Replacement heartbeats must continue after their own reply.');
      return;
    }
    if (refreshScenario === 'heartbeat-consent' || refreshScenario === 'heartbeat-stop') {
      const ownedStatus: AudioStatus = { ...status };
      if (refreshScenario === 'heartbeat-consent') {
        let resolveConsent: ((value: unknown) => void) | undefined;
        readPermission = (): Promise<unknown> => new Promise<unknown>((resolve): void => { resolveConsent = resolve; });
        visualizer.preferenceChanged('audio.autostart.v1');
        listeners.get('audio.status')!(ownedStatus);
        context.mock.timers.tick(1000);
        await settle();
        assert.equal(heartbeats, 0, 'Pending saved-consent verification must suspend heartbeats even after an owned status.');
        resolveConsent!({ value: true });
        readPermission = undefined;
        await settle();
        context.mock.timers.tick(1000);
        await settle();
        assert.equal(heartbeats, 1, 'Verified consent may resume heartbeats for capture that was not stopped.');
        permission = false;
        visualizer.preferenceChanged('audio.autostart.v1');
        await settle();
        listeners.get('audio.status')!(ownedStatus);
        context.mock.timers.tick(1000);
        await settle();
        assert.equal(heartbeats, 1, 'Delayed listening must not renew revoked capture.');
        permission = true;
        visualizer.preferenceChanged('audio.autostart.v1');
        await settle();
        context.mock.timers.tick(1000);
        await settle();
        assert.equal(heartbeats, 1, 'Restored consent alone must not restore stopped capture intent.');
      } else {
        stopReturnsStopping = true;
        visualizer.refresh();
        await settle();
        listeners.get('audio.status')!(ownedStatus);
        context.mock.timers.tick(1000);
        await settle();
        assert.equal(heartbeats, 0, 'Delayed listening after Stop must not renew capture despite verified consent.');
        stopReturnsStopping = false;
        status = { state: 'off', session: null, message: 'Off' };
        listeners.get('audio.status')!(status);
        await settle();
        assert.equal(starts, 2, 'Refresh must still restart after actual shutdown.');
        context.mock.timers.tick(1000);
        await settle();
        assert.equal(heartbeats, 1, 'The refreshed capture must establish new heartbeat intent.');
      }
      return;
    }
    if (refreshScenario) {
      stopReturnsStopping = true;
      visualizer.refresh();
      visualizer.refresh();
      await settle();
      assert.equal(starts, 1, 'Refresh must wait for actual helper shutdown, not the stop response.');
      assert.equal(status.state, 'stopping');
      if (refreshScenario === 'revoke') {
        permission = false;
        visualizer.preferenceChanged('audio.autostart.v1');
        await settle();
      } else if (refreshScenario === 'verify') {
        readPermission = async (): Promise<unknown> => ({ value: true });
        visualizer.preferenceChanged('audio.autostart.v1');
        await settle();
      } else if (refreshScenario === 'hide') {
        visible(false);
      } else if (refreshScenario === 'dispose') {
        visualizer.dispose();
      } else if (refreshScenario === 'peer') {
        status = { state: 'listening', session: 'peer-refresh-session-1234', message: 'Peer capture' };
        listeners.get('audio.status')!(status);
      } else if (refreshScenario === 'failure') {
        failStart = true;
      }
      stopReturnsStopping = false;
      status = { state: 'off', session: null, message: 'Off' };
      listeners.get('audio.status')?.(status);
      await settle();
      const expectedStarts: number = refreshScenario === 'restart' || refreshScenario === 'failure' ? 2 : 1;
      assert.equal(starts, expectedStarts, 'Only an uncancelled manual refresh may restart after shutdown.');
      if (refreshScenario === 'restart') {
        assert.equal(status.state, 'listening');
        status = { state: 'error', session: null, message: 'Capture failed' };
        listeners.get('audio.status')!(status);
        visualizer.refresh();
        await settle();
        assert.equal(starts, 3, 'Refresh must recover from a sessionless capture error.');
      } else if (refreshScenario === 'failure') {
        for (let update: number = 0; update < 3; update++) {
          listeners.get('audio.status')!({ state: 'error', session: null, message: 'Permission denied' });
        }
        await settle();
        assert.equal(starts, 2, 'A failed manual retry must not become a retry loop.');
      }
      return;
    }
    assert.equal(elements.get('audio-loader')!.hidden, false, 'Readiness without a frame must keep loading.');
    assert.equal(elements.get('audio-bands')!.hidden, true);
    assert.equal(elements.get('audio-status')!.dataset.quiet, 'true');
    visualizer.setMotionPaused(true);
    listeners.get('audio.frame')!({ bands: Array<number>(24).fill(0), level: 0 });
    assert.equal(elements.get('audio-loader')!.hidden, true, 'A valid silent frame must finish loading even with motion paused.');
    assert.equal(elements.get('audio-bands')!.hidden, true);
    assert.equal(elements.get('audio-idle')!.hidden, false, 'Silence must show Snorlax, including with motion paused.');
    const idleSprite: Element = elements.get('audio-idle-sprite')!;
    assert.equal(idleSprite.style.transform, 'translate(-1.734375px, 2.890625px)', 'Center Snorlax artwork rather than its padded canvas.');
    const firstAnimation: MockAnimation = idleSprite.animation!;
    assert.equal(firstAnimation.playState, 'paused');
    assert.equal(idleSprite.animationFrames.length, 3, 'Sleep must include both frames plus the end keyframe.');
    assert.match(String(idleSprite.animationFrames[0].backgroundImage), /0143\/Sleep-Anim/);
    assert.ok(idleSprite.animationFrames.every((frame: Keyframe): boolean => String(frame.backgroundImage).includes('0143/Sleep-Anim')));
    assert.ok(Math.abs(Number(idleSprite.animationOptions.duration) - 1083.333333) < 0.01, 'Sleep must use the original unequal frame durations.');
    listeners.get('audio.frame')!({ bands: Array<number>(24).fill(0.6), level: 0.5 });
    assert.equal(firstAnimation.playState, 'idle', 'Audio must cancel the idle animation.');
    assert.equal(elements.get('audio-idle')!.hidden, true, 'Audio must wake the idle sprite even with motion paused.');
    assert.equal(elements.get('audio-bands')!.hidden, false);
    listeners.get('audio.frame')!({ bands: Array<number>(24).fill(0), level: 0 });
    assert.equal(elements.get('audio-idle')!.hidden, false, 'Silence must restore the idle sprite.');
    visualizer.setMotionPaused(false);
    const resumedAnimation: MockAnimation = idleSprite.animation!;
    assert.equal(resumedAnimation.playState, 'running');
    context.mock.timers.tick(999);
    assert.equal(heartbeats, 0);
    context.mock.timers.tick(1);
    await settle();
    assert.equal(heartbeats, 1, 'Visible capture must renew its lease every second.');
    assert.equal(elements.get('audio-loader')!.hidden, true, 'Listening heartbeats must preserve the first-frame state.');
    assert.equal(elements.get('audio-idle')!.hidden, false, 'Heartbeats must preserve detected silence.');
    assert.equal(idleSprite.animation, resumedAnimation, 'Heartbeats must not restart the Snorlax cycle.');
    context.mock.timers.tick(1000);
    await settle();
    assert.equal(heartbeats, 2, 'Heartbeat renewal must continue after a status response.');
    for (let toggle: number = 0; toggle < 12; toggle++) {
      visualizer.setMotionPaused(toggle % 2 === 0);
      context.mock.timers.tick(500);
      await settle();
    }
    assert.equal(heartbeats, 8, 'Motion changes must not postpone capture heartbeats.');
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
      assert.equal(elements.get('audio-loader')!.hidden, false, 'Each new capture must wait for its own frame.');
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
      const automatic: Element = elements.get('audio-enable')!;
      status = { state: 'error', session: null, message: 'Previous capture failed' };
      listeners.get('audio.status')!(status);
      failStart = true;
      automatic.dispatchEvent(new Event('click'));
      elements.get('audio-allow')!.dispatchEvent(new Event('click'));
      await settle();
      assert.equal(starts, 6, 'New Allow must permit one attempt after a sessionless error.');
      assert.equal(elements.get('audio-loader')!.hidden, true, 'Capture errors must not leave a loader.');
      assert.equal(elements.get('audio-status')!.dataset.quiet, 'false', 'Capture errors must remain visible.');
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
    failStart = false;
    if (!elements.get('audio-disable')!.hidden) {
      elements.get('audio-disable')!.dispatchEvent(new Event('click'));
      await settle();
    }
    assert.equal(elements.get('audio-enable')!.hidden, false);
    elements.get('audio-enable')!.dispatchEvent(new Event('click'));
    elements.get('audio-allow')!.dispatchEvent(new Event('click'));
    await settle();
    assert.equal(permission, true, 'Explicit re-enable must persist literal true.');
    assert.equal(status.state, 'listening');
    assert.equal(elements.get('audio-status')!.textContent, '', 'Routine capture must not show a popup.');
    elements.get('audio-disable')!.dispatchEvent(new Event('click'));
    await settle();
    assert.equal(permission, false, 'Disable must persist literal false.');
    assert.equal(allAppsPermission, initialAllAppPermission, 'Spotify-only permission changes must not affect all-app permission.');
    assert.equal(status.state, 'off', 'Disable must stop owned capture.');
    assert.equal(elements.get('audio-status')!.textContent, '', 'Stopping capture must not show a popup.');
    assert.equal(elements.get('audio-enable')!.hidden, false, 'Disable must restore explicit consent.');
    status = { state: 'listening', session: 'peer-panel-session-1234', message: 'Peer capture' };
    listeners.get('audio.status')!(status);
    const peerStarts: number = starts;
    visualizer.refresh();
    await settle();
    assert.equal(starts, peerStarts, 'Refresh must not restart or take over a peer capture.');
    elements.get('audio-enable')!.dispatchEvent(new Event('click'));
    elements.get('audio-allow')!.dispatchEvent(new Event('click'));
    await settle();
    assert.equal(elements.get('audio-loader')!.hidden, false, 'A peer capture must show a loader while waiting.');
    elements.get('audio-disable')!.dispatchEvent(new Event('click'));
    await settle();
    assert.equal(permission, false);
    assert.equal(elements.get('audio-loader')!.hidden, true, 'Revocation must cancel the waiting loader without a peer status update.');
    assert.equal(elements.get('audio-status')!.dataset.quiet, 'false');
    assert.equal(starts, peerStarts, 'Re-enabling must not take over a peer.');
    assert.equal(status.session, 'peer-panel-session-1234', 'Disable must not stop a peer.');
  } finally {
    visualizer?.dispose();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('pending heartbeats belong to their capture run', (context: TestContext): Promise<void> => verifyReopen(context, true, false, true, 'pending-heartbeat'));
test('rejected old heartbeats cannot disturb replacement capture', (context: TestContext): Promise<void> => verifyReopen(context, true, false, true, 'pending-heartbeat-error'));
test('remembered consent survives panel reopen', (context: TestContext): Promise<void> => verifyReopen(context, false));
for (const scenario of ['restart', 'failure', 'revoke', 'verify', 'hide', 'dispose', 'peer', 'heartbeat-consent', 'heartbeat-stop']) {
  test(`manual capture refresh: ${scenario}`, (context: TestContext): Promise<void> => verifyReopen(context, true, false, true, scenario));
}
test('permission load failure after an early status event clears the loader', (context: TestContext): Promise<void> => verifyReopen(context, true, false, new Error('Storage unavailable')));
test('early status events do not suppress remembered capture on open or reopen', (context: TestContext): Promise<void> => verifyReopen(context, true));
test('quick reopen waits for the previous panel lease to expire before starting', (context: TestContext): Promise<void> => verifyReopen(context, true, true));
test('unsupported Windows capture stays disabled despite saved permission', (context: TestContext): Promise<void> => verifyReopen(context, true, false, true, undefined, 'unsupported'));
test('capture capability lookup failures fail closed', (context: TestContext): Promise<void> => verifyReopen(context, true, false, true, undefined, 'failure'));
test('Spotify-only consent does not authorize all-app fallback', (context: TestContext): Promise<void> => verifyReopen(context, true, false, true, undefined, 'all-app'));
test('remembered all-app consent is used only when Spotify-only capture is unavailable', (context: TestContext): Promise<void> => verifyReopen(context, true, false, false, undefined, 'all-app', true));
test('all-app consent does not authorize Spotify-only capture', (context: TestContext): Promise<void> => verifyReopen(context, true, false, false, undefined, 'spotify', true));
for (const permission of [false, null, 'true', 1]) {
  test(`consent UI starts the current panel only after Allow with stored ${JSON.stringify(permission)}`, (context: TestContext): Promise<void> => verifyReopen(context, true, false, permission));
}
