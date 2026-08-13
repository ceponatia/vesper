"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, ApiResult } from "@/lib/client/api";

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Refetch (shows the loading state again only when `silent` is false). */
  reload: (opts?: { silent?: boolean }) => void;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * Minimal client data hook over the ApiResult shape: skeleton state, error
 * state, stale-response guard. `deps` re-runs the fetch (like useEffect deps).
 */
export function useAsyncData<T>(fetcher: () => Promise<ApiResult<T>>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  // Render-adjust: a deps change flips the skeleton on during the same render,
  // so the effect below never has to set state synchronously.
  const [prevDeps, setPrevDeps] = useState(deps);
  if (!sameDeps(prevDeps, deps)) {
    setPrevDeps(deps);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    const gen = ++generation.current;
    void (async () => {
      const result = await fetcherRef.current();
      if (gen !== generation.current) return; // superseded by a newer request
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-owned dep list
  }, deps);

  const reload = useCallback((opts?: { silent?: boolean }) => {
    const gen = ++generation.current;
    if (!opts?.silent) {
      setLoading(true);
      setError(null);
    }
    void (async () => {
      const result = await fetcherRef.current();
      if (gen !== generation.current) return;
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    })();
  }, []);

  return { data, error, loading, reload };
}
