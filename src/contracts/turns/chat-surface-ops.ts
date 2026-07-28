import { z } from "zod";
import { diag, type DiagnosticSink } from "../diagnostics";
import {
  bodySurfaceWetnessAt,
  bodySurfaceWetnessCauseSchema,
  BODY_SURFACE_UNIT_ONE,
  pruneDryBodySurface,
  setBodySurfaceWetness,
  type BodySurfaceState,
  type BodySurfaceWetnessCause,
} from "../state/body-surface";
import {
  chatPrecipitationLevelSchema,
  chatWindLevelSchema,
  type ChatEnvironment,
} from "../state/chat-environment";

/**
 * The continuity extractor's **scene-environment and body-surface proposals**,
 * and their pure apply layer (body-attribute-affordances slice 4).
 *
 * The design law is the garment lane's, verbatim: *narrator prose is never parsed
 * at read time; the extraction leg proposes typed ops that commit through
 * `parseOr`.* A proposal is therefore never a state value — it is a small
 * semantic sentence ("the hair got a lot wetter, from rain") that this module
 * maps deterministically onto the owners in `state/body-surface.ts` and
 * `state/chat-environment.ts`. `level: 7314` is unreachable from a proposal, and
 * so is a body location nobody owns.
 *
 * Rejections are drops with a stable `chat_surface.*` code, never a throw
 * (docs/resilience.md §2), and the reducer clamps whatever the schema allowed.
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * A PARTIAL environment patch: only the keys the fiction actually settled. Each
 * field `.catch`es to `undefined` — a value outside the vocabulary drops that one
 * field and leaves the standing environment alone, rather than voiding the patch
 * or (worse) resetting the weather to the default.
 */
export const chatEnvironmentProposalSchema = z
  .object({
    wind: chatWindLevelSchema.optional().catch(undefined),
    precipitation: chatPrecipitationLevelSchema.optional().catch(undefined),
    indoors: z.boolean().optional().catch(undefined),
  })
  .catch({})
  .default({});
export type ChatEnvironmentProposal = z.infer<typeof chatEnvironmentProposalSchema>;

// ---------------------------------------------------------------------------
// Body-surface wetness
// ---------------------------------------------------------------------------

/**
 * The body locations this release owns surface wetness for. `hair` alone — the
 * audit's first production corpus is the hair domain, and a location with no
 * consumer would be state nobody reads (see `CHAT_SURFACE_LOCATION_UNKNOWN`).
 */
export const surfaceWetnessLocations = ["hair"] as const;
export type SurfaceWetnessLocation = (typeof surfaceWetnessLocations)[number];

/** Max wetness proposals accepted from one exchange — a beat wets a head, not a body chart. */
export const CHAT_SURFACE_WETNESS_MAX = 4;

/**
 * Degree → fixed-point delta. Three bands, deliberately coarse: the model judges
 * "a little / clearly / completely" and the table owns the numbers, so a
 * hallucinated magnitude is unreachable.
 *
 * `3` is the FULL range on purpose — "she comes out of the shower" and "she
 * towels off" should both land at the end of the scale in one move, and the
 * reducer clamps so an increase from half-wet cannot overshoot.
 */
export const SURFACE_WETNESS_DEGREE_DELTA: Readonly<Record<1 | 2 | 3, number>> = {
  1: 2_500,
  2: 5_000,
  3: BODY_SURFACE_UNIT_ONE,
};

export const surfaceWetnessProposalSchema = z
  .object({
    /** A body-location id. Parsed as free text so an unowned one can be REPORTED, not silently swallowed. */
    location: z.string().trim().min(1).max(64),
    direction: z.enum(["increase", "decrease"]),
    degree: z.union([z.literal(1), z.literal(2), z.literal(3)]).catch(2),
    cause: bodySurfaceWetnessCauseSchema.optional().catch(undefined),
  })
  .strict();
export type SurfaceWetnessProposal = z.infer<typeof surfaceWetnessProposalSchema>;

/**
 * Parsed PER ITEM so one malformed proposal drops instead of voiding the
 * exchange's whole surface read — the same boundary discipline
 * `garmentOperationProposalListSchema` applies.
 */
export const surfaceWetnessProposalListSchema = z
  .array(z.unknown())
  .catch([])
  .default([])
  .transform((items) =>
    items
      .flatMap((item) => {
        const parsed = surfaceWetnessProposalSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
      .slice(0, CHAT_SURFACE_WETNESS_MAX),
  );

// ---------------------------------------------------------------------------
// Trace + diagnostics
// ---------------------------------------------------------------------------

/** A proposal named a body location no owner tracks. */
export const CHAT_SURFACE_LOCATION_UNKNOWN = "chat_surface.location_unknown";

export const chatSurfaceOutcomes = ["applied", "no_change", "rejected"] as const;
export type ChatSurfaceOutcome = (typeof chatSurfaceOutcomes)[number];

/**
 * One proposal's fate, for the inspector and the tests. Deliberately NOT
 * persisted this slice: nothing renders it yet, and an unread column is a second
 * truth waiting to rot. The shape matches `GarmentOperationTraceEntry`'s so
 * lifting it onto the memory trace later is a move, not a redesign.
 */
export interface ChatSurfaceTraceEntry {
  readonly kind: "environment" | "wetness";
  /** The environment field or body location this entry is about. */
  readonly target: string;
  readonly outcome: ChatSurfaceOutcome;
  /** Stable `chat_surface.*` code on a rejection; "" otherwise. */
  readonly code: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ChatEnvironmentFold {
  environment: ChatEnvironment;
  trace: ChatSurfaceTraceEntry[];
}

/** The fields a patch may move — the trace walks exactly these. */
const ENVIRONMENT_FIELDS = ["wind", "precipitation", "indoors"] as const;

/**
 * Fold an environment patch onto the standing environment. PURE.
 *
 * `updatedAtMinutes` moves only when something ACTUALLY changed — it is the
 * freshness anchor a downstream read cites ("the storm started nine minutes
 * ago"), so restamping it on a no-op patch would make stale weather read as
 * fresh. An absent field means "no change", never "reset to default".
 *
 * There is deliberately no diagnostic sink here: every field either applies or
 * was already dropped by `chatEnvironmentProposalSchema`'s per-field `.catch`, so
 * this fold has no rejection path of its own to report.
 */
export function applyEnvironmentProposal(input: {
  environment: ChatEnvironment;
  proposal?: ChatEnvironmentProposal;
  atMinutes: number;
}): ChatEnvironmentFold {
  const proposal = input.proposal ?? {};
  const next: ChatEnvironment = {
    ...input.environment,
    ...(proposal.wind === undefined ? {} : { wind: proposal.wind }),
    ...(proposal.precipitation === undefined ? {} : { precipitation: proposal.precipitation }),
    ...(proposal.indoors === undefined ? {} : { indoors: proposal.indoors }),
  };
  const trace: ChatSurfaceTraceEntry[] = ENVIRONMENT_FIELDS.flatMap((field) =>
    next[field] === input.environment[field]
      ? []
      : [
          {
            kind: "environment" as const,
            target: field,
            outcome: "applied" as const,
            code: "",
            detail: `${String(input.environment[field])} → ${String(next[field])}`,
          },
        ],
  );
  if (trace.length === 0) return { environment: input.environment, trace: [] };
  return { environment: { ...next, updatedAtMinutes: Math.max(0, Math.trunc(input.atMinutes)) }, trace };
}

export interface ChatSurfaceWetnessFold {
  surface: BodySurfaceState;
  trace: ChatSurfaceTraceEntry[];
}

function isOwnedSurfaceLocation(locationId: string): locationId is SurfaceWetnessLocation {
  return (surfaceWetnessLocations as readonly string[]).includes(locationId);
}

/**
 * Fold this exchange's wetness proposals onto the surface state. PURE.
 *
 * Each proposal integrates its own location's drying forward to `atMinutes`
 * FIRST, then applies the delta — the garment `integrateGarmentCondition`
 * precedent: you may only ever move forward from a material write, so the value
 * that gets stamped is the honest one. Locations no proposal names are left
 * untouched except for pruning the ones that have dried to nothing, which cannot
 * change any read.
 *
 * An empty proposal list is therefore an idempotent no-op on a surface with
 * nothing dry to prune — the common case, every quiet exchange.
 */
export function applySurfaceWetnessProposals(input: {
  surface: BodySurfaceState;
  proposals: readonly SurfaceWetnessProposal[];
  atMinutes: number;
  sink?: DiagnosticSink;
}): ChatSurfaceWetnessFold {
  let surface = pruneDryBodySurface(input.surface, input.atMinutes);
  const trace: ChatSurfaceTraceEntry[] = [];

  for (const proposal of input.proposals.slice(0, CHAT_SURFACE_WETNESS_MAX)) {
    if (!isOwnedSurfaceLocation(proposal.location)) {
      const detail = `no surface owner for "${proposal.location}" — wetness change dropped`;
      trace.push({ kind: "wetness", target: proposal.location, outcome: "rejected", code: CHAT_SURFACE_LOCATION_UNKNOWN, detail });
      input.sink?.push(diag("info", CHAT_SURFACE_LOCATION_UNKNOWN, detail));
      continue;
    }
    const current = bodySurfaceWetnessAt(surface, proposal.location, input.atMinutes);
    const magnitude = SURFACE_WETNESS_DEGREE_DELTA[proposal.degree];
    const level = proposal.direction === "increase" ? current + magnitude : current - magnitude;
    const before = surface;
    // A DECREASE never records a cause: towelling off is not a reason the hair is
    // wet, and carrying the old cause forward at a lower level would let a
    // half-dried head keep citing rain that stopped hours ago.
    const cause: BodySurfaceWetnessCause | undefined = proposal.direction === "increase" ? proposal.cause : undefined;
    surface = setBodySurfaceWetness(surface, {
      locationId: proposal.location,
      level,
      atMinutes: input.atMinutes,
      ...(cause === undefined ? {} : { cause }),
    });
    const after = bodySurfaceWetnessAt(surface, proposal.location, input.atMinutes);
    trace.push({
      kind: "wetness",
      target: proposal.location,
      outcome: surface === before || after === current ? "no_change" : "applied",
      code: "",
      detail: `${current} → ${after}${cause ? ` (${cause})` : ""}`,
    });
  }

  return { surface, trace };
}
