"use client";

import Link from "next/link";
import { useState } from "react";
import { ChatInspectorAgentHealth } from "@/components/chat/chat-inspector-agent-health";
import { ChatInspectorCompositionHealth } from "@/components/chat/chat-inspector-composition-health";
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
 * The owner-admin memory inspector for one conversation. The client gate is UX;
 * `/api/admin/self/chat-inspector` separately requires the admin role and proves
 * that the current administrator owns the requested chat before returning or
 * mutating any memory.
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
          {/* Composed-turn health beside agent health: the choreography degrades as silently as
              the agent legs do — a "traveled alone" reads exactly like a normal turn (C15). */}
          <ChatInspectorCompositionHealth chatId={chatId} />
          <ChatInspectorFacts
            chatId={chatId}
            characterName={data.character.name}
            facts={data.facts}
            onChanged={reloadSilent}
          />
          <ChatInspectorEpisodes chatId={chatId} episodes={data.episodes} onChanged={reloadSilent} />
          <SummaryEditor chatId={chatId} summary={data.summary} onSaved={reloadSilent} />
          <PromptPreview chatId={chatId} />
        </div>
      ) : null}
    </PageContainer>
  );
}

function SummaryEditor({
  chatId,
  summary,
  onSaved,
}: {
  chatId: string;
  summary: InspectorSummary | null;
  onSaved: () => void;
}) {
  const [text, setText] = useState(summary?.summary ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await chatInspectorApi.updateSummary(chatId, text);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save summary");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">Rolling summary</h2>
        <span className="text-[11px] text-paper-600">
          {summary ? `${summary.coveredExchanges} exchanges covered` : "No summary row"}
        </span>
      </div>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        maxLength={4000}
        placeholder="No rolling summary yet."
      />
      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save summary"}
        </Button>
        {summary?.watermarkAt ? (
          <span className="text-xs text-paper-600">Watermark {summary.watermarkAt}</span>
        ) : null}
      </div>
      {error ? <p className="text-xs text-danger-300">{error}</p> : null}
    </section>
  );
}

function PromptPreview({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const prompt = useAsyncData(() => (open ? chatInspectorApi.prompt(chatId) : Promise.resolve(null)), [chatId, open]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium tracking-wide text-paper-400 uppercase">Narrator prompt preview</h2>
          <p className="mt-1 text-xs text-paper-600">Read-only reconstruction of what the next exchange would send.</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide prompt" : "Build prompt"}
        </Button>
      </div>
      {open ? (
        prompt.loading ? (
          <Skeleton className="h-48 w-full rounded-card" aria-hidden="true" />
        ) : prompt.error ? (
          <ErrorState error={prompt.error} onRetry={() => prompt.reload()} />
        ) : prompt.data ? (
          <div className="flex flex-col gap-3 rounded-card border border-paper-800 bg-paper-950/50 p-4">
            <PromptBlock label="System prefix" value={prompt.data.prefix} />
            <PromptBlock label="Turn tail" value={prompt.data.tail} />
            <PromptBlock label="Memory queries" value={prompt.data.memoryQueries.join("\n")} />
            <PromptBlock label="Facts selected" value={prompt.data.memory.facts.join("\n")} />
            <PromptBlock label="Episodes selected" value={prompt.data.memory.episodes.join("\n")} />
          </div>
        ) : null
      ) : null}
    </section>
  );
}

function PromptBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium tracking-wide text-paper-500 uppercase">{label}</h3>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-paper-900/70 p-3 text-xs text-paper-300">
        {value || "—"}
      </pre>
    </div>
  );
}
