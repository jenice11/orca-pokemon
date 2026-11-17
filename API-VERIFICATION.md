# API verification

Verified against the installed production Orca **1.4.250** on 2026-11-06 before implementing the integration. Sources: `orca skills get orca-plugin-authoring`, its `host-api`, `events`, `recipes`, `manifest`, `testing`, and `workflow` references; `orca skills get orca-cli` and its plugin/browser references; CLI command help and live read-only responses.

## Host API 1.3

- `agents.list`: focused-workspace agents only; no all-workspaces argument. Rows contain `terminalId`, title, kind, state, and state start time. No terminal-focus method exists on any plugin surface.
- `orca.on('agent.status.changed', handler)`: provides `paneKey`, state, nullable workspace ID, and optional terminal/title/main-agent metadata. HTML panels subscribe without worker manifest event contributions.
- `workspace.changed`: focused context/terminal changes, replayed on subscription. Created/removed workspace events and document visibility restoration also trigger refresh.
- `storage.get`/`storage.set`: plugin-private JSON; keys are bounded to 256 characters. Species keys use the full workspace/pane identity hashed with SHA256 (75 characters including prefix).
- Agent ordering reuses these hashed identity tokens in the `cards.order.v1` JSON array. Writes are serialized within a panel; cross-panel writes are last-writer-wins. No storage quota or compare-and-swap guarantee is established here. Missing-agent tokens remain in the order so partial rosters do not discard their positions.
- Project ordering uses a separate `projects.order.v1` array of hashed project identities. Existing agent/species identities are unchanged. Agent and project snapshots share the serialized writer; the two storage keys are not an atomic transaction.
- `plugin.request`: panel-to-worker bridge. The worker registers `roster` and `focus` handlers using `orca.panels.handle`.

State rendering is a presentation convention inspired by the reference mod, not a claim that Orca's “done” state proves success.

## CLI bridge contracts observed live

`orca worktree ps --limit 10000 --json` returns an `{ok,result}` envelope. `result.worktrees[]` includes `worktreeId`, `displayName`, and `agents[]`; agent rows have `paneKey`, `agentType`, state, optional conversation label, and `hasLivePty`. The response also includes `truncated` and `hostScope.omittedHostIds`. Historical rows can have no live PTY: those are excluded.

Live project-grouping verification also observed `repoId`, `repo`, `hostId`, and `identity.executionHostId`. Multiple worktrees of the same repository share `repoId`; `repo` names the project while `displayName` may name a branch/worktree. Group identity combines execution host and repository ID, never the display name. Missing repository metadata falls back to host-qualified worktree identity instead of guessing from paths or names.

`orca terminal list --worktree id:<worktreeId> --limit 10000 --json` returns `result.terminals[]` with `worktreeId`, `tabId`, `leafId`, `handle`, and orphan status. Matching is exact: same worktree ID and `${tabId}:${leafId}` equals `paneKey`. Duplicate, orphaned, malformed, truncated, or absent matches refuse focus.

`orca terminal switch --terminal <fresh-handle> --json` returns:

```json
{
  "ok": true,
  "result": {
    "focus": {
      "handle": "term_<runtime-issued-id>",
      "tabId": "<tab-id>",
      "worktreeId": "<worktree-id>",
      "navigated": true
    }
  }
}
```

The worker checks `focus.navigated === true` and matching handle before reporting success. Live verification focused this task's existing terminal; it did not create agents or send terminal input.

## Verification evidence

- User explicitly approved the listed trusted-worker access before the CLI approval command was run.
- Approved native worker returned four live agents from two workspaces. Native panel rendered those agents with local images and no logged frame errors.
- A native `agent.status.changed` test event was delivered to the subscribed HTML panel. Normal roster reconciliation restores authoritative status.
- Native focus handler and the underlying CLI both confirmed successful navigation to this task's existing terminal.
- Unit tests cover parsing, live-only filtering, partial results, handle mapping/refusal, bounded deterministic storage keys, safe CLI argument passing/error handling, worker validation, and serialized fresh roster queries.
- Eight retained browser scenarios execute the real panel against a fixture-only bridge, including races and failure paths. TypeScript strict checking and offline asset/hash validation pass.

The host's `plugin check` result has empty `panels` for HTML entries; it is not evidence of DOM behavior. Native captures are saved locally under `.orca/shots/` and excluded from distribution. Generated SDK declarations are unavailable in this installed app, so local boundary contracts are used.

## Not established

No guarantee of complete lifecycle notifications for background PTY exits/disconnections; manual Refresh remains available. Structured chats, separately paired servers, Windows/Linux behavior, and SSH navigation were not live-tested. The CLI bridge is version-coupled; it is not presented as a capability-sandboxed Host API extension.

## Optional Spotify audio capture

Orca Host API 1.3 has no playback-capture method. The existing trusted worker launches a bundled native helper only when the panel sends an explicit `audio.start` request. `audio.status` does not spawn or probe capture. The unchanged plugin capabilities do not replace macOS system-audio consent.

On macOS 26+, the helper uses `CATapDescription(stereoMixdownOfProcesses: [])` with `bundleIDs = ["com.spotify.client"]`, `isExclusive = false`, `isPrivate = true`, and `muteBehavior = .unmuted`. A private tap-only aggregate delivers Spotify output samples to an I/O callback. It does not enumerate screens, open a microphone device, change default audio output, or broaden capture to all applications. Native-endian Float32 mono/stereo buffers and their actual sample rates are validated before analysis.

The helper keeps samples in fixed in-memory channel buffers. Per-channel Accelerate FFTs produce 24 frequency bands at approximately 9 Hz without stereo phase cancellation. Only bounded JSON visualization levels, readiness, and sanitized errors cross stdout; no PCM audio is sent to the panel. Worker posts stay below Orca's 200-post-per-10-second budget. Only one frame post remains pending per capture; intervening frames are dropped. Posts have a 5-second delivery deadline, with at most four unresolved posts across capture restarts. Stale, undeliverable, or invalid streams fail closed.

Each capture belongs to a panel session. The panel renews a 5-second lease every second only while capture is active and visible. Preference revocation, visibility loss, page exit, worker teardown, stdin EOF, parent death, and termination signals shut down capture. Session status is never persisted. Reload starts a new session only when the person previously allowed automatic start. The panel ignores stale request responses after newer status events; another panel cannot take ownership of an active capture.

Permission defaults off unless saved consent is literal `true`. The compact Allow Spotify visualizer control opens an inline consent explanation; opening it and Cancel do not write permission or start capture. Only Allow persists literal `true` under `audio.autostart.v1`. After reading back and verifying that choice, Allow starts the current visible idle panel as well as enabling future opens without another prompt. Startup waits for both verified saved consent and initial capture status, never takes over a peer session, and fails closed on unreadable or malformed preferences. Reopening during an owned shutdown waits for it to finish. A sessionless error permits one new attempt after explicit Allow or a genuine panel open or hidden-to-visible transition; status updates and repeated visible events alone never retry. Disable visualizer under About & credits stores `false`, stops only owned capture, and restores the explicit consent control. There are no Start or Stop buttons; closing the panel ends capture without revoking consent. This setting cannot grant macOS permission.

Native lifecycle tracing on 6 November 2026 observed a removed HTML panel stop sending heartbeats without delivering its visibility/page-exit handlers. The worker stopped that session exactly 10 seconds after its final heartbeat under the original lease; the lease is now 5 seconds. A returning panel keeps its verified automatic-start request pending while a previous session is active, and starts only after that session reports idle. It does not stop or take ownership of a live peer session. Temporary tracing was removed after diagnosis; the previous-session regression runs under `npm test`.

Verified locally without capture: Swift 6 compilation for `arm64-apple-macos26.0`, ad-hoc signing, non-capturing `--check`/`--self-test`, FFT silence/sine/sample-rate tests, channel-layout tests, and explicit argument gating. The executable initializes capture only with exactly `--capture-spotify`. Node tests cover no-auto-start, session ownership, message validation, bounded frame posts, lease expiry, stalled streams, Stop escalation, spawn failures, and teardown.

Source references: Apple's [Core Audio tap guide](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps), [system-audio usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription), and the installed macOS SDK's `CATapDescription.h`/`AudioHardwareTapping.h`. `NSAudioCaptureUsageDescription` is included in the helper bundle. The audio-input entitlement grants Core Audio access; the code does not request or capture microphone input.

Remaining live checks: actual Spotify audio-producing process attribution, TCC attribution to the helper versus its responsible host, protected-content behavior, and audio route changes. No live capture is initiated as part of automated verification. The bundled binary is Apple Silicon only and ad-hoc signed; it is not a notarized cross-platform release.
