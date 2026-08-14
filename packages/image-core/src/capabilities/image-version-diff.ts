import { z } from "zod";
import { stableJson } from "../render-kernel/stable-json";
import type { ImageControlDefaults, ImageModelProfile } from "../models/image-model-profiles";
import {
  type ImageModelAdvancedCapabilities,
  type ImageModelControlBindings,
  imageModelControlBindingsSchema,
} from "./image-model-capabilities";

/**
 * Version-candidate comparison (image-model-capabilities.spec.md §"Version
 * candidate and promotion flow").
 *
 * Two pure questions the promotion flow asks before any row moves:
 *
 * 1. **What changed?** {@link diffImageModelCapabilities} compares the active
 *    row's mechanical capabilities against a candidate probe, field by field,
 *    so the admin card can show exactly how the candidate's schema differs.
 *    Entries describe SCHEMA DIFFERENCES, not a write plan: most diffed fields
 *    are what activation rewrites, but the owner-owned ones (`maxReferences`,
 *    `supportedAspects`) are reported for review and never auto-written — they
 *    carry {@link ImageCapabilityDiffEntry.ownerOwned} so the card can say so.
 * 2. **Would activating break a profile?** {@link validateImageProfileForCandidate}
 *    judges one enabled profile against the candidate's capabilities and
 *    reports findings. BLOCKING findings refuse activation (the profile's
 *    stored configuration would stop being executable at all); WARNING findings
 *    are allowed and reported (the configuration degrades to the recorded
 *    `no_binding` drops that live renders already tolerate).
 *
 * Both sides are structural snapshots rather than named provider types, so the
 * active side can be an `ImageModel` row and the candidate a
 * `ReplicateModelProbe` without this package importing either a database shape
 * or `@vesper/image-replicate` (which depends on this package and may not be
 * imported back).
 */

/**
 * The mechanical capability fields both an `ImageModel` row and a successful
 * Replicate probe carry — the comparable surface of a version.
 *
 * `referenceArity` and `aspectMode` are plain strings here on purpose: the
 * branded unions live in `../models/image-models`, and this module compares
 * values without interpreting them, so naming the unions would add a models
 * import for no behavioral gain. `maxReferences` is optional because the stored
 * cap is owner-editable while the probe's is a derived starting value — a
 * caller that considers the comparison misleading can omit either side and no
 * entry is produced.
 */
export interface ImageModelCapabilitySnapshot extends ImageCandidateCapabilities {
  referenceField: string;
  referenceArity: string;
  maxReferences?: number;
  aspectMode: string;
  supportedAspects: readonly string[];
  outputFormat: string | null;
  extraInput: Record<string, unknown>;
}

/** The subset profile validation needs — what the candidate can do, not how it is called. */
export interface ImageCandidateCapabilities {
  canGenerate: boolean;
  canEdit: boolean;
  advancedCapabilities: ImageModelAdvancedCapabilities;
}

export const imageCapabilityDiffKinds = ["added", "removed", "changed"] as const;
export type ImageCapabilityDiffKind = (typeof imageCapabilityDiffKinds)[number];

/**
 * One line of the capability diff, named for rendering as a flat list:
 * a scalar column (`canEdit`), a control slot (`controls.guidance`), one
 * `extraInput` key (`extraInput.go_fast`), one known input
 * (`knownInputFields.seed`), one dedicated image input
 * (`additionalImageInputs.pose_image`), `output`, or `prompt`.
 *
 * Unchanged fields are OMITTED — the diff is what differs between the two
 * schemas, not a second copy of the capability record. `active`/`candidate`
 * carry the serializable values where a value is worth showing; a
 * `knownInputFields.*` entry carries neither, because the field name IS the
 * fact.
 *
 * `ownerOwned` marks the fields whose STORED value is the owner's judgment
 * rather than the probe's (`maxReferences`, the curated `supportedAspects`):
 * the entry is reported so the owner can review the drift, but neither
 * activation nor a re-probe ever writes those columns.
 */
export interface ImageCapabilityDiffEntry {
  field: string;
  kind: ImageCapabilityDiffKind;
  active?: unknown;
  candidate?: unknown;
  ownerOwned?: true;
}

/** Wire schema for the diff entry, so routes and the admin client parse one shape. */
export const imageCapabilityDiffEntrySchema = z.object({
  field: z.string(),
  kind: z.enum(imageCapabilityDiffKinds),
  active: z.unknown().optional(),
  candidate: z.unknown().optional(),
  ownerOwned: z.literal(true).optional(),
});

/** Deep equality via the fingerprint spelling — one answer to "did this value move?". */
function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** A `changed` entry, or nothing when the two sides agree. */
function changedEntry(field: string, active: unknown, candidate: unknown): ImageCapabilityDiffEntry[] {
  return sameValue(active, candidate) ? [] : [{ field, kind: "changed", active, candidate }];
}

/**
 * Present/absent/changed for one optional record slot (a control binding, the
 * prompt binding, a dedicated image input). `added`/`removed` still carry the
 * one side that exists, so the list can show what appeared or went away.
 */
function slotEntries(field: string, active: unknown, candidate: unknown): ImageCapabilityDiffEntry[] {
  if (active === undefined && candidate === undefined) return [];
  if (active === undefined) return [{ field, kind: "added", candidate }];
  if (candidate === undefined) return [{ field, kind: "removed", active }];
  return changedEntry(field, active, candidate);
}

/** Per-key added/removed/changed entries over two plain records, keys sorted. */
function recordEntries(
  prefix: string,
  active: Record<string, unknown>,
  candidate: Record<string, unknown>,
): ImageCapabilityDiffEntry[] {
  const keys = [...new Set([...Object.keys(active), ...Object.keys(candidate)])].sort();
  return keys.flatMap((key) =>
    slotEntries(
      `${prefix}.${key}`,
      key in active ? active[key] : undefined,
      key in candidate ? candidate[key] : undefined,
    ),
  );
}

/**
 * Field-level diff between the ACTIVE version's stored capabilities and a
 * CANDIDATE probe — how the candidate's schema differs from what is stored
 * (spec §"Version candidate and promotion flow": the diff must highlight
 * removed or changed fields used by enabled profiles, including LoRA bindings,
 * reference arity, output format, aspects, size controls, and numeric ranges).
 * Most entries are what `activate-version` would rewrite; the owner-owned
 * `maxReferences` and `supportedAspects` entries are review-only and flagged.
 *
 * Entry order is deterministic: the scalar columns in declaration order, then
 * `supportedAspects`, then `extraInput.*`, then the advanced record —
 * `prompt`, `controls.*` in contract slot order, `additionalImageInputs.*`,
 * `output`, and `knownInputFields.*` sorted.
 *
 * `supportedAspects` is compared as a SET: the list is the model's offered
 * menu, selection happens per render by ratio, and a pure reordering changes
 * no render. `knownInputFields` reports one entry per appeared/vanished field
 * name — an active row that was never probed (empty list) honestly shows every
 * candidate field as `added`.
 */
export function diffImageModelCapabilities(
  active: ImageModelCapabilitySnapshot,
  candidate: ImageModelCapabilitySnapshot,
): ImageCapabilityDiffEntry[] {
  const entries: ImageCapabilityDiffEntry[] = [
    ...changedEntry("canGenerate", active.canGenerate, candidate.canGenerate),
    ...changedEntry("canEdit", active.canEdit, candidate.canEdit),
    ...changedEntry("referenceField", active.referenceField, candidate.referenceField),
    ...changedEntry("referenceArity", active.referenceArity, candidate.referenceArity),
    ...(active.maxReferences === undefined || candidate.maxReferences === undefined
      ? []
      : changedEntry("maxReferences", active.maxReferences, candidate.maxReferences).map((entry) => ({
          ...entry,
          ownerOwned: true as const,
        }))),
    ...changedEntry("aspectMode", active.aspectMode, candidate.aspectMode),
    ...(sameValue([...active.supportedAspects].sort(), [...candidate.supportedAspects].sort())
      ? []
      : [
          {
            field: "supportedAspects",
            kind: "changed" as const,
            active: [...active.supportedAspects],
            candidate: [...candidate.supportedAspects],
            // The stored list is curation (0098 prunes Wan's edit-breaking 4K
            // sizes); the diff shows the provider moved, the owner decides.
            ownerOwned: true as const,
          },
        ]),
    ...changedEntry("outputFormat", active.outputFormat, candidate.outputFormat),
    ...recordEntries("extraInput", active.extraInput, candidate.extraInput),
  ];

  const activeAdvanced = active.advancedCapabilities;
  const candidateAdvanced = candidate.advancedCapabilities;
  entries.push(...slotEntries("prompt", activeAdvanced.prompt, candidateAdvanced.prompt));
  // The contract's slot list is the single source of control names — a slot the
  // schema does not know cannot appear in either record, so iterating the shape
  // covers everything without a second hand-kept list.
  const controlSlots = Object.keys(imageModelControlBindingsSchema.shape) as (keyof ImageModelControlBindings)[];
  for (const slot of controlSlots) {
    entries.push(...slotEntries(`controls.${slot}`, activeAdvanced.controls[slot], candidateAdvanced.controls[slot]));
  }
  // Dedicated image inputs are keyed by their provider FIELD: the field is the
  // identity a render binds to, and one field carrying a new role hint is a
  // change to that input rather than a remove-plus-add.
  entries.push(
    ...recordEntries(
      "additionalImageInputs",
      Object.fromEntries(activeAdvanced.additionalImageInputs.map((input) => [input.binding.field, input])),
      Object.fromEntries(candidateAdvanced.additionalImageInputs.map((input) => [input.binding.field, input])),
    ),
  );
  entries.push(...changedEntry("output", activeAdvanced.output, candidateAdvanced.output));

  const activeKnown = new Set(activeAdvanced.knownInputFields);
  const candidateKnown = new Set(candidateAdvanced.knownInputFields);
  for (const name of [...new Set([...activeKnown, ...candidateKnown])].sort()) {
    if (activeKnown.has(name) && !candidateKnown.has(name)) {
      entries.push({ field: `knownInputFields.${name}`, kind: "removed" });
    } else if (!activeKnown.has(name) && candidateKnown.has(name)) {
      entries.push({ field: `knownInputFields.${name}`, kind: "added" });
    }
  }
  return entries;
}

export const imageProfileCandidateFindingLevels = ["blocking", "warning"] as const;
export type ImageProfileCandidateFindingLevel = (typeof imageProfileCandidateFindingLevels)[number];

export const imageProfileCandidateFindingCodes = [
  "operation_impossible",
  "override_field_unknown",
  "lora_binding_missing",
  "control_binding_missing",
] as const;
export type ImageProfileCandidateFindingCode = (typeof imageProfileCandidateFindingCodes)[number];

/**
 * One judgment about one enabled profile against a candidate version.
 *
 * `blocking` means the profile's stored configuration could not RUN on the
 * candidate — activation must refuse and name it. `warning` means a stored
 * control default would silently stop being sent (the mapper's recorded
 * `no_binding` drop), which live behavior already tolerates — activation
 * proceeds and reports it.
 */
export interface ImageProfileCandidateFinding {
  level: ImageProfileCandidateFindingLevel;
  code: ImageProfileCandidateFindingCode;
  message: string;
  context: Record<string, unknown>;
}

/** Wire schema for a finding, shared by the routes and the admin client. */
export const imageProfileCandidateFindingSchema = z.object({
  level: z.enum(imageProfileCandidateFindingLevels),
  code: z.enum(imageProfileCandidateFindingCodes),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).default(() => ({})),
});

/**
 * One enabled profile's findings against a candidate, labeled for the admin
 * card — the wire shape the probe/activate routes emit and the client parses,
 * spelled once here like the diff-entry and finding schemas above.
 */
export const imageModelProfileFindingsSchema = z.object({
  profileId: z.string().min(1),
  key: z.string(),
  label: z.string(),
  findings: z.array(imageProfileCandidateFindingSchema),
});
export type ImageModelProfileFindings = z.infer<typeof imageModelProfileFindingsSchema>;

/** The slice of a profile row validation reads — the full row is assignable. */
export type ImageProfileCandidateInput = Pick<ImageModelProfile, "operation" | "providerOverrides" | "controlDefaults">;

/**
 * The stored control defaults that need a candidate binding to keep being
 * sent, each mapped to the contract slot the render-time mapper resolves it
 * through. A `resolution` of `"custom"` is deliberately NOT mapped to
 * `resolutionTier` — a custom request travels through the width/height
 * bindings, which the `width`/`height` rows already cover.
 *
 * `seed` has no row (profiles store a seed POLICY, never a number),
 * `outputCount`/`coherentSet` have none (the single-image path forces them
 * regardless of binding), and `thinkingMode` has none (no seeded profile
 * stores it and its loss is the same tolerated `no_binding` drop) — the rows
 * here are the defaults an operator deliberately tuned and would want told
 * about losing.
 */
const CONTROL_DEFAULT_BINDINGS: ReadonlyArray<{
  control: string;
  slot: keyof ImageModelControlBindings;
  isSet: (defaults: ImageControlDefaults) => boolean;
}> = [
  { control: "guidance", slot: "guidance", isSet: (d) => d.guidance !== undefined },
  { control: "steps", slot: "steps", isSet: (d) => d.steps !== undefined },
  { control: "negativePrompt", slot: "negativePrompt", isSet: (d) => d.negativePrompt !== undefined },
  { control: "editStrength", slot: "editStrength", isSet: (d) => d.editStrength !== undefined },
  { control: "resolution", slot: "resolutionTier", isSet: (d) => d.resolution !== undefined && d.resolution !== "custom" },
  { control: "width", slot: "customWidth", isSet: (d) => d.width !== undefined },
  { control: "height", slot: "customHeight", isSet: (d) => d.height !== undefined },
];

/**
 * Judge one enabled profile against a candidate version's capabilities.
 *
 * BLOCKING (activation must refuse):
 *
 * - the profile's `operation` becomes impossible — `edit` while the candidate
 *   cannot edit, or `generate` while it cannot generate;
 * - a `providerOverrides` key the candidate's `knownInputFields` does not
 *   declare. An EMPTY `knownInputFields` fails CLOSED when overrides exist:
 *   emptiness means the probe recorded nothing, not that everything is
 *   permitted — the same rule `validateProviderOverrides` applies at render
 *   time, promoted from a drop to a refusal because activation is the moment
 *   the operator can still fix the profile before a render silently loses it;
 * - a `controlDefaults.lora` selection while the candidate lacks either LoRA
 *   binding (`loraWeights` AND `loraScale` are both required to send one).
 *
 * WARNING (allowed, reported): a tuned control default whose binding the
 * candidate does not declare ({@link CONTROL_DEFAULT_BINDINGS}) — it degrades
 * to the mapper's recorded `no_binding` drop, exactly what live renders on an
 * unprobed row already do.
 */
export function validateImageProfileForCandidate(
  profile: ImageProfileCandidateInput,
  candidate: ImageCandidateCapabilities,
): ImageProfileCandidateFinding[] {
  const findings: ImageProfileCandidateFinding[] = [];
  const { controls, knownInputFields } = candidate.advancedCapabilities;

  if (profile.operation === "edit" && !candidate.canEdit) {
    findings.push({
      level: "blocking",
      code: "operation_impossible",
      message: "this edit profile cannot run: the candidate version has no reference input",
      context: { operation: profile.operation },
    });
  }
  if (profile.operation === "generate" && !candidate.canGenerate) {
    findings.push({
      level: "blocking",
      code: "operation_impossible",
      message: "this generate profile cannot run: the candidate version requires a reference image",
      context: { operation: profile.operation },
    });
  }

  const known = new Set(knownInputFields);
  for (const field of Object.keys(profile.providerOverrides).sort()) {
    if (known.has(field)) continue;
    findings.push({
      level: "blocking",
      code: "override_field_unknown",
      message:
        knownInputFields.length === 0
          ? `providerOverrides key "${field}" cannot be validated: the candidate declares no known input fields`
          : `providerOverrides key "${field}" is not an input the candidate version declares`,
      context: { field },
    });
  }

  if (profile.controlDefaults.lora && (!controls.loraWeights || !controls.loraScale)) {
    findings.push({
      level: "blocking",
      code: "lora_binding_missing",
      message: "this profile names a LoRA but the candidate version does not expose both LoRA bindings",
      context: {
        loraId: profile.controlDefaults.lora.id,
        loraWeights: controls.loraWeights !== undefined,
        loraScale: controls.loraScale !== undefined,
      },
    });
  }

  for (const { control, slot, isSet } of CONTROL_DEFAULT_BINDINGS) {
    if (!isSet(profile.controlDefaults) || controls[slot] !== undefined) continue;
    findings.push({
      level: "warning",
      code: "control_binding_missing",
      message: `the "${control}" default will stop being sent: the candidate version declares no ${slot} binding`,
      context: { control, slot },
    });
  }

  return findings;
}
