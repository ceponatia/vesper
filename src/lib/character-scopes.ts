import { z } from "zod";
import { isPersonalityAttributeId } from "@/contracts";
import type { FillableDraft } from "./character-fill";

/**
 * Per-tab Re-draft scopes (character-sheet-forge.plan.md; semantics re-ruled
 * 2026-07-12 — multi-character-chat.followups.md ruling 1): the five content
 * tabs of the character sheet, each re-draftable from the whole sheet. Unlike
 * the sheet Forge's fill (additive-only), a Re-draft is a FULL re-sync of its
 * tab — the tool for "I changed the other tabs; bring this one in line" — so
 * it may revise player-set values too; the unsaved-draft review is the safety
 * net. Two scope limits stand: the Profile re-draft rewrites ONLY bio /
 * personality / voice (never name, age, aliases, or library tags), and
 * species / heritage / body-plan are untouchable everywhere (their cascade is
 * too destructive for a formatting pass).
 *
 * Scope ids intentionally match the editor's content-tab ids. One deliberate
 * mismatch: `disposition` still owns `preferences` (they ride the profile forge
 * leg with tags + traits) even though the editor shows likes/dislikes on the
 * Personality tab since 2026-07-11 — a Disposition re-draft re-derives them.
 * `disposition` also owns `drives` (desires & secrets, character-drives.plan.md)
 * — the editor card and the forge output both live on that tab's scope.
 */
export const characterSheetScopes = ["profile", "attributes", "personality", "disposition", "outfit"] as const;
export const characterSheetScopeSchema = z.enum(characterSheetScopes);
export type CharacterSheetScope = z.infer<typeof characterSheetScopeSchema>;

/**
 * Take a re-drafted scope's fields from `incoming` onto `base`, leaving every
 * other tab untouched. Shared verbatim by the server (authoritative) and the
 * client (re-applied over the response so edits made mid-flight win).
 */
export function mergeRedraftScope<T extends FillableDraft>(
  base: T,
  incoming: FillableDraft,
  scope: CharacterSheetScope,
): T {
  switch (scope) {
    case "profile":
      // Ruling 1: prose fields only — name/age/aliases/tags are not this tab's
      // re-sync surface (rename by hand; age is a fact, not formatting). The voice
      // micro-exemplars (character-fidelity slice 6) and structured voice anchors
      // (slice 7) ride this prose scope too.
      return {
        ...base,
        profile: {
          ...base.profile,
          bio: incoming.profile.bio,
          personality: incoming.profile.personality,
          voice: incoming.profile.voice,
          microExemplars: incoming.profile.microExemplars,
          voiceAnchors: incoming.profile.voiceAnchors,
        },
      };
    case "disposition":
      return {
        ...base,
        profile: {
          ...base.profile,
          tags: incoming.profile.tags,
          preferences: incoming.profile.preferences,
          traits: incoming.profile.traits,
          drives: incoming.profile.drives,
        },
      };
    case "attributes": {
      const kept = base.profile.attributes.filter((a) => isPersonalityAttributeId(a.id));
      const body = incoming.profile.attributes.filter((a) => !isPersonalityAttributeId(a.id));
      return {
        ...base,
        profile: {
          ...base.profile,
          attributes: [...body, ...kept],
          intimateRegions:
            base.profile.intimateRegions.length > 0 ? base.profile.intimateRegions : incoming.profile.intimateRegions,
        },
      };
    }
    case "personality": {
      const kept = base.profile.attributes.filter((a) => !isPersonalityAttributeId(a.id));
      const personality = incoming.profile.attributes.filter((a) => isPersonalityAttributeId(a.id));
      return { ...base, profile: { ...base.profile, attributes: [...kept, ...personality] } };
    }
    case "outfit":
      return {
        ...base,
        suggestedItems: incoming.suggestedItems,
        profile: { ...base.profile, outfits: incoming.profile.outfits },
      };
  }
}
