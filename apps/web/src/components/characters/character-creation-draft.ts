import { z } from "zod";
import { attributeRegistry, boundCharacterCreationBrief, traitRegistry } from "@/contracts";
import { characterEditorTabs } from "@/lib/character-scopes";
import { characterDraftSchema, emptyCharacterDraft, type CharacterDetail, type CharacterDraft } from "@/lib/client/api";
import { authorSnapshotFromDetail, characterAuthorSnapshotSchema } from "./character-author-draft";
import { characterReviewStateSchema, describeProposalValue, emptyCharacterReview, proposalChanges } from "./character-proposals";

export const characterCreationStateSchema = z.object({
  id: z.string(),
  savedCharacterId: z.string().nullable().default(null),
  initialSaveDraft: characterDraftSchema.nullable().default(null),
  serverSnapshot: characterAuthorSnapshotSchema.nullable().default(null),
  serverUpdatedAt: z.string().nullable().default(null),
  serverConflict: z.object({
    snapshot: characterAuthorSnapshotSchema,
    updatedAt: z.string().nullable(),
    reason: z.enum(["saved_change", "creation_mismatch"]).optional(),
  }).nullable().default(null),
  saveDestination: z.enum(characterEditorTabs).nullable().default(null),
  materializingDraft: characterDraftSchema.nullable().default(null),
  draft: characterDraftSchema,
  prompt: z.string(),
  tab: z.enum(characterEditorTabs).catch("profile"),
  review: characterReviewStateSchema,
});
export type CharacterCreationState = z.infer<typeof characterCreationStateSchema>;
export const emptyCharacterCreation = (): CharacterCreationState => ({ id: crypto.randomUUID(), savedCharacterId: null, initialSaveDraft: null, serverSnapshot: null, serverUpdatedAt: null, serverConflict: null, saveDestination: null, materializingDraft: null, draft: emptyCharacterDraft(), prompt: "", tab: "profile", review: emptyCharacterReview() });

/** Capture the original concept before any rewriting can remove it. This also
 * covers manually authored and legacy saved characters with no prompt history. */
function excerpt(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const marker = " […] ";
  const head = Math.floor((limit - marker.length) * 0.75);
  return text.slice(0, head).trimEnd() + marker + text.slice(-(limit - marker.length - head)).trimStart();
}

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

/** Initial Forge can use the editable preview as review, but only for a truly
 * untouched draft. Brief capture itself is not an authored field change. */
export function isPristineCharacterDraft(draft: CharacterDraft): boolean {
  return JSON.stringify({ ...draft, profile: { ...draft.profile, creationBrief: "" } }) === JSON.stringify(emptyCharacterDraft());
}

/** Commit the original request context only after a successful full Forge. The
 * editable first preview is safe only while the author has not changed its input. */
export function creationForgeStart(state: CharacterCreationState) {
  return { draft: structuredClone(state.draft), prompt: state.prompt, initialPreview: isPristineCharacterDraft(state.draft) && !state.review.pending.length && !state.savedCharacterId };
}

export function completeCreationForge(current: CharacterCreationState, started: ReturnType<typeof creationForgeStart>, base: CharacterDraft, proposed: CharacterDraft, proposalId: string): CharacterCreationState {
  const proposal = { id: proposalId, label: "forged character", base, proposed, undo: false };
  const hasChanges = proposalChanges(proposal).length > 0;
  // An empty first response has established no character to preserve. Keep the
  // original prompt editable so the author can refine it and retry.
  if (!hasChanges && started.initialPreview && !started.draft.profile.creationBrief) return current;
  const draft = { ...current.draft, profile: { ...current.draft.profile, creationBrief: current.draft.profile.creationBrief || base.profile.creationBrief } };
  const result = { ...proposed, profile: { ...proposed.profile, creationBrief: draft.profile.creationBrief } };
  const initialPreview = started.initialPreview
    && JSON.stringify(current.draft) === JSON.stringify(started.draft) && current.prompt === started.prompt;
  if (initialPreview) return { ...current, draft: result };
  return { ...current, draft, review: hasChanges ? { ...current.review, pending: [...current.review.pending, { ...proposal, proposed: result }] } : current.review };
}

export function savedCreationHref(state: CharacterCreationState): string | null {
  return state.savedCharacterId ? `/characters/${state.savedCharacterId}?tab=${state.saveDestination ?? state.tab}` : null;
}

/** Bind a retained local draft to the character already committed under its
 * request UUID. The original receipt is the three-way base and the current
 * owner-scoped row is the server side; authored values stay untouched until
 * the author explicitly reviews them. */
export function recoverCreationMismatch(
  current: CharacterCreationState,
  created: CharacterDetail,
  character: CharacterDetail,
): CharacterCreationState {
  return {
    ...current,
    savedCharacterId: character.id,
    initialSaveDraft: null,
    materializingDraft: null,
    serverSnapshot: authorSnapshotFromDetail(created),
    serverUpdatedAt: character.updatedAt,
    serverConflict: {
      snapshot: authorSnapshotFromDetail(character),
      updatedAt: character.updatedAt,
      reason: "creation_mismatch",
    },
  };
}


/** Each deliberate Save owns its destination. The first POST payload stays frozen
 * until its idempotent response is known; author edits after that are a later PATCH. */
export function prepareCreationSave(current: CharacterCreationState, destination: "portrait" | "chat" | null): CharacterCreationState {
  return { ...current, saveDestination: destination,
    initialSaveDraft: current.savedCharacterId ? current.initialSaveDraft : current.initialSaveDraft ?? withCreationBrief(structuredClone(current.draft), current.prompt) };
}
