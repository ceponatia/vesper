"use client";

import { useState } from "react";
import type { IdentityPackSummaryStatus } from "@vesper/image-core";
import { identityPacksApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { IdentityCropDialog } from "./identity-crop-dialog";
import { identityPackSummaryChip, identityPackSummaryHint } from "./identity-pack-copy";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";

export interface IdentityReferencePanelProps {
  characterId: string;
  name: string;
  avatarImageId: string | null;
}

/**
 * The portrait tab's entry point into the face-crop editor
 * (image-identity-packs.plan.md §Correction path).
 *
 * Deliberately quiet: identity packs are machinery, and most owners never need to
 * think about the crop. The block states the current state in one chip and one line,
 * and everything else lives behind the dialog.
 *
 * A failed read renders NOTHING. This surface is additive — before the routes
 * exist, or with the feature off, the portrait studio must look exactly as it did
 * rather than growing an error card about a subsystem the owner never asked for.
 */
export function IdentityReferencePanel({ characterId, name, avatarImageId }: IdentityReferencePanelProps) {
  // Keyed on the canonical portrait as well as the character: generating,
  // uploading or promoting a new portrait replaces the bytes every pack field
  // describes, and a summary read against the OLD ones would leave this block
  // claiming "ready" and hand the dialog a crop framed on a portrait that is no
  // longer on screen. The hook's generation counter still drops the superseded
  // response, so a fast second promotion cannot land out of order.
  const pack = useAsyncData(() => identityPacksApi.get(characterId), [characterId, avatarImageId]);
  const [open, setOpen] = useState(false);

  if (pack.loading || pack.error) return null;

  const summary = pack.data?.summary ?? null;
  const status: IdentityPackSummaryStatus = summary?.status ?? "none";
  // The wire's `stale` boolean, not a stale STATUS: a retired revision is never the
  // current one the summary reports, so the flag is the only thing that can tell the
  // owner their reference no longer describes the portrait on screen.
  const stale = summary?.stale === true;
  const chip = identityPackSummaryChip(status, stale);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Identity reference</h3>
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2">
        <Tag tone={chip.tone}>{chip.label}</Tag>
        <span className="min-w-0 text-xs text-paper-500">{identityPackSummaryHint(status, stale)}</span>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => setOpen(true)}
          disabled={!avatarImageId && !summary?.source.imageId}
          title={avatarImageId ? undefined : "Generate or upload a canonical portrait first"}
        >
          Adjust face crop
        </Button>
      </div>
      <IdentityCropDialog
        key={characterId}
        open={open}
        onClose={() => setOpen(false)}
        characterId={characterId}
        name={name}
        avatarImageId={avatarImageId}
        summary={summary}
        onRefresh={() => pack.reload({ silent: true })}
      />
    </div>
  );
}
