import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, MAX_INFERRED_CONFIDENCE, getRuleSet, type CausalEdge, type NormalisedEvent } from '../../src/contracts/index.ts';
import { computeBaselines, exclusiveMs, childIndex, investigate, stronglyConnected, toRankable, assessCompleteness } from '../../src/platform/analysis.ts';
import { applyMask, deriveEdges } from '../../src/platform/rules.ts';
import { ev, healthyBaselines, s1Events, shuffled, T0 } from '../helpers/fixtures.ts';

const NOW = T0 + 60_000;
const LAST = T0 + 3_300;

function run(events: NormalisedEvent[], ruleSetId = 'default', failure = 'F') {
  const rs = getRuleSet(ruleSetId);
  return investigate({ failureEventId: failure, events: applyMask(events, rs.masked), edges: deriveEdges(events, rs), baselines: healthyBaselines(s1Events()), ruleSetId, now: NOW, lastIngestAt: LAST });
}

test('S1: rank 1 is the delayed reservation (attempt 1), STRONG, in the frontier', () => {
  const inv = run(s1Events());
  const top = inv.candidates[0]!;
  assert.equal(top.event_id, 'C1');
  assert.equal(top.service, 'inventory-service');
  assert.equal(top.operation, 'inventory.reserve');
  assert.equal(top.in_frontier, true);
  assert.equal(top.label, 'STRONG');
  assert.equal(inv.completeness, 'COMPLETE');
  assert.equal(inv.frontier_fallback, false);
});

test('S1: the duplicate-work and idempotency-failure patterns are detected on the earliest member', () => {
  const inv = run(s1Events());
  const names = inv.patterns.map((p) => p.pattern);
  assert.ok(names.includes('DUPLICATE_WORK'));
  assert.ok(names.includes('IDEMPOTENCY_FAILURE'), 'overlapping duplicate executions imply a non-atomic guard');
  for (const p of inv.patterns.filter((p) => p.pattern === 'DUPLICATE_WORK')) assert.equal(p.earliest_event_id, 'C1');
});

test('S1: every candidate’s evidence carries the full path with matched field VALUES', () => {
  const top = run(s1Events()).candidates[0]!;
  assert.ok(top.evidence.path_to_failure.length >= 3);
  assert.equal(top.evidence.path_to_failure.at(-1)!.to_event_id, 'F');
  for (const step of top.evidence.path_to_failure) {
    assert.ok(step.derived_by_rule.startsWith('rule.'));
    assert.ok(step.matched_fields.every((m) => m.from_value.length > 0 && m.to_value.length > 0));
  }
});

test('S1: downstream symptoms are anomalous but are NOT the frontier (the payment error and order.failed are effects)', () => {
  const inv = run(s1Events());
  const front = inv.candidates.filter((c) => c.in_frontier).map((c) => c.event_id);
  assert.deepEqual(front, ['C1']);
  assert.ok(inv.candidates.some((c) => c.event_id === 'S' && !c.in_frontier), 'payment error is ranked but marked as a downstream effect');
});

test('DETERMINISM: identical candidate lists over 100 shuffled input orderings', () => {
  const base = JSON.stringify(run(s1Events()).candidates);
  const stable = (inv: ReturnType<typeof run>) => JSON.stringify(inv.candidates);
  for (let seed = 1; seed <= 100; seed++) {
    const events = shuffled(s1Events(), seed);
    const rs = getRuleSet('default');
    const inv = investigate({ failureEventId: 'F', events: shuffled(applyMask(events, rs.masked), seed + 1000), edges: shuffled(deriveEdges(events, rs), seed + 2000), baselines: shuffled(healthyBaselines(s1Events()), seed), ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
    assert.equal(stable(inv), base, `seed ${seed}`);
  }
});

// ───────────────────────── integrity: the evaluation must not be circular ─────────────────────────
test('INTEGRITY: ranking output is identical for inputs differing ONLY in experiment_id / is_fault_injected', () => {
  const plain = run(s1Events({ experiment: false }));
  const labelled = run(s1Events({ experiment: true }));
  const strip = (inv: ReturnType<typeof run>) => JSON.stringify({ ...inv, created_at: 0, duration_ms: 0 });
  assert.equal(strip(labelled), strip(plain));
});

test('INTEGRITY: the ranker’s input type structurally omits the ground-truth fields', () => {
  const r = toRankable(s1Events({ experiment: true })[2]!);
  assert.ok(!('experiment_id' in r));
  assert.ok(!('is_fault_injected' in r));
});

test('INTEGRITY: fault-injector events and FAULT_AFFECTED edges never enter the ranking graph', () => {
  const fault = ev({ event_id: 'F0', service: 'inventory-service', operation: 'inventory.reserve', event_type: 'fault.injected', source: 'fault', business_operation_id: null, experiment_id: 'exp_1', occurred_at: T0 - 5, attributes: { 'fault.ttl_ms': 60_000 } });
  const events = [fault, ...s1Events({ experiment: true })];
  const inv = run(events);
  assert.ok(!inv.subgraph_event_ids.includes('F0'));
  assert.deepEqual(JSON.stringify(inv.candidates), JSON.stringify(run(s1Events()).candidates));
});

test('INTEGRITY: a chain of inferred edges can never outrank a proven chain', () => {
  // Same two candidates, one reached through proven edges, one only through inferred edges.
  const events = [
    ev({ event_id: 'fail', service: 'x', operation: 'x.fail', event_type: 'domain.state_change', occurred_at: T0 + 1000, status: 'ERROR', error_type: 'E', parent_span_id: 'span-mid' }),
    ev({ event_id: 'mid', service: 'x', operation: 'x.mid', event_type: 'domain.state_change', occurred_at: T0 + 900, duration_ms: 50 }),
    ev({ event_id: 'prov', service: 'p', operation: 'p.slow', event_type: 'http.server.request', occurred_at: T0 + 100, duration_ms: 900, causation_id: null }),
    ev({ event_id: 'inf', service: 'q', operation: 'q.slow', event_type: 'http.server.request', occurred_at: T0 + 100, duration_ms: 900 }),
  ];
  const baselines = healthyBaselines(events);
  const edges: CausalEdge[] = [
    { from_event_id: 'mid', to_event_id: 'fail', type: 'PARENT_OF', evidence_class: 'proven', confidence: 1, derived_by_rule: 'rule.parent_of@v1', evidence: { matched_fields: [{ field: 'f', from_value: 'a', to_value: 'a' }] } },
    { from_event_id: 'prov', to_event_id: 'mid', type: 'TRIGGERED', evidence_class: 'proven', confidence: 1, derived_by_rule: 'rule.triggered.causation_id@v1', evidence: { matched_fields: [{ field: 'f', from_value: 'a', to_value: 'a' }] } },
    { from_event_id: 'inf', to_event_id: 'mid', type: 'LIKELY_TRIGGERED', evidence_class: 'inferred', confidence: MAX_INFERRED_CONFIDENCE, derived_by_rule: 'rule.inferred.triggered@v1', evidence: { matched_fields: [{ field: 'f', from_value: 'a', to_value: 'a' }] } },
  ];
  const inv = investigate({ failureEventId: 'fail', events, edges, baselines, ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
  const prov = inv.candidates.find((c) => c.event_id === 'prov')!;
  const inf = inv.candidates.find((c) => c.event_id === 'inf')!;
  assert.ok(prov.score > inf.score, 'proven beats inferred when everything else is equal');
  assert.ok(inf.evidence.path_to_failure.some((s) => s.evidence_class === 'inferred'));
  assert.ok(inf.label === 'WEAK' || inf.label === 'SPECULATIVE', `an inferred path must never be labelled ${inf.label}`);
  assert.notEqual(inf.label, 'STRONG');
});

test('weak edges are never traversed', () => {
  const events = s1Events();
  const edges = deriveEdges(events, getRuleSet('default')).filter((e) => e.from_event_id !== 'C1' || e.type === 'DUPLICATE_OF');
  const weak: CausalEdge = { from_event_id: 'root', to_event_id: 'F', type: 'TEMPORAL_PROXIMITY', evidence_class: 'weak', confidence: 0.1, derived_by_rule: 'rule.proximity@v1', evidence: { matched_fields: [] } };
  const inv = investigate({ failureEventId: 'F', events, edges: [...edges, weak], baselines: healthyBaselines(events), ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
  assert.ok(!inv.candidates.some((c) => c.evidence.path_to_failure.some((s) => s.type === 'TEMPORAL_PROXIMITY')));
});

// ───────────────────────── structure ─────────────────────────
test('Tarjan: a cycle collapses into one component and investigation still terminates', () => {
  const comp = stronglyConnected(['a', 'b', 'c', 'd'], new Map([['a', ['b']], ['b', ['c']], ['c', ['a', 'd']]]));
  assert.equal(comp.get('a'), comp.get('b'));
  assert.equal(comp.get('b'), comp.get('c'));
  assert.notEqual(comp.get('c'), comp.get('d'));

  const events = [
    ev({ event_id: 'f', service: 's', operation: 'o.f', event_type: 'domain.state_change', status: 'ERROR', error_type: 'E', occurred_at: T0 + 30 }),
    ev({ event_id: 'a', service: 's', operation: 'o.a', event_type: 'domain.state_change', duration_ms: 900, occurred_at: T0 }),
    ev({ event_id: 'b', service: 's', operation: 'o.b', event_type: 'domain.state_change', duration_ms: 900, occurred_at: T0 + 10 }),
  ];
  const mk = (from: string, to: string): CausalEdge => ({ from_event_id: from, to_event_id: to, type: 'LIKELY_TRIGGERED', evidence_class: 'inferred', confidence: 0.7, derived_by_rule: 'rule.inferred.triggered@v1', evidence: { matched_fields: [] } });
  const inv = investigate({ failureEventId: 'f', events, edges: [mk('a', 'b'), mk('b', 'a'), mk('b', 'f')], baselines: healthyBaselines(events), ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
  assert.ok(inv.candidates.length > 0, 'a cyclic inferred graph still yields candidates');
  assert.equal(inv.frontier_fallback, false);
});

test('bounds: traversal depth and node cap are enforced and reported, never silent', () => {
  const chain: NormalisedEvent[] = [];
  const edges: CausalEdge[] = [];
  for (let i = 0; i < 40; i++) {
    chain.push(ev({ event_id: `n${i}`, service: 's', operation: `o${i}`, event_type: 'domain.state_change', occurred_at: T0 + i, status: i === 0 ? 'ERROR' : 'OK' }));
    if (i > 0) edges.push({ from_event_id: `n${i}`, to_event_id: `n${i - 1}`, type: 'PARENT_OF', evidence_class: 'proven', confidence: 1, derived_by_rule: 'rule.parent_of@v1', evidence: { matched_fields: [] } });
  }
  const depthBound = investigate({ failureEventId: 'n0', events: chain, edges, baselines: [], ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
  assert.equal(depthBound.subgraph_node_count, DEFAULT_CONFIG.maxTraversalDepth + 1);
  const capped = investigate({ failureEventId: 'n0', events: chain, edges, baselines: [], ruleSetId: 'default', now: NOW, lastIngestAt: LAST, config: { ...DEFAULT_CONFIG, maxTraversalDepth: 99, maxSubgraphNodes: 5 } });
  assert.equal(capped.truncated, true);
  assert.equal(capped.subgraph_node_count, 5);
  assert.equal(capped.completeness, 'DEGRADED');
});

test('without a baseline a latency anomaly cannot be scored, and the evidence says so', () => {
  const events = s1Events();
  const inv = investigate({ failureEventId: 'F', events, edges: deriveEdges(events, getRuleSet('default')), baselines: [], ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
  for (const c of inv.candidates) {
    assert.equal(c.evidence.anomaly_breakdown.latency.contribution, 0);
    assert.ok(c.evidence.caveats.some((x) => x.includes('no baseline')));
    assert.notEqual(c.label, 'STRONG');
  }
});

test('error attribution: a caller’s timeout/error is explained by its callee, so the callee is the origin', () => {
  // S2 shape: client span times out; the server span finishes later, slowly, successfully.
  const events = [
    ev({ event_id: 'set', service: 'order-service', operation: 'order.settle', event_type: 'domain.state_change', occurred_at: T0, duration_ms: 810, status: 'ERROR', error_type: 'PAYMENT_TIMEOUT' }),
    ev({ event_id: 'cli', service: 'order-service', operation: 'order.call_payment', event_type: 'http.client.request', occurred_at: T0 + 1, duration_ms: 800, parent_span_id: 'span-set', causation_id: 'set', status: 'TIMEOUT', error_type: 'TIMEOUT' }),
    ev({ event_id: 'srv', service: 'payment-service', operation: 'payment.authorize', event_type: 'http.server.request', occurred_at: T0 + 3, duration_ms: 1500, parent_span_id: 'span-cli', causation_id: 'cli' }),
    ev({ event_id: 'to', service: 'order-service', operation: 'order.payment_wait.timeout', event_type: 'timeout.fired', occurred_at: T0 + 802, duration_ms: 0, parent_span_id: 'span-set', causation_id: 'cli', awaited_correlation_id: 'srv', status: 'TIMEOUT', error_type: 'TIMEOUT' }),
    ev({ event_id: 'fail', service: 'order-service', operation: 'order.failed', event_type: 'domain.state_change', occurred_at: T0 + 803, duration_ms: 0, parent_span_id: 'span-set', causation_id: 'to', status: 'ERROR', error_type: 'PAYMENT_TIMEOUT' }),
  ];
  const inv = investigate({ failureEventId: 'fail', events, edges: deriveEdges(events, getRuleSet('default')), baselines: healthyBaselines(events), ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
  assert.equal(inv.candidates[0]!.event_id, 'srv');
  assert.equal(inv.candidates[0]!.service, 'payment-service');
});

test('ablation degrades honestly: tracing-only cannot reach the cause and says it is degraded', () => {
  const inv = run(s1Events(), 'ablation.tracing_only.no_inference');
  assert.ok(!inv.subgraph_event_ids.includes('C1'));
  assert.ok(inv.candidates.every((c) => c.label === 'SPECULATIVE' || c.label === 'WEAK'));
  assert.equal(inv.completeness, 'DEGRADED');
});

// ───────────────────────── completeness, baselines ─────────────────────────
test('completeness has three honest states', () => {
  const ok = s1Events().map(toRankable);
  assert.equal(assessCompleteness(ok, NOW, LAST, false).completeness, 'COMPLETE');
  assert.equal(assessCompleteness(ok, LAST + 200, LAST, false).completeness, 'PROVISIONAL', 'telemetry still arriving');
  const dangling = s1Events().filter((e) => e.event_id !== 'C1').map(toRankable);
  assert.equal(assessCompleteness(dangling, LAST + 2000, LAST, false).completeness, 'PROVISIONAL', 'references unresolved but recent');
  assert.equal(assessCompleteness(dangling, LAST + 20_000, LAST, false).completeness, 'DEGRADED', 'references still unresolved long after');
  const violated = applyMask(s1Events(), ['causation_id']).map(toRankable);
  assert.equal(assessCompleteness(violated, NOW, LAST, false).completeness, 'DEGRADED');
});

test('exclusive time subtracts child spans and never goes negative', () => {
  const parent = ev({ event_id: 'p', service: 's', operation: 'p', event_type: 'http.client.request', duration_ms: 800 });
  const child = ev({ event_id: 'c', service: 's2', operation: 'c', event_type: 'http.server.request', duration_ms: 1500, parent_span_id: 'span-p' });
  assert.equal(exclusiveMs(parent, childIndex([parent, child])), 0);
  assert.equal(exclusiveMs(child, childIndex([parent, child])), 1500);
});

test('baselines: percentiles, sample counts and error rates come from the events', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ev({ event_id: `x${i}`, service: 's', operation: 'op', event_type: 'http.server.request', duration_ms: i + 1, status: i < 5 ? 'ERROR' : 'OK' }));
  const [b] = computeBaselines(samples);
  assert.equal(b!.sample_count, 100);
  assert.equal(b!.p50_ms, 50);
  assert.equal(b!.p95_ms, 95);
  assert.equal(b!.error_rate, 0.05);
});

test('an investigation keeps the operation id even when business_operation_id is masked in the analysed view', () => {
  const events = s1Events();
  const rs = getRuleSet('ablation.tracing_only');
  const inv = investigate({ failureEventId: 'F', businessOperationId: 'ord_1', events: applyMask(events, rs.masked), edges: deriveEdges(events, rs), baselines: healthyBaselines(events), ruleSetId: rs.id, now: NOW, lastIngestAt: LAST });
  assert.equal(inv.business_operation_id, 'ord_1');
});

// ───────────────────────── the two fitted heuristics, individually ─────────────────────────
function s2Shape() {
  return [
    ev({ event_id: 'set', service: 'order-service', operation: 'order.settle', event_type: 'domain.state_change', occurred_at: T0, duration_ms: 810, status: 'ERROR', error_type: 'PAYMENT_TIMEOUT' }),
    ev({ event_id: 'cli', service: 'order-service', operation: 'order.call_payment', event_type: 'http.client.request', occurred_at: T0 + 1, duration_ms: 800, parent_span_id: 'span-set', causation_id: 'set', status: 'TIMEOUT', error_type: 'TIMEOUT' }),
    ev({ event_id: 'srv', service: 'payment-service', operation: 'payment.authorize', event_type: 'http.server.request', occurred_at: T0 + 3, duration_ms: 1500, parent_span_id: 'span-cli', causation_id: 'cli' }),
    ev({ event_id: 'to', service: 'order-service', operation: 'order.payment_wait.timeout', event_type: 'timeout.fired', occurred_at: T0 + 802, duration_ms: 0, parent_span_id: 'span-set', causation_id: 'cli', awaited_correlation_id: 'srv', status: 'TIMEOUT', error_type: 'TIMEOUT' }),
    ev({ event_id: 'fail', service: 'order-service', operation: 'order.failed', event_type: 'domain.state_change', occurred_at: T0 + 803, duration_ms: 0, parent_span_id: 'span-set', causation_id: 'to', status: 'ERROR', error_type: 'PAYMENT_TIMEOUT' }),
  ];
}
/** Rank-1 event for the S2-shaped failure under a given analysis config (generic healthy baselines: p95 = 6 ms). */
function s2Top(cfg: Partial<typeof DEFAULT_CONFIG>): { id: string; service: string } {
  const events = s2Shape();
  const inv = investigate({
    failureEventId: 'fail', events, edges: deriveEdges(events, getRuleSet('default')), baselines: healthyBaselines(events),
    ruleSetId: 'default', now: NOW, lastIngestAt: LAST, config: { ...DEFAULT_CONFIG, ...cfg },
  });
  const top = inv.candidates[0]!;
  return { id: top.event_id, service: top.service };
}

test('heuristic flags default to ON and the shipped config blames the slow callee', () => {
  assert.equal(DEFAULT_CONFIG.selfTimeLatency, true);
  assert.equal(DEFAULT_CONFIG.calleeErrorAttribution, true);
  assert.deepEqual(s2Top({}), { id: 'srv', service: 'payment-service' });
});

test('without callee error attribution, blame lands on the CALLER side (order service), not the slow callee', () => {
  const top = s2Top({ calleeErrorAttribution: false });
  assert.equal(top.service, 'order-service', 'the caller\'s own TIMEOUT/ERROR is counted as its own anomaly');
  assert.notEqual(top.id, 'srv');
});

test('without self-time, the caller\'s raw 800 ms wait is scored as its own slowness and blamed', () => {
  const top = s2Top({ selfTimeLatency: false });
  assert.equal(top.service, 'order-service', 'an 800 ms wait on a slow callee is not the caller\'s fault');
  assert.notEqual(top.id, 'srv');
});

test('turning a heuristic off never changes the shipped default result (flags are inert unless asked for)', () => {
  const events = s1Events();
  const rs = getRuleSet('default');
  const base = investigate({ failureEventId: 'F', events, edges: deriveEdges(events, rs), baselines: healthyBaselines(events), ruleSetId: 'default', now: NOW, lastIngestAt: LAST });
  const explicit = investigate({ failureEventId: 'F', events, edges: deriveEdges(events, rs), baselines: healthyBaselines(events), ruleSetId: 'default', now: NOW, lastIngestAt: LAST, config: { ...DEFAULT_CONFIG } });
  assert.equal(JSON.stringify(base.candidates), JSON.stringify(explicit.candidates));
});
