"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, type ApiFailure, type RunDetailResponse } from "@/lib/client-api";

/** Four-valued loading state, not `useApiResource`, which resets to `loading` every reload:
 *  this view polls each second, so a failed *refresh* warns beside the run, never replaces it. */
export interface RunDetailState {
  /** The most recent successful response. Never cleared by a failed refresh. */
  data: RunDetailResponse | null;
  failure: ApiFailure | null;
  /** A request is in flight. Drives a quiet indicator, not a skeleton. */
  refreshing: boolean;
  refresh: () => Promise<void>;
}

export function useRunDetail(runId: string): RunDetailState {
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [refreshing, setRefreshing] = useState(true);

  // Latest request wins: refreshes overlap routinely and can resolve out of order, so a
  // slow earlier response must not overwrite a fast later one. Also bumped on unmount.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    setRefreshing(true);

    const result = await getJson<RunDetailResponse>(`/api/runs/${runId}`);
    if (mine !== generation.current) return;

    setRefreshing(false);
    if (result.ok) {
      setData(result.data);
      setFailure(null);
    } else {
      // `data` is untouched on purpose — see the note above.
      setFailure(result.failure);
    }
  }, [runId]);

  useEffect(() => {
    // A different run id means the run on screen is not the run being asked
    // for, so it is cleared rather than shown under the new id's heading.
    setData(null);
    setFailure(null);
    void refresh();

    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  return { data, failure, refreshing, refresh };
}
