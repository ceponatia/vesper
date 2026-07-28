import { diag, type Diagnostic } from "../../diagnostics";
import { attributeRegistry } from "../../attributes";
import { mergeAffordanceEvidence, type AffordanceEvidence } from "./evidence";
import {
  assertAffordanceDomainId,
  assertAffordancePhenomenonId,
  deepFreeze,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
  AFFORDANCE_SUPPRESSED_NO_PROFILE,
  type AffordanceDependency,
  type AffordanceDomainDefinition,
  type AffordanceDomainRequest,
  type AffordanceDomainRun,
  type AffordancePhenomenonDefinition,
  type AffordanceResolution,
  type AffordanceResolutionContext,
  type AffordanceStateSnapshot,
  type DomainFrame,
  type RegisteredAffordanceDomain,
  type RegisteredAffordancePhenomenon,
  type ResolvedAttributeSnapshot,
} from "./types";

/**
 * Definition-time construction and validation for the affordance layer.
 *
 * Everything here runs when a module is loaded, not when a turn is taken, so it
 * THROWS. That is the deliberate exception to the diagnostics-over-exceptions
 * rule (docs/resilience.md: "Exceptions are for programmer errors only") and it
 * matches the registries this layer sits beside — `defineAttributeGroup` and
 * `buildBodyLocationRegistry` both refuse to build an invalid definition rather
 * than degrade at runtime. A mistyped attribute id or a double-owned profile
 * path is a bug in a definition file; it cannot be recovered from and must not
 * be discovered as silent nothing in production.
 *
 * Runtime resolution, by contrast, never throws: missing or malformed lane
 * input degrades to conservative silence plus a diagnostic.
 */

// ---------------------------------------------------------------------------
// Attribute contribution axes
// ---------------------------------------------------------------------------

/**
 * One attribute's mapping from its legal vocabulary into orthogonal profile
 * contributions (architecture spec §"Attribute contribution definitions").
 *
 * An axis owns paths, not conclusions: `hair.length` may contribute a length
 * scale and a nominal reach, `hair.density` a bulk density — but the combined
 * load they imply is derived once, centrally, in the domain's mechanics. Two
 * axes writing the same "final" number is the duplication this layer exists to
 * prevent.
 */
export interface AttributeAxisDefinition<TValue extends string, TContribution> {
  readonly attributeId: string;
  /** Positive integer, bumped when the calibration changes. */
  readonly version: number;
  /** Profile paths this axis exclusively owns. */
  readonly ownedPaths: readonly string[];
  /** PARTIAL by design: unmapped vocabulary omits its contribution, it does not guess a neighbour. */
  readonly values: Readonly<Partial<Record<TValue, TContribution>>>;
  /** Quarantined mapping — usable, but reported in diagnostics until calibrated. */
  readonly provisional?: boolean;
}

/**
 * Type-erased member for cross-axis validation. `values` is widened to `object`
 * rather than a contribution record on purpose: the set-level checks read only
 * the KEYS (vocabulary membership), and widening this way lets any concrete axis
 * be validated with no cast at the call site.
 */
export interface AttributeAxisSetMember {
  readonly attributeId: string;
  readonly version: number;
  readonly ownedPaths: readonly string[];
  readonly values: object;
  readonly provisional?: boolean;
}

/** Returns an issue string, or `null` when the contribution is in bounds. */
export type AttributeContributionValidator<TContribution> = (contribution: TContribution, value: string) => string | null;

/** Diagnostic code for a provisional (quarantined) mapping. */
export const AFFORDANCE_AXIS_PROVISIONAL = "affordance.axis.provisional";

/** The one erasure: a partial vocabulary map read as a plain lookup. */
function axisValues<TValue extends string, TContribution>(
  axis: AttributeAxisDefinition<TValue, TContribution>,
): Readonly<Record<string, TContribution | undefined>> {
  return axis.values as Readonly<Record<string, TContribution | undefined>>;
}

/**
 * The per-axis proofs the architecture spec requires: the attribute exists, its
 * mapped values are real vocabulary, free text cannot drive mechanics, and the
 * version is a positive integer.
 */
function validateAxisShape(axis: AttributeAxisSetMember): void {
  const definition = attributeRegistry.byId(axis.attributeId);
  if (!definition) {
    throw new Error(`Affordance axis references unknown attribute "${axis.attributeId}"`);
  }
  if (definition.valueType === "text") {
    throw new Error(`Affordance axis "${axis.attributeId}" is free text; text cannot drive runtime mechanics`);
  }
  if (!Number.isInteger(axis.version) || axis.version < 1) {
    throw new Error(`Affordance axis "${axis.attributeId}" version must be a positive integer`);
  }
  if (axis.ownedPaths.length === 0) {
    throw new Error(`Affordance axis "${axis.attributeId}" owns no profile path`);
  }
  const allowed = definition.allowedValues;
  if (!allowed) return;
  for (const value of Object.keys(axis.values)) {
    if (!allowed.includes(value)) {
      throw new Error(`Affordance axis "${axis.attributeId}" maps "${value}", which is not in allowedValues`);
    }
  }
}

/**
 * Define one attribute axis. Validates the axis shape and — when the caller
 * supplies a per-axis validator — that every contribution is in bounds, since
 * only the axis's own domain knows what "bounded" means for its contribution
 * type.
 */
export function defineAttributeAxis<TValue extends string, TContribution>(
  definition: AttributeAxisDefinition<TValue, TContribution>,
  validateContribution?: AttributeContributionValidator<TContribution>,
): AttributeAxisDefinition<TValue, TContribution> {
  validateAxisShape(definition);
  if (validateContribution) {
    const values = axisValues(definition);
    for (const value of Object.keys(values)) {
      const contribution = values[value];
      if (contribution === undefined) continue;
      const issue = validateContribution(contribution, value);
      if (issue !== null) {
        throw new Error(`Affordance axis "${definition.attributeId}" value "${value}": ${issue}`);
      }
    }
  }
  return definition;
}

/**
 * Validate a domain's whole axis set: every axis shape, plus the cross-axis law
 * that each exclusive profile path has exactly ONE owner.
 *
 * Returns the diagnostics a provisional mapping must surface — the axis stays
 * usable (quarantine, not deletion), but every read it feeds can say so.
 */
export function validateAxisSet(axes: readonly AttributeAxisSetMember[]): readonly Diagnostic[] {
  const owners = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  for (const axis of axes) {
    validateAxisShape(axis);
    for (const path of axis.ownedPaths) {
      const owner = owners.get(path);
      if (owner !== undefined) {
        throw new Error(`Profile path "${path}" is owned by both "${owner}" and "${axis.attributeId}"`);
      }
      owners.set(path, axis.attributeId);
    }
    if (axis.provisional === true) {
      diagnostics.push(
        diag("info", AFFORDANCE_AXIS_PROVISIONAL, `Provisional attribute mapping for ${axis.attributeId}`, {
          path: axis.attributeId,
          context: { version: axis.version, ownedPaths: [...axis.ownedPaths] },
        }),
      );
    }
  }
  return diagnostics;
}

/**
 * The contribution this axis makes for a subject's resolved value, or
 * `undefined` when the attribute is unset or its value is unmapped. This is the
 * ONLY door between raw vocabulary and a profile — which is what keeps enum
 * labels out of phenomena.
 */
export function axisContributionFor<TValue extends string, TContribution>(
  axis: AttributeAxisDefinition<TValue, TContribution>,
  attributes: ResolvedAttributeSnapshot,
): { readonly value: string; readonly contribution: TContribution } | undefined {
  const raw = attributes.byId(axis.attributeId)?.value;
  if (typeof raw !== "string") return undefined;
  const contribution = axisValues(axis)[raw];
  return contribution === undefined ? undefined : { value: raw, contribution };
}

// ---------------------------------------------------------------------------
// Phenomena
// ---------------------------------------------------------------------------

/**
 * Type-check a selector/resolver pair and wrap it for a domain tuple.
 *
 * The wrapper is where the frozen-input law is applied: the selected input is
 * deep-frozen before the resolver runs, so a resolver cannot memoise into its
 * own input or mutate shared frame state that a later phenomenon will read.
 */
export function defineAffordancePhenomenon<TFrame, TInput>(
  definition: AffordancePhenomenonDefinition<TFrame, TInput>,
): RegisteredAffordancePhenomenon<TFrame> {
  return {
    id: definition.id,
    dependencies: definition.dependencies,
    resolveFrame(frame) {
      return definition.resolve(deepFreeze(definition.selectInput(frame)));
    },
  };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** The worst status among a phenomenon's unmet required dependencies. */
function unmetDependencies(
  dependencies: readonly AffordanceDependency[],
  inputs: AffordanceStateSnapshot["inputs"],
): { readonly keys: readonly string[]; readonly code: string } | null {
  const unmet = dependencies.filter((dependency) => dependency.optional !== true && inputs[dependency.key] !== "supported");
  if (unmet.length === 0) return null;
  const invalid = unmet.some((dependency) => inputs[dependency.key] === "invalid");
  return { keys: unmet.map((dependency) => dependency.key), code: invalid ? AFFORDANCE_INPUT_INVALID : AFFORDANCE_INPUT_UNAVAILABLE };
}

/**
 * Wrap a fully-typed domain definition into the erased tuple member the runner
 * walks.
 *
 * The registry is an explicit tuple of these wrappers — no filesystem
 * discovery (the code-organization ruling), so the set of live domains is
 * readable in one file and a domain cannot appear by being saved. Type erasure
 * is existential: the closure below still sees the concrete `TProfile`,
 * `TMechanics`, `TState`, `TContext`, and `TFrame`, so `deriveMechanics` cannot
 * be handed the wrong domain's state even though the tuple is heterogeneous.
 *
 * The staged pipeline, in order, with its degradation law at each gate:
 *
 * 1. `compileProfile` — no profile ⇒ diagnostic + every phenomenon suppressed;
 * 2. `readInputs` — not `supported` ⇒ diagnostic + every phenomenon suppressed;
 * 3. `deriveMechanics` — once per frame, never per phenomenon;
 * 4. `buildFrame` → deep-frozen;
 * 5. each phenomenon — required dependency not `supported` ⇒ suppressed, so an
 *    absent force or contact can never be read as still air or no touch.
 */
export function registerAffordanceDomain<
  TProfile,
  TMechanics,
  TState extends AffordanceStateSnapshot,
  TContext extends AffordanceResolutionContext,
  TFrame extends DomainFrame<TProfile, TMechanics>,
>(definition: AffordanceDomainDefinition<TProfile, TMechanics, TState, TContext, TFrame>): RegisteredAffordanceDomain {
  assertAffordanceDomainId(definition.id);
  const seen = new Set<string>();
  for (const phenomenon of definition.phenomena) {
    assertAffordancePhenomenonId(phenomenon.id, definition.id);
    if (seen.has(phenomenon.id)) throw new Error(`Duplicate affordance phenomenon "${phenomenon.id}"`);
    seen.add(phenomenon.id);
  }
  for (const attributeId of definition.requiredAttributeIds) {
    if (!attributeRegistry.byId(attributeId)) {
      throw new Error(`Affordance domain "${definition.id}" requires unknown attribute "${attributeId}"`);
    }
  }

  const suppressAll = (code: string, detail?: string): AffordanceResolution[] =>
    definition.phenomena.map((phenomenon) => ({
      kind: "suppressed",
      phenomenonId: phenomenon.id,
      code,
      ...(detail === undefined ? {} : { detail }),
    }));

  return {
    id: definition.id,
    requiredAttributeIds: definition.requiredAttributeIds,
    phenomenonIds: definition.phenomena.map((phenomenon) => phenomenon.id),

    resolve(request: AffordanceDomainRequest): AffordanceDomainRun {
      const diagnostics: Diagnostic[] = [];
      const evidence: (readonly AffordanceEvidence[])[] = [];

      const profileResult = definition.compileProfile(request.attributes);
      evidence.push(profileResult.evidence);
      diagnostics.push(...profileResult.diagnostics);
      const profile = profileResult.profile;
      if (profile === undefined) {
        diagnostics.push(
          diag("warn", AFFORDANCE_INPUT_UNAVAILABLE, `No structural profile for domain ${definition.id}`, {
            path: definition.id,
          }),
        );
        return {
          domainId: definition.id,
          resolutions: suppressAll(AFFORDANCE_SUPPRESSED_NO_PROFILE),
          evidence: mergeAffordanceEvidence(...evidence),
          diagnostics,
        };
      }

      const read = definition.readInputs(request);
      if (read.status !== "supported") {
        const code = read.status === "invalid" ? AFFORDANCE_INPUT_INVALID : AFFORDANCE_INPUT_UNAVAILABLE;
        diagnostics.push(
          diag("warn", code, `Domain ${definition.id} inputs ${read.status}`, { path: definition.id }),
        );
        return {
          domainId: definition.id,
          resolutions: suppressAll(code, definition.id),
          evidence: mergeAffordanceEvidence(...evidence),
          diagnostics,
        };
      }
      evidence.push(read.evidence, read.value.state.evidence);

      const mechanicsResult = definition.deriveMechanics(profile, read.value.state);
      evidence.push(mechanicsResult.evidence);
      diagnostics.push(...mechanicsResult.diagnostics);

      const frame = deepFreeze(definition.buildFrame(profile, mechanicsResult.mechanics, read.value.context));
      evidence.push(frame.evidence);

      const resolutions: AffordanceResolution[] = [];
      for (const phenomenon of definition.phenomena) {
        const unmet = unmetDependencies(phenomenon.dependencies, read.value.state.inputs);
        if (unmet) {
          diagnostics.push(
            diag("warn", unmet.code, `${phenomenon.id} suppressed: ${unmet.keys.join(", ")}`, {
              path: phenomenon.id,
              context: { keys: [...unmet.keys] },
            }),
          );
          resolutions.push({
            kind: "suppressed",
            phenomenonId: phenomenon.id,
            code: unmet.code,
            detail: unmet.keys.join(","),
          });
          continue;
        }
        resolutions.push(phenomenon.resolveFrame(frame));
      }

      return { domainId: definition.id, resolutions, evidence: mergeAffordanceEvidence(...evidence), diagnostics };
    },
  };
}
