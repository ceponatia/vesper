"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Diagnostic } from "@/contracts";
import {
  charactersApi,
  type CharacterDraft,
  type CharacterForgeSection,
} from "@/lib/client/api";
import { mergeCharacterSection } from "@/components/forge/draft-merge";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SaveBar } from "@/components/ui/save-bar";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { CharacterEditor } from "./character-editor";

/**
 * Prose prompt → AI draft → human review/edit → save (docs/authoring.md).
 * The draft lives in component state only; abandoning the page writes nothing.
 */
export function CharacterForgePage() {
  const router = useRouter();
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [forging, setForging] = useState(false);
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [regenerating, setRegenerating] = useState<CharacterForgeSection | null>(null);
  const [saving, setSaving] = useState(false);

  const forge = async () => {
    if (!prompt.trim()) return;
    setForging(true);
    const result = await charactersApi.forge({ prompt: prompt.trim() });
    setForging(false);
    if (result.ok) {
      setDraft(result.data.draft);
      setDiagnostics(result.data.diagnostics);
    } else {
      toast.push({ title: "Forge failed", description: result.error.message, tone: "error" });
    }
  };

  const regenerate = async (section: CharacterForgeSection) => {
    if (!draft) return;
    setRegenerating(section);
    const result = await charactersApi.forge({ prompt: prompt.trim(), section, draft });
    setRegenerating(null);
    if (result.ok) {
      setDraft((current) => (current ? mergeCharacterSection(current, result.data.draft, section) : result.data.draft));
      setDiagnostics(result.data.diagnostics);
    } else {
      toast.push({ title: `Couldn't regenerate ${section}`, description: result.error.message, tone: "error" });
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await charactersApi.create({
      name: draft.name || "Untitled character",
      tags: draft.tags,
      profile: draft.profile,
      suggestedItems: draft.suggestedItems,
    });
    setSaving(false);
    if (result.ok) {
      toast.push({ title: "Character saved", tone: "success" });
      router.push(`/characters/${result.data.id}`);
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
  };

  return (
    <PageContainer>
      <h1 className="prose-display mb-1 text-2xl">Character forge</h1>
      <p className="mb-6 text-sm text-paper-400">
        Describe someone; the forge drafts the profile, attributes and outfit. Everything stays editable.
      </p>

      <div className="mb-8 flex flex-col gap-3">
        <Field label="Prompt">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="a weary harbor-master in her forties, dry humor, bad knee, keeps the storm ledger…"
              disabled={forging}
            />
          )}
        </Field>
        <Button variant="primary" onClick={forge} busy={forging} disabled={!prompt.trim()} className="w-fit">
          {draft ? "Forge again" : "Forge draft"}
        </Button>
      </div>

      {forging && !draft ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-72" />
          <SkeletonText lines={6} />
        </div>
      ) : null}

      {draft ? (
        <>
          <CharacterEditor
            draft={draft}
            onChange={setDraft}
            onRegenerate={regenerate}
            regenerating={regenerating}
            diagnostics={diagnostics.filter((d) => d.severity !== "info")}
          />
          <SaveBar dirty={true} saving={saving} onSave={save} saveLabel="Save character" />
        </>
      ) : null}
    </PageContainer>
  );
}
