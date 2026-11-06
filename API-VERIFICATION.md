# API verification

Verified against the installed production Orca **1.4.250** on 2026-11-06 before implementing the integration. Sources: `orca skills get orca-plugin-authoring`, its `host-api`, `events`, `recipes`, `manifest`, `testing`, and `workflow` references; `orca skills get orca-cli` and its plugin/browser references; CLI command help and live read-only responses.

## Host API 1.3

- `agents.list`: focused-workspace agents only; no all-workspaces argument. Rows contain `terminalId`, title, kind, state, and state start time. No terminal-focus method exists on any plugin surface.
- `orca.on('agent.status.changed', handler)`: provides `paneKey`, state, nullable workspace ID, and optional terminal/title/main-agent metadata. HTML panels subscribe without worker manifest event contributions.
- `workspace.changed`: focused context/terminal changes, replayed on subscription. Created/removed workspace events and document visibility restoration also trigger refresh.
- `storage.get`/`storage.set`: plugin-private JSON; keys are bounded to 256 characters. Species keys use the full workspace/pane identity hashed with SHA256 (75 characters including prefix).
- `plugin.request`: panel-to-worker bridge. The worker registers `roster` and `focus` handlers using `orca.panels.handle`.

State rendering is a presentation convention inspired by the reference mod, not a claim that Orca's “done” state proves success.

## CLI bridge contracts observed live

`orca worktree ps --limit 10000 --json` returns an `{ok,result}` envelope. `result.worktrees[]` includes `worktreeId`, `displayName`, and `agents[]`; agent rows have `paneKey`, `agentType`, state, optional conversation label, and `hasLivePty`. The response also includes `truncated` and `hostScope.omittedHostIds`. Historical rows can have no live PTY: those are excluded.

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
- Unit tests cover parsing, live-only filtering, partial results, handle mapping/refusal, bounded deterministic storage keys, safe CLI argument passing/error handling, worker validation, and single-flight roster queries.
- Eight retained browser scenarios execute the real panel against a fixture-only bridge, including races and failure paths. TypeScript strict checking and offline asset/hash validation pass.

The host's `plugin check` result has empty `panels` for HTML entries; it is not evidence of DOM behavior. Native captures are saved locally under `.orca/shots/` and excluded from distribution. Generated SDK declarations are unavailable in this installed app, so local boundary contracts are used.

## Not established

No guarantee of complete lifecycle notifications for background PTY exits/disconnections; manual Refresh remains available. Structured chats, separately paired servers, Windows/Linux behavior, and SSH navigation were not live-tested. The CLI bridge is version-coupled; it is not presented as a capability-sandboxed Host API extension.
