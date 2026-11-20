# Pokémon Agents for Orca

A Pokémon companion panel for [Orca](https://www.onorca.dev/). Each live terminal agent gets a sprite that reflects its status. Click a Pokémon to focus its agent, or search for a different species from its Poké Ball.

## Features

- **Live status animations:** walking while working (Pikachu uses 4× slower Shock, turning in place once through each of eight directions), an attention hop when blocked, idle breathing while waiting, and sleeping when done.
- **Click-to-focus:** switches to the exact agent terminal using a freshly resolved Orca terminal handle.
- **Saved species choices:** 22 Pokémon, with choices stored per workspace and pane identity.
- **Offline sprites:** 69 bundled animation sheets; no runtime downloads, telemetry, or external requests.
- **Accessible controls:** keyboard navigation, status labels, a motion toggle, and support for reduced-motion preferences.
- **Idle animation savings:** hidden and collapsed companions pause their sprite animations without changing Spotify capture or the global motion choice.
- **Spotify visualizer:** an optional spectrum display driven by Spotify desktop playback on supported Macs, with remembered explicit permission.

“Done” reflects Orca's status; it does not prove the agent's task succeeded.

## Requirements

- Orca **1.4.250 or newer**, with plugins enabled.
- Orca's CLI available to the plugin worker. The worker checks standard macOS app locations when the GUI's PATH does not include `orca`.
- Optional Spotify visualization requires **macOS 26+ on Apple Silicon**, Spotify desktop playing on this Mac, and system-audio recording permission. The bundled helper targets Apple Silicon.

Native rendering and terminal focus have been verified on macOS. Windows, Linux, and SSH navigation have not been live-tested.

## Install locally

Clone this repository and inspect the requested access:

```sh
git clone https://github.com/jenice11/orca-plugin.git
cd orca-plugin
orca plugin validate . --json
orca plugin inspect . --json
```

Load the plugin folder:

```sh
orca plugin dev load . --json
```

Orca returns an approval fingerprint and the exact command needed to approve it. **Review the access before running that command. Agents must ask the user before approving plugin permissions.** Do not reuse a fingerprint from another plugin or version.

After approval, open the panel:

```sh
orca plugin open local.pokemon-agents --panel pokemon-agents --json
```

No npm installation is needed. The Spotify helper is bundled for Apple Silicon Macs. This local loading mode hot-reloads the folder: later code edits run under its existing approval unless the requested access changes.

To unload the plugin:

```sh
orca plugin dev unload . --json
```

## Use

1. Start an agent in an Orca terminal and open **Pokémon Agents** in the right sidebar.
2. Click its Pokémon, or use Tab and Enter, to focus the terminal.
3. Click the Poké Ball in the sprite area's lower-left corner, then choose Pokémon to search names (case-insensitive). The current species is marked. Use Arrow Up/Down and Enter to choose, or Escape to close. Choosing saves immediately, updates the sprite, closes the picker, and returns focus to the Poké Ball. Right-clicking the Pokémon opens search directly. Failed saves keep the previous species, show an error, and leave search usable. Clicking outside dismisses without taking focus.
4. Use **Pause** to stop animations, or **Refresh** to reconcile the roster and refresh permitted Spotify capture.

Available species: Bulbasaur, Charmander, Squirtle, Pikachu, Jigglypuff, Meowth, Psyduck, Gengar, Cubone, Eevee, Snorlax, Dragonite, Mew, Pichu, Togepi, Suicune, Piplup, Sylveon, Rowlet, Mimikyu, Scorbunny, and Yamper.

The Poké Ball opens a battle-style popup. Choose **Pokémon** to search species, or **Work** to choose Pikachu's Walk/Shock/Tumble work animation. Work is currently available for Pikachu only. Arrow keys move the cursor; Enter chooses an option. Escape closes the popup. A successful choice saves and closes the popup; failures keep it open for retry. Tumble plays left to right, then TumbleBack plays right to left, looping every 3.6 seconds. The work animation choice saves per agent; Shock remains the default. Other Pokémon keep their existing walking animation.

## Arrange agents

Use the **Filter and sort agents** icon beside Pause to open status and sort options. Filter by Working, Needs help, or Waiting / Done; **All statuses** restores the full roster, including agents without a recognized status. Waiting / Done shows both states without changing their card status or animation. Unreported statuses are never assumed to be done. Filtered counts show matching/total agents. The active status appears beside the icon; click its × to clear only the filter, keeping your sort and order. Empty projects disappear, but saved order and collapsed groups are retained. Status changes update matches immediately. Filter and sort choices last until the panel reloads. Press Escape, click outside, or click the icon again to close the popup.

- Agents are grouped by project, with a collapsible heading and agent count. A small Claude, Codex, or OpenCode icon sits at the bottom-right of each sprite area instead of an agent-type text row. Hover, focus, or click the icon for the agent name only; clicking the Pokémon still focuses its terminal. Other agent types use a neutral terminal mark.
- **Manual** is the default. Drag a card's header grip within its project, or focus the grip and use **Arrow Up** or **Arrow Down**. The Pokémon still focuses its terminal.
- Drag a project heading's grip to rearrange whole groups, or focus the grip and use **Arrow Up** or **Arrow Down**. Project order is saved independently of agent order. Collapsing a group is preserved during refreshes, not across panel reloads.
- Manual order is saved across refreshes and panel reloads. New agents append at the end; temporarily absent agents retain their place when they return.
- **Needs attention first** puts permission/prompt requests first within each project. **Name** sorts agent titles within each project. These views do not replace your manual order or move projects.
- Status updates do not shuffle cards. Select a sort or click **Refresh** to apply it again. Choose **Manual** before rearranging cards.

Saved order contains hashed agent and project identities, not agent names or workspace paths. Projects use repository identity and execution host, so matching display names do not merge unrelated repositories. Older rosters without repository identity fall back to separate workspace groups. Existing species choices and manual agent order are retained. Save failures keep your local arrangement and show an error; move a card or project again to retry. Concurrent panels use last-writer-wins storage.

If saved order cannot be read, moves stay local to protect existing saved positions. After storage recovers, click **Refresh** to reload saved order and resume saving.

## Spotify visualizer

The power icon beside **Spotify visualizer** turns it on or off. Its highlighted state means saved permission is enabled; turning it on still requires the consent confirmation.

1. Play a song in Spotify desktop on this Mac. Spotify Connect playback on another device cannot be captured here.
2. Choose **Allow Spotify visualizer**, read the confirmation popup, and choose **Allow and remember**. Cancel or Escape closes it without granting permission. If macOS asks, approve system-audio recording for the helper or its responsible host in **System Settings → Privacy & Security → Screen & System Audio Recording**.
3. Hide or close the panel to end capture. Automatic start is off by default.

Permission is off by default. Enable and Disable share the footer control area outside the visualizer. The Spotify card disappears when disabled, freeing space for agents; consent and errors remain reachable. **Allow Spotify visualizer** only opens the confirmation; Cancel grants nothing. After Allow saves and verifies the choice, Spotify capture starts in the current visible idle panel and on future panel opens or reloads without asking again. Choose **Disable visualizer** to revoke permission and stop this panel's capture, never a peer panel's capture. The explicit consent control returns after revocation. Closing the panel stops capture without changing the remembered choice. This does not bypass macOS audio permission. There are no manual Start or Stop buttons.

Quickly switching away and back may show **Waiting for previous capture to stop…** for about 5 seconds. Automatic start waits for that session to end instead of taking it over.

The helper uses an audio-only Core Audio tap filtered to Spotify (`com.spotify.client`), not the microphone, screen, or other apps' audio. Samples remain in memory; only frequency-band levels reach the panel. No audio is recorded, saved, or uploaded. The plugin never falls back to microphone or all-system capture.

Silence shows sleeping Snorlax instead of the bars; audio input restores the visualizer. A loader appears until the first captured frame arrives. Silence means all captured frequency bands are below the helper's display floor, not proof that Spotify is stopped. If no bars appear, confirm Spotify is playing locally and check the permission above. Protected playback, device changes, or Spotify's process attribution can prevent capture. Pausing motion pauses the display, not capture. Hiding or closing the panel requests a stop, with a 5-second lease timeout if the connection is lost. Reopening starts capture again only if saved permission is verified as literal `true`. Capture waits for a previous session to stop and never takes it over. A failed start does not retry in a loop; reopen the panel to try again.

Click **Refresh** to update the agent list and restart Spotify capture when saved permission is enabled. Capture waits for its previous helper to close before restarting. Automatic roster updates do not restart capture, and Refresh never takes over another panel's session or grants permission.

## Permissions and privacy

The plugin runs a **trusted Node worker with your user account's machine access**. Its declared capabilities are:

| Capability | Purpose |
| --- | --- |
| `workspace:read` | Workspace context and lifecycle events |
| `workspace:write` | Workspace and terminal navigation |
| `agent:read` | Live agent status events |
| `storage:own` | Persist Pokémon choices in plugin-private storage |

Orca's plugin API cannot list agents across all workspaces or focus an individual terminal. The worker bridges those gaps with the documented `worktree ps`, `terminal list`, and `terminal switch` CLI commands. It passes fixed argument shapes without a shell and validates agent identities and navigation receipts.

CLI responses include conversation metadata and terminal previews. The worker discards these except the displayed agent title, kind, state, workspace label, and routing identity. Raw responses and previews are not stored or logged. Persistent storage contains species numbers under hashed identity keys and your automatic-start choice.

The plugin does not submit terminal input, launch agents, access the microphone, or send data to an external service. Optional Spotify capture requires your remembered explicit consent, plus separate macOS permission. These are intended behaviors, not sandbox guarantees: trusted worker code has broader machine authority.

## Limitations

- Shows proven live **terminal-backed agents** on this runtime and its reachable SSH workspaces, not structured chats or separately paired servers.
- Some background terminal exits or disconnections produce no lifecycle event. Use **Refresh** if a departed agent remains visible.
- Choices follow workspace/pane identity. Recreating a terminal can give it a new identity.
- The panel uses Orca's right sidebar. Orca 1.4.250 cannot stack Explorer above it.
- The CLI bridge depends on Orca's response formats. See [API verification](API-VERIFICATION.md) for the checked contracts.

## Development checks

Installing the plugin does not require npm. For development checks:

```sh
npm ci
node node_modules/playwright/cli.js install chromium
npm run verify
npm run test:browser
```

The browser command starts its own loopback fixture server on an available port and closes it afterward. It runs the main, filtering, ordering, project, audio, and consent suites at 260, 320, and 480 px. The main suite also runs with reduced motion. Reload checks preserve their scenario's storage; other cases use fresh browser storage and a mock Orca bridge. Tests do not change live plugin settings.

Targeted layout checks also cover 320/400 px heights and doubled text sizes, not OS or browser zoom.

Live-region tests verify announcement text and suppress unchanged refresh updates. They do not verify spoken output from VoiceOver or another screen reader.

## Credits and asset rights

- **Original concept:** [mathieucroset/herdr-pokemon-agents](https://github.com/mathieucroset/herdr-pokemon-agents), an MIT-licensed Herdr mod.
- **Sprite source and animation metadata:** [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab), with per-animation artist credits in [ATTRIBUTION.md](ATTRIBUTION.md), including **CHUNSOFT** for original game artwork.
- **Pokémon characters and marks:** Nintendo, Creatures Inc., and GAME FREAK inc.

See [CREDITS.md](CREDITS.md) for project acknowledgments and [ATTRIBUTION.md](ATTRIBUTION.md) for per-animation credits, pinned sources, license terms, and modifications. [Asset provenance](assets/provenance.json) records download URLs and SHA256 hashes.

**Noncommercial use only for the bundled sprite material under the upstream CC BY-NC 4.0 policy.** That policy does not clear underlying Pokémon/game artwork or trademark rights. This unofficial fan project is not affiliated with or endorsed by the rights holders or PMDCollab.
