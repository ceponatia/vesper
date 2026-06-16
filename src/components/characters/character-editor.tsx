"use client";

import { useState } from "react";
import { speciesById, speciesCatalog, type Diagnostic } from "@/contracts";
import type { CharacterDraft, CharacterForgeSection } from "@/lib/client/api";
import { DiagnosticList } from "@/components/forge/diagnostic-list";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AttributePicker, PERSONALITY_CATEGORIES } from "./attribute-picker";
import { OutfitEditor } from "./outfit-editor";
import { PortraitStudio } from "./portrait-studio";

type EditorTab = "profile" | "attributes" | "personality" | "outfit" | "portrait";

/** Split the flat attribute list into the two tabs that render it. */
const isPersonalityAttribute = (id: string) => PERSONALITY_CATEGORIES.some((c) => id.startsWith(`${c}.`));

export interface CharacterEditorProps {
  draft: CharacterDraft;
  onChange: (next: CharacterDraft) => void;
  /** Forge mode shows per-section regenerate buttons (docs/authoring.md). */
  onRegenerate?: (section: CharacterForgeSection) => void;
  regenerating?: CharacterForgeSection | null;
  /** Saved characters get the portrait studio; drafts don't exist yet. */
  characterId?: string;
  avatarImageId?: string | null;
  onAvatarChanged?: () => void;
  diagnostics?: readonly Diagnostic[];
}

/** The character form — the forge review UI *is* the editor (docs/authoring.md). */
export function CharacterEditor({
  draft,
  onChange,
  onRegenerate,
  regenerating = null,
  characterId,
  avatarImageId = null,
  onAvatarChanged,
  diagnostics = [],
}: CharacterEditorProps) {
  const [tab, setTab] = useState<EditorTab>("profile");

  const personalityCount = draft.profile.attributes.filter((a) => isPersonalityAttribute(a.id)).length;
  const tabs: TabDef<EditorTab>[] = [
    { id: "profile", label: "Profile" },
    {
      id: "attributes",
      label: "Attributes",
      badge: draft.profile.attributes.length - personalityCount || undefined,
    },
    { id: "personality", label: "Personality", badge: personalityCount || undefined },
    {
      id: "outfit",
      label: "Outfit",
      badge: draft.profile.defaultOutfit.length + draft.suggestedItems.length || undefined,
    },
    { id: "portrait", label: "Portrait studio" },
  ];

  const patchProfile = (patch: Partial<CharacterDraft["profile"]>) =>
    onChange({ ...draft, profile: { ...draft.profile, ...patch } });
  const setSpecies = (speciesId: string) => {
    const species = speciesById(speciesId);
    if (!species) return;
    patchProfile({
      speciesId: species.id,
      bodyPlanId: species.bodyPlanId,
      bodyFeatures: species.defaultFeatureGroups ? [...species.defaultFeatureGroups] : undefined,
    });
  };

  const sectionFor: Partial<Record<EditorTab, CharacterForgeSection>> = {
    profile: "profile",
    attributes: "attributes",
    outfit: "outfit",
  };
  const section = sectionFor[tab];

  return (
    <div className="flex flex-col gap-5">
      <DiagnosticList diagnostics={diagnostics} />

      <div className="flex items-end justify-between gap-3">
        <Tabs tabs={tabs} value={tab} onChange={setTab} className="flex-1" />
        {onRegenerate && section ? (
          <Button
            size="sm"
            onClick={() => onRegenerate(section)}
            busy={regenerating === section}
            disabled={regenerating !== null && regenerating !== section}
            className="mb-1"
          >
            ↻ Regenerate {section}
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
          bodyPlanId={draft.profile.bodyPlanId}
        />
      ) : null}

      {tab === "personality" ? (
        <AttributePicker
          scope="personality"
          values={draft.profile.attributes}
          onChange={(attributes) => patchProfile({ attributes })}
          speciesId={draft.profile.speciesId}
          bodyPlanId={draft.profile.bodyPlanId}
        />
      ) : null}

      {tab === "outfit" ? (
        <OutfitEditor
          outfit={draft.profile.defaultOutfit}
          onChange={(defaultOutfit) => patchProfile({ defaultOutfit })}
          suggestedItems={draft.suggestedItems}
          onChangeSuggested={(suggestedItems) => onChange({ ...draft, suggestedItems })}
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
    </div>
  );
}
