import { logger } from './logger.js';

export interface RetryOptions {
  retries?: number;
  label?: string;
  onRetry?: (attempt: number, error: unknown) => Promise<void> | void;
}

/**
 * Retries `fn` up to `retries` times with linear backoff.
 * BigSeller session-expiry errors must NOT be retried here — callers should
 * check session validity before calling withRetry and fail fast instead.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? Number(process.env.MAX_RETRIES ?? 2);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const label = options.label ?? 'operation';
      if (attempt < retries) {
        await logger.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}): ${(error as Error).message}. Retrying...`);
        await options.onRetry?.(attempt + 1, error);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}
