/**
 * Telemetry SDK + bus + normalisation + store + engine, in one process with no containers and no
 * network. Proves that the causal contract survives a hop through the real publish()/subscribe().
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTR, MSG_HEADERS, ingestSchema, type WireSpan } from '../../src/contracts/index.ts';
import { openBus, publish, subscribe } from '../../src/bus/index.ts';
import { sleep } from '../../src/lib/ids.ts';
import { Engine } from '../../src/platform/engine.ts';
import { normaliseSpan } from '../../src/platform/normalise.ts';
import { Store } from '../../src/platform/store.ts';
import { initTelemetry, setTelemetrySink, withSpan } from '../../src/telemetry/index.ts';

initTelemetry({ service: 'test-service', platformUrl: 'http://127.0.0.1:1' });

async function untilTrue(fn: () => boolean, ms = 3000) {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

/** Publish one message and consume it, returning every span the SDK emitted. */
async function hop(opts: { attempt?: number; retryOf?: string } = {}) {
  const spans: WireSpan[] = [];
  setTelemetrySink((s) => spans.push(...s));
  const bus = openBus(':memory:');
  const received: Array<{ headers: Record<string, string>; spanAttrs: Record<string, unknown> }> = [];
  const sub = subscribe({ bus, topic: 't', group: 'g', operation: 'test.consume', mutating: true, pollMs: 5, handler: async (msg, span) => { received.push({ headers: msg.headers, spanAttrs: { ...span.attrs } }); } });
  let pub!: { messageId: string; eventId: string };
  let rootEventId = '';
  await withSpan({ name: 'root', operation: 'test.root', eventType: 'http.server.request', kind: 'server', businessOperationId: 'ord_42', idempotencyKey: 'secret-key-123' }, async (root) => {
    rootEventId = root.eventId;
    pub = await publish({ bus, topic: 't', key: 'ord_42', type: 'x', payload: { a: 1 }, operation: 'test.publish', causationId: root.eventId, businessOperationId: 'ord_42', attempt: opts.attempt ?? 1, idempotencyKey: 'secret-key-123', retryOfEventId: opts.retryOf, initiatesRetry: !!opts.retryOf });
  });
  await untilTrue(() => received.length === 1);
  await sleep(30);
  sub.stop();
  setTelemetrySink(null);
  return { spans, received: received[0]!, pub, rootEventId };
}

test('ROUND TRIP: every contract header set by the producer is readable by the consumer', async () => {
  const { received, pub, rootEventId } = await hop({ attempt: 2, retryOf: 'prior-event' });
  const h = received.headers;
  assert.equal(h[MSG_HEADERS.eventId], pub.eventId);
  assert.equal(h[MSG_HEADERS.causationId], rootEventId);
  assert.equal(h[MSG_HEADERS.businessOperationId], 'ord_42');
  assert.equal(h[MSG_HEADERS.idempotencyKey], 'secret-key-123');
  assert.equal(h[MSG_HEADERS.attempt], '2');
  assert.equal(h[MSG_HEADERS.retryOfEventId], 'prior-event');
  assert.match(h[MSG_HEADERS.traceparent]!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.ok(Number(h[MSG_HEADERS.producedAt]) > 0);
  assert.equal(h[MSG_HEADERS.schemaVersion], '1');
});

test('the consume span opens the causal context before the handler body runs', async () => {
  const { received, pub } = await hop();
  assert.equal(received.spanAttrs[ATTR.causationId], pub.eventId, 'consumer’s causation is the producer’s event id');
  assert.equal(received.spanAttrs[ATTR.businessOperationId], 'ord_42');
  assert.equal(received.spanAttrs[ATTR.eventId], `consume:${pub.messageId}:g`, 'deterministic consume id: anyone who knows the message can name it');
  assert.equal(received.spanAttrs[ATTR.eventType], 'messaging.consume');
  assert.equal(received.spanAttrs[ATTR.mutating], true);
});

test('redaction: the idempotency key reaches telemetry only as a stable hash', async () => {
  const { spans } = await hop();
  const blob = JSON.stringify(spans);
  assert.ok(!blob.includes('secret-key-123'), 'raw key must never appear in exported spans');
  const hashes = new Set(spans.map((s) => s.attributes[ATTR.idempotencyKey]).filter(Boolean));
  assert.equal(hashes.size, 1, 'equality is preserved across the hop, which is all the duplicate rule needs');
});

test('exported spans satisfy the ingest schema', async () => {
  const { spans } = await hop();
  assert.ok(ingestSchema.safeParse({ spans }).success);
});

test('publish() refuses to send without the causal contract', async () => {
  const bus = openBus(':memory:');
  const base = { bus, topic: 't', key: 'k', type: 'x', payload: {}, operation: 'o', attempt: 1 };
  assert.throws(() => publish({ ...base, businessOperationId: 'b' } as any), /causationId/);
  assert.throws(() => publish({ ...base, causationId: 'c' } as any), /businessOperationId/);
  assert.throws(() => publish({ ...base, causationId: 'c', businessOperationId: 'b', initiatesRetry: true }), /retryOfEventId/);
});

test('delivery is at-least-once: a failing handler is redelivered, then dead-lettered', async () => {
  const spans: WireSpan[] = [];
  setTelemetrySink((s) => spans.push(...s));
  const bus = openBus(':memory:');
  let calls = 0;
  const sub = subscribe({ bus, topic: 't', group: 'g', operation: 'o', pollMs: 5, handler: async () => { calls++; throw new Error('boom'); } });
  const pub = await withSpan({ name: 'r', operation: 'r', eventType: 'http.server.request', kind: 'server' }, (root) => publish({ bus, topic: 't', key: 'k', type: 'x', payload: {}, operation: 'p', causationId: root.eventId, businessOperationId: 'b', attempt: 1 }));
  await untilTrue(() => calls >= 3, 5000);
  await sleep(300);
  sub.stop();
  setTelemetrySink(null);
  assert.equal(calls, 3, 'MAX_DELIVERIES attempts, then dead');
  assert.equal((bus.db.prepare("SELECT status FROM deliveries").get() as any).status, 'dead');

  // Regression for held-out defect P6: every delivery is its own event, and ONLY the first keeps the
  // id a waiter can compute in advance. Previously all three shared one id and two were dropped at ingest.
  const ids = spans.filter((s) => s.attributes[ATTR.eventType] === 'messaging.consume').map((s) => s.attributes[ATTR.eventId]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, 'redeliveries must not collide on one event id');
  assert.ok(ids.includes(`consume:${pub.messageId}:g`), 'the first delivery keeps the deterministic, awaitable id');
  assert.ok(ids.includes(`consume:${pub.messageId}:g#2`) && ids.includes(`consume:${pub.messageId}:g#3`));
});

// ───────────────────────── normalisation ─────────────────────────
test('normalise() is pure: same span → identical event, stable event_id', async () => {
  const { spans } = await hop();
  for (const s of spans) {
    const a = normaliseSpan(s, 5);
    const b = normaliseSpan(structuredClone(s), 5);
    assert.deepEqual(a, b);
  }
});

test('contract violations are recorded, not thrown; malformed spans are rejected with a reason', async () => {
  const { spans } = await hop();
  const consume = spans.find((s) => s.attributes[ATTR.eventType] === 'messaging.consume')!;
  const broken = structuredClone(consume);
  delete broken.attributes[ATTR.causationId];
  const r = normaliseSpan(broken, 1);
  assert.ok(r.ok && r.event.contract_violations.includes('missing:causation_id'));
  assert.ok(!normaliseSpan({ ...consume, attributes: {} }, 1).ok, 'no event type → rejected');
  const bad = normaliseSpan({ ...consume, attributes: { ...consume.attributes, [ATTR.eventType]: 'made.up' } }, 1);
  assert.ok(!bad.ok);
});

test('a timeout span normalises to status TIMEOUT; dwell is derived from produced_at', async () => {
  const { spans } = await hop();
  const consume = normaliseSpan(spans.find((s) => s.attributes[ATTR.eventType] === 'messaging.consume')!, 1);
  assert.ok(consume.ok && consume.event.dwell_ms !== null && consume.event.dwell_ms >= 0);
  const t = normaliseSpan({ traceId: 't', spanId: 's', name: 'x', service: 'svc', kind: 'internal', startTimeMs: 1, endTimeMs: 2, status: { code: 'ERROR' }, attributes: { [ATTR.eventType]: 'timeout.fired', [ATTR.operation]: 'o', [ATTR.errorType]: 'TIMEOUT' } }, 1);
  assert.ok(t.ok && t.event.status === 'TIMEOUT');
});

// ───────────────────────── store + engine ─────────────────────────
test('ingest is idempotent, and a consumer that arrives BEFORE its producer is linked when the producer lands', async () => {
  const { spans } = await hop();
  const store = new Store(':memory:');
  const engine = new Engine(store);
  const producer = spans.filter((s) => s.attributes[ATTR.eventType] === 'messaging.produce' || s.attributes[ATTR.eventType] === 'http.server.request');
  const consumer = spans.filter((s) => s.attributes[ATTR.eventType] === 'messaging.consume');

  const r1 = engine.ingest(consumer);
  assert.equal(r1.accepted, consumer.length);
  assert.equal(store.edgesForOperation('ord_42').filter((e) => e.type === 'TRIGGERED').length, 0, 'no edge until the producer exists');
  assert.equal(engine.dangling('ord_42'), 1, 'the dangling reference is visible, not hidden');

  engine.ingest(producer);
  const triggered = store.edgesForOperation('ord_42').filter((e) => e.type === 'TRIGGERED');
  assert.equal(triggered.length, 1, 'late arrival is stitched in by re-derivation');
  assert.equal(engine.dangling('ord_42'), 0);

  const before = JSON.stringify(store.edgesForOperation('ord_42'));
  const again = engine.ingest([...consumer, ...producer]);
  assert.equal(again.accepted, 0);
  assert.equal(again.duplicates, consumer.length + producer.length);
  assert.equal(JSON.stringify(store.edgesForOperation('ord_42')), before, 're-ingest changes nothing');
  assert.equal(store.counts().events, spans.length);
  store.close();
});

test('rejected telemetry is counted and returned, never silently dropped', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store);
  const res = engine.ingest([{ traceId: 't', spanId: 'bad', name: 'x', service: 's', kind: 'internal', startTimeMs: 1, endTimeMs: 2, status: { code: 'OK' }, attributes: {} }]);
  assert.equal(res.accepted, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0]!.reason, /event_type/);
  store.close();
});
