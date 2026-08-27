"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { chatInspectorApi, type InspectorEpisode } from "@/lib/api-inspector";

/**
 * The inspector's Episodes section: every episode with its exchange ordinal,
 * click-to-edit summary (re-embeds on save), hard delete, and a "score against
 * query" probe — the same cosine +
 * embedder-isolation math live retrieval uses, so retrieval quality can be
 * eyeballed per row. Scoring re-sorts the list best-first; rows without a
 * matching embedding show "—".
 */
export function ChatInspectorEpisodes({
  chatId,
  episodes,
  onChanged,
}: {
  chatId: string;
  episodes: InspectorEpisode[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scoring, setScoring] = useState(false);
  const [scores, setScores] = useState<Record<string, number> | null>(null);
  const [scoreDegraded, setScoreDegraded] = useState(false);

  const score = async () => {
    const q = query.trim();
    if (!q || scoring) return;
    setScoring(true);
    setError(null);
    const result = await chatInspectorApi.scoreEpisodes(chatId, q);
    setScoring(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setScoreDegraded(result.data.degraded);
    setScores(Object.fromEntries(result.data.scores.map((s) => [s.id, s.score])));
  };

  const clearScores = () => {
    setScores(null);
    setScoreDegraded(false);
  };

  const ordered = scores ? [...episodes].sort((a, b) => (scores[b.id] ?? -1) - (scores[a.id] ?? -1)) : episodes;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">
        Episodes <span className="text-paper-600">({episodes.length})</span>
      </h2>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          maxLength={300}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void score();
          }}
          placeholder="Score against a test query…"
          className="w-72 max-w-full"
        />
        <Button size="sm" busy={scoring} disabled={!query.trim()} onClick={() => void score()}>
          Score
        </Button>
        {scores ? (
          <Button size="sm" variant="quiet" onClick={clearScores}>
            Clear scores
          </Button>
        ) : null}
      </div>
      {scoreDegraded ? (
        <p className="text-xs text-danger-300">Query embedding failed — no scores this run.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger-300">
          {error}
        </p>
      ) : null}

      {episodes.length === 0 ? (
        <p className="text-xs text-paper-600">No episodes stored yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {ordered.map((episode) => (
            <EpisodeRow
              key={episode.id}
              chatId={chatId}
              episode={episode}
              score={scores ? (scores[episode.id] ?? null) : null}
              scored={scores !== null}
              onChanged={onChanged}
              onError={setError}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EpisodeRow({
  chatId,
  episode,
  score,
  scored,
  onChanged,
  onError,
}: {
  chatId: string;
  episode: InspectorEpisode;
  score: number | null;
  scored: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [embedNote, setEmbedNote] = useState<string | null>(null);

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    onError(null);
    const result = await chatInspectorApi.updateEpisode(chatId, episode.id, trimmed);
    setBusy(false);
    if (!result.ok) {
      onError(result.error.message);
      return;
    }
    setEmbedNote(
      result.data.embedDegraded
        ? "Re-embed failed — summary saved, but this episode is out of similarity retrieval until re-embedded."
        : null,
    );
    setEditing(false);
    onChanged();
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    const result = await chatInspectorApi.deleteEpisode(chatId, episode.id);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      onError(result.error.message);
      return;
    }
    onChanged();
  };

  return (
    <div className="rounded-card border border-ink-600 bg-ink-800 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-paper-500">#{episode.turnNumber}</span>
        {episode.embedded ? null : <Tag tone="danger">no embedding</Tag>}
        {scored ? (
          <Tag tone={score !== null ? "accent" : "default"} title="Cosine similarity to the test query">
            {score !== null ? score.toFixed(3) : "—"}
          </Tag>
        ) : null}
        {episode.createdAt ? (
          <span className="ml-auto text-[11px] text-paper-600">{episode.createdAt.slice(0, 10)}</span>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea rows={3} value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" busy={busy} disabled={!draft.trim()} onClick={() => void save()}>
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
            setDraft(episode.summary);
            setEditing(true);
          }}
          className="mt-1.5 block w-full cursor-text rounded text-left text-sm text-paper-200 hover:bg-ink-750"
        >
          {episode.summary}
        </button>
      )}

      {embedNote ? <p className="mt-1 text-[11px] text-danger-300">{embedNote}</p> : null}

      <div className="mt-1.5 flex items-center gap-0.5">
        {confirming ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className={cx(
                "cursor-pointer rounded px-2 py-1 text-[11px] text-danger-300 hover:text-danger-200",
                "disabled:cursor-not-allowed disabled:text-paper-600",
              )}
            >
              Really delete?
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="cursor-pointer rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200"
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="cursor-pointer rounded px-2 py-1 text-[11px] text-paper-500 hover:text-danger-400 disabled:cursor-not-allowed disabled:text-paper-600"
          >
            Delete…
          </button>
        )}
      </div>
    </div>
  );
}
