import {
  affordanceExposureAt,
  isAffordanceChannelAvailable,
  type AffordanceChannel,
  type AffordanceDomainTrace,
  type AffordanceObservation,
  type AffordanceResolution,
  type EffectiveCoverageRead,
} from "@/contracts";
import { affordanceChannels } from "@/contracts";
import type { ChatAffordanceReadResult } from "./chat-affordances";
import { renderChatAffordanceCues } from "./chat-affordance-cues";

/**
 * The READ-ONLY developer preview of the staged affordance calculation
 * (body-attribute-affordances.spec.architecture.md §Resolved, "Developer
 * preview": built after the garment domain proved the architecture twice).
 *
 * It shows the same staircase a developer reads in code —
 *
 * ```text
 * source inputs → structural profile → mechanics
 *   → observations or suppression reason → perception filtering → selected cue
 * ```
 *
 * — for every domain this lane can feed, and it **stores nothing**. Every stage
 * is recomputed on demand from the committed cut through the domains' own
 * `trace(...)`, which runs the identical stages `resolve` does, so the preview
 * can never explain a read that differs from the one production would take.
 *
 * Three deliberate properties:
 *
 * - **No cue memory is spent.** The preview never persists `nextCues`, so
 *   opening it cannot make the next real exchange fall silent through the repeat
 *   gate.
 * - **It ignores the feature flag.** `CHAT_AFFORDANCE_CUES` decides whether cues
 *   reach the NARRATOR; a developer looking at why a read said nothing needs the
 *   answer either way. The preview reports the flag's state rather than obeying
 *   it.
 * - **Everything is flattened to strings.** The registry erases each domain's
 *   generics, so profile and mechanics arrive as `unknown` — a debug surface is
 *   exactly where that is the honest type, and rendering dotted paths beats
 *   pretending to know the shape.
 */

/** One flattened `path = value` row from a profile or mechanics object. */
export interface AffordancePreviewValue {
  readonly path: string;
  readonly value: string;
}

/** One phenomenon's outcome: what it said, or why it said nothing. */
export interface AffordancePreviewResolution {
  readonly phenomenonId: string;
  readonly kind: AffordanceResolution["kind"];
  /** Suppression/constraint code, or "" for an observation. */
  readonly code: string;
  readonly detail: string;
  readonly band: string;
  readonly locationId: string;
  readonly tags: readonly string[];
}

export interface AffordancePreviewDomain {
  readonly domainId: string;
  /** Per-input adapter verdict — `supported` / `unavailable` / `invalid`. */
  readonly inputs: readonly { readonly key: string; readonly status: string }[];
  /** `null` when no structural profile compiled (the whole domain is suppressed). */
  readonly profile: readonly AffordancePreviewValue[] | null;
  readonly mechanics: readonly AffordancePreviewValue[];
  readonly resolutions: readonly AffordancePreviewResolution[];
  readonly evidence: readonly string[];
  readonly diagnostics: readonly { readonly level: string; readonly code: string; readonly message: string }[];
}

export interface AffordancePreview {
  readonly storyTime: number;
  /** Whether `CHAT_AFFORDANCE_CUES` is on — i.e. whether these cues reach the narrator. */
  readonly cueFlagEnabled: boolean;
  readonly domains: readonly AffordancePreviewDomain[];
  /** The observer view this read was filtered through. */
  readonly perception: {
    readonly exposure: readonly { readonly locationId: string; readonly exposure: string }[];
    readonly channels: readonly { readonly channel: string; readonly available: boolean }[];
  };
  /** Perception-safe observations — what survived the filter. */
  readonly observations: readonly AffordancePreviewResolution[];
  /** Everything that fell silent, physical or perceptual, with its reason. */
  readonly suppressed: readonly AffordancePreviewResolution[];
  /** The ≤2 cues this cut would offer, and the sentence each becomes. */
  readonly cues: readonly { readonly phenomenonId: string; readonly band: string; readonly line: string }[];
  /** The staged coverage read this cut captures; `null` for an unmodelled wardrobe. */
  readonly coverage: EffectiveCoverageRead | null;
}

/** Max flattened rows shown per profile/mechanics object — a debug view, not a dump. */
const PREVIEW_VALUE_CAP = 64;

/**
 * Flatten an erased profile/mechanics value into dotted `path = value` rows.
 *
 * `Set` becomes a sorted list because the domains use it for reach sets, where
 * membership is the interesting thing and iteration order is not; objects and
 * arrays recurse; everything else stringifies. Sorted output, so two reads of
 * the same cut render identically.
 */
function flattenPreviewValue(value: unknown, prefix = ""): AffordancePreviewValue[] {
  if (value === null || value === undefined) return [{ path: prefix || "value", value: String(value) }];
  if (value instanceof Set) {
    return [{ path: prefix || "value", value: [...value].map(String).sort().join(", ") }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => flattenPreviewValue(entry, `${prefix}[${index}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, entry]) => flattenPreviewValue(entry, prefix ? `${prefix}.${key}` : key));
  }
  return [{ path: prefix || "value", value: String(value) }];
}

function previewValues(value: unknown): AffordancePreviewValue[] {
  return flattenPreviewValue(value).slice(0, PREVIEW_VALUE_CAP);
}

function previewResolution(resolution: AffordanceResolution): AffordancePreviewResolution {
  switch (resolution.kind) {
    case "observation":
      return {
        phenomenonId: resolution.id,
        kind: "observation",
        code: "",
        detail: resolution.targetLocationId ?? "",
        band: resolution.intensityBand,
        locationId: resolution.sourceLocationId,
        tags: [...resolution.semanticTags],
      };
    case "constraint":
      return {
        phenomenonId: resolution.id,
        kind: "constraint",
        code: resolution.code,
        detail: "",
        band: "",
        locationId: resolution.locationId ?? "",
        tags: [],
      };
    case "suppressed":
      return {
        phenomenonId: resolution.phenomenonId,
        kind: "suppressed",
        code: resolution.code,
        detail: resolution.detail ?? "",
        band: "",
        locationId: "",
        tags: [],
      };
  }
}

function previewDomain(trace: AffordanceDomainTrace): AffordancePreviewDomain {
  return {
    domainId: trace.domainId,
    inputs: Object.entries(trace.inputs ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, status]) => ({ key, status })),
    profile: trace.profile === null ? null : previewValues(trace.profile),
    mechanics: trace.mechanics === null ? [] : previewValues(trace.mechanics),
    resolutions: trace.resolutions.map(previewResolution),
    evidence: trace.evidence.map((entry) => `${entry.kind}:${entry.ref}${entry.detail ? ` (${entry.detail})` : ""}`),
    diagnostics: trace.diagnostics.map((entry) => ({
      level: entry.severity,
      code: entry.code,
      message: entry.message,
    })),
  };
}

/**
 * Build the staged preview for one already-computed chat affordance read.
 *
 * Takes the read RESULT rather than the raw inputs, so the preview is always
 * about a read that actually happened — the caller assembles the same committed
 * cut a live exchange would and hands the result straight through.
 */
export function buildChatAffordancePreview(input: {
  result: ChatAffordanceReadResult;
  /** How cue lines name the subject — "Wren's". */
  possessive: string;
  /** Whether `CHAT_AFFORDANCE_CUES` is on. Reported, never obeyed (see the header). */
  cueFlagEnabled: boolean;
}): AffordancePreview {
  const { request, read } = input.result;
  const lines = renderChatAffordanceCues({
    cues: read.cues,
    attributes: input.result.attributes,
    possessive: input.possessive,
    garmentNames: input.result.garmentNames,
  });

  return {
    storyTime: request.storyTime,
    cueFlagEnabled: input.cueFlagEnabled,
    domains: request.domains.map((domain) =>
      previewDomain(
        domain.trace({
          subjectId: request.subjectId,
          storyTime: request.storyTime,
          attributes: request.attributes,
          payload: request.payloads[domain.id],
        }),
      ),
    ),
    perception: {
      exposure: previewExposureLocations(read.observations, read.suppressed).map((locationId) => ({
        locationId,
        exposure: affordanceExposureAt(request.perception, locationId),
      })),
      channels: affordanceChannels.map((channel: AffordanceChannel) => ({
        channel,
        available: isAffordanceChannelAvailable(request.perception, channel),
      })),
    },
    observations: read.observations.map(previewResolution),
    suppressed: read.suppressed.map(previewResolution),
    // Pair each selected cue with the sentence it became. The projection dedupes
    // identical sentences, so a shorter list than `cues` is honest output, not a
    // mismatch — the cue simply had nothing distinct to say.
    cues: read.cues.slice(0, lines.length).map((cue, index) => ({
      phenomenonId: cue.id,
      band: cue.intensityBand,
      line: lines[index] ?? "",
    })),
    coverage: input.result.coverage,
  };
}

/**
 * The body locations worth showing an exposure verdict for: every location this
 * cut actually produced a read about. Listing the whole registry would bury the
 * three rows that explain the silence.
 */
function previewExposureLocations(
  observations: readonly AffordanceObservation[],
  suppressed: readonly { readonly detail?: string }[],
): string[] {
  const ids = new Set<string>();
  for (const observation of observations) {
    ids.add(observation.sourceLocationId);
    if (observation.targetLocationId !== undefined) ids.add(observation.targetLocationId);
  }
  // A perception suppression records the blocking location in `detail`.
  for (const entry of suppressed) {
    if (entry.detail !== undefined && entry.detail.length > 0 && !entry.detail.includes(",")) ids.add(entry.detail);
  }
  return [...ids].sort();
}
