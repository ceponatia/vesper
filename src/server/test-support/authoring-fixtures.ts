import type { AttributeValue } from "@/contracts";
import { emptyCharacterDraft, type CharacterDraft } from "../authoring/drafts";
import type { ClothingCandidateLookup, LibraryLookup } from "../authoring/library";
import { attr } from "./profile-fixtures";

/**
 * The scaffolding the authoring (forge / fill / redraft / portrait) suites share.
 *
 * Four suites each re-declared the same three or four helpers byte-for-byte: the
 * two empty library lookups the keyless demo path needs, a draft builder, and a
 * manually-authored attribute. Nothing here is a behaviour stub — the demo path
 * is exercised for real; these only remove the copies.
 *
 * `drafts` / `library` are imported by RELATIVE path because `@/server/authoring`
 * is the module under test in those suites: reaching them through the barrel
 * would pull the whole authoring surface into a file that wanted two types.
 */

/** A library that owns nothing — every forged garment stays a suggestion. */
export const noLibrary: LibraryLookup = async () => [];

/** No reuse candidates — the outfit leg always drafts fresh garments. */
export const noCandidates: ClothingCandidateLookup = async () => [];

/**
 * A blank draft with `mutate` applied. Mutation in place is deliberate: the
 * suites author nested profile fields (`d.profile.outfits = …`), and a spread
 * would silently drop the schema defaults underneath them.
 */
export function draftWith(mutate: (draft: CharacterDraft) => void): CharacterDraft {
  const draft = emptyCharacterDraft();
  mutate(draft);
  return draft;
}

/**
 * An attribute the USER authored. `source: "manual"` is the load-bearing half —
 * it is what the fill path must never overwrite and what the re-draft path is
 * allowed to revise (ruling 1), so these tests assert on it constantly.
 */
export function manualAttr(id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue {
  return attr(id, value, "manual");
}
