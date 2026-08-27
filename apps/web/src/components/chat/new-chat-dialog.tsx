"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { engineComparisonApi } from "@/lib/api-engine-comparison";
import { charactersApi, chatPresetsApi, chatsApi, type ApiResult, type CharacterSummary, type ChatPreset } from "@/lib/client/api";

/** Roster cap — mirrors the server's MAX_CHAT_PARTICIPANTS; 2–4 is the typical roster. */
const MAX_PICKS = 4;

/**
 * Start a conversation: pick one or more characters (skipped when the caller
 * already knows one — the editor tab / a library card), choose the D7 memory mode,
 * optionally start from a saved scenario preset (the server seeds the new
 * conversation's state from it), optionally title it, then create + navigate to the
 * full-screen conversation. Selection order matters: the first pick is the
 * conversation's primary participant; every pick joins as a full roster member of
 * the ensemble exchange. The memory choice is always shown with "shared" as the
 * default: for a first-ever chat the two are equivalent (a fresh group is minted
 * either way), so the copy speaks in "if any" terms rather than probing for priors.
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
  const isAdmin = useIsAdmin();
  /** Selection order preserved — index 0 is the primary participant. */
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState(""); // debounced → server q
  const [memory, setMemory] = useState<"shared" | "fresh">("shared");
  const [presetId, setPresetId] = useState("");
  const [title, setTitle] = useState("");
  const [engineComparison, setEngineComparison] = useState(false);
  /** If chat creation succeeded but comparison setup failed, retry the setup only. */
  const [createdChatId, setCreatedChatId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The filter re-queries the server (name/tag + semantic match) instead of
  // narrowing the capped first page — past LIST_LIMIT characters, a client-only
  // filter can't see rows that never loaded.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);
  const onFilter = (value: string) => {
    setFilter(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(value.trim()), 250);
  };

  const needsPicker = !characterId;
  const characters = useAsyncData(
    () =>
      open && needsPicker
        ? charactersApi.list(search ? { q: search } : {})
        : Promise.resolve<ApiResult<CharacterSummary[]>>({ ok: true, data: [] }),
    [open, needsPicker, search],
  );
  const presets = useAsyncData(
    () => (open ? chatPresetsApi.list() : Promise.resolve<ApiResult<ChatPreset[]>>({ ok: true, data: [] })),
    [open],
  );
  const selectedIds = characterId ? [characterId] : picked;
  const filtered = characters.data ?? [];
  const comparisonEligible = selectedIds.length === 1;

  const togglePick = (id: string) => {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : prev.length < MAX_PICKS ? [...prev, id] : prev,
    );
  };

  const reset = () => {
    setPicked([]);
    setFilter("");
    setSearch("");
    setMemory("shared");
    setPresetId("");
    setTitle("");
    setEngineComparison(false);
    setCreatedChatId(null);
    setError(null);
  };

  const close = () => {
    if (creating) return;
    reset();
    onClose();
  };

  const create = async () => {
    if ((selectedIds.length === 0 && createdChatId === null) || creating) return;
    setCreating(true);
    setError(null);

    let chatId = createdChatId;
    if (chatId === null) {
      const result = await chatsApi.create({
        characterIds: selectedIds,
        memory,
        title: title.trim() || undefined,
        presetId: presetId || undefined,
      });
      if (!result.ok) {
        setError(result.error.message || "could not create the conversation");
        setCreating(false);
        return;
      }
      chatId = result.data.id;
    }

    if (isAdmin && engineComparison && comparisonEligible) {
      const started = await engineComparisonApi.start(chatId);
      if (!started.ok) {
        // The conversation itself already exists. Keep its id so another click
        // retries ONLY comparison setup instead of minting a duplicate chat.
        setCreatedChatId(chatId);
        setError(`Conversation created, but Engine Comparison could not start: ${started.error.message}`);
        setCreating(false);
        return;
      }
    }

    // Leave `creating` set — the dialog unmounts with the navigation.
    router.push(`/chat/${chatId}`);
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
          <Button
            variant="primary"
            busy={creating}
            disabled={selectedIds.length === 0 && createdChatId === null}
            onClick={() => void create()}
          >
            {createdChatId ? "Retry comparison" : "Start chatting"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {needsPicker ? (
          <div>
            <p className="mb-2 text-xs tracking-wide text-paper-500 uppercase">Who with? (up to {MAX_PICKS})</p>
            <Input placeholder="Search characters…" value={filter} onChange={(e) => onFilter(e.target.value)} />
            <div className="mt-2 grid max-h-56 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
              {characters.loading ? (
                <p className="col-span-full text-sm text-paper-500">Loading…</p>
              ) : filtered.length === 0 ? (
                <p className="col-span-full text-sm text-paper-500">No characters match.</p>
              ) : (
                filtered.map((c) => {
                  const order = picked.indexOf(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => togglePick(c.id)}
                      aria-pressed={order >= 0}
                      className={cx(
                        "relative flex flex-col items-center gap-1 rounded-md border p-1.5 text-center transition-colors",
                        order >= 0
                          ? "border-accent-500 bg-ink-800"
                          : "border-transparent hover:border-ink-600 hover:bg-ink-800/60",
                      )}
                    >
                      {order >= 0 && picked.length > 1 ? (
                        <span
                          aria-hidden
                          className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-accent-500 text-[10px] font-semibold text-ink-900"
                        >
                          {order + 1}
                        </span>
                      ) : null}
                      <EntityImage imageId={c.avatarImageId} name={c.name} className="size-12 rounded-full text-sm" />
                      <span className="w-full truncate text-[11px] text-paper-300">{c.name}</span>
                    </button>
                  );
                })
              )}
            </div>
            {picked.length > 1 ? (
              <p className="mt-1.5 text-[11px] text-paper-600">
                Everyone you pick joins the conversation — the first pick is the primary, who anchors the scene and
                leads when others are away.
              </p>
            ) : null}
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

        {isAdmin ? (
          <label
            className={cx(
              "flex items-start gap-2 rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2 text-sm",
              comparisonEligible ? "cursor-pointer" : "opacity-60",
            )}
          >
            <input
              type="checkbox"
              checked={engineComparison && comparisonEligible}
              disabled={!comparisonEligible}
              onChange={(e) => setEngineComparison(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-paper-100">Run Engine Comparison</span>
              <span className="block text-xs text-paper-400">
                Keep the legacy chat playable while a neutral successor mirror evaluates the same turns for review.
              </span>
              {!comparisonEligible ? (
                <span className="mt-0.5 block text-[11px] text-paper-500">Currently available for one-on-one conversations only.</span>
              ) : null}
            </span>
          </label>
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
