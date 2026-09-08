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

interface DecisionOptions { expectedAuthoringRevision?: number; currentDraft?: CharacterDraft }

export interface CharacterGenerationCompletionActions {
  decide: (
    proposal: { sourceRunId?: string; proposalRevision?: number },
    action: CharacterAuthoringDecision,
    choices?: ProposalChoices,
    options?: DecisionOptions,
  ) => Promise<CharacterGenerationDecisionResult | null>;
}

function optimistic(
  ownerId: string,
  target: GenerationTarget,
  id: string,
  input: GenerationInput,
  lineage: { retryOf: string | null; rootRunId: string } = { retryOf: null, rootRunId: id },
): CharacterGeneration {
  return {
    ...input,
    id,
    ownerId,
    target,
    status: "pending",
    result: null,
    error: null,
    errorCode: null,
    persisted: false,
    retryOf: lineage.retryOf,
    rootRunId: lineage.rootRunId,
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
  onComplete: (record: CharacterGeneration, actions: CharacterGenerationCompletionActions) => Promise<boolean>,
) {
  const [records, setRecords] = useState<CharacterGeneration[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const callback = useRef(onComplete);
  const processing = useRef(new Set<string>());
  const starting = useRef(false);
  const retryingRoots = useRef(new Set<string>());
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
      store(cached);
    } catch { setUnavailable(true); }
    void refresh();
  }, [cacheKey, refresh, store]);

  useEffect(() => {
    if (!records.some((record) => record.status === "pending")) return;
    const timer = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [records, refresh]);

  const replace = useCallback((run: CharacterGeneration, removeId?: string) => store([
    run,
    ...recordsRef.current.filter((record) => record.id !== run.id && record.id !== removeId),
  ]), [store]);

  const decide = useCallback(async (
    proposal: { sourceRunId?: string; proposalRevision?: number },
    action: CharacterAuthoringDecision,
    choices: ProposalChoices = {},
    options: DecisionOptions = {},
  ): Promise<CharacterGenerationDecisionResult | null> => {
    const runId = proposal.sourceRunId;
    const expectedProposalRevision = proposal.proposalRevision;
    if (!runId || !expectedProposalRevision || (blocked && action !== "dismiss")) return null;
    const response = await characterAuthoringRunsApi.decide(runId, {
      action,
      expectedProposalRevision,
      choices,
      ...options,
    });
    if (!response.ok) { await refresh(); return null; }
    replace(response.data.run);
    return { run: response.data.run, appliedDraft: response.data.run.proposal.appliedDraft };
  }, [blocked, refresh, replace]);

  useEffect(() => {
    if (!ready || blocked) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      for (const record of recordsRef.current) {
        const receipt = record.id;
        if (cancelled || record.status !== "completed" || processing.current.has(receipt)) continue;
        processing.current.add(receipt);
        try { await callback.current(record, { decide }); }
        catch { /* The server record remains available for the next safe projection. */ }
        finally { processing.current.delete(receipt); }
      }
    });
    return () => { cancelled = true; };
  }, [ready, blocked, destination, records, decide]);

  const start = async (input: GenerationInput, replacesId?: string): Promise<boolean> => {
    if (!ready || blocked || starting.current || recordsRef.current.some((record) => record.status === "pending")) return false;
    starting.current = true;
    const requestId = crypto.randomUUID();
    const pending = optimistic(ownerId, { kind, id }, requestId, input);
    replace(pending, replacesId);
    try {
      const response = await characterAuthoringRunsApi.start(requestId, { kind, id }, input);
      if (response.ok) { replace(response.data.run, requestId); return true; }
      replace({ ...pending, status: "failed", error: response.error.message, errorCode: response.error.code, finishedAt: new Date().toISOString() }, requestId);
      return false;
    } finally { starting.current = false; }
  };

  const retry = async (record: CharacterGeneration): Promise<boolean> => {
    if (blocked || !ready || retryingRoots.current.has(record.rootRunId)
      || !matchesGeneration(record, ownerId, { kind, id })
      || recordsRef.current.some((item) => item.status === "pending")) return false;
    retryingRoots.current.add(record.rootRunId);
    try {
      const input: GenerationInput = {
        operation: record.operation, scope: record.scope, label: record.label, base: record.base,
        creationStart: record.creationStart, source: record.source,
      };
      if (!record.persisted) return start(input, record.id);
      const requestId = crypto.randomUUID();
      const pending = optimistic(ownerId, { kind, id }, requestId, input, { retryOf: record.id, rootRunId: record.rootRunId });
      replace(pending);
      const response = await characterAuthoringRunsApi.retry(record.id, requestId);
      if (!response.ok) {
        const withoutPending = recordsRef.current.filter((item) => item.id !== requestId && item.id !== record.id);
        store([{ ...record, error: response.error.message, errorCode: response.error.code }, ...withoutPending]);
        return false;
      }
      replace(response.data.run, requestId);
      return true;
    } finally { retryingRoots.current.delete(record.rootRunId); }
  };

  const dismiss = async (record: CharacterGeneration): Promise<boolean> => {
    if (!matchesGeneration(record, ownerId, { kind, id })) return false;
    if (!record.persisted) {
      store(recordsRef.current.filter((item) => item.id !== record.id));
      return true;
    }
    const result = await decide({ sourceRunId: record.id, proposalRevision: record.proposal.revision }, "dismiss");
    if (result) store(recordsRef.current.filter((item) => item.id !== record.id));
    return result !== null;
  };

  const abandon = async (): Promise<boolean> => {
    const outstanding = recordsRef.current.filter((record) => record.status === "pending"
      || record.status === "failed" || record.proposal.status === "unresolved");
    for (const record of outstanding) if (!(await dismiss(record))) return false;
    return true;
  };

  const active = records.find((record) => record.status === "pending") ?? null;
  return {
    records,
    active,
    unavailable,
    isRunning: () => recordsRef.current.some((record) => record.status === "pending"),
    hasOutstanding: () => recordsRef.current.some((record) => record.status === "pending" || record.status === "failed" || record.proposal.status === "unresolved"),
    start,
    retry,
    dismiss,
    abandon,
    decide,
    refresh,
  };
}
