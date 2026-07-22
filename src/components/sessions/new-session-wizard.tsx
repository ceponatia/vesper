"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { charactersApi, worldsApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { useDebouncedValue } from "@/components/hooks/use-debounced-value";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SkeletonCards } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

type Step = "world" | "embodiment" | "title";

/** /sessions/new wizard: world → embodiment → title → play (docs/ui.md). */
export function NewSessionWizard() {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();

  // Both pickers search server-side (name/tag + semantic): past LIST_LIMIT
  // entries, a client-only filter can't see rows that never loaded.
  const [worldQuery, setWorldQuery] = useState("");
  const worldSearch = useDebouncedValue(worldQuery.trim());
  const worlds = useAsyncData(() => worldsApi.list(worldSearch ? { q: worldSearch } : {}), [worldSearch]);
  const [characterQuery, setCharacterQuery] = useState("");
  const characterSearch = useDebouncedValue(characterQuery.trim());
  const characters = useAsyncData(
    () => charactersApi.list(characterSearch ? { q: characterSearch } : {}),
    [characterSearch],
  );

  const [step, setStep] = useState<Step>(searchParams.get("worldId") ? "embodiment" : "world");
  const [worldId, setWorldId] = useState<string | null>(searchParams.get("worldId"));
  /** Captured at pick time so searching the list away never blanks the title hint. */
  const [worldName, setWorldName] = useState<string | null>(null);
  const [embodied, setEmbodied] = useState(true);
  const [playerCharacterId, setPlayerCharacterId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [prefilledWorldId, setPrefilledWorldId] = useState<string | null>(null);

  const selectedWorld = (worlds.data ?? []).find((w) => w.id === worldId);
  const selectedWorldName = worldName ?? selectedWorld?.name;

  // Pre-fill embodiment from the world's default player character (UX-audit §1a) — a
  // changeable default: applied once per world, then the user owns the choice. Deferred
  // past a microtask to satisfy the no-sync-setState-in-effects rule.
  useEffect(() => {
    if (!selectedWorld || selectedWorld.id === prefilledWorldId) return;
    const id = selectedWorld.id;
    const defaultPlayer = selectedWorld.playerCharacterId ?? null;
    void Promise.resolve().then(() => {
      setPrefilledWorldId(id);
      setEmbodied(defaultPlayer !== null);
      setPlayerCharacterId(defaultPlayer);
    });
  }, [selectedWorld, prefilledWorldId]);

  const create = async () => {
    if (!worldId) return;
    setCreating(true);
    const result = await worldsApi.createSession(worldId, {
      title: title.trim() || `${selectedWorldName ?? "Session"} — first visit`,
      embodied,
      ...(embodied && playerCharacterId ? { playerCharacterId } : {}),
    });
    setCreating(false);
    if (result.ok) {
      router.push(`/sessions/${result.data.id}`);
    } else {
      toast.push({ title: "Couldn't start the session", description: result.error.message, tone: "error" });
    }
  };

  const steps: { id: Step; label: string }[] = [
    { id: "world", label: "World" },
    { id: "embodiment", label: "Embodiment" },
    { id: "title", label: "Title" },
  ];

  return (
    <PageContainer>
      <h1 className="prose-display mb-1 text-2xl">New session</h1>
      <ol className="mb-8 flex gap-2 text-xs text-paper-500">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            {i > 0 ? <span>·</span> : null}
            <span className={cx(step === s.id && "text-accent-300")}>{`${i + 1}. ${s.label}`}</span>
          </li>
        ))}
      </ol>

      {step === "world" ? (
        <section>
          <h2 className="mb-4 text-sm text-paper-300">Where does this story happen?</h2>
          <Input
            value={worldQuery}
            onChange={(e) => setWorldQuery(e.target.value)}
            placeholder="Search worlds…"
            aria-label="Search worlds"
            className="mb-4 max-w-72"
          />
          {worlds.loading ? (
            <SkeletonCards count={4} />
          ) : worlds.error ? (
            <ErrorState error={worlds.error} onRetry={() => worlds.reload()} />
          ) : (worlds.data ?? []).length === 0 ? (
            worldSearch ? (
              <p className="text-sm text-paper-500">No worlds match.</p>
            ) : (
              <EmptyState
                title="No worlds to play in"
                description="World-model sessions are retired — new worlds live on the successor engine under Worlds."
                action={
                  <Button variant="primary" onClick={() => router.push("/worlds")}>
                    Open Worlds
                  </Button>
                }
              />
            )
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {(worlds.data ?? []).map((world) => (
                <button
                  key={world.id}
                  type="button"
                  aria-pressed={worldId === world.id}
                  onClick={() => {
                    setWorldId(world.id);
                    setWorldName(world.name);
                  }}
                  className="text-left"
                >
                  <Card
                    interactive
                    className={cx(
                      "flex h-full gap-3 p-4",
                      worldId === world.id && "border-accent-500/70 bg-accent-500/10",
                    )}
                  >
                    <EntityImage imageId={world.imageId} name={world.name} className="h-16 w-24 shrink-0 rounded-md" />
                    <div className="min-w-0">
                      <p className="prose-display truncate">{world.name}</p>
                      {world.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-paper-400">{world.description}</p>
                      ) : null}
                    </div>
                  </Card>
                </button>
              ))}
            </div>
          )}
          <div className="mt-6 flex justify-end">
            <Button variant="primary" disabled={!worldId} onClick={() => setStep("embodiment")}>
              Next
            </Button>
          </div>
        </section>
      ) : null}

      {step === "embodiment" ? (
        <section>
          <h2 className="mb-4 text-sm text-paper-300">How do you want to be in the story?</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <button type="button" aria-pressed={embodied} onClick={() => setEmbodied(true)} className="text-left">
              <Card interactive className={cx("h-full p-5", embodied && "border-accent-500/70 bg-accent-500/10")}>
                <p className={cx("prose-display flex items-center justify-between", embodied && "text-accent-300")}>
                  Play a character
                  {embodied ? <span aria-hidden>✓</span> : null}
                </p>
                <p className="mt-1 text-xs text-paper-400">
                  You act and speak in-world; the narrator treats you as present.
                </p>
              </Card>
            </button>
            <button type="button" aria-pressed={!embodied} onClick={() => setEmbodied(false)} className="text-left">
              <Card interactive className={cx("h-full p-5", !embodied && "border-accent-500/70 bg-accent-500/10")}>
                <p className={cx("prose-display flex items-center justify-between", !embodied && "text-accent-300")}>
                  Observer
                  {!embodied ? <span aria-hidden>✓</span> : null}
                </p>
                <p className="mt-1 text-xs text-paper-400">
                  You direct from outside the story; the cast carries the scenes.
                </p>
              </Card>
            </button>
          </div>

          {embodied ? (
            <div className="mt-6">
              <h3 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">
                Play as (optional)
              </h3>
              <Input
                value={characterQuery}
                onChange={(e) => setCharacterQuery(e.target.value)}
                placeholder="Search characters…"
                aria-label="Search characters"
                className="mb-3 max-w-72"
              />
              {characters.error ? (
                <ErrorState error={characters.error} onRetry={() => characters.reload()} />
              ) : (characters.data ?? []).length === 0 ? (
                <p className="text-sm text-paper-500">
                  {characterSearch
                    ? "No characters match."
                    : "No library characters — you can still play; describe yourself in your first message."}
                </p>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {(characters.data ?? []).map((character) => (
                    <button
                      key={character.id}
                      type="button"
                      aria-pressed={playerCharacterId === character.id}
                      onClick={() =>
                        setPlayerCharacterId(playerCharacterId === character.id ? null : character.id)
                      }
                      className={cx(
                        "flex w-24 cursor-pointer flex-col items-center gap-1.5 rounded-card border p-3 transition-colors",
                        playerCharacterId === character.id
                          ? "border-accent-500/70 bg-accent-500/10"
                          : "border-ink-600 hover:border-ink-500",
                      )}
                    >
                      <EntityImage
                        imageId={character.avatarImageId}
                        name={character.name}
                        className="size-14 rounded-full"
                      />
                      <span className="w-full truncate text-center text-xs text-paper-300">{character.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          <div className="mt-6 flex justify-between">
            <Button onClick={() => setStep("world")}>Back</Button>
            <Button variant="primary" onClick={() => setStep("title")}>
              Next
            </Button>
          </div>
        </section>
      ) : null}

      {step === "title" ? (
        <section className="max-w-md">
          <Field label="Session title" hint={selectedWorldName ? `In ${selectedWorldName}.` : undefined}>
            {(id) => (
              <Input
                id={id}
                value={title}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`${selectedWorldName ?? "Somewhere"} — first visit`}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
            )}
          </Field>
          <div className="mt-6 flex justify-between">
            <Button onClick={() => setStep("embodiment")}>Back</Button>
            <Button variant="primary" onClick={create} busy={creating} disabled={!worldId}>
              Begin
            </Button>
          </div>
        </section>
      ) : null}
    </PageContainer>
  );
}
