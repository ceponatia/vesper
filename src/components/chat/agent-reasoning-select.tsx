"use client";

import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  AGENT_REASONING_PROFILES,
  agentReasoningProfileSchema,
  type AgentReasoningProfileId,
} from "@/lib/agent-reasoning";
import { apiGet, apiPatch } from "@/lib/client/api";
import { ModelSelect } from "@/components/ui/model-select";
import { useToast } from "@/components/ui/toast";

const responseSchema = z.object({ profile: agentReasoningProfileSchema });
const pathFor = (chatId: string) => `/api/admin/self/agent-reasoning/${chatId}`;

type LoadedProfile = { chatId: string; profile: AgentReasoningProfileId };

/** Admin-only per-conversation experiment control; the route re-checks role + ownership. */
export function AgentReasoningSelect({ chatId }: { chatId: string }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<LoadedProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const loading = loaded?.chatId !== chatId;
  const profile = loading ? "off" : loaded.profile;

  useEffect(() => {
    let active = true;
    void apiGet(responseSchema, pathFor(chatId)).then((result) => {
      if (!active) return;
      setLoaded({ chatId, profile: result.ok ? result.data.profile : "off" });
    });
    return () => {
      active = false;
    };
  }, [chatId]);

  const description = useMemo(
    () => AGENT_REASONING_PROFILES.find((option) => option.id === profile)?.description ?? "",
    [profile],
  );

  const save = async (next: string) => {
    const parsed = agentReasoningProfileSchema.parse(next);
    const previous = profile;
    setLoaded({ chatId, profile: parsed });
    setSaving(true);
    const result = await apiPatch(responseSchema, pathFor(chatId), { profile: parsed });
    setSaving(false);
    if (!result.ok) {
      setLoaded({ chatId, profile: previous });
      toast.push({ title: "Couldn't save agent reasoning", description: result.error.message, tone: "error" });
      return;
    }
    setLoaded({ chatId, profile: result.data.profile });
    toast.push({ title: "Agent reasoning updated", description: "The profile applies to the next helper-agent run." });
  };

  return (
    <label className="flex flex-col gap-1 px-2 pt-1 pb-2">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Agent reasoning (admin)</span>
      <ModelSelect
        ariaLabel="Agent reasoning profile"
        models={AGENT_REASONING_PROFILES}
        value={profile}
        onChange={(value) => void save(value)}
        disabled={loading || saving}
        className="h-8 text-xs"
      />
      <span className="text-[11px] leading-snug text-paper-600">{loading ? "Loading profile…" : description}</span>
    </label>
  );
}
