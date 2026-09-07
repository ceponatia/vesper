import {
  adapterSupported,
  adapterUnavailable,
  affordanceEvidence,
  diag,
  effectiveCoverageAt,
  emptyEffectiveCoverageRead,
  isAdapterSupported,
  toUnitInterval,
  type AdapterRead,
  type ChatEnvironment,
  type ChatGarmentStore,
  type ContactMaterialLayerRead,
  type ContactMaterialRead,
  type DiagnosticSink,
  type EffectiveCoverageBand,
  type EffectiveCoverageRead,
  type UnitInterval,
  type WornItemInput,
  type WornVisibility,
  wornGarmentInstances,
} from "@/contracts";
import { chatGarmentCoverageForCut } from "../chat-garment-affordances";

// ---------------------------------------------------------------------------
// Material between
// ---------------------------------------------------------------------------

/**
 * How much each channel a covered surface lets through, per coverage band.
 *
 * **Minimal by declaration.** The wardrobe owns real material terms — weave,
 * thickness, saturation, friction — and none of them are projected into the
 * contact core yet; the only wardrobe fact this proof consults is the captured
 * effective-coverage BAND, which was derived for visibility rather than for
 * touch. So these numbers are carried, not decided upon: nothing in this slice
 * reads them. The resolution turns on `layers.length > 0` and the intent's
 * `any_material` access, and the narrator line says only that there is cloth in
 * between. A channel-aware registration is explicitly the LAST item in the
 * continuation order, and it replaces this table rather than tuning it.
 */
const COVERAGE_TRANSMISSION: Readonly<
  Record<EffectiveCoverageBand, { readonly tactile: number; readonly thermal: number; readonly visible: boolean }>
> = {
  opaque: { tactile: 6_000, thermal: 4_000, visible: false },
  hinted: { tactile: 8_000, thermal: 6_000, visible: true },
  exposed: { tactile: 9_000, thermal: 8_000, visible: true },
};

/**
 * Whether this conversation can say what is on a given body — and if so, what.
 *
 * `supported` is an ANSWER (layers where the wardrobe covers, bare where it does
 * not); `unavailable` means nobody in this lane knows, and the resolver turns
 * that into `unresolved` — silence — rather than a guess. The adapter result law
 * is reused verbatim rather than restated as a bespoke union: this is exactly
 * one lane input as the adapter found it.
 */
export type ChatContactMaterialSource = AdapterRead<EffectiveCoverageRead>;

/**
 * Where a roster member's material answer comes from, resolved ONCE per member.
 *
 * The chat lane has three genuinely different wardrobe situations, and only one
 * of them is "bare":
 *
 * 1. **This cut modelled the wardrobe into coverage** — the caller derived an
 *    effective-coverage read from the CURRENT exchange's resolved wardrobe
 *    (`chatGarmentCoverageForCut`, or the affordance read's own capture when one
 *    was taken this turn). That read IS the answer: entries where something
 *    covers, nothing where it does not. A read with no entries is a real
 *    "nothing over that surface", not an absence.
 * 2. **The body is dressed in clothes nothing modelled** — worn garment
 *    instances the coverage stages could not run over, or the legacy free-text
 *    path (`ChatState.outfit` / `wornItemIds` with no materialized instances),
 *    where the look lives in a phrase the narrator imagined. Something IS
 *    between the hand and the skin and this lane cannot name it, so the
 *    material is **unavailable** and the attempt resolves to silence.
 * 3. **The wardrobe says nothing is worn** — no modelled coverage, no
 *    instances, no worn ids, no free-text look. Then `[]` is the wardrobe's own
 *    answer and the touch lands on skin.
 *
 * Case 2 is the correction this function exists for. Reading an absent answer as
 * `[]` made "we never staged a wardrobe" indistinguishable from "she is bare",
 * and a committed contact then told the narrator it had skin under its hand —
 * a positive physical claim nothing in the conversation supports. Silence costs
 * one beat; that claim costs the fiction's clothes.
 *
 * **The persisted capture (`ChatGarmentStore.coverage`) is deliberately NOT
 * consulted.** It lands at the PREVIOUS exchange's settle, which is the settle
 * race: a touch sent before the prior turn's post-stream legs finished read "no
 * capture yet" for a body whose wardrobe this very turn had already resolved —
 * and, the mirror failure, a capture from an earlier cut could describe garments
 * the current wardrobe no longer wears. The caller derives `coverage` from the
 * current cut and hands it in; when that derivation says `null`, an older stored
 * capture is not a substitute for it.
 */
export function chatContactMaterialSource(input: {
  /**
   * The CURRENT exchange's derived coverage for this actor, or `null` when this
   * cut could not model their wardrobe into coverage.
   */
  readonly coverage: EffectiveCoverageRead | null;
  readonly store: ChatGarmentStore;
  readonly actorId: string;
  /** `ChatState.outfit` — the free-text look, which applies when nothing is materialized. */
  readonly freeTextOutfit: string;
  /** `ChatState.wornItemIds` — structured ids that may predate materialization. */
  readonly wornItemIds?: readonly string[];
}): ChatContactMaterialSource {
  if (input.coverage !== null) {
    return adapterSupported(input.coverage, [affordanceEvidence("coverage", `wardrobe:${input.actorId}`)]);
  }
  const dressed =
    wornGarmentInstances(input.store, input.actorId).length > 0 ||
    (input.wornItemIds?.length ?? 0) > 0 ||
    input.freeTextOutfit.trim().length > 0;
  return dressed ? adapterUnavailable : adapterSupported(emptyEffectiveCoverageRead());
}

/** The diagnostic a failed current-cut coverage derivation files. */
export const CHAT_CONTACT_COVERAGE_DERIVE_FAILED = "chat_contact.coverage.derive_failed";

/**
 * One body's material answer AT THE CUT THE CALLER IS STANDING IN — the whole
 * derivation, fenced, shared by both legs that need it.
 *
 * The pre-prompt player leg derives it from the exchange's resolved wardrobes;
 * the reply-scene decision leg derives it again from the POST-settle scenario's
 * current garment store and per-actor coverage. Those are two different cuts and
 * must stay two different reads — but they are the SAME derivation, and two
 * copies of it is how one leg quietly acquires a different answer to "is this
 * body dressed in something nobody modelled".
 *
 * `coverage` rides out beside the material because settlement persists the exact
 * object the resolver consumed rather than recomputing one, and because a caller
 * that took a capture this turn hands it back in as `captured` so both consumers
 * share one object.
 *
 * Fenced (docs/resilience.md §2): a derivation that throws degrades to "this cut
 * could not model the wardrobe", which the three-way law turns into
 * `unavailable` for a dressed body — silence with a diagnostic, never a stale
 * capture and never bare skin.
 */
export function chatContactMaterialAtCut(input: {
  readonly store: ChatGarmentStore;
  readonly actorId: string;
  /** The resolved wardrobe's coverage rows; absent ⇒ the wardrobe could not be read at all. */
  readonly worn?: readonly WornItemInput[];
  readonly visibility?: Readonly<Record<string, WornVisibility>>;
  readonly environment: ChatEnvironment;
  readonly clockMinutes: number;
  /** A read this turn already took for this actor — reused VERBATIM when present. */
  readonly captured?: EffectiveCoverageRead | null;
  /** `ChatState.outfit` / `ChatPlayerState.overlay` — the free-text look. */
  readonly freeTextOutfit: string;
  /** The structured worn ids, which may predate materialization. */
  readonly wornItemIds?: readonly string[];
  readonly sink?: DiagnosticSink;
}): { readonly coverage: EffectiveCoverageRead | null; readonly material: ChatContactMaterialSource } {
  let coverage: EffectiveCoverageRead | null = input.captured ?? null;
  if (coverage === null) {
    try {
      coverage = chatGarmentCoverageForCut({
        store: input.store,
        actorId: input.actorId,
        ...(input.worn === undefined ? {} : { worn: input.worn }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        environment: input.environment,
        clockMinutes: input.clockMinutes,
      });
    } catch (error) {
      input.sink?.push(
        diag(
          "warn",
          CHAT_CONTACT_COVERAGE_DERIVE_FAILED,
          "current-cut coverage derivation failed; this body's material reads unavailable",
          {
            path: "chat_contact",
            context: { actorId: input.actorId, error: error instanceof Error ? error.message : String(error) },
          },
        ),
      );
      coverage = null;
    }
  }
  return {
    coverage,
    material: chatContactMaterialSource({
      coverage,
      store: input.store,
      actorId: input.actorId,
      freeTextOutfit: input.freeTextOutfit,
      ...(input.wornItemIds === undefined ? {} : { wornItemIds: input.wornItemIds }),
    }),
  };
}

/**
 * What lies between the player's hand and the target surface, given an answer.
 *
 * A location NO worn garment reaches has no coverage entry, and that is bare
 * skin — the wardrobe's own answer, not something invented here. An entry in ANY
 * band is one interposed layer: `exposed` means the cover stopped CONCEALING,
 * which is a statement about sight, and the fabric is still there to touch.
 *
 * **Minimal, not wrong.** Only the BAND is consulted; the wardrobe's real
 * material terms (weave, thickness, friction) are not projected into the contact
 * core yet, so the numbers below are carried rather than decided upon. What this
 * function may never be handed is an ABSENCE — that case belongs to
 * `chatContactMaterialSource`, which reports it as `unavailable` instead.
 */
export function chatContactMaterialLayers(
  coverage: EffectiveCoverageRead | undefined,
  locationId: string,
): readonly ContactMaterialLayerRead[] {
  const band = effectiveCoverageAt(coverage, locationId);
  if (band === undefined) return [];
  const entry = coverage?.entries.find((row) => row.locationId === locationId);
  const transmission = COVERAGE_TRANSMISSION[band];
  const tactile: UnitInterval = toUnitInterval(transmission.tactile);
  return [
    {
      layerId: entry?.evidence[0]?.regionId ?? `coverage:${locationId}`,
      order: 0,
      tactileTransmission: tactile,
      shapeTransmission: tactile,
      thermalTransmission: toUnitInterval(transmission.thermal),
      moistureTransmission: toUnitInterval(0),
      scentTransmission: toUnitInterval(transmission.thermal),
      visibleThrough: transmission.visible,
      evidence: [affordanceEvidence("coverage", `coverage:${locationId}`, band)],
    },
  ];
}

/**
 * One participant's contribution to what lies between two surfaces: whose
 * wardrobe answer, over which of their own locations.
 *
 * `source` is the ACTING surface — the hand doing the touching, and whatever is
 * over it (a glove). `target` is the surface being touched. The distinction is
 * carried rather than inferred because it decides both the stack ORDER (a glove
 * is nearer the hand than her sleeve is) and the layer's identity: two hands
 * meeting produce two `hands` coverage reads, and un-prefixed ids would collide
 * into one layer that claims to be both.
 */
export interface ChatContactMaterialSide {
  readonly side: "source" | "target";
  /** That participant's answer, from `chatContactMaterialSource`. */
  readonly material: ChatContactMaterialSource;
  /** The location on THAT participant's own body. */
  readonly locationId: string;
}

/**
 * What lies between the two surfaces, composed from every side this lane can
 * read: material is resolved from BOTH sides, composing the actor-hand coverage
 * (gloves, source first) with the target-surface coverage (target garments
 * after it).
 *
 * **One unreadable side makes the whole read unavailable.** A hand whose glove
 * nobody modelled is exactly as unknown as a shoulder whose blouse nobody
 * modelled: in either case the lane cannot say what the touch lands through, and
 * `chatContactMaterialSource`'s three-way law already decided which of "modelled",
 * "dressed but unmodellable", and "genuinely bare" each side is. `unavailable`
 * rides out of here untouched, and the resolver's own material gate turns it into
 * `unresolved` — silence — with its own diagnostic. Composing the readable side
 * alone would be worse than silence: it would state a material the other body's
 * clothes may contradict.
 *
 * Stack order is the ARRAY order, with `order` renumbered across sides so the
 * composed list is one continuous stack rather than two stacks that both start at
 * zero. The player leg passes one side (the target's) and is unchanged by the
 * generalization beyond its layer ids gaining that side's prefix.
 */
export function chatContactMaterialBetween(
  sides: readonly ChatContactMaterialSide[],
): AdapterRead<ContactMaterialRead> {
  const layers: ContactMaterialLayerRead[] = [];
  for (const side of sides) {
    if (!isAdapterSupported(side.material)) return adapterUnavailable;
    for (const layer of chatContactMaterialLayers(side.material.value, side.locationId)) {
      layers.push({ ...layer, layerId: `${side.side}:${layer.layerId}`, order: layers.length });
    }
  }
  const evidence = layers.flatMap((layer) => [...layer.evidence]);
  return adapterSupported({ layers, evidence }, evidence);
}