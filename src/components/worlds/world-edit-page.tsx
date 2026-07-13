"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { worldsApi, type WorldDraft } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { useAutosave } from "@/components/hooks/use-autosave";
import { PageContainer } from "@/components/shell/app-shell";
import { ErrorState } from "@/components/ui/error-state";
import { SaveBar } from "@/components/ui/save-bar";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { worldDetailToDraft } from "./world-detail-to-draft";
import { WorldEditor } from "./world-editor";

/** Same review UI as the forge, loaded from the saved world (docs/ui.md). */
export function WorldEditPage({ worldId }: { worldId: string }) {
  const toast = useToast();
  const world = useAsyncData(() => worldsApi.get(worldId), [worldId]);
  const [draft, setDraft] = useState<WorldDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);

  // Seed the draft from the loaded world during render (the React "adjust
  // state while rendering" pattern). Each world is seeded exactly once, so
  // refetches can never clobber in-progress edits.
  const [seededId, setSeededId] = useState<string | null>(null);
  const seedAction = decideDraftSeed({ entityId: worldId, seededId, loadedId: world.data?.id ?? null });
  if (seedAction === "seed" && world.data) {
    setSeededId(worldId);
    setDirty(false);
    setDraft(worldDetailToDraft(world.data));
  } else if (seedAction === "clear") {
    setSeededId(null);
    setDraft(null);
    setDirty(false);
  }

  const save = async () => {
    if (!draft) return;
    const gen = editGenRef.current;
    setSaving(true);
    // Draft shape → from-draft route: a raw draft PATCH would silently strip
    // castSuggestions/itemPlacements and duplicate library locations.
    const result = await worldsApi.updateFromDraft(worldId, draft);
    setSaving(false);
    if (result.ok) {
      // Edits made while the save was in flight stay marked unsaved.
      if (editGenRef.current === gen) setDirty(false);
      const notices = result.data.diagnostics.filter((d) => d.severity !== "info");
      toast.push({
        title: "World saved",
        tone: "success",
        ...(notices.length > 0
          ? { description: `${notices.length} notice${notices.length === 1 ? "" : "s"} applied during save.` }
          : {}),
      });
      world.reload({ silent: true });
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
  };

  // Autosave is deliberately OFF here (enabled: false — the slice-7 exception):
  // the from-draft save FORGES new cast suggestions server-side (a minute-long,
  // paid, non-idempotent side effect), so a silent background save would forge
  // half-typed suggestions. The hook still installs the ruled beforeunload
  // guard for the unsaved/in-flight window; Save stays explicit.
  useAutosave({ enabled: false, dirty, saving, save: async () => save(), signal: draft });

  if (world.loading && !draft) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-9 w-72" />
        <SkeletonText lines={8} />
      </PageContainer>
    );
  }

  if (world.error && !draft) {
    return (
      <PageContainer wide>
        <ErrorState error={world.error} onRetry={() => world.reload()} />
      </PageContainer>
    );
  }

  if (!draft) return null;

  return (
    <PageContainer wide>
      <div className="mb-6 flex items-baseline justify-between gap-3">
        <h1 className="prose-display text-2xl">Edit · {draft.name || "Untitled world"}</h1>
        <Link href={`/worlds/${worldId}`} className="text-sm text-paper-400 hover:text-paper-100">
          ← Back to world
        </Link>
      </div>
      <WorldEditor
        draft={draft}
        onChange={(next) => {
          editGenRef.current += 1;
          setDraft(next);
          setDirty(true);
        }}
      />
      {saving ? (
        <p className="mt-4 text-sm text-paper-400">
          Saving — new cast members are forged during the save, which can take a minute. Stay on this page; leaving
          won&apos;t cancel it, but you&apos;ll miss the result.
        </p>
      ) : null}
      <SaveBar dirty={dirty} saving={saving} onSave={save} />
    </PageContainer>
  );
}
