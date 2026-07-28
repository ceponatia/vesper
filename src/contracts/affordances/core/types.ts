import { z } from "zod";
import type { Diagnostic } from "../../diagnostics";
import type { AttributeValue } from "../../attributes";
import type { AffordanceEvidence } from "./evidence";

/**
 * The lane-neutral affordance type surface
 * (body-attribute-affordances.spec.architecture.md §"Layer contracts").
 *
 * The staged pipeline every domain compiles through:
 *
 * ```text
 * resolved attributes → structural profile → effective mechanics → domain frame
 *   → phenomena → resolutions → perception → ranking → cues
 * ```
 *
 * Nothing in this file — or anywhere under `core/` — may name hair, skin,
 * garments, or any other concrete domain. The core owns the STAGING; a domain
 * owns its vocabulary, its calibration, and its physics.
 *
 * Three laws are encoded as types rather than left to discipline:
 *
 * 1. **The adapter result law** (audit §"Adapter result law"). A lane input is
 *    `supported`, `unavailable`, or `invalid`. The two failure states carry no
 *    value at all, so no code path can quietly read one as dry, uncovered,
 *    motionless, or in contact.
 * 2. **The narrow-input law.** A phenomenon receives `selectInput(frame)`, never
 *    the resolved attribute snapshot, so raw enum vocabulary cannot reach a
 *    physics function and calibration cannot fork per phenomenon.
 * 3. **The frozen-input law.** Frames and selected inputs are deep-frozen before
 *    a resolver sees them: resolution is a pure read, never a write.
 */

// ---------------------------------------------------------------------------
// Identity and time
// ---------------------------------------------------------------------------

/**
 * The subject of a read — a lane-local character/actor id, branded so a chat
 * character id and a world-character id cannot be swapped by accident. The core
 * never interprets it; it only carries it into the frame and the evidence.
 */
export const affordanceSubjectIdSchema = z.string().trim().min(1).max(256).brand<"AffordanceSubjectId">();
export type AffordanceSubjectId = z.infer<typeof affordanceSubjectIdSchema>;

/** Construct a subject id. A blank id is a lane bug, not degraded data — it throws. */
export function affordanceSubjectId(raw: string): AffordanceSubjectId {
  return affordanceSubjectIdSchema.parse(raw);
}

/** A registered domain's id — one lowercase segment (`hair`, `garment`). */
export type AffordanceDomainId = string;

/** A phenomenon's id — `<domainId>.<snake_case>` (`hair.wet_clumping`). */
export type AffordancePhenomenonId = string;

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9_]*$/u;
const PHENOMENON_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** Domain ids are single lowercase segments. Definition-time; throws. */
export function assertAffordanceDomainId(id: string): void {
  if (!DOMAIN_ID_PATTERN.test(id)) {
    throw new Error(`Affordance domain id "${id}" must be a lowercase snake_case segment`);
  }
}

/**
 * Phenomenon ids are dotted and PREFIXED BY THEIR DOMAIN, so a resolution's id
 * names its owner without a second lookup and a phenomenon cannot be registered
 * under a domain it does not belong to. Definition-time; throws.
 */
export function assertAffordancePhenomenonId(id: string, domainId: AffordanceDomainId): void {
  if (!PHENOMENON_ID_PATTERN.test(id)) {
    throw new Error(`Affordance phenomenon id "${id}" must be <domain>.<snake_case>`);
  }
  if (!id.startsWith(`${domainId}.`)) {
    throw new Error(`Affordance phenomenon "${id}" is registered under domain "${domainId}"`);
  }
}

/**
 * Story-clock stamp for the cut being read. **Provenance only** — the core does
 * no time arithmetic: no hysteresis, no latches, no decay. Persistent aftermath
 * belongs to the system that owns the state (architecture spec §"Recompute and
 * capture"), so the read layer stays a pure function of the committed moment.
 */
export type AffordanceStoryTime = number;
export const affordanceStoryTimeSchema = z.number().int().min(0).catch(0);

// ---------------------------------------------------------------------------
// Adapter result law
// ---------------------------------------------------------------------------

/**
 * One lane input as the adapter found it. `unavailable` (no owner, or no fact
 * for this cut) and `invalid` (a trust-boundary value failed parsing) carry NO
 * value — the type makes the audit's law unbreakable. The adapter that produced
 * an `invalid` records the diagnostic; the core records the suppression.
 */
export type AdapterRead<T> =
  | { readonly status: "supported"; readonly value: T; readonly evidence: readonly AffordanceEvidence[] }
  | { readonly status: "unavailable" }
  | { readonly status: "invalid" };

export type AffordanceInputStatus = AdapterRead<unknown>["status"];

/** Per-input status, keyed by the domain's own stable input keys. */
export type AffordanceInputStatusMap = Readonly<Record<string, AffordanceInputStatus>>;

export function adapterSupported<T>(value: T, evidence: readonly AffordanceEvidence[] = []): AdapterRead<T> {
  return { status: "supported", value, evidence };
}

/** The lane has no owner, or no fact, for this input on this cut. */
export const adapterUnavailable: AdapterRead<never> = { status: "unavailable" };

/** A trust-boundary value failed to parse. Never a reason to substitute a default. */
export const adapterInvalid: AdapterRead<never> = { status: "invalid" };

export function isAdapterSupported<T>(read: AdapterRead<T>): read is Extract<AdapterRead<T>, { status: "supported" }> {
  return read.status === "supported";
}

/** Project a bag of adapter reads into the status map a state snapshot carries. */
export function adapterInputStatuses(
  reads: Readonly<Record<string, AdapterRead<unknown>>>,
): AffordanceInputStatusMap {
  const statuses: Record<string, AffordanceInputStatus> = {};
  for (const [key, read] of Object.entries(reads)) statuses[key] = read.status;
  return statuses;
}

/** Every supported read's provenance, in key order. */
export function adapterReadEvidence(
  reads: Readonly<Record<string, AdapterRead<unknown>>>,
): readonly AffordanceEvidence[] {
  return Object.values(reads).flatMap((read) => (isAdapterSupported(read) ? [...read.evidence] : []));
}

// ---------------------------------------------------------------------------
// Diagnostic codes
// ---------------------------------------------------------------------------

/**
 * The core's ONLY two diagnostic codes (audit §"Diagnostic convention for
 * missing inputs"). Everything else a read wants to explain — which phenomenon
 * fell silent and why — rides the `suppressed` resolutions as data, so the
 * diagnostic sink stays a signal that something DEGRADED rather than a log of
 * every conservative silence.
 */
export const AFFORDANCE_INPUT_UNAVAILABLE = "affordance.input.unavailable";
export const AFFORDANCE_INPUT_INVALID = "affordance.input.invalid";

/** Suppression code: the domain could not compile a structural profile. */
export const AFFORDANCE_SUPPRESSED_NO_PROFILE = "affordance.profile.unavailable";

// ---------------------------------------------------------------------------
// Resolutions
// ---------------------------------------------------------------------------

/** How much of an effect is present. Bands only — a fixed-point value never leaves mechanics. */
export const affordanceIntensityBands = ["subtle", "clear", "strong"] as const;
export const affordanceIntensityBandSchema = z.enum(affordanceIntensityBands);
export type AffordanceIntensityBand = z.infer<typeof affordanceIntensityBandSchema>;

/** Ranking weight per band; higher wins a scarce cue slot. */
export const AFFORDANCE_INTENSITY_WEIGHT: Readonly<Record<AffordanceIntensityBand, number>> = {
  subtle: 1,
  clear: 2,
  strong: 3,
};

/** Something is actually true now, at a body location, because of a current cause. */
export interface AffordanceObservation {
  readonly kind: "observation";
  /** The phenomenon that resolved it (`hair.strands_adhere_to_skin`). */
  readonly id: AffordancePhenomenonId;
  readonly sourceLocationId: string;
  readonly targetLocationId?: string;
  readonly intensityBand: AffordanceIntensityBand;
  /** Structured descriptors for cue projection ("damp", "clumped"). Never prose. */
  readonly semanticTags: readonly string[];
  /** Anti-repeat identity WITHOUT the band — the band is the thing that changes. */
  readonly repeatKey: string;
}

/** A current fact that prevents a contradiction (bound, covered, supported). */
export interface AffordanceConstraint {
  readonly kind: "constraint";
  readonly id: AffordancePhenomenonId;
  /** Domain-owned reason vocabulary (`bound`, `covered`). */
  readonly code: string;
  readonly locationId?: string;
}

/**
 * Explicit silence. Diagnostic-visible only — a suppression NEVER reaches the
 * narrator, because "we considered saying this and did not" is exactly the
 * detail that would leak hidden state into a prompt.
 */
export interface AffordanceSuppression {
  readonly kind: "suppressed";
  readonly phenomenonId: AffordancePhenomenonId;
  /** Core codes are dotted (`affordance.perception.hidden`); domain codes are bare (`no_current_force`). */
  readonly code: string;
  readonly detail?: string;
}

export type AffordanceResolution = AffordanceObservation | AffordanceConstraint | AffordanceSuppression;

// ---------------------------------------------------------------------------
// Stage 0 — resolved attributes
// ---------------------------------------------------------------------------

/**
 * The resolved canonical attributes a profile compiles from.
 *
 * Deliberately an ORDER-FREE view: the constructor dedupes by id (last write
 * wins, matching `resolveAttributes`) and sorts, so "identical resolved
 * attributes produce identical structural profiles" and "profile compilation is
 * independent of registration order" hold structurally rather than by
 * convention. This value reaches `compileProfile` and stops there — no
 * phenomenon ever sees it.
 */
export interface ResolvedAttributeSnapshot {
  readonly values: readonly AttributeValue[];
  byId(id: string): AttributeValue | undefined;
}

export function resolvedAttributeSnapshot(values: readonly AttributeValue[]): ResolvedAttributeSnapshot {
  const byId = new Map<string, AttributeValue>();
  for (const value of values) byId.set(value.id, value);
  const sorted = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  return { values: sorted, byId: (id) => byId.get(id) };
}

/**
 * A resolved single-select value, or `undefined` when the attribute is unset or
 * holds a non-scalar. Unknown vocabulary omits its contribution; it never
 * substitutes a neighbouring value.
 */
export function attributeEnumValue(attributes: ResolvedAttributeSnapshot, attributeId: string): string | undefined {
  const value = attributes.byId(attributeId)?.value;
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Stages 1–3 — profile, mechanics, frame
// ---------------------------------------------------------------------------

/**
 * Stable material and geometry facts compiled from resolved attributes. No
 * wetness, coverage, binding, contact, or force lives here.
 *
 * `profile` is OPTIONAL by law: absent required structure suppresses the domain
 * without failing the cut.
 */
export interface DomainProfileResult<TProfile> {
  readonly profile?: TProfile;
  readonly evidence: readonly AffordanceEvidence[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Present capacity and material condition — profile plus current state. High
 * capacity means "would respond strongly IF a force existed"; it is never
 * itself an observation.
 */
export interface DomainMechanicsResult<TMechanics> {
  readonly mechanics: TMechanics;
  readonly evidence: readonly AffordanceEvidence[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * One subject/domain view of one committed cut. Concrete domains extend this
 * with only the live inputs their phenomena may read (presentation, contacts,
 * forces, events) — never with persistence handles or prompt text.
 */
export interface DomainFrame<TProfile, TMechanics> {
  readonly subjectId: AffordanceSubjectId;
  readonly storyTime: AffordanceStoryTime;
  readonly profile: TProfile;
  readonly mechanics: TMechanics;
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Stage 4 — phenomena
// ---------------------------------------------------------------------------

/**
 * An input a phenomenon requires, named by the domain's own input key (the same
 * keys the state snapshot's status map is keyed by).
 *
 * Declarations have teeth: the core suppresses a phenomenon whose required key
 * is anything but `supported`, so an unavailable wind read cannot be silently
 * treated as still air by a resolver that forgot to check.
 */
export interface AffordanceDependency {
  readonly key: string;
  /** Enrichment rather than a precondition — absence does not suppress. */
  readonly optional?: boolean;
}

export interface AffordancePhenomenonDefinition<TFrame, TInput> {
  readonly id: AffordancePhenomenonId;
  readonly dependencies: readonly AffordanceDependency[];
  /** Prefer a `Pick<...>` result: what is not selected cannot be depended on. */
  selectInput(frame: Readonly<TFrame>): Readonly<TInput>;
  resolve(input: Readonly<TInput>): AffordanceResolution;
}

export interface RegisteredAffordancePhenomenon<TFrame> {
  readonly id: AffordancePhenomenonId;
  readonly dependencies: readonly AffordanceDependency[];
  resolveFrame(frame: Readonly<TFrame>): AffordanceResolution;
}

// ---------------------------------------------------------------------------
// Stage 5 — domains
// ---------------------------------------------------------------------------

/**
 * Current state for one domain, as the lane adapter read it. Concrete domains
 * extend this with their own typed inputs; the base carries what the CORE needs
 * — who, when, which inputs survived their adapters, and the provenance.
 */
export interface AffordanceStateSnapshot {
  readonly subjectId: AffordanceSubjectId;
  readonly storyTime: AffordanceStoryTime;
  readonly inputs: AffordanceInputStatusMap;
  readonly evidence: readonly AffordanceEvidence[];
}

/** Live context for frame assembly. Domains extend it with forces, contacts, events. */
export interface AffordanceResolutionContext {
  readonly subjectId: AffordanceSubjectId;
  readonly storyTime: AffordanceStoryTime;
}

/** What a domain's adapter hands the staged runner. */
export interface DomainInputs<TState, TContext> {
  readonly state: TState;
  readonly context: TContext;
}

/**
 * One domain's slice of a read request. `payload` is the lane's per-domain
 * input and is `unknown` BY LAW: the erased registry cannot type it, so the
 * domain's own `readInputs` narrows it (`parseOr` at the trust boundary) and
 * reports `invalid` rather than throwing.
 */
export interface AffordanceDomainRequest {
  readonly subjectId: AffordanceSubjectId;
  readonly storyTime: AffordanceStoryTime;
  readonly attributes: ResolvedAttributeSnapshot;
  readonly payload: unknown;
}

export interface AffordanceDomainDefinition<
  TProfile,
  TMechanics,
  TState extends AffordanceStateSnapshot,
  TContext extends AffordanceResolutionContext,
  TFrame extends DomainFrame<TProfile, TMechanics>,
> {
  readonly id: AffordanceDomainId;
  /** Validated against the attribute registry at registration — a typo cannot compile a silent empty profile. */
  readonly requiredAttributeIds: readonly string[];
  /** Narrow the lane payload. The only place a domain touches untyped input. */
  readInputs(request: AffordanceDomainRequest): AdapterRead<DomainInputs<TState, TContext>>;
  compileProfile(attributes: ResolvedAttributeSnapshot): DomainProfileResult<TProfile>;
  deriveMechanics(profile: TProfile, state: TState): DomainMechanicsResult<TMechanics>;
  buildFrame(profile: TProfile, mechanics: TMechanics, context: TContext): TFrame;
  readonly phenomena: readonly RegisteredAffordancePhenomenon<TFrame>[];
}

/** What one domain contributed to a read. */
export interface AffordanceDomainRun {
  readonly domainId: AffordanceDomainId;
  readonly resolutions: readonly AffordanceResolution[];
  readonly evidence: readonly AffordanceEvidence[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * A registered domain with its generics erased. The erasure is EXISTENTIAL, not
 * a widening: `registerAffordanceDomain` closes over the fully-typed definition,
 * so every internal call still type-checks against the concrete profile,
 * mechanics, state, context, and frame. Nothing on this surface is `any`.
 */
export interface RegisteredAffordanceDomain {
  readonly id: AffordanceDomainId;
  readonly requiredAttributeIds: readonly string[];
  readonly phenomenonIds: readonly AffordancePhenomenonId[];
  resolve(request: AffordanceDomainRequest): AffordanceDomainRun;
}

// ---------------------------------------------------------------------------
// Frozen inputs
// ---------------------------------------------------------------------------

/**
 * Recursively freeze a value. Freezes the parent BEFORE descending, so a cyclic
 * structure terminates on the `isFrozen` check.
 *
 * This enforces the architecture's "all resolvers accept frozen inputs and
 * perform no writes": in a module (always strict mode) an assignment to a
 * frozen property throws, so a resolver that tries to cache into its frame
 * fails loudly in test rather than corrupting a later domain's read.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(record)) deepFreeze(record[key]);
  return value;
}
