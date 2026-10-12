import { HTTP_HEADERS } from '../contracts/index.ts';
import { formatTraceparent, parseTraceparent, uuid } from '../lib/ids.ts';
import { type Span, type SpanOptions, withSpan } from './index.ts';

type Headers = Record<string, string | string[] | undefined>;
const h = (headers: Headers, name: string): string | undefined => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Inject the causal contract into outbound HTTP headers. `calleeEventId` is allocated by the caller. */
export function injectHttp(span: Span, calleeEventId: string, deadlineMs: number): Record<string, string> {
  const out: Record<string, string> = {
    [HTTP_HEADERS.traceparent]: formatTraceparent(span.traceId, span.spanId),
    [HTTP_HEADERS.causationId]: span.eventId,
    [HTTP_HEADERS.attempt]: String(span.attempt),
    [HTTP_HEADERS.deadlineMs]: String(Math.max(0, Math.round(deadlineMs))),
    [HTTP_HEADERS.eventId]: calleeEventId,
  };
  if (span.businessOperationId) out[HTTP_HEADERS.businessOperationId] = span.businessOperationId;
  if (span.rawIdempotencyKey) out[HTTP_HEADERS.idempotencyKey] = span.rawIdempotencyKey;
  return out;
}

/** Run `fn` inside a server span whose causal context is extracted from the request headers. */
export function serverSpan<T>(
  headers: Headers,
  base: Pick<SpanOptions, 'name' | 'operation' | 'mutating' | 'attributes'>,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tp = parseTraceparent(h(headers, HTTP_HEADERS.traceparent));
  const attempt = Number(h(headers, HTTP_HEADERS.attempt));
  return withSpan(
    {
      ...base,
      eventType: 'http.server.request',
      kind: 'server',
      parent: tp ?? 'none',
      eventId: h(headers, HTTP_HEADERS.eventId),
      businessOperationId: h(headers, HTTP_HEADERS.businessOperationId),
      causationId: h(headers, HTTP_HEADERS.causationId),
      idempotencyKey: h(headers, HTTP_HEADERS.idempotencyKey),
      attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : undefined,
    },
    fn,
  );
}

export interface TracedFetchResult {
  status: number;
  body: any;
  timedOut: boolean;
  networkError: boolean;
  /** Event id the callee will use for its server span (allocated here, before the call). */
  calleeEventId: string;
  clientEventId: string;
}

/** HTTP call with propagation, a deadline wired into an AbortController, and a client span. */
export function tracedFetch(opts: {
  url: string;
  method: string;
  body?: unknown;
  name: string;
  operation: string;
  deadlineMs: number;
  mutating?: boolean;
}): Promise<TracedFetchResult> {
  const calleeEventId = uuid();
  return withSpan(
    { name: opts.name, operation: opts.operation, eventType: 'http.client.request', kind: 'client', mutating: opts.mutating },
    async (span) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.deadlineMs);
      const base = { calleeEventId, clientEventId: span.eventId };
      try {
        const res = await fetch(opts.url, {
          method: opts.method,
          headers: { 'content-type': 'application/json', ...injectHttp(span, calleeEventId, opts.deadlineMs) },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        span.set('http.status_code', res.status);
        if (!res.ok) span.fail(`HTTP_${res.status}`);
        let body: any = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        return { ...base, status: res.status, body, timedOut: false, networkError: false };
      } catch (e) {
        if (ctrl.signal.aborted) {
          span.timeout(`no response within ${opts.deadlineMs}ms`);
          return { ...base, status: 0, body: null, timedOut: true, networkError: false };
        }
        span.fail('NETWORK_ERROR', e instanceof Error ? e.message : String(e));
        return { ...base, status: 0, body: null, timedOut: false, networkError: true };
      } finally {
        clearTimeout(timer);
      }
    },
  );
}

