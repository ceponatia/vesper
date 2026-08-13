"use client";

import { useEffect, useRef, useState } from "react";
import {
  clampSelection,
  cropPreviewLayout,
  displayScale,
  fitDisplayBox,
  type IdentityCropHandle,
  identityCropHandles,
  type IdentityPackResponseWire,
  type IdentityPackSummaryStatus,
  type IdentitySquareSelection,
  imageIdentityPackFailureCodeSchema,
  imageIdentityPackWarningCodeSchema,
  moveSelection,
  resizeSelection,
  selectionFromCrop,
  selectionToNormalized,
  type SourceDimensions,
  toDisplayRect,
  toSourceSpace,
} from "@vesper/image-core";
import {
  identityPackConflictSummary,
  identityPackRejectionCode,
  identityPacksApi,
  imageUrl,
  type ApiError,
  type ApiResult,
  type IdentityPackNormalizedCropWire,
  type IdentityPackSummaryWire,
  type IdentityPackWriteGuard,
} from "@/lib/client/api";
import { identityPackCodeCopy, identityPackSummaryChip } from "./identity-pack-copy";
import { IdentityPackInspector } from "./identity-pack-inspector";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

/** The editor's viewport, in CSS px — the source is contain-fit inside it. */
const EDITOR_BOX = { width: 340, height: 460 };
const PREVIEW_SIDE = 176;
/** One delayed re-read while a pack is preparing. Never a loop — see the effect. */
const PENDING_REFRESH_MS = 3000;
/** Keyboard nudge, in source pixels (shift = 4×). */
const NUDGE_PX = 8;

export interface IdentityCropDialogProps {
  open: boolean;
  onClose: () => void;
  characterId: string;
  name: string;
  /** The character's canonical portrait — the source when no pack names one yet. */
  avatarImageId: string | null;
  /** Latest summary from the owning panel; null while loading or unavailable. */
  summary: IdentityPackSummaryWire | null;
  /** Ask the panel to re-read the summary (its chip mirrors what happens here). */
  onRefresh: () => void;
}

/** Copy for a wire failure code, or null when this build has none for it. */
function parsedFailureCopy(code: string | null): string | null {
  const parsed = imageIdentityPackFailureCodeSchema.safeParse(code);
  return parsed.success ? identityPackCodeCopy(parsed.data) : null;
}

/**
 * A refused write in the owner's words: the measured failure code first (the 422
 * body's stable code, which has copy), then an envelope code that happens to be one,
 * and only then the server's own sentence.
 */
function writeErrorCopy(error: ApiError): string {
  const measured = identityPackRejectionCode(error);
  if (measured) return identityPackCodeCopy(measured);
  const envelope = imageIdentityPackFailureCodeSchema.safeParse(error.code);
  if (envelope.success) return identityPackCodeCopy(envelope.data);
  return error.message || "That crop could not be saved.";
}

function guardOf(summary: IdentityPackSummaryWire | null): IdentityPackWriteGuard | null {
  if (!summary?.packId || summary.revision === null || !summary.sourceContentHash) return null;
  return { packId: summary.packId, revision: summary.revision, sourceContentHash: summary.sourceContentHash };
}

function submissionOf(selection: IdentitySquareSelection, source: SourceDimensions): IdentityPackNormalizedCropWire {
  return { space: "normalized", ...selectionToNormalized(selection, source) };
}

interface DragState {
  pointerId: number;
  mode: "move" | "resize";
  handle: IdentityCropHandle;
  /** The rendered image's top-left in client coords, captured at press. */
  originX: number;
  originY: number;
  startX: number;
  startY: number;
  base: IdentitySquareSelection;
}

const HANDLE_POSITION: Record<IdentityCropHandle, string> = {
  nw: "-top-1.5 -left-1.5 cursor-nwse-resize",
  ne: "-top-1.5 -right-1.5 cursor-nesw-resize",
  se: "-right-1.5 -bottom-1.5 cursor-nwse-resize",
  sw: "-bottom-1.5 -left-1.5 cursor-nesw-resize",
};

/**
 * The character owner's face-crop editor (image-identity-packs.plan.md §Correction
 * path): the canonical portrait with the current crop as a draggable, resizable
 * square, a live preview of what gets stored, and the pack's warnings in plain copy.
 *
 * The preview is NOT authoritative. Every coordinate is re-resolved and re-validated
 * against the real source bytes server-side, which is why the editor submits
 * normalized coordinates plus the pack id, revision and source hash it was opened
 * on: if the portrait changed under an open editor, the save is refused as stale and
 * reloads here instead of applying old framing to new bytes.
 */
export function IdentityCropDialog({
  open,
  onClose,
  characterId,
  name,
  avatarImageId,
  summary: summaryProp,
  onRefresh,
}: IdentityCropDialogProps) {
  const toast = useToast();
  const isAdmin = useIsAdmin();
  const [summary, setSummary] = useState<IdentityPackSummaryWire | null>(summaryProp);
  const [selection, setSelection] = useState<IdentitySquareSelection | null>(null);
  const [loaded, setLoaded] = useState<{ imageId: string; width: number; height: number } | null>(null);
  const [loadFailedFor, setLoadFailedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "ensure" | "reset" | "refresh" | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  // The panel owns the fetch; adopt whatever it last read (a write here pushes the
  // fresh summary back through it, so the two never disagree for longer than a tick).
  const [prevSummaryProp, setPrevSummaryProp] = useState(summaryProp);
  if (summaryProp !== prevSummaryProp) {
    setPrevSummaryProp(summaryProp);
    if (summaryProp) setSummary(summaryProp);
  }

  const status: IdentityPackSummaryStatus = summary?.status ?? "none";
  // Staleness is the separate boolean, never a status: a retired revision loses
  // `current` in the same write that marks it stale, and the summary reads only the
  // current row — so `status` here is one of none|pending|ready|unusable|failed.
  const stale = summary?.stale === true;
  const packSourceImageId = summary?.source.imageId ?? null;
  // A stale pack's source is no longer canonical, so the editor frames the
  // character's CURRENT portrait: re-preparing against bytes the renders have
  // already moved off would only produce another stale crop.
  const sourceImageId = stale ? (avatarImageId ?? packSourceImageId) : (packSourceImageId ?? avatarImageId);
  const natural = loaded && loaded.imageId === sourceImageId ? { width: loaded.width, height: loaded.height } : null;
  // The pack's recorded dimensions describe the pack's source; they are the editor's
  // geometry only while that is what is on screen (a stale pack shows another image).
  const source: SourceDimensions | null =
    packSourceImageId === sourceImageId && summary?.source.width && summary.source.height
      ? { width: summary.source.width, height: summary.source.height }
      : natural;

  // One flaky `/file` response must not brand an image permanently unreadable: the
  // verdict is dropped whenever the dialog reopens or the source changes, so the
  // decode below gets a clean attempt. Render-adjusted, never a setState in an effect.
  const decodeKey = `${open ? "open" : "closed"}|${sourceImageId ?? "none"}`;
  const [prevDecodeKey, setPrevDecodeKey] = useState(decodeKey);
  if (decodeKey !== prevDecodeKey) {
    setPrevDecodeKey(decodeKey);
    setLoadFailedFor(null);
  }

  // Decode the source once per id so the geometry has real dimensions even before a
  // pack exists (a "none" summary names no source size). setState happens in the
  // load callback, never synchronously inside the effect.
  useEffect(() => {
    if (!open || !sourceImageId) return;
    let active = true;
    const el = new Image();
    el.onload = () => {
      if (active && el.naturalWidth > 0 && el.naturalHeight > 0) {
        setLoaded({ imageId: sourceImageId, width: el.naturalWidth, height: el.naturalHeight });
      }
    };
    el.onerror = () => {
      if (active) setLoadFailedFor(sourceImageId);
    };
    el.src = imageUrl(sourceImageId);
    return () => {
      active = false;
    };
  }, [open, sourceImageId]);

  // Re-seed the square whenever the stored crop, the source, or the open state
  // changes — render-adjusted (the "previous render" pattern) rather than a
  // setState-in-effect. An unrelated panel refresh leaves the key alone, so
  // in-progress framing survives it.
  const storedCrop = summary?.crop ?? null;
  const seedKey = [
    open ? "open" : "closed",
    summary?.packId ?? "none",
    summary?.revision ?? 0,
    source ? `${source.width}x${source.height}` : "unsized",
    storedCrop ? `${storedCrop.left},${storedCrop.top},${storedCrop.width}` : "nocrop",
  ].join("|");
  const [prevSeedKey, setPrevSeedKey] = useState<string | null>(null);
  if (seedKey !== prevSeedKey) {
    setPrevSeedKey(seedKey);
    setSelection(source ? selectionFromCrop(storedCrop, source) : null);
    setConfirmReset(false);
  }

  // Latest onRefresh for the async paths — an inline arrow from the panel must not
  // re-arm the pending re-read below.
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  });
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Every installed summary bumps this, so a re-read can tell that its answer is
  // now older than what is on screen.
  const writeSeqRef = useRef(0);

  const applySummary = (next: IdentityPackSummaryWire) => {
    writeSeqRef.current += 1;
    setSummary(next);
    refreshRef.current();
  };

  const reread = async (trigger: "manual" | "background") => {
    // The background re-read must never undo a write: its GET can still be in
    // flight when a save lands, and installing that older summary would put the
    // revision the owner just replaced back on screen. The counter is the guard
    // that holds — a timer's captured `busy` can be a render behind, so that check
    // only saves the request.
    if (trigger === "background" && busy !== null) return;
    const seq = writeSeqRef.current;
    if (trigger === "manual") setBusy("refresh");
    const result = await identityPacksApi.get(characterId);
    if (!activeRef.current) return;
    if (trigger === "manual") setBusy(null);
    if (trigger === "background" && writeSeqRef.current !== seq) return;
    if (result.ok) applySummary(result.data.summary);
    else if (trigger === "manual") setNotice({ tone: "error", text: result.error.message });
  };

  // ONE delayed re-read while preparing, then the Refresh button takes over: a
  // background derivation is short, and an open dialog polling forever is exactly
  // the busy loop this surface must not become.
  const pendingKey = status === "pending" ? `${summary?.packId ?? ""}:${summary?.revision ?? 0}` : null;
  useEffect(() => {
    if (!open || pendingKey === null) return;
    const timer = setTimeout(() => void reread("background"), PENDING_REFRESH_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arms per pending revision only
  }, [open, pendingKey, characterId]);

  const display = source ? fitDisplayBox(source, EDITOR_BOX) : { width: 0, height: 0 };
  const scale = source ? displayScale(source, display) : 1;
  const rect = selection ? toDisplayRect(selection, scale) : null;
  const preview = selection && source ? cropPreviewLayout(selection, source, PREVIEW_SIDE) : null;
  const guard = guardOf(summary);
  const storedSelection = source ? selectionFromCrop(storedCrop, source) : null;
  const dirty =
    selection !== null &&
    storedSelection !== null &&
    (selection.left !== storedSelection.left ||
      selection.top !== storedSelection.top ||
      selection.side !== storedSelection.side);

  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const startDrag = (e: React.PointerEvent, mode: "move" | "resize", handle: IdentityCropHandle) => {
    const frame = frameRef.current;
    if (!frame || !selection || !source) return;
    const box = frame.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      mode,
      handle,
      originX: box.left,
      originY: box.top,
      startX: e.clientX,
      startY: e.clientY,
      base: selection,
    };
    // Capture on the FRAME (not the pressed handle) so one pair of move/up handlers
    // serves the body and all four grips.
    frame.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !source) return;
    setSelection(
      drag.mode === "move"
        ? moveSelection(drag.base, toSourceSpace({ x: e.clientX - drag.startX, y: e.clientY - drag.startY }, scale), source)
        : resizeSelection(
            drag.base,
            drag.handle,
            toSourceSpace({ x: e.clientX - drag.originX, y: e.clientY - drag.originY }, scale),
            source,
          ),
    );
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!selection || !source) return;
    const step = e.shiftKey ? NUDGE_PX * 4 : NUDGE_PX;
    const move = (x: number, y: number) => {
      e.preventDefault();
      setSelection(moveSelection(selection, { x, y }, source));
    };
    switch (e.key) {
      case "ArrowLeft":
        return move(-step, 0);
      case "ArrowRight":
        return move(step, 0);
      case "ArrowUp":
        return move(0, -step);
      case "ArrowDown":
        return move(0, step);
      case "+":
      case "=":
        e.preventDefault();
        return setSelection(clampSelection({ ...selection, side: selection.side + step }, source));
      case "-":
        e.preventDefault();
        return setSelection(clampSelection({ ...selection, side: selection.side - step }, source));
      default:
        return;
    }
  };

  const save = async () => {
    if (!guard || !selection || !source) return;
    setBusy("save");
    setNotice(null);
    const result = await identityPacksApi.manualCrop(characterId, { ...guard, crop: submissionOf(selection, source) });
    if (!activeRef.current) return;
    setBusy(null);
    if (result.ok) {
      applySummary(result.data.summary);
      toast.push({ title: "Face crop saved", description: "This is the reference identity renders will use.", tone: "success" });
      return;
    }
    const conflict = identityPackConflictSummary(result.error);
    if (conflict) {
      applySummary(conflict);
      setNotice({ tone: "info", text: "The portrait changed — reloading the current reference." });
      return;
    }
    if (result.error.status === 409) {
      setNotice({ tone: "info", text: "The portrait changed — reloading the current reference." });
      void reread("background");
      return;
    }
    setNotice({ tone: "error", text: writeErrorCopy(result.error) });
  };

  /** Prepare/reset share one shape: run, adopt the new summary, or explain the refusal. */
  const runPackWrite = async (kind: "ensure" | "reset", call: () => Promise<ApiResult<IdentityPackResponseWire>>) => {
    setBusy(kind);
    setNotice(null);
    const result = await call();
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: writeErrorCopy(result.error) });
      return;
    }
    applySummary(result.data.summary);
    // A 200 whose refusal never reached a revision: the summary is unchanged
    // (the previous pack, or none at all), so the body's `blocked` code is the
    // only thing that can tell the owner why nothing happened.
    const blocked = result.data.blocked;
    if (blocked) setNotice({ tone: "error", text: identityPackCodeCopy(blocked.code) });
  };

  const chip = identityPackSummaryChip(status, stale);
  // `stale` rather than a `stale` STATUS: the status arm is unreachable from a
  // summary, and a pack whose portrait moved on is exactly the one that needs the
  // action offered.
  const canPrepare = stale || status === "none" || status === "failed" || status === "unusable";
  const prepareLabel = stale ? "Re-prepare" : status === "none" ? "Prepare reference" : "Try again";
  const sourceUnreadable = loadFailedFor !== null && loadFailedFor === sourceImageId;
  // Codes come off the wire; a code this build has no copy for is DROPPED rather
  // than printed raw — a bare identifier on screen tells the owner nothing.
  const failureLine = parsedFailureCopy(summary?.failureCode ?? null);
  const warningLines = (summary?.warningCodes ?? []).flatMap((code) => {
    const parsed = imageIdentityPackWarningCodeSchema.safeParse(code);
    return parsed.success ? [{ code: parsed.data, text: identityPackCodeCopy(parsed.data) }] : [];
  });

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
        Close
      </Button>
      <Button
        variant="primary"
        busy={busy === "save"}
        disabled={!guard || !selection || !source || !dirty || busy !== null}
        onClick={() => void save()}
        title={guard ? undefined : "Prepare the reference first — a crop is saved against a pack revision."}
      >
        Save crop
      </Button>
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} title={`Face reference — ${name}`} size="xl" footer={footer}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-paper-400">
          <Tag tone={chip.tone}>{chip.label}</Tag>
          {summary?.method ? <span>{summary.method} crop</span> : null}
          {summary?.revision !== null && summary?.revision !== undefined ? <span>· revision {summary.revision}</span> : null}
          {stale ? <span className="text-accent-300">· the portrait moved on</span> : null}
          {summary && !summary.current && summary.packId ? <span>· not the current revision</span> : null}
          {status === "pending" ? (
            <Button size="sm" variant="quiet" busy={busy === "refresh"} onClick={() => void reread("manual")}>
              Refresh
            </Button>
          ) : null}
        </div>

        {failureLine ? (
          <p className="rounded-card border border-danger-500/40 bg-danger-500/5 px-3 py-2 text-xs text-danger-200">
            {failureLine}
          </p>
        ) : null}
        {warningLines.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-xs text-paper-400">
            {warningLines.map((warning) => (
              <li key={warning.code}>{warning.text}</li>
            ))}
          </ul>
        ) : null}
        {notice ? (
          <p
            className={cx(
              "rounded-card border px-3 py-2 text-xs",
              notice.tone === "error"
                ? "border-danger-500/40 bg-danger-500/5 text-danger-200"
                : "border-ink-600 bg-ink-950/40 text-paper-300",
            )}
          >
            {notice.text}
          </p>
        ) : null}

        <div className="flex flex-wrap items-start gap-5">
          {!sourceImageId ? (
            <p className="text-sm text-paper-500">
              This character has no canonical portrait yet. Generate or upload one, then prepare the face reference.
            </p>
          ) : sourceUnreadable ? (
            <p className="text-sm text-danger-300">{identityPackCodeCopy("source_unreadable")}</p>
          ) : !source || !selection || !rect ? (
            <p className="text-sm text-paper-500">Loading the portrait…</p>
          ) : (
            <div
              ref={frameRef}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="relative touch-none overflow-hidden rounded-card border border-ink-600 select-none"
              style={{ width: display.width, height: display.height }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- local asset route sized to the crop geometry; next/image cannot drive this preview */}
              <img
                src={imageUrl(sourceImageId)}
                alt={name}
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full"
              />
              <div className="pointer-events-none absolute inset-0 bg-ink-950/55" />
              <div
                role="group"
                tabIndex={0}
                aria-label="Face crop — drag to move, arrow keys to nudge, corner grips to resize"
                onPointerDown={(e) => startDrag(e, "move", "se")}
                onKeyDown={onKeyDown}
                className="absolute cursor-move rounded-sm outline outline-accent-400 focus-visible:outline-2"
                style={{ left: rect.left, top: rect.top, width: rect.size, height: rect.size }}
              >
                {/* The un-dimmed cut-out: the same image, back-offset inside a clipping
                    box so only the selected square shows through. The clip lives on this
                    inner div rather than the selection itself, which would also clip the
                    corner grips that sit outside its edges. */}
                <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element -- same source, un-dimmed inside the selection */}
                  <img
                    src={imageUrl(sourceImageId)}
                    alt=""
                    draggable={false}
                    aria-hidden="true"
                    className="absolute max-w-none"
                    style={{ left: -rect.left, top: -rect.top, width: display.width, height: display.height }}
                  />
                </div>
                {identityCropHandles.map((handle) => (
                  <span
                    key={handle}
                    onPointerDown={(e) => startDrag(e, "resize", handle)}
                    className={cx("absolute size-3 rounded-full border border-ink-900 bg-accent-400", HANDLE_POSITION[handle])}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="flex min-w-56 flex-1 flex-col gap-3">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Stored reference</h3>
            <div
              className="relative overflow-hidden rounded-card border border-ink-600 bg-ink-950"
              style={{ width: PREVIEW_SIDE, height: PREVIEW_SIDE }}
            >
              {preview && sourceImageId ? (
                // eslint-disable-next-line @next/next/no-img-element -- positioned by cropPreviewLayout; next/image cannot express it
                <img
                  src={imageUrl(sourceImageId)}
                  alt={`${name} face crop preview`}
                  draggable={false}
                  className="pointer-events-none absolute max-w-none"
                  style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height }}
                />
              ) : null}
            </div>
            <p className="text-xs text-paper-500">
              {dirty
                ? "Unsaved framing — save to make this the stored reference."
                : "This is the square identity renders receive."}
            </p>
            {selection ? (
              <p className="text-[11px] text-paper-600">
                {selection.side} × {selection.side} px at {selection.left}, {selection.top}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {canPrepare ? (
                <Button
                  busy={busy === "ensure"}
                  disabled={busy !== null || !sourceImageId}
                  onClick={() => void runPackWrite("ensure", () => identityPacksApi.ensure(characterId))}
                >
                  {prepareLabel}
                </Button>
              ) : null}
              {summary?.method === "manual" ? (
                <Button
                  variant="quiet"
                  disabled={busy !== null}
                  onClick={() => setConfirmReset(true)}
                  title="Discard this manual crop and let Vesper choose the crop again"
                >
                  Reset to automatic
                </Button>
              ) : null}
            </div>
            {confirmReset ? (
              <div className="flex flex-col gap-2 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-xs text-paper-300">
                <span>Reset to automatic? Your manual crop is replaced by a fresh automatic one.</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    busy={busy === "reset"}
                    onClick={() => {
                      setConfirmReset(false);
                      void runPackWrite("reset", () => identityPacksApi.resetAutomatic(characterId));
                    }}
                  >
                    Reset
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setConfirmReset(false)}>
                    Keep my crop
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {isAdmin && summary?.packId ? (
          <IdentityPackInspector
            packId={summary.packId}
            guard={guard}
            editorCrop={selection && source ? submissionOf(selection, source) : null}
            onOverridden={applySummary}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
