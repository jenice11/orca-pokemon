#!/usr/bin/env python3
"""Rebuild pinned sprites with stdlib only; --check validates offline without writing."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import struct
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path
from typing import TypedDict


COMMIT: str = "13eb5a7733c5f5ba66031a2c5fb7bc67371d7310"
REPOSITORY: str = "https://github.com/PMDCollab/SpriteCollab"
RAW: str = f"https://raw.githubusercontent.com/PMDCollab/SpriteCollab/{COMMIT}"
ROOT: Path = Path(__file__).resolve().parents[1]
SPECIES: tuple[tuple[int, str], ...] = (
    (1, "Bulbasaur"), (4, "Charmander"), (7, "Squirtle"), (25, "Pikachu"),
    (39, "Jigglypuff"), (52, "Meowth"), (54, "Psyduck"), (94, "Gengar"),
    (104, "Cubone"), (133, "Eevee"), (143, "Snorlax"), (149, "Dragonite"), (151, "Mew"),
    (172, "Pichu"), (175, "Togepi"), (245, "Suicune"), (393, "Piplup"),
    (700, "Sylveon"), (722, "Rowlet"), (778, "Mimikyu"), (813, "Scorbunny"), (835, "Yamper"),
)
ANIMATIONS: tuple[str, ...] = ("Walk", "Idle", "Sleep")


class OptionalAnimation(TypedDict, total=False):
    scale: float
    rotatedBottomOffsets: list[float]


class Animation(OptionalAnimation):
    path: str
    width: int
    height: int
    columns: int
    row: int
    bottomOffset: int
    durations: list[float]


class Pokemon(TypedDict):
    id: int
    name: str
    scale: float
    animations: dict[str, Animation]


class Asset(TypedDict):
    path: str
    source: str
    sha256: str
    bytes: int


def png_size(data: bytes) -> tuple[int, int]:
    if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("Invalid PNG header")
    width: int
    height: int
    width, height = struct.unpack(">II", data[16:24])
    if width <= 0 or height <= 0:
        raise ValueError("Empty PNG")
    return width, height


def resolve_animation(anims: dict[str, ET.Element], name: str) -> tuple[str, ET.Element]:
    seen: set[str] = set()
    while True:
        if name in seen:
            raise ValueError(f"CopyOf cycle: {name}")
        seen.add(name)
        animation: ET.Element = anims[name]
        target: str | None = animation.findtext("CopyOf")
        if target is None:
            return name, animation
        name = target.strip()


def png_alpha(data: bytes) -> bytes:
    width, height = png_size(data)
    if struct.unpack(">I", data[8:12])[0] != 13 or data[24:29] != bytes((8, 6, 0, 0, 0)):
        raise ValueError("PNG must be RGBA 8-bit noninterlaced")
    stride: int = width * 4
    expected: int = (stride + 1) * height
    if expected > 50 * 1024 * 1024:
        raise ValueError("Oversized decoded PNG")
    compressed: bytearray = bytearray()
    position: int = 8
    ended: bool = False
    while position < len(data):
        if position + 12 > len(data):
            raise ValueError("Truncated PNG chunk")
        length: int = struct.unpack(">I", data[position:position + 4])[0]
        kind: bytes = data[position + 4:position + 8]
        end: int = position + 8 + length
        if end + 4 > len(data):
            raise ValueError("Truncated PNG chunk")
        if zlib.crc32(data[position + 4:end]) != struct.unpack(">I", data[end:end + 4])[0]:
            raise ValueError("Invalid PNG checksum")
        if kind == b"IDAT":
            compressed.extend(data[position + 8:end])
        position = end + 4
        if kind == b"IEND":
            ended = True
            break
    if not ended:
        raise ValueError("Missing PNG end")
    decoder = zlib.decompressobj()
    raw: bytes = decoder.decompress(compressed, expected + 1)
    if len(raw) != expected or not decoder.eof or decoder.unused_data:
        raise ValueError("Invalid PNG decompressed length")
    alpha: bytearray = bytearray()
    previous: bytearray = bytearray(stride)
    for y in range(height):
        start: int = y * (stride + 1)
        mode: int = raw[start]
        if mode > 4:
            raise ValueError("Unsupported PNG filter")
        current: bytearray = bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            left: int = current[x - 4] if x >= 4 else 0
            up: int = previous[x]
            corner: int = previous[x - 4] if x >= 4 else 0
            predictor: int = 0
            if mode == 1:
                predictor = left
            elif mode == 2:
                predictor = up
            elif mode == 3:
                predictor = (left + up) // 2
            elif mode == 4:
                p: int = left + up - corner
                a, b, c = abs(p - left), abs(p - up), abs(p - corner)
                predictor = left if a <= b and a <= c else up if b <= c else corner
            current[x] = (current[x] + predictor) & 255
        alpha.extend(current[3::4])
        previous = current
    return bytes(alpha)


def opaque_bounds(data: bytes, width: int, height: int, columns: int, row: int) -> tuple[int, int, int, int]:
    sheet_width, sheet_height = png_size(data)
    if width <= 0 or height <= 0 or columns <= 0 or sheet_width != width * columns or row < 0 or (row + 1) * height > sheet_height:
        raise ValueError("Invalid offset frame geometry")
    alpha: bytes = png_alpha(data)
    left: int = width
    top: int = height
    right: int = 0
    bottom: int = 0
    for y in range(row * height, (row + 1) * height):
        for x in range(sheet_width):
            if alpha[y * sheet_width + x]:
                left, top = min(left, x % width), min(top, y % height)
                right, bottom = max(right, x % width + 1), max(bottom, y % height + 1)
    if right == 0:
        raise ValueError("Selected PNG animation row is fully transparent")
    return left, top, right, bottom


def bottom_offset(data: bytes, width: int, height: int, columns: int, row: int) -> int:
    # One shared offset preserves the original vertical motion between frames.
    return height - opaque_bounds(data, width, height, columns, row)[3]


def obtain(source: str, local: str, check: bool, assets: list[Asset]) -> bytes:
    path: Path = ROOT / local
    url: str = f"{RAW}/{source}"
    data: bytes
    if check:
        data = path.read_bytes()
    else:
        request: urllib.request.Request = urllib.request.Request(url, headers={"User-Agent": "orca-offline-sprite-bundler"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(50 * 1024 * 1024 + 1)
        if len(data) > 50 * 1024 * 1024:
            raise ValueError(f"Oversized download: {url}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    assets.append({"path": local, "source": url, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    return data


def output(path: str, content: str, check: bool) -> None:
    destination: Path = ROOT / path
    if check:
        if destination.read_text(encoding="utf-8") != content:
            raise ValueError(f"Stale or modified generated file: {path}")
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")


def main() -> None:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify local SHA256, metadata, credits and generated output; no network")
    args: argparse.Namespace = parser.parse_args()
    check: bool = args.check
    assets: list[Asset] = []
    names_data: bytes = obtain("credit_names.txt", "assets/credit_names.txt", check, assets)
    obtain("LICENSE.md", "assets/LICENSE.md", check, assets)
    obtain("README.md", "assets/UPSTREAM-README.md", check, assets)
    names: dict[str, tuple[str, str]] = {}
    record: dict[str, str]
    for record in csv.DictReader(io.StringIO(names_data.decode("utf-8-sig")), delimiter="\t"):
        names[record["Discord"]] = (record["Name"] or record["Discord"], record["Contact"])
    pokemon: list[Pokemon] = []
    credit_rows: list[str] = []
    number: int
    species: str
    for number, species in SPECIES:
        directory: str = f"{number:04d}"
        upstream: str = f"sprite/{directory}"
        local: str = f"assets/{directory}"
        xml: bytes = obtain(f"{upstream}/AnimData.xml", f"{local}/AnimData.xml", check, assets)
        credits: bytes = obtain(f"{upstream}/credits.txt", f"{local}/credits.txt", check, assets)
        anims: dict[str, ET.Element] = {element.findtext("Name", ""): element for element in ET.fromstring(xml).findall("./Anims/Anim")}
        animations: dict[str, Animation] = {}
        bounds: dict[str, tuple[int, int, int, int]] = {}
        requested: str
        for requested in ANIMATIONS + (("Shock", "Tumble", "TumbleBack") if number == 25 else ()):
            resolved: str
            metadata: ET.Element
            resolved, metadata = resolve_animation(anims, requested)
            filename: str = f"{requested}-Anim.png"
            data: bytes = obtain(f"{upstream}/{resolved}-Anim.png", f"{local}/{filename}", check, assets)
            width: int = int(metadata.findtext("FrameWidth", "0"))
            height: int = int(metadata.findtext("FrameHeight", "0"))
            sheet_width: int
            sheet_height: int
            sheet_width, sheet_height = png_size(data)
            ticks: list[int] = [int(duration.text or "0") for duration in metadata.findall("./Durations/Duration")]
            if width <= 0 or height <= 0 or sheet_width % width or sheet_height % height:
                raise ValueError(f"Invalid frame geometry: {species} {requested}")
            columns: int = sheet_width // width
            rows: int = sheet_height // height
            if columns != len(ticks) or not ticks or any(tick <= 0 for tick in ticks):
                raise ValueError(f"Invalid frame durations: {species} {requested}")
            row: int = min(2 if requested in ("Walk", "TumbleBack") else 0, rows - 1)
            bounds[requested.lower()] = opaque_bounds(data, width, height, columns, row)
            if requested in ("Shock", "Tumble", "TumbleBack"):
                direction_bounds: list[tuple[int, int, int, int]] = [
                    opaque_bounds(data, width, height, columns, direction) for direction in range(rows)
                ]
                bounds[requested.lower()] = (
                    min(item[0] for item in direction_bounds), min(item[1] for item in direction_bounds),
                    max(item[2] for item in direction_bounds), max(item[3] for item in direction_bounds),
                )
            animations[requested.lower()] = {
                "path": f"../{local}/{filename}", "width": width, "height": height,
                "columns": columns, "row": row,
                "bottomOffset": height - bounds[requested.lower()][3],
                "durations": [tick * 1000 / 60 for tick in ticks],
            }
            contributors: list[str] = []
            line: str
            for line in credits.decode("utf-8-sig").splitlines():
                fields: list[str] = line.split("\t")
                if len(fields) < 5:
                    raise ValueError(f"Malformed credits: {species}: {line}")
                if resolved not in fields[4].split(",") and fields[4] not in ("", "Unspecified"):
                    continue
                author: str
                contact: str
                author, contact = names[fields[1]]
                label: str = f"[{author}]({contact})" if contact.startswith("https://") else author
                if label not in contributors:
                    contributors.append(label)
            if not contributors:
                raise ValueError(f"Missing named credits: {species} {requested}")
            credit_rows.append(f"| {number} {species} | {requested} | {', '.join(contributors)} | [{resolved}]({REPOSITORY}/tree/{COMMIT}/{upstream}) |")
        walk: Animation = animations["walk"]
        idle: Animation = animations["idle"]
        # Source frames share a center anchor; retain idle hovering relative to walking feet.
        idle["bottomOffset"] = min(idle["bottomOffset"], (idle["height"] - walk["height"]) // 2 + walk["bottomOffset"])
        awake_size: int = max(max(bounds[name][2] - bounds[name][0], bounds[name][3] - bounds[name][1]) for name in ("walk", "idle"))
        # Normalize once per species; every pose must fit without changing its native proportions.
        scale: float = min(
            50 / awake_size,
            *(88 / (2 * max(animation["width"] / 2 - bounds[name][0], bounds[name][2] - animation["width"] / 2)) for name, animation in animations.items() if name not in ("shock", "tumble", "tumbleback")),
            *(50 / (animation["height"] - animation["bottomOffset"] - bounds[name][1]) for name, animation in animations.items() if name not in ("shock", "tumble", "tumbleback")),
        )
        if "shock" in animations:
            shock: Animation = animations["shock"]
            shock["scale"] = min(scale, 88 / (2 * max(shock["width"] / 2 - bounds["shock"][0], bounds["shock"][2] - shock["width"] / 2)), 50 / (bounds["shock"][3] - bounds["shock"][1]))
        for name in ("tumble", "tumbleback"):
            if name not in animations:
                continue
            tumble: Animation = animations[name]
            tumble["scale"] = min(scale, 88 / (2 * max(tumble["width"] / 2 - bounds[name][0], bounds[name][2] - tumble["width"] / 2)), 50 / (bounds[name][3] - bounds[name][1]))
            tumble["rotatedBottomOffsets"] = [
                (tumble["height"] + tumble["width"]) / 2 - bounds[name][2],
                (tumble["height"] - tumble["width"]) / 2 + bounds[name][0],
            ]
        pokemon.append({"id": number, "name": species, "scale": scale, "animations": animations})
    typescript: str = """// Generated by python3 tools/bundle-sprites.py. Do not edit by hand.
export type SpriteAnimation = {
  scale?: number;
  rotatedBottomOffsets?: number[];
  path: string;
  width: number;
  height: number;
  columns: number;
  row: number;
  bottomOffset: number;
  durations: number[];
};

export type Pokemon = {
  id: number;
  name: string;
  scale: number;
  animations: { walk: SpriteAnimation; idle: SpriteAnimation; sleep: SpriteAnimation; shock?: SpriteAnimation; tumble?: SpriteAnimation; tumbleback?: SpriteAnimation };
};

export const POKEMON: Pokemon[] = """ + json.dumps(pokemon, indent=2, ensure_ascii=False) + ";\n"
    output("panel/sprites.ts", typescript, check)
    attribution: str = f"""# Sprite attribution

Offline sprite companions are inspired by [mathieucroset/herdr-pokemon-agents](https://github.com/mathieucroset/herdr-pokemon-agents). No sprite files were copied from that project.

## Source and license

Sprites and animation metadata: [PMDCollab/SpriteCollab]({REPOSITORY}), pinned to commit [`{COMMIT}`]({REPOSITORY}/commit/{COMMIT}). The repository publishes its submission/use policy under [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/). See the bundled [full license](assets/LICENSE.md) and [upstream policy](assets/UPSTREAM-README.md). Material is provided as-is, without warranties; see license Section 5.

**Noncommercial use only.** This bundle does not grant permission for commercial use. The upstream license cannot grant rights the contributor does not own, including rights in official game sprites and Pokémon characters or trademarks. Obtain any additional rights required for your use.

Pokémon and related characters and marks belong to Nintendo, Creatures Inc., and GAME FREAK inc. Original Mystery Dungeon sprite artwork is credited upstream to CHUNSOFT where indicated below. This project is not affiliated with, sponsored by, or endorsed by Nintendo, Creatures Inc., GAME FREAK inc., CHUNSOFT, or PMDCollab.

## Modifications and reproduction

No PNG modifications or crops: sheets are stored byte-for-byte as downloaded. CopyOf aliases use the resolved source sheet under the requested local filename. Only generated playback metadata changes representation: durations convert 60fps ticks to milliseconds, Walk selects right-facing row 2, Idle/Sleep select row 0, and row indices clamp to existing rows. Walk and Sleep bottomOffset is calculated in source pixels as the minimum transparent bottom padding across the selected row's frames, preserving original frame motion. Idle uses the walking ground relative to the source frame center, capped at its opaque bottom to retain hovering without sinking. One scale per species normalizes the largest awake opaque dimension to 50 CSS pixels, constrained by every pose's centered 88-pixel width and 50-pixel above-ground extent. Sleeping poses retain their source proportions and all poses share that scale. Original XML and per-species credit logs remain bundled.

Run `python3 tools/bundle-sprites.py` to download and regenerate; run `python3 tools/bundle-sprites.py --check` to validate locally with no network or writes. [Provenance](assets/provenance.json) records pinned download URLs and SHA256 for every downloaded file. Named contributors below are resolved from upstream [credit_names.txt](assets/credit_names.txt); original per-species `credits.txt` retains submission history and animation scopes. Historical contributors are retained rather than discarded.

## Per-sprite credits

Pikachu additionally bundles Shock, starting at screen-facing row 0. Its bounds and bottom padding cover all eight directions for turning. Shock alone may use a smaller scale to fit every direction without shrinking Pikachu's other poses.

Pikachu also bundles TumbleBack, rotating its single source direction 90 degrees for rightward travel and -90 degrees for the return trip. It has an independently constrained scale.

The Tumble work option uses Tumble for rightward travel and TumbleBack for leftward travel, with separate rotated floor offsets for each sheet.

| Species | Bundled animation | Named contributors | Resolved source animation |
| --- | --- | --- | --- |
""" + "\n".join(credit_rows) + "\n"
    output("ATTRIBUTION.md", attribution, check)
    manifest: str = json.dumps({"repository": REPOSITORY, "commit": COMMIT, "license": "https://creativecommons.org/licenses/by-nc/4.0/", "png_modifications": "none", "assets": assets}, indent=2) + "\n"
    output("assets/provenance.json", manifest, check)
    files: list[Path] = [path for path in (ROOT / "assets").rglob("*") if path.is_file()]
    size: int = sum(path.stat().st_size for path in files)
    if len(files) > 2000 or size > 50 * 1024 * 1024:
        raise ValueError(f"Bundle limit exceeded: {len(files)} files, {size} bytes")
    print(f"{'Validated offline' if check else 'Bundled'}: {len(pokemon)} species, {sum(len(species['animations']) for species in pokemon)} animations, {len(files)} asset files, {size} bytes")


if __name__ == "__main__":
    main()
