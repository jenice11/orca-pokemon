# Sprite attribution

Offline sprite companions are inspired by [mathieucroset/herdr-pokemon-agents](https://github.com/mathieucroset/herdr-pokemon-agents). No sprite files were copied from that project.

## Source and license

Sprites and animation metadata: [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab), pinned to commit [`13eb5a7733c5f5ba66031a2c5fb7bc67371d7310`](https://github.com/PMDCollab/SpriteCollab/commit/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310). The repository publishes its submission/use policy under [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/). See the bundled [full license](assets/LICENSE.md) and [upstream policy](assets/UPSTREAM-README.md). Material is provided as-is, without warranties; see license Section 5.

**Noncommercial use only.** This bundle does not grant permission for commercial use. The upstream license cannot grant rights the contributor does not own, including rights in official game sprites and Pokémon characters or trademarks. Obtain any additional rights required for your use.

Pokémon and related characters and marks belong to Nintendo, Creatures Inc., and GAME FREAK inc. Original Mystery Dungeon sprite artwork is credited upstream to CHUNSOFT where indicated below. This project is not affiliated with, sponsored by, or endorsed by Nintendo, Creatures Inc., GAME FREAK inc., CHUNSOFT, or PMDCollab.

## Modifications and reproduction

No PNG modifications or crops: sheets are stored byte-for-byte as downloaded. CopyOf aliases use the resolved source sheet under the requested local filename. Only generated playback metadata changes representation: durations convert 60fps ticks to milliseconds, Walk selects right-facing row 2, Idle/Sleep select row 0, and row indices clamp to existing rows. Walk and Sleep bottomOffset is calculated in source pixels as the minimum transparent bottom padding across the selected row's frames, preserving original frame motion. Idle uses the walking ground relative to the source frame center, capped at its opaque bottom to retain hovering without sinking. One scale per species normalizes the largest awake opaque dimension to 50 CSS pixels, constrained by every pose's centered 88-pixel width and 50-pixel above-ground extent. Sleeping poses retain their source proportions and all poses share that scale. Original XML and per-species credit logs remain bundled.

Run `python3 tools/bundle-sprites.py` to download and regenerate; run `python3 tools/bundle-sprites.py --check` to validate locally with no network or writes. [Provenance](assets/provenance.json) records pinned download URLs and SHA256 for every downloaded file. Named contributors below are resolved from upstream [credit_names.txt](assets/credit_names.txt); original per-species `credits.txt` retains submission history and animation scopes. Historical contributors are retained rather than discarded.

## Per-sprite credits

| Species | Bundled animation | Named contributors | Resolved source animation |
| --- | --- | --- | --- |
| 1 Bulbasaur | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0001) |
| 1 Bulbasaur | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0001) |
| 1 Bulbasaur | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0001) |
| 4 Charmander | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0004) |
| 4 Charmander | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0004) |
| 4 Charmander | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0004) |
| 7 Squirtle | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0007) |
| 7 Squirtle | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0007) |
| 7 Squirtle | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0007) |
| 25 Pikachu | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0025) |
| 25 Pikachu | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0025) |
| 25 Pikachu | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0025) |
| 39 Jigglypuff | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0039) |
| 39 Jigglypuff | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0039) |
| 39 Jigglypuff | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0039) |
| 52 Meowth | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0052) |
| 52 Meowth | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0052) |
| 52 Meowth | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0052) |
| 54 Psyduck | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0054) |
| 54 Psyduck | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0054) |
| 54 Psyduck | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0054) |
| 94 Gengar | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0094) |
| 94 Gengar | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0094) |
| 94 Gengar | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0094) |
| 104 Cubone | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0104) |
| 104 Cubone | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0104) |
| 104 Cubone | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0104) |
| 133 Eevee | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0133) |
| 133 Eevee | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0133) |
| 133 Eevee | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0133) |
| 143 Snorlax | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0143) |
| 143 Snorlax | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0143) |
| 143 Snorlax | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0143) |
| 149 Dragonite | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0149) |
| 149 Dragonite | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0149) |
| 149 Dragonite | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0149) |
| 151 Mew | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0151) |
| 151 Mew | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0151) |
| 151 Mew | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0151) |
| 245 Suicune | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0245) |
| 245 Suicune | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0245) |
| 245 Suicune | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0245) |
| 393 Piplup | Walk | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0393) |
| 393 Piplup | Idle | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0393) |
| 393 Piplup | Sleep | [CHUNSOFT](https://www.spike-chunsoft.com/) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0393) |
| 700 Sylveon | Walk | baronessfaron | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0700) |
| 700 Sylveon | Idle | baronessfaron | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0700) |
| 700 Sylveon | Sleep | baronessfaron | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0700) |
| 835 Yamper | Walk | RelicCipher, baronessfaron, [Emmuffin](https://twitter.com/Ernmuffin) | [Walk](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0835) |
| 835 Yamper | Idle | RelicCipher, baronessfaron, [Emmuffin](https://twitter.com/Ernmuffin) | [Idle](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0835) |
| 835 Yamper | Sleep | RelicCipher, baronessfaron, [Emmuffin](https://twitter.com/Ernmuffin) | [Sleep](https://github.com/PMDCollab/SpriteCollab/tree/13eb5a7733c5f5ba66031a2c5fb7bc67371d7310/sprite/0835) |
