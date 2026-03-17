import { createChildLogger } from "./logger.js";

const log = createChildLogger({ module: "retry" });

export async function retry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; delayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, label = "operation" } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) {
        log.error({ err, attempt, label }, "All retry attempts exhausted");
        throw err;
      }
      const backoff = delayMs * Math.pow(2, attempt - 1);
      log.warn({ err, attempt, label, backoff }, "Retrying after failure");
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error("Unreachable");
}
