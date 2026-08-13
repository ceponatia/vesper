"use client";

import { useState } from "react";
import {
  heritagesForSpecies,
  speciesById,
  speciesCatalog,
  type PersonaProfile,
} from "@/contracts";
import { wearerHintForGender } from "@/lib/clothing-slots";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AttributePicker } from "@/components/characters/attribute-picker";
import { heritageChangePatch, speciesChangePatch } from "@/components/characters/attribute-helpers";
import { OutfitEditor } from "@/components/characters/outfit-editor";

/**
 * The persona form (persona-library.plan.md slice 5) — deliberately THREE tabs against
 * the character editor's eight. A persona has a body, a wardrobe and a bio; it has no
 * personality, disposition, drives, relationships or schedule, because the narrator
 * never writes the player's lines (contracts/players/persona-profile.ts).
 *
 * `AttributePicker` and `OutfitEditor` are embedded **as-is** — both are pure
 * props-in/callback-out over contract shapes with no `characterId` coupling, so the
 * persona's body and wardrobe editing come free. Do not fork them.
 */

export type PersonaEditorTab = "profile" | "body" | "wardrobe";

export interface PersonaDraft {
  /** Per-owner-unique library label — never reaches a prompt. */
  title: string;
  /** The in-fiction name a character calls you; repeatable across personas. */
  name: string;
  tags: string[];
  profile: PersonaProfile;
}

/** The presented-gender attribute value, when set (drives the outfit picker's wearer default). */
function genderValue(attributes: readonly { id: string; value: unknown }[]): string | undefined {
  const value = attributes.find((a) => a.id === "identity.gender")?.value;
  return typeof value === "string" ? value : undefined;
}

export interface PersonaEditorProps {
  draft: PersonaDraft;
  onChange: (next: PersonaDraft) => void;
  /** Server-reported title collision (409) — rendered inline on the Title field. */
  titleError?: string;
}

export function PersonaEditor({ draft, onChange, titleError }: PersonaEditorProps) {
  const [tab, setTab] = useState<PersonaEditorTab>("profile");

  const tabs: TabDef<PersonaEditorTab>[] = [
    { id: "profile", label: "Profile" },
    { id: "body", label: "Body", badge: draft.profile.attributes.length || undefined },
    {
      id: "wardrobe",
      label: "Wardrobe",
      badge: draft.profile.outfits.reduce((n, o) => n + o.items.length, 0) || undefined,
    },
  ];

  const patchProfile = (patch: Partial<PersonaProfile>) => onChange({ ...draft, profile: { ...draft.profile, ...patch } });

  // Species/heritage decide which attributes apply (realizeBody), so a change re-seeds
  // the required set — shared with the character editor, never re-implemented.
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

  return (
    <div className="flex flex-col gap-5">
      <Tabs tabs={tabs} value={tab} onChange={setTab} className="min-w-0 flex-1" />

      {tab === "profile" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Title"
            hint="Your label for this persona — how you'll tell it apart in the library. Characters never see it."
            error={titleError ?? (!draft.title.trim() ? "A title is required — it has to be unique." : undefined)}
          >
            {(id) => (
              <Input
                id={id}
                value={draft.title}
                placeholder="Brian, 22"
                onChange={(e) => onChange({ ...draft, title: e.target.value })}
              />
            )}
          </Field>
          <Field label="Name" hint="What the character calls you. Personas can share a name — that's what Title is for.">
            {(id) => (
              <Input
                id={id}
                value={draft.name}
                placeholder="Brian"
                onChange={(e) => onChange({ ...draft, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Tags" className="sm:col-span-2">
            {(id) => (
              <TagInput
                id={id}
                value={draft.tags}
                onChange={(tags) => onChange({ ...draft, tags })}
                placeholder="young, modern…"
              />
            )}
          </Field>
          <Field label="Species">
            {(id) => (
              <Select id={id} value={speciesById(draft.profile.speciesId)?.id ?? "human"} onChange={(e) => setSpecies(e.target.value)}>
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
              hint={selectedSpecies?.subtypeLabel ? "The persona's body subtype." : "A sub-group within the species."}
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
          <Field label="About you" className="sm:col-span-2" hint="A couple of sentences on who you are. Characters read this.">
            {(id) => (
              <Textarea
                id={id}
                rows={4}
                value={draft.profile.bio}
                onChange={(e) => patchProfile({ bio: e.target.value })}
                placeholder="A quiet man who fixes things and doesn't explain himself."
              />
            )}
          </Field>
          <Field
            label="Voice"
            className="sm:col-span-2"
            hint="How you sound — the narrator describes your voice, it never writes your lines."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={draft.profile.voice ?? ""}
                onChange={(e) => patchProfile({ voice: e.target.value })}
                placeholder="Low and unhurried; goes rough when it matters."
              />
            )}
          </Field>
          <Field
            label="What you like"
            className="sm:col-span-2"
            hint="Your preferences in intimacy — a character only reads this once things get intimate."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={draft.profile.intimacy ?? ""}
                onChange={(e) => patchProfile({ intimacy: e.target.value })}
                placeholder="Responds to being taken care of; slow to ask for anything."
              />
            )}
          </Field>
        </div>
      ) : null}

      {tab === "body" ? (
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

      {tab === "wardrobe" ? (
        <OutfitEditor
          outfits={draft.profile.outfits}
          onChange={(outfits) => patchProfile({ outfits })}
          // Forge-suggested items are a character-authoring concept; a persona has no
          // forge, so the picker draws only from the real library.
          suggestedItems={[]}
          onChangeSuggested={() => undefined}
          wearerHint={wearerHintForGender(genderValue(draft.profile.attributes))}
        />
      ) : null}
    </div>
  );
}
