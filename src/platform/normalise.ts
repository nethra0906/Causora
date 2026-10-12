/**
 * Wire span → NormalisedEvent. PURE: no I/O, no clock reads, no randomness. The same span always
 * yields the same event (stable `event_id`), which is what makes ingestion idempotent and replay
 * byte-identical. Contract violations are RECORDED, never thrown: Causora must be able to ingest
 * imperfectly instrumented telemetry and then say exactly what it could not prove.
 */
import { ATTR, EVENT_TYPES, SCHEMA_VERSION, type EventStatus, type EventType, type NormalisedEvent, type WireSpan } from '../contracts/index.ts';

type Attrs = WireSpan['attributes'];

const str = (a: Attrs, k: string): string | null => (typeof a[k] === 'string' && (a[k] as string).length > 0 ? (a[k] as string) : null);
const num = (a: Attrs, k: string): number | null => (typeof a[k] === 'number' ? (a[k] as number) : null);

const CAUSORA_PREFIX = 'causora.';

export type NormaliseResult = { ok: true; event: NormalisedEvent } | { ok: false; reason: string };

export function normaliseSpan(w: WireSpan, ingestedAt: number): NormaliseResult {
  const a = w.attributes;
  const eventType = str(a, ATTR.eventType);
  const operation = str(a, ATTR.operation);
  if (!eventType || !(EVENT_TYPES as readonly string[]).includes(eventType)) return { ok: false, reason: `unknown or missing ${ATTR.eventType}` };
  if (!operation) return { ok: false, reason: `missing ${ATTR.operation}` };
  const type = eventType as EventType;

  const isFault = str(a, ATTR.source) === 'fault';
  const errorType = str(a, ATTR.errorType);
  let status: EventStatus = w.status.code === 'OK' ? 'OK' : w.status.code === 'ERROR' ? 'ERROR' : 'UNKNOWN';
  if (status === 'ERROR' && (errorType === 'TIMEOUT' || type === 'timeout.fired')) status = 'TIMEOUT';

  const experimentId = str(a, ATTR.experimentId);
  const producedAt = num(a, ATTR.producedAt);
  const duration = Math.max(0, w.endTimeMs - w.startTimeMs);

  let resourceIds: Record<string, string> = {};
  const rawResources = str(a, ATTR.resourceIds);
  if (rawResources) {
    try {
      const parsed = JSON.parse(rawResources);
      if (parsed && typeof parsed === 'object') resourceIds = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      /* malformed resource ids are simply absent */
    }
  }

  const attributes: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(a)) if (!k.startsWith(CAUSORA_PREFIX)) attributes[k] = v;
  if (w.status.message) attributes['status.message'] = w.status.message;
  const faultTtl = num(a, ATTR.faultTtlMs);
  if (faultTtl !== null) attributes['fault.ttl_ms'] = faultTtl; // surfaced under a neutral key: the causora.* namespace is stripped above

  const event: NormalisedEvent = {
    event_id: str(a, ATTR.eventId) ?? w.spanId,
    event_type: type,
    source: isFault ? 'fault' : 'span',
    service: w.service,
    operation,
    occurred_at: w.startTimeMs,
    ended_at: w.endTimeMs,
    duration_ms: duration,
    ingested_at: ingestedAt,
    trace_id: w.traceId,
    span_id: w.spanId,
    parent_span_id: w.parentSpanId ?? null,
    business_operation_id: str(a, ATTR.businessOperationId),
    causation_id: str(a, ATTR.causationId),
    idempotency_key: str(a, ATTR.idempotencyKey),
    attempt_number: num(a, ATTR.attemptNumber) ?? 1,
    retry_of_event_id: str(a, ATTR.retryOfEventId),
    awaited_correlation_id: str(a, ATTR.awaitedCorrelationId),
    message_id: str(a, ATTR.messageId),
    topic: str(a, ATTR.topic),
    message_key: str(a, ATTR.messageKey),
    produced_at: producedAt,
    dwell_ms: producedAt !== null && type === 'messaging.consume' ? w.startTimeMs - producedAt : null,
    status,
    error_type: errorType,
    experiment_id: experimentId,
    is_fault_injected: isFault || experimentId !== null,
    resource_ids: resourceIds,
    mutating: a[ATTR.mutating] === true,
    evidence_source: isFault ? 'fault_injector' : 'otlp_span',
    attributes,
    schema_version: SCHEMA_VERSION,
    contract_violations: [],
  };
  event.contract_violations = detectViolations(event);
  return { ok: true, event };
}

/** Required-by-contract fields that are optional in the type. Absence is information, not an error. */
export function detectViolations(e: NormalisedEvent): string[] {
  if (e.source === 'fault') return [];
  const v: string[] = [];
  if (!e.business_operation_id) v.push('missing:business_operation_id');
  if (e.event_type === 'messaging.consume' && !e.causation_id) v.push('missing:causation_id');
  if (e.event_type === 'timeout.fired' && !e.awaited_correlation_id) v.push('missing:awaited_correlation_id');
  if (e.mutating && !e.idempotency_key) v.push('missing:idempotency_key');
  return v;
}
