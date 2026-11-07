import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spectrumPalette, type SpectrumPalette } from './panel/audio-theme.ts';

test('neutral themes get color rather than gray, with readable light/dark shades', (): void => {
  const dark: SpectrumPalette = spectrumPalette([230, 230, 230], [120, 120, 120], [10, 10, 10]);
  const light: SpectrumPalette = spectrumPalette([20, 20, 20], [120, 120, 120], [250, 250, 250]);
  assert.equal(dark.middle, 'hsl(220 78% 65%)');
  assert.equal(light.middle, 'hsl(220 78% 42%)');
  assert.notEqual(dark.low, dark.high);
});

test('palette follows colored primary, ring, then tinted background', (): void => {
  assert.equal(spectrumPalette([0, 200, 0], [0, 0, 255], [10, 10, 10]).middle, 'hsl(120 78% 65%)');
  assert.equal(spectrumPalette([128, 128, 128], [200, 0, 200], [10, 10, 10]).middle, 'hsl(300 78% 65%)');
  assert.equal(spectrumPalette([128, 128, 128], [100, 100, 100], [10, 30, 30]).middle, 'hsl(180 78% 65%)');
  assert.match(spectrumPalette([255, 0, 0], [0, 0, 0], [0, 0, 0]).high, /^hsl\(340 /);
});

test('yellow and green accents darken against light cards instead of washing out', (): void => {
  const yellow: SpectrumPalette = spectrumPalette([255, 255, 0], [128, 128, 128], [250, 250, 250], [255, 255, 255]);
  const green: SpectrumPalette = spectrumPalette([0, 255, 0], [128, 128, 128], [250, 250, 250], [255, 255, 255]);
  assert.match(yellow.middle, /^hsl\(60 78% (2[0-9]|3[0-5])%\)$/);
  assert.notEqual(yellow.high, 'hsl(40 82% 52%)');
  assert.notEqual(green.high, 'hsl(100 82% 52%)');
});

test('gradient interpolation stays readable on mid-gray and light/dark cards', (): void => {
  type Rgb = [number, number, number];
  function rgb(color: string): Rgb {
    const parts: RegExpMatchArray = color.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/)!;
    const hue: number = Number(parts[1]) / 60;
    const saturation: number = Number(parts[2]) / 100;
    const lightness: number = Number(parts[3]) / 100;
    const chroma: number = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const secondary: number = chroma * (1 - Math.abs(hue % 2 - 1));
    const offset: number = lightness - chroma / 2;
    const channels: Rgb = hue < 1 ? [chroma, secondary, 0] : hue < 2 ? [secondary, chroma, 0] :
      hue < 3 ? [0, chroma, secondary] : hue < 4 ? [0, secondary, chroma] :
        hue < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
    return channels.map((channel: number): number => 255 * (channel + offset)) as Rgb;
  }
  function luminance(channels: Rgb): number {
    const linear: Rgb = channels.map((channel: number): number => {
      const value: number = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }
  for (const gray of [0, 20, 90, 112, 119, 128, 180, 250, 255]) {
    const card: Rgb = [gray, gray, gray];
    const background: number = luminance(card);
    for (let hue: number = 0; hue < 360; hue += 15) {
      const palette: SpectrumPalette = spectrumPalette(rgb(`hsl(${hue} 90% 50%)`), [128, 128, 128], card, card);
      const stops: Rgb[] = [rgb(palette.low), rgb(palette.middle), rgb(palette.high)];
      for (let pair: number = 0; pair < 2; pair++) {
        for (let step: number = 0; step <= 20; step++) {
          const amount: number = step / 20;
          const mixed: Rgb = stops[pair].map((value: number, index: number): number => value * (1 - amount) + stops[pair + 1][index] * amount) as Rgb;
          const foreground: number = luminance(mixed);
          const contrast: number = (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
          assert.ok(contrast >= 3, `hue=${hue} card=${gray} stop=${pair} mix=${amount} contrast=${contrast}`);
        }
      }
    }
  }
});
