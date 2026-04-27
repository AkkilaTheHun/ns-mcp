/**
 * Color math for color-targeted image cropping.
 * Converts sRGB → LAB and computes Delta-E (CIE76) for perceptual color matching.
 */

export type Lab = [number, number, number];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  if (h.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) * 100;
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) * 100;
  const z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) * 100;
  // D65 illuminant
  const Xn = 95.047, Yn = 100, Zn = 108.883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / Xn), fy = f(y / Yn), fz = f(z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

export function deltaE76(a: Lab, b: Lab): number {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

const COLOR_NAMES: Record<string, string> = {
  "pastel blue": "#b5d3e7",
  "light blue": "#aacae8",
  "powder blue": "#c0d8e8",
  "blue": "#5a8fc4",
  "pastel mint": "#c8e6d3",
  "mint": "#a8e0c0",
  "pastel teal": "#b8e3d6",
  "teal": "#5fb5a8",
  "pastel pink": "#f5c4d3",
  "pink": "#f0a8c0",
  "pastel purple": "#c5a8d3",
  "purple": "#9070a8",
  "lavender": "#c5a8d3",
  "lilac": "#c5a8d3",
  "periwinkle": "#a8b8e0",
  "grey": "#b0b0b0",
  "gray": "#b0b0b0",
  "green": "#80b890",
  "red": "#c46060",
  "orange": "#e8a060",
  "yellow": "#e8d060",
  "white": "#f0f0f0",
  "black": "#202020",
};

/** Resolve a color string (hex like "#rrggbb" or a known name) to LAB coordinates. */
export function parseColor(input: string): Lab {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.startsWith("#")) return hexToLab(trimmed);
  if (COLOR_NAMES[trimmed]) return hexToLab(COLOR_NAMES[trimmed]);
  throw new Error(
    `Unknown color "${input}". Use hex like "#a8c5e8" or one of: ${Object.keys(COLOR_NAMES).join(", ")}`,
  );
}
