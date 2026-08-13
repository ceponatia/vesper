"use client";

import {
  VOICE_CADENCE_MAX,
  VOICE_NEVER_SAYS_MAX,
  VOICE_PET_PHRASES_MAX,
  type VoiceAnchors,
} from "@/contracts";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TagInput } from "@/components/ui/tag-input";

export interface VoiceAnchorsEditorProps {
  anchors: VoiceAnchors;
  onChange: (anchors: VoiceAnchors) => void;
}

/**
 * Structured voice anchors (character-fidelity slice 7): pet phrases, a rhythm/cadence
 * note, and a never-says list — forge-drafted and hand-editable. Rendered in the chat
 * prefix AND as a one-line tail re-anchor beside the mood pin so voice stays consistent
 * near generation. Lives on the Profile tab beside Voice examples; the profile Re-draft
 * scope re-derives them.
 */
export function VoiceAnchorsEditor({ anchors, onChange }: VoiceAnchorsEditorProps) {
  const patch = (p: Partial<VoiceAnchors>) => onChange({ ...anchors, ...p });

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-paper-200">Voice anchors</span>
      <p className="text-xs text-paper-500">
        Concrete levers that keep the voice consistent across a long chat — restated near where the reply is written.
      </p>
      <Field label="Pet phrases" hint={`Turns of phrase they actually use (up to ${VOICE_PET_PHRASES_MAX}).`}>
        {(id) => (
          <TagInput
            id={id}
            value={anchors.petPhrases}
            placeholder="no promises, be serious…"
            onChange={(petPhrases) => patch({ petPhrases: petPhrases.slice(0, VOICE_PET_PHRASES_MAX) })}
          />
        )}
      </Field>
      <Field label="Rhythm / cadence" hint="One line on how they sound (clipped, rambling, dry, trails off).">
        {(id) => (
          <Input
            id={id}
            value={anchors.cadence}
            maxLength={VOICE_CADENCE_MAX}
            placeholder="clipped and dry; trails off when she deflects"
            onChange={(e) => patch({ cadence: e.target.value })}
          />
        )}
      </Field>
      <Field label="Never says" hint={`Words or registers off-limits for them (up to ${VOICE_NEVER_SAYS_MAX}).`}>
        {(id) => (
          <TagInput
            id={id}
            value={anchors.neverSays}
            placeholder="babe, corporate-speak…"
            onChange={(neverSays) => patch({ neverSays: neverSays.slice(0, VOICE_NEVER_SAYS_MAX) })}
          />
        )}
      </Field>
    </div>
  );
}
