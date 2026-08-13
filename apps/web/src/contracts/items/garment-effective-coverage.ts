import { bodyLocationRegistry, type BodyLocationRegistry } from "../body/locations";
import {
  garmentBehaviorBindingFor,
  garmentPartNode,
  type GarmentBehavior,
  type GarmentBlueprint,
} from "./garment-blueprint";
import {
  garmentConditionAtPart,
  garmentDepositFreshnessBand,
  garmentWorstConditionVector,
  hystereticGarmentConditionBand,
  integrateGarmentCondition,
  GARMENT_CONDITION_NEUTRAL_BANDS,
  type GarmentConditionBand,
  type GarmentDepositFreshnessBand,
} from "./garment-condition";
import { garmentBehaviorCoverage, orderCoverageIds } from "./garment-coverage";
import { garmentDegreeBandOf, type GarmentDegreeBand, type GarmentUnit } from "./garment-material";
import {
  garmentConditionKeys,
  type GarmentClosureState,
  type GarmentConditionKey,
  type GarmentDamageKind,
  type GarmentDepositKind,
  type GarmentDisplacementKind,
  type GarmentInstanceState,
  type GarmentLocusKind,
  type GarmentTuckState,
} from "./garment-instance";
import {
  garmentChannelDegree,
  GARMENT_BEHAVIOR_CHANNEL,
  GARMENT_BEHAVIOR_DISPLACEMENT_KIND,
  type GarmentPresentationChannel,
} from "./garment-presentation";

/**
 * The DERIVED wardrobe read (clothing-state-graph.plan.md §"Derived wardrobe and
 * observation read" steps 3–5).
 *
 * Step 1 (loading instances) belongs to the caller. This module owns step 2 —
 * **integrate condition to story time** (lazily, through slice 4's
 * `garment-condition.ts`, and never persisting what a read derived) — and step 3,
 * **apply presentation behavior to per-part coverage**, which the per-garment
 * rollup steps 4–5 consume:
 *
 *     node.baselineCoverage  −  behavior(current channel reading)  =  part coverage
 *     ⋃ part coverage                                              =  garment coverage
 *
 * The subtraction is `garment-coverage.ts`'s OQ6 law verbatim — this file never
 * re-derives a threshold, it only decides which reading each part's behavior sees
 * (`garmentChannelDegree`) and unions the results.
 *
 * The union is what makes cross-garment exposure structural: a garment's coverage
 * is the union of its parts, so `resolveWardrobeVisibility` → `exposedRegions`
 * still decides what is actually bare, and an open shirt over a tee exposes the
 * TEE, never skin.
 */

/** What one part covers this cut, and what its behavior took away. */
export interface GarmentPartEffectiveCoverage {
  partId: string;
  /** Body-location ids this part still covers (exploded, registry order). */
  covers: string[];
  /** Ids the part's behavior removed from its baseline. */
  dropped: string[];
  /** The behavior bound to this part, if any. */
  behavior: GarmentBehavior | null;
  /** The normalized 0–1 channel reading the law consumed (`0` = neutral). */
  degree: GarmentUnit;
  /** Layer nudge relative to the garment's layer (a lining sits inside). */
  layerOffset: number;
}

/** One worn garment's presentation-aware coverage — the shared read. */
export interface GarmentEffectiveCoverage {
  garmentId: string;
  name: string;
  parts: GarmentPartEffectiveCoverage[];
  /** Union of the parts' effective coverage — what this garment covers right now. */
  covers: string[];
  /**
   * Ids presentation removed that NO other part of the garment still covers —
   * "the shirt no longer covers this". A location one part drops while another
   * keeps is not dropped at all (both bra straps must fall before the garment
   * stops covering `shoulders`).
   */
  dropped: string[];
}

/**
 * Expand one instance's per-part coverage and roll it up. Pure; the blueprint
 * comes from the store's snapshot map, so a library edit can never move it.
 */
export function garmentEffectiveCoverage(
  instance: GarmentInstanceState,
  blueprint: GarmentBlueprint,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentEffectiveCoverage {
  const parts = blueprint.nodes.map((node): GarmentPartEffectiveCoverage => {
    const binding = garmentBehaviorBindingFor(blueprint, node.id);
    const degree = garmentChannelDegree(instance.presentation, node.id, binding);
    const coverage = garmentBehaviorCoverage(binding, { degree }, node.baselineCoverage, registry);
    return {
      partId: node.id,
      covers: coverage.covers,
      dropped: coverage.dropped,
      behavior: binding?.behavior ?? null,
      degree,
      layerOffset: node.layerOffset ?? 0,
    };
  });
  const covers = new Set<string>();
  for (const part of parts) for (const id of part.covers) covers.add(id);
  const dropped = new Set<string>();
  for (const part of parts) for (const id of part.dropped) if (!covers.has(id)) dropped.add(id);
  return {
    garmentId: instance.id,
    name: instance.name,
    parts,
    covers: orderCoverageIds(covers, registry),
    dropped: orderCoverageIds(dropped, registry),
  };
}

// --- Inspector / state-tool readout -------------------------------------------

/** One addressable presentation control on a garment — the state-tools row. */
export interface GarmentPartControl {
  partId: string;
  /** Authoring alias if the part has one, else the id humanized. Never prompt prose. */
  label: string;
  behavior: GarmentBehavior;
  channel: GarmentPresentationChannel;
  /** Declared fastener count for a `fastener_series` closure; `null` otherwise. */
  fastenerCount: number | null;
  /** Which fasteners are currently open (empty unless the closure is a series). */
  openFasteners: number[];
  /** The current reading as a band — `null` at the neutral end (or for `tuck`). */
  band: GarmentDegreeBand | null;
  /** Tuck channel only; `null` elsewhere. */
  tuck: GarmentTuckState | null;
  /** The displacement kind this part accepts; `null` off the displacement channel. */
  displacementKind: GarmentDisplacementKind | null;
  /** Body locations this part no longer covers because of its current reading. */
  dropped: string[];
}

/** Every channel's band for one scope — bands only, never fixed point. */
export type GarmentConditionBands = Readonly<Record<GarmentConditionKey, GarmentConditionBand>>;

/** A part whose material state differs from the garment's own baseline. */
export interface GarmentPartConditionReadout {
  partId: string;
  label: string;
  /** Only the channels this part actually overrides. */
  bands: Partial<Record<GarmentConditionKey, GarmentConditionBand>>;
}

/** A located contaminant as the sheet sees it — kind, where, how much, how recent. */
export interface GarmentDepositReadout {
  id: string;
  kind: GarmentDepositKind;
  /** Empty ⇒ the whole garment. */
  partIds: string[];
  labels: string[];
  intensity: GarmentDegreeBand | null;
  freshness: GarmentDepositFreshnessBand;
}

/** A located damage mark. */
export interface GarmentDamageReadout {
  id: string;
  kind: GarmentDamageKind;
  partId: string;
  label: string;
  severity: GarmentDegreeBand | null;
}

/**
 * A worn garment as the state-tools sheet and the admin inspector see it: the
 * controls it offers, the coverage that results, and the material state it is
 * currently in. Deliberately modest — the narrator digest and the ranked cue
 * block are slice 6's, and raw fixed-point values never leave here except as
 * bands.
 */
export interface GarmentReadout {
  garmentId: string;
  name: string;
  locus: GarmentLocusKind;
  controls: GarmentPartControl[];
  /** Effective coverage of the whole garment (registry order). */
  covers: string[];
  /** What presentation is currently taking away. */
  dropped: string[];
  /** Whole-garment condition — the WORST reading across base and overrides, hysteretic. */
  condition: GarmentConditionBands;
  /** Channels currently off their neutral band, in registry order — the "worth saying" subset. */
  notableChannels: GarmentConditionKey[];
  /** Parts reading differently from the garment baseline (a wet hem on a dry shirt). */
  conditionParts: GarmentPartConditionReadout[];
  deposits: GarmentDepositReadout[];
  damage: GarmentDamageReadout[];
}

export interface GarmentReadoutOptions {
  registry?: BodyLocationRegistry;
  /**
   * Story minute to read AT. The condition is integrated to it lazily and the
   * result is NOT persisted (the §25.2 law) — reading a garment can never dry it.
   * Absent ⇒ read the stored state as last written.
   */
  atMinutes?: number;
  /**
   * The bands this consumer last reported, so the reader can apply hysteresis and
   * a boundary value cannot alternate damp/wet between two reads. Slice 6's cue
   * map is the durable home for these; absent ⇒ the plain band.
   */
  previousBands?: Partial<Record<GarmentConditionKey, string>>;
}

/** Alias, else the id with underscores opened out ("sleeve_left" → "sleeve left"). */
function partLabel(aliases: readonly string[], partId: string): string {
  return aliases[0] ?? partId.replace(/_/gu, " ");
}

/** Alias for a part id resolved through the blueprint, falling back to the humanized id. */
function labelOf(blueprint: GarmentBlueprint, partId: string): string {
  return partLabel(garmentPartNode(blueprint, partId)?.aliases ?? [], partId);
}

export function garmentReadout(
  instance: GarmentInstanceState,
  blueprint: GarmentBlueprint,
  options: GarmentReadoutOptions = {},
): GarmentReadout {
  const registry = options.registry ?? bodyLocationRegistry;
  const condition = integrateGarmentCondition(
    instance.condition,
    blueprint,
    options.atMinutes ?? instance.condition.integratedAtMinutes,
  );
  const readAt = Math.max(options.atMinutes ?? 0, condition.integratedAtMinutes);
  const worst = garmentWorstConditionVector(condition);
  const bands = Object.fromEntries(
    garmentConditionKeys.map((channel) => [
      channel,
      hystereticGarmentConditionBand(channel, worst[channel], options.previousBands?.[channel]),
    ]),
  ) as GarmentConditionBands;
  const conditionParts = Object.entries(condition.regionOverrides).flatMap(
    ([partId, override]): GarmentPartConditionReadout[] => {
      if (!override) return [];
      const effective = garmentConditionAtPart(condition, partId);
      const partBands: Partial<Record<GarmentConditionKey, GarmentConditionBand>> = {};
      for (const channel of garmentConditionKeys) {
        if (override[channel] === undefined) continue;
        partBands[channel] = hystereticGarmentConditionBand(channel, effective[channel], undefined);
      }
      return [{ partId, label: labelOf(blueprint, partId), bands: partBands }];
    },
  );
  const effective = garmentEffectiveCoverage(instance, blueprint, registry);
  const byPart = new Map(effective.parts.map((part) => [part.partId, part]));
  const controls = blueprint.behaviors.flatMap((binding): GarmentPartControl[] => {
    const node = garmentPartNode(blueprint, binding.partId);
    if (!node) return [];
    const channel = GARMENT_BEHAVIOR_CHANNEL[binding.behavior];
    const part = byPart.get(binding.partId);
    const closure: GarmentClosureState | undefined =
      channel === "closure" ? instance.presentation.closure[binding.partId] : undefined;
    return [
      {
        partId: binding.partId,
        label: partLabel(node.aliases, binding.partId),
        behavior: binding.behavior,
        channel,
        fastenerCount: binding.fastenerCount ?? null,
        openFasteners: closure?.kind === "fastener_series" ? [...closure.openFastenerIndexes] : [],
        band: channel === "tuck" ? null : garmentDegreeBandOf(part?.degree ?? 0),
        tuck: channel === "tuck" ? (instance.presentation.tuck[binding.partId] ?? "out") : null,
        displacementKind: GARMENT_BEHAVIOR_DISPLACEMENT_KIND[binding.behavior],
        dropped: part?.dropped ?? [],
      },
    ];
  });
  return {
    garmentId: instance.id,
    name: instance.name,
    locus: instance.locus.kind,
    controls,
    covers: effective.covers,
    dropped: effective.dropped,
    condition: bands,
    notableChannels: garmentConditionKeys.filter(
      (channel) => bands[channel] !== GARMENT_CONDITION_NEUTRAL_BANDS[channel],
    ),
    conditionParts,
    deposits: condition.deposits.map((deposit) => ({
      id: deposit.id,
      kind: deposit.kind,
      partIds: [...deposit.partIds],
      labels: deposit.partIds.map((partId) => labelOf(blueprint, partId)),
      intensity: garmentDegreeBandOf(deposit.intensity),
      freshness: garmentDepositFreshnessBand(deposit, readAt),
    })),
    damage: condition.damageMarks.map((mark) => ({
      id: mark.id,
      kind: mark.kind,
      partId: mark.partId,
      label: labelOf(blueprint, mark.partId),
      severity: garmentDegreeBandOf(mark.severity),
    })),
  };
}
