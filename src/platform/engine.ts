/**
 * Orchestration: ingest → normalise → persist → derive edges → detect failures → investigate.
 * All decisions live in the pure modules (normalise, rules, analysis); this file only wires them
 * to the store and the clock.
 */
import { DEFAULT_RULE_SET_ID, getRuleSet, type AnalysisConfig, type Baseline, type CausalEdge, type Investigation, type NormalisedEvent, type WireSpan } from '../contracts/index.ts';
import { wallMs } from '../lib/time.ts';
import { computeBaselines, investigate } from './analysis.ts';
import { normaliseSpan } from './normalise.ts';
import { applyMask, deriveEdges } from './rules.ts';
import type { Store } from './store.ts';

/** How long after the last telemetry for an operation we run the automatic investigation. */
const AUTO_INVESTIGATE_AFTER_MS = 1800;

export class Engine {
  readonly store: Store;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(store: Store) {
    this.store = store;
  }

  // ───────────────────────── ingest ─────────────────────────
  ingest(spans: WireSpan[]): { accepted: number; duplicates: number; rejected: Array<{ spanId: string; reason: string }> } {
    const now = wallMs();
    const events: NormalisedEvent[] = [];
    const rejected: Array<{ spanId: string; reason: string }> = [];
    for (const s of spans) {
      const r = normaliseSpan(s, now);
      if (r.ok) events.push(r.event);
      else rejected.push({ spanId: s.spanId, reason: r.reason }); // counted, never silently dropped
    }
    const fresh = new Set(this.store.insertEvents(events));

    const ops = new Set<string>();
    const experiments = new Set<string>();
    for (const e of events) {
      if (!fresh.has(e.event_id)) continue;
      if (e.business_operation_id) ops.add(e.business_operation_id);
      if (e.source === 'fault' && e.experiment_id) experiments.add(e.experiment_id);
    }
    for (const exp of experiments) {
      const rows = this.store.db.prepare('SELECT DISTINCT business_operation_id AS id FROM events WHERE experiment_id = ? AND business_operation_id IS NOT NULL').all(exp) as Array<{ id: string }>;
      for (const r of rows) ops.add(r.id);
    }
    for (const op of ops) {
      this.store.touchOperation(op, now);
      this.rederive(op);
    }
    return { accepted: fresh.size, duplicates: events.length - fresh.size, rejected };
  }

  /** Re-derive the default edge set for one operation and detect failures. Idempotent. */
  rederive(opId: string): void {
    const events = this.store.loadOperationEvents(opId);
    this.store.persistEdges(opId, deriveEdges(events, getRuleSet(DEFAULT_RULE_SET_ID)));
    for (const e of events) {
      if (e.operation === 'order.failed' && e.status === 'ERROR' && e.source === 'span') {
        this.store.recordFailure({ eventId: e.event_id, opId, reason: e.error_type, occurredAt: e.occurred_at, now: wallMs() });
      }
    }
    const failure = this.store.failureForOperation(opId);
    if (failure) this.scheduleAutoInvestigation(failure.failure_event_id);
  }

  private scheduleAutoInvestigation(failureEventId: string): void {
    clearTimeout(this.timers.get(failureEventId));
    const t = setTimeout(() => {
      this.timers.delete(failureEventId);
      try { this.investigateNow(failureEventId); } catch { /* the failure may have been purged */ }
    }, AUTO_INVESTIGATE_AFTER_MS);
    t.unref();
    this.timers.set(failureEventId, t);
  }

  // ───────────────────────── investigation ─────────────────────────
  /**
   * Investigate under any rule set. Only the default result is cached (immutable per run).
   * `config` exists for the heuristic ablation; an investigation under a non-default config is never cached.
   */
  investigateNow(failureEventId: string, ruleSetId: string = DEFAULT_RULE_SET_ID, now: number = wallMs(), config?: AnalysisConfig): Investigation {
    clearTimeout(this.timers.get(failureEventId));
    this.timers.delete(failureEventId);
    const f = this.store.failureById(failureEventId);
    if (!f) throw new Error(`unknown failure ${failureEventId}`);
    const events = this.store.loadOperationEvents(f.business_operation_id);
    const rs = getRuleSet(ruleSetId);
    const inv = investigate({
      failureEventId,
      businessOperationId: f.business_operation_id,
      events: applyMask(events, rs.masked),
      edges: deriveEdges(events, rs),
      // A naive (no-self-time) analyser would have baselined raw durations too; do the same for a fair ablation.
      baselines: config && !config.selfTimeLatency ? computeBaselines(this.store.allEvents({ kind: 'baseline' }), false) : this.store.baselines(),
      ruleSetId,
      config,
      now,
      lastIngestAt: this.store.lastIngestAt(f.business_operation_id),
    });
    if (ruleSetId === DEFAULT_RULE_SET_ID && !config) this.store.saveInvestigation(inv);
    return inv;
  }

  /** Graph for display: nodes + edges under a rule set. Ground-truth fields are withheld unless `reveal`. */
  graph(opId: string, ruleSetId: string, reveal: boolean): { nodes: unknown[]; edges: CausalEdge[]; rule_set_id: string } {
    const events = this.store.loadOperationEvents(opId);
    const rs = getRuleSet(ruleSetId);
    const edges = deriveEdges(events, rs).filter((e) => reveal || e.type !== 'FAULT_AFFECTED');
    const nodes = applyMask(events, rs.masked)
      .filter((e) => reveal || e.source !== 'fault')
      .map((e) => {
        if (reveal) return e;
        const { experiment_id: _x, is_fault_injected: _y, ...rest } = e; // withheld until the user asks for the answer
        return rest;
      });
    return { nodes, edges, rule_set_id: ruleSetId };
  }

  // ───────────────────────── baselines & completeness helpers ─────────────────────────
  recomputeBaselines(): Array<Baseline & { dwell_p95_ms: number | null }> {
    const rows = computeBaselines(this.store.allEvents({ kind: 'baseline' }));
    this.store.replaceBaselines(rows, wallMs());
    return rows;
  }

  /** True once the operation has produced its verdict event (confirmed or failed). */
  hasTerminalEvent(opId: string): boolean {
    return this.store.loadOperationEvents(opId).some((e) => e.source === 'span' && (e.operation === 'order.failed' || e.operation === 'order.confirmed'));
  }

  /** References that point at events not (yet) received. Zero means the operation's graph is closed. */
  dangling(opId: string): number {
    const events = this.store.loadOperationEvents(opId).filter((e) => e.source !== 'fault');
    const ids = new Set(events.map((e) => e.event_id));
    let n = 0;
    for (const e of events) for (const ref of [e.causation_id, e.retry_of_event_id, e.awaited_correlation_id]) if (ref && !ids.has(ref)) n++;
    return n;
  }
}
