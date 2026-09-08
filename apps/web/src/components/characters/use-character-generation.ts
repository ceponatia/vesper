"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  characterAuthoringRunsApi,
  type CharacterAuthoringDecision,
} from "@/lib/client/api";
import {
  generationCacheKey,
  matchesGeneration,
  readGenerationCache,
  type CharacterGeneration,
  type GenerationInput,
  type GenerationTarget,
} from "./character-generation-record";
import type { CharacterDraft } from "@/lib/client/api";
import type { ProposalChoices } from "./character-proposals";

const POLL_MS = 2500;

export interface CharacterGenerationDecisionResult {
  readonly run: CharacterGeneration;
  readonly appliedDraft: CharacterDraft | null;
}

function optimistic(ownerId: string, target: GenerationTarget, id: string, input: GenerationInput): CharacterGeneration {
  return {
    ...input,
    id,
    ownerId,
    target,
    status: "pending",
    result: null,
    error: null,
    retryOf: null,
    rootRunId: id,
    proposal: { revision: 1, status: "unresolved", choices: {}, appliedDraft: null, undo: null },
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

/** Server rows own execution and review state; browser storage is a bounded read cache. */
export function useCharacterGeneration(
  ownerId: string,
  target: GenerationTarget,
  ready: boolean,
  blocked: boolean,
  destination: unknown,
  onComplete: (record: CharacterGeneration) => Promise<boolean>,
) {
  const [records, setRecords] = useState<CharacterGeneration[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const callback = useRef(onComplete);
  const processing = useRef(new Set<string>());
  const recordsRef = useRef(records);
  const { kind, id } = target;
  const cacheKey = generationCacheKey(ownerId, { kind, id });
  useEffect(() => { callback.current = onComplete; }, [onComplete]);
  useEffect(() => { recordsRef.current = records; }, [records]);

  const store = useCallback((next: CharacterGeneration[]) => {
    const scoped = next.filter((record) => matchesGeneration(record, ownerId, { kind, id })).slice(0, 25);
    recordsRef.current = scoped;
    setRecords(scoped);
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), records: scoped }));
      setUnavailable(false);
    } catch { setUnavailable(true); }
  }, [cacheKey, id, kind, ownerId]);

  const refresh = useCallback(async () => {
    const response = await characterAuthoringRunsApi.list({ kind, id });
    if (!response.ok) { setUnavailable(true); return false; }
    store(response.data.runs);
    if (response.data.diagnostics.length) setUnavailable(true);
    return true;
  }, [id, kind, store]);

  useEffect(() => {
    try {
      const cached = readGenerationCache(localStorage.getItem(cacheKey));
      if (cached.length) store(cached);
    } catch { setUnavailable(true); }
    void refresh();
  }, [cacheKey, refresh, store]);

  useEffect(() => {
    if (!records.some((record) => record.status === "pending")) return;
    const timer = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [records, refresh]);

  useEffect(() => {
    if (!ready || blocked) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      for (const record of recordsRef.current) {
        const receipt = `${record.id}:${record.proposal.revision}`;
        if (cancelled || record.status !== "completed" || processing.current.has(receipt)) continue;
        processing.current.add(receipt);
        try { await callback.current(record); }
        catch { /* The server record remains available for the next safe projection. */ }
        finally { processing.current.delete(receipt); }
      }
    });
    return () => { cancelled = true; };
  }, [ready, blocked, destination, records]);

  const replace = (run: CharacterGeneration) => store([
    run,
    ...recordsRef.current.filter((record) => record.id !== run.id),
  ]);

  const start = async (input: GenerationInput): Promise<boolean> => {
    if (!ready || blocked || recordsRef.current.some((record) => record.status === "pending")) return false;
    const requestId = crypto.randomUUID();
    replace(optimistic(ownerId, { kind, id }, requestId, input));
    const response = await characterAuthoringRunsApi.start(requestId, { kind, id }, input);
    if (response.ok) { replace(response.data.run); return true; }
    replace({ ...optimistic(ownerId, { kind, id }, requestId, input), status: "failed", error: response.error.message, finishedAt: new Date().toISOString() });
    return false;
  };

  const retry = async (record: CharacterGeneration): Promise<boolean> => {
    if (blocked || !ready || !matchesGeneration(record, ownerId, { kind, id }) || recordsRef.current.some((item) => item.status === "pending")) return false;
    const response = await characterAuthoringRunsApi.retry(record.id, crypto.randomUUID());
    if (!response.ok) return false;
    replace(response.data.run);
    return true;
  };

  const decide = async (
    proposal: { sourceRunId?: string; proposalRevision?: number },
    action: CharacterAuthoringDecision,
    choices: ProposalChoices = {},
    options: { expectedAuthoringRevision?: number; currentDraft?: CharacterDraft } = {},
  ): Promise<CharacterGenerationDecisionResult | null> => {
    const runId = proposal.sourceRunId;
    const expectedProposalRevision = proposal.proposalRevision;
    if (!runId || !expectedProposalRevision || blocked) return null;
    const response = await characterAuthoringRunsApi.decide(runId, {
      action,
      expectedProposalRevision,
      choices,
      ...options,
    });
    if (!response.ok) { await refresh(); return null; }
    replace(response.data.run);
    return { run: response.data.run, appliedDraft: response.data.run.proposal.appliedDraft };
  };

  const dismiss = async (record: CharacterGeneration) => {
    if (!matchesGeneration(record, ownerId, { kind, id })) return;
    const result = await decide({ sourceRunId: record.id, proposalRevision: record.proposal.revision }, "dismiss");
    if (result) store(recordsRef.current.filter((item) => item.id !== record.id));
  };

  const active = records.find((record) => record.status === "pending") ?? null;
  return {
    records,
    active,
    unavailable,
    isRunning: () => recordsRef.current.some((record) => record.status === "pending"),
    hasOutstanding: () => recordsRef.current.some((record) => record.status === "pending" || record.status === "failed" || record.proposal.status === "unresolved"),
    start,
    retry: (record: CharacterGeneration) => { void retry(record); },
    dismiss: (record: CharacterGeneration) => { void dismiss(record); },
    decide,
    refresh,
  };
}
