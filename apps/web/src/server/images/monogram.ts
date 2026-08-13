import { fnv1a32 } from "@/lib/hash";

const WIDTH = 768;
const HEIGHT = 1024; // 3:4, matching avatar aspect

/**
 * Demo-mode placeholder (docs/images/README.md §Demo mode): a deterministic gradient
 * SVG derived from the entity name. Saved through the same registry path as
 * real generations — saveImageBuffer's sharp pass rasterizes it to webp.
 */
export function monogramSvg(name: string): Buffer {
  const display = name.trim() || "?";
  const seed = fnv1a32(display.toLowerCase());
  const hueA = seed % 360;
  const hueB = (hueA + 50 + ((seed >>> 9) % 90)) % 360;
  const angle = (seed >>> 4) % 2 === 0 ? "0%" : "100%";
  const initials = escapeXml(initialsFor(display));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<defs><linearGradient id="g" x1="0%" y1="0%" x2="${angle}" y2="100%">`,
    `<stop offset="0%" stop-color="hsl(${hueA}, 62%, 46%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hueB}, 68%, 28%)"/>`,
    `</linearGradient></defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>`,
    `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="300" fill="rgba(255,255,255,0.92)">${initials}</text>`,
    `</svg>`,
  ].join("");
  return Buffer.from(svg, "utf8");
}

function initialsFor(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? "");
  const joined = letters.join("").toUpperCase();
  return joined || "?";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
