"use client";

import { useCallback, useState } from "react";

/**
 * Minimal async-action hook for mutations (chatbot send, UI-state writes).
 *
 * The dashboard's reads are SWR; this covers the handful of write paths. It
 * owns exactly one error slot so a component can never end up showing two
 * different errors for the same action — a bug the previous implementation had
 * by combining this with a local `useState` catch.
 */
export interface UseActionResult<TArgs extends unknown[], TData> {
  run: (...args: TArgs) => Promise<TData | undefined>;
  isPending: boolean;
  error: Error | null;
  data: TData | null;
  reset: () => void;
}

export function useAction<TArgs extends unknown[], TData>(
  fn: (...args: TArgs) => Promise<TData>,
): UseActionResult<TArgs, TData> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<TData | null>(null);

  const run = useCallback(
    async (...args: TArgs) => {
      setIsPending(true);
      setError(null);
      try {
        const result = await fn(...args);
        setData(result);
        return result;
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        return undefined;
      } finally {
        setIsPending(false);
      }
    },
    [fn],
  );

  const reset = useCallback(() => {
    setError(null);
    setData(null);
    setIsPending(false);
  }, []);

  return { run, isPending, error, data, reset };
}
