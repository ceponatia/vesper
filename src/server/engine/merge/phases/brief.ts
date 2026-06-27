import { emptyBrief, nextTurnBriefSchema, type ExposureMask, type NextTurnBrief } from "@/contracts/state/brief";
import type { AtmosphereLabel } from "@/contracts/mood";
import type { ContinuityResult, DirectorResult } from "@/contracts/turns/agent-results";
import type { PhaseContext } from "../types";
import type { WorkingState } from "../working-state";

const CORRECTION_CAP = 2;
const THRESHOLD_HINT_CAP = 2;
const DIRECTIVE_CAP = 8;

export interface BriefBuildInput {
  prior: NextTurnBrief;
  director: DirectorResult | null;
  continuity: ContinuityResult | null;
  episodeSummary: string;
  droppedEvents: readonly string[];
  /** Newly crossed meter-threshold hints, "Name: hint". */
  thresholdHints: readonly string[];
  /** Schedule-tick staging lines (scheduleMoveStaging) — per-turn, never carried forward. */
  arrivals?: readonly string[];
  departures?: readonly string[];
  /** On-arrival directives from staged beats that fired this turn — play the beat next turn. */
  stagedDirectives?: readonly string[];
}

/**
 * Next-turn brief (docs/turn-engine.md step 7). Director failure → the
 * previous brief carries forward with sceneSummary refreshed from the episode
 * and memoryQueries kept. Continuity output folds in as at most
 * CORRECTION_CAP `Correction:`-prefixed directives (self-expiring — the brief
 * is rebuilt every turn).
 */
/** Scene tones that an intimate frame must NOT overwrite (an intimate scene can be fraught). */
const DARK_ATMOSPHERES: ReadonlySet<AtmosphereLabel> = new Set(["tense", "ominous", "melancholy"]);

/**
 * Resolve the next brief's scene tone (scene-atmosphere.spec.md §2): the director's
 * classification wins when present, else carry the prior tone forward (sticky — a quiet
 * turn doesn't reset to calm). Then a deterministic floor: an intimate frame reads
 * `romantic` unless the resolved tone is already dark. Pure + total.
 */
export function resolveAtmosphere(input: {
  director?: AtmosphereLabel;
  prior: AtmosphereLabel;
  exposure: ExposureMask;
}): AtmosphereLabel {
  const base = input.director ?? input.prior;
  const intimate = input.exposure.touch === "intimate" || input.exposure.appearance === "intimate";
  return intimate && !DARK_ATMOSPHERES.has(base) ? "romantic" : base;
}

export function buildNextBrief(input: BriefBuildInput): NextTurnBrief {
  // Arrivals/departures are this turn's staging only — stale lines would
  // re-stage a long-finished entrance, so they never carry forward from prior.
  const arrivals = [...(input.arrivals ?? [])];
  const departures = [...(input.departures ?? [])];
  const base: NextTurnBrief = input.director
    ? {
        sceneSummary: input.director.sceneSummary.trim() || input.episodeSummary || input.prior.sceneSummary,
        storySoFar: input.director.storySoFar.trim() || input.prior.storySoFar,
        characterNotes: [...input.director.characterNotes],
        directives: [...input.director.directives],
        memoryQueries: input.director.memoryQueries.length > 0 ? [...input.director.memoryQueries] : [...input.prior.memoryQueries],
        exposure: input.director.exposure,
        atmosphere: resolveAtmosphere({
          director: input.director.atmosphere,
          prior: input.prior.atmosphere,
          exposure: input.director.exposure,
        }),
        droppedEvents: [],
        arrivals,
        departures,
      }
    : {
        ...input.prior,
        sceneSummary: input.episodeSummary || input.prior.sceneSummary,
        characterNotes: [...input.prior.characterNotes],
        directives: [...input.prior.directives],
        memoryQueries: [...input.prior.memoryQueries],
        droppedEvents: [],
        arrivals,
        departures,
      };

  const corrections: string[] = [];
  if (input.continuity) {
    const violations = [...input.continuity.violations].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1,
    );
    for (const v of violations) {
      corrections.push(`Correction: the narration claimed "${v.claim}" but canon holds "${v.canonical}" (${v.subject}).`);
    }
    // Card-breach directives ride in via stagedDirectives (planCardBreachReactions), which
    // also folds the per-witness affinity — both need the world cards, resolved in the reducer.
  }

  const directives = dedupe([
    ...base.directives,
    ...(input.stagedDirectives ?? []),
    ...corrections.slice(0, CORRECTION_CAP),
    ...input.thresholdHints.slice(0, THRESHOLD_HINT_CAP),
  ]).slice(0, DIRECTIVE_CAP);

  const candidate: NextTurnBrief = {
    ...base,
    directives,
    droppedEvents: [...input.droppedEvents],
  };
  const parsed = nextTurnBriefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : emptyBrief();
}

/**
 * Reconcile-mode brief (docs/turn-engine.md §Edit / rerun): the prior brief
 * carries forward untouched — no director/continuity ran — except that this
 * reconcile's dropped events and newly crossed meter thresholds fold in.
 * Without this, an edit that references unknown entities fails silently and a
 * meter adjustment that crosses a threshold never surfaces to the next turn.
 * Returns the prior brief by identity when there is nothing to fold.
 */
export function reconcileBrief(
  prior: NextTurnBrief,
  droppedEvents: readonly string[],
  thresholdHints: readonly string[],
): NextTurnBrief {
  if (droppedEvents.length === 0 && thresholdHints.length === 0) return prior;
  const candidate: NextTurnBrief = {
    ...prior,
    directives: dedupe([...prior.directives, ...thresholdHints.slice(0, THRESHOLD_HINT_CAP)]).slice(0, DIRECTIVE_CAP),
    droppedEvents: dedupe([...prior.droppedEvents, ...droppedEvents]),
  };
  const parsed = nextTurnBriefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : prior;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// -- Step 7: next-turn brief --------------------------------------------------
export function phaseBrief(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, bundle, results, continuity } = ctx;
  ctx.brief = reconcile
    ? reconcileBrief(bundle.brief, state.droppedEvents, ctx.thresholdHints)
    : buildNextBrief({
        prior: bundle.brief,
        director: results.director,
        continuity,
        episodeSummary: ctx.episodeSummary,
        droppedEvents: state.droppedEvents,
        thresholdHints: ctx.thresholdHints,
        arrivals: state.arrivals,
        departures: state.departures,
        stagedDirectives: state.stagedDirectives,
      });
}
