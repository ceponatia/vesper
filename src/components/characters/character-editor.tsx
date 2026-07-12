"use client";

import { useState } from "react";
import {
  heritageFor,
  heritagesForSpecies,
  isPersonalityAttributeId,
  speciesById,
  speciesCatalog,
  type Diagnostic,
} from "@/contracts";
import type { CharacterDraft, CharacterForgeSection, CharacterSheetScope } from "@/lib/client/api";
import { wearerHintForGender } from "@/lib/clothing-slots";
import { resolveChatModelId } from "@/lib/narrative-models";
import { DiagnosticList } from "@/components/forge/diagnostic-list";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SocialCardsEditor } from "@/components/personality/social-cards-editor";
import { AttributePicker } from "./attribute-picker";
import { seedRequiredAttributes } from "./attribute-helpers";
import { CharacterChat } from "./character-chat";
import { DispositionEditor } from "./disposition-editor";
import { OutfitEditor } from "./outfit-editor";
import { PortraitStudio } from "./portrait-studio";
import { PreferencesEditor } from "./preferences-editor";

type EditorTab = "profile" | "attributes" | "personality" | "disposition" | "outfit" | "portrait" | "chat";

/** The presented-gender attribute value, when set (drives the outfit picker's wearer default). */
function genderValue(attributes: readonly { id: string; value: unknown }[]): string | undefined {
  const value = attributes.find((a) => a.id === "identity.gender")?.value;
  return typeof value === "string" ? value : undefined;
}


export interface CharacterEditorProps {
  draft: CharacterDraft;
  onChange: (next: CharacterDraft) => void;
  /** Forge mode shows per-section regenerate buttons (docs/authoring.md). */
  onRegenerate?: (section: CharacterForgeSection) => void;
  regenerating?: CharacterForgeSection | null;
  /** Edit mode shows per-tab Re-draft buttons (character-sheet-forge.plan.md). */
  onRedraft?: (scope: CharacterSheetScope) => void;
  redrafting?: CharacterSheetScope | null;
  /** Portrait → attributes (Attributes tab, needs a ready avatar). */
  onPortraitAttributes?: () => void;
  derivingPortrait?: boolean;
  /** Saved characters get the portrait studio; drafts don't exist yet. */
  characterId?: string;
  avatarImageId?: string | null;
  onAvatarChanged?: () => void;
  diagnostics?: readonly Diagnostic[];
  /**
   * The owner's persisted chat-tab narrator pick + a setter that saves it. Held by the
   * page (not here) so it survives the chat tab unmounting on a tab switch; the forge
   * page omits both — it never shows the chat tab (no `characterId`).
   */
  chatModel?: string;
  onChatModelChange?: (modelId: string) => void;
}

/** The character form — the forge review UI *is* the editor (docs/authoring.md). */
export function CharacterEditor({
  draft,
  onChange,
  onRegenerate,
  regenerating = null,
  onRedraft,
  redrafting = null,
  onPortraitAttributes,
  derivingPortrait = false,
  characterId,
  avatarImageId = null,
  onAvatarChanged,
  diagnostics = [],
  chatModel,
  onChatModelChange,
}: CharacterEditorProps) {
  const [tab, setTab] = useState<EditorTab>("profile");

  const personalityCount = draft.profile.attributes.filter((a) => isPersonalityAttributeId(a.id)).length;
  const tabs: TabDef<EditorTab>[] = [
    { id: "profile", label: "Profile" },
    {
      id: "attributes",
      label: "Attributes",
      badge: draft.profile.attributes.length - personalityCount || undefined,
    },
    {
      id: "personality",
      label: "Personality",
      badge: personalityCount + draft.profile.preferences.length + draft.profile.socialCards.length || undefined,
    },
    {
      id: "disposition",
      label: "Disposition",
      badge: draft.profile.traits.length + draft.profile.tags.length || undefined,
    },
    {
      id: "outfit",
      label: "Outfit",
      badge: draft.profile.defaultOutfit.length + draft.suggestedItems.length || undefined,
    },
    { id: "portrait", label: "Portrait studio" },
    { id: "chat", label: "Chat" },
  ];

  const patchProfile = (patch: Partial<CharacterDraft["profile"]>) =>
    onChange({ ...draft, profile: { ...draft.profile, ...patch } });
  const setSpecies = (speciesId: string) => {
    const species = speciesById(speciesId);
    if (!species) return;
    // A heritage belongs to one species, so changing species clears it and the
    // feature config resets to the (bare) species defaults.
    const bodyFeatures = species.defaultFeatureGroups ? [...species.defaultFeatureGroups] : undefined;
    patchProfile({
      speciesId: species.id,
      heritageId: undefined,
      bodyPlanId: species.bodyPlanId,
      bodyFeatures,
      attributes: seedRequiredAttributes(draft.profile.attributes, {
        speciesId: species.id,
        bodyPlanId: species.bodyPlanId,
        intimateRegions: draft.profile.intimateRegions,
        bodyFeatures,
      }),
    });
  };
  const setHeritage = (heritageId: string) => {
    const species = speciesById(draft.profile.speciesId);
    if (!species) return;
    const heritage = heritageFor(species.id, heritageId);
    const groups = [...(species.defaultFeatureGroups ?? []), ...(heritage?.defaultFeatureGroups ?? [])];
    const bodyFeatures = groups.length > 0 ? [...new Set(groups)] : undefined;
    patchProfile({
      heritageId: heritage?.id,
      bodyFeatures,
      attributes: seedRequiredAttributes(draft.profile.attributes, {
        speciesId: species.id,
        heritageId: heritage?.id,
        bodyPlanId: draft.profile.bodyPlanId,
        intimateRegions: draft.profile.intimateRegions,
        bodyFeatures,
      }),
    });
  };
  const heritages = heritagesForSpecies(draft.profile.speciesId);

  const sectionFor: Partial<Record<EditorTab, CharacterForgeSection>> = {
    profile: "profile",
    attributes: "attributes",
    outfit: "outfit",
  };
  const section = sectionFor[tab];
  // Every content tab is re-draftable; scope ids match tab ids by design.
  const scopeFor: Partial<Record<EditorTab, CharacterSheetScope>> = {
    profile: "profile",
    attributes: "attributes",
    personality: "personality",
    disposition: "disposition",
    outfit: "outfit",
  };
  const scope = scopeFor[tab];

  return (
    <div className="flex flex-col gap-5">
      <DiagnosticList diagnostics={diagnostics} />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <Tabs tabs={tabs} value={tab} onChange={setTab} className="min-w-0 flex-1" />
        {onRegenerate && section ? (
          <Button
            size="sm"
            onClick={() => onRegenerate(section)}
            busy={regenerating === section}
            disabled={regenerating !== null && regenerating !== section}
            className="self-start sm:mb-1 sm:self-auto"
          >
            ↻ Regenerate {section}
          </Button>
        ) : null}
        {onPortraitAttributes && tab === "attributes" && avatarImageId ? (
          <Button
            size="sm"
            onClick={onPortraitAttributes}
            busy={derivingPortrait}
            disabled={redrafting !== null}
            className="self-start sm:mb-1 sm:self-auto"
            title="Read the portrait and fill in appearance attributes it clearly shows — never changes values already set (disagreements are reported)."
          >
            ◉ From portrait
          </Button>
        ) : null}
        {onRedraft && scope ? (
          <Button
            size="sm"
            onClick={() => onRedraft(scope)}
            busy={redrafting === scope}
            disabled={(redrafting !== null && redrafting !== scope) || derivingPortrait}
            className="self-start sm:mb-1 sm:self-auto"
            title="Rewrite this tab from the whole sheet, formatted for the narrator. Text fields are rewritten; attribute and trait values you set yourself are kept."
          >
            ↻ Re-draft tab
          </Button>
        ) : null}
      </div>

      {tab === "profile" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-1">
            {(id) => (
              <Input id={id} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
            )}
          </Field>
          <Field label="Tags">
            {(id) => <TagInput id={id} value={draft.tags} onChange={(tags) => onChange({ ...draft, tags })} placeholder="harbor, dry humor…" />}
          </Field>
          <Field label="Species">
            {(id) => (
              <Select
                id={id}
                value={speciesById(draft.profile.speciesId)?.id ?? "human"}
                onChange={(e) => setSpecies(e.target.value)}
              >
                {speciesCatalog.map((species) => (
                  <option key={species.id} value={species.id}>
                    {species.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {heritages.length > 0 ? (
            <Field label="Heritage" hint="A sub-group within the species.">
              {(id) => (
                <Select id={id} value={draft.profile.heritageId ?? ""} onChange={(e) => setHeritage(e.target.value)}>
                  <option value="">— None —</option>
                  {heritages.map((heritage) => (
                    <option key={heritage.id} value={heritage.id}>
                      {heritage.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Field
            label="Age"
            hint="Real/chronological age — a number, or e.g. “ancient” / “312 years”. Distinct from the look (Attributes → Apparent age)."
          >
            {(id) => (
              <Input id={id} value={draft.profile.age} onChange={(e) => patchProfile({ age: e.target.value })} />
            )}
          </Field>
          <Field label="Bio" className="sm:col-span-2">
            {(id) => (
              <Textarea id={id} rows={5} value={draft.profile.bio} onChange={(e) => patchProfile({ bio: e.target.value })} />
            )}
          </Field>
          <Field label="Personality" className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                rows={4}
                value={draft.profile.personality}
                onChange={(e) => patchProfile({ personality: e.target.value })}
              />
            )}
          </Field>
          <Field label="Voice notes" hint="How they sound on the page." className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={draft.profile.voice ?? ""}
                onChange={(e) => patchProfile({ voice: e.target.value || undefined })}
              />
            )}
          </Field>
          <Field label="Aliases" hint="Other names the narrative may use.">
            {(id) => <TagInput id={id} value={draft.profile.aliases} onChange={(aliases) => patchProfile({ aliases })} />}
          </Field>
        </div>
      ) : null}

      {tab === "attributes" ? (
        <AttributePicker
          scope="body"
          values={draft.profile.attributes}
          onChange={(attributes) => patchProfile({ attributes })}
          intimateRegions={draft.profile.intimateRegions ?? []}
          onChangeIntimateRegions={(intimateRegions) => patchProfile({ intimateRegions })}
          bodyFeatures={draft.profile.bodyFeatures}
          onChangeBodyFeatures={(bodyFeatures) => patchProfile({ bodyFeatures })}
          speciesId={draft.profile.speciesId}
          heritageId={draft.profile.heritageId}
          bodyPlanId={draft.profile.bodyPlanId}
        />
      ) : null}

      {tab === "personality" ? (
        <div className="flex flex-col gap-6">
          <AttributePicker
            scope="personality"
            values={draft.profile.attributes}
            onChange={(attributes) => patchProfile({ attributes })}
            speciesId={draft.profile.speciesId}
            heritageId={draft.profile.heritageId}
            bodyPlanId={draft.profile.bodyPlanId}
          />
          <PreferencesEditor
            preferences={draft.profile.preferences}
            onChange={(preferences) => patchProfile({ preferences })}
          />
          <SocialCardsEditor
            cards={draft.profile.socialCards}
            onChange={(socialCards) => patchProfile({ socialCards })}
            hint="This character's own taboos and rules — they apply in 1-on-1 chat and take precedence over a world's cards in a session."
            emptyText="No personal cards. Add one to give this character lines that travel with them into any world."
          />
        </div>
      ) : null}

      {tab === "disposition" ? (
        <DispositionEditor
          traits={draft.profile.traits}
          onChangeTraits={(traits) => patchProfile({ traits })}
          tags={draft.profile.tags}
          onChangeTags={(tags) => patchProfile({ tags })}
        />
      ) : null}

      {tab === "outfit" ? (
        <OutfitEditor
          outfit={draft.profile.defaultOutfit}
          onChange={(defaultOutfit) => patchProfile({ defaultOutfit })}
          suggestedItems={draft.suggestedItems}
          onChangeSuggested={(suggestedItems) => onChange({ ...draft, suggestedItems })}
          wearerHint={wearerHintForGender(genderValue(draft.profile.attributes))}
        />
      ) : null}

      {tab === "portrait" ? (
        characterId ? (
          <PortraitStudio
            characterId={characterId}
            name={draft.name || "Untitled"}
            avatarImageId={avatarImageId}
            onAvatarChanged={onAvatarChanged ?? (() => {})}
          />
        ) : (
          <p className="rounded-card border border-dashed border-ink-600 px-4 py-8 text-center text-sm text-paper-500">
            Save the character first — the avatar pipeline runs from saved attributes.
          </p>
        )
      ) : null}

      {tab === "chat" ? (
        characterId ? (
          // The tab is a summary surface (defaults + conversation list) — playing happens
          // on /chat/[chatId]. Starting Relationship writes back into the draft here; the
          // editor SaveBar persists it to the profile.
          <CharacterChat
            characterId={characterId}
            name={draft.name || "Untitled"}
            starting={draft.profile.playerRelationship}
            onStartingChange={(next) => patchProfile({ playerRelationship: next })}
            chatModel={resolveChatModelId(chatModel)}
            onChatModelChange={onChatModelChange ?? (() => undefined)}
          />
        ) : (
          <p className="rounded-card border border-dashed border-ink-600 px-4 py-8 text-center text-sm text-paper-500">
            Save the character first — chat speaks from the saved profile and attributes.
          </p>
        )
      ) : null}
    </div>
  );
}
