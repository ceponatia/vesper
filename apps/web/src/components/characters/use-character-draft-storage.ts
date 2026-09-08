"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { promoteDraftRecovery, readDraft, writeDraft } from "./character-draft-storage";

interface RecoveryCopy { key: string; label: string }

/** Mount with key={storageKey}. Versions protect async results, and Web Locks
 * serialize cooperating tabs. Each editor owns a separate discoverable recovery copy. */
export function useCharacterDraftStorage<T>(key: string, schema: z.ZodType<T>, initial: () => T) {
  const [data, setData] = useState(initial);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [recoveries, setRecoveries] = useState<RecoveryCopy[]>([]);
  const [editorId] = useState(() => crypto.randomUUID());
  const current = useRef(data);
  const expected = useRef<string | null>(null);
  const revision = useRef("");
  const mounted = useRef(true);
  const blocked = useRef(false);
  const epoch = useRef(0);
  const tail = useRef<Promise<void>>(Promise.resolve());
  const recoveryPrefix = `${key}:recovery:`;
  const recoveryKey = `${recoveryPrefix}${editorId}`;

  const findRecoveries = useCallback(() => {
    const copies: RecoveryCopy[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const storedKey = localStorage.key(index);
      if (!storedKey?.startsWith(recoveryPrefix)) continue;
      const raw = localStorage.getItem(storedKey);
      const parsed = readDraft(raw, schema);
      if (parsed) copies.push({ key: storedKey, label: parsed.savedAt ? new Date(parsed.savedAt).toLocaleString() : "another editing session" });
    }
    return copies;
  }, [recoveryPrefix, schema]);
  const lock = useCallback(async (action: () => void) => {
    if (navigator.locks) await navigator.locks.request(key, action);
    else action();
  }, [key]);

  useEffect(() => {
    mounted.current = true;
    // Storage hydration is deferred, matching other client-only preference surfaces.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem(key);
        expected.current = raw;
        const parsed = readDraft(raw, schema);
        setRecoveries(findRecoveries());
        if (parsed) { current.current = parsed.data; revision.current = parsed.revision; setData(parsed.data); }
        if (raw && !parsed) {
          blocked.current = true;
          setConflict(true);
          setNotice("This browser draft could not be read. It is retained until you explicitly start a new draft. New edits are kept in a separate recovery copy.");
        }
      } catch { setNotice("Browser storage is unavailable. Keep this page open until you save."); }
      setReady(true);
    });
    const changed = (event: StorageEvent) => {
      if (event.key?.startsWith(recoveryPrefix)) {
        try { setRecoveries(findRecoveries()); } catch { /* current draft stays usable */ }
      }
      if (event.key !== key || event.newValue === expected.current) return;
      blocked.current = true;
      setConflict(true);
      setNotice("This draft changed in another tab. Your version is kept separately; choose which version to continue.");
    };
    window.addEventListener("storage", changed);
    return () => { cancelled = true; mounted.current = false; window.removeEventListener("storage", changed); };
  }, [key, recoveryPrefix, schema, findRecoveries]);

  const persist = useCallback((next: T) => {
    const nextRevision = crypto.randomUUID();
    revision.current = nextRevision;
    const raw = JSON.stringify({ revision: nextRevision, savedAt: Date.now(), data: next });
    const operationEpoch = epoch.current;
    tail.current = tail.current.then(() => lock(() => {
      if (operationEpoch !== epoch.current) return;
      let result: ReturnType<typeof writeDraft> = "unavailable";
      try {
        result = blocked.current ? "conflict" : writeDraft(localStorage, key, expected.current, raw);
        if (result === "saved") expected.current = raw;
        if (result === "conflict") {
          localStorage.setItem(recoveryKey, raw);
          blocked.current = true;
        }
      } catch { result = "unavailable"; }
      if (!mounted.current) return;
      if (result === "conflict") {
        setConflict(true);
        setRecoveries(findRecoveries());
        setNotice("A newer draft exists in another tab. Your edits are in a recovery copy; choose which version to continue.");
      } else if (result === "unavailable") setNotice("Browser storage is unavailable. Keep this page open until you save.");
    })).catch(() => { if (mounted.current) setNotice("Browser storage is unavailable. Keep this page open until you save."); });
  }, [key, recoveryKey, lock, findRecoveries]);

  const update = useCallback((value: T | ((old: T) => T)) => {
    const next = typeof value === "function" ? (value as (old: T) => T)(current.current) : value;
    if (Object.is(next, current.current)) return;
    current.current = next;
    if (mounted.current) setData(next);
    persist(next);
  }, [persist]);

  const resume = useCallback(async (copyKey?: string): Promise<boolean> => {
    // Invalidates callbacks already queued by the version being left.
    const operationEpoch = ++epoch.current;
    const requestedRevision = revision.current;
    let resumed = false;
    await lock(() => {
      if (!mounted.current || epoch.current !== operationEpoch) return;
      if (revision.current !== requestedRevision) { setNotice("This draft was edited while resuming. Your edits are kept; choose a version again when ready."); return; }
      try {
        const raw = localStorage.getItem(key);
        const selected = copyKey ? localStorage.getItem(copyKey) : raw;
        const parsed = readDraft(selected, schema);
        if (!parsed) { setNotice("That draft could not be read. Your current edits are still here."); return; }
        const shared = readDraft(raw, schema);
        // Preserve truly displaced local edits. If local already equals the shared
        // version, the shared backup below owns that one copy.
        if (revision.current && revision.current !== parsed.revision && revision.current !== shared?.revision) {
          localStorage.setItem(recoveryKey, JSON.stringify({ revision: revision.current, savedAt: Date.now(), data: current.current }));
        }
        if (copyKey && selected) {
          // Version-addressed backups avoid multiplying the same displaced record
          // when users alternate between recovery copies.
          if (raw && raw !== selected) {
            let backupKey = `${recoveryPrefix}version:${shared?.revision ?? crypto.randomUUID()}`;
            const previousBackup = localStorage.getItem(backupKey);
            if (previousBackup && previousBackup !== raw) backupKey = `${recoveryPrefix}${crypto.randomUUID()}`;
            localStorage.setItem(backupKey, raw);
          }
          const promoted = promoteDraftRecovery(localStorage, key, raw, copyKey, selected);
          if (promoted.status !== "saved") {
            blocked.current = true;
            setConflict(true);
            setNotice("The shared draft changed while recovering. Your current edits and the recovery copy are retained.");
            setRecoveries(findRecoveries());
            return;
          }
        }
        expected.current = copyKey ? selected : raw;
        blocked.current = false;
        setConflict(false);
        current.current = parsed.data;
        revision.current = parsed.revision;
        setData(parsed.data);
        setNotice(null);
        setRecoveries(findRecoveries());
        resumed = true;
      } catch { setNotice("Browser storage is unavailable. Keep this page open until you save."); }
    });
    return resumed;
  }, [key, recoveryKey, recoveryPrefix, schema, findRecoveries, lock]);

  const reset = useCallback(() => {
    epoch.current += 1;
    try { expected.current = localStorage.getItem(key); } catch { /* surfaced on write */ }
    blocked.current = false;
    setConflict(false);
    setNotice(null);
    const fresh = initial();
    current.current = fresh;
    setData(fresh);
    persist(fresh);
  }, [key, initial, persist]);

  const clear = useCallback(async (savedRevision: string): Promise<boolean> => {
    await tail.current;
    if (revision.current !== savedRevision || blocked.current) return false;
    let cleared = false;
    await lock(() => {
      if (revision.current !== savedRevision || blocked.current) return;
      try {
        cleared = writeDraft(localStorage, key, expected.current, null) === "saved";
        if (cleared) expected.current = null;
      } catch { /* storage failure never changes the draft */ }
    });
    return cleared;
  }, [key, lock]);

  const isPersisted = () => {
    try { return !blocked.current && expected.current !== null && localStorage.getItem(key) === expected.current && readDraft(expected.current, schema)?.revision === revision.current; }
    catch { return false; }
  };
  return { data, update, current, revision, ready, notice, conflict, resume, reset, clear, isPersisted, flush: () => tail.current, isBlocked: () => blocked.current, recoveries };
}
