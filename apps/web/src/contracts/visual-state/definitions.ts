import type { ZodType } from "zod";
import { defineVisualStateAttentionPriors, type VisualStateAttentionPriors } from "./priors";
import {
  visualStateLayerSchema,
  visualStateLocusKindSchema,
  visualStateStabilitySchema,
  type VisualStateLayer,
  type VisualStateLocusKind,
  type VisualStateStability,
} from "./vocabulary";

/**
 * Visual-state feature KIND definitions.
 *
 * A kind stores CALIBRATION and shape, never which features a character has:
 * what a value may look like, where it may sit, how long it lasts, which
 * consumers may use it, and how distinctive one is by default. The per-subject
 * records come from the source adapters.
 *
 * Registries are the extension point — a new visual vocabulary is a data edit in
 * `kinds.ts`, never a schema migration.
 *
 * Definition-time construction THROWS (a bad id, an empty locus list, or a
 * self-contradicting kind is a programmer error); every runtime read degrades
 * with a diagnostic instead (docs/resilience.md).
 */

/** `<family>.<snake_case>` — e.g. `appearance.located_fact`. */
export type VisualStateKindId = string;

export interface VisualStateKindDefinition<TValue = unknown> {
  readonly id: VisualStateKindId;
  readonly layer: VisualStateLayer;
  /** Parses a feature's `value`; arbitrary JSON and executable prose are forbidden. */
  readonly valueSchema: ZodType<TValue>;
  readonly allowedLoci: readonly VisualStateLocusKind[];
  readonly stability: VisualStateStability;
  readonly repeatFamily: string;
  readonly recognitionEligible: boolean;
  readonly narratorEligible: boolean;
  readonly imageEligible: boolean;
  readonly priors: VisualStateAttentionPriors;
  /**
   * SPEC DEVIATION: optional, not required. No visual-realizer system exists
   * yet, and the same field on the appearance kind registry
   * (`visualRealizerId`) is optional and unread for the same reason. Naming it
   * now means authored kinds do not have to be retrofitted later; requiring it
   * now would mean inventing ids for a system with no consumers.
   */
  readonly realizerId?: string;
}

export const VISUAL_STATE_KIND_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Construct + validate one kind. Throws on a malformed id, an empty or
 * duplicated locus list, out-of-range priors, an unknown layer/stability, or an
 * `instantaneous` kind that also claims recognition eligibility — a posture fact
 * true for exactly one committed cut must never earn a long-term recognition
 * floor.
 */
export function defineVisualStateKind<TValue>(
  definition: VisualStateKindDefinition<TValue>,
): VisualStateKindDefinition<TValue> {
  if (!VISUAL_STATE_KIND_ID_PATTERN.test(definition.id)) {
    throw new Error(`Visual state kind id must be <family>.<snake_case>: ${definition.id}`);
  }
  visualStateLayerSchema.parse(definition.layer);
  visualStateStabilitySchema.parse(definition.stability);
  if (definition.allowedLoci.length === 0) {
    throw new Error(`Visual state kind ${definition.id} allows no loci`);
  }
  if (new Set(definition.allowedLoci).size !== definition.allowedLoci.length) {
    throw new Error(`Visual state kind ${definition.id} repeats a locus kind`);
  }
  for (const locusKind of definition.allowedLoci) visualStateLocusKindSchema.parse(locusKind);
  if (definition.repeatFamily.length === 0) {
    throw new Error(`Visual state kind ${definition.id} needs a repeat family`);
  }
  if (definition.stability === "instantaneous" && definition.recognitionEligible) {
    throw new Error(`Visual state kind ${definition.id} is instantaneous and cannot be recognition-eligible`);
  }
  defineVisualStateAttentionPriors(definition.priors);
  return definition;
}
