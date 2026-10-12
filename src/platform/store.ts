import type { Baseline, CausalEdge, EvidenceClass, EdgeType, Investigation, NormalisedEvent } from '../contracts/index.ts';
import { type Db, bind, openDb, tx } from '../lib/db.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY, business_operation_id TEXT, experiment_id TEXT, span_id TEXT, service TEXT NOT NULL, operation TEXT NOT NULL,
  event_type TEXT NOT NULL, source TEXT NOT NULL, occurred_at REAL NOT NULL, ingested_at REAL NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_op ON events(business_operation_id);
CREATE INDEX IF NOT EXISTS events_exp ON events(experiment_id, source);
CREATE INDEX IF NOT EXISTS events_type ON events(event_type, operation);

CREATE TABLE IF NOT EXISTS edges(
  from_event_id TEXT NOT NULL, to_event_id TEXT NOT NULL, type TEXT NOT NULL, evidence_class TEXT NOT NULL, confidence REAL NOT NULL,
  derived_by_rule TEXT NOT NULL, evidence TEXT NOT NULL, business_operation_id TEXT,
  PRIMARY KEY(from_event_id, to_event_id, type));
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_event_id);
CREATE INDEX IF NOT EXISTS edges_op ON edges(business_operation_id);

CREATE TABLE IF NOT EXISTS business_operations(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'live', first_seen REAL NOT NULL, last_ingest_at REAL NOT NULL);

CREATE TABLE IF NOT EXISTS failures(
  failure_event_id TEXT PRIMARY KEY, business_operation_id TEXT NOT NULL, reason TEXT, detected_at REAL NOT NULL, occurred_at REAL NOT NULL);

CREATE TABLE IF NOT EXISTS investigations(
  failure_event_id TEXT NOT NULL, rule_set_id TEXT NOT NULL, doc TEXT NOT NULL, created_at REAL NOT NULL,
  PRIMARY KEY(failure_event_id, rule_set_id));

CREATE TABLE IF NOT EXISTS baselines(
  service TEXT NOT NULL, operation TEXT NOT NULL, sample_count INTEGER NOT NULL, p50_ms REAL NOT NULL, p95_ms REAL NOT NULL,
  error_rate REAL NOT NULL, dwell_p95_ms REAL, computed_at REAL NOT NULL, PRIMARY KEY(service, operation));

CREATE TABLE IF NOT EXISTS experiment_runs(
  id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, scenario_id TEXT NOT NULL, business_operation_id TEXT NOT NULL UNIQUE,
  truth_service TEXT, truth_operation TEXT, expect_failure INTEGER NOT NULL, started_at REAL NOT NULL,
  order_status TEXT, order_reason TEXT);

CREATE TABLE IF NOT EXISTS evaluation_runs(
  id TEXT PRIMARY KEY, started_at REAL NOT NULL, finished_at REAL, status TEXT NOT NULL, doc TEXT);
`;

export class Store {
  readonly db: Db;

  constructor(file: string) {
    this.db = openDb(file);
    this.db.exec(SCHEMA);
  }

  // ─────────── events ───────────
  /** Idempotent on event_id. Returns the ids that were actually new. */
  insertEvents(events: NormalisedEvent[]): string[] {
    const fresh: string[] = [];
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO events(event_id,business_operation_id,experiment_id,span_id,service,operation,event_type,source,occurred_at,ingested_at,doc)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    tx(this.db, () => {
      for (const e of events) {
        const r = ins.run(e.event_id, e.business_operation_id, e.experiment_id, e.span_id, e.service, e.operation, e.event_type, e.source, e.occurred_at, e.ingested_at, JSON.stringify(e));
        if (r.changes > 0) fresh.push(e.event_id);
      }
    });
    return fresh;
  }

  touchOperation(id: string, now: number): void {
    this.db.prepare(
      `INSERT INTO business_operations(id,kind,first_seen,last_ingest_at) VALUES(?, 'live', ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_ingest_at = excluded.last_ingest_at`,
    ).run(id, now, now);
  }

  setOperationKind(id: string, kind: 'live' | 'baseline' | 'experiment', now: number): void {
    this.db.prepare(
      `INSERT INTO business_operations(id,kind,first_seen,last_ingest_at) VALUES(?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind`,
    ).run(id, kind, now, now);
  }

  lastIngestAt(opId: string): number | null {
    const r = this.db.prepare('SELECT last_ingest_at FROM business_operations WHERE id = ?').get(opId) as { last_ingest_at: number } | undefined;
    return r?.last_ingest_at ?? null;
  }

  /** Events of one operation plus the fault-injector events of every experiment that touched it. */
  loadOperationEvents(opId: string): NormalisedEvent[] {
    const rows = this.db.prepare(
      `SELECT doc FROM events WHERE business_operation_id = ?
       UNION
       SELECT doc FROM events WHERE source = 'fault' AND experiment_id IN
         (SELECT DISTINCT experiment_id FROM events WHERE business_operation_id = ? AND experiment_id IS NOT NULL)`,
    ).all(opId, opId) as Array<{ doc: string }>;
    return rows.map((r) => JSON.parse(r.doc) as NormalisedEvent);
  }

  allEvents(filter?: { kind?: string }): NormalisedEvent[] {
    const rows = filter?.kind
      ? this.db.prepare(`SELECT e.doc FROM events e JOIN business_operations o ON o.id = e.business_operation_id WHERE o.kind = ?`).all(filter.kind)
      : this.db.prepare('SELECT doc FROM events').all();
    return (rows as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as NormalisedEvent);
  }

  // ─────────── edges ───────────
  persistEdges(opId: string, edges: CausalEdge[]): void {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO edges(from_event_id,to_event_id,type,evidence_class,confidence,derived_by_rule,evidence,business_operation_id) VALUES(?,?,?,?,?,?,?,?)`,
    );
    tx(this.db, () => {
      for (const e of edges) ins.run(e.from_event_id, e.to_event_id, e.type, e.evidence_class, e.confidence, e.derived_by_rule, JSON.stringify(e.evidence), opId);
    });
  }

  edgesForOperation(opId: string): CausalEdge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE business_operation_id = ? ORDER BY from_event_id, to_event_id, type').all(opId) as any[];
    return rows.map((r) => ({
      from_event_id: r.from_event_id, to_event_id: r.to_event_id, type: r.type as EdgeType, evidence_class: r.evidence_class as EvidenceClass,
      confidence: r.confidence, derived_by_rule: r.derived_by_rule, evidence: JSON.parse(r.evidence),
    }));
  }

  // ─────────── failures & investigations ───────────
  recordFailure(f: { eventId: string; opId: string; reason: string | null; occurredAt: number; now: number }): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO failures(failure_event_id,business_operation_id,reason,detected_at,occurred_at) VALUES(?,?,?,?,?)').run(f.eventId, f.opId, f.reason, f.now, f.occurredAt);
    return r.changes > 0;
  }

  failureForOperation(opId: string): { failure_event_id: string; reason: string | null } | undefined {
    return this.db.prepare('SELECT failure_event_id, reason FROM failures WHERE business_operation_id = ?').get(opId) as any;
  }

  failureById(id: string): { failure_event_id: string; business_operation_id: string; reason: string | null } | undefined {
    return this.db.prepare('SELECT * FROM failures WHERE failure_event_id = ?').get(id) as any;
  }

  listFailures(limit = 50): Array<{ failure_event_id: string; business_operation_id: string; reason: string | null; detected_at: number; occurred_at: number; kind: string; top: Investigation | null }> {
    const rows = this.db.prepare(
      `SELECT f.*, COALESCE(o.kind,'live') AS kind, i.doc AS inv FROM failures f
       LEFT JOIN business_operations o ON o.id = f.business_operation_id
       LEFT JOIN investigations i ON i.failure_event_id = f.failure_event_id AND i.rule_set_id = 'default'
       ORDER BY f.occurred_at DESC LIMIT ?`,
    ).all(limit) as any[];
    return rows.map((r) => ({ failure_event_id: r.failure_event_id, business_operation_id: r.business_operation_id, reason: r.reason, detected_at: r.detected_at, occurred_at: r.occurred_at, kind: r.kind, top: r.inv ? JSON.parse(r.inv) : null }));
  }

  saveInvestigation(inv: Investigation): void {
    this.db.prepare('INSERT OR REPLACE INTO investigations(failure_event_id,rule_set_id,doc,created_at) VALUES(?,?,?,?)').run(inv.failure_event_id, inv.rule_set_id, JSON.stringify(inv), inv.created_at);
  }

  getInvestigation(failureEventId: string, ruleSetId: string): Investigation | undefined {
    const r = this.db.prepare('SELECT doc FROM investigations WHERE failure_event_id = ? AND rule_set_id = ?').get(failureEventId, ruleSetId) as { doc: string } | undefined;
    return r ? (JSON.parse(r.doc) as Investigation) : undefined;
  }

  // ─────────── baselines ───────────
  replaceBaselines(rows: Array<Baseline & { dwell_p95_ms: number | null }>, now: number): void {
    const ins = this.db.prepare('INSERT OR REPLACE INTO baselines(service,operation,sample_count,p50_ms,p95_ms,error_rate,dwell_p95_ms,computed_at) VALUES(?,?,?,?,?,?,?,?)');
    tx(this.db, () => {
      this.db.exec('DELETE FROM baselines');
      for (const b of rows) ins.run(b.service, b.operation, b.sample_count, b.p50_ms, b.p95_ms, b.error_rate, bind(b.dwell_p95_ms), now);
    });
  }

  baselines(): Array<Baseline & { dwell_p95_ms: number | null }> {
    return this.db.prepare('SELECT service,operation,sample_count,p50_ms,p95_ms,error_rate,dwell_p95_ms FROM baselines ORDER BY service, operation').all() as any;
  }

  // ─────────── experiments ───────────
  recordExperimentRun(r: { id: string; experimentId: string; scenarioId: string; opId: string; truthService: string | null; truthOperation: string | null; expectFailure: boolean; startedAt: number }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO experiment_runs(id,experiment_id,scenario_id,business_operation_id,truth_service,truth_operation,expect_failure,started_at) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(r.id, r.experimentId, r.scenarioId, r.opId, bind(r.truthService), bind(r.truthOperation), r.expectFailure ? 1 : 0, r.startedAt);
  }

  setExperimentOutcome(opId: string, status: string | null, reason: string | null): void {
    this.db.prepare('UPDATE experiment_runs SET order_status = ?, order_reason = ? WHERE business_operation_id = ?').run(bind(status), bind(reason), opId);
  }

  listExperimentRuns(limit = 50): any[] {
    return this.db.prepare('SELECT * FROM experiment_runs ORDER BY started_at DESC LIMIT ?').all(limit) as any[];
  }

  experimentRunByOp(opId: string): any | undefined {
    return this.db.prepare('SELECT * FROM experiment_runs WHERE business_operation_id = ?').get(opId);
  }

  // ─────────── evaluation ───────────
  saveEvaluation(id: string, startedAt: number, finishedAt: number | null, status: string, doc: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO evaluation_runs(id,started_at,finished_at,status,doc) VALUES(?,?,?,?,?)').run(id, startedAt, bind(finishedAt), status, JSON.stringify(doc));
  }

  latestEvaluation(): { id: string; started_at: number; finished_at: number | null; status: string; doc: any } | undefined {
    const r = this.db.prepare('SELECT * FROM evaluation_runs ORDER BY started_at DESC LIMIT 1').get() as any;
    return r ? { ...r, doc: r.doc ? JSON.parse(r.doc) : null } : undefined;
  }

  counts(): { events: number; edges: number; failures: number; baselineOps: number } {
    const c = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      events: c('SELECT COUNT(*) n FROM events'),
      edges: c('SELECT COUNT(*) n FROM edges'),
      failures: c('SELECT COUNT(*) n FROM failures'),
      baselineOps: c("SELECT COUNT(*) n FROM business_operations WHERE kind = 'baseline'"),
    };
  }

  close(): void {
    this.db.close();
  }
}
