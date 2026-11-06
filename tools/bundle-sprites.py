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
from pathlib import Path
from typing import TypedDict


COMMIT: str = "13eb5a7733c5f5ba66031a2c5fb7bc67371d7310"
REPOSITORY: str = "https://github.com/PMDCollab/SpriteCollab"
RAW: str = f"https://raw.githubusercontent.com/PMDCollab/SpriteCollab/{COMMIT}"
ROOT: Path = Path(__file__).resolve().parents[1]
SPECIES: tuple[tuple[int, str], ...] = (
    (1, "Bulbasaur"), (4, "Charmander"), (7, "Squirtle"), (25, "Pikachu"),
    (39, "Jigglypuff"), (52, "Meowth"), (54, "Psyduck"), (94, "Gengar"),
    (133, "Eevee"), (143, "Snorlax"), (149, "Dragonite"), (151, "Mew"),
)
ANIMATIONS: tuple[str, ...] = ("Walk", "Idle", "Sleep")


class Animation(TypedDict):
    path: str
    width: int
    height: int
    columns: int
    row: int
    durations: list[float]


class Pokemon(TypedDict):
    id: int
    name: str
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
        requested: str
        for requested in ANIMATIONS:
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
            animations[requested.lower()] = {
                "path": f"../{local}/{filename}", "width": width, "height": height,
                "columns": columns, "row": min(2 if requested == "Walk" else 0, rows - 1),
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
        pokemon.append({"id": number, "name": species, "animations": animations})
    typescript: str = """// Generated by python3 tools/bundle-sprites.py. Do not edit by hand.
export type SpriteAnimation = {
  path: string;
  width: number;
  height: number;
  columns: number;
  row: number;
  durations: number[];
};

export type Pokemon = {
  id: number;
  name: string;
  animations: { walk: SpriteAnimation; idle: SpriteAnimation; sleep: SpriteAnimation };
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

No PNG modifications or crops: sheets are stored byte-for-byte as downloaded. CopyOf aliases use the resolved source sheet under the requested local filename. Only generated playback metadata changes representation: durations convert 60fps ticks to milliseconds, Walk selects right-facing row 2, Idle/Sleep select row 0, and row indices clamp to existing rows. Original XML and per-species credit logs remain bundled.

Run `python3 tools/bundle-sprites.py` to download and regenerate; run `python3 tools/bundle-sprites.py --check` to validate locally with no network or writes. [Provenance](assets/provenance.json) records pinned download URLs and SHA256 for every downloaded file. Named contributors below are resolved from upstream [credit_names.txt](assets/credit_names.txt); original per-species `credits.txt` retains submission history and animation scopes. Historical contributors are retained rather than discarded.

## Per-sprite credits

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
    print(f"{'Validated offline' if check else 'Bundled'}: {len(pokemon)} species, 36 animations, {len(files)} asset files, {size} bytes")


if __name__ == "__main__":
    main()
