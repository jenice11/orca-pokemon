type Rgb = readonly [number, number, number];

export interface SpectrumPalette {
  low: string;
  middle: string;
  high: string;
}

function hue(rgb: Rgb, minimumChroma: number): number | null {
  const [red, green, blue]: Rgb = rgb;
  const maximum: number = Math.max(red, green, blue);
  const delta: number = maximum - Math.min(red, green, blue);
  if (delta < minimumChroma) return null;
  const sector: number = maximum === red ? (green - blue) / delta :
    maximum === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return (sector * 60 + 360) % 360;
}

function luminance(rgb: Rgb): number {
  const linear: number[] = rgb.map((value: number): number => {
    const channel: number = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function stopColor(hue: number, saturation: number, initialLightness: number, card: Rgb): string {
  const backgroundLuminance: number = luminance(card);
  let lightness: number = initialLightness;
  for (let attempt: number = 0; attempt < 90; attempt++) {
    const level: number = lightness / 100;
    const amplitude: number = saturation / 100 * Math.min(level, 1 - level);
    const channel: (offset: number) => number = (offset: number): number => {
      const sector: number = (offset + hue / 30) % 12;
      return 255 * (level - amplitude * Math.max(-1, Math.min(sector - 3, 9 - sector, 1)));
    };
    const foregroundLuminance: number = luminance([channel(0), channel(8), channel(4)]);
    const contrast: number = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    const sameDirection: boolean = backgroundLuminance > 0.179
      ? foregroundLuminance < backgroundLuminance : foregroundLuminance > backgroundLuminance;
    if (contrast >= 3.1 && sameDirection) break;
    lightness += backgroundLuminance > 0.179 ? -1 : 1;
    lightness = Math.max(5, Math.min(95, lightness));
  }
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

export function spectrumPalette(primary: Rgb, ring: Rgb, background: Rgb, card: Rgb = background): SpectrumPalette {
  const accent: number = hue(primary, 24) ?? hue(ring, 24) ?? hue(background, 12) ?? 220;
  const light: boolean = background[0] * 0.2126 + background[1] * 0.7152 + background[2] * 0.0722 > 160;
  return {
    low: stopColor(Math.round((accent + 20) % 360), 70, light ? 35 : 52, card),
    middle: stopColor(Math.round(accent), 78, light ? 42 : 65, card),
    high: stopColor(Math.round((accent + 340) % 360), 82, light ? 52 : 76, card)
  };
}

export function updateAudioTheme(): void {
  const styles: CSSStyleDeclaration = getComputedStyle(document.documentElement);
  const canvas: HTMLCanvasElement = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context: CanvasRenderingContext2D | null = canvas.getContext('2d', { willReadFrequently: true });
  function readColor(token: string, fallback: Rgb): Rgb {
    const color: string = styles.getPropertyValue(token).trim();
    if (!context || !color || !CSS.supports('color', color)) return fallback;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const pixels: Uint8ClampedArray = context.getImageData(0, 0, 1, 1).data;
    return pixels[3] === 0 ? fallback : [pixels[0], pixels[1], pixels[2]];
  }
  const background: Rgb = readColor('--orca-background', document.documentElement.classList.contains('light') ? [255, 255, 255] : [20, 20, 20]);
  const palette: SpectrumPalette = spectrumPalette(
    readColor('--orca-primary', [128, 128, 128]),
    readColor('--orca-ring', [128, 128, 128]),
    background,
    readColor('--orca-card', background)
  );
  const card: HTMLElement | null = document.querySelector('.audio-card');
  if (!card) return;
  card.style.setProperty('--audio-low', palette.low);
  card.style.setProperty('--audio-middle', palette.middle);
  card.style.setProperty('--audio-high', palette.high);
}
