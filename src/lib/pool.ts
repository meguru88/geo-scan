/** 同時実行数を limit に抑えつつ全要素を処理する。個々の失敗は fn 側で扱う前提 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  onRetry?: (err: unknown, attempt: number) => void;
}

/** 失敗したら retries 回まで再試行（待ち時間は base, base*3, base*9 …） */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      if (attempt > opts.retries) throw err;
      opts.onRetry?.(err, attempt);
      await sleep(opts.baseDelayMs * 3 ** (attempt - 1));
    }
  }
}
