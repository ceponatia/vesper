"use client";

import { useState, type ReactNode } from "react";
import { SUPPORTING_CAST_MAX, type SupportingCastMember } from "@/contracts";
import { chatsApi, type ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The Supporting Cast panel (a dev/testing surface): the scenario's recurring
 * named side characters, listed below "In this story".
 * Names accrete as the archivist establishes people; this panel is the manual
 * override — add someone before their first mention, fix a relation, or remove
 * an entry the system minted erroneously. Tapping a name opens a lightbox
 * editor for the member's texture (relation / details / voice / whereabouts).
 * Saves are whole-list replacements through the state PATCH (chat-wide field);
 * a 409 means a reply is streaming — try again after it settles.
 */
export function ChatSupportingCastPanel({
  chatId,
  cast,
  archived,
  onSaved,
}: {
  chatId: string;
  cast: SupportingCastMember[];
  archived: boolean;
  /** Receives the fresh state snapshot after a successful save. */
  onSaved: (snapshot: ChatStateSnapshot) => void;
}) {
  const toast = useToast();
  /** The member being viewed/edited, or "new" for the add flow; null = closed. */
  const [editing, setEditing] = useState<SupportingCastMember | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (next: SupportingCastMember[]) => {
    setSaving(true);
    const result = await chatsApi.editState(chatId, { supportingCast: next });
    setSaving(false);
    if (!result.ok) {
      toast.push({
        title: "Couldn't save the cast",
        description:
          result.error.code === "chat_busy" ? "A reply is still streaming — try again in a moment." : result.error.message,
        tone: "error",
      });
      return false;
    }
    onSaved(result.data);
    return true;
  };

  const upsert = async (original: SupportingCastMember | "new", member: SupportingCastMember) => {
    const rest = original === "new" ? [...cast] : cast.filter((m) => m.name !== original.name);
    // A rename colliding with another entry replaces it (names are the identity).
    const next = [...rest.filter((m) => m.name.toLowerCase() !== member.name.toLowerCase()), member];
    if (await save(next)) setEditing(null);
  };

  const remove = async (original: SupportingCastMember) => {
    if (await save(cast.filter((m) => m.name !== original.name))) setEditing(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Supporting cast</span>
      {cast.length === 0 ? (
        <p className="text-xs text-paper-500">No one yet — side characters appear here as the story establishes them.</p>
      ) : (
        cast.map((member) => (
          <button
            key={member.name}
            type="button"
            onClick={() => setEditing(member)}
            title={member.relation || undefined}
            className="flex cursor-pointer flex-col rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-left transition-colors hover:border-accent-500/50"
          >
            <span className="truncate text-sm text-paper-200">{member.name}</span>
            {member.relation ? <span className="truncate text-[10px] text-paper-500">{member.relation}</span> : null}
          </button>
        ))
      )}
      {!archived && cast.length < SUPPORTING_CAST_MAX ? (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="cursor-pointer rounded-md border border-dashed border-ink-500 px-2 py-1.5 text-left text-xs text-paper-400 transition-colors hover:border-accent-500/50 hover:text-paper-200"
        >
          + Add person
        </button>
      ) : null}
      {editing !== null ? (
        <CastMemberDialog
          member={editing === "new" ? null : editing}
          readOnly={archived}
          saving={saving}
          onClose={() => {
            if (!saving) setEditing(null);
          }}
          onSave={(member) => void upsert(editing, member)}
          onRemove={editing === "new" ? undefined : () => void remove(editing)}
        />
      ) : null}
    </div>
  );
}

/** The lightbox editor for one cast member — name/relation/details/voice/whereabouts. */
function CastMemberDialog({
  member,
  readOnly,
  saving,
  onClose,
  onSave,
  onRemove,
}: {
  /** null = the add-person flow (empty form). */
  member: SupportingCastMember | null;
  readOnly: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (member: SupportingCastMember) => void;
  onRemove?: () => void;
}) {
  const [name, setName] = useState(member?.name ?? "");
  const [relation, setRelation] = useState(member?.relation ?? "");
  const [details, setDetails] = useState((member?.details ?? []).join("\n"));
  const [voice, setVoice] = useState(member?.voice ?? "");
  const [whereabouts, setWhereabouts] = useState(member?.whereabouts ?? "");

  const submit = () => {
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      relation: relation.trim(),
      details: details
        .split("\n")
        .map((d) => d.trim())
        .filter(Boolean),
      voice: voice.trim() || undefined,
      whereabouts: whereabouts.trim() || undefined,
    });
  };

  const field = (label: string, node: ReactNode) => (
    <label className="flex flex-col gap-1 text-xs text-paper-400">
      {label}
      {node}
    </label>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={member ? member.name : "Add a supporting character"}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {onRemove && !readOnly ? (
            <Button variant="danger" size="sm" disabled={saving} onClick={onRemove}>
              Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            {!readOnly ? (
              <Button variant="primary" busy={saving} disabled={!name.trim()} onClick={submit}>
                Save
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {field("Name", <Input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} placeholder="Abby" />)}
        {field(
          "Who they are to the story",
          <Input
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
            disabled={readOnly}
            placeholder="the player's coworker and close friend"
          />,
        )}
        {field(
          "Established details (one per line)",
          <Textarea
            rows={4}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            disabled={readOnly}
            placeholder={"training for a marathon\ncovered a shift last week"}
          />,
        )}
        {field(
          "Voice (how they talk)",
          <Input
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            disabled={readOnly}
            placeholder="dry one-liners, never raises her voice"
          />,
        )}
        {field(
          "Usually found",
          <Input
            value={whereabouts}
            onChange={(e) => setWhereabouts(e.target.value)}
            disabled={readOnly}
            placeholder="the front desk at the clinic"
          />,
        )}
        <p className="text-[11px] text-paper-500">
          The story keeps this person consistent with what&rsquo;s here; new details accrete as scenes establish them.
        </p>
      </div>
    </Dialog>
  );
}
