import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const uuid = (): string => randomUUID();
export const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
export const newTraceId = (): string => hex(16);
export const newSpanId = (): string => hex(8);

export function sha(input: string, len = 16): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

/**
 * Idempotency keys are business-meaningful and may embed customer data, so telemetry only ever
 * carries a salted-free hash. Equality is preserved (which is all the duplicate rule needs).
 */
export function hashKey(key: string): string {
  return `h_${sha(key, 16)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseTraceparent(tp: string | undefined | null): { traceId: string; spanId: string } | null {
  if (!tp) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(tp);
  return m ? { traceId: m[1]!, spanId: m[2]! } : null;
}

export const formatTraceparent = (traceId: string, spanId: string): string => `00-${traceId}-${spanId}-01`;
