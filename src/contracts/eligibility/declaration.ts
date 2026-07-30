import { z } from "zod";

/**
 * The adult-eligibility declaration (adult-eligibility.plan.md; owner ruling
 * 2026-07-30, romantic-contact-affordances.audit.md §"Owner decisions needed" 1).
 *
 * An explicit, authored statement about a **fictional participant** — a library
 * character or the player's persona — that is independent of any written age.
 * It exists because the repo's only age gate is a negative fence that fails
 * open: `isMinorAge` reads a blank age, "ancient", "seventeen" and a
 * fantasy-scaled "312" all as adult, and the player persona carries no age at
 * all. Romantic and intimate contact need a POSITIVE answer, and a field whose
 * absence means "we could not ask" is the only shape that can carry one.
 *
 * **One schema, defined once, imported everywhere it is stored.** Both
 * `characterProfileObjectSchema` (world/profile.ts) and `personaProfileSchema`
 * (players/persona-profile.ts) hold this exact schema under
 * `adultEligibilityDeclaration`, so the two record kinds can never drift into
 * separate vocabularies.
 *
 * `.catch("unresolved").default("unresolved")` is the whole no-migration story:
 * every row stored before this field existed, and every row whose value is
 * corrupt, reads `unresolved` — the fail-closed value — with no backfill and no
 * schema change (both profiles ride JSONB `profile` columns).
 *
 * This is deliberately **not** an attribute registry entry. Attributes are
 * model-generated, visually inferred, default-filled, and read by unrelated
 * consumers (the portrait studio, the appearance summarizer); this is
 * policy-grade authorial metadata that only a human may set.
 */
export const adultEligibilityDeclarations = ["adult", "minor", "unresolved"] as const;
export type AdultEligibilityDeclaration = (typeof adultEligibilityDeclarations)[number];

/** The stored vocabulary. Missing or malformed ⇒ `unresolved`, never `adult`. */
export const adultEligibilityDeclarationSchema = z
  .enum(adultEligibilityDeclarations)
  .catch("unresolved")
  .default("unresolved");

/** The value every un-declared record reads — the fail-closed default. */
export const DEFAULT_ADULT_ELIGIBILITY_DECLARATION: AdultEligibilityDeclaration = "unresolved";

/** Reader-facing labels for the two authoring surfaces (character + persona editors). */
export const ADULT_ELIGIBILITY_DECLARATION_LABELS: Readonly<Record<AdultEligibilityDeclaration, string>> = {
  unresolved: "Not stated",
  adult: "An adult",
  minor: "A minor",
};

/** Display order for the editors — the default first, so the control opens on it. */
export const ADULT_ELIGIBILITY_DECLARATION_OPTIONS: readonly AdultEligibilityDeclaration[] = [
  "unresolved",
  "adult",
  "minor",
];

/**
 * The stable anchor a future deep link targets (romantic-contact slice 3's
 * "blocked romantic action takes you to the setting" affordance). Both editors
 * mark their declaration control with this DOM id; nothing links to it yet.
 */
export const ADULT_ELIGIBILITY_ANCHOR_ID = "adult-eligibility-declaration";
