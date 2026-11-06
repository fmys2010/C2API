/** Thrown when polling stops because its AbortSignal fired (e.g. the page was left). */
export class PollAbortedError extends Error {
  constructor() {
    super("Polling aborted");
    this.name = "PollAbortedError";
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PollAbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PollAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls one request at a time until `done`, so a slow older response can never
 * land after a newer one and move the UI backwards.
 */
export async function pollUntilDone<T extends { done?: boolean; error?: string | null }>(
  fetcher: () => Promise<T>,
  onTick: (value: T) => void,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { intervalMs = 300, signal } = options;
  while (true) {
    await wait(intervalMs, signal);
    const value = await fetcher();
    if (signal?.aborted) {
      throw new PollAbortedError();
    }
    onTick(value);
    if (value.done) {
      if (value.error) {
        throw new Error(value.error);
      }
      return value;
    }
  }
}
