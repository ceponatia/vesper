import { ADULT_ELIGIBILITY_ANCHOR_ID } from "./declaration";
import type { AdultEligibilityParticipantEntity, AdultEligibilityVerdict } from "./contact-adapter";

/**
 * Blocked-action routing (eligibility follow-ups; UI wiring is romantic-contact
 * slice 3's) — the pure half of "a blocked romantic action links the editor
 * that can fix it".
 *
 * The routing law:
 * - a failing PERSONA links the persona editor (the viewer always owns it);
 * - a failing OWNED character links the character editor;
 * - a failing FOREIGN character cannot be edited, so the blocker offers
 *   **"Duplicate to edit"** — the existing copy-on-use clone flow, after which
 *   the copy's editor is the fix surface.
 *
 * Every target carries {@link ADULT_ELIGIBILITY_ANCHOR_ID} so the editor can
 * scroll straight to the declaration field. A verdict with no entity descriptor
 * yields no target — a synthetic subject has no editor, and inventing a link
 * would 404.
 */

export const adultEligibilityEditorTargets = ["persona-editor", "character-editor", "duplicate-character"] as const;
export type AdultEligibilityEditorTarget = (typeof adultEligibilityEditorTargets)[number];

export interface AdultEligibilityBlockerLink {
  readonly target: AdultEligibilityEditorTarget;
  readonly entityId: string;
  /** The in-editor anchor for the declaration field. */
  readonly anchorId: string;
  /** The CTA label the blocker renders. */
  readonly label: string;
}

/** The editor (or clone flow) that can fix one participant's eligibility. */
export function adultEligibilityEditorTarget(
  entity: AdultEligibilityParticipantEntity | undefined,
): AdultEligibilityBlockerLink | undefined {
  if (entity === undefined) return undefined;
  if (entity.kind === "persona") {
    return { target: "persona-editor", entityId: entity.entityId, anchorId: ADULT_ELIGIBILITY_ANCHOR_ID, label: "Edit persona" };
  }
  if (entity.foreign === true) {
    return {
      target: "duplicate-character",
      entityId: entity.entityId,
      anchorId: ADULT_ELIGIBILITY_ANCHOR_ID,
      label: "Duplicate to edit",
    };
  }
  return { target: "character-editor", entityId: entity.entityId, anchorId: ADULT_ELIGIBILITY_ANCHOR_ID, label: "Edit character" };
}

/**
 * The blocker links for a failed read: one per participant that is not
 * positively eligible (both `ineligible` and `unresolved` block a gated
 * action, so both get a fix link), in participant order, deduplicated by
 * entity so a self-contact never renders the same editor twice.
 */
export function adultEligibilityBlockerLinks(
  verdicts: readonly AdultEligibilityVerdict[],
): readonly AdultEligibilityBlockerLink[] {
  const seen = new Set<string>();
  return verdicts.flatMap((verdict) => {
    if (verdict.result === "eligible") return [];
    const link = adultEligibilityEditorTarget(verdict.entity);
    if (link === undefined) return [];
    const key = `${link.target}:${link.entityId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [link];
  });
}
