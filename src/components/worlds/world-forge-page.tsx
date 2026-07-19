"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Diagnostic } from "@/contracts";
import { worldsApi, type WorldDraft, type WorldForgeSection } from "@/lib/client/api";
import { mergeWorldSection } from "@/components/forge/draft-merge";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SaveBar } from "@/components/ui/save-bar";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { WorldEditor } from "./world-editor";

/** Prose premise → parallel agent draft → tabbed review → save (docs/authoring.md). */
export function WorldForgePage() {
  const router = useRouter();
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  // Auto-generate counts (UX-audit §1b): 0–5 each; 0 ⇒ skip (import your own). Defaults match the forge's prior ranges.
  const [locationCount, setLocationCount] = useState(4);
  const [characterCount, setCharacterCount] = useState(3);
  const [forging, setForging] = useState(false);
  const [draft, setDraft] = useState<WorldDraft | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [regenerating, setRegenerating] = useState<WorldForgeSection | null>(null);
  const [saving, setSaving] = useState(false);

  const forge = async () => {
    if (!prompt.trim()) return;
    setForging(true);
    const result = await worldsApi.forge({ prompt: prompt.trim(), locationCount, characterCount });
    setForging(false);
    if (result.ok) {
      setDraft(result.data.draft);
      setDiagnostics(result.data.diagnostics);
    } else {
      toast.push({ title: "Forge failed", description: result.error.message, tone: "error" });
    }
  };

  const regenerate = async (section: WorldForgeSection) => {
    if (!draft) return;
    setRegenerating(section);
    const result = await worldsApi.forge({ prompt: prompt.trim(), section, draft, locationCount, characterCount });
    setRegenerating(null);
    if (result.ok) {
      setDraft((current) => (current ? mergeWorldSection(current, result.data.draft, section) : result.data.draft));
      setDiagnostics(result.data.diagnostics);
    } else {
      toast.push({ title: `Couldn't regenerate ${section}`, description: result.error.message, tone: "error" });
    }
  };

  const newCastCount = draft?.castSuggestions.filter((c) => !c.existingCharacterId && c.name.trim()).length ?? 0;

  // One-click remediation for a dropped map link (UX-audit M2): mint the missing
  // location, reconnect the rooms that referenced it, and clear the diagnostics it raised.
  const createMissingLocation = (name: string) => {
    const froms = diagnostics
      .filter((d) => d.context?.kind === "missing_location" && d.context?.missingLocation === name)
      .map((d) => (typeof d.context?.from === "string" ? d.context.from : null))
      .filter((f): f is string => f !== null);
    setDraft((current) => {
      if (!current) return current;
      const exists = current.locations.some((l) => l.name.toLowerCase() === name.toLowerCase());
      const locations = exists
        ? current.locations
        : [...current.locations, { name, description: "", ambient: {}, scale: "room" as const, tags: [], links: [] }];
      const relinked = locations.map((l) =>
        froms.some((f) => f.toLowerCase() === l.name.toLowerCase()) && !l.links.includes(name)
          ? { ...l, links: [...l.links, name] }
          : l,
      );
      return { ...current, locations: relinked };
    });
    setDiagnostics((prev) =>
      prev.filter((d) => !(d.context?.kind === "missing_location" && d.context?.missingLocation === name)),
    );
    toast.push({ title: `Added “${name}” to the map — open the Map tab to flesh it out`, tone: "success" });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await worldsApi.createFromDraft(draft);
    setSaving(false);
    if (result.ok) {
      const notices = result.data.diagnostics.filter((d) => d.severity !== "info");
      toast.push({
        title: "World saved",
        tone: "success",
        ...(notices.length > 0
          ? { description: `${notices.length} notice${notices.length === 1 ? "" : "s"} — review in the world editor.` }
          : {}),
      });
      router.push(`/worlds/${result.data.id}`);
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
  };

  return (
    <PageContainer wide>
      <h1 className="prose-display mb-1 text-2xl">World forge</h1>
      <p className="mb-6 text-sm text-paper-400">
        Give it a premise; agents draft the map, lore, cast and furnishings — every secret wired to a
        discovery arc. Review and reshape anything before saving.
      </p>

      <div className="mb-8 flex flex-col gap-3">
        <Field label="Premise">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="a fog-bound harbor town where the lighthouse keeper went missing a week ago…"
              disabled={forging}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field label="Locations" hint="How many to generate. 0 = none (import your own).">
            {(id) => (
              <Select
                id={id}
                value={locationCount}
                onChange={(e) => setLocationCount(Number(e.target.value))}
                disabled={forging}
                className="w-24"
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Characters" hint="How many to generate. 0 = none (import your own).">
            {(id) => (
              <Select
                id={id}
                value={characterCount}
                onChange={(e) => setCharacterCount(Number(e.target.value))}
                disabled={forging}
                className="w-24"
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Button variant="primary" onClick={forge} busy={forging} disabled={!prompt.trim()} className="w-fit">
          {draft ? "Forge again" : "Forge draft"}
        </Button>
      </div>

      {forging && !draft ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-full max-w-96" />
          <SkeletonText lines={8} />
        </div>
      ) : null}

      {draft ? (
        <>
          <WorldEditor
            draft={draft}
            onChange={setDraft}
            onRegenerate={regenerate}
            regenerating={regenerating}
            diagnostics={diagnostics.filter((d) => d.severity !== "info")}
            onCreateLocation={createMissingLocation}
          />
          {saving && newCastCount > 0 ? (
            <p className="mt-4 text-sm text-paper-400">
              Forging {Math.min(newCastCount, 5)} new cast member{Math.min(newCastCount, 5) === 1 ? "" : "s"} — this can
              take a minute…
            </p>
          ) : null}
          <SaveBar dirty={true} saving={saving} onSave={save} saveLabel="Save world" />
        </>
      ) : null}
    </PageContainer>
  );
}
