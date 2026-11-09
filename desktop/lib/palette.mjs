// Resolución de tokens de color a partir de theme.json.

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const PALETTE_KEYS = ['background', 'surface', 'onSurface', 'primary', 'accent'];

export function hexToRgb(hex) {
  if (!HEX_RE.test(hex)) throw new Error(`color no válido: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

export function rgbToHex(rgb) {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Mezcla lineal: weight 0 devuelve a, 1 devuelve b. */
export function mix(a, b, weight) {
  const [ra, rb] = [hexToRgb(a), hexToRgb(b)];
  return rgbToHex(ra.map((c, i) => c + (rb[i] - c) * weight));
}

/** Color de Windows en formato DWORD 0xAABBGGRR (AccentColor, ColorizationColor). */
export function toAbgrDword(hex, alpha = 0xff) {
  const [r, g, b] = hexToRgb(hex);
  return ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function resolveTheme(themeJson, presetName = themeJson.active) {
  const preset = themeJson.presets[presetName];
  if (!preset) {
    const names = Object.keys(themeJson.presets).join(', ');
    throw new Error(`preset desconocido "${presetName}" (disponibles: ${names})`);
  }
  for (const key of PALETTE_KEYS) hexToRgb(preset.palette[key]);

  const p = preset.palette;
  const isDark = preset.mode === 'dark';
  const colors = {
    ...p,
    muted: mix(p.onSurface, p.background, 0.45),
    border: mix(p.surface, p.onSurface, 0.18),
    selection: mix(p.background, p.primary, 0.3),
  };
  return {
    name: presetName,
    label: preset.label,
    isDark,
    colors,
    ansi: themeJson.ansi[isDark ? 'dark' : 'light'],
    font: themeJson.font,
  };
}
