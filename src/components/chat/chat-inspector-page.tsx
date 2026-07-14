"use client";

import Link from "next/link";
import { useState } from "react";
import { ChatInspectorAgentHealth } from "@/components/chat/chat-inspector-agent-health";
import { ChatInspectorEpisodes } from "@/components/chat/chat-inspector-episodes";
import { ChatInspectorFacts } from "@/components/chat/chat-inspector-facts";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { chatInspectorApi, type InspectorSummary } from "@/lib/api-inspector";

/**
 * The dev memory inspector for one conversation (`/chat/[chatId]/inspector`,
 * character-chat-standalone.spec.md §6.1): full visibility + editability of
 * everything stored — facts (all statuses), episodes (+ retrieval scoring), the
 * rolling summary, and the rebuilt "what reaches the narrator now" prompt.
 * Admin-gated client-side via `useIsAdmin` (false until confirmed, so
 * non-admins — and everyone, briefly — see a plain "Not found." fallback); the
 * `/api/admin/chat-inspector` family is additionally role-gated server-side
 * (404 for non-admins) — real enforcement lives there, not in this UI gate.
 */
export function ChatInspectorPage({ chatId }: { chatId: string }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <PageContainer>
        <p className="text-sm text-paper-500">Not found.</p>
      </PageContainer>
    );
  }
  return <InspectorBody chatId={chatId} />;
}

function InspectorBody({ chatId }: { chatId: string }) {
  const overview = useAsyncData(() => chatInspectorApi.overview(chatId), [chatId]);
  const data = overview.data;
  const reloadSilent = () => overview.reload({ silent: true });

  return (
    <PageContainer>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="prose-display text-2xl">Memory inspector</h1>
          <p className="mt-1 text-sm text-paper-400">
            {data?.character.name
              ? `Everything stored for ${data.character.name} in this conversation.`
              : "Everything stored for this conversation."}
          </p>
        </div>
        <Link href={`/chat/${chatId}`} className="text-sm text-accent-300 hover:text-accent-200">
          ← Back to conversation
        </Link>
      </div>

      {overview.loading ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-card" />
          ))}
        </div>
      ) : overview.error ? (
        <ErrorState error={overview.error} onRetry={() => overview.reload()} />
      ) : data ? (
        <div className="flex flex-col gap-8 pb-10">
          {/* Agent health leads: a leg failing silently is the thing you most want to know
              BEFORE you start reading the memory it was supposed to have written. */}
          <ChatInspectorAgentHealth chatId={chatId} />
          <ChatInspectorFacts
            chatId={chatId}
            characterName={data.character.name}
            facts={data.facts}
            onChanged={reloadSilent}
          />
          <ChatInspectorEpisodes chatId={chatId} episodes={data.episodes} onChanged={reloadSilent} />
          <SummarySection chatId={chatId} summary={data.summary} onSaved={reloadSilent} />
          <PromptSection chatId={chatId} />
        </div>
      ) : null}
    </PageContainer>
  );
}

function SummarySection({
  chatId,
  summary,
  onSaved,
}: {
  chatId: string;
  summary: InspectorSummary | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(summary?.summary ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await chatInspectorApi.updateSummary(chatId, draft);
    setSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSaved(true);
    onSaved();
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">Rolling summary</h2>
      <Textarea
        rows={6}
        value={draft}
        maxLength={4000}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        placeholder="No rolling summary yet — everything is still inside the verbatim window."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" busy={saving} onClick={() => void save()}>
          Save summary
        </Button>
        {saved ? <span className="text-xs text-ok-400">Saved.</span> : null}
        {error ? (
          <span role="alert" className="text-xs text-danger-300">
            {error}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-paper-600">
          {summary
            ? `covers ${summary.coveredExchanges} exchange${summary.coveredExchanges === 1 ? "" : "s"} · watermark ${
                summary.watermarkAt ? summary.watermarkAt.slice(0, 16).replace("T", " ") : "none"
              }`
            : "no summary row yet"}
        </span>
      </div>
    </section>
  );
}

function PromptSection({ chatId }: { chatId: string }) {
  const prompt = useAsyncData(() => chatInspectorApi.prompt(chatId), [chatId]);
  const data = prompt.data;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">
          Prompt — what reaches the narrator now
        </h2>
        <Button size="sm" onClick={() => prompt.reload()} disabled={prompt.loading}>
          Refresh
        </Button>
      </div>

      {prompt.loading ? (
        <Skeleton className="h-32 w-full rounded-card" aria-hidden="true" />
      ) : prompt.error ? (
        <ErrorState error={prompt.error} onRetry={() => prompt.reload()} />
      ) : data ? (
        <>
          <p className="text-xs text-paper-500">
            Recall: {data.memory.facts.length} fact{data.memory.facts.length === 1 ? "" : "s"} ·{" "}
            {data.memory.episodes.length} episode{data.memory.episodes.length === 1 ? "" : "s"} · queries:{" "}
            <span className="text-paper-400">{data.memoryQueries.length ? data.memoryQueries.join("; ") : "—"}</span>
          </p>
          <PromptBlock label="Prefix (cache-stable)" text={data.prefix} defaultOpen />
          <PromptBlock label="Tail (per-turn)" text={data.tail} defaultOpen />
        </>
      ) : null}
    </section>
  );
}

const encoder = new TextEncoder();

function PromptBlock({ label, text, defaultOpen }: { label: string; text: string; defaultOpen?: boolean }) {
  return (
    <details className="rounded-card border border-ink-600 bg-ink-950/40" open={defaultOpen}>
      <summary className="cursor-pointer px-3 py-2 text-xs text-paper-300 select-none">
        {label} · {encoder.encode(text).length.toLocaleString()} bytes
      </summary>
      <pre className="overflow-x-auto border-t border-ink-600 p-3 font-mono text-xs leading-relaxed text-paper-300">
        {text || "(empty)"}
      </pre>
    </details>
  );
}
