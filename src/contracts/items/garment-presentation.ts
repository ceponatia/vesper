import { diag, type DiagnosticSink } from "../diagnostics";
import {
  garmentBehaviorBindingFor,
  garmentPartNode,
  GARMENT_MAX_PART_NODES,
  type GarmentBehavior,
  type GarmentBehaviorBinding,
  type GarmentBlueprint,
} from "./garment-blueprint";
import { nextGarmentCondition, type GarmentConditionOperation } from "./garment-condition";
import { isFastenerSeriesBehavior } from "./garment-coverage";
import { GARMENT_DEGREE_BAND_VALUES, type GarmentUnit } from "./garment-material";
import {
  garmentClosureOpenFraction,
  type ChatGarmentStore,
  type GarmentChangeKind,
  type GarmentClosureState,
  type GarmentDisplacement,
  type GarmentDisplacementKind,
  type GarmentInstanceState,
  type GarmentOperation,
  type GarmentPresentationState,
} from "./garment-instance";
import { applyGarmentTransfers, garmentBlueprintFor, type GarmentOperationResult } from "./garment-store";

/**
 * The PRESENTATION reducer (clothing-state-graph.plan.md §Slice 3 · §"Typed
 * mutation surface"; slice-0 audit OQ6/OQ7).
 *
 * Slice 2 taught the store how a garment MOVES; this module teaches it how a
 * garment is currently ARRANGED — closures opened, sleeves rolled, hems tucked,
 * straps and hems displaced, and the whole lot put back. It is the counterpart
 * to garment-coverage.ts: that file states what each behavior may subtract, this
 * one decides which channel a part legally has and what its current reading is.
 *
 * Three rules hold everything together:
 *
 * 1. **A channel exists only where a behavior binds it.** `GARMENT_BEHAVIOR_CHANNEL`
 *    is the single table mapping the six behaviors to the four presentation
 *    channels, shared by the reducer (which validates against it) and the derived
 *    read (which reads through it), so a stored value on an unbound part can never
 *    change a coverage read.
 * 2. **Every rejection is a stable-code diagnostic, never a throw** — an
 *    unresolvable part, an unbound channel, a mismatched closure shape and a
 *    `gone` garment all DROP their operation and leave the store byte-identical
 *    (docs/resilience.md §2).
 * 3. **Locus rule:** presentation applies at every locus EXCEPT `gone`. A jacket
 *    over a chair or folded in the wardrobe can still be buttoned (it contributes
 *    no coverage either way, and re-donning it must find the arrangement it was
 *    left in); a garment the fiction destroyed has nothing left to arrange.
 */

// --- Channels -----------------------------------------------------------------

/** The four presentation channels an operation can address. */
export const garmentPresentationChannels = ["closure", "roll", "tuck", "displacement"] as const;
export type GarmentPresentationChannel = (typeof garmentPresentationChannels)[number];

/**
 * Which channel each behavior drives — the ONE binding table. A part whose
 * behavior maps elsewhere (or has no behavior at all) rejects the operation with
 * `garment_op.channel_unbound`: a roll on a placket is not a quiet no-op, it is a
 * hallucinated handle (OQ7).
 */
export const GARMENT_BEHAVIOR_CHANNEL: Readonly<Record<GarmentBehavior, GarmentPresentationChannel>> = {
  linear_front_closure: "closure",
  zipper_closure: "closure",
  rollable_sleeve: "roll",
  adjustable_strap: "displacement",
  tuckable_hem: "tuck",
  liftable_hem: "displacement",
};

/**
 * The displacement kind each displacement-channel behavior accepts. A strap can
 * fall off a shoulder and a hem can be lifted; neither can do the other's job,
 * because each kind carries its own coverage law (OQ6).
 */
export const GARMENT_BEHAVIOR_DISPLACEMENT_KIND: Readonly<Record<GarmentBehavior, GarmentDisplacementKind | null>> = {
  linear_front_closure: null,
  zipper_closure: null,
  rollable_sleeve: null,
  adjustable_strap: "off_shoulder",
  tuckable_hem: null,
  liftable_hem: "lifted",
};

/** The five operation kinds this slice owns. */
export const garmentPresentationOperationKinds = [
  "set_closure",
  "set_roll",
  "set_tuck",
  "set_displacement",
  "restore_presentation",
] as const;
export type GarmentPresentationOperationKind = (typeof garmentPresentationOperationKinds)[number];
export type GarmentPresentationOperation = Extract<GarmentOperation, { kind: GarmentPresentationOperationKind }>;

/** True when an operation addresses the presentation graph rather than a locus or a gradient. */
export function isGarmentPresentationOperation(operation: GarmentOperation): operation is GarmentPresentationOperation {
  return (garmentPresentationOperationKinds as readonly string[]).includes(operation.kind);
}

/** The channel each part-addressed presentation operation requires of its part. */
const CHANNEL_FOR_OPERATION: Readonly<
  Record<Exclude<GarmentPresentationOperationKind, "restore_presentation">, GarmentPresentationChannel>
> = {
  set_closure: "closure",
  set_roll: "roll",
  set_tuck: "tuck",
  set_displacement: "displacement",
};

// --- Current channel reading --------------------------------------------------

/**
 * The stored closure's normalized open fraction, read CONSERVATIVELY: a value
 * whose shape does not match the behavior's declared closure kind (only reachable
 * through a corrupt blob — the reducer refuses to write one) reads as fully
 * fastened, because "more covered" is the safe direction for a degraded value.
 */
function closureDegree(state: GarmentClosureState | undefined, binding: GarmentBehaviorBinding): GarmentUnit {
  if (!state) return 0;
  if (isFastenerSeriesBehavior(binding.behavior) !== (state.kind === "fastener_series")) return 0;
  return garmentClosureOpenFraction(state, binding.fastenerCount);
}

/**
 * The normalized 0–1 channel reading a part's coverage law consumes — the single
 * place presentation state becomes a `GarmentChannelReading.degree`. An unbound
 * part, or a `tuck` binding (which has no coverage law at all), reads `0`.
 */
export function garmentChannelDegree(
  presentation: GarmentPresentationState,
  partId: string,
  binding: GarmentBehaviorBinding | undefined,
): GarmentUnit {
  if (!binding) return 0;
  switch (GARMENT_BEHAVIOR_CHANNEL[binding.behavior]) {
    case "closure":
      return closureDegree(presentation.closure[partId], binding);
    case "roll":
      return presentation.roll[partId] ?? 0;
    case "tuck":
      // Tuck is silhouette only (OQ6) — it never feeds a coverage law.
      return 0;
    case "displacement": {
      const kind = GARMENT_BEHAVIOR_DISPLACEMENT_KIND[binding.behavior];
      if (!kind) return 0;
      return presentation.displacement.find((entry) => entry.partId === partId && entry.kind === kind)?.degree ?? 0;
    }
  }
}

// --- Structural comparison ----------------------------------------------------

function sameRecord<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>, eq: (x: T, y: T) => boolean): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const right = b[key];
    const left = a[key];
    return left !== undefined && right !== undefined && eq(left, right);
  });
}

function sameClosure(a: GarmentClosureState, b: GarmentClosureState): boolean {
  if (a.kind === "continuous") return b.kind === "continuous" && a.openness === b.openness;
  return (
    b.kind === "fastener_series" &&
    a.openFastenerIndexes.length === b.openFastenerIndexes.length &&
    a.openFastenerIndexes.every((index, at) => index === b.openFastenerIndexes[at])
  );
}

/** Structural presentation equality — the "this operation changes nothing" test. */
export function sameGarmentPresentation(a: GarmentPresentationState, b: GarmentPresentationState): boolean {
  return (
    sameRecord(a.closure, b.closure, sameClosure) &&
    sameRecord(a.roll, b.roll, (x, y) => x === y) &&
    sameRecord(a.tuck, b.tuck, (x, y) => x === y) &&
    a.displacement.length === b.displacement.length &&
    a.displacement.every((entry) =>
      b.displacement.some((other) => other.partId === entry.partId && other.kind === entry.kind && other.degree === entry.degree),
    )
  );
}

// --- The reducer --------------------------------------------------------------

function drop(sink: DiagnosticSink | undefined, code: string, message: string): null {
  sink?.push(diag("info", code, message));
  return null;
}

/** Copy a record without the named keys (a restore clears a channel rather than zeroing it). */
function withoutKeys<T>(record: Readonly<Record<string, T>>, remove: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !remove.has(key)));
}

/** Keep only the fastener indexes the binding's declared count actually has. */
function clampFastenerIndexes(indexes: readonly number[], fastenerCount: number | undefined): number[] {
  const count = fastenerCount ?? 0;
  return [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0 && index < count))].sort(
    (a, b) => a - b,
  );
}

/**
 * The next presentation for one operation, or `null` when the operation is
 * DROPPED (with its diagnostic already pushed). Pure over one instance's
 * blueprint + presentation.
 */
export function nextGarmentPresentation(
  presentation: GarmentPresentationState,
  blueprint: GarmentBlueprint,
  operation: GarmentPresentationOperation,
  sink?: DiagnosticSink,
): GarmentPresentationState | null {
  if (operation.kind === "restore_presentation") {
    // Empty `partIds` restores NOTHING (garment-instance.ts §GARMENT_ROOT_SCOPED_OPERATIONS):
    // only the condition-class operations may mean "the whole garment" with an
    // empty list, and the audit lists restore among those that never fall back.
    // A whole-garment restore is authored by naming the parts.
    if (operation.partIds.length === 0) {
      return drop(
        sink,
        "garment_op.restore_no_parts",
        "restore_presentation named no parts — dropped (an empty list is not a whole-garment restore)",
      );
    }
    for (const partId of operation.partIds) {
      if (!garmentPartNode(blueprint, partId)) {
        return drop(sink, "garment_op.part_unresolved", `no garment part "${partId}" — restore_presentation dropped`);
      }
    }
    const cleared = new Set<string>(operation.partIds);
    return {
      closure: withoutKeys(presentation.closure, cleared),
      roll: withoutKeys(presentation.roll, cleared),
      tuck: withoutKeys(presentation.tuck, cleared),
      displacement: presentation.displacement.filter((entry) => !cleared.has(entry.partId)),
    };
  }

  if (!garmentPartNode(blueprint, operation.partId)) {
    return drop(sink, "garment_op.part_unresolved", `no garment part "${operation.partId}" — ${operation.kind} dropped`);
  }
  const binding = garmentBehaviorBindingFor(blueprint, operation.partId);
  const channel = CHANNEL_FOR_OPERATION[operation.kind];
  if (!binding || GARMENT_BEHAVIOR_CHANNEL[binding.behavior] !== channel) {
    return drop(
      sink,
      "garment_op.channel_unbound",
      `garment part "${operation.partId}" has no ${channel} behavior${binding ? ` (it is ${binding.behavior})` : ""} — ${operation.kind} dropped`,
    );
  }

  switch (operation.kind) {
    case "set_closure": {
      const wantsSeries = isFastenerSeriesBehavior(binding.behavior);
      if (wantsSeries !== (operation.state.kind === "fastener_series")) {
        return drop(
          sink,
          "garment_op.closure_shape",
          `garment part "${operation.partId}" declares a ${wantsSeries ? "fastener_series" : "continuous"} closure — set_closure dropped`,
        );
      }
      const state: GarmentClosureState =
        operation.state.kind === "fastener_series"
          ? {
              kind: "fastener_series",
              openFastenerIndexes: clampFastenerIndexes(operation.state.openFastenerIndexes, binding.fastenerCount),
            }
          : operation.state;
      return { ...presentation, closure: { ...presentation.closure, [operation.partId]: state } };
    }
    case "set_roll":
      return {
        ...presentation,
        roll: { ...presentation.roll, [operation.partId]: GARMENT_DEGREE_BAND_VALUES[operation.degree] },
      };
    case "set_tuck":
      return { ...presentation, tuck: { ...presentation.tuck, [operation.partId]: operation.state } };
    case "set_displacement": {
      const kind = GARMENT_BEHAVIOR_DISPLACEMENT_KIND[binding.behavior];
      if (kind === null || kind !== operation.displacement) {
        return drop(
          sink,
          "garment_op.displacement_kind",
          `garment part "${operation.partId}" cannot be displaced "${operation.displacement}" — set_displacement dropped`,
        );
      }
      const entry: GarmentDisplacement = {
        partId: operation.partId,
        kind,
        degree: GARMENT_DEGREE_BAND_VALUES[operation.degree],
      };
      const others = presentation.displacement.filter(
        (existing) => !(existing.partId === entry.partId && existing.kind === entry.kind),
      );
      return { ...presentation, displacement: [...others, entry].slice(-GARMENT_MAX_PART_NODES) };
    }
  }
}

/**
 * Resolve one part-addressed operation's instance and hand it to `mutate`, or
 * DROP it with a stable code. The locus rule both slices share: everything but
 * `gone`. A jacket over a chair can still be buttoned or rained on (it
 * contributes no coverage either way, and re-donning it must find what was left);
 * a garment the fiction destroyed has nothing left to change.
 *
 * `mutate` returns `null` for "dropped or changed nothing" — its own diagnostic
 * is already pushed by then.
 */
function applyInstanceOperation(
  store: ChatGarmentStore,
  operation: GarmentPresentationOperation | GarmentConditionOperation,
  options: { atMinutes: number; sink?: DiagnosticSink },
  goneCode: string,
  mutate: (instance: GarmentInstanceState, blueprint: GarmentBlueprint) => GarmentInstanceState | null,
): ChatGarmentStore | null {
  const index = store.instances.findIndex((instance) => instance.id === operation.garmentId);
  const instance = index >= 0 ? store.instances[index] : undefined;
  if (!instance) {
    return drop(
      options.sink,
      "garment_op.garment_unresolved",
      `no garment instance "${operation.garmentId}" — ${operation.kind} dropped`,
    );
  }
  if (instance.locus.kind === "gone") {
    return drop(options.sink, goneCode, `garment "${operation.garmentId}" is gone — ${operation.kind} dropped`);
  }
  const next = mutate(instance, garmentBlueprintFor(store, instance));
  if (!next) return null;
  const instances = [...store.instances];
  instances[index] = next;
  return { ...store, instances };
}

/** Apply ONE presentation operation to the store, or return `null` when it is dropped / a no-op. */
function applyPresentationOperation(
  store: ChatGarmentStore,
  operation: GarmentPresentationOperation,
  options: { atMinutes: number; sink?: DiagnosticSink },
): ChatGarmentStore | null {
  return applyInstanceOperation(store, operation, options, "garment_op.presentation_on_gone", (instance, blueprint) => {
    const next = nextGarmentPresentation(instance.presentation, blueprint, operation, options.sink);
    if (!next || sameGarmentPresentation(instance.presentation, next)) return null;
    return { ...instance, presentation: next, lastChange: { kind: "presentation", atMinutes: options.atMinutes } };
  });
}

/** What kind of change each condition-class operation stamps on the instance. */
const CONDITION_CHANGE_KIND: Readonly<Record<GarmentConditionOperation["kind"], GarmentChangeKind>> = {
  apply_condition: "condition",
  deposit: "condition",
  clean: "condition",
  damage: "damage",
  repair: "repair",
};

/** Apply ONE condition operation to the store, or return `null` when it is dropped / a no-op. */
function applyConditionOperation(
  store: ChatGarmentStore,
  operation: GarmentConditionOperation,
  options: { atMinutes: number; sink?: DiagnosticSink },
): ChatGarmentStore | null {
  return applyInstanceOperation(store, operation, options, "garment_op.condition_on_gone", (instance, blueprint) => {
    const next = nextGarmentCondition(instance.condition, blueprint, operation, options);
    if (!next) return null;
    return {
      ...instance,
      condition: next,
      lastChange: { kind: CONDITION_CHANGE_KIND[operation.kind], atMinutes: options.atMinutes },
    };
  });
}

/**
 * Apply typed garment operations in FICTION ORDER (plan §Typed mutation surface):
 * a transfer may remove coverage before a part operation, and an impossible later
 * operation is dropped with a stable diagnostic rather than reordered or widened.
 *
 * This is the one entry point every writer shares — the state route, and (slice 5)
 * the continuity extractor. Transfers route to slice 2's reducer, presentation
 * operations to this module's reducer, and the five condition-class operations to
 * slice 4's gradient reducer (`garment-condition.ts`), which integrates to the
 * event minute before it applies anything.
 */
export function applyGarmentOperations(
  store: ChatGarmentStore,
  operations: readonly GarmentOperation[],
  options: { atMinutes: number; sink?: DiagnosticSink },
): GarmentOperationResult {
  let current = store;
  let applied = 0;
  for (const operation of operations) {
    switch (operation.kind) {
      case "transfer": {
        const result = applyGarmentTransfers(current, [operation], options);
        current = result.store;
        applied += result.applied;
        break;
      }
      case "set_closure":
      case "set_roll":
      case "set_tuck":
      case "set_displacement":
      case "restore_presentation": {
        const next = applyPresentationOperation(current, operation, options);
        if (next) {
          current = next;
          applied += 1;
        }
        break;
      }
      case "apply_condition":
      case "deposit":
      case "clean":
      case "damage":
      case "repair": {
        const next = applyConditionOperation(current, operation, options);
        if (next) {
          current = next;
          applied += 1;
        }
        break;
      }
    }
  }
  return { store: current, applied };
}
