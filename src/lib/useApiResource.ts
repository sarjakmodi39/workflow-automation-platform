"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFailure, ApiResult } from "@/lib/client-api";

export type Resource<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "failed"; failure: ApiFailure };

/** One request, three states, and a way to try again. `load` lives in a ref because an
 *  inline arrow would change identity every render and fetch forever. */
export function useApiResource<T>(
  load: () => Promise<ApiResult<T>>,
  deps: readonly unknown[] = [],
): { resource: Resource<T>; reload: () => void } {
  const loadRef = useRef(load);
  loadRef.current = load;

  const [resource, setResource] = useState<Resource<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResource({ state: "loading" });

    loadRef.current().then((result) => {
      // A resolved request for a previous `deps` value must not overwrite the
      // state of the current one.
      if (cancelled) return;
      setResource(
        result.ok
          ? { state: "ready", data: result.data }
          : { state: "failed", failure: result.failure },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { resource, reload };
}
