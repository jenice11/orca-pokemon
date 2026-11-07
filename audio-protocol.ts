export const AUDIO_BANDS: number = 24;

export interface AudioStatus {
  state: 'off' | 'starting' | 'listening' | 'stopping' | 'error';
  message: string;
  session: string | null;
}

export interface AudioFrame {
  bands: number[];
  level: number;
}

export function audioStatus(value: unknown): AudioStatus {
  if (value === null || typeof value !== 'object') throw new Error('Invalid audio status.');
  const data: Partial<AudioStatus> = value as Partial<AudioStatus>;
  if (!['off', 'starting', 'listening', 'stopping', 'error'].includes(data.state ?? '') ||
      typeof data.message !== 'string' || data.message.length > 500 ||
      !(data.session === null || typeof data.session === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(data.session))) {
    throw new Error('Invalid audio status.');
  }
  return { state: data.state!, message: data.message, session: data.session };
}

export function audioFrame(value: unknown): AudioFrame {
  if (value === null || typeof value !== 'object') throw new Error('Invalid audio frame.');
  const data: Partial<AudioFrame> = value as Partial<AudioFrame>;
  if (!Array.isArray(data.bands) || data.bands.length !== AUDIO_BANDS ||
      !data.bands.every((band: unknown): boolean => typeof band === 'number' && Number.isFinite(band) && band >= 0 && band <= 1) ||
      typeof data.level !== 'number' || !Number.isFinite(data.level) || data.level < 0 || data.level > 1) {
    throw new Error('Invalid audio levels.');
  }
  return { bands: [...data.bands], level: data.level };
}

export function audioSession(value: unknown): string {
  if (value === null || typeof value !== 'object' ||
      !('session' in value) || typeof value.session !== 'string' ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(value.session)) {
    throw new Error('Invalid audio session.');
  }
  return value.session;
}
