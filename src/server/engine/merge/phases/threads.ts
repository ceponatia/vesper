import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { storyThreadSchema, type StoryThread, type StoryThreadDevelopment } from "@/contracts/state/session-runtime";
import type { DirectorResult } from "@/contracts/turns/agent-results";
import { newId } from "@/lib/ids";
import { cosineSimilarity } from "../../../memory";
import { THREAD_COOLING_TURNS, THREAD_DEDUPE_MIN_SCORE, THREAD_DEVELOPMENTS_CAP } from "../../constants";
import type { PhaseContext } from "../types";
import { MAX_THREAD_PROPOSALS } from "./caps";

type ThreadSignals = NonNullable<DirectorResult["threadSignals"]>;

export interface ThreadSignalResult {
  threads: StoryThread[];
  touchedIds: string[];
}

/**
 * Thread lifecycle (docs/story-threads.md): touch keeps a thread warm (no log
 * entry), develop appends an accumulated development on a major beat, propose
 * opens a new thread (deduped by exact title here as the innermost guard;
 * semantic dedup runs upstream in dedupeThreadProposals), resolve closes an
 * investigation — never an ongoing thread (kind-guarded; the blocked signal
 * logs merge.thread.resolve_blocked). Touch/develop/propose only ever match
 * live (open/cooling) threads, so a closed thread can't be revived by id or
 * title. Unknown references degrade to diagnostics. Signals are
 * partial-tolerant so callers (and tests) may omit empty channels.
 */
export function applyThreadSignals(
  threads: readonly StoryThread[],
  signals: Partial<ThreadSignals>,
  turnNumber: number,
  sink?: DiagnosticSink,
): ThreadSignalResult {
  const next = threads.map((t) => ({ ...t }));
  const touchedIds = new Set<string>();

  const refresh = (thread: StoryThread, summary?: string) => {
    thread.status = "open";
    thread.lastTouchedTurn = turnNumber;
    thread.touchCount += 1;
    if (summary?.trim()) thread.summary = summary.trim();
    touchedIds.add(thread.id);
  };

  // develop = refresh + append an accumulated development (capped, oldest dropped).
  const develop = (thread: StoryThread, entry: string, entryKind: StoryThreadDevelopment["kind"] | undefined, summary?: string) => {
    refresh(thread, summary);
    const text = entry.trim();
    if (!text) return;
    thread.developments = [...thread.developments, { turn: turnNumber, text, kind: entryKind ?? "update" }].slice(
      -THREAD_DEVELOPMENTS_CAP,
    );
  };

  // Only live threads are signal targets: a resolved/archived thread must stay
  // closed, whether referenced by id or by an exact-title match (a same-title
  // propose opens a fresh thread instead of resurrecting the old one).
  const isLive = (t: StoryThread) => t.status === "open" || t.status === "cooling";
  const byTitle = (title: string) => next.find((t) => isLive(t) && t.title.trim().toLowerCase() === title.trim().toLowerCase());
  const find = (id?: string, title?: string) =>
    (id ? next.find((t) => isLive(t) && t.id === id) : undefined) ?? (title ? byTitle(title) : undefined);

  for (const touch of signals.touch ?? []) {
    const thread = find(touch.id, touch.title);
    if (!thread) {
      sink?.push(diag("info", "merge.thread.unmatched", `touched thread "${touch.title}" not found`, { context: { id: touch.id } }));
      continue;
    }
    refresh(thread, touch.summary);
  }

  for (const entry of signals.develop ?? []) {
    const thread = find(entry.id, entry.title);
    if (!thread) {
      sink?.push(
        diag("info", "merge.thread.unmatched", `developed thread "${entry.title ?? entry.id ?? ""}" not found`, {
          context: { id: entry.id },
        }),
      );
      continue;
    }
    develop(thread, entry.entry, entry.entryKind, entry.summary);
  }

  for (const proposal of signals.propose ?? []) {
    if (!proposal.title.trim()) continue;
    const existing = byTitle(proposal.title);
    if (existing) {
      // Exact-title re-proposal of a live thread is a development, not a duplicate.
      develop(existing, proposal.summary, "update", proposal.summary);
      continue;
    }
    const summary = proposal.summary.trim();
    const thread = storyThreadSchema.parse({
      id: newId(),
      title: proposal.title.trim(),
      summary,
      kind: proposal.kind,
      status: "open",
      source: "emergent",
      question: proposal.question ?? "",
      closeConditions: proposal.closeConditions ?? [],
      // Seed the timeline with the opening beat so the modal isn't empty.
      developments: summary ? [{ turn: turnNumber, text: summary, kind: "update" }] : [],
      openedAtTurn: turnNumber,
      lastTouchedTurn: turnNumber,
      touchCount: 1,
    });
    next.push(thread);
    touchedIds.add(thread.id);
  }

  for (const id of signals.resolve ?? []) {
    const thread = next.find((t) => t.id === id);
    if (!thread) {
      sink?.push(diag("info", "merge.thread.unmatched", `resolved thread "${id}" not found`));
      continue;
    }
    // Only investigations resolve; an ongoing thread has no end state, so a
    // resolve signal against one (the director prompt forbids it, but an LLM
    // can slip) is skipped rather than applied.
    if (thread.kind === "ongoing") {
      sink?.push(
        diag("info", "merge.thread.resolve_blocked", `resolve of ongoing thread "${thread.title}" blocked (ongoing threads never resolve)`, {
          context: { id },
        }),
      );
      continue;
    }
    thread.status = "resolved";
    thread.lastTouchedTurn = turnNumber;
    touchedIds.add(thread.id);
  }

  return { threads: next, touchedIds: [...touchedIds] };
}

/** Text a thread/proposal embeds as for dedup: title, question, and synopsis together. */
function threadDedupText(t: { title: string; question?: string; summary?: string }): string {
  return [t.title, t.question, t.summary].map((s) => s?.trim()).filter(Boolean).join(" — ");
}

/**
 * Semantic dedup backstop (docs/story-threads.md): a proposed thread whose
 * title+question+summary is near-identical to an existing open/cooling thread is
 * rewritten into a `develop` on that thread instead of opening a duplicate —
 * the same belt-and-suspenders idiom as the item-dedupe ladder. Conservative
 * threshold (THREAD_DEDUPE_MIN_SCORE) so only obvious dupes merge; the director
 * prompt is the primary consolidation. Resolved/archived threads are never
 * candidates (a closed thread must not resurrect). Embedding failure degrades
 * to the exact-title guard in applyThreadSignals.
 */
export async function dedupeThreadProposals(
  threads: readonly StoryThread[],
  signals: ThreadSignals,
  embed: (texts: string[]) => Promise<number[][]>,
  turnNumber: number,
  sink?: DiagnosticSink,
): Promise<ThreadSignals> {
  void turnNumber; // reserved for future recency-aware tie-breaks; keeps the call signature stable
  if (signals.propose.length === 0) return signals;
  const candidates = threads.filter((t) => t.status === "open" || t.status === "cooling");
  if (candidates.length === 0) return signals;

  // Bound the embedding batch (docs/resilience.md §3): a flood of model-proposed
  // threads would otherwise trigger an unbounded embed() call. Only the first
  // MAX_THREAD_PROPOSALS are considered for *semantic* dedup; any tail beyond the
  // cap passes through to applyThreadSignals unchanged (still title-deduped there,
  // never embedded here). The cap shrinks the embed batch, it does not drop work.
  const consideredProposals = signals.propose.slice(0, MAX_THREAD_PROPOSALS);
  const passthroughProposals = signals.propose.slice(MAX_THREAD_PROPOSALS);

  let vectors: number[][];
  try {
    vectors = await embed([...candidates.map(threadDedupText), ...consideredProposals.map(threadDedupText)]);
  } catch (err) {
    sink?.push(
      diag("warn", "merge.thread.dedup_embed_failed", `thread dedup embedding failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    return signals;
  }
  const candVecs = vectors.slice(0, candidates.length);
  const propVecs = vectors.slice(candidates.length);

  const extraDevelop: ThreadSignals["develop"] = [];
  const keptProposals: ThreadSignals["propose"] = [];
  consideredProposals.forEach((proposal, i) => {
    const pv = propVecs[i];
    let bestScore = -1;
    let bestIdx = -1;
    if (pv) {
      candVecs.forEach((cv, j) => {
        const score = cosineSimilarity(pv, cv);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      });
    }
    const match = bestIdx >= 0 ? candidates[bestIdx] : undefined;
    if (match && bestScore >= THREAD_DEDUPE_MIN_SCORE) {
      sink?.push(
        diag(
          "info",
          "merge.thread.dedup_merged",
          `proposed thread "${proposal.title}" folded into "${match.title}" (${bestScore.toFixed(2)})`,
        ),
      );
      extraDevelop.push({ id: match.id, entry: proposal.summary.trim() || proposal.title.trim(), summary: proposal.summary });
    } else {
      keptProposals.push(proposal);
    }
  });

  // No fold ⇒ the original signals are unchanged (the passthrough tail was never
  // touched and is already part of `signals.propose`).
  if (extraDevelop.length === 0) return signals;
  // Fold ⇒ rebuild propose from the kept considered-proposals plus the
  // never-considered passthrough tail (preserves both the original order group
  // and every proposal that the cap excluded from dedup).
  return {
    ...signals,
    propose: [...keptProposals, ...passthroughProposals],
    develop: [...signals.develop, ...extraDevelop],
  };
}

/** Open threads untouched for THREAD_COOLING_TURNS move to cooling. */
export function coolThreads(threads: readonly StoryThread[], turnNumber: number): StoryThread[] {
  return threads.map((t) =>
    t.status === "open" && turnNumber - t.lastTouchedTurn >= THREAD_COOLING_TURNS ? { ...t, status: "cooling" as const } : t,
  );
}

// Story threads (docs/story-threads.md): touch/develop/propose/resolve, with a
// semantic-dedup backstop that degrades to exact-title dedup with no embedder.
export async function phaseThreads(ctx: PhaseContext): Promise<void> {
  const { reconcile, results, bundle, turn, sink } = ctx;
  if (reconcile) return;
  const threads = bundle.runtime.storyThreads;
  const raw = results.director?.threadSignals ?? { touch: [], develop: [], propose: [], resolve: [] };
  // Conservative semantic dedup folds near-duplicate proposals into develops
  // before the pure reducer runs (degrades to exact-title dedup if no embedder).
  const signals = ctx.deps?.embedThreadTexts
    ? await dedupeThreadProposals(threads, raw, ctx.deps.embedThreadTexts, turn.number, sink)
    : raw;
  const applied = applyThreadSignals(threads, signals, turn.number, sink);
  ctx.threads = coolThreads(applied.threads, turn.number);
  ctx.touchedThreadIds = applied.touchedIds;
}
