"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { apiGet, apiPost } from "@/lib/client/api";
import { Select } from "@/components/ui/select";

/**
 * Dev-only narration-shape toggle (narrator-prompt-focus.plan.md §1.1). Flips the
 * live narration *shape profile* for **both** the session and chat lanes via
 * POST /api/dev/narration-shape (404 in prod). Mounted in the admin-gated Inspector
 * tab; flipping busts the prefix cache for subsequent turns by design — a dev-only
 * experimentation cost, not a player path.
 */

const SHAPES = [
  { id: "concise_immersive", label: "Concise (immersive) — default" },
  { id: "aggressive_concise", label: "Aggressive concise" },
] as const;

const shapeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" ? raw : {}),
  z.object({ shape: z.enum(["concise_immersive", "aggressive_concise"]).catch("concise_immersive") }),
);

export function NarrationShapeToggle() {
  // null until the active shape loads — keeps the control disabled (no accidental flip
  // on a stale value) and reflects the real server state on mount.
  const [shape, setShape] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void apiGet(shapeSchema, "/api/dev/narration-shape").then((r) => {
      if (active && r.ok) setShape(r.data.shape);
    });
    return () => {
      active = false;
    };
  }, []);

  const change = async (next: string) => {
    setSaving(true);
    const r = await apiPost(shapeSchema, "/api/dev/narration-shape", { shape: next });
    if (r.ok) setShape(r.data.shape);
    setSaving(false);
  };

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Narration shape</h3>
      <Select
        value={shape ?? ""}
        disabled={shape === null || saving}
        onChange={(e) => void change(e.target.value)}
        aria-label="Narration shape profile"
        className="h-8 text-xs"
      >
        {SHAPES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>
      <p className="text-[11px] text-paper-500 italic">
        Live A/B knob for both lanes (dev-only). Flipping busts the prefix cache for new turns.
      </p>
    </section>
  );
}
