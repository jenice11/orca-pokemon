# Pokémon Agents for Orca

A Pokémon companion panel for [Orca](https://www.onorca.dev/). Each live terminal agent gets a sprite that reflects its status. Click a Pokémon to focus its agent, or choose a different species from its dropdown.

## Features

- **Live status animations:** walking while working, an attention hop when blocked, idle breathing while waiting, and sleeping when done.
- **Click-to-focus:** switches to the exact agent terminal using a freshly resolved Orca terminal handle.
- **Saved species choices:** 12 Pokémon, with choices stored per workspace and pane identity.
- **Offline sprites:** 36 bundled animation sheets; no runtime downloads, telemetry, or external requests.
- **Accessible controls:** keyboard navigation, status labels, a motion toggle, and support for reduced-motion preferences.
- **Spotify visualizer:** an optional spectrum display driven by Spotify desktop playback on supported Macs, with manual or remembered automatic start.

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
3. Choose a species from the dropdown. Right-clicking the Pokémon focuses that dropdown.
4. Use **Pause motion** to stop animations, or **Refresh** to reconcile the roster.

Available species: Bulbasaur, Charmander, Squirtle, Pikachu, Jigglypuff, Meowth, Psyduck, Gengar, Eevee, Snorlax, Dragonite, and Mew.

## Spotify visualizer

1. Play a song in Spotify desktop on this Mac. Spotify Connect playback on another device cannot be captured here.
2. Check **Always start when this panel opens**, read the confirmation, and choose **Allow and remember**. If macOS asks, approve system-audio recording for the helper or its responsible host in **System Settings → Privacy & Security → Screen & System Audio Recording**.
3. Hide or close the panel to end capture. Automatic start is off by default.

The checkbox is off by default. Checking it only opens the confirmation; Cancel grants nothing. After Allow saves and verifies the choice, Spotify capture starts in the current visible idle panel and on future panel opens or reloads without asking again. Uncheck it to revoke automatic start and stop current capture. Closing the panel stops capture without changing the remembered choice. This does not bypass macOS audio permission. There are no manual Start or Stop buttons.

Quickly switching away and back may show **Waiting for previous capture to stop…** for about 5 seconds. Automatic start waits for that session to end instead of taking it over.

The helper uses an audio-only Core Audio tap filtered to Spotify (`com.spotify.client`), not the microphone, screen, or other apps' audio. Samples remain in memory; only frequency-band levels reach the panel. No audio is recorded, saved, or uploaded. The plugin never falls back to microphone or all-system capture.

Silence produces a flat display. If no bars appear, confirm Spotify is playing locally and check the permission above. Protected playback, device changes, or Spotify's process attribution can prevent capture. Pausing motion pauses the display, not capture. Hiding or closing the panel requests a stop, with a 5-second lease timeout if the connection is lost. Reopening starts capture again only if saved Always start consent is verified. Capture waits for a previous session to stop and never takes it over. A failed start does not retry in a loop; reopen the panel to try again.

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

The plugin does not submit terminal input, launch agents, access the microphone, or send data to an external service. Optional Spotify capture requires an explicit Start or your remembered automatic-start consent, plus macOS permission. These are intended behaviors, not sandbox guarantees: trusted worker code has broader machine authority.

## Limitations

- Shows proven live **terminal-backed agents** on this runtime and its reachable SSH workspaces, not structured chats or separately paired servers.
- Some background terminal exits or disconnections produce no lifecycle event. Use **Refresh** if a departed agent remains visible.
- Choices follow workspace/pane identity. Recreating a terminal can give it a new identity.
- The panel uses Orca's right sidebar. Orca 1.4.250 cannot stack Explorer above it.
- The CLI bridge depends on Orca's response formats. See [API verification](API-VERIFICATION.md) for the checked contracts.

## Credits and asset rights

- **Original concept:** [mathieucroset/herdr-pokemon-agents](https://github.com/mathieucroset/herdr-pokemon-agents), an MIT-licensed Herdr mod.
- **Sprite source and animation metadata:** [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab), with original artwork credited to **CHUNSOFT** in the bundled contributor records.
- **Pokémon characters and marks:** Nintendo, Creatures Inc., and GAME FREAK inc.

See [CREDITS.md](CREDITS.md) for project acknowledgments and [ATTRIBUTION.md](ATTRIBUTION.md) for per-animation credits, pinned sources, license terms, and modifications. [Asset provenance](assets/provenance.json) records download URLs and SHA256 hashes.

**Noncommercial use only for the bundled sprite material under the upstream CC BY-NC 4.0 policy.** That policy does not clear underlying Pokémon/game artwork or trademark rights. This unofficial fan project is not affiliated with or endorsed by the rights holders or PMDCollab.
