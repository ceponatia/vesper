import { diag } from "@/contracts/diagnostics";
import type { ArchivistResult } from "@/contracts/turns/agent-results";
import { computeUnlocks } from "../../../memory";
import { findParticipant, resolveItemByName, resolveSessionLocation } from "../grounding";
import type { PhaseContext } from "../types";
import type { WorkingState } from "../working-state";

const SYNTHETIC_EPISODE_CHARS = 300;

export function syntheticEpisodeSummary(narration: string): string {
  const trimmed = narration.trim().replace(/\s+/g, " ");
  if (!trimmed) return "(turn completed without narration)";
  return trimmed.length <= SYNTHETIC_EPISODE_CHARS ? trimmed : `${trimmed.slice(0, SYNTHETIC_EPISODE_CHARS - 1)}…`;
}

// -- Step 5/6 planning: facts + episode --------------------------------------
export function phaseFactsEpisode(ctx: PhaseContext, state: WorkingState): void {
  const { results, bundle, turn, sink } = ctx;
  const archivist: ArchivistResult | null = results.archivist;
  const locByName = (name: string) => resolveSessionLocation(name, bundle.locations);
  ctx.factDrafts = (archivist?.facts ?? []).map((draft) => {
    let subjectId: string | null = null;
    if (draft.subjectKind === "character" || draft.subjectKind === "player") {
      subjectId = findParticipant(draft.subjectName, state.participants)?.id ?? null;
    } else if (draft.subjectKind === "location") {
      subjectId = locByName(draft.subjectName)?.id ?? null;
    } else if (draft.subjectKind === "item") {
      subjectId = resolveItemByName(draft.subjectName, "alter", state.items, null)?.id ?? null;
    }
    return { ...draft, subjectId };
  });

  const syntheticEpisode = !archivist || !archivist.episodeSummary.trim();
  ctx.episodeSummary = syntheticEpisode ? syntheticEpisodeSummary(turn.narration) : archivist.episodeSummary.trim();
  ctx.syntheticEpisode = syntheticEpisode;
  if (syntheticEpisode) {
    sink.push(diag("warn", "merge.episode.synthetic", "archivist failed — synthetic episode written from the narration"));
  }
}

// Lore unlocks from this turn's fact tags (exact lowercase tag match).
export function phaseLore(ctx: PhaseContext): void {
  const { bundle } = ctx;
  const factTags = ctx.factDrafts.flatMap((d) => d.tags);
  ctx.newlyUnlocked = computeUnlocks(factTags, bundle.loreChunks, {
    alreadyUnlockedIds: bundle.runtime.unlockedLoreIds,
    sessionId: ctx.logMissesForSessionId,
  });
}
