"use client";

import { useState } from "react";
import { charactersApi, chatsApi, type ChatRosterMember } from "@/lib/client/api";
import { EntityPickerDialog } from "@/components/library/entity-picker";
import { cx } from "@/components/ui/cx";
import { EntityImage } from "@/components/ui/entity-image";
import { useToast } from "@/components/ui/toast";

/** Mirrors the server's MAX_CHAT_PARTICIPANTS (multi-character-chat.plan.md). */
const MAX_ROSTER = 4;

/**
 * The conversation roster (multi-character-chat.plan.md slice 1): who is in this
 * story, with the manual present/away toggle (the dev-override philosophy — the
 * archivist will confirm transitions once slice 3 lands), add-from-library, and
 * remove (never the last member; the server promotes a removed primary's heir).
 * Mounted in the desktop aside and the menu's Roster sheet.
 */
export function ChatRosterPanel({
  chatId,
  roster,
  archived,
  onChanged,
}: {
  chatId: string;
  roster: ChatRosterMember[];
  archived: boolean;
  /** Refetch the conversation envelope after a roster mutation. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The characterId being mutated (serializes row actions), or null. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const fail = (title: string, message: string) => toast.push({ title, description: message, tone: "error" });

  const flipPresence = async (member: ChatRosterMember) => {
    if (busyId) return;
    setBusyId(member.characterId);
    const next = member.presence === "present" ? "away" : "present";
    const result = await chatsApi.setPresence(chatId, member.characterId, next);
    setBusyId(null);
    if (!result.ok) {
      fail("Couldn't change presence", result.error.message);
      return;
    }
    onChanged();
  };

  const removeMember = async (member: ChatRosterMember) => {
    if (busyId) return;
    setBusyId(member.characterId);
    const result = await chatsApi.removeParticipant(chatId, member.characterId);
    setBusyId(null);
    if (!result.ok) {
      fail("Couldn't remove", result.error.message);
      return;
    }
    toast.push({ title: `${member.name} left the conversation`, tone: "success" });
    onChanged();
  };

  const addMember = async (characterId: string) => {
    const result = await chatsApi.addParticipant(chatId, characterId);
    if (!result.ok) {
      fail("Couldn't add", result.error.message);
      return;
    }
    onChanged();
  };

  const searchCharacters = async (q: string) => {
    const result = await charactersApi.list({ q, scope: "owned" });
    return result.ok
      ? {
          ok: true as const,
          data: result.data.map((c) => ({ id: c.id, name: c.name, imageId: c.avatarImageId })),
        }
      : result;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">In this story</span>
      {roster.map((member) => (
        <div key={member.characterId} className="group flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5">
          <EntityImage imageId={member.avatarImageId} name={member.name} className="size-7 shrink-0 rounded-full text-[9px]" />
          <span className="min-w-0 flex-1 truncate text-sm text-paper-200">{member.name}</span>
          <button
            type="button"
            disabled={archived || busyId !== null}
            onClick={() => void flipPresence(member)}
            aria-pressed={member.presence === "present"}
            title={member.presence === "present" ? "Sharing the scene — tap to send away" : "Away, living their life — tap to bring back"}
            className={cx(
              "shrink-0 cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:cursor-default",
              member.presence === "present"
                ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                : "border-ink-500 text-paper-500 hover:text-paper-300",
            )}
          >
            {member.presence === "present" ? "Present" : "Away"}
          </button>
          {roster.length > 1 && !archived ? (
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void removeMember(member)}
              aria-label={`Remove ${member.name} from the conversation`}
              className="hover-reveal shrink-0 cursor-pointer rounded px-1 text-xs text-paper-500 hover:text-danger-300"
            >
              ✕
            </button>
          ) : null}
        </div>
      ))}
      {!archived && roster.length < MAX_ROSTER ? (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="cursor-pointer rounded-md border border-dashed border-ink-500 px-2 py-1.5 text-left text-xs text-paper-400 transition-colors hover:border-accent-500/50 hover:text-paper-200"
        >
          + Add character
        </button>
      ) : null}
      <EntityPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add to the conversation"
        search={searchCharacters}
        onPick={(entry) => {
          setPickerOpen(false);
          void addMember(entry.id);
        }}
        disabledIds={new Set(roster.map((m) => m.characterId))}
        emptyText="No characters match."
      />
    </div>
  );
}
