"use client";

import { useState } from "react";
import { meApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The account settings page (player-character.plan.md). Its first occupant is
 * the **default player character** — a light name + bio the user is represented
 * by in character chat. Reads/writes `/api/users/me`.
 */
export function SettingsPage() {
  const toast = useToast();
  const me = useAsyncData(() => meApi.get(), []);

  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed the form once from the loaded record (the React "adjust state while
  // rendering" pattern; a silent reload after save can't clobber edits).
  if (!seeded && me.data) {
    setSeeded(true);
    setName(me.data.playerPersona.name ?? "");
    setPersona(me.data.playerPersona.persona);
  }

  const accountName = me.data?.accountName ?? "";
  const effectiveName = name.trim() || accountName || "your account name";

  const save = async () => {
    setSaving(true);
    const result = await meApi.updatePersona({ name: name.trim() || undefined, persona: persona.trim() });
    setSaving(false);
    if (result.ok) {
      toast.push({ title: "Player character saved", tone: "success" });
      me.reload({ silent: true });
    } else {
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
          <h2 className="prose-display text-lg">Default player character</h2>
          <p className="mt-1 mb-4 text-sm text-paper-400">
            Who you are when you talk to a character one-on-one. In a session you can still embody a
            character from your library — this is the lightweight you for quick chats.
          </p>
          <div className="flex flex-col gap-4">
            <Field label="Name" hint={`Leave blank to use your account name${accountName ? ` (${accountName})` : ""}.`}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={accountName || "Your name"}
                  maxLength={80}
                />
              )}
            </Field>
            <Field
              label="About you"
              hint="A couple of sentences on who you are and how you come across. Characters read this."
            >
              {(id) => (
                <Textarea
                  id={id}
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="e.g. A traveling cartographer — curious, dry sense of humor, quick to listen."
                />
              )}
            </Field>
            <p className="text-xs text-paper-500">
              Characters will know you as <span className="text-paper-200">{effectiveName}</span>.
            </p>
            <div className="flex justify-end">
              <Button variant="primary" busy={saving} onClick={save}>
                Save
              </Button>
            </div>
          </div>
        </section>
      )}
    </PageContainer>
  );
}
