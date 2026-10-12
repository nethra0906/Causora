/**
 * Causora telemetry SDK — a deliberately small, OTel-shaped tracer (see ADR-0017).
 *
 * What it guarantees (this is the point of the package):
 *  - every span carries the causal contract as `causora.*` attributes, written ONLY via the
 *    constants in `contracts`;
 *  - causal fields are inherited from the enclosing span by default, so a developer has to opt
 *    OUT of causality rather than remember to opt in;
 *  - time comes from an injectable clock (so `clock_offset` faults are possible) — `Date.now()` is
 *    banned elsewhere (test/unit/conventions.test.ts enforces it).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ATTR, PORTS, type EventType, type WireSpan } from '../contracts/index.ts';
import { hashKey, newSpanId, newTraceId } from '../lib/ids.ts';

type AttrValue = string | number | boolean;

// ───────────────────────────── clock ─────────────────────────────
export const clock = {
  offsetMs: 0,
  /** Wall clock in epoch milliseconds, sub-millisecond precision, plus any injected skew. */
  now(): number {
    return performance.timeOrigin + performance.now() + this.offsetMs;
  },
};

// ───────────────────────────── span ─────────────────────────────
export interface SpanInit {
  traceId: string;
  spanId: string;
  eventId: string;
  parentSpanId: string | null;
  service: string;
  name: string;
  kind: WireSpan['kind'];
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly eventId: string;
  readonly parentSpanId: string | null;
  readonly service: string;
  readonly name: string;
  readonly kind: WireSpan['kind'];
  readonly startMs: number;
  endMs: number | null = null;
  statusCode: 'OK' | 'ERROR' | 'UNSET' = 'UNSET';
  statusMessage: string | undefined;
  attrs: Record<string, AttrValue> = {};
  /** Raw key, kept only in memory for propagation; telemetry carries the hash. */
  rawIdempotencyKey: string | null = null;

  constructor(init: SpanInit) {
    this.traceId = init.traceId;
    this.spanId = init.spanId;
    this.eventId = init.eventId;
    this.parentSpanId = init.parentSpanId;
    this.service = init.service;
    this.name = init.name;
    this.kind = init.kind;
    this.startMs = clock.now();
  }

  get businessOperationId(): string | null {
    return (this.attrs[ATTR.businessOperationId] as string | undefined) ?? null;
  }
  get attempt(): number {
    return (this.attrs[ATTR.attemptNumber] as number | undefined) ?? 1;
  }

  set(key: string, value: AttrValue | null | undefined): this {
    if (value === null || value === undefined) return this;
    this.attrs[key] = value;
    return this;
  }

  setIdempotencyKey(raw: string | null | undefined): this {
    if (!raw) return this;
    this.rawIdempotencyKey = raw;
    this.attrs[ATTR.idempotencyKey] = hashKey(raw);
    return this;
  }

  setResourceIds(ids: Record<string, string>): this {
    this.attrs[ATTR.resourceIds] = JSON.stringify(ids);
    return this;
  }

  fail(errorType: string, message?: string): this {
    this.statusCode = 'ERROR';
    this.statusMessage = message;
    this.attrs[ATTR.errorType] = errorType;
    return this;
  }

  timeout(message?: string): this {
    return this.fail('TIMEOUT', message);
  }

  end(): void {
    if (this.endMs !== null) return;
    this.endMs = clock.now();
    if (this.statusCode === 'UNSET') this.statusCode = 'OK';
    enqueue(this);
  }
}

// ───────────────────────────── options & context ─────────────────────────────
export type ParentRef = 'current' | 'none' | { traceId: string; spanId: string };

export interface SpanOptions {
  name: string;
  operation: string;
  eventType: EventType;
  kind: WireSpan['kind'];
  /** Caller-allocated event id (HTTP: x-causora-event-id; bus consumer: deterministic). */
  eventId?: string;
  parent?: ParentRef;
  businessOperationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  attempt?: number;
  retryOfEventId?: string;
  awaitedCorrelationId?: string;
  mutating?: boolean;
  attributes?: Record<string, AttrValue>;
}

const als = new AsyncLocalStorage<Span>();
export const currentSpan = (): Span | undefined => als.getStore();

interface State {
  service: string;
  platformUrl: string | null;
  buffer: WireSpan[];
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
}
const state: State = { service: 'unknown', platformUrl: null, buffer: [], timer: null, inFlight: null };
const MAX_BUFFER = 20_000;
/** Test hook: collect spans in-process instead of POSTing them. */
let sink: ((spans: WireSpan[]) => void) | null = null;

export function initTelemetry(opts: { service: string; platformUrl?: string; flushMs?: number }): void {
  state.service = opts.service;
  state.platformUrl = opts.platformUrl ?? process.env.CAUSORA_PLATFORM_URL ?? `http://127.0.0.1:${PORTS.platform}`;
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => void flushTelemetry(), opts.flushMs ?? 250);
  state.timer.unref();
}

export function setTelemetrySink(fn: ((spans: WireSpan[]) => void) | null): void {
  sink = fn;
}

export function startSpan(opts: SpanOptions): Span {
  const parent = opts.parent ?? 'current';
  const cur = parent === 'current' ? als.getStore() : undefined;

  let traceId: string;
  let parentSpanId: string | null;
  if (parent === 'current' && cur) {
    traceId = cur.traceId;
    parentSpanId = cur.spanId;
  } else if (typeof parent === 'object') {
    traceId = parent.traceId;
    parentSpanId = parent.spanId;
  } else {
    traceId = newTraceId();
    parentSpanId = null;
  }

  const spanId = newSpanId();
  const span = new Span({
    traceId,
    spanId,
    eventId: opts.eventId ?? spanId,
    parentSpanId,
    service: state.service,
    name: opts.name,
    kind: opts.kind,
  });

  // Inheritance: causal fields flow from the enclosing span unless explicitly overridden.
  span.set(ATTR.eventId, span.eventId);
  span.set(ATTR.eventType, opts.eventType);
  span.set(ATTR.operation, opts.operation);
  span.set(ATTR.businessOperationId, opts.businessOperationId ?? cur?.businessOperationId);
  span.set(ATTR.causationId, opts.causationId ?? cur?.eventId);
  span.set(ATTR.attemptNumber, opts.attempt ?? cur?.attempt ?? 1);
  span.setIdempotencyKey(opts.idempotencyKey ?? cur?.rawIdempotencyKey);
  span.set(ATTR.retryOfEventId, opts.retryOfEventId);
  span.set(ATTR.awaitedCorrelationId, opts.awaitedCorrelationId);
  if (opts.mutating) span.set(ATTR.mutating, true);
  for (const [k, v] of Object.entries(opts.attributes ?? {})) span.set(k, v);
  return span;
}

export async function withSpan<T>(opts: SpanOptions, fn: (span: Span) => Promise<T> | T): Promise<T> {
  const span = startSpan(opts);
  try {
    return await als.run(span, () => fn(span));
  } catch (e) {
    if (span.statusCode === 'UNSET') span.fail('EXCEPTION', e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    span.end();
  }
}

/** A zero-duration event (timeout fired, fault injected, idempotency hit...). Returns the span for its ids. */
export function emitEvent(opts: SpanOptions & { status?: 'OK' | 'ERROR'; errorType?: string }): Span {
  const span = startSpan(opts);
  if (opts.errorType) span.fail(opts.errorType);
  span.end();
  return span;
}

// ───────────────────────────── export ─────────────────────────────
function enqueue(span: Span): void {
  const wire: WireSpan = {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    service: span.service,
    kind: span.kind,
    startTimeMs: span.startMs,
    endTimeMs: span.endMs ?? span.startMs,
    status: { code: span.statusCode, message: span.statusMessage },
    attributes: span.attrs,
  };
  if (sink) return sink([wire]);
  state.buffer.push(wire);
  if (state.buffer.length > MAX_BUFFER) state.buffer.splice(0, state.buffer.length - MAX_BUFFER); // drop oldest, bounded
}

export async function flushTelemetry(): Promise<void> {
  if (state.inFlight) return state.inFlight;
  if (!state.platformUrl || state.buffer.length === 0) return;
  const batch = state.buffer.splice(0, 500);
  state.inFlight = (async () => {
    try {
      const res = await fetch(`${state.platformUrl}/v1/spans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spans: batch }),
      });
      if (!res.ok && res.status >= 500) throw new Error(`ingest ${res.status}`);
    } catch {
      state.buffer.unshift(...batch); // retry on the next tick; bounded by MAX_BUFFER
    } finally {
      state.inFlight = null;
    }
  })();
  await state.inFlight;
}

export async function drainTelemetry(timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (state.buffer.length > 0 && performance.now() < deadline) await flushTelemetry();
}

