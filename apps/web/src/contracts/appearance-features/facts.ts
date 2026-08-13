import { z } from "zod";
import { parseOrNull } from "@/lib/parse";
import { diag, type DiagnosticSink } from "../diagnostics";
import { bodyLocusRefSchema } from "./locus";
import type { AppearanceFeatureKindRegistry } from "./registry";

/**
 * Located appearance facts — the lane-neutral typed rows for repeatable,
 * multi-instance, patterned marks that would otherwise explode an attribute
 * enum (body-attribute-affordances.spec.recognizable-features.md §Located
 * appearance facts).
 *
 * Owner ruling 2026-07-28: prose RAG facts are NEVER authoritative body truth.
 * These rows are; semantic-memory documents are generated downstream from
 * them, not the other way round. A row stores body truth, never "a thing worth
 * mentioning".
 */

/**
 * How the row came to exist. `authored` = character authoring; `event` = a
 * committed in-play transition (a wound that healed into a scar), which is
 * also the source that carries `sourceEventId`.
 */
export const appearanceFactSources = ["authored", "event"] as const;
export const appearanceFactSourceSchema = z.enum(appearanceFactSources);
export type AppearanceFactSource = z.infer<typeof appearanceFactSourceSchema>;

/**
 * The persisted row. Identity and placement are load-bearing and stay REQUIRED
 * (a row without them cannot be projected at all); everything else heals at
 * the JSONB boundary the way `affordanceCueStateSchema` does — a corrupt
 * provenance field degrades the row, it never rejects the character's whole
 * appearance blob (docs/resilience.md §1, §3).
 *
 * `validFrom` / `validUntil` are story-clock MINUTES, matching the chat lane's
 * story time; `validUntil` is exclusive.
 */
export const locatedAppearanceFactSchema = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1),
  kindId: z.string().min(1),
  locus: bodyLocusRefSchema,
  value: z.unknown(),
  source: appearanceFactSourceSchema.catch("authored"),
  sourceEventId: z.string().min(1).optional().catch(undefined),
  validFrom: z.number().int().min(0).catch(0),
  validUntil: z.number().int().min(0).optional().catch(undefined),
  supersedesFactId: z.string().min(1).optional().catch(undefined),
});

export type LocatedAppearanceFact = z.infer<typeof locatedAppearanceFactSchema>;

/** The row names a kind the registry does not know. */
export const APPEARANCE_FACT_KIND_UNKNOWN = "appearance.fact.kind_unknown";
/** The row's `value` did not parse through its kind's schema. */
export const APPEARANCE_FACT_VALUE_INVALID = "appearance.fact.value_invalid";
/** The row sits somewhere its kind does not allow. */
export const APPEARANCE_FACT_LOCUS_NOT_ALLOWED = "appearance.fact.locus_not_allowed";

/**
 * Trust-boundary parse for one persisted row (docs/resilience.md §1): heals
 * what it can, returns null plus a `parse.boundary_failed` diagnostic for a
 * row whose identity or placement is unusable.
 */
export function parseLocatedAppearanceFact(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "appearance.located_fact",
): LocatedAppearanceFact | null {
  return parseOrNull(locatedAppearanceFactSchema, raw, sink, path);
}

/**
 * The rows in force at `atMinutes`: inside their validity window, and not
 * superseded by another row that is itself in force.
 *
 * Supersedence chains resolve naturally — if C supersedes B and B supersedes
 * A, both A and B are named by a present row and drop out, leaving C. A row
 * whose superseder has expired is NOT resurrected: the superseding row is only
 * consulted while it is itself active, which keeps "one wound → one scar"
 * true at every point on the timeline.
 */
export function activeLocatedFacts(
  facts: readonly LocatedAppearanceFact[],
  atMinutes: number,
): readonly LocatedAppearanceFact[] {
  const inWindow = facts.filter(
    (fact) => fact.validFrom <= atMinutes && (fact.validUntil === undefined || atMinutes < fact.validUntil),
  );
  const superseded = new Set<string>();
  for (const fact of inWindow) {
    if (fact.supersedesFactId !== undefined) superseded.add(fact.supersedesFactId);
  }
  return inWindow.filter((fact) => !superseded.has(fact.id));
}

/**
 * Parse a row's `value` through its registered kind. Returns `null` and
 * records a warn diagnostic for an unknown kind or a malformed value — a
 * broken row is silence plus an explanation, never a thrown turn.
 */
export function parseLocatedFactValue(
  kinds: AppearanceFeatureKindRegistry,
  fact: LocatedAppearanceFact,
  sink?: DiagnosticSink,
  path = "appearance.located_fact.value",
): unknown {
  if (!kinds.byId(fact.kindId)) {
    sink?.push(
      diag("warn", APPEARANCE_FACT_KIND_UNKNOWN, `Unknown appearance feature kind ${fact.kindId}`, {
        path,
        context: { factId: fact.id, kindId: fact.kindId },
      }),
    );
    return null;
  }
  const result = kinds.parseValue(fact.kindId, fact.value);
  if (result.ok) return result.value;
  sink?.push(
    diag("warn", APPEARANCE_FACT_VALUE_INVALID, result.issues.slice(0, 3).join("; "), {
      path,
      context: { factId: fact.id, kindId: fact.kindId },
    }),
  );
  return null;
}
