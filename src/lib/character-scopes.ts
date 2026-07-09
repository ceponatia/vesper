import { z } from "zod";
import { diag, isPersonalityAttributeId, type DiagnosticSink } from "@/contracts";
import { isPlaceholderName, type FillableDraft } from "./character-fill";

/**
 * Per-tab Re-draft scopes (character-sheet-forge.plan.md): the five content
 * tabs of the character sheet, each re-draftable from the whole sheet. Unlike
 * the sheet Forge's fill (additive-only), a Re-draft REWRITES its own tab's
 * fields — narrator-formatted, content moved into its right field — with one
 * mechanical guarantee: `manual`-provenance attribute/trait values survive,
 * and a re-draft that disagreed with one is reported, not applied.
 *
 * Scope ids intentionally match the editor's content-tab ids.
 */
export const characterSheetScopes = ["profile", "attributes", "personality", "disposition", "outfit"] as const;
export const characterSheetScopeSchema = z.enum(characterSheetScopes);
export type CharacterSheetScope = z.infer<typeof characterSheetScopeSchema>;

const formatValue = (value: unknown): string => (Array.isArray(value) ? value.join("+") : String(value));

/**
 * Rebuild a provenance list from the re-draft's output while every
 * player-set (`manual`) value survives: a conflicting suggestion is replaced
 * by the player's value (with a kept-your-value diagnostic), an omitted one is
 * reinstated, and AI-owned (`creation`) values the re-draft dropped stay
 * dropped — the re-draft owns those.
 */
function reinstateManual<T extends { id: string; value: unknown; source: string }>(
  base: readonly T[],
  incoming: readonly T[],
  sink: DiagnosticSink | undefined,
  code: string,
): T[] {
  const manualById = new Map(base.filter((v) => v.source === "manual").map((v) => [v.id, v]));
  const out: T[] = [];
  for (const value of incoming) {
    const kept = manualById.get(value.id);
    if (!kept) {
      out.push(value);
      continue;
    }
    manualById.delete(value.id);
    if (JSON.stringify(kept.value) !== JSON.stringify(value.value)) {
      sink?.push(
        diag("info", code, `kept your ${value.id} = ${formatValue(kept.value)} (re-draft suggested ${formatValue(value.value)})`, {
          context: { id: value.id, kept: kept.value, suggested: value.value },
        }),
      );
    }
    out.push(kept);
  }
  return [...out, ...manualById.values()];
}

/**
 * Take a re-drafted scope's fields from `incoming` onto `base`, leaving every
 * other tab untouched. Shared verbatim by the server (authoritative, with a
 * diagnostic sink) and the client (re-applied over the response so edits made
 * mid-flight win).
 */
export function mergeRedraftScope<T extends FillableDraft>(
  base: T,
  incoming: FillableDraft,
  scope: CharacterSheetScope,
  sink?: DiagnosticSink,
): T {
  const code = `forge.character.redraft.${scope}.kept_manual`;
  switch (scope) {
    case "profile":
      return {
        ...base,
        name: isPlaceholderName(base.name) && incoming.name.trim() !== "" ? incoming.name : base.name,
        tags: incoming.tags,
        profile: {
          ...base.profile,
          bio: incoming.profile.bio,
          personality: incoming.profile.personality,
          voice: incoming.profile.voice,
          age: incoming.profile.age,
          aliases: incoming.profile.aliases,
        },
      };
    case "disposition":
      return {
        ...base,
        profile: {
          ...base.profile,
          tags: incoming.profile.tags,
          preferences: incoming.profile.preferences,
          traits: reinstateManual(base.profile.traits, incoming.profile.traits, sink, code),
        },
      };
    case "attributes": {
      const kept = base.profile.attributes.filter((a) => isPersonalityAttributeId(a.id));
      const body = reinstateManual(
        base.profile.attributes.filter((a) => !isPersonalityAttributeId(a.id)),
        incoming.profile.attributes.filter((a) => !isPersonalityAttributeId(a.id)),
        sink,
        code,
      );
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
      const personality = reinstateManual(
        base.profile.attributes.filter((a) => isPersonalityAttributeId(a.id)),
        incoming.profile.attributes.filter((a) => isPersonalityAttributeId(a.id)),
        sink,
        code,
      );
      return { ...base, profile: { ...base.profile, attributes: [...kept, ...personality] } };
    }
    case "outfit":
      return {
        ...base,
        suggestedItems: incoming.suggestedItems,
        profile: { ...base.profile, defaultOutfit: incoming.profile.defaultOutfit },
      };
  }
}
