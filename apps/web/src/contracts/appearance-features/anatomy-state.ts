import { z } from "zod";
import { parseOrNull } from "@/lib/parse";
import type { DiagnosticSink } from "../diagnostics";
import { bodyLocusKey, bodyLocusRefSchema, validateBodyLocusRefStrict } from "./locus";

/**
 * Realized anatomy / topology state — presence, absence, alteration, or
 * replacement of a body part.
 *
 * Topology affects action validation as well as appearance, so it is EVENTED:
 * every row names the committed event that produced it (`sourceEventId` is
 * required, unlike a located fact's optional provenance). Recognition may
 * describe the consequence; it never owns or mutates topology.
 */

/** A registered alteration (a shortened horn, a torn ear). Free-form id for v1. */
export type AnatomyAlterationKindId = string;

export const anatomyPartStateValues = ["present", "absent", "altered", "prosthetic"] as const;
export const anatomyPartStateValueSchema = z.enum(anatomyPartStateValues);
export type AnatomyPartStateValue = z.infer<typeof anatomyPartStateValueSchema>;

export const anatomyPartStateSchema = z.object({
  subjectId: z.string().min(1),
  locus: bodyLocusRefSchema,
  state: anatomyPartStateValueSchema,
  alterationKindId: z.string().min(1).optional().catch(undefined),
  /** Story-clock minutes. */
  effectiveFrom: z.number().int().min(0).catch(0),
  /** Required: topology only ever changes through a committed event. */
  sourceEventId: z.string().min(1),
});

export type AnatomyPartState = z.infer<typeof anatomyPartStateSchema>;

/** Trust-boundary parse for one persisted topology row. */
export function parseAnatomyPartState(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "appearance.anatomy_state",
): AnatomyPartState | null {
  return parseOrNull(anatomyPartStateSchema, raw, sink, path);
}

/**
 * The topology in force at `atMinutes`: per subject and locus, the row with
 * the greatest `effectiveFrom` at or before `atMinutes` wins (ties go to the
 * later row in the list — last write).
 *
 * Loci validate STRICTLY: a detail path the registry cannot validate is
 * rejected with a diagnostic and the row is ignored, because widening a
 * topology claim to the coarse locus would assert something false ("the
 * fingers are absent"). See `coarsenBodyLocusRef` in locus.ts.
 *
 * Output is sorted by subject + locus key so a projection over it is
 * deterministic.
 */
export function currentAnatomyStates(
  states: readonly AnatomyPartState[],
  atMinutes: number,
  sink?: DiagnosticSink,
): readonly AnatomyPartState[] {
  const winners = new Map<string, AnatomyPartState>();
  for (const state of states) {
    if (state.effectiveFrom > atMinutes) continue;
    const validation = validateBodyLocusRefStrict(state.locus, sink);
    if (!validation.ok) continue;
    const key = `${state.subjectId}|${bodyLocusKey(validation.locus)}`;
    const current = winners.get(key);
    if (current === undefined || state.effectiveFrom >= current.effectiveFrom) winners.set(key, state);
  }
  return [...winners.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, state]) => state);
}
