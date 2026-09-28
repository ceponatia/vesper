import { attributeRegistry, boundCharacterCreationBrief, traitRegistry } from "@/contracts";
import { type CharacterDraft } from "@/lib/client/api";
import { describeProposalValue } from "./character-proposals";

/** Capture the original concept before any rewriting can remove it. This also
 * covers manually authored and legacy saved characters with no prompt history. */
function excerpt(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const marker = " […] ";
  const head = Math.floor((limit - marker.length) * 0.75);
  return text.slice(0, head).trimEnd() + marker + text.slice(-(limit - marker.length - head)).trimStart();
}

/** Before the first AI action on a manual or legacy saved character, capture its
 * original authored details as the brief so later Fill/Re-draft have context to
 * work from. A prompt (from a Forge run) always wins over a manual capture. */
export function withCreationBrief(draft: CharacterDraft, prompt = ""): CharacterDraft {
  if (draft.profile.creationBrief.trim()) {
    const bounded = boundCharacterCreationBrief(draft.profile.creationBrief);
    return bounded === draft.profile.creationBrief ? draft : { ...draft, profile: { ...draft.profile, creationBrief: bounded } };
  }
  const profile = draft.profile;
  const priority = (id: typeof profile.attributes[number]["id"]) => {
    const definition = attributeRegistry.byId(id);
    return definition?.identityAnchor ? 0 : definition?.coreVisual ? 1 : definition?.renderVisual ? 2 : 3;
  };
  const appearance = [...profile.attributes].sort((a, b) => priority(a.id) - priority(b.id))
    .map((row) => `${attributeRegistry.byId(row.id)?.label ?? row.id}: ${excerpt(describeProposalValue(row.value), 72)}`).join("; ");
  const outfit = [
    ...draft.suggestedItems.map((item) => `${excerpt(item.name, 100)}: ${excerpt(item.description, 140)}`),
    ...profile.outfits.map((preset) => `${excerpt(preset.name, 100)}: ${preset.items.join(", ")}`),
  ].join("; ");
  // Reserve space for visual identity and clothing before prose. A long biography
  // cannot push eye/hair facts or the signature outfit out of the preserved brief.
  const sections: [string, string, number][] = [
    ["Identity", `Name: ${excerpt(draft.name, 120)}; Species: ${excerpt(profile.speciesId, 80)}; Heritage: ${excerpt(profile.heritageId ?? "", 80)}; Age: ${excerpt(profile.age, 80)}`, 400],
    ["Appearance", appearance, 900],
    ["Outfit", outfit, 650],
    ["Biography", profile.bio, 1000],
    ["Personality", profile.personality, 350],
    ["Voice", profile.voice ?? "", 200],
    ["Traits", profile.traits.map((row) => `${traitRegistry.byId(row.id)?.label ?? row.id}: ${row.value}`).join("; "), 200],
  ];
  const manual = "Original authored details\n" + sections.filter(([, value]) => value.trim()).map(([label, value, limit]) => `${label}: ${excerpt(value, limit)}`).join("\n");
  const brief = boundCharacterCreationBrief(prompt.trim() || manual);
  return { ...draft, profile: { ...profile, creationBrief: brief } };
}
