"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { charactersApi, chatPresetsApi, chatsApi, type ApiResult, type CharacterSummary, type ChatPreset } from "@/lib/client/api";

/**
 * Start a conversation (character-chat-standalone.spec.md §2.2): pick a character
 * (skipped when the caller already knows one — the editor tab / a library card),
 * choose the D7 memory mode, optionally start from a saved scenario preset (spec
 * §1.5 — the server seeds the new conversation's state from it), optionally title
 * it, then create + navigate to the full-screen conversation. The memory choice is
 * always shown with "shared" as the default: for a first-ever chat the two are
 * equivalent (a fresh group is minted either way), so the copy speaks in "if any"
 * terms rather than probing for priors.
 */
export function NewChatDialog({
  open,
  onClose,
  characterId,
}: {
  open: boolean;
  onClose: () => void;
  /** Pre-picked character; omitted ⇒ the dialog shows a character picker. */
  characterId?: string;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [memory, setMemory] = useState<"shared" | "fresh">("shared");
  const [presetId, setPresetId] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsPicker = !characterId;
  const characters = useAsyncData(
    () =>
      open && needsPicker
        ? charactersApi.list()
        : Promise.resolve<ApiResult<CharacterSummary[]>>({ ok: true, data: [] }),
    [open, needsPicker],
  );
  const presets = useAsyncData(
    () => (open ? chatPresetsApi.list() : Promise.resolve<ApiResult<ChatPreset[]>>({ ok: true, data: [] })),
    [open],
  );
  const selectedId = characterId ?? picked;

  const filtered = useMemo(() => {
    const all = characters.data ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  }, [characters.data, filter]);

  const reset = () => {
    setPicked(null);
    setFilter("");
    setMemory("shared");
    setPresetId("");
    setTitle("");
    setError(null);
  };

  const close = () => {
    if (creating) return;
    reset();
    onClose();
  };

  const create = async () => {
    if (!selectedId || creating) return;
    setCreating(true);
    setError(null);
    const result = await chatsApi.create({
      characterId: selectedId,
      memory,
      title: title.trim() || undefined,
      presetId: presetId || undefined,
    });
    if (!result.ok) {
      setError(result.error.message || "could not create the conversation");
      setCreating(false);
      return;
    }
    // Leave `creating` set — the dialog unmounts with the navigation.
    router.push(`/chat/${result.data.id}`);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New conversation"
      footer={
        <>
          <Button onClick={close} disabled={creating}>
            Cancel
          </Button>
          <Button variant="primary" busy={creating} disabled={!selectedId} onClick={() => void create()}>
            Start chatting
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {needsPicker ? (
          <div>
            <p className="mb-2 text-xs tracking-wide text-paper-500 uppercase">Who with?</p>
            <Input placeholder="Filter characters…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="mt-2 grid max-h-56 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
              {characters.loading ? (
                <p className="col-span-full text-sm text-paper-500">Loading…</p>
              ) : filtered.length === 0 ? (
                <p className="col-span-full text-sm text-paper-500">No characters match.</p>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setPicked(c.id)}
                    aria-pressed={picked === c.id}
                    className={cx(
                      "flex flex-col items-center gap-1 rounded-md border p-1.5 text-center transition-colors",
                      picked === c.id
                        ? "border-accent-500 bg-ink-800"
                        : "border-transparent hover:border-ink-600 hover:bg-ink-800/60",
                    )}
                  >
                    <EntityImage imageId={c.avatarImageId} name={c.name} className="size-12 rounded-full text-sm" />
                    <span className="w-full truncate text-[11px] text-paper-300">{c.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs tracking-wide text-paper-500 uppercase">What do they remember?</p>
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2 text-sm">
              <input
                type="radio"
                name="chat-memory"
                checked={memory === "shared"}
                onChange={() => setMemory("shared")}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-paper-100">Continue our shared history</span>
                <span className="block text-xs text-paper-400">
                  They remember your past conversations (if any) — same relationship, new scene.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2 text-sm">
              <input
                type="radio"
                name="chat-memory"
                checked={memory === "fresh"}
                onChange={() => setMemory("fresh")}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-paper-100">Fresh start</span>
                <span className="block text-xs text-paper-400">
                  A clean slate — an alternate universe; nothing carries over in either direction.
                </span>
              </span>
            </label>
          </div>
        </div>

        {(presets.data?.length ?? 0) > 0 ? (
          <div>
            <p className="mb-1.5 text-xs tracking-wide text-paper-500 uppercase">Start from preset</p>
            <Select value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="Start from a saved scenario preset">
              <option value="">None — a blank scenario</option>
              {(presets.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] text-paper-600">
              Seeds the premise, outfit, cards, and starting relationship from a saved scenario.
            </p>
          </div>
        ) : null}

        <div>
          <p className="mb-1.5 text-xs tracking-wide text-paper-500 uppercase">Title (optional)</p>
          <Input
            placeholder="e.g. The winter visit"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {error ? <p className="text-sm text-danger-300">{error}</p> : null}
      </div>
    </Dialog>
  );
}
