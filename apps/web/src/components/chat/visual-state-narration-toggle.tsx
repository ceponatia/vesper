"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { apiGet, apiPatch } from "@/lib/client/api";
import { useToast } from "@/components/ui/toast";

const responseSchema = z.object({ enabled: z.boolean() });
const pathFor = (chatId: string) => `/api/chats/${chatId}/visual-state-narration`;

/**
 * The per-conversation visual-state narration switch (visual-state.plan.md
 * slice 7; owner ruling 2026-08-17).
 *
 * Self-loading and self-saving, like `AgentReasoningSelect`, rather than a field
 * on the scenario form's patch: the column is operational configuration and does
 * not ride `ChatScenario`, so it must not travel with a save that story rollback
 * can undo. Its own route, its own request, its own toast.
 *
 * Optimistic, with the previous value restored on failure — a switch that
 * silently stayed where it was would be worse than one that visibly snaps back.
 */
export function VisualStateNarrationToggle({ chatId }: { chatId: string }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<{ chatId: string; enabled: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const loading = loaded?.chatId !== chatId;
  const enabled = loading ? false : loaded.enabled;

  useEffect(() => {
    let active = true;
    void apiGet(responseSchema, pathFor(chatId)).then((result) => {
      if (!active) return;
      setLoaded({ chatId, enabled: result.ok ? result.data.enabled : false });
    });
    return () => {
      active = false;
    };
  }, [chatId]);

  const save = async (next: boolean) => {
    const previous = enabled;
    setLoaded({ chatId, enabled: next });
    setSaving(true);
    const result = await apiPatch(responseSchema, pathFor(chatId), { enabled: next });
    setSaving(false);
    if (!result.ok) {
      setLoaded({ chatId, enabled: previous });
      toast.push({
        title: "Couldn't change visual continuity",
        description: result.error.message,
        tone: "error",
      });
      return;
    }
    setLoaded({ chatId, enabled: result.data.enabled });
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Visual continuity</span>
      <label className="flex items-center gap-2 text-xs text-paper-400">
        <input
          type="checkbox"
          checked={enabled}
          disabled={loading || saving}
          onChange={(event) => void save(event.target.checked)}
          className="size-4 accent-accent-500"
        />
        Tell the narrator what it can see
      </label>
      <span className="text-[11px] leading-snug text-paper-600">
        Passes what is currently true of this character — what she is wearing, how it is arranged, how she is sitting
        or turned — to the narrator as things not to contradict, plus at most two details that just changed or just
        came into view. Experimental: it should mean fewer moments where she stands up while she is kneeling, at some
        risk of the same detail being mentioned twice. Applies from your next message.
      </span>
    </div>
  );
}
