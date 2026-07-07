"use client";

import { useState } from "react";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsMobile } from "@/components/hooks/use-is-mobile";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { ErrorState } from "@/components/ui/error-state";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { regardBandById, type MilestoneKind, type RelationshipSample } from "@/contracts";
import { chatsApi, type ChatRelationship } from "@/lib/client/api";
import { timeAgo } from "@/lib/relative-time";

/**
 * The Relationship panel (character-chat-standalone.spec.md §7): the two axes +
 * region, the two-line history sparkline (§7.2), milestones, unfinished business
 * (open loops, §6.2), the story so far with the rebuild recovery lever (§7.3),
 * and transcript export (§7.4). Hosted in the shared Sheet — bottom on phones,
 * right on desktop, same split as the conversation header menu.
 *
 * The body mounts only while the Sheet is open (Sheet unmounts its children on
 * close), so the payload refetches on every open — no staleness, and a chatId
 * switch reseeds for free.
 */
export function ChatRelationshipPanel({
  chatId,
  who,
  open,
  onClose,
}: {
  chatId: string;
  who: string;
  open: boolean;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={open} onClose={onClose} side={isMobile ? "bottom" : "right"} title={`Relationship — ${who}`}>
      <PanelBody chatId={chatId} />
    </Sheet>
  );
}

function PanelBody({ chatId }: { chatId: string }) {
  const rel = useAsyncData(() => chatsApi.relationship(chatId), [chatId]);

  if (rel.loading) {
    return (
      <div className="flex flex-col gap-4 p-4" aria-hidden="true">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (rel.error) return <ErrorState error={rel.error} onRetry={() => rel.reload()} className="m-4" />;
  const data = rel.data;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="prose-display text-2xl text-paper-100">{data.region || data.regardBand.label}</span>
        <div className="flex items-center gap-1.5">
          <Tag tone="accent" title={`Regard ${data.regard}`}>
            <span aria-hidden>♥</span> {data.regardBand.label}
          </Tag>
          <Tag title={`Familiarity ${data.familiarity}`}>{data.familiarityBand.label}</Tag>
        </div>
      </div>
      {data.relationship.kind || data.relationship.history ? (
        <p className="-mt-3 text-xs text-paper-400">
          {[data.relationship.kind, data.relationship.history].filter(Boolean).join(" — ")}
        </p>
      ) : null}

      <section>
        <SectionHeading>Where things stand</SectionHeading>
        <PositionPlot history={data.history} familiarity={data.familiarity} regard={data.regard} />
      </section>

      <section>
        <SectionHeading>History</SectionHeading>
        <Sparkline history={data.history} currentBandLabel={data.regardBand.label} />
      </section>

      <section>
        <SectionHeading>Milestones</SectionHeading>
        <Milestones milestones={data.milestones} />
      </section>

      {data.openLoops.length > 0 ? (
        <section>
          <SectionHeading>Unfinished business</SectionHeading>
          <div className="flex flex-wrap gap-1.5">
            {data.openLoops.map((loop, i) => (
              <Tag key={`${i}:${loop}`} className="whitespace-normal">
                {loop}
              </Tag>
            ))}
          </div>
        </section>
      ) : null}

      <StorySoFar chatId={chatId} storySoFar={data.storySoFar} onRebuilt={() => rel.reload({ silent: true })} />

      <ExportSection chatId={chatId} />
    </div>
  );
}

function SectionHeading({ children }: { children: string }) {
  return <h3 className="mb-2 text-xs font-medium tracking-wide text-paper-500 uppercase">{children}</h3>;
}

/**
 * The 2D relationship position (relationship-model v2 §UI, quadrant labels ruled
 * in): familiarity on x (0..100), regard on y (−100..100), the sampled history
 * as a faint trail behind the current point — enemies-to-lovers literally draws
 * its arc through the plane. Corner names come from the header's region label;
 * the plot itself stays quiet: axes, a zero line, the trail, the point.
 */
function PositionPlot({ history, familiarity, regard }: { history: RelationshipSample[]; familiarity: number; regard: number }) {
  const x = (fam: number) => Math.max(0, Math.min(100, fam));
  const y = (reg: number) => (100 - Math.max(-100, Math.min(100, reg))) / 2;
  const trail = history.map((s) => `${x(s.familiarity)},${y(s.regard)}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={`Familiarity ${familiarity} of 100, regard ${regard} of ±100`} className="h-28 w-full text-accent-300">
      <rect x={0} y={0} width={100} height={100} className="fill-ink-900/60 stroke-ink-600" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={0} y1={50} x2={100} y2={50} className="stroke-ink-600" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {history.length >= 2 ? (
        <polyline
          points={trail}
          fill="none"
          className="stroke-paper-600/60"
          strokeWidth={1}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <circle cx={x(familiarity)} cy={y(regard)} r={2.5} fill="currentColor" />
      <text x={2} y={97} className="fill-paper-600" fontSize={5}>
        strangers → deeply known
      </text>
      <text x={2} y={7} className="fill-paper-600" fontSize={5}>
        warm ↑
      </text>
    </svg>
  );
}

/**
 * Relationship-over-time sparkline (§7.2, two axes since relationship-model v2):
 * volatile regard as the accent polyline over a subtle zero line, the slow
 * familiarity ramp as a muted second line (0..100 mapped onto the same box).
 * `vector-effect: non-scaling-stroke` keeps line weight honest under the
 * non-uniform `preserveAspectRatio="none"` stretch. No chart library.
 */
function Sparkline({ history, currentBandLabel }: { history: RelationshipSample[]; currentBandLabel: string }) {
  const first = history[0];
  if (history.length < 2 || first === undefined) {
    return <p className="text-xs text-paper-500">No history yet — it starts moving as you talk.</p>;
  }
  const width = history.length - 1;
  // regard 100 → y 0 (top), -100 → y 100 (bottom); clamp defensively.
  const regardPoints = history
    .map((s, i) => `${i},${(100 - Math.max(-100, Math.min(100, s.regard))) / 2}`)
    .join(" ");
  // familiarity 0..100 → y 100..0 on the same box.
  const familiarityPoints = history
    .map((s, i) => `${i},${100 - Math.max(0, Math.min(100, s.familiarity))}`)
    .join(" ");
  const firstBandLabel = regardBandById(first.band)?.label ?? first.band;
  return (
    <svg
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Relationship history: ${history.length} samples from ${firstBandLabel} to ${currentBandLabel}`}
      className="h-12 w-full text-accent-300"
    >
      <line x1={0} y1={50} x2={width} y2={50} className="stroke-ink-600" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <polyline
        points={familiarityPoints}
        fill="none"
        className="stroke-paper-600"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={regardPoints}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Glyph + tone per milestone kind (§7.2) — small badges, not icon soup. */
const MILESTONE_GLYPHS: Record<MilestoneKind, { glyph: string; className: string }> = {
  first_exchange: { glyph: "✦", className: "text-accent-300" },
  stage_up: { glyph: "↑", className: "text-accent-300" },
  stage_down: { glyph: "↓", className: "text-paper-500" },
  familiarity_up: { glyph: "◆", className: "text-accent-300" },
  strong_reaction: { glyph: "!", className: "text-paper-300" },
  player_marked: { glyph: "★", className: "text-accent-300" },
};

function Milestones({ milestones }: { milestones: ChatRelationship["milestones"] }) {
  if (milestones.length === 0) return <p className="text-xs text-paper-500">No milestones yet.</p>;
  // Stored append-order (oldest first); the panel reads newest first.
  const newestFirst = [...milestones].reverse();
  return (
    <ul className="flex flex-col gap-1.5">
      {newestFirst.map((m, i) => {
        const badge = MILESTONE_GLYPHS[m.kind];
        const stamp = timeAgo(m.at);
        return (
          <li key={`${m.at}:${m.kind}:${i}`} className="flex items-baseline gap-2 text-sm">
            <span aria-hidden className={cx("w-4 shrink-0 text-center text-xs", badge.className)}>
              {badge.glyph}
            </span>
            <span className="min-w-0 flex-1 text-paper-200">{m.label}</span>
            {stamp ? <span className="shrink-0 text-[11px] text-paper-500">{stamp}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The rolling summary, read-only (§7.3), plus the rebuild recovery lever:
 * two-click confirm → POST …/summary/rebuild → toast + silent panel refresh.
 */
function StorySoFar({
  chatId,
  storySoFar,
  onRebuilt,
}: {
  chatId: string;
  storySoFar: string;
  onRebuilt: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const rebuild = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    const result = await chatsApi.rebuildSummary(chatId);
    setRebuilding(false);
    setConfirming(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't rebuild the summary", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Summary rebuilt", description: "Re-folded from the full transcript.", tone: "success" });
    onRebuilt();
  };

  return (
    <section>
      <SectionHeading>The story so far</SectionHeading>
      {storySoFar ? (
        <div className="max-h-48 overflow-y-auto rounded-md border border-ink-600 bg-ink-850 p-3 text-sm whitespace-pre-wrap text-paper-300">
          {storySoFar}
        </div>
      ) : (
        <p className="text-xs text-paper-500">No summary yet — it builds as the conversation grows.</p>
      )}
      <div className="mt-2">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-paper-400">
            <span>Re-read the whole transcript and replace this summary?</span>
            <Button size="sm" variant="quiet" busy={rebuilding} onClick={() => void rebuild()}>
              Rebuild
            </Button>
            <Button size="sm" variant="quiet" disabled={rebuilding} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => setConfirming(true)}
            title="Recovery lever — use after editing or deleting lines the summary already folded in."
          >
            Rebuild from full transcript
          </Button>
        )}
      </div>
    </section>
  );
}

/** Transcript export (§7.4): plain download anchors; the checkbox toggles the memory appendix. */
function ExportSection({ chatId }: { chatId: string }) {
  const [includeMemory, setIncludeMemory] = useState(false);
  const anchorClass =
    "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2.5 text-xs text-paper-400 transition-colors hover:bg-ink-800 hover:text-paper-100";
  return (
    <section>
      <SectionHeading>Export</SectionHeading>
      <div className="flex flex-wrap items-center gap-2">
        <a href={chatsApi.exportUrl(chatId, "md", includeMemory)} download className={anchorClass}>
          Export Markdown
        </a>
        <a href={chatsApi.exportUrl(chatId, "json", includeMemory)} download className={anchorClass}>
          Export JSON
        </a>
        <label className="flex items-center gap-1.5 text-xs text-paper-400">
          <input
            type="checkbox"
            checked={includeMemory}
            onChange={(e) => setIncludeMemory(e.target.checked)}
            className="size-4 accent-accent-500"
          />
          Include memory
        </label>
      </div>
    </section>
  );
}
