import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_INFERRED_CONFIDENCE, RULE_SETS, getRuleSet, type CausalEdge, type NormalisedEvent } from '../../src/contracts/index.ts';
import { applyMask, deriveEdges } from '../../src/platform/rules.ts';
import { ev, s1Events, shuffled, T0 } from '../helpers/fixtures.ts';

const key = (e: CausalEdge) => `${e.from_event_id}>${e.to_event_id}:${e.type}`;
const has = (edges: CausalEdge[], from: string, to: string, type: string) => edges.some((e) => e.from_event_id === from && e.to_event_id === to && e.type === type);

test('S1: all eight key relationships are derived, seven proven and one derived', () => {
  const edges = deriveEdges(s1Events(), getRuleSet('default'));
  assert.ok(has(edges, 'P1', 'C1', 'TRIGGERED'), 'order.created#1 → reserve#1');
  assert.ok(has(edges, 'C1', 'T', 'TIMED_OUT_WAITING_FOR'), 'reserve#1 → timeout');
  assert.ok(has(edges, 'P1', 'P2', 'RETRY_OF'), 'order.created#1 → #2');
  assert.ok(has(edges, 'T', 'P2', 'PARENT_OF'), 'timeout → retry publish');
  assert.ok(has(edges, 'P2', 'C2', 'TRIGGERED'), 'order.created#2 → reserve#2');
  assert.ok(has(edges, 'C1', 'C2', 'DUPLICATE_OF'), 'reserve#1 → reserve#2 duplicate');
  assert.ok(has(edges, 'H', 'S', 'PARENT_OF'), 'client call → payment');
  assert.ok(has(edges, 'S', 'F', 'TRIGGERED'), 'payment rejection → order.failed');
  assert.equal(edges.filter((e) => e.evidence_class === 'inferred').length, 0, 'zero inferred edges when the contract is honoured');
  assert.equal(edges.filter((e) => e.type === 'DUPLICATE_OF')[0]!.evidence_class, 'derived');
});

test('every edge carries its rule id and the matched field values (no edge without evidence)', () => {
  for (const e of deriveEdges(s1Events(), getRuleSet('default'))) {
    assert.match(e.derived_by_rule, /^rule\.[a-z_.]+@v\d+$/);
    assert.ok(e.evidence.matched_fields.length > 0, `${key(e)} has no matched fields`);
    for (const m of e.evidence.matched_fields) assert.ok(m.from_value !== undefined && m.to_value !== undefined);
  }
});

test('derivation is idempotent and independent of input order', () => {
  const base = deriveEdges(s1Events(), getRuleSet('default'));
  assert.deepEqual(deriveEdges(s1Events(), getRuleSet('default')), base);
  for (let seed = 1; seed <= 25; seed++) assert.deepEqual(deriveEdges(shuffled(s1Events(), seed), getRuleSet('default')), base, `seed ${seed}`);
});

test('DUPLICATE_OF direction is canonical (earlier start → later) under permutation', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const d = deriveEdges(shuffled(s1Events(), seed), getRuleSet('default')).filter((e) => e.type === 'DUPLICATE_OF');
    assert.deepEqual(d.map(key), ['C1>C2:DUPLICATE_OF']);
  }
});

test('the corrected guard (no second reservation) produces no DUPLICATE_OF edge', () => {
  const events = s1Events().map((e) => (e.event_id === 'C2' ? { ...e, resource_ids: { order_id: 'ord_1' } } : e));
  assert.equal(deriveEdges(events, getRuleSet('default')).filter((e) => e.type === 'DUPLICATE_OF').length, 0);
});

test('ablation is configuration: masking causation_id removes TRIGGERED edges and nothing else changes the rules', () => {
  const full = deriveEdges(s1Events(), getRuleSet('default'));
  const masked = deriveEdges(s1Events(), getRuleSet('ablation.no_causation_id.no_inference'));
  assert.ok(full.some((e) => e.type === 'TRIGGERED'));
  assert.equal(masked.filter((e) => e.type === 'TRIGGERED').length, 0);
  assert.ok(masked.length < full.length);
  assert.ok(has(masked, 'C1', 'T', 'TIMED_OUT_WAITING_FOR'), 'untouched fields still produce their edges');
});

test('masking never mutates its input', () => {
  const events = s1Events();
  const copy = structuredClone(events);
  applyMask(events, ['causation_id', 'attempt_number']);
  assert.deepEqual(events, copy);
});

test('inference bridges the broker only where causation_id is missing', () => {
  const edges = deriveEdges(s1Events(), getRuleSet('ablation.no_causation_id'));
  const inferred = edges.filter((e) => e.evidence_class === 'inferred');
  assert.ok(inferred.length > 0);
  assert.ok(has(edges, 'P1', 'C1', 'LIKELY_TRIGGERED'));
  assert.ok(has(edges, 'P2', 'C2', 'LIKELY_TRIGGERED'), 'picks the nearest preceding publish, not the first');
  assert.ok(inferred.every((e) => e.confidence <= MAX_INFERRED_CONFIDENCE));
});

test('the orphan rule never links an event to its own child (clock tolerance must not admit descendants)', () => {
  const edges = deriveEdges(s1Events(), getRuleSet('ablation.no_causation_id'));
  assert.ok(!has(edges, 'F', 'SET', 'LIKELY_TRIGGERED'), 'order.failed is SET’s child');
  assert.ok(has(edges, 'RE2', 'SET', 'LIKELY_TRIGGERED'), 'timer-driven settle is attributed to the last reply in the same service');
});

test('LIKELY_RETRY_OF requires a deadline firing; inherited attempt numbers alone are not retries', () => {
  // PR1/PR2 share an idempotency key and have attempts 1,2 but no timeout between them in inventory-service.
  const events = s1Events().map((e) => (e.event_id === 'PR1' || e.event_id === 'PR2' ? { ...e, idempotency_key: 'h_dupkey' } : e));
  const edges = deriveEdges(events, getRuleSet('ablation.no_retry_of'));
  assert.ok(!has(edges, 'PR1', 'PR2', 'LIKELY_RETRY_OF'));
  assert.ok(has(edges, 'P1', 'P2', 'LIKELY_RETRY_OF'), 'the real retry is still inferred when retry_of is lost');
});

test('FAULT_AFFECTED links the injector event to affected spans only (same experiment, service, operation)', () => {
  const fault = ev({ event_id: 'F0', service: 'inventory-service', operation: 'inventory.reserve', event_type: 'fault.injected', source: 'fault', business_operation_id: null, experiment_id: 'exp_1', occurred_at: T0 - 5, attributes: { 'fault.ttl_ms': 60_000 } });
  const edges = deriveEdges([fault, ...s1Events({ experiment: true })], getRuleSet('default'));
  assert.deepEqual(edges.filter((e) => e.type === 'FAULT_AFFECTED').map(key).sort(), ['F0>C1:FAULT_AFFECTED', 'F0>C2:FAULT_AFFECTED']);
});

test('PROPERTY: over random event sets there are no self-loops, no duplicate edges, and inferred confidence is capped', () => {
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  for (let round = 0; round < 60; round++) {
    const n = 5 + Math.floor(rnd() * 25);
    const events: NormalisedEvent[] = [];
    for (let i = 0; i < n; i++) {
      const id = `e${i}`;
      const prior = events.length ? pick(events) : null;
      events.push(
        ev({
          event_id: id, service: pick(['a', 'b', 'c']), operation: pick(['op1', 'op2']),
          event_type: pick(['messaging.consume', 'messaging.produce', 'http.server.request', 'timeout.fired', 'domain.state_change'] as const),
          occurred_at: T0 + Math.floor(rnd() * 5000), duration_ms: Math.floor(rnd() * 800),
          causation_id: rnd() < 0.4 && prior ? prior.event_id : null, parent_span_id: rnd() < 0.3 && prior ? prior.span_id : null,
          topic: 't', message_key: pick(['k1', 'k2']), idempotency_key: rnd() < 0.5 ? pick(['x', 'y']) : null, attempt_number: 1 + Math.floor(rnd() * 3),
          mutating: rnd() < 0.5, resource_ids: rnd() < 0.5 ? { reservation_id: `r${i}` } : {},
          awaited_correlation_id: rnd() < 0.2 && prior ? prior.event_id : null, retry_of_event_id: rnd() < 0.2 && prior ? prior.event_id : null,
        }),
      );
    }
    for (const rs of RULE_SETS) {
      const edges = deriveEdges(events, rs);
      const keys = new Set<string>();
      for (const e of edges) {
        assert.notEqual(e.from_event_id, e.to_event_id, `self-loop under ${rs.id}`);
        assert.ok(!keys.has(key(e)), 'duplicate edge');
        keys.add(key(e));
        if (e.evidence_class === 'inferred') assert.ok(e.confidence <= MAX_INFERRED_CONFIDENCE);
        assert.ok(e.confidence > 0 && e.confidence <= 1);
      }
    }
  }
});

test('TEMPORAL_PROXIMITY is weak, display-only, and enabled by no shipped rule set', () => {
  assert.ok(RULE_SETS.every((rs) => !rs.enabled.includes('rule.proximity@v1')));
  const events = [ev({ event_id: 'a', service: 's', operation: 'o1', event_type: 'domain.state_change', occurred_at: T0 }), ev({ event_id: 'b', service: 's', operation: 'o2', event_type: 'domain.state_change', occurred_at: T0 + 20 })];
  const edges = deriveEdges(events, { ...getRuleSet('default'), enabled: ['rule.proximity@v1'] });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.evidence_class, 'weak');
  assert.equal(edges[0]!.confidence, 0.1);
});
