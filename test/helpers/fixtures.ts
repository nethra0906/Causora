import type { Baseline, NormalisedEvent } from '../../src/contracts/index.ts';

export const T0 = 1_000_000;

let seq = 0;
/** A NormalisedEvent with sensible defaults; override only what a test cares about. */
export function ev(p: Partial<NormalisedEvent> & Pick<NormalisedEvent, 'event_id' | 'service' | 'operation' | 'event_type'>): NormalisedEvent {
  seq++;
  return {
    source: 'span',
    occurred_at: T0,
    duration_ms: 1,
    ingested_at: T0 + 10_000,
    trace_id: `trace-${seq}`,
    span_id: `span-${p.event_id}`,
    parent_span_id: null,
    business_operation_id: 'ord_1',
    causation_id: null,
    idempotency_key: null,
    attempt_number: 1,
    retry_of_event_id: null,
    awaited_correlation_id: null,
    message_id: null,
    topic: null,
    message_key: null,
    produced_at: null,
    dwell_ms: null,
    status: 'OK',
    error_type: null,
    experiment_id: null,
    is_fault_injected: false,
    resource_ids: {},
    mutating: false,
    evidence_source: 'otlp_span',
    attributes: {},
    schema_version: 1,
    contract_violations: [],
    ...p,
    ended_at: p.ended_at ?? (p.occurred_at ?? T0) + (p.duration_ms ?? 1),
  };
}

const K = 'h_dupkey';

/**
 * The primary scenario (S1) as it appears in telemetry: slow reservation → timeout → retry →
 * duplicate reservation → doubled quantity → payment rejection. 14 events, 8 key relationships.
 */
export function s1Events(opts: { experiment?: boolean } = {}): NormalisedEvent[] {
  const exp = opts.experiment ? { experiment_id: 'exp_1', is_fault_injected: true } : {};
  return [
    ev({ event_id: 'root', service: 'order-service', operation: 'order.create', event_type: 'http.server.request', occurred_at: T0, duration_ms: 1, mutating: true, idempotency_key: K }),
    ev({ event_id: 'P1', service: 'order-service', operation: 'order.publish_created', event_type: 'messaging.produce', occurred_at: T0 + 1, duration_ms: 0.5, parent_span_id: 'span-root', causation_id: 'root', topic: 'orders.events', message_key: 'ord_1', idempotency_key: K, mutating: true }),
    ev({ event_id: 'C1', service: 'inventory-service', operation: 'inventory.reserve', event_type: 'messaging.consume', occurred_at: T0 + 3, duration_ms: 1700, causation_id: 'P1', topic: 'orders.events', message_key: 'ord_1', idempotency_key: K, mutating: true, dwell_ms: 2, resource_ids: { reservation_id: 'R1', order_id: 'ord_1' }, ...exp }),
    ev({ event_id: 'T', service: 'order-service', operation: 'order.inventory_wait.timeout', event_type: 'timeout.fired', occurred_at: T0 + 1003, duration_ms: 1, status: 'TIMEOUT', error_type: 'TIMEOUT', causation_id: 'P1', awaited_correlation_id: 'C1' }),
    ev({ event_id: 'P2', service: 'order-service', operation: 'order.publish_created', event_type: 'messaging.produce', occurred_at: T0 + 1004, duration_ms: 0.5, parent_span_id: 'span-T', causation_id: 'T', retry_of_event_id: 'P1', attempt_number: 2, topic: 'orders.events', message_key: 'ord_1', idempotency_key: K, mutating: true }),
    ev({ event_id: 'C2', service: 'inventory-service', operation: 'inventory.reserve', event_type: 'messaging.consume', occurred_at: T0 + 1006, duration_ms: 1700, causation_id: 'P2', attempt_number: 2, topic: 'orders.events', message_key: 'ord_1', idempotency_key: K, mutating: true, dwell_ms: 2, resource_ids: { reservation_id: 'R2', order_id: 'ord_1' }, ...exp }),
    ev({ event_id: 'PR1', service: 'inventory-service', operation: 'inventory.publish_reserved', event_type: 'messaging.produce', occurred_at: T0 + 1702, duration_ms: 0.5, parent_span_id: 'span-C1', causation_id: 'C1', topic: 'inventory.events', message_key: 'ord_1' }),
    ev({ event_id: 'RE1', service: 'order-service', operation: 'order.on_inventory_reply', event_type: 'messaging.consume', occurred_at: T0 + 1705, duration_ms: 1, causation_id: 'PR1', topic: 'inventory.events', message_key: 'ord_1', dwell_ms: 2 }),
    ev({ event_id: 'PR2', service: 'inventory-service', operation: 'inventory.publish_reserved', event_type: 'messaging.produce', occurred_at: T0 + 2706, duration_ms: 0.5, parent_span_id: 'span-C2', causation_id: 'C2', topic: 'inventory.events', message_key: 'ord_1', attempt_number: 2 }),
    ev({ event_id: 'RE2', service: 'order-service', operation: 'order.on_inventory_reply', event_type: 'messaging.consume', occurred_at: T0 + 2709, duration_ms: 1, causation_id: 'PR2', topic: 'inventory.events', message_key: 'ord_1', dwell_ms: 2, attempt_number: 2 }),
    ev({ event_id: 'SET', service: 'order-service', operation: 'order.settle', event_type: 'domain.state_change', occurred_at: T0 + 3207, duration_ms: 25, causation_id: 'RE2', status: 'ERROR', error_type: 'PAYMENT_FAILED', attempt_number: 2 }),
    ev({ event_id: 'H', service: 'order-service', operation: 'order.call_payment', event_type: 'http.client.request', occurred_at: T0 + 3208, duration_ms: 20, parent_span_id: 'span-SET', causation_id: 'SET', status: 'ERROR', error_type: 'HTTP_422', attempt_number: 2 }),
    ev({ event_id: 'S', service: 'payment-service', operation: 'payment.authorize', event_type: 'http.server.request', occurred_at: T0 + 3210, duration_ms: 5, parent_span_id: 'span-H', causation_id: 'H', status: 'ERROR', error_type: 'RESERVATION_AMOUNT_MISMATCH', mutating: true, idempotency_key: K, attempt_number: 2 }),
    ev({ event_id: 'F', service: 'order-service', operation: 'order.failed', event_type: 'domain.state_change', occurred_at: T0 + 3232, duration_ms: 0, parent_span_id: 'span-SET', causation_id: 'S', status: 'ERROR', error_type: 'PAYMENT_FAILED', attempt_number: 2 }),
  ];
}

/** 40 healthy samples per operation: p50 ≈ 2 ms, p95 ≈ 6 ms, no errors. */
export function healthyBaselines(events: NormalisedEvent[]): Array<Baseline & { dwell_p95_ms: number | null }> {
  const seen = new Map<string, NormalisedEvent>();
  for (const e of events) seen.set(`${e.service}|${e.operation}`, e);
  return [...seen.values()].map((e) => ({ service: e.service, operation: e.operation, sample_count: 40, p50_ms: 2, p95_ms: 6, error_rate: 0, dwell_p95_ms: 10 }));
}

/** Deterministic Fisher–Yates using a seeded LCG, so shuffles are reproducible. */
export function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
