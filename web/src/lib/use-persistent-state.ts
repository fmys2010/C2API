"use client";

import { useCallback, useEffect, useState } from "react";

function read<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

/**
 * useState backed by localStorage, for view preferences that should survive
 * navigation and reloads. Starts from `initial` so the statically exported HTML
 * hydrates cleanly, then adopts the stored value after mount.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const storageKey = `chatgpt2api:${key}`;
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    const stored = read<T>(storageKey);
    if (stored !== undefined) {
      setValue(stored);
    }
  }, [storageKey]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage may be unavailable (private mode); the in-memory value still applies.
      }
    },
    [storageKey],
  );

  return [value, update] as const;
}
