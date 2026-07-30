import { z } from "zod";
import { diag, type DiagnosticSink } from "../../diagnostics";
import { parseOr } from "@/lib/parse";
import { affordanceSubjectIdSchema, unitIntervalSchema } from "../core";
import { CONTACT_LIFECYCLE_INVALID } from "./diagnostics";
import {
  contactActionKindSchema,
  contactAdjustmentKindSchema,
  contactControlStatusSchema,
  contactEligibilityStatusSchema,
  contactPolicyScopeSchema,
  contactPolicyStatusSchema,
} from "./decisions";
import { contactEventRefSchema, contactIdSchema } from "./identity";
import { contactEvidenceSchema, contactMaterialLayerReadSchema } from "./material";
import { contactSurfaceRefSchema, contactBodySurfaceRefSchema } from "./surfaces";
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
 * 2026-07-30** (romantic-contact-affordances.audit.md): a durable event/action
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
 */

const evidenceListSchema = z.array(contactEvidenceSchema).max(64).readonly();

const storyTimeSchema = z.number().int().min(0);

const actorControlSchema = z.object({
  status: contactControlStatusSchema,
  actorId: affordanceSubjectIdSchema,
  evidence: evidenceListSchema,
});

const eligibilitySchema = z.object({
  status: contactEligibilityStatusSchema,
  participantIds: z.array(affordanceSubjectIdSchema).max(8).readonly(),
  evidence: evidenceListSchema,
});

const policySchema = z.object({
  status: contactPolicyStatusSchema,
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
  participantEligibility: eligibilitySchema,
  policy: policySchema,
  evidence: evidenceListSchema,
});

const rawStateSchema = z.object({
  version: z.number().int().catch(CONTACT_LIFECYCLE_STATE_VERSION),
  contacts: z.array(z.unknown()).catch([]).default([]),
});

/**
 * Parse stored lifecycle state, dropping what cannot be read.
 *
 * A blob that is not even an object degrades to the empty projection — nothing
 * is touching, which is the answer that can never be wrong in a harmful
 * direction. A future `version` also degrades to empty rather than being read
 * optimistically: a newer writer may have meant something this reader would
 * misinterpret, and a missing contact is always safer than a misread one.
 */
export function parseContactLifecycleState(raw: unknown, sink?: DiagnosticSink): ContactLifecycleState {
  const outer = parseOr(rawStateSchema, raw, { version: CONTACT_LIFECYCLE_STATE_VERSION, contacts: [] }, sink);
  if (outer.version !== CONTACT_LIFECYCLE_STATE_VERSION) {
    sink?.push(
      diag("warn", CONTACT_LIFECYCLE_INVALID, "stored contact state is a version this build cannot read", {
        context: { version: outer.version, expected: CONTACT_LIFECYCLE_STATE_VERSION },
      }),
    );
    return emptyContactLifecycleState();
  }

  const contacts: CommittedContactRead[] = [];
  let dropped = 0;
  const seenPairs = new Set<string>();
  for (const entry of outer.contacts.slice(0, CONTACT_LIFECYCLE_MAX_ACTIVE)) {
    const parsed = committedContactReadSchema.safeParse(entry);
    if (!parsed.success || seenPairs.has(parsed.data.pairKey)) {
      dropped += 1;
      continue;
    }
    seenPairs.add(parsed.data.pairKey);
    contacts.push(parsed.data);
  }
  if (dropped > 0) {
    sink?.push(
      diag("error", CONTACT_LIFECYCLE_INVALID, "stored contact entries were unreadable and were dropped", {
        context: { dropped },
      }),
    );
  }
  return {
    version: CONTACT_LIFECYCLE_STATE_VERSION,
    contacts: contacts.sort((left, right) => left.pairKey.localeCompare(right.pairKey)),
  };
}
