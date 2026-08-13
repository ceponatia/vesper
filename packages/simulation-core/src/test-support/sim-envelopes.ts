import type { z, ZodType } from "zod";
import type { commandPrincipalSchema, PrincipalKind } from "../contracts/envelopes";
import { sortedUnique } from "../lib/hash";

/**
 * Command/event envelope builders for the pure simulation suites.
 *
 * Every kernel test file grew its own per-command-type builder that differed
 * only in `type`/`payload` and a slug; these two functions carry the whole
 * envelope shape once. They PARSE through the caller's schema, so an envelope
 * that stops satisfying the contract fails here rather than silently drifting.
 *
 * All identity fields are branded at the contract layer, so the specs below are
 * `z.input` (plain-string) shapes — the same reason the per-file builders take
 * `*CommandInput["payload"]` rather than the branded output type.
 */

/**
 * Mirrors `LEGACY_ENGINE_TEST_PLAYER_ID` in `src/server/test-support`, which
 * pure contracts/lib tests cannot import (server is out of bounds for them).
 * Keep the two literals in step.
 */
export const TEST_PRINCIPAL_ID = "principal-1";

/**
 * The neutral world/branch/ruleset trio. These are the literals the majority of
 * kernel suites already use (activities, commitments, engagements,
 * move-together, space). A suite whose OTHER fixtures carry different constants
 * must pass its own — see `bindSimEnvelopes`.
 */
export const TEST_WORLD_ID = "world-1";
export const TEST_BRANCH_ID = "branch-1";
export const TEST_RULESET_VERSION = "gate3-test-v1";
export const TEST_CORRELATION_ID = "corr-1";

/** Operational metadata only — it must never affect resolution, so one literal serves every suite. */
export const TEST_WALL_CLOCK = "2026-07-19T10:00:00.000Z";

/** The story second the E5.x view builders default to. */
export const TEST_STORY_SECOND = 10_000;

/** Pre-brand principal shape: plain strings that flow into a `.parse()` call. */
export type TestPrincipal = z.input<typeof commandPrincipalSchema>;

/**
 * A principal of the given family. `controlledActorIds` is sorted-unique
 * because the contract enforces a stable capability set (an unsorted list is a
 * parse failure, not a normalization).
 */
export function testPrincipal(kind: PrincipalKind, controlledActorIds: readonly string[] = []): TestPrincipal {
  return { kind, principalId: TEST_PRINCIPAL_ID, controlledActorIds: sortedUnique(controlledActorIds) };
}

export interface CommandEnvelopeSpec {
  type: string;
  payload: unknown;
  /** Defaults to a `storyteller` principal with no controlled actors. */
  principal?: TestPrincipal;
  branchId?: string;
  expectedVersion?: number;
  schemaVersion?: number;
  /** Distinguishes two commands of the SAME type; feeds `id` and `idempotencyKey`. */
  idSlug?: string;
  /** Last word on any envelope field (`correlationId`, `requestedStorySecond`, …). */
  overrides?: Record<string, unknown>;
}

/**
 * One command envelope, parsed by `schema`. Ids are derived from
 * `idSlug ?? type` so a suite only names a slug when it needs two commands of
 * one type to differ (idempotency keys must not collide inside a branch).
 */
export function commandEnvelope<TOutput>(schema: ZodType<TOutput>, spec: CommandEnvelopeSpec): TOutput {
  const slug = spec.idSlug ?? spec.type;
  return schema.parse({
    id: `cmd-${slug}`,
    branchId: spec.branchId ?? TEST_BRANCH_ID,
    expectedVersion: spec.expectedVersion ?? 0,
    idempotencyKey: `idem-${slug}`,
    principal: spec.principal ?? testPrincipal("storyteller"),
    submittedAtWallClock: TEST_WALL_CLOCK,
    type: spec.type,
    schemaVersion: spec.schemaVersion ?? 1,
    correlationId: TEST_CORRELATION_ID,
    payload: spec.payload,
    ...spec.overrides,
  });
}

export interface EventEnvelopeSpec {
  type: string;
  payload: unknown;
  /** Distinguishes two events of the SAME type; feeds `id` alongside `sequence`. */
  idSlug?: string;
  sequence?: number;
  storySecond?: number;
  actorIds?: readonly string[];
  entityIds?: readonly string[];
  worldId?: string;
  branchId?: string;
  rulesetVersion?: string;
  commandId?: string;
  /** Last word on any envelope field (`derivationVersion`, `causationId`, `schemaVersion`, …). */
  overrides?: Record<string, unknown>;
}

/**
 * One event envelope, parsed by `schema`. `actorIds`/`entityIds` are
 * sorted-unique for the same stable-set reason as a principal's capability set.
 * `commandId` is omitted (not set to `undefined`) when absent so a
 * command-less event — `engagement_ended`, a scheduler re-arm — stays legal.
 */
export function eventEnvelope<TOutput>(schema: ZodType<TOutput>, spec: EventEnvelopeSpec): TOutput {
  const sequence = spec.sequence ?? 1;
  return schema.parse({
    id: `event-${spec.idSlug ?? spec.type}-${sequence}`,
    worldId: spec.worldId ?? TEST_WORLD_ID,
    branchId: spec.branchId ?? TEST_BRANCH_ID,
    sequence,
    storySecond: spec.storySecond ?? 1_000,
    rulesetVersion: spec.rulesetVersion ?? TEST_RULESET_VERSION,
    correlationId: TEST_CORRELATION_ID,
    actorIds: sortedUnique(spec.actorIds ?? []),
    entityIds: sortedUnique(spec.entityIds ?? []),
    recordedAtWallClock: TEST_WALL_CLOCK,
    ...(spec.commandId === undefined ? {} : { commandId: spec.commandId }),
    type: spec.type,
    schemaVersion: 1,
    payload: spec.payload,
    ...spec.overrides,
  });
}

/** The branch-boundary facts every `resolve*FromView` reads off its view. */
export interface SimMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

/** The recurring view preamble — spread it into a suite's own view builder. */
export function simMeta(overrides: Partial<SimMeta> = {}): SimMeta {
  return {
    worldId: TEST_WORLD_ID,
    branchId: TEST_BRANCH_ID,
    rulesetVersion: TEST_RULESET_VERSION,
    headSequence: 0,
    storySecond: TEST_STORY_SECOND,
    ...overrides,
  };
}

/** The three constants a suite carries at its top; everything else has a shared default. */
export interface SimEnvelopeDefaults {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
}

export interface BoundSimEnvelopes {
  command<TOutput>(schema: ZodType<TOutput>, spec: CommandEnvelopeSpec): TOutput;
  event<TOutput>(schema: ZodType<TOutput>, spec: EventEnvelopeSpec): TOutput;
  meta(overrides?: Partial<SimMeta>): SimMeta;
}

/**
 * Bind a suite's own world/branch/ruleset once, at the top of the file, instead
 * of repeating them at every call site. A resolver compares its view's
 * `branchId` against the command's, so a suite that keeps bespoke view builders
 * MUST feed both from the same constants.
 */
export function bindSimEnvelopes(defaults: SimEnvelopeDefaults): BoundSimEnvelopes {
  const { worldId, branchId, rulesetVersion } = defaults;
  return {
    command<TOutput>(schema: ZodType<TOutput>, spec: CommandEnvelopeSpec): TOutput {
      return commandEnvelope(schema, { branchId, ...spec });
    },
    event<TOutput>(schema: ZodType<TOutput>, spec: EventEnvelopeSpec): TOutput {
      return eventEnvelope(schema, { worldId, branchId, rulesetVersion, ...spec });
    },
    meta(overrides: Partial<SimMeta> = {}): SimMeta {
      return simMeta({ worldId, branchId, rulesetVersion, ...overrides });
    },
  };
}
