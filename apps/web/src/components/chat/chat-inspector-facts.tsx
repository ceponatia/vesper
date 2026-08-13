"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { chatInspectorApi, type InspectorFact, type InspectorFactPatch } from "@/lib/api-inspector";

/**
 * The inspector's Facts section (character-chat-standalone.spec.md §6.1): every
 * fact in the chat's memory group — active, superseded, and retracted — with
 * status/origin/pinned chips, click-to-edit text (re-embeds on save),
 * retract/restore, an immediate pinned toggle, and an ad-hoc "New fact" form.
 * Errors surface as inline text (never a throw); the parent reload refreshes
 * the rows after every successful write.
 */
export function ChatInspectorFacts({
  chatId,
  characterName,
  facts,
  onChanged,
}: {
  chatId: string;
  characterName: string;
  facts: InspectorFact[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [pinned, setPinned] = useState(false);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    const trimmed = text.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    const result = await chatInspectorApi.createFact(chatId, {
      text: trimmed,
      ...(subject.trim() ? { subjectName: subject.trim() } : {}),
      pinned,
    });
    setCreating(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setText("");
    setSubject("");
    setPinned(false);
    onChanged();
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">
        Facts <span className="text-paper-600">({facts.length})</span>
      </h2>

      <div className="rounded-card border border-ink-600 bg-ink-800 p-3">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">New fact</span>
        <Textarea
          rows={2}
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should they remember? (origin: dev, confidence 1)"
          className="mt-2"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Input
            value={subject}
            maxLength={120}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={`Subject (default: ${characterName})`}
            className="w-56 max-w-full"
          />
          <label className="flex items-center gap-2 text-xs text-paper-400">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="size-4 accent-accent-500"
            />
            Pinned
          </label>
          <Button size="sm" variant="primary" busy={creating} disabled={!text.trim()} onClick={() => void create()}>
            Add fact
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-danger-300">
          {error}
        </p>
      ) : null}

      {facts.length === 0 ? (
        <p className="text-xs text-paper-600">No facts stored yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {facts.map((fact) => (
            <FactRow key={fact.id} chatId={chatId} fact={fact} onChanged={onChanged} onError={setError} />
          ))}
        </div>
      )}
    </section>
  );
}

function FactRow({
  chatId,
  fact,
  onChanged,
  onError,
}: {
  chatId: string;
  fact: InspectorFact;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [embedNote, setEmbedNote] = useState<string | null>(null);

  const patch = async (body: InspectorFactPatch): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    onError(null);
    const result = await chatInspectorApi.updateFact(chatId, fact.id, body);
    setBusy(false);
    if (!result.ok) {
      onError(result.error.message);
      return false;
    }
    setEmbedNote(
      result.data.embedDegraded
        ? "Re-embed failed — text saved, but this fact is out of similarity retrieval until re-embedded."
        : null,
    );
    onChanged();
    return true;
  };

  const saveText = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (await patch({ text: trimmed })) setEditing(false);
  };

  const muted = fact.status !== "active";
  return (
    <div className={cx("rounded-card border border-ink-600 bg-ink-800 p-3", muted && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone={fact.status === "active" ? "ok" : fact.status === "retracted" ? "danger" : "default"}>
          {fact.status}
        </Tag>
        <Tag tone={fact.origin === "extracted" ? "default" : "accent"} title="Who authored this fact">
          {fact.origin}
        </Tag>
        {fact.pinned ? <Tag tone="accent">pinned</Tag> : null}
        <span className="min-w-0 truncate text-xs text-paper-500">
          {fact.subjectName} · {fact.subjectKind} · {fact.kind} · conf {fact.confidence.toFixed(2)}
        </span>
      </div>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea rows={3} value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" busy={busy} disabled={!draft.trim()} onClick={() => void saveText()}>
              Save
            </Button>
            <Button size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          title="Click to edit"
          onClick={() => {
            setDraft(fact.text);
            setEditing(true);
          }}
          className="mt-1.5 block w-full cursor-text rounded text-left text-sm text-paper-200 hover:bg-ink-750"
        >
          {fact.text}
        </button>
      )}

      {embedNote ? <p className="mt-1 text-[11px] text-danger-300">{embedNote}</p> : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void patch({ pinned: !fact.pinned })}
          className="cursor-pointer rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200 disabled:cursor-not-allowed disabled:text-paper-600"
        >
          {fact.pinned ? "Unpin" : "Pin"}
        </button>
        {fact.status === "active" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void patch({ status: "retracted" })}
            className="cursor-pointer rounded px-2 py-1 text-[11px] text-paper-500 hover:text-danger-400 disabled:cursor-not-allowed disabled:text-paper-600"
          >
            Retract
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void patch({ status: "active" })}
            className="cursor-pointer rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200 disabled:cursor-not-allowed disabled:text-paper-600"
          >
            Restore
          </button>
        )}
        {fact.supersededById ? (
          <span className="px-2 text-[11px] text-paper-600">superseded by {fact.supersededById.slice(0, 8)}…</span>
        ) : null}
      </div>
    </div>
  );
}
