"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { apiGet, apiPost } from "@/lib/client/api";
import { Select } from "@/components/ui/select";

/**
 * Dev-only narration-shape toggle (narrator-prompt-focus.plan.md §1.1). Overrides the
 * live narration *shape profile* for **both** the session and chat lanes via
 * POST /api/dev/narration-shape (404 in prod). Mounted in the admin-gated Inspector
 * tab; flipping busts the prefix cache for subsequent turns by design — a dev-only
 * experimentation cost, not a player path. The "" / "default" option clears the
 * override so each lane reverts to its resting per-lane default (session concise,
 * chat aggressive — eval Run 2).
 */

// "" is the no-override / per-lane-defaults state; the two ids force both lanes.
const SHAPES = [
  { id: "", label: "Default (per-lane: session concise · chat aggressive)" },
  { id: "concise_immersive", label: "Force concise (immersive)" },
  { id: "aggressive_concise", label: "Force aggressive concise" },
] as const;

const stateSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" ? raw : {}),
  z.object({ override: z.enum(["concise_immersive", "aggressive_concise"]).nullable().catch(null) }),
);

export function NarrationShapeToggle() {
  // null until the server state loads — keeps the control disabled (no accidental flip
  // on a stale value) and reflects the real override on mount. "" once loaded ⇒ no override.
  const [override, setOverride] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void apiGet(stateSchema, "/api/dev/narration-shape").then((r) => {
      if (active && r.ok) {
        setOverride(r.data.override ?? "");
        setLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const change = async (next: string) => {
    setSaving(true);
    const r = await apiPost(stateSchema, "/api/dev/narration-shape", { shape: next === "" ? null : next });
    if (r.ok) setOverride(r.data.override ?? "");
    setSaving(false);
  };

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Narration shape</h3>
      <Select
        value={override ?? ""}
        disabled={!loaded || saving}
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
        Live A/B override for both lanes (dev-only). Default leaves each lane on its own profile; forcing
        busts the prefix cache for new turns.
      </p>
    </section>
  );
}
