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
import {
  referenceViewRebuildQueuedTitle,
  referenceViewRefusalCopy,
  referenceViewSelectionActionLabel,
  referenceViewStateCopy,
} from "./reference-view-copy";
import { ReferenceViewHistory, type ReferenceViewHistorySlot } from "./reference-view-history";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
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
 *
 * A tile's image opens in the shared `ImageLightbox` (docs/ui/conventions.md
 * §Image lightbox) — a thumbnail is too small to judge identity, anatomy or
 * angle before approving. The viewer is one instance at the panel root, outside
 * every tile, and the thumbnail is its own button beside the review buttons
 * rather than around them, so opening or closing it can neither reach nor be
 * reached by Approve, Reject, Regenerate or Upload.
 *
 * A tile's **History** opens that slot's past attempts in their own read-only
 * overlay (`reference-view-history.tsx`), mounted last and only while open.
 *
 * **Regeneration is a selection, not a queue the owner works through.** Every
 * attempted tile carries a checkbox, and the selection submits as ONE request
 * that the server admits, charges and runs as one batch. Nothing here waits for
 * one rebuild to finish before the next may be asked for: what a rebuild costs
 * is the image budget's question, and the studio must not invent a second,
 * quieter limit by making the owner click eight times.
 */

const POLL_MS = 3000;

/** The empty selection, shared so clearing one twice is not two renders. */
const NO_SLOTS: ReadonlySet<string> = new Set<string>();

/** One tile's identity, spelled once. */
function slotKey(view: { angle: string; wardrobe: string }): string {
  return `${view.angle} ${view.wardrobe}`;
}

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
  /** The slots the owner has ticked, waiting to be submitted together. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SLOTS);
  /**
   * The slots the server has accepted a rebuild for but whose rows have not
   * caught up yet. It replaces the old character-wide lock: a live batch marks
   * ITS OWN targets busy and leaves every other tile — and the checkboxes —
   * usable, so the next selection can be assembled while this one runs.
   */
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(NO_SLOTS);
  const [submitting, setSubmitting] = useState(false);
  const [enlarged, setEnlarged] = useState<{ imageId: string; label: string } | null>(null);
  const [historySlot, setHistorySlot] = useState<ReferenceViewHistorySlot | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<{ angle: ReferenceViewAngleId; wardrobe: ReferenceViewWardrobe } | null>(null);

  const set = views.data?.set ?? null;
  const planned = views.data?.planned ?? 0;
  // A build is live server-side, or a slot is still holding a pending row. Both
  // arm the poll: the job row covers the stretch before the first row is
  // reserved, where the rows alone say nothing is happening.
  const inFlight =
    (set?.building ?? false) ||
    (set?.views.some((view) => view.state === "pending") ?? false) ||
    building ||
    // The optimistic marks a submit placed keep the poll alive until a tick has
    // pruned them, so a batch that settles before the first tick cannot leave a
    // tile busy forever.
    submitted.size > 0;

  usePollWhile(
    inFlight,
    () => {
      // The optimistic marks are dropped as the rows catch up: a slot the set
      // now reports `pending` has its own "building…" chip to carry it, and a
      // set with nothing live has settled everything it was going to.
      setSubmitted((prev) => {
        const current = views.data?.set;
        if (prev.size === 0 || !current) return prev;
        if (!current.building && !current.views.some((view) => view.state === "pending")) return NO_SLOTS;
        const next = new Set(prev);
        for (const view of current.views) {
          if (view.state === "pending") next.delete(slotKey(view));
        }
        return next.size === prev.size ? prev : next;
      });
      views.reload({ silent: true });
      onChanged();
    },
    POLL_MS,
  );

  if (views.loading || views.error || set === null) return null;

  const bySlot = new Map(set.views.map((view) => [slotKey(view), view]));
  const buildable = set.views.some(
    (view) => view.state === "missing" || view.state === "stale" || view.state === "failed",
  );
  // Read back off the set rather than out of the checkbox state, so a slot that
  // vanished between tick and submit cannot inflate the count the owner is shown.
  const selectedViews = set.views.filter((view) => selected.has(slotKey(view)));

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

  const unmark = (keys: readonly string[]) => {
    setSubmitted((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
  };

  /**
   * Rebuild every named slot in ONE request — the single card's Regenerate is
   * this call with one target, so both paths are charged, admitted and run the
   * same way.
   *
   * The selection survives a refusal. A batch the server would not take (a live
   * build, a spent budget) is work the owner still wants, and clearing their
   * ticks would make them reassemble it.
   */
  const regenerate = async (targets: readonly ReferenceViewSummary[]) => {
    if (targets.length === 0) return;
    const keys = targets.map(slotKey);
    setSubmitting(true);
    setSubmitted((prev) => new Set([...prev, ...keys]));
    const result = await referenceViewsApi.regenerate(
      characterId,
      targets.map((view) => ({ angle: view.angle, wardrobe: view.wardrobe })),
    );
    setSubmitting(false);
    if (!result.ok) {
      unmark(keys);
      toast.push({
        title: keys.length === 1 ? "Could not rebuild that view" : "Could not rebuild those views",
        description: result.error.message,
        tone: "error",
      });
      return;
    }
    if (result.data.views.queued) {
      setSelected(NO_SLOTS);
    } else {
      unmark(keys);
    }
    reportQueue(result.data.views, referenceViewRebuildQueuedTitle(keys.length));
    refetch();
  };

  const review = async (view: ReferenceViewSummary, verdict: "approve" | "reject") => {
    const slot = slotKey(view);
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
    const slot = slotKey(target);
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

      {selectedViews.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-ink-600 bg-ink-950/40 p-2">
          <Button
            size="sm"
            variant="primary"
            busy={submitting}
            disabled={set.building}
            title={set.building ? referenceViewRefusalCopy.busy : undefined}
            onClick={() => void regenerate(selectedViews)}
          >
            {referenceViewSelectionActionLabel(selectedViews.length)}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setSelected(NO_SLOTS)}>
            Clear selection
          </Button>
        </div>
      ) : null}

      {referenceViewWardrobeEntries.map((wardrobe) => (
        <div key={wardrobe.id} className="flex flex-col gap-2">
          <h4 className="text-xs text-paper-500">{wardrobe.label}</h4>
          <div className="flex flex-wrap gap-3">
            {referenceViewAngles.map((angle) => {
              const view = bySlot.get(slotKey({ angle: angle.id, wardrobe: wardrobe.id }));
              if (!view) return null;
              const copy = referenceViewStateCopy[view.state];
              const slot = slotKey(view);
              const busy = busySlot === slot;
              const label = `${angle.label}, ${wardrobe.label}`;
              // A slot is selectable once something has been attempted in it —
              // there is nothing to REbuild in an empty or still-rendering one.
              const attempted = view.state !== "missing" && view.state !== "pending";
              return (
                <div
                  key={angle.id}
                  className="flex w-40 flex-col gap-2 rounded-card border border-ink-600 bg-ink-950/40 p-2"
                >
                  <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-card border border-ink-700 bg-ink-900">
                    {view.imageId ? (
                      <button
                        type="button"
                        onClick={() => view.imageId && setEnlarged({ imageId: view.imageId, label })}
                        aria-label={`Enlarge ${label}`}
                        className="block h-full w-full cursor-pointer"
                      >
                        <EntityImage imageId={view.imageId} name={angle.label} alt={label} className="h-full w-full" />
                      </button>
                    ) : (
                      <span className="px-2 text-center text-xs text-paper-500">{copy.label}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {attempted ? (
                      <input
                        type="checkbox"
                        className="accent-accent-500"
                        checked={selected.has(slot)}
                        aria-label={`Select ${label} for regeneration`}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (!next.delete(slot)) next.add(slot);
                            return next;
                          })
                        }
                      />
                    ) : null}
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
                    {attempted ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={submitted.has(slot)}
                        onClick={() => void regenerate([view])}
                      >
                        Regenerate
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" busy={busy} onClick={() => pickUpload(view)}>
                      Upload
                    </Button>
                    {view.state === "missing" || view.state === "pending" ? null : (
                      // Read-only, so it is never disabled and never busy: opening a
                      // slot's past renders cannot change what the slot currently is.
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setHistorySlot({ angle: view.angle, wardrobe: view.wardrobe, label })}
                      >
                        History
                      </Button>
                    )}
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

      <ImageLightbox
        imageId={enlarged?.imageId ?? null}
        alt={enlarged?.label ?? ""}
        caption={enlarged?.label}
        onClose={() => setEnlarged(null)}
      />

      {/* Mounted only while open, so the read happens on the click rather than on
          every render of the sheet, and last in the tree so its overlay sits above
          the panel's own viewer. */}
      {historySlot === null ? null : (
        <ReferenceViewHistory characterId={characterId} slot={historySlot} onClose={() => setHistorySlot(null)} />
      )}
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
