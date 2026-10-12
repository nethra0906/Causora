/**
 * The edge-rule engine. Every rule is a PURE function over the events of one business operation:
 * no I/O, no clock, no randomness — so rules are unit-tested with no containers, derivation is
 * idempotent, and replay is just "derive again". Every edge carries the id of the rule that made it
 * and the field values that matched (the project's central claim: no edge without evidence).
 *
 * Metadata ablation is configuration, not code: a RuleSet names contract fields to treat as ABSENT
 * (`applyMask`) and the rules to run. Rules never know they are being ablated.
 */
import {
  DEFAULT_CONFIG, EDGE_META, MAX_INFERRED_CONFIDENCE, RULE_IDS,
  type AnalysisConfig, type CausalEdge, type ContractField, type EdgeType, type MatchedField, type NormalisedEvent, type RuleId, type RuleSet,
} from '../contracts/index.ts';

// ───────────────────────────── masking (simulates lost metadata) ─────────────────────────────
export function applyMask(events: NormalisedEvent[], masked: readonly ContractField[]): NormalisedEvent[] {
  if (masked.length === 0) return events;
  return events.map((e) => {
    const c: NormalisedEvent = { ...e };
    for (const f of masked) {
      if (f === 'attempt_number') c.attempt_number = 1;
      else (c as any)[f] = null;
    }
    return c;
  });
}

// ───────────────────────────── index ─────────────────────────────
export interface EventIndex {
  events: NormalisedEvent[];
  byId: Map<string, NormalisedEvent>;
  bySpanId: Map<string, NormalisedEvent>;
}

export function buildIndex(events: NormalisedEvent[]): EventIndex {
  const sorted = [...events].sort((a, b) => a.occurred_at - b.occurred_at || (a.event_id < b.event_id ? -1 : 1));
  const byId = new Map<string, NormalisedEvent>();
  const bySpanId = new Map<string, NormalisedEvent>();
  for (const e of sorted) {
    byId.set(e.event_id, e);
    if (e.span_id) bySpanId.set(e.span_id, e);
  }
  return { events: sorted, byId, bySpanId };
}

// ───────────────────────────── edge factory ─────────────────────────────
function mk(from: NormalisedEvent, to: NormalisedEvent, type: EdgeType, rule: RuleId, matched: MatchedField[], extra: Partial<CausalEdge['evidence']> & { confidence?: number } = {}): CausalEdge {
  const meta = EDGE_META[type];
  let confidence = extra.confidence ?? meta.confidence;
  // HARD CAP: no chain of inferences may ever outrank a proven chain (property-tested).
  if (meta.cls === 'inferred') confidence = Math.min(confidence, MAX_INFERRED_CONFIDENCE);
  const { confidence: _c, ...evidence } = extra;
  return { from_event_id: from.event_id, to_event_id: to.event_id, type, evidence_class: meta.cls, confidence, derived_by_rule: rule, evidence: { matched_fields: matched, ...evidence } };
}

type Rule = (ix: EventIndex, cfg: AnalysisConfig, enabled: ReadonlySet<RuleId>) => CausalEdge[];

// ───────────────────────────── proven rules ─────────────────────────────
const parentOf: Rule = (ix) => {
  const out: CausalEdge[] = [];
  for (const e of ix.events) {
    if (!e.parent_span_id) continue;
    const p = ix.bySpanId.get(e.parent_span_id);
    if (p && p.event_id !== e.event_id) out.push(mk(p, e, 'PARENT_OF', RULE_IDS.parentOf, [{ field: 'span_id = parent_span_id', from_value: p.span_id!, to_value: e.parent_span_id }]));
  }
  return out;
};

const triggered: Rule = (ix, _cfg, enabled) => {
  const out: CausalEdge[] = [];
  for (const e of ix.events) {
    if (!e.causation_id) continue;
    const src = ix.byId.get(e.causation_id);
    if (!src || src.event_id === e.event_id) continue;
    // Pure span parentage already proves this pair; do not draw the same arrow twice.
    if (enabled.has(RULE_IDS.parentOf) && e.parent_span_id && e.parent_span_id === src.span_id) continue;
    out.push(mk(src, e, 'TRIGGERED', RULE_IDS.triggered, [{ field: 'event_id = causation_id', from_value: src.event_id, to_value: e.causation_id }]));
  }
  return out;
};

const retryOf: Rule = (ix) => {
  const out: CausalEdge[] = [];
  for (const e of ix.events) {
    if (!e.retry_of_event_id) continue;
    const src = ix.byId.get(e.retry_of_event_id);
    if (src && src.event_id !== e.event_id)
      out.push(mk(src, e, 'RETRY_OF', RULE_IDS.retryOf, [
        { field: 'event_id = retry_of_event_id', from_value: src.event_id, to_value: e.retry_of_event_id },
        { field: 'attempt_number', from_value: String(src.attempt_number), to_value: String(e.attempt_number) },
      ]));
  }
  return out;
};

const timedOut: Rule = (ix) => {
  const out: CausalEdge[] = [];
  for (const e of ix.events) {
    if (e.event_type !== 'timeout.fired' || !e.awaited_correlation_id) continue;
    const src = ix.byId.get(e.awaited_correlation_id);
    if (src && src.event_id !== e.event_id) out.push(mk(src, e, 'TIMED_OUT_WAITING_FOR', RULE_IDS.timedOut, [{ field: 'event_id = awaited_correlation_id', from_value: src.event_id, to_value: e.awaited_correlation_id }]));
  }
  return out;
};

/** Ground-truth linkage. Proven, but EXCLUDED from ranking traversal (integrity rule). */
const faultAffected: Rule = (ix, cfg) => {
  const out: CausalEdge[] = [];
  const faults = ix.events.filter((e) => e.source === 'fault' && e.event_type === 'fault.injected');
  for (const f of faults) {
    const ttl = Number(f.attributes['fault.ttl_ms'] ?? 60_000);
    for (const e of ix.events) {
      if (e.source === 'fault' || !f.experiment_id || e.experiment_id !== f.experiment_id) continue;
      if (e.service !== f.service || e.operation !== f.operation) continue;
      if (e.occurred_at < f.occurred_at - cfg.clockUncertaintyMs || e.occurred_at > f.occurred_at + ttl) continue;
      out.push(mk(f, e, 'FAULT_AFFECTED', RULE_IDS.faultAffected, [
        { field: 'experiment_id', from_value: f.experiment_id, to_value: e.experiment_id },
        { field: 'service.operation', from_value: `${f.service}.${f.operation}`, to_value: `${e.service}.${e.operation}` },
      ], { window_ms: ttl }));
    }
  }
  return out;
};

// ───────────────────────────── derived rule ─────────────────────────────
/**
 * DUPLICATE_OF: two mutating consumptions with the same idempotency key, each of which produced a
 * DIFFERENT resource, close in time. Direction is canonical (earlier start → later, ties by event_id)
 * so the graph cannot flap; members are chained (n−1 edges) so a storm stays linear.
 */
const duplicate: Rule = (ix, cfg) => {
  const groups = new Map<string, NormalisedEvent[]>();
  for (const e of ix.events) {
    if (e.event_type !== 'messaging.consume' || !e.mutating || !e.idempotency_key) continue;
    const list = groups.get(e.idempotency_key) ?? [];
    list.push(e);
    groups.set(e.idempotency_key, list);
  }
  const out: CausalEdge[] = [];
  for (const [key, members] of groups) {
    const withResource = members.filter((m) => Object.keys(m.resource_ids).some((k) => k !== 'order_id'));
    withResource.sort((a, b) => a.occurred_at - b.occurred_at || (a.event_id < b.event_id ? -1 : 1));
    for (let i = 1; i < withResource.length; i++) {
      const a = withResource[i - 1]!;
      const b = withResource[i]!;
      const distinct = Object.keys(a.resource_ids).filter((k) => k !== 'order_id' && b.resource_ids[k] !== undefined && a.resource_ids[k] !== b.resource_ids[k]);
      if (distinct.length === 0) continue;
      const gap = b.occurred_at - (a.ended_at ?? a.occurred_at);
      if (gap > cfg.retryWindowMs) continue; // negative gap == overlapping intervals
      out.push(mk(a, b, 'DUPLICATE_OF', RULE_IDS.duplicate, [
        { field: 'idempotency_key', from_value: key, to_value: key },
        ...distinct.map((k) => ({ field: k, from_value: a.resource_ids[k]!, to_value: b.resource_ids[k]! })),
      ], { window_ms: cfg.retryWindowMs, notes: gap < 0 ? 'intervals overlap (concurrent)' : `started ${Math.round(gap)}ms after the other ended` }));
    }
  }
  return out;
};

// ───────────────────────────── inferred rules (only where the contract field is missing) ─────────────────────────────
const likelyTriggered: Rule = (ix, cfg) => {
  const out: CausalEdge[] = [];
  const produces = ix.events.filter((e) => e.event_type === 'messaging.produce');
  for (const c of ix.events) {
    if (c.event_type !== 'messaging.consume' || c.causation_id || !c.topic) continue;
    const cands = produces.filter((p) => p.topic === c.topic && p.message_key === c.message_key && p.occurred_at <= c.occurred_at + cfg.clockUncertaintyMs && c.occurred_at - p.occurred_at <= cfg.inferenceWindowMs);
    if (cands.length === 0) continue;
    const best = cands[cands.length - 1]!; // nearest preceding produce (events are time-sorted)
    const confidence = Math.max(0.45, Math.min(MAX_INFERRED_CONFIDENCE, 0.75 - 0.15 * (cands.length - 1)));
    out.push(mk(best, c, 'LIKELY_TRIGGERED', RULE_IDS.likelyTriggered, [
      { field: 'topic', from_value: best.topic!, to_value: c.topic },
      { field: 'message_key', from_value: String(best.message_key), to_value: String(c.message_key) },
    ], { confidence, window_ms: cfg.inferenceWindowMs, notes: `${cands.length} candidate producer(s); chose the nearest preceding publish` }));
  }
  return out;
};

/**
 * Second inference branch: an event with NO causation and NO span parent (a timer-driven or
 * otherwise orphaned internal event) is attributed to the latest event of the same business
 * operation that had already ended. Weakest inference in the system (0.45): it exists to show how
 * much of the chain heuristics can recover when the contract is gone, not to be trusted.
 */
function descendantSpanIds(ix: EventIndex, root: NormalisedEvent): Set<string> {
  const out = new Set<string>();
  if (!root.span_id) return out;
  const stack = [root.span_id];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of ix.events) if (e.parent_span_id === id && e.span_id && !out.has(e.span_id)) { out.add(e.span_id); stack.push(e.span_id); }
  }
  return out;
}

const likelyTriggeredOrphan: Rule = (ix, cfg) => {
  const out: CausalEdge[] = [];
  for (const e of ix.events) {
    if (e.causation_id || e.parent_span_id || !e.business_operation_id || e.source === 'fault') continue;
    if (e.event_type !== 'domain.state_change' && e.event_type !== 'timeout.fired') continue;
    // Same service only (a timer-driven continuation), and never one of the event's own descendants:
    // the clock tolerance below would otherwise admit a child that ended a few ms after its parent began.
    const own = descendantSpanIds(ix, e);
    let prior: NormalisedEvent | undefined;
    for (const p of ix.events) {
      if (p.event_id === e.event_id || p.source === 'fault' || p.service !== e.service || p.business_operation_id !== e.business_operation_id) continue;
      if (p.span_id && own.has(p.span_id)) continue;
      if ((p.ended_at ?? p.occurred_at) <= e.occurred_at + cfg.clockUncertaintyMs && (!prior || (p.ended_at ?? p.occurred_at) > (prior.ended_at ?? prior.occurred_at))) prior = p;
    }
    if (prior) out.push(mk(prior, e, 'LIKELY_TRIGGERED', RULE_IDS.likelyTriggered, [{ field: 'business_operation_id', from_value: prior.business_operation_id!, to_value: e.business_operation_id }], { confidence: 0.45, notes: 'orphan event attributed to the latest ended event of the same business operation' }));
  }
  return out;
};

const likelyRetry: Rule = (ix, cfg) => {
  const out: CausalEdge[] = [];
  const groups = new Map<string, NormalisedEvent[]>();
  for (const e of ix.events) {
    if ((e.event_type !== 'messaging.produce' && e.event_type !== 'http.client.request') || e.retry_of_event_id || !e.idempotency_key) continue;
    const k = `${e.service}|${e.operation}|${e.idempotency_key}`;
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.attempt_number - b.attempt_number || a.occurred_at - b.occurred_at);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      if (cur.attempt_number <= prev.attempt_number) continue;
      // A genuine retry is preceded by a deadline firing in the SAME service. Without this, two
      // downstream messages that merely inherited attempt numbers would be mistaken for retries.
      const deadline = ix.events.some((t) => t.event_type === 'timeout.fired' && t.service === cur.service && t.occurred_at >= prev.occurred_at - cfg.clockUncertaintyMs && t.occurred_at <= cur.occurred_at + cfg.clockUncertaintyMs);
      if (!deadline) continue;
      out.push(mk(prev, cur, 'LIKELY_RETRY_OF', RULE_IDS.likelyRetry, [
        { field: 'idempotency_key', from_value: prev.idempotency_key!, to_value: cur.idempotency_key! },
        { field: 'attempt_number', from_value: String(prev.attempt_number), to_value: String(cur.attempt_number) },
      ], { confidence: 0.6 }));
    }
  }
  return out;
};

/** Display-only weak edge. Never enabled by any shipped rule set and never traversed. */
const proximity: Rule = (ix) => {
  const out: CausalEdge[] = [];
  for (let i = 1; i < ix.events.length; i++) {
    const a = ix.events[i - 1]!;
    const b = ix.events[i]!;
    if (a.service === b.service && b.occurred_at - a.occurred_at <= 100 && a.source !== 'fault' && b.source !== 'fault')
      out.push(mk(a, b, 'TEMPORAL_PROXIMITY', RULE_IDS.proximity, [{ field: 'service', from_value: a.service, to_value: b.service }], { window_ms: 100 }));
  }
  return out;
};

export const RULES: Record<RuleId, Rule> = {
  [RULE_IDS.parentOf]: parentOf,
  [RULE_IDS.triggered]: triggered,
  [RULE_IDS.retryOf]: retryOf,
  [RULE_IDS.timedOut]: timedOut,
  [RULE_IDS.faultAffected]: faultAffected,
  [RULE_IDS.duplicate]: duplicate,
  [RULE_IDS.likelyTriggered]: (ix, cfg, en) => [...likelyTriggered(ix, cfg, en), ...likelyTriggeredOrphan(ix, cfg, en)],
  [RULE_IDS.likelyRetry]: likelyRetry,
  [RULE_IDS.proximity]: proximity,
};

// ───────────────────────────── derivation ─────────────────────────────
/**
 * Derive the edge set for one operation's events under a rule set. Deterministic and idempotent:
 * same events + same rule set ⇒ identical, sorted output, regardless of input order.
 */
export function deriveEdges(events: NormalisedEvent[], ruleSet: RuleSet, cfg: AnalysisConfig = DEFAULT_CONFIG): CausalEdge[] {
  const ix = buildIndex(applyMask(events, ruleSet.masked));
  const enabled = new Set<RuleId>(ruleSet.enabled);
  const seen = new Map<string, CausalEdge>();
  for (const id of ruleSet.enabled) {
    for (const edge of RULES[id](ix, cfg, enabled)) {
      const k = `${edge.from_event_id}|${edge.to_event_id}|${edge.type}`;
      if (!seen.has(k)) seen.set(k, edge);
    }
  }
  return [...seen.values()].sort((a, b) => (a.from_event_id + a.to_event_id + a.type < b.from_event_id + b.to_event_id + b.type ? -1 : 1));
}
