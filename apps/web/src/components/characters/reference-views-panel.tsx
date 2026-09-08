"use client";

import { useRef, useState, type SetStateAction } from "react";
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
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { ReferenceViewFeedbackNote, ReferenceViewReviewer } from "./reference-view-reviewer";
import {
  discardReferenceViewFeedbackDraft,
  writeReferenceViewFeedbackDraft,
  type ReferenceViewFeedbackDrafts,
} from "./reference-view-review-drafts";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

/**
 * The portrait tab's reference view sheet: the accepted portrait seen from the
 * other three sides, dressed and undressed, each one reviewable and replaceable
 * on its own.
 *
 * The grid is the shape of the REGISTRY, not of the rows that happen to exist —
 * one row of tiles per wardrobe state, one tile per angle, after acceptance. A slot with
 * no row is a tile that says "not built" and offers to build it, which is
 * something the owner can act on; a hole in the grid is not.
 *
 * Loading and failed reads retain the current viewer and offer retry. A polling
 * failure must not discard an author's feedback or hide their review surface.
 *
 * A tile's image opens in the shared `ImageLightbox` (docs/ui/conventions.md
 * §Image lightbox) — a thumbnail is too small to judge identity, anatomy or
 * angle before approving. The viewer is one instance at the panel root, outside
 * every tile, and the thumbnail is its own button beside the review buttons
 * rather than around them, so opening or closing it can neither reach nor be
 * reached by Approve, Reject, Regenerate or Upload.
 *
 * A tile's **History** opens that slot's retained attempts in their own
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
  /** Identity of the saved apparent-age value that determines eligibility. */
  planKey: string;
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

export function ReferenceViewsPanel({ characterId, planKey, acceptance, onChanged }: ReferenceViewsPanelProps) {
  const views = useAsyncData(
    () => referenceViewsApi.get(characterId),
    [characterId, acceptance.acceptedImageId, planKey],
  );
  const toast = useToast();
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  /** The slots the owner has ticked, waiting to be submitted together. */
  const [selection, setSelection] = useState<{ planKey: string; slots: ReadonlySet<string> }>(() => ({ planKey, slots: NO_SLOTS }));
  // React's previous-prop pattern clears the old plan during render without an
  // effect or a panel remount, so feedback and open review state stay intact.
  if (selection.planKey !== planKey) setSelection({ planKey, slots: NO_SLOTS });
  const selected = selection.planKey === planKey ? selection.slots : NO_SLOTS;
  const setSelected = (action: SetStateAction<ReadonlySet<string>>) => {
    setSelection((current) => {
      const previous = current.planKey === planKey ? current.slots : NO_SLOTS;
      const slots = typeof action === "function" ? action(previous) : action;
      return { planKey, slots };
    });
  };
  /**
   * The slots the server has accepted a rebuild for but whose rows have not
   * caught up yet. It replaces the old character-wide lock: a live batch marks
   * ITS OWN targets busy and leaves every other tile — and the checkboxes —
   * usable, so the next selection can be assembled while this one runs.
   */
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(NO_SLOTS);
  const [submitting, setSubmitting] = useState(false);
  const [enlarged, setEnlarged] = useState<ReferenceViewSummary | null>(null);
  const [historySlot, setHistorySlot] = useState<ReferenceViewHistorySlot | null>(null);
  // The viewer may close through Escape or its backdrop. Keep unfinished notes
  // at the panel session boundary so reopening the exact attempt restores them.
  const [reviewDrafts, setReviewDrafts] = useState<ReferenceViewFeedbackDrafts>({});
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

  if (set === null) return (
    <div className="space-y-2 text-sm text-paper-400" role="status">
      <p>{views.error ? "Reference views could not be loaded." : "Loading reference views…"}</p>
      {views.error ? <Button size="sm" onClick={() => views.reload()}>Retry reference views</Button> : null}
    </div>
  );

  // Before the first portrait is chosen, there is nothing to review or configure.
  // Keep existing attempts and live builds visible even if acceptance is cleared.
  if (!acceptance.acceptedImageId && !inFlight && set.views.every((view) => view.state === "missing" || view.state === "ineligible")) return null;

  const bySlot = new Map(set.views.map((view) => [slotKey(view), view]));
  const buildable = set.views.some(
    (view) => view.state === "missing" || view.state === "stale" || view.state === "failed",
  );
  // Read back off the set rather than out of the checkbox state, so a slot that
  // vanished between tick and submit cannot inflate the count the owner is shown.
  const selectedViews = set.views.filter(
    (view) => view.state !== "ineligible" && view.attemptId !== null && selected.has(slotKey(view)),
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

  const pickUpload = (view: ReferenceViewSummary) => {
    if (inFlight || submitting || busySlot !== null) return;
    uploadTarget.current = { angle: view.angle, wardrobe: view.wardrobe };
    fileInput.current?.click();
  };

  const onFilePicked = async (file: File | undefined) => {
    const target = uploadTarget.current;
    uploadTarget.current = null;
    if (!file || !target) return;
    if (inFlight || submitting) {
      toast.push({ title: "Wait for the reference build", description: "Upload your image after the reference views finish building." });
      return;
    }
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
      refetch();
      return;
    }
    toast.push({ title: "View replaced", description: "Your own image is now this angle's reference." });
    refetch();
  };

  return (
    <div className="flex flex-col gap-5">
      {views.error ? <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-paper-400"><span>Reference views could not be refreshed.</span><Button size="sm" onClick={() => views.reload({ silent: true })}>Retry</Button></div> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 max-w-2xl flex-col gap-2">
          <h3 className="text-base font-medium text-paper-100">Reference views</h3>
          <p className="text-sm text-paper-400">
            Check each angle against the accepted portrait, then approve the views that look right. Only approved views
            are used in new images.
          </p>
          <p className="text-xs text-paper-500">
            Open an image for a closer look. Select attempted views to regenerate them together.
          </p>
          {inFlight || submitting ? <p className="text-xs text-paper-400">Uploads are available after the reference build finishes.</p> : null}
        </div>
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
        <div key={wardrobe.id} className="flex flex-col gap-3">
          <h4 className="text-sm font-medium text-paper-200">{wardrobe.label}</h4>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {referenceViewAngles.map((angle) => {
              const view = bySlot.get(slotKey({ angle: angle.id, wardrobe: wardrobe.id }));
              if (!view) return null;
              const copy = referenceViewStateCopy[view.state];
              const slot = slotKey(view);
              const busy = busySlot === slot;
              const label = `${angle.label}, ${wardrobe.label}`;
              // A slot is selectable once something has been attempted in it —
              // there is nothing to REbuild in an empty or still-rendering one.
              const attempted = view.attemptId !== null;
              const eligible = view.state !== "ineligible";
              return (
                <div
                  key={angle.id}
                  className="flex min-w-0 flex-col gap-3 rounded-card border border-ink-600 bg-ink-800 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {attempted && eligible ? (
                      <label className="touch-target flex cursor-pointer items-center gap-2 text-sm font-medium text-paper-100">
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
                        {angle.label}
                      </label>
                    ) : (
                      <span className="text-sm font-medium text-paper-100">{angle.label}</span>
                    )}
                    <Tag tone={copy.tone} title={copy.hint}>
                      {copy.label}
                    </Tag>
                  </div>
                  <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-card border border-ink-700 bg-ink-900">
                    {view.imageId ? (
                      <button
                        type="button"
                        onClick={() => setEnlarged(view)}
                        aria-label={`Enlarge ${label}`}
                        className="block h-full w-full cursor-pointer"
                      >
                        <EntityImage imageId={view.imageId} name={angle.label} alt={label} className="h-full w-full" />
                      </button>
                    ) : (
                      <span className="px-2 text-center text-xs text-paper-500">{copy.label}</span>
                    )}
                  </div>
                  {view.state === "failed" || view.state === "rejected" || view.state === "stale" || view.state === "ineligible" ? (
                    <p className="text-xs leading-relaxed text-paper-400">
                      {view.state === "failed" && view.failureMessage ? view.failureMessage : copy.hint}
                    </p>
                  ) : null}
                  <ReferenceViewFeedbackNote feedback={view.feedback} />
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    {view.state === "unreviewed" ? (
                      <>
                        <Button size="sm" variant="primary" onClick={() => setEnlarged(view)}>
                          Review image
                        </Button>
                      </>
                    ) : null}
                    {attempted && eligible ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={submitted.has(slot)}
                        disabled={set.building}
                        title={set.building ? referenceViewRefusalCopy.busy : undefined}
                        onClick={() => void regenerate([view])}
                      >
                        Regenerate
                      </Button>
                    ) : null}
                    <ActionMenu
                      label="More"
                      ariaLabel={`${label} actions`}
                      items={[
                        { label: "Upload image", onSelect: () => pickUpload(view), busy, disabled: !eligible || inFlight || submitting || busySlot !== null },
                        ...(attempted ? [{
                          label: "History",
                          // Read-only: a busy upload or review must not disable history.
                          onSelect: () => setHistorySlot({ angle: view.angle, wardrobe: view.wardrobe, label }),
                        }] : []),
                      ]}
                    />
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

      {enlarged ? <ReferenceViewReviewer characterId={characterId} initialView={enlarged} set={set}
        drafts={reviewDrafts}
        onDraftChange={(attemptId, feedback) => setReviewDrafts((current) => writeReferenceViewFeedbackDraft(current, attemptId, feedback))}
        onDraftDiscard={(attemptId) => setReviewDrafts((current) => discardReferenceViewFeedbackDraft(current, attemptId))}
        onClose={() => setEnlarged(null)} onChanged={refetch} /> : null}

      {/* Mounted only while open, so the read happens on the click rather than on
          every render of the sheet, and last in the tree so its overlay sits above
          the panel's own viewer. */}
      {historySlot === null ? null : (
        <ReferenceViewHistory characterId={characterId} slot={historySlot} onClose={() => setHistorySlot(null)}
          onRestored={(view) => { setHistorySlot(null); setEnlarged(view); refetch(); }} />
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
