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
  precipitationActive,
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

/**
 * **`.catch` is for narration-affecting leaves, never for state-mutating
 * magnitudes.** `degree` is strict for exactly that reason: it is the only thing
 * on this proposal that decides HOW MUCH state moves, and repairing a
 * hallucinated `999` to the middle band would commit a 50% wetness change that
 * nothing in the exchange asked for — a fabricated write dressed as resilience.
 * A bad degree fails the ITEM, and the item is dropped and reported.
 *
 * `cause` keeps its `.catch` because it is provenance only: it can add a "still
 * wet from the rain" tag to a cue and nothing else, so degrading it to "no
 * recorded reason" is strictly conservative. `direction` is likewise strict —
 * it decides the SIGN of the write.
 */
export const surfaceWetnessProposalSchema = z
  .object({
    /** A body-location id. Parsed as free text so an unowned one can be REPORTED, not silently swallowed. */
    location: z.string().trim().min(1).max(64),
    direction: z.enum(["increase", "decrease"]),
    degree: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    cause: bodySurfaceWetnessCauseSchema.optional().catch(undefined),
  })
  .strict();
export type SurfaceWetnessProposal = z.infer<typeof surfaceWetnessProposalSchema>;

/**
 * The RAW list as the extraction leg returned it — deliberately unparsed at the
 * aggregate boundary, because a schema-level `.transform` that silently discards
 * items has no sink to report the discard to. Consumers call
 * `parseSurfaceWetnessProposals` (below), which drops and REPORTS in one place.
 */
export const surfaceWetnessProposalListSchema = z.array(z.unknown()).catch([]).default([]);

// ---------------------------------------------------------------------------
// Trace + diagnostics
// ---------------------------------------------------------------------------

/** A proposal named a body location no owner tracks. */
export const CHAT_SURFACE_LOCATION_UNKNOWN = "chat_surface.location_unknown";

/** One or more proposals in the list failed to parse and were dropped. */
export const CHAT_SURFACE_PROPOSAL_INVALID = "chat_surface.proposal_invalid";

/**
 * Parse the raw proposal list PER ITEM, dropping what fails — the same boundary
 * discipline `garmentOperationProposalListSchema` applies, except the drop is
 * visible: one `warn` carries how many items were lost, so a model that has
 * started emitting garbage magnitudes shows up in the inspector instead of
 * quietly committing nothing (or, before this, quietly committing a repair).
 */
export function parseSurfaceWetnessProposals(
  raw: unknown,
  sink?: DiagnosticSink,
  path?: string,
): SurfaceWetnessProposal[] {
  const items = surfaceWetnessProposalListSchema.parse(raw);
  const proposals: SurfaceWetnessProposal[] = [];
  let dropped = 0;
  for (const item of items) {
    const parsed = surfaceWetnessProposalSchema.safeParse(item);
    if (parsed.success) proposals.push(parsed.data);
    else dropped += 1;
  }
  if (dropped > 0) {
    sink?.push(
      diag("warn", CHAT_SURFACE_PROPOSAL_INVALID, `${dropped} malformed surface-wetness proposal(s) dropped`, {
        ...(path === undefined ? {} : { path }),
        context: { dropped, kept: proposals.length },
      }),
    );
  }
  return proposals.slice(0, CHAT_SURFACE_WETNESS_MAX);
}

export const chatSurfaceOutcomes = ["applied", "no_change", "rejected"] as const;
export type ChatSurfaceOutcome = (typeof chatSurfaceOutcomes)[number];

/**
 * One proposal's fate, for the inspector and the tests. Deliberately NOT
 * persisted this slice: nothing renders it yet, and an unread column is a second
 * truth waiting to rot. The shape matches `GarmentOperationTraceEntry`'s so
 * lifting it onto the memory trace later is a move, not a redesign.
 */
export interface ChatSurfaceTraceEntry {
  readonly kind: "environment" | "wetness" | "mark";
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
 * Is committed surface wetness held rather than dried right now?
 *
 * ONE definition, shared by the finalize fold and the affordance adapter, so the
 * number a read reports and the number a write stamps can never disagree.
 * Standing outdoor precipitation is the whole rule: rain that is actively
 * landing does not let hair dry. (`precipitationActive` already encodes the
 * enclosure half — a downpour seen through a window wets, and holds, nobody.)
 *
 * Holding never RAISES wetness. Getting wetter is a physical event the fiction
 * has to play, and it commits through a proposal like everything else; all this
 * does is decline to dry what is standing in the rain.
 */
export function surfaceDryingSuspended(environment: ChatEnvironment): boolean {
  return precipitationActive(environment);
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
 * `environment` is the scene's weather **as of the end of this exchange** — the
 * caller applies its environment patch first and passes the result, so the
 * integration uses the sky the exchange finished under. That is a deliberate
 * one-window approximation: a beat where the rain stops halfway through is
 * integrated as though it had already stopped, which errs toward drying at the
 * boundary of a single exchange rather than modelling sub-exchange weather the
 * lane cannot observe. Absent ⇒ no suspension, the pre-review behaviour.
 *
 * An empty proposal list is therefore an idempotent no-op on a surface with
 * nothing dry to prune — the common case, every quiet exchange.
 */
export function applySurfaceWetnessProposals(input: {
  surface: BodySurfaceState;
  proposals: readonly SurfaceWetnessProposal[];
  atMinutes: number;
  environment?: ChatEnvironment;
  sink?: DiagnosticSink;
}): ChatSurfaceWetnessFold {
  const readOptions = { suspendDrying: input.environment ? surfaceDryingSuspended(input.environment) : false };
  let surface = pruneDryBodySurface(input.surface, input.atMinutes, readOptions);
  const trace: ChatSurfaceTraceEntry[] = [];

  for (const proposal of input.proposals.slice(0, CHAT_SURFACE_WETNESS_MAX)) {
    if (!isOwnedSurfaceLocation(proposal.location)) {
      const detail = `no surface owner for "${proposal.location}" — wetness change dropped`;
      trace.push({ kind: "wetness", target: proposal.location, outcome: "rejected", code: CHAT_SURFACE_LOCATION_UNKNOWN, detail });
      input.sink?.push(diag("info", CHAT_SURFACE_LOCATION_UNKNOWN, detail));
      continue;
    }
    // A QUARANTINED location has no readable base, so the delta lands on dry —
    // and the write REPLACES the marker, which is the heal path: a fresh
    // authoritative statement about this body is exactly what corruption was
    // waiting for. (An increase therefore lands at its own magnitude, and a
    // decrease resolves the location to honest absence.)
    const read = bodySurfaceWetnessAt(surface, proposal.location, input.atMinutes, readOptions);
    const current = read.status === "known" ? read.level : 0;
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
    const after = bodySurfaceWetnessAt(surface, proposal.location, input.atMinutes, readOptions);
    const settled = after.status === "known" ? after.level : current;
    trace.push({
      kind: "wetness",
      target: proposal.location,
      outcome: surface === before || (read.status === "known" && settled === current) ? "no_change" : "applied",
      code: "",
      detail: `${read.status === "known" ? current : "invalid"} → ${settled}${cause ? ` (${cause})` : ""}`,
    });
  }

  return { surface, trace };
}
