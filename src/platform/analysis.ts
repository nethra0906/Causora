/**
 * Failure analysis (docs/algorithms/failure-analysis.md). Nothing here is machine learning or
 * causal inference: it is a declared, inspectable heuristic over a graph whose edges are mostly
 * proven. Same input + same config ⇒ byte-identical output (property-tested over shuffled inputs).
 *
 *   scope → baseline → score → frontier → patterns → rank → evidence → label
 */
import {
  DEFAULT_CONFIG, TIMING,
  type AnalysisConfig, type Baseline, type Candidate, type CandidateEvidence, type CausalEdge, type Completeness,
  type ConfidenceLabel, type Investigation, type NormalisedEvent, type PathStep, type PatternMatch, type RankableEvent,
} from '../contracts/index.ts';

// ───────────────────────────── integrity projection ─────────────────────────────
/**
 * THE ONE PLACE ground truth is stripped. `experiment_id` and `is_fault_injected` exist solely to
 * label evaluation runs and to draw the fault badge AFTER ranking. If the ranker could see them the
 * evaluation would be circular. Do not "helpfully" add them back; test/unit/integrity.test.ts will fail.
 */
export function toRankable(e: NormalisedEvent): RankableEvent {
  const { is_fault_injected: _gt1, experiment_id: _gt2, ...rest } = e;
  return rest;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const opKey = (e: { service: string; operation: string }) => `${e.service}|${e.operation}`;
const isErr = (e: { status: string }) => e.status === 'ERROR' || e.status === 'TIMEOUT';

// ───────────────────────────── exclusive time & baselines ─────────────────────────────
export function childIndex<T extends { parent_span_id: string | null }>(events: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const e of events) {
    if (!e.parent_span_id) continue;
    const l = m.get(e.parent_span_id) ?? [];
    l.push(e);
    m.set(e.parent_span_id, l);
  }
  return m;
}

/**
 * Self time: duration minus the time spent inside child spans, clamped at zero. A caller that gave
 * up (timeout) or merely waited on a slow callee must not look slower than the callee itself.
 */
export function exclusiveMs(e: { duration_ms: number | null; span_id: string | null }, children: Map<string, Array<{ duration_ms: number | null }>>): number | null {
  if (e.duration_ms === null) return null;
  const kids = e.span_id ? (children.get(e.span_id) ?? []) : [];
  const inKids = kids.reduce((s, k) => s + (k.duration_ms ?? 0), 0);
  return Math.max(0, e.duration_ms - inKids);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** `selfTime=false` is only for the heuristic ablation: a naive analyser would baseline raw durations too. */
export function computeBaselines(events: NormalisedEvent[], selfTime = true): Array<Baseline & { dwell_p95_ms: number | null }> {
  const spans = events.filter((e) => e.source !== 'fault');
  const kids = childIndex(spans);
  const groups = new Map<string, NormalisedEvent[]>();
  for (const e of spans) {
    const l = groups.get(opKey(e)) ?? [];
    l.push(e);
    groups.set(opKey(e), l);
  }
  const out: Array<Baseline & { dwell_p95_ms: number | null }> = [];
  for (const [, list] of [...groups].sort((a, b) => cmp(a[0], b[0]))) {
    const durs = list.map((e) => (selfTime ? exclusiveMs(e, kids) : e.duration_ms)).filter((d): d is number => d !== null).sort((a, b) => a - b);
    const dwells = list.map((e) => e.dwell_ms).filter((d): d is number => d !== null).sort((a, b) => a - b);
    out.push({
      service: list[0]!.service,
      operation: list[0]!.operation,
      sample_count: durs.length,
      p50_ms: percentile(durs, 0.5),
      p95_ms: percentile(durs, 0.95),
      error_rate: list.filter(isErr).length / list.length,
      dwell_p95_ms: dwells.length ? percentile(dwells, 0.95) : null,
    });
  }
  return out;
}

// ───────────────────────────── Tarjan SCC (cycle collapse) ─────────────────────────────
/** Returns component ids; nodes in a cycle share one. Graph depth is bounded by maxSubgraphNodes. */
export function stronglyConnected(nodes: string[], adj: Map<string, string[]>): Map<string, number> {
  let index = 0;
  let comp = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out = new Map<string, number>();
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        out.set(w, comp);
        if (w === v) break;
      }
      comp++;
    }
  };
  for (const n of [...nodes].sort(cmp)) if (!idx.has(n)) visit(n);
  return out;
}

// ───────────────────────────── investigation ─────────────────────────────
export interface InvestigateInput {
  failureEventId: string;
  /** Identity of the operation, taken from the failure RECORD - never from the (possibly masked) event view. */
  businessOperationId?: string | null;
  /** The (possibly rule-set-masked) event view for ONE business operation. */
  events: NormalisedEvent[];
  edges: CausalEdge[];
  baselines: Array<Baseline & { dwell_p95_ms?: number | null }>;
  ruleSetId: string;
  config?: AnalysisConfig;
  now: number;
  lastIngestAt: number | null;
}

interface Reach {
  depth: number;
  conf: number;
  via: CausalEdge | null; // edge leading one hop closer to the failure
}

export function investigate(input: InvestigateInput): Investigation {
  const t0 = performance.now();
  const cfg = input.config ?? DEFAULT_CONFIG;

  // Fault-injector events and FAULT_AFFECTED edges never enter ranking (integrity rule).
  const evs = input.events.filter((e) => e.source !== 'fault').map(toRankable);
  const byId = new Map(evs.map((e) => [e.event_id, e]));
  const failure = byId.get(input.failureEventId);
  if (!failure) throw new Error(`failure event ${input.failureEventId} not found`);

  const trav = input.edges
    .filter((e) => e.evidence_class !== 'weak' && e.type !== 'FAULT_AFFECTED' && byId.has(e.from_event_id) && byId.has(e.to_event_id))
    .sort((a, b) => cmp(a.from_event_id + a.to_event_id + a.type, b.from_event_id + b.to_event_id + b.type));
  const incoming = new Map<string, CausalEdge[]>();
  const outgoing = new Map<string, CausalEdge[]>();
  for (const e of trav) {
    (incoming.get(e.to_event_id) ?? incoming.set(e.to_event_id, []).get(e.to_event_id)!).push(e);
    (outgoing.get(e.from_event_id) ?? outgoing.set(e.from_event_id, []).get(e.from_event_id)!).push(e);
  }

  // ── Stage 1: scope - reverse reachability, bounded, cycle-safe, best-confidence path per node ──
  const reach = new Map<string, Reach>([[failure.event_id, { depth: 0, conf: 1, via: null }]]);
  let truncated = false;
  let wave = [failure.event_id];
  for (let d = 1; d <= cfg.maxTraversalDepth && wave.length > 0; d++) {
    const next = new Set<string>();
    for (const node of wave.sort(cmp)) {
      const here = reach.get(node)!;
      for (const edge of incoming.get(node) ?? []) {
        const conf = here.conf * edge.confidence;
        if (conf < cfg.minPathConfidence) continue;
        const cur = reach.get(edge.from_event_id);
        if (!cur) {
          if (reach.size >= cfg.maxSubgraphNodes) { truncated = true; continue; }
          reach.set(edge.from_event_id, { depth: d, conf, via: edge });
          next.add(edge.from_event_id);
        } else if (conf > cur.conf + 1e-9) {
          reach.set(edge.from_event_id, { depth: cur.depth, conf, via: edge });
          next.add(edge.from_event_id);
        }
      }
    }
    wave = [...next];
  }
  const nodes = [...reach.keys()].sort(cmp);
  const inSub = new Set(nodes);
  const subEdges = trav.filter((e) => inSub.has(e.from_event_id) && inSub.has(e.to_event_id));

  // ── cycle collapse ──
  const adj = new Map<string, string[]>();
  for (const e of subEdges) (adj.get(e.from_event_id) ?? adj.set(e.from_event_id, []).get(e.from_event_id)!).push(e.to_event_id);
  const comp = stronglyConnected(nodes, adj);

  // ── Stages 2–3: baseline attachment and per-node anomaly ──
  const kids = childIndex(evs);
  const baseline = new Map(input.baselines.map((b) => [opKey(b), b]));
  const retryTargets = new Set(trav.filter((e) => e.type === 'RETRY_OF' || e.type === 'LIKELY_RETRY_OF').map((e) => e.to_event_id));

  const downstream = (start: string): Set<string> => {
    const seen = new Set<string>();
    const st = [start];
    while (st.length) {
      const n = st.pop()!;
      for (const e of outgoing.get(n) ?? []) if (!seen.has(e.to_event_id)) { seen.add(e.to_event_id); st.push(e.to_event_id); }
    }
    return seen;
  };

  // observed per-operation error rate inside the subgraph (own, undiscounted errors only)
  const ownError = (e: RankableEvent): boolean => {
    if (!isErr(e)) return false;
    if (!cfg.calleeErrorAttribution) return true; // ablation: every errored span claims its own error
    if (e.event_type === 'http.client.request' || e.event_type === 'timeout.fired') return false; // symptom types: they report on someone else
    return !(kids.get(e.span_id ?? '') ?? []).some(isErr); // bubbled-up from a failing child
  };
  const opTotals = new Map<string, { n: number; err: number }>();
  for (const id of nodes) {
    const e = byId.get(id)!;
    const t = opTotals.get(opKey(e)) ?? { n: 0, err: 0 };
    t.n++;
    if (ownError(e)) t.err++;
    opTotals.set(opKey(e), t);
  }

  const w = cfg.anomalyWeights;
  const scored = new Map<string, { anomaly: number; breakdown: CandidateEvidence['anomaly_breakdown']; baselineAvailable: boolean }>();
  for (const id of nodes) {
    const e = byId.get(id)!;
    const b = baseline.get(opKey(e));
    const available = !!b && b.sample_count >= cfg.minBaselineSamples;
    const excl = cfg.selfTimeLatency ? exclusiveMs(e, kids) : e.duration_ms;

    let z = 0;
    let latency = 0;
    if (available && excl !== null) {
      const spread = Math.max(b!.p95_ms - b!.p50_ms, cfg.minSpreadMs);
      z = (excl - b!.p95_ms) / spread;
      // NOISE FLOOR: with sub-millisecond baselines a ~45 ms stall (GC pause, disk flush, CPU steal on a
      // shared runner) already saturates the z-score. Because the frontier rule promotes the earliest anomalous
      // ancestor, one such blip upstream of the real fault would hijack rank 1 (found by a CI failure; see
      // docs/experiments/jitter-sensitivity.md). Below the floor, latency simply is not evidence.
      if (excl >= cfg.minLatencyAnomalyMs) latency = clamp(z / cfg.zSaturation, 0, 1);
    }
    const error = ownError(e) ? 1 : 0;
    const totals = opTotals.get(opKey(e))!;
    const observed = totals.err / totals.n;
    const errorRate = error && available ? clamp((observed - b!.error_rate) / 0.5, 0, 1) : 0;
    const retries = [...downstream(id)].filter((d) => retryTargets.has(d)).length;
    const retry = clamp(retries / cfg.retrySaturation, 0, 1);
    const dwellP95 = (b as any)?.dwell_p95_ms ?? null;
    const dwell = available && e.dwell_ms !== null && dwellP95 !== null ? clamp(e.dwell_ms / Math.max(dwellP95, 1) / cfg.dwellSaturation, 0, 1) : 0;

    const anomaly = w.latency * latency + w.error * error + w.errorRate * errorRate + w.retry * retry + w.dwell * dwell;
    scored.set(id, {
      anomaly,
      baselineAvailable: available,
      breakdown: {
        latency: { exclusive_ms: excl, baseline_p50: b?.p50_ms ?? null, baseline_p95: b?.p95_ms ?? null, z, contribution: w.latency * latency },
        error: { status: e.status, error_type: e.error_type, discounted_for_callee_error: isErr(e) && !error, contribution: w.error * error },
        error_rate: { observed, baseline: b?.error_rate ?? null, contribution: w.errorRate * errorRate },
        retries: { descendant_retry_count: retries, contribution: w.retry * retry },
        dwell: { dwell_ms: e.dwell_ms, baseline_p95: dwellP95, clock_uncertainty_ms: cfg.clockUncertaintyMs, contribution: w.dwell * dwell },
      },
    });
  }

  // ── Stage 4: frontier = anomalous nodes with no anomalous ancestor (on the SCC-condensed graph) ──
  const compAnomaly = new Map<number, number>();
  for (const id of nodes) compAnomaly.set(comp.get(id)!, Math.max(compAnomaly.get(comp.get(id)!) ?? 0, scored.get(id)!.anomaly));
  const compPreds = new Map<number, Set<number>>();
  for (const e of subEdges) {
    const a = comp.get(e.from_event_id)!;
    const b = comp.get(e.to_event_id)!;
    if (a !== b) (compPreds.get(b) ?? compPreds.set(b, new Set()).get(b)!).add(a);
  }
  const memo = new Map<number, boolean>();
  const hasAnomalousAncestor = (c: number): boolean => {
    const hit = memo.get(c);
    if (hit !== undefined) return hit;
    memo.set(c, false); // cycle guard on the (acyclic by construction) condensation
    let res = false;
    for (const p of compPreds.get(c) ?? []) if ((compAnomaly.get(p) ?? 0) >= cfg.anomalyThreshold || hasAnomalousAncestor(p)) { res = true; break; }
    memo.set(c, res);
    return res;
  };
  const anomalous = nodes.filter((id) => scored.get(id)!.anomaly >= cfg.anomalyThreshold);
  let frontier = anomalous.filter((id) => !hasAnomalousAncestor(comp.get(id)!));
  let frontierFallback = false;
  if (frontier.length === 0 && anomalous.length > 0) {
    frontierFallback = true; // never return empty without saying why
    const maxDepth = Math.max(...anomalous.map((id) => reach.get(id)!.depth));
    frontier = anomalous.filter((id) => reach.get(id)!.depth === maxDepth);
  }
  const frontierSet = new Set(frontier);

  // ── Stage 5: patterns ──
  const patterns = detectPatterns({ nodes, byId, subEdges, scored, cfg });

  // ── Stage 6: rank ──
  const bonusFor = (id: string) => patterns.filter((p) => p.earliest_event_id === id).reduce((s, p) => s + (cfg.patternBonus[p.pattern] ?? 0), 0);
  const rw = cfg.rankWeights;
  const ranked = anomalous
    .map((id) => {
      const r = reach.get(id)!;
      const s = scored.get(id)!;
      const score = rw.anomaly * s.anomaly + rw.proximity * (1 / (1 + r.depth)) + rw.path * r.conf + rw.pattern * bonusFor(id);
      return { id, score, r, s };
    })
    .sort((a, b) => {
      const fa = frontierSet.has(a.id) ? 1 : 0;
      const fb = frontierSet.has(b.id) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      if (a.r.depth !== b.r.depth) return b.r.depth - a.r.depth; // prefer the more upstream cause
      const ea = byId.get(a.id)!;
      const eb = byId.get(b.id)!;
      return ea.occurred_at - eb.occurred_at || cmp(a.id, b.id);
    });

  // ── completeness (computed on the same masked view the graph was built from) ──
  const { completeness, reasons } = assessCompleteness(evs, input.now, input.lastIngestAt, truncated);

  // ── Stages 7–8: evidence and labels ──
  const descendants = nodes.length <= 400 ? reachability(nodes, adj) : null;
  const candidates: Candidate[] = ranked.slice(0, 10).map((c, i) => {
    const e = byId.get(c.id)!;
    const path = pathToFailure(c.id, reach);
    const myPatterns = patterns.filter((p) => p.member_event_ids.includes(c.id));
    const caveats: string[] = [];
    if (!c.s.baselineAvailable) caveats.push('no baseline available for this operation; latency could not be scored');
    const inferred = path.filter((p) => p.evidence_class === 'inferred').length;
    if (inferred > 0) caveats.push(`${inferred} inferred hop(s) in the path to the failure`);
    if (truncated) caveats.push(`subgraph truncated at ${cfg.maxSubgraphNodes} nodes`);
    if (frontierFallback) caveats.push('no frontier found; fell back to the deepest anomalous nodes');
    const missing = evs.filter((x) => x.contract_violations.some((v) => v.endsWith('causation_id'))).length;
    if (missing > 0) caveats.push(`causation_id missing on ${missing} event(s)`);
    if (!descendants) caveats.push('concurrency not computed: subgraph too large');
    for (const r of reasons) caveats.push(`completeness: ${r}`);

    const inFrontier = frontierSet.has(c.id);
    const allProvenOrDerived = path.every((p) => p.evidence_class === 'proven' || p.evidence_class === 'derived');
    let label: ConfidenceLabel;
    if (c.r.conf < 0.5 || completeness === 'DEGRADED' || frontierFallback) label = 'SPECULATIVE';
    else if (allProvenOrDerived && inFrontier && myPatterns.length >= 1 && c.s.baselineAvailable && completeness === 'COMPLETE') label = 'STRONG';
    else if (allProvenOrDerived && inFrontier && c.s.baselineAvailable && completeness !== 'PROVISIONAL') label = 'SUPPORTED';
    else label = 'WEAK';

    const concurrent = descendants
      ? nodes.filter((n) => n !== c.id && !descendants.get(c.id)!.has(n) && !descendants.get(n)!.has(c.id)).sort(cmp)
      : [];
    return {
      rank: i + 1, event_id: c.id, service: e.service, operation: e.operation, attempt_number: e.attempt_number,
      in_frontier: inFrontier, score: c.score, anomaly: c.s.anomaly, depth: c.r.depth, label,
      evidence: { candidate_event_id: c.id, path_to_failure: path, anomaly_breakdown: c.s.breakdown, patterns: myPatterns, concurrent_with: concurrent, caveats },
    };
  });

  return {
    failure_event_id: failure.event_id,
    business_operation_id: input.businessOperationId ?? failure.business_operation_id,
    rule_set_id: input.ruleSetId,
    mode: 'default',
    completeness,
    completeness_reasons: reasons,
    subgraph_node_count: nodes.length,
    subgraph_edge_count: subEdges.length,
    subgraph_event_ids: nodes,
    truncated,
    frontier_fallback: frontierFallback,
    candidates,
    patterns,
    config_snapshot: cfg,
    duration_ms: performance.now() - t0,
    created_at: input.now,
  };
}

function pathToFailure(from: string, reach: Map<string, Reach>): PathStep[] {
  const steps: PathStep[] = [];
  let cur = from;
  for (let guard = 0; guard < 64; guard++) {
    const via = reach.get(cur)?.via;
    if (!via) break;
    steps.push({
      from_event_id: via.from_event_id, to_event_id: via.to_event_id, type: via.type, evidence_class: via.evidence_class,
      confidence: via.confidence, derived_by_rule: via.derived_by_rule, matched_fields: via.evidence.matched_fields,
    });
    cur = via.to_event_id;
  }
  return steps;
}

function reachability(nodes: string[], adj: Map<string, string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const n of nodes) {
    const seen = new Set<string>();
    const st = [n];
    while (st.length) {
      const x = st.pop()!;
      for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); }
    }
    out.set(n, seen);
  }
  return out;
}

// ───────────────────────────── completeness ─────────────────────────────
export function assessCompleteness(evs: RankableEvent[], now: number, lastIngestAt: number | null, truncated: boolean): { completeness: Completeness; reasons: string[] } {
  const ids = new Set(evs.map((e) => e.event_id));
  let dangling = 0;
  let violations = 0;
  for (const e of evs) {
    for (const ref of [e.causation_id, e.retry_of_event_id, e.awaited_correlation_id]) if (ref && !ids.has(ref)) dangling++;
    if (e.event_type === 'messaging.consume' && !e.causation_id) violations++;
    if (e.event_type === 'timeout.fired' && !e.awaited_correlation_id) violations++;
    if (e.mutating && !e.idempotency_key) violations++;
  }
  const reasons: string[] = [];
  const quiet = lastIngestAt === null || now - lastIngestAt >= TIMING.quietMs;
  if (violations > 0) reasons.push(`${violations} contract field(s) missing`);
  if (dangling > 0) reasons.push(`${dangling} reference(s) point to events not yet received`);
  if (!quiet) reasons.push('telemetry for this operation is still arriving');
  if (truncated) reasons.push('traversal truncated');
  let completeness: Completeness = 'COMPLETE';
  if (violations > 0 || truncated || (dangling > 0 && quiet && lastIngestAt !== null && now - lastIngestAt >= 6000)) completeness = 'DEGRADED';
  else if (dangling > 0 || !quiet) completeness = 'PROVISIONAL';
  return { completeness, reasons };
}

// ───────────────────────────── patterns ─────────────────────────────
function detectPatterns(a: {
  nodes: string[];
  byId: Map<string, RankableEvent>;
  subEdges: CausalEdge[];
  scored: Map<string, { anomaly: number; breakdown: CandidateEvidence['anomaly_breakdown'] }>;
  cfg: AnalysisConfig;
}): PatternMatch[] {
  const out: PatternMatch[] = [];
  const earliest = (ids: string[]) => [...ids].sort((x, y) => a.byId.get(x)!.occurred_at - a.byId.get(y)!.occurred_at || cmp(x, y))[0]!;
  const chains = (type: string): string[][] => {
    const adj = new Map<string, Set<string>>();
    const link = (x: string, y: string) => (adj.get(x) ?? adj.set(x, new Set()).get(x)!).add(y);
    for (const e of a.subEdges.filter((x) => x.type === type)) { link(e.from_event_id, e.to_event_id); link(e.to_event_id, e.from_event_id); }
    const seen = new Set<string>();
    const comps: string[][] = [];
    for (const s of [...adj.keys()].sort(cmp)) {
      if (seen.has(s)) continue;
      const comp: string[] = [];
      const st = [s];
      seen.add(s);
      while (st.length) {
        const x = st.pop()!;
        comp.push(x);
        for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); }
      }
      comps.push(comp);
    }
    return comps.sort((x, y) => cmp(earliest(x), earliest(y)));
  };

  for (const members of chains('DUPLICATE_OF')) {
    const evs = members.map((id) => a.byId.get(id)!).sort((x, y) => x.occurred_at - y.occurred_at);
    const overlapping = evs.some((e, i) => i > 0 && e.occurred_at < (evs[i - 1]!.ended_at ?? e.occurred_at));
    out.push({ pattern: 'DUPLICATE_WORK', member_event_ids: members.sort(cmp), earliest_event_id: earliest(members), evidence: { idempotency_key: evs[0]!.idempotency_key, members: members.length } });
    if (overlapping)
      out.push({ pattern: 'IDEMPOTENCY_FAILURE', member_event_ids: members.sort(cmp), earliest_event_id: earliest(members), evidence: { note: 'duplicate executions overlapped in time: the idempotency guard is not atomic with the work', idempotency_key: evs[0]!.idempotency_key } });
  }
  for (const members of chains('RETRY_OF').concat(chains('LIKELY_RETRY_OF')))
    if (members.length >= 3) out.push({ pattern: 'RETRY_STORM', member_event_ids: members.sort(cmp), earliest_event_id: earliest(members), evidence: { attempts: members.length } });

  for (const e of a.subEdges.filter((x) => x.type === 'TIMED_OUT_WAITING_FOR')) {
    out.push({ pattern: 'TIMEOUT_CASCADE', member_event_ids: [e.from_event_id, e.to_event_id].sort(cmp), earliest_event_id: e.from_event_id, evidence: { awaited: e.from_event_id, timeout: e.to_event_id } });
  }
  for (const id of a.nodes) {
    const e = a.byId.get(id)!;
    const s = a.scored.get(id)!;
    if (e.event_type === 'messaging.consume' && s.breakdown.latency.contribution + s.breakdown.dwell.contribution >= a.cfg.anomalyWeights.latency * 0.5)
      out.push({ pattern: 'SLOW_CONSUMER', member_event_ids: [id], earliest_event_id: id, evidence: { exclusive_ms: s.breakdown.latency.exclusive_ms, baseline_p95: s.breakdown.latency.baseline_p95 } });
  }
  return out.sort((x, y) => cmp(x.pattern + x.earliest_event_id, y.pattern + y.earliest_event_id));
}
