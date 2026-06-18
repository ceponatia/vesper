"use client";

import { useMemo } from "react";
import { layoutWorldGraph } from "@/lib/world-graph-layout";

export interface WorldMapGraphLocation {
  id: string;
  name: string;
  description?: string;
}

export interface WorldMapGraphLink {
  fromWorldLocationId: string;
  toWorldLocationId: string;
}

/**
 * Read-only force-directed render of a world's location graph
 * (developer-notes/world-map.plan.md Slice 1): nodes are locations, edges are
 * undirected links. Layout is computed client-side and not stored. A location
 * with no links renders in danger red so a stranded room is obvious at a glance
 * (the UX-audit M2 motivation). Node hover (`<title>`) carries name + blurb.
 */
export function WorldMapGraph({ locations, links }: { locations: WorldMapGraphLocation[]; links: WorldMapGraphLink[] }) {
  const layout = useMemo(
    () =>
      layoutWorldGraph(
        locations.map((l) => l.id),
        links.map((l) => ({ from: l.fromWorldLocationId, to: l.toWorldLocationId })),
      ),
    [locations, links],
  );

  const nodePos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const connectedIds = useMemo(() => {
    const set = new Set<string>();
    for (const link of links) {
      if (link.fromWorldLocationId !== link.toWorldLocationId) {
        set.add(link.fromWorldLocationId);
        set.add(link.toWorldLocationId);
      }
    }
    return set;
  }, [links]);

  if (locations.length === 0) return <p className="text-sm text-paper-500">No locations.</p>;

  const orphanCount = locations.filter((l) => !connectedIds.has(l.id)).length;

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="w-full rounded-card border border-ink-600 bg-ink-900/60"
        role="img"
        aria-label={`World map: ${locations.length} location${locations.length === 1 ? "" : "s"}, ${links.length} connection${links.length === 1 ? "" : "s"}${orphanCount > 0 ? `, ${orphanCount} not connected` : ""}.`}
      >
        {links.map((link, i) => {
          const a = nodePos.get(link.fromWorldLocationId);
          const b = nodePos.get(link.toWorldLocationId);
          if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="stroke-ink-500" strokeWidth={1.5} />;
        })}
        {layout.nodes.map((node) => {
          const loc = byId.get(node.id);
          const isOrphan = !connectedIds.has(node.id);
          const name = loc?.name || "Unnamed";
          return (
            <g key={node.id}>
              <title>
                {name}
                {isOrphan ? " (not connected)" : ""}
                {loc?.description ? ` — ${loc.description}` : ""}
              </title>
              <circle
                cx={node.x}
                cy={node.y}
                r={7}
                className={isOrphan ? "fill-danger-400 stroke-ink-950" : "fill-accent-500 stroke-ink-950"}
                strokeWidth={2}
              />
              <text
                x={node.x}
                y={node.y + 16}
                textAnchor="middle"
                fontSize={11}
                className={isOrphan ? "fill-danger-300" : "fill-paper-300"}
              >
                {name}
              </text>
            </g>
          );
        })}
      </svg>
      {orphanCount > 0 ? (
        <p className="text-xs text-danger-300">
          {orphanCount} location{orphanCount === 1 ? " is" : "s are"} not connected to the rest of the map.
        </p>
      ) : null}
    </div>
  );
}
