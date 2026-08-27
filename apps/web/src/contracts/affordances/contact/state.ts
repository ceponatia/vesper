import { z } from "zod";
import { diag, type DiagnosticSink } from "../../diagnostics";
import { parseOr } from "@/lib/parse";
import { affordanceSubjectIdSchema, unitIntervalSchema } from "../core";
import { CONTACT_LIFECYCLE_INVALID, CONTACT_STATE_RECOMPUTED } from "./diagnostics";
import {
  CONTACT_ACTION_SCOPE,
  contactActionKindSchema,
  contactActionRequiresPermission,
  contactAdjustmentKindSchema,
  contactAgencyStatusSchema,
  contactControlStatusSchema,
  contactPolicyNotRequiredBasisSchema,
  contactPolicyScopeSchema,
  contactPolicyStatusSchema,
} from "./decisions";
import { contactEventRefSchema, contactIdMatchesDerivation, contactIdSchema } from "./identity";
import {
  composeContactMaterial,
  contactEvidenceSchema,
  contactMaterialLayerReadSchema,
  type ContactMaterialTransmissionRead,
} from "./material";
import {
  contactPairKey,
  contactSurfaceRefSchema,
  contactBodySurfaceRefSchema,
  isInterpersonalContact,
} from "./surfaces";
import {
  CONTACT_LIFECYCLE_MAX_ACTIVE,
  CONTACT_LIFECYCLE_STATE_VERSION,
  emptyContactLifecycleState,
  type ContactLifecycleState,
} from "./lifecycle";
import {
  contactAreaBandSchema,
  contactMotionBandSchema,
  contactPressureBandSchema,
  type CommittedContactRead,
} from "./types";

/**
 * The persisted shape of the active-contact projection, and its healing rules.
 *
 * **No storage wiring ships in slice 1**, but the home is no longer an open
 * question. *"Where should committed contact live?"* was **ruled by the owner
 * 2026-07-30**: a durable event/action
 * is the provenance, plus a versioned active-contact projection captured in the
 * chat's retake snapshot — contact can never remain prompt-local. This file is
 * that projection's shape, settled here so it is not decided twice; slice 3
 * wires the store to it.
 *
 * ## Why a corrupt contact is DROPPED, not quarantined
 *
 * The body-surface owner quarantines a corrupt entry
 * (`src/contracts/state/body-surface.ts` law 4) because an absent entry there
 * means *dry*, and deleting a bad one would launder "unknown" into a physical
 * claim. Contact is the mirror image: an absent contact means *no contact*,
 * which is already the most conservative answer available, and a dropped entry
 * can therefore never buy a claim. A quarantine marker here would only be a way
 * for unreadable data to keep occupying a surface pair.
 *
 * So: item-lenient, drop the unreadable, report every drop, and never fail the
 * whole blob over one bad row.
 *
 * ## Why field shapes are not enough
 *
 * A stored projection is DERIVED data that left this process, and everything
 * that comes back through here is untrusted — a hand-edited JSONB column, a row
 * written by an older release, a blob a branch restore carried across. Every
 * field below can be individually well-formed while the record as a whole claims
 * something no gate ever allowed: a pair key that names other surfaces than the
 * ones stored beside it, a contact id that was never derived from this pair, an
 * acting surface belonging to somebody the actor-control decision never covered,
 * a transmission that reports bare skin while the layers beside it say a covering
 * is in the way. `storedContactProblem` checks the RELATIONSHIPS, and a row that
 * fails one is dropped exactly like a row that failed its schema — the
 * conservative answer for a contact is that there is no contact.
 *
 * The one exception is `transmission`, which is recomputed rather than rejected:
 * it is derived from `materialBetween`, and re-deriving it can only narrow what
 * the blob claimed. Every other field is a claim in its own right, and repairing
 * one would be inventing the thing the plan says may never be invented.
 */

const evidenceListSchema = z.array(contactEvidenceSchema).max(64).readonly();

const storyTimeSchema = z.number().int().min(0);

const actorControlSchema = z.object({
  status: contactControlStatusSchema,
  actorId: affordanceSubjectIdSchema,
  evidence: evidenceListSchema,
});

const targetAgencySchema = z.object({
  status: contactAgencyStatusSchema,
  targetId: affordanceSubjectIdSchema,
  evidence: evidenceListSchema,
});

const policySchema = z.object({
  status: contactPolicyStatusSchema,
  notRequiredBasis: contactPolicyNotRequiredBasisSchema.optional(),
  notRequiredTargetId: affordanceSubjectIdSchema.optional(),
  scopes: z.array(contactPolicyScopeSchema).max(8).readonly(),
  evidence: evidenceListSchema,
});

const minimalAdjustmentSchema = z.object({
  id: z.string().trim().min(1).max(128),
  subjectId: affordanceSubjectIdSchema,
  kind: contactAdjustmentKindSchema,
  evidence: evidenceListSchema,
});

const transmissionSchema = z.object({
  directSkinContact: z.boolean(),
  layerIds: z.array(z.string().min(1)).max(16).readonly(),
  tactileTransmission: unitIntervalSchema,
  shapeTransmission: unitIntervalSchema,
  thermalTransmission: unitIntervalSchema,
  moistureTransmission: unitIntervalSchema,
  scentTransmission: unitIntervalSchema,
  visibleThrough: z.boolean(),
  evidence: evidenceListSchema,
});

const motionSchema = z.object({
  band: contactMotionBandSchema,
  pathDetailIds: z.array(z.string().trim().min(1).max(64)).max(16).readonly().optional(),
  evidence: evidenceListSchema,
});

/**
 * One stored contact. **Strict throughout** — no `.catch()`, no defaults.
 *
 * Every field is either identity (which surfaces, which contact) or a physical
 * claim (which pressure, what is between). Repairing either would be inventing
 * the thing the plan says may never be invented, so a row that does not parse
 * simply stops being a contact.
 */
export const committedContactReadSchema: z.ZodType<CommittedContactRead> = z.object({
  phase: z.literal("active"),
  contactId: contactIdSchema,
  pairKey: z.string().min(1).max(2_048),
  startedByEventRef: contactEventRefSchema,
  lastUpdatedByEventRef: contactEventRefSchema,
  startedAt: storyTimeSchema,
  lastUpdatedAt: storyTimeSchema,
  actorId: affordanceSubjectIdSchema,
  actionKind: contactActionKindSchema,
  source: contactBodySurfaceRefSchema,
  target: contactSurfaceRefSchema,
  pressure: contactPressureBandSchema.optional(),
  contactArea: contactAreaBandSchema.optional(),
  motion: motionSchema.optional(),
  materialBetween: z.array(contactMaterialLayerReadSchema).max(16).readonly(),
  transmission: transmissionSchema,
  implicitAdjustments: z.array(minimalAdjustmentSchema).max(8).readonly(),
  actorControl: actorControlSchema,
  targetAgencies: z.array(targetAgencySchema).max(8).readonly(),
  policy: policySchema,
  evidence: evidenceListSchema,
});

/**
 * The outer blob. `version` is read as `unknown` ON PURPOSE.
 *
 * A `.catch(CURRENT)` here would take a malformed version — a string, a null, a
 * missing key — and hand back the number this build happens to write, so the
 * blob would then be read as though a writer of this exact release had produced
 * it. That is the opposite of the stated rule: an unreadable version means
 * nothing else in the blob can be interpreted, and the only safe answer is the
 * empty projection.
 */
const rawStateSchema = z.object({
  version: z.unknown(),
  contacts: z.array(z.unknown()).catch([]).default([]),
});

/** The physical half of a transmission read — everything but its provenance. */
function transmissionsAgree(
  left: ContactMaterialTransmissionRead,
  right: ContactMaterialTransmissionRead,
): boolean {
  return (
    left.directSkinContact === right.directSkinContact &&
    left.visibleThrough === right.visibleThrough &&
    left.tactileTransmission === right.tactileTransmission &&
    left.shapeTransmission === right.shapeTransmission &&
    left.thermalTransmission === right.thermalTransmission &&
    left.moistureTransmission === right.moistureTransmission &&
    left.scentTransmission === right.scentTransmission &&
    left.layerIds.length === right.layerIds.length &&
    left.layerIds.every((layerId, index) => layerId === right.layerIds[index])
  );
}

/**
 * The agency proof a stored contact must still carry for the bodies its own
 * recorded adjustments moved.
 *
 * `implicitAdjustments` is a durable claim that a body MOVED. Without this
 * check, a stored contact could carry an adjustment on a non-actor participant
 * with no decision behind it at all — the resolver's per-participant gate
 * enforced at commit time and then nothing enforcing it on read, which is
 * exactly the gap the pair-key and contact-id re-derivations exist to close for
 * identity. A row that cannot prove the movement was authorized is dropped like
 * any other unreadable row: no contact is always the safe answer.
 *
 * Duplicates are rejected first, and for the resolver's reason — two answers
 * about one body make the `find` below meaningless, because the row it returns
 * is an artifact of array order rather than of anybody's authority.
 */
function storedAgencyProblem(contact: CommittedContactRead): string | undefined {
  const seen = new Set<string>();
  for (const decision of contact.targetAgencies) {
    if (seen.has(decision.targetId)) return "duplicate_agency_decision";
    seen.add(decision.targetId);
  }
  for (const adjustment of contact.implicitAdjustments) {
    if (adjustment.subjectId === contact.actorId) continue;
    const decision = contact.targetAgencies.find((entry) => entry.targetId === adjustment.subjectId);
    if (decision?.status !== "allowed") return "agency_does_not_cover_adjustment";
  }
  return undefined;
}

/**
 * Every relationship between fields that a per-field schema cannot see.
 *
 * Returns the first failure as a short structured reason — never prose for a
 * user, and never a repair. Order runs identity first (is this even the contact
 * it says it is), then authority (was the acting body the one the decision
 * covered), then the authorization the action kind demands.
 */
function storedContactProblem(contact: CommittedContactRead): string | undefined {
  const pairKey = contactPairKey(contact.source, contact.target);
  if (pairKey !== contact.pairKey) return "pair_key_mismatch";
  if (!contactIdMatchesDerivation(contact.contactId, { pairKey, startedByEventRef: contact.startedByEventRef })) {
    return "contact_id_not_derived";
  }
  if (contact.source.subjectId !== contact.actorId) return "source_is_not_the_actor";
  if (contact.actorControl.actorId !== contact.actorId) return "actor_control_names_another_subject";
  if (contact.actorControl.status !== "allowed") return "actor_control_did_not_allow";
  const agencyProblem = storedAgencyProblem(contact);
  if (agencyProblem !== undefined) return agencyProblem;
  if (contact.lastUpdatedAt < contact.startedAt) return "last_updated_precedes_start";

  if (!isInterpersonalContact(contact.source, contact.target)) return undefined;
  if (contactActionRequiresPermission(contact.actionKind)) {
    // The ruled player-target exception carries no scope: a stored contact whose
    // policy says `not_required` FOR THAT REASON is exactly what the resolver
    // committed. A bare `not_required` remains a contact no gate ever allowed.
    const playerTarget =
      contact.policy.status === "not_required" &&
      contact.policy.notRequiredBasis === "player_target" &&
      contact.target.kind === "body" &&
      contact.policy.notRequiredTargetId === contact.target.subjectId;
    if (!playerTarget) {
      if (contact.policy.status !== "allowed") return "permission_does_not_allow";
      if (!contact.policy.scopes.includes(CONTACT_ACTION_SCOPE[contact.actionKind])) return "permission_scope_missing";
    }
  }
  return undefined;
}

/**
 * Re-derive the composed transmission from the stored layers.
 *
 * The layers are the physical claim and the composition is a function of them,
 * so a stored composition that disagrees is either a stale write or a tampered
 * one — and in both cases the layers win. Recomputation can only ever narrow the
 * claim (a stack of layers can never compose to bare skin), which is why this
 * one field is healed instead of dropped.
 */
function withRecomposedTransmission(contact: CommittedContactRead, sink?: DiagnosticSink): CommittedContactRead {
  const recomposed = composeContactMaterial(contact.materialBetween);
  if (transmissionsAgree(recomposed, contact.transmission)) return contact;
  sink?.push(
    diag("warn", CONTACT_STATE_RECOMPUTED, "a stored contact's transmission disagreed with its own layers", {
      context: {
        contactId: contact.contactId,
        storedDirectSkinContact: contact.transmission.directSkinContact,
        layers: contact.materialBetween.length,
      },
    }),
  );
  return { ...contact, transmission: recomposed };
}

/**
 * Parse stored lifecycle state, dropping what cannot be read.
 *
 * A blob that is not even an object degrades to the empty projection — nothing
 * is touching, which is the answer that can never be wrong in a harmful
 * direction. A malformed or future `version` degrades the same way rather than
 * being read optimistically: a newer writer may have meant something this reader
 * would misinterpret, and a missing contact is always safer than a misread one.
 */
export function parseContactLifecycleState(raw: unknown, sink?: DiagnosticSink): ContactLifecycleState {
  const outer = parseOr(rawStateSchema, raw, { version: CONTACT_LIFECYCLE_STATE_VERSION, contacts: [] }, sink);
  if (outer.version !== CONTACT_LIFECYCLE_STATE_VERSION) {
    sink?.push(
      diag("warn", CONTACT_LIFECYCLE_INVALID, "stored contact state carries no version this build can read", {
        context: { version: outer.version, expected: CONTACT_LIFECYCLE_STATE_VERSION },
      }),
    );
    return emptyContactLifecycleState();
  }

  const contacts: CommittedContactRead[] = [];
  const problems: string[] = [];
  const seenPairs = new Set<string>();
  for (const entry of outer.contacts.slice(0, CONTACT_LIFECYCLE_MAX_ACTIVE)) {
    const parsed = committedContactReadSchema.safeParse(entry);
    if (!parsed.success) {
      problems.push("unreadable");
      continue;
    }
    if (seenPairs.has(parsed.data.pairKey)) {
      problems.push("duplicate_pair");
      continue;
    }
    const problem = storedContactProblem(parsed.data);
    if (problem !== undefined) {
      problems.push(problem);
      continue;
    }
    seenPairs.add(parsed.data.pairKey);
    contacts.push(withRecomposedTransmission(parsed.data, sink));
  }
  if (problems.length > 0) {
    sink?.push(
      diag("error", CONTACT_LIFECYCLE_INVALID, "stored contact entries were unusable and were dropped", {
        context: { dropped: problems.length, problems },
      }),
    );
  }
  return {
    version: CONTACT_LIFECYCLE_STATE_VERSION,
    contacts: contacts.sort((left, right) => left.pairKey.localeCompare(right.pairKey)),
  };
}
