"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, type ApiFailure, type RunDetailResponse } from "@/lib/client-api";

/**
 * Loading state for a view that refetches itself while the reader watches.
 *
 * `useApiResource` is deliberately not used here. It resets to `loading` on
 * every reload, which is right for a page that loads once — and wrong for this
 * one: the run view refetches about once a second while a run advances, and
 * tearing the whole page down to a skeleton between polls would make the run
 * unreadable exactly when there is most to see.
 *
 * So the state is four-valued rather than three, and the extra distinction is
 * the point:
 *
 *   - `data === null, failure === null` — the first request is in flight.
 *   - `data === null, failure !== null` — nothing loaded; the failure is all
 *     there is to show.
 *   - `data !== null, failure !== null` — a *refresh* failed. The run on screen
 *     is the last good response and stays; the failure is a warning beside it,
 *     not a replacement for it. Discarding a run the reader is reading because
 *     one poll timed out would be a regression, not error handling.
 *   - `data !== null, failure === null` — current.
 */
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

  /*
   * Latest request wins.
   *
   * Two refreshes overlap routinely here — the tick loop fires one while a
   * manual reload is still open — and responses can arrive in either order. The
   * counter is incremented when a request starts and checked when it resolves,
   * so a slow earlier response cannot overwrite a fast later one with staler
   * run state. It is also incremented on unmount, which discards everything in
   * flight.
   */
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
