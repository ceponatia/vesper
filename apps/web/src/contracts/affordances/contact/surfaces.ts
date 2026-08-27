import { z } from "zod";
import { bodyLocationRegistry } from "../../body/locations";
import { affordanceSubjectIdSchema, type AffordanceSubjectId } from "../core";
import {
  CONTACT_KEY_FIELD_SEPARATOR,
  contactEntityIdSchema,
  contactPairKeyOf,
  type ContactEntityId,
} from "./identity";

/**
 * What is touching what — the two ends of a contact.
 *
 * The vocabulary is REUSED, never re-invented: a body end names a location from
 * `bodyLocationRegistry`, the same tree wardrobe coverage, image prompts, and the
 * hair domain address. The contact layer owns none of its source facts, and a
 * parallel body-part vocabulary would be the fastest way to break that.
 *
 * `detail` is the one deliberate hole: the foot domain wants an arch and a heel
 * pad that the registry does not carry, and the intimate domain wants a
 * subregion and a side. The core takes the detail as an OPAQUE token it stores,
 * keys, and hands back — it never parses one, so a domain can name its own
 * sub-surfaces without the core learning any anatomy.
 */

export const contactSurfaceSides = ["left", "right", "center"] as const;
export const contactSurfaceSideSchema = z.enum(contactSurfaceSides);
export type ContactSurfaceSide = z.infer<typeof contactSurfaceSideSchema>;

const surfaceTokenSchema = z.string().trim().min(1).max(64);

/** One end of a contact on a character's body. */
export const contactBodySurfaceRefSchema = z.object({
  kind: z.literal("body"),
  subjectId: affordanceSubjectIdSchema,
  /** A `bodyLocationRegistry` id. Validated at the resolver, not here. */
  locationId: surfaceTokenSchema,
  side: contactSurfaceSideSchema.optional(),
  /** Domain-owned sub-surface token (`arch`, `heel_pad`). Opaque to the core. */
  detail: surfaceTokenSchema.optional(),
});
export type ContactBodySurfaceRef = z.infer<typeof contactBodySurfaceRefSchema>;

/**
 * One end of a contact on something that is not a body — furniture, a wall, the
 * floor. Modelled now though the foot trial only needs body↔body, because a foot
 * braced against a wall is the same lifecycle with a different target and the
 * alternative is a second, divergent contact type later.
 */
export const contactObjectSurfaceRefSchema = z.object({
  kind: z.literal("object"),
  entityId: contactEntityIdSchema,
  surfaceId: surfaceTokenSchema,
});
export type ContactObjectSurfaceRef = z.infer<typeof contactObjectSurfaceRefSchema>;

export const contactSurfaceRefSchema = z.discriminatedUnion("kind", [
  contactBodySurfaceRefSchema,
  contactObjectSurfaceRefSchema,
]);
export type ContactSurfaceRef = z.infer<typeof contactSurfaceRefSchema>;

/**
 * Is this a location the shared body tree knows?
 *
 * Registry MEMBERSHIP only. Whether a given character has actually realized the
 * location — the intimate subtrees are switched on per body config
 * (`species/realize.ts`) — is a question about one character, so it belongs to
 * the domain that knows which character it is reading, not to the shared core.
 */
export function isKnownContactBodyLocation(locationId: string): boolean {
  return bodyLocationRegistry.byId(locationId) !== undefined;
}

/** The stable key for one surface. Identity only — never shown to anyone. */
export function contactSurfaceKey(ref: ContactSurfaceRef): string {
  const parts: readonly string[] =
    ref.kind === "body"
      ? ["body", ref.subjectId, ref.locationId, ref.side ?? "", ref.detail ?? ""]
      : ["object", ref.entityId, ref.surfaceId];
  return parts.join(CONTACT_KEY_FIELD_SEPARATOR);
}

/** Two surfaces name the same place. */
export function contactSurfacesEqual(left: ContactSurfaceRef, right: ContactSurfaceRef): boolean {
  return contactSurfaceKey(left) === contactSurfaceKey(right);
}

/** The order-independent projection key for a pair of surfaces. */
export function contactPairKey(source: ContactSurfaceRef, target: ContactSurfaceRef): string {
  return contactPairKeyOf(contactSurfaceKey(source), contactSurfaceKey(target));
}

/** Every character taking part in a contact between these two surfaces, in source-first order. */
export function contactParticipantIds(
  source: ContactSurfaceRef,
  target: ContactSurfaceRef,
): readonly AffordanceSubjectId[] {
  const ids: AffordanceSubjectId[] = [];
  for (const ref of [source, target]) {
    if (ref.kind !== "body") continue;
    if (!ids.includes(ref.subjectId)) ids.push(ref.subjectId);
  }
  return ids;
}

/** The non-character owner of a surface, when there is one. */
export function contactSurfaceEntityId(ref: ContactSurfaceRef): ContactEntityId | undefined {
  return ref.kind === "object" ? ref.entityId : undefined;
}

/** True when both ends belong to bodies — the case that needs control and permission. */
export function isInterpersonalContact(source: ContactSurfaceRef, target: ContactSurfaceRef): boolean {
  return source.kind === "body" && target.kind === "body" && source.subjectId !== target.subjectId;
}
