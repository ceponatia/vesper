"use client";

import { useEffect, useState } from "react";

/**
 * The trailing-debounced echo of `value` — updates `ms` after the last change.
 * For search inputs whose queries re-fetch from the server: bind the input to
 * the immediate state, fetch on the debounced value.
 */
export function useDebouncedValue(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
