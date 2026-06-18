/**
 * Deterministic force-directed layout for the read-only world map
 * (developer-notes/world-map.plan.md Slice 1). Pure + dependency-free:
 *
 * - nodes seed on a circle (no RNG, so renders are stable and tests are
 *   deterministic), then a few hundred Fruchterman–Reingold iterations of
 *   all-pairs repulsion + per-edge attraction settle them;
 * - the result is normalized into a fixed viewBox with padding.
 *
 * Sized for small worlds (tens of locations at most); O(nodes²) per iteration is
 * plenty and keeps the math trivial to follow. Positions are mutable `{x,y}`
 * objects iterated by reference — clean under `noUncheckedIndexedAccess` without
 * non-null assertions (banned in source here).
 */

export interface LayoutNode {
  id: string;
  /** viewBox coordinates (0..width / 0..height). */
  x: number;
  y: number;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
  /** Inset (viewBox units) so nodes + labels don't clip the edges. */
  padding?: number;
}

interface Vec {
  x: number;
  y: number;
}

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 420;
const DEFAULT_ITERATIONS = 320;
const DEFAULT_PADDING = 32;

export function layoutWorldGraph(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
  options: LayoutOptions = {},
): LayoutResult {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const padding = options.padding ?? DEFAULT_PADDING;

  const n = nodeIds.length;
  const cx = width / 2;
  const cy = height / 2;
  if (n === 0) return { nodes: [], width, height };
  if (n === 1) return { nodes: nodeIds.map((id) => ({ id, x: cx, y: cy })), width, height };

  const indexById = new Map(nodeIds.map((id, i) => [id, i]));

  // Seed on a circle — deterministic, no RNG (stable renders + testable).
  const radius = Math.min(width, height) * 0.36;
  const pos: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    pos.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  }
  const disp: Vec[] = pos.map(() => ({ x: 0, y: 0 }));

  // Pre-resolve each valid edge to the position + displacement objects it acts
  // on, by reference — the hot loop then mutates in place with no re-indexing.
  // Dangling/self links are dropped defensively.
  const links: Array<{ pa: Vec; pb: Vec; da: Vec; db: Vec }> = [];
  for (const edge of edges) {
    const a = indexById.get(edge.from);
    const b = indexById.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    const pa = pos[a];
    const pb = pos[b];
    const da = disp[a];
    const db = disp[b];
    if (pa && pb && da && db) links.push({ pa, pb, da, db });
  }

  const k = Math.sqrt((width * height) / n); // ideal edge length
  const repulsion = k * k;
  let temperature = Math.min(width, height) * 0.1;
  const cooling = 0.95;

  for (let iter = 0; iter < iterations; iter++) {
    for (const d of disp) {
      d.x = 0;
      d.y = 0;
    }

    // Repulsion between every pair (guards are no-ops — indices are in range —
    // but keep the access typed under noUncheckedIndexedAccess).
    for (let i = 0; i < n; i++) {
      const a = pos[i];
      const da = disp[i];
      if (!a || !da) continue;
      for (let j = i + 1; j < n; j++) {
        const b = pos[j];
        const db = disp[j];
        if (!b || !db) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const force = repulsion / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        da.x += fx;
        da.y += fy;
        db.x -= fx;
        db.y -= fy;
      }
    }

    // Attraction along edges (pull connected nodes together).
    for (const { pa, pb, da, db } of links) {
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      da.x -= fx;
      da.y -= fy;
      db.x += fx;
      db.y += fy;
    }

    // Apply, capped by the (cooling) temperature so it converges.
    for (let i = 0; i < n; i++) {
      const p = pos[i];
      const d = disp[i];
      if (!p || !d) continue;
      const len = Math.hypot(d.x, d.y) || 0.01;
      p.x += (d.x / len) * Math.min(len, temperature);
      p.y += (d.y / len) * Math.min(len, temperature);
    }
    temperature *= cooling;
  }

  // Normalize the settled cloud into the padded viewBox.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pos) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const innerW = width - 2 * padding;
  const innerH = height - 2 * padding;

  return {
    nodes: nodeIds.map((id, i) => {
      const p = pos[i] ?? { x: cx, y: cy };
      return {
        id,
        x: padding + ((p.x - minX) / spanX) * innerW,
        y: padding + ((p.y - minY) / spanY) * innerH,
      };
    }),
    width,
    height,
  };
}
