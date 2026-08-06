"use client";

import { useState } from "react";
import { identityReferenceStrategies, type IdentityReferenceStrategy } from "@/contracts";
import { IDENTITY_PACK_TRIAL_PROMPT_FIXTURES } from "@/lib/images/identity-pack-trial";
import { adminIdentityPacksApi, identityPackTrialRefusal, meApi } from "@/lib/client/api";
import {
  identityPackTrialRefusalCopy,
  identityReferenceStrategyLabel,
  trialCountsLine,
  trialRunStatusChip,
} from "@/components/characters/identity-pack-copy";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { IdentityTrialRunDetail } from "./identity-trial-run-detail";

/**
 * The identity-reference trial harness's admin page
 * (image-identity-packs.spec.trial.md; design doc Wave 3): plan a run over the
 * admin's own characters, execute it a few paid renders at a time, grade
 * blinded pairs, and record per-(profile, strategy) verdicts. The routes under
 * `/api/admin/self` are the real gate — they 404 for non-admins — so the check
 * here is only so a non-admin sees an explanation instead of failed requests.
 *
 * Characters and profiles are entered as pasted ids: no admin profile-listing
 * route exists yet, and the run's cells echo back exactly what each id resolved
 * to (or the refusal that stopped it), so a typo is visible in the planned grid
 * rather than silently absorbed.
 */

/** Non-empty trimmed lines of a paste-one-per-line textarea. */
function idLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function toggled<T>(current: readonly T[], value: T): T[] {
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
}

export function IdentityTrialsPage() {
  const me = useAsyncData(() => meApi.get(), []);
  const runs = useAsyncData(() => adminIdentityPacksApi.trial.list(), []);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const isAdmin = me.data?.role === "admin";

  if (me.loading && !me.data) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-56" />
      </PageContainer>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <h1 className="prose-display text-2xl">Identity trials</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  if (selectedRunId !== null) {
    return (
      <PageContainer>
        <IdentityTrialRunDetail
          runId={selectedRunId}
          onBack={() => {
            setSelectedRunId(null);
            runs.reload({ silent: true });
          }}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="prose-display text-2xl">Identity trials</h1>
          <p className="mt-1 text-sm text-paper-400">
            Blinded A/B runs comparing identity-reference strategies on fixed prompts, so a strategy is promoted on
            evidence rather than a hunch. Executing a run spends real render budget.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          New trial run
        </Button>
      </header>

      {runs.error ? <ErrorState error={runs.error} onRetry={() => runs.reload()} /> : null}
      {runs.loading && !runs.data ? <Skeleton className="h-24 w-full" /> : null}

      <div className="flex flex-col gap-3">
        {(runs.data ?? []).map((run) => {
          const chip = trialRunStatusChip(run.status);
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => setSelectedRunId(run.id)}
              className="rounded-card border border-ink-600 bg-ink-850 p-4 text-left transition-colors hover:border-ink-500"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium text-paper-200">{run.label}</h2>
                <Tag tone={chip.tone}>{chip.label}</Tag>
              </div>
              <p className="mt-1 text-[11px] text-paper-500">
                {trialCountsLine(run.counts)} · created {new Date(run.createdAt).toLocaleString()}
              </p>
            </button>
          );
        })}
        {runs.data?.length === 0 ? (
          <p className="text-sm text-paper-500">No trial runs yet. Plan one to compare reference strategies.</p>
        ) : null}
      </div>

      <CreateTrialRunDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(runId) => {
          setCreateOpen(false);
          runs.reload({ silent: true });
          setSelectedRunId(runId);
        }}
      />
    </PageContainer>
  );
}

function CreateTrialRunDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (runId: string) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [charactersText, setCharactersText] = useState("");
  const [profilesText, setProfilesText] = useState("");
  const [strategies, setStrategies] = useState<IdentityReferenceStrategy[]>([]);
  const [fixtureIds, setFixtureIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const characterIds = idLines(charactersText);
  const profileIds = idLines(profilesText);
  const ready =
    label.trim().length > 0 &&
    characterIds.length > 0 &&
    profileIds.length > 0 &&
    strategies.length > 0 &&
    fixtureIds.length > 0;

  const create = async () => {
    setCreating(true);
    const result = await adminIdentityPacksApi.trial.create({
      label: label.trim(),
      characterIds,
      profileIds,
      strategies,
      promptFixtureIds: fixtureIds,
    });
    setCreating(false);
    if (!result.ok) {
      const refusal = identityPackTrialRefusal(result.error);
      toast.push({
        title: "Couldn't plan that run",
        description: refusal ? identityPackTrialRefusalCopy(refusal.code) : result.error.message,
        tone: "error",
      });
      return;
    }
    toast.push({
      title: "Run planned",
      description: trialCountsLine(result.data.counts),
      tone: result.data.counts.planned > 0 ? "success" : "info",
    });
    onCreated(result.data.runId);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Plan a trial run"
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={creating} disabled={!ready} onClick={() => void create()}>
            Plan run
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Label" hint="What this run is testing, in your own words.">
          {(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Character ids" hint="One per line, up to 12. They must be your own characters.">
            {(id) => (
              <Textarea
                id={id}
                rows={4}
                value={charactersText}
                onChange={(e) => setCharactersText(e.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
          <Field
            label="Profile ids"
            hint="Registry profile ids, one per line, up to 6 — pasted for now (no admin profile list exists yet)."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={4}
                value={profilesText}
                onChange={(e) => setProfilesText(e.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
        </div>
        <Field label="Strategies" hint="Which reference strategies to compare. Pick at least two for pairs to exist.">
          <div className="flex flex-wrap gap-4">
            {identityReferenceStrategies.map((strategy) => (
              <label key={strategy} className="flex items-center gap-2 text-sm text-paper-300">
                <input
                  type="checkbox"
                  checked={strategies.includes(strategy)}
                  onChange={() => setStrategies((current) => toggled(current, strategy))}
                  className="accent-accent-500"
                />
                {identityReferenceStrategyLabel(strategy)}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Prompt fixtures" hint="Fixed, character-agnostic instructions — identity must come from the references.">
          <div className="flex flex-col gap-2">
            {IDENTITY_PACK_TRIAL_PROMPT_FIXTURES.map((fixture) => (
              <label key={fixture.id} className="flex items-start gap-2 text-sm text-paper-300" title={fixture.prompt}>
                <input
                  type="checkbox"
                  checked={fixtureIds.includes(fixture.id)}
                  onChange={() => setFixtureIds((current) => toggled(current, fixture.id))}
                  className="mt-1 accent-accent-500"
                />
                <span>
                  <code className="text-xs">{fixture.id}</code>
                  <span className="ml-2 text-[11px] text-paper-500">{fixture.task}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <p className="text-[11px] text-paper-600">
          Cells are characters × profiles × strategies × fixtures, capped at 96 per run. Planning is free; each Execute
          click is charged against the daily render budget.
        </p>
      </div>
    </Dialog>
  );
}
