"use client";

import { useCallback, useId, useState } from "react";
import {
  emptyCharacterPortraitAcceptance,
  heritagesForSpecies,
  PLAYER_RELATIONSHIP_NOTE_MAX,
  speciesById,
  speciesCatalog,
  type CharacterPortraitAcceptance,
  type Diagnostic,
} from "@/contracts";
import type { CharacterDraft, CharacterSheetScope } from "@/lib/client/api";
import { characterSections, characterSheetScopes, characterSectionDetailCount, type CharacterEditorTab } from "@/lib/character-scopes";
export type { CharacterEditorTab } from "@/lib/character-scopes";
import { RelationshipRecordEditor } from "./relationship-record-editor";
import { wearerHintForGender } from "@/lib/clothing-slots";
import { resolveChatModelId } from "@/lib/narrative-models";
import { DiagnosticList } from "@/components/forge/diagnostic-list";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { RelationshipsEditor, type RelationshipSaveStatus } from "./relationships-editor";
import { Textarea } from "@/components/ui/textarea";
import { SocialCardsEditor } from "@/components/personality/social-cards-editor";
import { AttributePicker } from "./attribute-picker";
import { heritageChangePatch, speciesChangePatch } from "./attribute-helpers";
import { CharacterChat } from "./character-chat";
import { DispositionEditor } from "./disposition-editor";
import { DrivesEditor } from "./drives-editor";
import { MicroExemplarsEditor } from "./micro-exemplars-editor";
import { VoiceAnchorsEditor } from "./voice-anchors-editor";
import { OutfitEditor } from "./outfit-editor";
import { PortraitStudio } from "./portrait-studio";
import { PreferencesEditor } from "./preferences-editor";
import { ScheduleEditor } from "./schedule-editor";

/** The presented-gender attribute value, when set (drives the outfit picker's wearer default). */
function genderValue(attributes: readonly { id: string; value: unknown }[]): string | undefined {
  const value = attributes.find((a) => a.id === "identity.gender")?.value;
  return typeof value === "string" ? value : undefined;
}


export interface CharacterEditorProps {
  draft: CharacterDraft;
  tab?: CharacterEditorTab;
  onTabChange?: (tab: CharacterEditorTab) => void;
  onComplete?: (scope: CharacterSheetScope) => void;
  completing?: CharacterSheetScope | null;
  generationDisabled?: boolean;
  onSaveAndOpen?: (destination: "portrait" | "chat") => void;
  saving?: boolean;
  onChange: (next: CharacterDraft) => void;
  /** Edit mode shows per-tab Re-draft buttons. */
  onRedraft?: (scope: CharacterSheetScope) => void;
  redrafting?: CharacterSheetScope | null;
  /** Portrait → attributes (Attributes tab, needs a ready avatar). */
  onPortraitAttributes?: () => void;
  derivingPortrait?: boolean;
  /** Saved characters get the portrait studio; drafts don't exist yet. */
  characterId?: string;
  /** The portrait candidate on screen. */
  avatarImageId?: string | null;
  /** Which portrait is the character's identity source (owner read; absent ⇒ none). */
  acceptance?: CharacterPortraitAcceptance;
  onAvatarChanged?: () => void;
  diagnostics?: readonly Diagnostic[];
  /**
   * The page owns narrator selection and autosaves it with the character draft.
   * Unsaved characters show a save-and-open action on Chat.
   */
  chatModel?: string;
  onChatModelChange?: (modelId: string) => void;
}

/** The character form — the forge review UI *is* the editor (docs/authoring/manual-editing.md). */
export function CharacterEditor({
  draft,
  tab: controlledTab,
  onTabChange,
  onComplete,
  completing = null,
  generationDisabled = false,
  onSaveAndOpen,
  saving = false,
  onChange,
  onRedraft,
  redrafting = null,
  onPortraitAttributes,
  derivingPortrait = false,
  characterId,
  avatarImageId = null,
  acceptance = emptyCharacterPortraitAcceptance(),
  onAvatarChanged,
  diagnostics = [],
  chatModel,
  onChatModelChange,
}: CharacterEditorProps) {
  const [localTab, setLocalTab] = useState<CharacterEditorTab>("profile");
  const [relationshipSave, setRelationshipSave] = useState<{ characterId?: string; status: RelationshipSaveStatus }>({ status: "saved" });
  const onRelationshipSaveStatusChange = useCallback((status: RelationshipSaveStatus) => {
    setRelationshipSave((current) => current.characterId === characterId && current.status === status
      ? current : { characterId, status });
  }, [characterId]);
  const relationshipSaveStatus = relationshipSave.characterId === characterId ? relationshipSave.status : "saved";
  const tab = controlledTab ?? localTab;
  const setTab = (next: CharacterEditorTab) => {
    setLocalTab(next);
    onTabChange?.(next);
  };
  const panelPrefix = useId();
  const tabs: TabDef<CharacterEditorTab>[] = [
    ...characterSheetScopes.map((id) => ({
      id,
      label: characterSections[id].label,
      badge: characterSectionDetailCount(draft, id) || undefined,
    })),
    { id: "portrait", label: "Portrait studio" },
    { id: "chat", label: "Chat" },
  ];
  const scope = characterSheetScopes.find((id) => id === tab);
  const generationBusy = generationDisabled || redrafting !== null || completing !== null || derivingPortrait;

  const patchProfile = (patch: Partial<CharacterDraft["profile"]>) =>
    onChange({ ...draft, profile: { ...draft.profile, ...patch } });
  // Shared with the persona editor (attribute-helpers.ts): a species change clears the
  // heritage (a heritage belongs to one species), follows the body plan, resets features
  // to the species defaults, and re-seeds required attributes.
  const setSpecies = (speciesId: string) => {
    const patch = speciesChangePatch(draft.profile, speciesId);
    if (patch) patchProfile(patch);
  };
  const setHeritage = (heritageId: string) => {
    const patch = heritageChangePatch(draft.profile, heritageId);
    if (patch) patchProfile(patch);
  };
  const selectedSpecies = speciesById(draft.profile.speciesId);
  const heritages = heritagesForSpecies(draft.profile.speciesId);
  const selectedHeritageId =
    heritages.find((heritage) => heritage.id === draft.profile.heritageId)?.id ??
    selectedSpecies?.defaultHeritageId ??
    "";

  const hasVoiceAnchors = Boolean(
    draft.profile.voiceAnchors.cadence.trim()
    || draft.profile.voiceAnchors.petPhrases.some((phrase) => phrase.trim())
    || draft.profile.voiceAnchors.neverSays.some((phrase) => phrase.trim()),
  );
  const voiceSummary = [
    ...(draft.profile.microExemplars.length > 0
      ? [`${draft.profile.microExemplars.length} voice ${draft.profile.microExemplars.length === 1 ? "example" : "examples"}`]
      : []),
    ...(hasVoiceAnchors ? ["Voice anchors written"] : []),
  ].join(" · ");

  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-[var(--app-header-height,3.25rem)] z-30 -mx-1 border-b border-ink-600 bg-ink-900/95 px-1 py-2 backdrop-blur">
        <div className="md:hidden">
          <Field label="Character section">
            {(id) => (
              <Select id={id} value={tab} onChange={(event) => setTab(event.target.value as CharacterEditorTab)}>
                {tabs.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Tabs tabs={tabs} value={tab} onChange={setTab} idPrefix={panelPrefix} ariaLabel="Character sections" className="hidden md:flex" />
        {relationshipSaveStatus !== "saved" ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-600 bg-ink-800 px-3 py-2">
            <p role={relationshipSaveStatus === "error" || relationshipSaveStatus === "blocked" ? "alert" : "status"}
              className="text-sm text-paper-200">
              {relationshipSaveStatus === "error" ? "Library relationships could not be saved. Review them and retry."
                : relationshipSaveStatus === "blocked" ? "Library relationship autosave is paused. Review the recovered versions."
                  : relationshipSaveStatus === "saving" ? "Saving library relationships…"
                    : "Library relationship changes are waiting to save."}
            </p>
            {tab !== "relationships" ? (
              <Button size="sm" onClick={() => setTab("relationships")}>Return to Relationships</Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {scope ? (
        <div className="flex flex-wrap items-center gap-2">
          {onComplete ? (
            <Button size="sm" variant="primary" onClick={() => onComplete(scope)} busy={completing === scope}
              disabled={generationBusy} title="Suggest missing details in this section, preserving everything already authored.">
              Complete missing details
            </Button>
          ) : null}
          {onRedraft ? (
            <Button size="sm" onClick={() => onRedraft(scope)} busy={redrafting === scope} disabled={generationBusy}
              title="Propose replacements for this section, including manually authored values. Review changes before accepting; identity facts stay fixed.">
              Rewrite this section
            </Button>
          ) : null}
          {onPortraitAttributes && tab === "attributes" && avatarImageId ? (
            <Button size="sm" onClick={onPortraitAttributes} busy={derivingPortrait} disabled={generationBusy}
              title="Read the portrait and propose appearance details. Review disagreements before accepting.">
              Complete using portrait
            </Button>
          ) : null}
        </div>
      ) : null}

      {diagnostics.length > 0 ? (
        <Disclosure
          title="Generation notes"
          description={`${diagnostics.length} ${diagnostics.length === 1 ? "note" : "notes"} to review${diagnostics.some((d) => d.severity === "error") ? " · Some details could not be generated" : ""}`}
        >
          <DiagnosticList diagnostics={diagnostics} />
        </Disclosure>
      ) : null}

      <div role="tabpanel" id={`${panelPrefix}-panel-relationships`}
        aria-labelledby={`${panelPrefix}-tab-relationships`}
        className={tab === "relationships" ? "flex flex-col gap-6" : "hidden"} tabIndex={0}>
          <div className="flex flex-col gap-4">
            <h3 className="text-base font-medium text-paper-100">Starting relationship with the player</h3>
            <p className="text-sm text-paper-400">Saved with the character. New conversations start from these details; existing stories keep their own relationship.</p>
            <RelationshipRecordEditor
              value={draft.profile.playerRelationship}
              onChange={(next) => patchProfile({ playerRelationship: { ...draft.profile.playerRelationship, ...next } })}
              selfName={draft.name || "this character"}
              targetName="the player"
            />
            <Field label="Premise note" hint="One line to pre-fill the opening scene of a new conversation.">
              {(id) => (
                <Textarea id={id} rows={2} value={draft.profile.playerRelationship.note}
                  maxLength={PLAYER_RELATIONSHIP_NOTE_MAX}
                  onChange={(event) => patchProfile({
                    playerRelationship: { ...draft.profile.playerRelationship, note: event.target.value },
                  })} />
              )}
            </Field>
          </div>
          {characterId ? <RelationshipsEditor key={characterId} characterId={characterId} name={draft.name} onSaveStatusChange={onRelationshipSaveStatusChange} /> : <p className="text-sm text-paper-400">Save this character to link relationships with other library characters.</p>}
        </div>

      {tabs.filter((entry) => entry.id !== tab && entry.id !== "relationships").map((entry) => (
        <div key={entry.id} hidden role="tabpanel" id={`${panelPrefix}-panel-${entry.id}`}
          aria-labelledby={`${panelPrefix}-tab-${entry.id}`} />
      ))}
      <div role={tab === "relationships" ? undefined : "tabpanel"}
        id={tab === "relationships" ? undefined : `${panelPrefix}-panel-${tab}`}
        aria-labelledby={tab === "relationships" ? undefined : `${panelPrefix}-tab-${tab}`}
        tabIndex={tab === "relationships" ? undefined : 0}>
      {tab === "profile" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            className="sm:col-span-1"
            error={!draft.name.trim() ? "No name yet — the character saves unnamed." : undefined}
          >
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
            <Field
              label={selectedSpecies?.subtypeLabel ?? "Heritage"}
              hint={selectedSpecies?.subtypeLabel ? "The character's body subtype." : "A sub-group within the species."}
            >
              {(id) => (
                <Select
                  id={id}
                  value={selectedHeritageId}
                  onChange={(e) => setHeritage(e.target.value)}
                >
                  {selectedSpecies?.defaultHeritageId ? null : <option value="">— None —</option>}
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
            hint="Their actual age. Set their apparent age under Appearance."
          >
            {(id) => (
              <Input id={id} value={draft.profile.age} onChange={(e) => patchProfile({ age: e.target.value })} />
            )}
          </Field>
          <Field label="Bio" className="sm:col-span-2">
            {(id) => (
              <Textarea id={id} rows={6} value={draft.profile.bio} onChange={(e) => patchProfile({ bio: e.target.value })} />
            )}
          </Field>
          <Field label="Aliases" hint="Other names the narrative may use.">
            {(id) => <TagInput id={id} value={draft.profile.aliases} onChange={(aliases) => patchProfile({ aliases })} />}
          </Field>
          <Disclosure
            title="Daily rhythm"
            description={draft.profile.schedule.length > 0
              ? `${draft.profile.schedule.length} scheduled ${draft.profile.schedule.length === 1 ? "activity" : "activities"}`
              : "Optional · Work, rest and the places they spend time"}
            className="sm:col-span-2"
          >
            <ScheduleEditor
              schedule={draft.profile.schedule}
              onChange={(schedule) => patchProfile({ schedule })}
              outfitPresets={draft.profile.outfits.map((o) => ({ id: o.id, name: o.name }))}
            />
          </Disclosure>
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
          <Field label="Voice notes" hint="How they sound on the page." className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={draft.profile.voice ?? ""}
                onChange={(e) => patchProfile({ voice: e.target.value || undefined })}
              />
            )}
          </Field>
          <Disclosure
            title="Voice examples & anchors"
            description={voiceSummary || "Optional · Sample dialogue, phrases and speaking rhythm"}
            className="sm:col-span-2"
          >
            <div className="flex flex-col gap-6">
              <MicroExemplarsEditor
                exemplars={draft.profile.microExemplars}
                onChange={(microExemplars) => patchProfile({ microExemplars })}
              />
              <VoiceAnchorsEditor
                anchors={draft.profile.voiceAnchors}
                onChange={(voiceAnchors) => patchProfile({ voiceAnchors })}
              />
            </div>
          </Disclosure>

          <AttributePicker
            scope="personality"
            values={draft.profile.attributes}
            onChange={(attributes) => patchProfile({ attributes })}
            speciesId={draft.profile.speciesId}
            heritageId={draft.profile.heritageId}
            bodyPlanId={draft.profile.bodyPlanId}
          />
        </div>
      ) : null}

      {tab === "disposition" ? (
        <div className="flex flex-col gap-6">
          <Field label="Personality" className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                rows={5}
                value={draft.profile.personality}
                onChange={(e) => patchProfile({ personality: e.target.value })}
              />
            )}
          </Field>
          <Disclosure
            title="Intimate disposition"
            description={draft.profile.intimacy?.trim()
              ? "Written · Used when a scene turns intimate"
              : "Optional · How they are as a lover"}
            className="sm:col-span-2"
          >
            <Field label="Intimate disposition" hint="Used when a scene turns intimate.">
              {(id) => (
                <Textarea
                  id={id}
                  rows={4}
                  value={draft.profile.intimacy ?? ""}
                  onChange={(e) => patchProfile({ intimacy: e.target.value || undefined })}
                />
              )}
            </Field>
          </Disclosure>
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

          <DrivesEditor drives={draft.profile.drives} onChange={(drives) => patchProfile({ drives })} />
          <DispositionEditor
            traits={draft.profile.traits}
            onChangeTraits={(traits) => patchProfile({ traits })}
            tags={draft.profile.tags}
            onChangeTags={(tags) => patchProfile({ tags })}
          />
        </div>
      ) : null}

      {tab === "outfit" ? (
        <OutfitEditor
          outfits={draft.profile.outfits}
          onChange={(outfits) => patchProfile({ outfits })}
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
            acceptance={acceptance}
            onAvatarChanged={onAvatarChanged ?? (() => {})}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-ink-600 px-4 py-8 text-center text-sm text-paper-400">
            <p>Save your character to create a portrait from these details.</p>
            {onSaveAndOpen ? <Button variant="primary" busy={saving} disabled={saving} onClick={() => onSaveAndOpen("portrait")}>Save and open Portrait Studio</Button> : null}
          </div>
        )
      ) : null}

      {tab === "chat" ? (
        characterId ? (
          // Conversation defaults and links; the player relationship belongs to Relationships.
          <CharacterChat
            characterId={characterId}
            name={draft.name || "Untitled"}
            chatModel={resolveChatModelId(chatModel)}
            onChatModelChange={onChatModelChange ?? (() => undefined)}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-ink-600 px-4 py-8 text-center text-sm text-paper-400">
            <p>Save your character to start a conversation.</p>
            {onSaveAndOpen ? <Button variant="primary" busy={saving} disabled={saving} onClick={() => onSaveAndOpen("chat")}>Save and open Chat</Button> : null}
          </div>
        )
      ) : null}
      </div>
    </div>
  );
}
