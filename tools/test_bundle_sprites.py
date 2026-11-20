import importlib.util
import json
import struct
import subprocess
import unittest
import zlib
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("bundle_sprites", Path(__file__).with_name("bundle-sprites.py"))
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


def png(width, height, pixels, filters, depth=8, color=6, interlace=0):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    encoded = bytearray()
    stride = width * 4
    for y, mode in enumerate(filters):
        encoded.append(mode)
        for x in range(stride):
            index = y * stride + x
            left = pixels[index - 4] if x >= 4 else 0
            up = pixels[index - stride] if y else 0
            corner = pixels[index - stride - 4] if y and x >= 4 else 0
            p = left + up - corner
            distances = [abs(p - value) for value in (left, up, corner)]
            predictor = (0, left, up, (left + up) // 2, (left, up, corner)[distances.index(min(distances))])[mode]
            encoded.append((pixels[index] - predictor) % 256)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, color, 0, 0, interlace))
            + chunk(b"IDAT", zlib.compress(encoded)) + chunk(b"IEND", b""))


class SpriteOffsetsTest(unittest.TestCase):
    def test_rendered_species_scale_and_bounds(self):
        # Exercise the actual renderer with generated metadata, not a duplicate scale formula.
        result = subprocess.run(["node", "--input-type=module", "-e", """
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('panel/main.ts', 'utf8');
const renderer = source.slice(source.indexOf('function animateSprite('), source.indexOf('function updateMotion('));
const metadata = fs.readFileSync('panel/sprites.ts', 'utf8');
const pokemon = JSON.parse(metadata.split('export const POKEMON: Pokemon[] = ')[1].trim().replace(/;$/, ''));
const context = vm.createContext({ paused: true, document: { hidden: false } });
vm.runInContext(ts.transpileModule(renderer, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const rendered = {};
for (const species of pokemon) {
  rendered[species.name] = {};
  for (const [pose, state] of [['walk', 'working'], ['idle', 'idle'], ['sleep', 'done'], ...(species.animations.shock ? [['shock', 'working'], ['tumble', 'working'], ['tumbleback', 'working']] : [])]) {
    const selected = pose === 'tumbleback' ? { ...species, animations: { ...species.animations, tumble: undefined } } : species;
    const companion = { row: { state }, dialogue: {}, species: selected, workAnimation: pose, sprite: { style: {}, dataset: {} } };
    context.animateSprite(companion);
    if (!companion.sprite.style.backgroundImage.includes(species.animations[pose].path)) throw new Error(`Wrong animation: ${species.name} ${pose}`);
    rendered[species.name][pose] = companion.sprite.style;
  }
}
console.log(JSON.stringify(rendered));
context.paused = false;
for (const species of pokemon) {
  let captured;
  const companion = { row: { state: 'working' }, dialogue: {}, species, card: { closest() { return null; } }, sprite: {
    style: {}, dataset: {}, animate(frames, options) { captured = { frames, options }; return { cancel() {} }; }
  } };
  context.animateSprite(companion);
  const sheet = species.animations.shock ?? species.animations.walk;
  const turning = Boolean(species.animations.shock);
  const cycle = sheet.durations.reduce((sum, duration) => sum + duration, 0);
  if (Math.abs(captured.options.duration - cycle * (turning ? 32 : 1)) > 0.001) throw new Error('Wrong animation speed');
  if (companion.sprite.dataset.turning !== String(turning)) throw new Error('Wrong patrol mode');
  if (turning) {
    const height = sheet.height * (sheet.scale ?? species.scale);
    for (let segment = 0; segment < 8; segment++) {
      const frame = captured.frames[segment * sheet.columns];
      if (frame.backgroundPosition !== `0px ${-segment * height}px`) throw new Error('Wrong turn direction');
    }
  }
}
const pikachu = pokemon.find(species => species.id === 25);
let tumble;
context.animateSprite({ row: { state: 'working' }, dialogue: {}, species: pikachu, workAnimation: 'tumbleback', card: { closest() { return null; } }, sprite: {
  style: {}, dataset: {}, animate(frames, options) { tumble = { frames, options }; return { cancel() {} }; }
} });
if (tumble.options.duration !== 3600 || tumble.frames.length !== 19) throw new Error('Wrong tumble timing');
for (let index = 0; index < 18; index++) {
  const sheet = index < 8 ? pikachu.animations.tumble : pikachu.animations.tumbleback;
  const height = sheet.height * (sheet.scale ?? pikachu.scale);
  const width = sheet.width * (sheet.scale ?? pikachu.scale);
  const frame = tumble.frames[index];
  const row = sheet.row;
  if (frame.backgroundImage !== `url("${sheet.path}")` || frame.width !== `${width}px` || frame.height !== `${height}px`) throw new Error('Wrong tumble sheet geometry');
  if (frame.backgroundPosition !== `${-(index < 8 ? index : index - 8) * width}px ${-row * height}px`) throw new Error('Wrong tumble facing');
  if (!frame.transform.endsWith(`rotate(${index < 8 ? 90 : -90}deg)`)) throw new Error('Wrong tumble rotation');
  const groundOffset = sheet.rotatedBottomOffsets[index < 8 ? 0 : 1] * (sheet.scale ?? pikachu.scale);
  if (!frame.transform.includes(`px, ${groundOffset}px)`)) throw new Error('Wrong rotated grounding');
}
if (!tumble.frames[0].transform.startsWith('translate(-35px,') ||
    !tumble.frames[7].transform.startsWith('translate(35px,') ||
    !tumble.frames[8].transform.startsWith('translate(35px,') ||
    !tumble.frames[17].transform.startsWith('translate(-35px,')) throw new Error('Wrong tumble travel');
"""], cwd=bundle.ROOT, check=True, capture_output=True, text=True)
        rendered = json.loads(result.stdout)
        text = (bundle.ROOT / "panel/sprites.ts").read_text()
        pokemon = json.loads(text.split("export const POKEMON: Pokemon[] = ")[1].rstrip(";\n"))
        self.assertTrue(
            {(172, "Pichu"), (175, "Togepi"), (722, "Rowlet"), (778, "Mimikyu"), (813, "Scorbunny")}
            <= {(species["id"], species["name"]) for species in pokemon}
        )
        visible = {}
        self.assertEqual([species["id"] for species in pokemon if "shock" in species["animations"]], [25])
        self.assertEqual(next(species for species in pokemon if species["id"] == 25)["animations"]["shock"]["row"], 0)
        for species in pokemon:
            scales = []
            visible[species["name"]] = {}
            for name, animation in species["animations"].items():
                style = rendered[species["name"]][name]
                scale = float(style["width"][:-2]) / animation["width"]
                translation = float(style["transform"].removeprefix("translateY(").split("px)")[0])
                if name in ("tumble", "tumbleback"):
                    self.assertAlmostEqual(translation, animation["rotatedBottomOffsets"][0] * scale)
                    translation = animation["bottomOffset"] * scale
                if name not in ("shock", "tumble", "tumbleback"):
                    scales.append(scale)
                data = (bundle.ROOT / "panel" / animation["path"]).read_bytes()
                width, sheet_height = bundle.png_size(data)
                alpha = bundle.png_alpha(data)
                points = [(x % animation["width"], y % animation["height"])
                          for y in (range(sheet_height) if name in ("shock", "tumble", "tumbleback") else range(animation["row"] * animation["height"], (animation["row"] + 1) * animation["height"]))
                          for x in range(width) if alpha[y * width + x]]
                xs, ys = zip(*points)
                if name in ("tumble", "tumbleback"):
                    self.assertAlmostEqual(animation["height"] / 2 + animation["width"] / 2 - (max(xs) + 1), animation["rotatedBottomOffsets"][0])
                    self.assertAlmostEqual(animation["height"] / 2 - animation["width"] / 2 + min(xs), animation["rotatedBottomOffsets"][1])
                visible[species["name"]][name] = ((max(xs) - min(xs) + 1) * scale, (max(ys) - min(ys) + 1) * scale)
                with self.subTest(species=species["name"], pose=name):
                    self.assertAlmostEqual(float(style["height"][:-2]) / animation["height"], scale)
                    self.assertAlmostEqual(translation, animation["bottomOffset"] * scale)
                    self.assertAlmostEqual(float(style["backgroundSize"].split("px")[0]), animation["width"] * scale * animation["columns"])
                    # Centered horizontally; grounded at actor bottom, inside its 88x50 safe area.
                    self.assertLessEqual(max(abs(min(xs) - animation["width"] / 2), abs(max(xs) + 1 - animation["width"] / 2)) * scale, 44 + 1e-8)
                    self.assertLessEqual((animation["height"] - min(ys)) * scale - translation, 50 + 1e-8)
                    self.assertLessEqual((max(ys) + 1 - animation["height"]) * scale + translation, 1e-8)
                    if name in ("sleep", "walk"):
                        self.assertAlmostEqual((max(ys) + 1 - animation["height"]) * scale + translation, 0)
            with self.subTest(species=species["name"]):
                self.assertAlmostEqual(min(scales), max(scales), msg="Pose changes must not resize a species")
                awake_size = max(max(visible[species["name"]][pose]) for pose in ("walk", "idle"))
                self.assertGreater(awake_size, 42)
                self.assertLessEqual(awake_size, 50 + 1e-8)
        pikachu = visible["Pikachu"]["sleep"]
        sylveon = visible["Sylveon"]["sleep"]
        # Extra working frames constrain Pikachu's shared scale without resizing between poses.
        self.assertGreater(pikachu[0] / sylveon[0], 0.75, (pikachu, sylveon))
        self.assertGreater(pikachu[0], 35)
        self.assertLess(visible["Snorlax"]["sleep"][1], visible["Snorlax"]["walk"][1])

    def test_png_filters(self):
        pixels = bytes((index * 37 + index // 7) % 256 for index in range(3 * 5 * 4))
        for mode in range(5):
            with self.subTest(filter=mode):
                self.assertEqual(bundle.png_alpha(png(3, 5, pixels, [mode] * 5)), pixels[3::4])

    def test_unsupported_formats(self):
        for options in ({"depth": 16}, {"color": 2}, {"interlace": 1}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                bundle.png_alpha(png(1, 1, bytes(4), [0], **options))

    def test_selected_row_minimum_preserves_bobbing(self):
        pixels = bytearray(4 * 8 * 4)
        pixels[(4 * 4 + 0) * 4 + 3] = 255
        pixels[(5 * 4 + 2) * 4 + 3] = 1
        data = png(4, 8, pixels, [0] * 8)
        self.assertEqual(bundle.bottom_offset(data, 2, 4, 2, 1), 2)

    def test_malformed_png(self):
        valid = png(1, 1, bytes(4), [0])
        oversized = bytearray(png(2, 1, bytes(8), [0]))
        oversized[16:20] = struct.pack(">I", 1)
        oversized[29:33] = struct.pack(">I", zlib.crc32(oversized[12:29]))
        compressed = zlib.compress(bytes((5, 0, 0, 0, 0)))
        kind = b"IDAT"
        invalid_filter = valid[:33] + struct.pack(">I", len(compressed)) + kind + compressed + struct.pack(">I", zlib.crc32(kind + compressed)) + valid[-12:]
        for data in (valid[:-1], valid[:40], bytes(oversized), invalid_filter):
            with self.subTest(data=data), self.assertRaises(ValueError):
                bundle.png_alpha(data)

    def test_generated_offsets_match_assets(self):
        text = (bundle.ROOT / "panel/sprites.ts").read_text()
        pokemon = json.loads(text.split("export const POKEMON: Pokemon[] = ")[1].rstrip(";\n"))
        for species in pokemon:
            for name, animation in species["animations"].items():
                with self.subTest(species=species["name"], animation=name):
                    expected = 0
                    if name in ("sleep", "walk", "shock", "tumble", "tumbleback"):
                        data = (bundle.ROOT / "panel" / animation["path"]).read_bytes()
                        expected = bundle.bottom_offset(data, animation["width"], animation["height"], animation["columns"], animation["row"])
                        if name in ("shock", "tumble", "tumbleback"):
                            expected = min(bundle.bottom_offset(data, animation["width"], animation["height"], animation["columns"], row) for row in range(bundle.png_size(data)[1] // animation["height"]))
                    else:
                        data = (bundle.ROOT / "panel" / animation["path"]).read_bytes()
                        walk = species["animations"]["walk"]
                        expected = min(
                            bundle.bottom_offset(data, animation["width"], animation["height"], animation["columns"], animation["row"]),
                            (animation["height"] - walk["height"]) // 2 + walk["bottomOffset"],
                        )
                    self.assertEqual(animation["bottomOffset"], expected)
                    if species["name"] == "Pikachu" and name == "sleep":
                        self.assertEqual(expected, 13)
                    if species["name"] == "Pikachu" and name == "walk":
                        self.assertEqual(expected, 14)


if __name__ == "__main__":
    unittest.main()
