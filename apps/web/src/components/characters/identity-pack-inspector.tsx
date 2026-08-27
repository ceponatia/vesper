"use client";

import { useEffect, useRef, useState } from "react";
import {
  adminIdentityPacksApi,
  imageUrl,
  type IdentityPackAdminRevision,
  type IdentityPackNormalizedCropWire,
  type IdentityPackSummaryWire,
  type IdentityPackWriteGuard,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";

export interface IdentityPackInspectorProps {
  packId: string;
  /** The concurrency triple an override must carry; null when the summary lacks one. */
  guard: IdentityPackWriteGuard | null;
  /** The square currently framed in the editor, offered as the override's coordinates. */
  editorCrop: IdentityPackNormalizedCropWire | null;
  onOverridden: (summary: IdentityPackSummaryWire) => void;
}

function versionLine(revision: IdentityPackAdminRevision): string {
  return [revision.derivationVersion, revision.policyVersion, revision.detectorVersion ?? "no detector"].join(" · ");
}

function cropLine(revision: IdentityPackAdminRevision): string {
  const crop = revision.crop;
  if (!crop) return "no crop";
  return `${crop.width}×${crop.height} at ${crop.left},${crop.top}`;
}

/**
 * Admin inspection for one pack.
 *
 * Deliberately RAW: revisions list their stable codes, versions and confidence
 * verbatim rather than the owner-facing copy, because the question an admin is
 * answering ("which policy version judged this, and on what measurement?") is
 * exactly the one prose erases. The history is fetched only when the section is
 * opened — most sessions never expand it, and it is an extra authorized round trip.
 */
export function IdentityPackInspector({ packId, guard, editorCrop, onOverridden }: IdentityPackInspectorProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="rounded-card border border-ink-600 bg-ink-950/40"
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary className="cursor-pointer px-3 py-2 text-xs text-paper-300 select-none">
        Inspection <span className="text-[10px] text-paper-600">admin only</span>
      </summary>
      {expanded ? (
        <IdentityPackInspectorBody packId={packId} guard={guard} editorCrop={editorCrop} onOverridden={onOverridden} />
      ) : null}
    </details>
  );
}

/** Mounted only while the section is open — that is what makes the fetch lazy. */
function IdentityPackInspectorBody({ packId, guard, editorCrop, onOverridden }: IdentityPackInspectorProps) {
  const history = useAsyncData(() => adminIdentityPacksApi.history(packId), [packId]);
  const [reason, setReason] = useState("");
  const [applyEditorCrop, setApplyEditorCrop] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Collapsing the section unmounts this body mid-request; the result must not be
  // applied to a surface that is gone.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const submit = async () => {
    const trimmed = reason.trim();
    if (!guard || !trimmed) return;
    setSubmitting(true);
    setError(null);
    const result = await adminIdentityPacksApi.override(packId, {
      ...guard,
      reason: trimmed,
      ...(applyEditorCrop && editorCrop ? { crop: editorCrop } : {}),
    });
    if (!activeRef.current) return;
    setSubmitting(false);
    if (result.ok) {
      setReason("");
      onOverridden(result.data.summary);
      history.reload({ silent: true });
    } else {
      setError(result.error.message || "The override was refused.");
    }
  };

  return (
    <div className="flex flex-col gap-4 border-t border-ink-600 px-3 py-3 text-xs text-paper-400">
      {history.loading ? (
        <p className="text-paper-500">Loading revisions…</p>
      ) : history.error ? (
        <ErrorState error={history.error} onRetry={() => history.reload()} />
      ) : (history.data?.history.length ?? 0) === 0 ? (
        <p className="text-paper-500">No revisions recorded for this pack.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(history.data?.history ?? []).map((revision) => (
            <li
              key={`${revision.revision}-${revision.createdAt}`}
              className="flex flex-col gap-1 rounded-card border border-ink-700 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-paper-200">r{revision.revision}</span>
                <Tag tone={revision.current ? "ok" : "default"}>{revision.status}</Tag>
                {revision.current ? <Tag tone="accent">current</Tag> : null}
                <span>{revision.method ?? "no method"}</span>
                {revision.confidence !== null ? <span>conf {revision.confidence.toFixed(3)}</span> : null}
                <span className="ml-auto text-paper-600">{revision.createdAt}</span>
              </div>
              <p className="text-paper-500">{versionLine(revision)}</p>
              <p className="text-paper-500">
                {cropLine(revision)}
                {revision.cropImageId ? (
                  <>
                    {" · "}
                    <a
                      href={imageUrl(revision.cropImageId)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent-300 hover:underline"
                    >
                      crop file
                    </a>
                  </>
                ) : null}
                {` · src ${revision.sourceContentHash.slice(0, 12)}`}
              </p>
              {revision.warningCodes.length > 0 ? (
                <p className="text-paper-500">warnings: {revision.warningCodes.join(", ")}</p>
              ) : null}
              {revision.failureCode ? (
                <p className="text-danger-300">
                  {revision.failureCode}
                  {revision.failureMessage ? ` — ${revision.failureMessage}` : ""}
                </p>
              ) : null}
              {revision.reviewReason ? (
                <p className="text-paper-500">
                  review: {revision.reviewReason}
                  {revision.reviewedByUserId ? ` (${revision.reviewedByUserId})` : ""}
                  {revision.reviewedAt ? ` · ${revision.reviewedAt}` : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 border-t border-ink-700 pt-3">
        <Field
          label="Override reason"
          hint="Required and audited — it is stored on the revision and shown here forever."
        >
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why the reviewed thresholds are being waived for this character"
            />
          )}
        </Field>
        <label className="flex items-center gap-2 text-paper-400">
          <input
            type="checkbox"
            checked={applyEditorCrop}
            disabled={!editorCrop}
            onChange={(e) => setApplyEditorCrop(e.target.checked)}
            className="size-3.5 accent-accent-500"
          />
          <span>Apply the crop framed above (otherwise the current coordinates are kept)</span>
        </label>
        {error ? <p className="text-danger-300">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="danger"
            busy={submitting}
            disabled={!guard || !reason.trim()}
            onClick={() => void submit()}
            title={guard ? undefined : "This pack has no current revision to override."}
          >
            Override
          </Button>
          <span className="text-paper-600">
            {guard ? `against r${guard.revision}` : "no current revision"}
          </span>
        </div>
      </div>
    </div>
  );
}
