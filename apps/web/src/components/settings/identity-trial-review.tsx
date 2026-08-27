"use client";

import { useState } from "react";
import {
  type ImageIdentityPackTrialReviewPairWire,
  perTrialGradeDimension,
  trialGradeDimensions,
  type TrialPairGrades,
  trialPromptFixtureById,
} from "@vesper/image-core";
import { adminIdentityPacksApi, identityPackTrialRefusal, imageUrl } from "@/lib/client/api";
import {
  identityPackTrialRefusalCopy,
  trialGradeDimensionLabel,
} from "@/components/characters/identity-pack-copy";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The blinded review screen: two images side by side, eleven anchored relative
 * grades,
 * catastrophic-defect labels per side, notes, submit — then the next pair loads
 * automatically. Everything here is LEFT/RIGHT: the wire pair deliberately
 * carries no strategy fields, and the server unblinds the submission with its
 * own persisted mapping, so nothing this screen holds could reveal which
 * strategy produced which side.
 */

/** The anchored ordinal scale: negative favors the left image, positive the right. */
const GRADE_CHOICES: { value: number; label: string }[] = [
  { value: -2, label: "Much better — left" },
  { value: -1, label: "Better — left" },
  { value: 0, label: "Tie" },
  { value: 1, label: "Better — right" },
  { value: 2, label: "Much better — right" },
];

/** Free-text defect labels, one per line, bounded to the wire limits (8 × 120 chars). */
function defectLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().slice(0, 120))
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

export function IdentityTrialReview({ runId }: { runId: string }) {
  const [generation, setGeneration] = useState(0);
  const next = useAsyncData(() => adminIdentityPacksApi.trial.nextPair(runId), [runId, generation]);

  if (next.error && !next.data) {
    return <ErrorState error={next.error} onRetry={() => next.reload()} />;
  }
  if (next.loading || !next.data) {
    return <Skeleton className="h-48 w-full" />;
  }

  const pair = next.data.pair;
  if (pair === null) {
    return (
      <p className="text-sm text-paper-500">
        Every reviewable pair has a grade. Render more cells, or open the summary to record verdicts.
      </p>
    );
  }

  // Keyed by pair id so a new pair remounts the form with fresh state — no
  // effect needed to reset grades when the queue advances.
  return <PairGradeForm key={pair.pairId} runId={runId} pair={pair} onDone={() => setGeneration((n) => n + 1)} />;
}

function PairGradeForm({
  runId,
  pair,
  onDone,
}: {
  runId: string;
  pair: ImageIdentityPackTrialReviewPairWire;
  onDone: () => void;
}) {
  const toast = useToast();
  const [grades, setGrades] = useState<TrialPairGrades>(() => perTrialGradeDimension(() => 0));
  const [catastrophicLeft, setCatastrophicLeft] = useState("");
  const [catastrophicRight, setCatastrophicRight] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fixture = trialPromptFixtureById(pair.promptFixtureId);

  const submit = async () => {
    setSubmitting(true);
    const result = await adminIdentityPacksApi.trial.grade(runId, {
      pairId: pair.pairId,
      grades,
      catastrophicLeft: defectLines(catastrophicLeft),
      catastrophicRight: defectLines(catastrophicRight),
      notes: notes.trim() === "" ? null : notes.trim(),
    });
    setSubmitting(false);
    if (!result.ok) {
      const refusal = identityPackTrialRefusal(result.error);
      toast.push({
        title: "Couldn't record the grade",
        description: refusal ? identityPackTrialRefusalCopy(refusal.code) : result.error.message,
        tone: "error",
      });
      // A duplicate means someone already graded this pair — advance past it.
      if (refusal?.code === "grade_conflict") onDone();
      return;
    }
    toast.push({ title: "Grade recorded", tone: "success" });
    onDone();
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm text-paper-300">
          <span className="text-[11px] tracking-wide text-paper-500 uppercase">{pair.task}</span>
          {fixture ? <span className="mt-1 block text-paper-400">{fixture.prompt}</span> : null}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            { side: "Left", imageId: pair.leftImageId },
            { side: "Right", imageId: pair.rightImageId },
          ] as const
        ).map((entry) => (
          <figure key={entry.side} className="rounded-card border border-ink-600 bg-ink-850 p-2">
            <figcaption className="mb-1 text-[11px] tracking-wide text-paper-500 uppercase">{entry.side}</figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element -- local asset route at natural size; next/image adds nothing here */}
            <img src={imageUrl(entry.imageId)} alt={`${entry.side} render`} className="w-full rounded" />
          </figure>
        ))}
      </div>

      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {trialGradeDimensions.map((dimension) => (
          <label key={dimension} className="flex items-center justify-between gap-3 text-sm text-paper-300">
            <span>{trialGradeDimensionLabel(dimension)}</span>
            <Select
              value={String(grades[dimension])}
              onChange={(e) =>
                setGrades((current) => ({ ...current, [dimension]: Number(e.target.value) }))
              }
              className="h-8 w-44 text-xs"
            >
              {GRADE_CHOICES.map((choice) => (
                <option key={choice.value} value={String(choice.value)}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </label>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Catastrophic defects — left" hint="One per line: second person, changed outfit, extra limb…">
          {(id) => (
            <Textarea id={id} rows={3} value={catastrophicLeft} onChange={(e) => setCatastrophicLeft(e.target.value)} />
          )}
        </Field>
        <Field label="Catastrophic defects — right" hint="Leave empty when the side has none.">
          {(id) => (
            <Textarea id={id} rows={3} value={catastrophicRight} onChange={(e) => setCatastrophicRight(e.target.value)} />
          )}
        </Field>
      </div>

      <Field label="Notes" hint="Anything the grades can't carry.">
        {(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}
      </Field>

      <div className="flex justify-end">
        <Button variant="primary" busy={submitting} onClick={() => void submit()}>
          Record grade &amp; next pair
        </Button>
      </div>
    </div>
  );
}
