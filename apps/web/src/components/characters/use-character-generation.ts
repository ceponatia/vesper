"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  characterAuthoringRunsApi,
  type CharacterAuthoringDecision,
  type CharacterDraft,
} from "@/lib/client/api";
import {
  generationCacheKey,
  generationProjectionReceipt,
  generationRecordsForAbandonment,
  matchesGeneration,
  needsGenerationProjection,
  readGenerationCache,
  type CharacterGeneration,
  type GenerationInput,
  type GenerationTarget,
} from "./character-generation-record";
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
  const { kind, id } = target;
  const cacheKey = generationCacheKey(ownerId, { kind, id });
  const [records, setRecords] = useState<CharacterGeneration[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [projectedReceipts, setProjectedReceipts] = useState<ReadonlySet<string>>(() => new Set());
  const [projectionRetry, setProjectionRetry] = useState(0);
  const callback = useRef(onComplete);
  const mounted = useRef(true);
  const processing = useRef(new Set<string>());
  const starting = useRef(false);
  const abandoning = useRef(false);
  const retryingRoots = useRef(new Set<string>());
  const settlements = useRef(new Map<string, Promise<CharacterGeneration | null>>());
  const projectionRetryTimer = useRef<number | null>(null);
  const recordsRef = useRef(records);
  const projectedReceiptsRef = useRef(projectedReceipts);
  const cacheKeyRef = useRef(cacheKey);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { callback.current = onComplete; }, [onComplete]);
  useEffect(() => { recordsRef.current = records; }, [records]);
  useEffect(() => { projectedReceiptsRef.current = projectedReceipts; }, [projectedReceipts]);

  useEffect(() => {
    cacheKeyRef.current = cacheKey;
    processing.current.clear();
    if (projectionRetryTimer.current !== null) {
      window.clearTimeout(projectionRetryTimer.current);
      projectionRetryTimer.current = null;
    }
  }, [cacheKey]);

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
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const cached = readGenerationCache(localStorage.getItem(cacheKey));
        store(cached);
      } catch { setUnavailable(true); }
      if (!cancelled) void refresh();
    });
    return () => { cancelled = true; };
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

  const scheduleProjectionRetry = useCallback(() => {
    if (projectionRetryTimer.current !== null) return;
    const expectedCacheKey = cacheKey;
    projectionRetryTimer.current = window.setTimeout(() => {
      projectionRetryTimer.current = null;
      if (!mounted.current || cacheKeyRef.current !== expectedCacheKey) return;
      void refresh().finally(() => {
        if (mounted.current && cacheKeyRef.current === expectedCacheKey) {
          setProjectionRetry((value) => value + 1);
        }
      });
    }, POLL_MS);
  }, [cacheKey, refresh]);

  useEffect(() => {
    if (!ready || blocked) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      for (const record of recordsRef.current) {
        const receipt = generationProjectionReceipt(record);
        if (cancelled || abandoning.current || !needsGenerationProjection(record, projectedReceiptsRef.current)
          || processing.current.has(record.id)) continue;
        processing.current.add(record.id);
        let received = false;
        try { received = await callback.current(record, { decide }); }
        catch { /* The server record remains available for the next safe projection. */ }
        finally { processing.current.delete(record.id); }
        if (received) {
          const next = new Set(projectedReceiptsRef.current);
          next.add(receipt);
          projectedReceiptsRef.current = next;
          if (mounted.current) setProjectedReceipts(next);
        } else scheduleProjectionRetry();
        if (cancelled) return;
      }
    });
    return () => { cancelled = true; };
  }, [ready, blocked, destination, records, decide, projectedReceipts, projectionRetry, scheduleProjectionRetry, cacheKey]);

  const hasActiveWork = useCallback((candidateRecords: readonly CharacterGeneration[]) => candidateRecords.some(
    (record) => record.status === "pending" || needsGenerationProjection(record, projectedReceiptsRef.current),
  ), []);

  const start = async (input: GenerationInput, replacesId?: string): Promise<boolean> => {
    if (!ready || blocked || abandoning.current || starting.current || hasActiveWork(recordsRef.current)) return false;
    starting.current = true;
    const requestId = crypto.randomUUID();
    const pending = optimistic(ownerId, { kind, id }, requestId, input);
    replace(pending, replacesId);
    const settlement = (async (): Promise<CharacterGeneration | null> => {
      const response = await characterAuthoringRunsApi.start(requestId, { kind, id }, input);
      if (response.ok) {
        replace(response.data.run, requestId);
        return response.data.run;
      }
      replace({ ...pending, status: "failed", error: response.error.message, errorCode: response.error.code, finishedAt: new Date().toISOString() }, requestId);
      return null;
    })();
    settlements.current.set(requestId, settlement);
    try {
      return (await settlement) !== null;
    } finally {
      settlements.current.delete(requestId);
      starting.current = false;
    }
  };

  const retry = async (record: CharacterGeneration): Promise<boolean> => {
    if (blocked || !ready || abandoning.current || retryingRoots.current.has(record.rootRunId)
      || !matchesGeneration(record, ownerId, { kind, id })
      || hasActiveWork(recordsRef.current)) return false;
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
      const settlement = (async (): Promise<CharacterGeneration | null> => {
        const response = await characterAuthoringRunsApi.retry(record.id, requestId);
        if (!response.ok) {
          const withoutPending = recordsRef.current.filter((item) => item.id !== requestId && item.id !== record.id);
          store([{ ...record, error: response.error.message, errorCode: response.error.code }, ...withoutPending]);
          return null;
        }
        replace(response.data.run, requestId);
        return response.data.run;
      })();
      settlements.current.set(requestId, settlement);
      try { return (await settlement) !== null; }
      finally { settlements.current.delete(requestId); }
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
    if (abandoning.current) return false;
    abandoning.current = true;
    const captured = [...recordsRef.current];
    const inFlight = [...settlements.current.entries()];
    try {
      const settled = await Promise.all(inFlight.map(async ([requestId, settlement]) => ({ requestId, run: await settlement })));
      const outstanding = generationRecordsForAbandonment(captured, recordsRef.current, settled);
      for (const record of outstanding) if (!(await dismiss(record))) return false;
      return true;
    } catch {
      return false;
    } finally {
      abandoning.current = false;
    }
  };

  const active = records.find((record) => record.status === "pending")
    ?? records.find((record) => needsGenerationProjection(record, projectedReceipts))
    ?? null;
  const settling = records.some((record) => needsGenerationProjection(record, projectedReceipts));
  return {
    records,
    active,
    settling,
    unavailable,
    isRunning: () => hasActiveWork(recordsRef.current),
    hasOutstanding: () => recordsRef.current.some((record) => record.status === "pending" || record.status === "failed" || record.proposal.status === "unresolved"),
    recordsNow: () => recordsRef.current,
    start,
    retry,
    dismiss,
    abandon,
    decide,
    refresh,
  };
}
