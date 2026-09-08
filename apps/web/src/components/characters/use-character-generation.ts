"use client";

import { useEffect, useRef, useState } from "react";
import { charactersApi } from "@/lib/client/api";
import { authClient } from "@/components/auth/auth-client";
import { mergeFillDraft } from "@/lib/character-fill";
import { mergeFillScope, mergeRedraftScope } from "@/lib/character-scopes";
import { consumeGeneration, createGenerationStorage, finishGeneration, generationKey, generationPrefix, matchesGeneration, readGeneration, type CharacterGeneration, type GenerationInput, type GenerationResult, type GenerationTarget } from "./character-generation-record";

const eventName = "vesper-character-generation";
const running = new Set<string>();
const storage = createGenerationStorage({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, raw) => localStorage.setItem(key, raw),
  removeItem: (key) => localStorage.removeItem(key),
});
const locked = <T,>(key: string, work: () => T | Promise<T>): Promise<T> => navigator.locks ? navigator.locks.request(key, work) : Promise.resolve().then(work);
const notify = () => window.dispatchEvent(new Event(eventName));
async function generate(record: CharacterGeneration): Promise<GenerationResult | { error: string }> {
  if (record.operation === "portrait") {
    const response = await charactersApi.attributesFromPortrait(record.target.id, record.base);
    if (!response.ok) return { error: response.error.message };
    const proposed = mergeFillDraft(record.base, response.data.draft);
    const conflicts = new Map(response.data.portrait.conflicts.map((item) => [item.id, item.proposed]));
    proposed.profile.attributes = proposed.profile.attributes.map((row) => conflicts.has(row.id) ? { ...row, value: conflicts.get(row.id) ?? row.value, source: "creation" as const } : row);
    return { proposed, diagnostics: response.data.diagnostics };
  }
  const response = await charactersApi.forge({ mode: record.operation, draft: record.base, ...(record.scope ? { scope: record.scope } : {}), ...(record.operation === "create" ? { prompt: record.base.profile.creationBrief } : {}) });
  if (!response.ok) return { error: response.error.message };
  const proposed = record.operation === "create" ? { ...response.data.draft, profile: { ...response.data.draft.profile, creationBrief: record.base.profile.creationBrief } }
    : record.scope ? record.operation === "fill" ? mergeFillScope(record.base, response.data.draft, record.scope) : mergeRedraftScope(record.base, response.data.draft, record.scope)
    : mergeFillDraft(record.base, response.data.draft);
  return { proposed, diagnostics: response.data.diagnostics };
}
/** Execution belongs to the browser request, never to one React mount. */
function run(record: CharacterGeneration) {
  const key = generationKey(record);
  if (running.has(key)) return;
  running.add(key); notify();
  const work = async () => {
    const latest = readGeneration(storage.getItem(key));
    if (!latest || latest.status === "completed" || !matchesGeneration(latest, record.ownerId, record.target)) return;
    const started: CharacterGeneration = { ...latest, status: "pending", result: null, error: null };
    storage.setItem(key, JSON.stringify(started)); notify();
    try {
      const session = await authClient.getSession();
      if (session.data?.user.id !== started.ownerId) throw new Error("Sign back into the account that started this generation, then retry.");
      // The session check may outlive an explicit new-draft or dismiss action.
      if (!readGeneration(storage.getItem(key))) return;
      const result = await generate(started);
      finishGeneration(storage, started, "error" in result ? result : { result });
    } catch (error) { finishGeneration(storage, started, { error: error instanceof Error ? error.message : "Generation failed" }); }
  };
  void locked(key, work).catch(() => { finishGeneration(storage, record, { error: "Could not resume generation. Try again." }); }).finally(() => { running.delete(key); notify(); });
}
function list(ownerId: string, target: GenerationTarget): CharacterGeneration[] {
  const prefix = generationPrefix(ownerId, target);
  const keys = new Set(storage.cachedKeys().filter((key) => key.startsWith(prefix)));
  try { for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key?.startsWith(prefix)) keys.add(key); } } catch { /* memory fallback is visible below */ }
  return [...keys].flatMap((key) => { const record = readGeneration(storage.getItem(key)); return record && matchesGeneration(record, ownerId, target) ? [record] : []; });
}
export function useCharacterGeneration(ownerId: string, target: GenerationTarget, ready: boolean, blocked: boolean, destination: unknown, onComplete: (record: CharacterGeneration) => Promise<boolean>) {
  const [records, setRecords] = useState<CharacterGeneration[]>([]);
  const [tick, setTick] = useState(0);
  const callback = useRef(onComplete);
  const processing = useRef(new Set<string>());
  const { kind, id } = target;
  const prefix = generationPrefix(ownerId, { kind, id });
  useEffect(() => { callback.current = onComplete; }, [onComplete]);
  useEffect(() => {
    let mounted = true;
    const refresh = () => { if (mounted) { setRecords(list(ownerId, { kind, id })); setTick((value) => value + 1); } };
    void Promise.resolve().then(refresh);
    const changed = (event: StorageEvent) => { if (event.key?.startsWith(prefix)) refresh(); };
    window.addEventListener(eventName, refresh); window.addEventListener("storage", changed);
    return () => { mounted = false; window.removeEventListener(eventName, refresh); window.removeEventListener("storage", changed); };
  }, [prefix, ownerId, kind, id]);
  useEffect(() => {
    if (!ready || blocked) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      for (const record of list(ownerId, { kind, id })) {
        const key = generationKey(record);
        if (cancelled || record.status !== "completed" || processing.current.has(key)) continue;
        processing.current.add(key);
        try {
          const persisted = await callback.current(record);
          if (!cancelled && await locked(key, () => consumeGeneration(storage, record, persisted))) notify();
          else if (persisted && cancelled) void Promise.resolve().then(notify);
        } catch { /* Keep the completed response for the next safe destination write. */ }
        finally { processing.current.delete(key); }
      }
    });
    return () => { cancelled = true; };
  }, [ready, blocked, destination, tick, prefix, ownerId, kind, id]);
  const active = records.find((record) => running.has(generationKey(record))) ?? null;
  return {
    records, active, unavailable: storage.unavailable(prefix),
    isRunning: () => list(ownerId, target).some((record) => running.has(generationKey(record))),
    hasOutstanding: () => list(ownerId, target).length > 0,
    start: (input: GenerationInput) => {
      const record: CharacterGeneration = { ...input, id: crypto.randomUUID(), ownerId, target, status: "pending", result: null, error: null };
      storage.setItem(generationKey(record), JSON.stringify(record)); run(record);
    },
    retry: (record: CharacterGeneration) => { if (!blocked && ready && matchesGeneration(record, ownerId, target)) run(record); },
    dismiss: (record: CharacterGeneration) => {
      if (!matchesGeneration(record, ownerId, target)) return;
      const key = generationKey(record);
      void locked(key, () => {
        const latest = readGeneration(storage.getItem(key));
        if (latest && matchesGeneration(latest, ownerId, target)) storage.removeItem(key);
      }).catch(() => { /* Retain the record and its storage notice when deletion fails. */ }).finally(notify);
    },
  };
}
