"use client";

import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { ReactNode } from "react";
import type { ImageLabExperimentKind } from "@vesper/image-core";
import type { CharacterSummary, ChatSummary } from "@/lib/client/api";
import type { AsyncState } from "@/components/hooks/use-async";
import { LabCharacterSelect } from "../image-lab-pickers";

export function LabChatFields({
  kind,
  isTwoCharacter,
  chats,
  chatId,
  setChatId,
  identityColumn,
}: {
  kind: ImageLabExperimentKind;
  isTwoCharacter: boolean;
  chats: AsyncState<ChatSummary[]>;
  chatId: string;
  setChatId: (value: string) => void;
  identityColumn: ReactNode;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
      <Field
        label="Chat"
        hint={
          kind === "baseline_scene"
            ? "A scene baseline re-runs this conversation's own scene settings."
            : isTwoCharacter
              ? "The conversation this evidence is filed against. Both characters are picked below, so this says where the scene belongs — not who is in it."
              : "The conversation this evidence is filed against; its character and scene renders feed the pickers."
        }
      >
        {(id) => (
          <Select id={id} value={chatId} onChange={(e) => setChatId(e.target.value)}>
            <option value="">— Choose a conversation —</option>
            {(chats.data ?? []).map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chat.title || chat.characterName || chat.id}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {kind === "controlled_scene" ? identityColumn : null}
    </div>
  );
}

export function LabCharacterFields({
  kind,
  isProbe,
  isStaged,
  characterRows,
  characterId,
  setCharacterId,
  identityColumn,
}: {
  kind: ImageLabExperimentKind;
  isProbe: boolean;
  isStaged: boolean;
  characterRows: CharacterSummary[];
  characterId: string;
  setCharacterId: (value: string) => void;
  identityColumn: ReactNode;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
      <Field
        label="Character"
        hint={
          isProbe
            ? "Whose identity the probe must preserve."
            : kind === "controlled_portrait"
              ? "The character this evidence is filed against — whose identity the render must keep."
              : isStaged
                ? "Who performs the act. Named here rather than bound to the reference below, because only a two-character scene binds its subjects to their inputs."
                : "The character whose portrait settings are re-run."
        }
      >
        {(id) => (
          <LabCharacterSelect
            id={id}
            characters={characterRows}
            value={characterId}
            onChange={setCharacterId}
          />
        )}
      </Field>
      {isProbe || kind === "controlled_portrait" || isStaged ? identityColumn : null}
    </div>
  );
}
