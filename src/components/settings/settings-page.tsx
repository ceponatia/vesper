"use client";

import Link from "next/link";
import { useState } from "react";
import { meApi, personasApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/**
 * The account settings page. Its occupant is the **default persona** — which of your
 * personas new chats start as (persona-library.plan.md slice 6).
 *
 * This used to be a two-field name + bio form writing the inline `users.playerPersona`
 * blob. That blob is gone (migration 0052 backfilled it into a real persona row, 0053
 * dropped the column), so *authoring* who you are moved to the persona editor and this
 * page is only the pick. It is the ladder's middle rung: a chat with no persona of its
 * own starts as whatever is chosen here.
 */
export function SettingsPage() {
  const toast = useToast();
  const me = useAsyncData(() => meApi.get(), []);
  const personas = useAsyncData(() => personasApi.list({ sort: "name" }), []);

  const [saving, setSaving] = useState(false);
  /** Optimistic pick — the select shows it immediately; a failed save reverts. */
  const [picked, setPicked] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  // Seed once from the loaded record (the "adjust state while rendering" pattern), so a
  // silent reload after save can't clobber the pick.
  if (!seeded && me.data) {
    setSeeded(true);
    setPicked(me.data.defaultPersonaId);
  }

  const accountName = me.data?.accountName ?? "";
  const rows = personas.data ?? [];
  const current = rows.find((p) => p.id === picked);

  const save = async (next: string | null) => {
    const previous = picked;
    setPicked(next);
    setSaving(true);
    const result = await meApi.setDefaultPersona(next);
    setSaving(false);
    if (result.ok) {
      toast.push({ title: next ? "Default persona set" : "Default persona cleared", tone: "success" });
      me.reload({ silent: true });
    } else {
      setPicked(previous);
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
  };

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="prose-display text-2xl">Settings</h1>
        <p className="mt-1 text-sm text-paper-400">Your account and how you appear in the app.</p>
      </header>

      {me.loading && !me.data ? (
        <div className="space-y-3 rounded-card border border-ink-600 bg-ink-850 p-5">
          <Skeleton className="h-5 w-44" />
          <SkeletonText lines={3} />
        </div>
      ) : me.error && !me.data ? (
        <ErrorState error={me.error} onRetry={() => me.reload()} />
      ) : (
        <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
          <h2 className="prose-display text-lg">Default persona</h2>
          <p className="mt-1 mb-4 text-sm text-paper-400">
            Who you are when you start a new conversation. Each chat can play as a different persona — this is
            just the one it starts with.
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-paper-400">
              You don&apos;t have any personas yet.{" "}
              <Link href="/personas" className="text-paper-200 underline underline-offset-4">
                Build one
              </Link>{" "}
              — a name, a body, and a couple of sentences about who you are.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <Field label="Play as" hint="Personas are built in your library.">
                {(id) => (
                  <Select
                    id={id}
                    value={picked ?? ""}
                    disabled={saving}
                    onChange={(e) => void save(e.target.value || null)}
                  >
                    <option value="">— None (characters use your account name) —</option>
                    {rows.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="text-xs text-paper-500">
                {current ? (
                  <>
                    New chats will know you as <span className="text-paper-200">{current.name}</span>.{" "}
                    <Link href={`/personas/${current.id}`} className="underline underline-offset-4">
                      Edit this persona
                    </Link>
                  </>
                ) : (
                  <>
                    New chats will know you as{" "}
                    <span className="text-paper-200">{accountName || "your account name"}</span>.
                  </>
                )}
              </p>
              <div className="flex justify-end">
                <Button onClick={() => void personas.reload()}>Refresh list</Button>
              </div>
            </div>
          )}
        </section>
      )}
    </PageContainer>
  );
}
