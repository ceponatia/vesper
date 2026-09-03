"use client";

import { useRef, useState } from "react";
import {
  referenceViewAngles,
  referenceViewWardrobeEntries,
  type CharacterPortraitAcceptance,
} from "@/contracts";
import {
  referenceViewsApi,
  type ReferenceViewAngleId,
  type ReferenceViewSummary,
  type ReferenceViewWardrobe,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { referenceViewRefusalCopy, referenceViewStateCopy } from "./reference-view-copy";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

/**
 * The portrait tab's reference view sheet: the accepted portrait seen from the
 * other three sides, dressed and undressed, each one reviewable and replaceable
 * on its own.
 *
 * The grid is the shape of the REGISTRY, not of the rows that happen to exist —
 * one row of tiles per wardrobe state, one tile per angle, always. A slot with
 * no row is a tile that says "not built" and offers to build it, which is
 * something the owner can act on; a hole in the grid is not.
 *
 * A failed read renders NOTHING, exactly like `IdentityReferencePanel`. This
 * surface is additive: with the routes unreachable, the portrait studio must
 * look precisely as it did rather than growing an error card about machinery
 * nobody asked about.
 */

const POLL_MS = 3000;

export interface ReferenceViewsPanelProps {
  characterId: string;
  /**
   * Which portrait the character's identity comes from, and whether the one on
   * screen is it. Views are measured against the ACCEPTED portrait, so the read
   * is keyed on it: accepting a different one makes every existing view stale,
   * and a set read against the old pointer would keep claiming they are fine.
   */
  acceptance: CharacterPortraitAcceptance;
  /** Called after anything that may have changed the set — the parent refetches. */
  onChanged: () => void;
}

export function ReferenceViewsPanel({ characterId, acceptance, onChanged }: ReferenceViewsPanelProps) {
  const views = useAsyncData(
    () => referenceViewsApi.get(characterId),
    [characterId, acceptance.acceptedImageId],
  );
  const toast = useToast();
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<{ angle: ReferenceViewAngleId; wardrobe: ReferenceViewWardrobe } | null>(null);

  const set = views.data?.set ?? null;
  const planned = views.data?.planned ?? 0;
  // A build is live server-side, or a slot is still holding a pending row. Both
  // arm the poll: the job row covers the stretch before the first row is
  // reserved, where the rows alone say nothing is happening.
  const inFlight = (set?.building ?? false) || (set?.views.some((view) => view.state === "pending") ?? false) || building;

  usePollWhile(
    inFlight,
    () => {
      views.reload({ silent: true });
      onChanged();
    },
    POLL_MS,
  );

  if (views.loading || views.error || set === null) return null;

  const bySlot = new Map(set.views.map((view) => [`${view.angle} ${view.wardrobe}`, view]));
  const buildable = set.views.some(
    (view) => view.state === "missing" || view.state === "stale" || view.state === "failed",
  );

  const refetch = () => {
    views.reload({ silent: true });
    onChanged();
  };

  const reportQueue = (
    outcome: { queued: boolean; reason: "budget" | "storage" | "busy" | null; planned: number },
    queuedTitle: string,
  ) => {
    if (outcome.queued) {
      toast.push({ title: queuedTitle });
      return;
    }
    const reason = outcome.reason;
    toast.push({
      title: "The views were not built",
      description: reason === null ? "Everything is already up to date." : referenceViewRefusalCopy[reason],
      ...(reason === null ? {} : { tone: "error" as const }),
    });
  };

  const buildAll = async () => {
    setBuilding(true);
    const result = await referenceViewsApi.build(characterId);
    setBuilding(false);
    if (!result.ok) {
      toast.push({ title: "Could not build the views", description: result.error.message, tone: "error" });
      return;
    }
    reportQueue(result.data.views, `Building ${String(result.data.views.planned)} reference views…`);
    refetch();
  };

  const regenerate = async (view: ReferenceViewSummary) => {
    const slot = `${view.angle} ${view.wardrobe}`;
    setBusySlot(slot);
    const result = await referenceViewsApi.regenerate(characterId, view.angle, view.wardrobe);
    setBusySlot(null);
    if (!result.ok) {
      toast.push({ title: "Could not rebuild that view", description: result.error.message, tone: "error" });
      return;
    }
    reportQueue(result.data.views, "Rebuilding that view…");
    refetch();
  };

  const review = async (view: ReferenceViewSummary, verdict: "approve" | "reject") => {
    const slot = `${view.angle} ${view.wardrobe}`;
    setBusySlot(slot);
    const result = await referenceViewsApi.review(characterId, view.angle, view.wardrobe, verdict);
    setBusySlot(null);
    if (!result.ok) {
      toast.push({ title: "Could not record that", description: result.error.message, tone: "error" });
      return;
    }
    refetch();
  };

  const pickUpload = (view: ReferenceViewSummary) => {
    uploadTarget.current = { angle: view.angle, wardrobe: view.wardrobe };
    fileInput.current?.click();
  };

  const onFilePicked = async (file: File | undefined) => {
    const target = uploadTarget.current;
    uploadTarget.current = null;
    if (!file || !target) return;
    const slot = `${target.angle} ${target.wardrobe}`;
    setBusySlot(slot);
    const dataUrl = await readAsDataUrl(file);
    if (dataUrl === null) {
      setBusySlot(null);
      toast.push({ title: "Could not read that file", tone: "error" });
      return;
    }
    const result = await referenceViewsApi.upload(characterId, target.angle, target.wardrobe, dataUrl);
    setBusySlot(null);
    if (!result.ok) {
      toast.push({ title: "Upload failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "View replaced", description: "Your own image is now this angle's reference." });
    refetch();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Reference views</h3>
        <span className="min-w-0 text-xs text-paper-500">
          What this character looks like from the other sides, built from the accepted portrait. Only views you approve
          are used.
        </span>
        {buildable && acceptance.acceptedImageId ? (
          <Button size="sm" variant="primary" className="ml-auto" busy={building} disabled={set.building} onClick={buildAll}>
            {`Build ${String(planned)} reference views`}
          </Button>
        ) : null}
      </div>

      {referenceViewWardrobeEntries.map((wardrobe) => (
        <div key={wardrobe.id} className="flex flex-col gap-2">
          <h4 className="text-xs text-paper-500">{wardrobe.label}</h4>
          <div className="flex flex-wrap gap-3">
            {referenceViewAngles.map((angle) => {
              const view = bySlot.get(`${angle.id} ${wardrobe.id}`);
              if (!view) return null;
              const copy = referenceViewStateCopy[view.state];
              const slot = `${view.angle} ${view.wardrobe}`;
              const busy = busySlot === slot;
              return (
                <div
                  key={angle.id}
                  className="flex w-40 flex-col gap-2 rounded-card border border-ink-600 bg-ink-950/40 p-2"
                >
                  <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-card border border-ink-700 bg-ink-900">
                    {view.imageId ? (
                      <EntityImage
                        imageId={view.imageId}
                        name={angle.label}
                        alt={`${angle.label}, ${wardrobe.label}`}
                        className="h-full w-full"
                      />
                    ) : (
                      <span className="px-2 text-center text-xs text-paper-500">{copy.label}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-paper-300">{angle.label}</span>
                    <Tag tone={copy.tone}>{copy.label}</Tag>
                  </div>
                  <p className="text-[11px] leading-snug text-paper-500">
                    {view.state === "failed" && view.failureMessage ? view.failureMessage : copy.hint}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {view.state === "unreviewed" ? (
                      <>
                        <Button size="sm" busy={busy} onClick={() => void review(view, "approve")}>
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" busy={busy} onClick={() => void review(view, "reject")}>
                          Reject
                        </Button>
                      </>
                    ) : null}
                    {view.state === "missing" || view.state === "pending" ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={busy}
                        disabled={set.building}
                        onClick={() => void regenerate(view)}
                      >
                        Regenerate
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" busy={busy} onClick={() => pickUpload(view)}>
                      Upload
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared before the async work so picking the same file twice in a row
          // still fires a change event.
          event.target.value = "";
          void onFilePicked(file);
        }}
      />
    </div>
  );
}

/** The picked file as a data URL, or null when it could not be read. The server
 * re-fits it to the canonical 3:4 portrait, so no client-side crop is needed. */
function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
