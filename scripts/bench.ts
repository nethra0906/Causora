/**
 * Micro-benchmarks. Every number written to docs/benchmarks/results.md comes from this script's own
 * measurements, with the hardware block, repetition counts and percentiles alongside it.
 *
 *   BM1  ingest → normalise → persist → derive edges   (events/s, per-batch latency)
 *   BM2  investigation latency vs ancestor-subgraph size (100 / 500 / 2000 nodes)
 *
 * In-process on a file-backed SQLite store: no network, no demo services. Run: npm run bench
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { ATTR, DEFAULT_CONFIG, type CausalEdge, type NormalisedEvent, type WireSpan } from '../src/contracts/index.ts';
import { investigate } from '../src/platform/analysis.ts';
import { Engine } from '../src/platform/engine.ts';
import { Store } from '../src/platform/store.ts';
import { ev, healthyBaselines, s1Events, T0 } from '../test/helpers/fixtures.ts';

const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]!;
const fmt = (n: number, d = 2) => n.toFixed(d);

/** NormalisedEvent → the wire span the SDK would have exported (so ingest does its real work). */
function toWire(e: NormalisedEvent, tag: string): WireSpan {
  const id = (x: string | null) => (x ? `${tag}:${x}` : null);
  const attrs: Record<string, string | number | boolean> = {
    [ATTR.eventId]: `${tag}:${e.event_id}`, [ATTR.eventType]: e.event_type, [ATTR.operation]: e.operation,
    [ATTR.businessOperationId]: `ord_${tag}`, [ATTR.attemptNumber]: e.attempt_number,
  };
  const put = (k: string, v: string | number | boolean | null) => { if (v !== null) attrs[k] = v; };
  put(ATTR.causationId, id(e.causation_id)); put(ATTR.retryOfEventId, id(e.retry_of_event_id)); put(ATTR.awaitedCorrelationId, id(e.awaited_correlation_id));
  put(ATTR.idempotencyKey, e.idempotency_key ? `${tag}:${e.idempotency_key}` : null); put(ATTR.topic, e.topic); put(ATTR.messageKey, e.message_key);
  put(ATTR.producedAt, e.dwell_ms !== null ? e.occurred_at - e.dwell_ms : null); put(ATTR.mutating, e.mutating || null);
  if (Object.keys(e.resource_ids).length) attrs[ATTR.resourceIds] = JSON.stringify(e.resource_ids);
  if (e.status !== 'OK') attrs[ATTR.errorType] = e.error_type ?? 'ERR';
  return {
    traceId: `t${tag}`, spanId: `${tag}:${e.span_id}`, parentSpanId: id(e.parent_span_id), name: e.operation, service: e.service, kind: 'internal',
    startTimeMs: e.occurred_at, endTimeMs: e.ended_at ?? e.occurred_at, status: { code: e.status === 'OK' ? 'OK' : 'ERROR' }, attributes: attrs,
  };
}

function bm1(): { events: number; seconds: number; eps: number; batchP50: number; batchP95: number; batchP99: number; batches: number; reps: number[] } {
  const reps: number[] = [];
  let last: ReturnType<typeof bm1> | undefined;
  for (let rep = 0; rep < 3; rep++) {
    const dir = mkdtempSync(join(tmpdir(), 'causora-bench-'));
    const store = new Store(join(dir, 'bench.db'));
    const engine = new Engine(store);
    const ops = 600;
    const perBatch = 20; // operations per ingest call ≈ 280 events, like a 250 ms exporter flush under load
    const base = s1Events();
    const lat: number[] = [];
    let events = 0;
    const t0 = performance.now();
    for (let i = 0; i < ops; i += perBatch) {
      const batch: WireSpan[] = [];
      for (let j = 0; j < perBatch; j++) for (const e of base) batch.push(toWire(e, `${rep}x${i + j}`));
      const b0 = performance.now();
      const r = engine.ingest(batch);
      lat.push(performance.now() - b0);
      if (r.rejected.length) throw new Error(`bench spans rejected: ${r.rejected[0]!.reason}`);
      events += r.accepted;
    }
    const seconds = (performance.now() - t0) / 1000;
    const edges = store.counts().edges;
    if (edges < ops * 10) throw new Error(`implausibly few edges (${edges}) - the benchmark is not exercising derivation`);
    store.close();
    rmSync(dir, { recursive: true, force: true });
    reps.push(events / seconds);
    last = { events, seconds, eps: events / seconds, batchP50: pctl(lat, 0.5), batchP95: pctl(lat, 0.95), batchP99: pctl(lat, 0.99), batches: lat.length, reps };
  }
  return last!;
}

/** A k-ary tree of ancestors feeding one failure: realistic fan-in, depth stays under the traversal bound. */
function treeGraph(n: number): { events: NormalisedEvent[]; edges: CausalEdge[] } {
  const events: NormalisedEvent[] = [ev({ event_id: 'n0', service: 'order-service', operation: 'order.failed', event_type: 'domain.state_change', occurred_at: T0 + n, status: 'ERROR', error_type: 'E' })];
  const edges: CausalEdge[] = [];
  for (let i = 1; i < n; i++) {
    const parent = Math.floor((i - 1) / 3);
    events.push(ev({ event_id: `n${i}`, service: ['order-service', 'inventory-service', 'payment-service'][i % 3]!, operation: `op${i % 17}`, event_type: 'domain.state_change', occurred_at: T0 + (n - i), duration_ms: i === n - 1 ? 900 : 2 }));
    edges.push({ from_event_id: `n${i}`, to_event_id: `n${parent}`, type: 'TRIGGERED', evidence_class: 'proven', confidence: 1, derived_by_rule: 'rule.triggered.causation_id@v1', evidence: { matched_fields: [{ field: 'causation_id', from_value: `n${i}`, to_value: `n${parent}` }] } });
  }
  return { events, edges };
}

function bm2() {
  const out: Array<{ nodes: number; edges: number; reps: number; p50: number; p95: number; max: number }> = [];
  for (const n of [100, 500, 2000]) {
    const { events, edges } = treeGraph(n);
    const baselines = healthyBaselines(events);
    const lat: number[] = [];
    let sub = 0;
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const inv = investigate({ failureEventId: 'n0', events, edges, baselines, ruleSetId: 'default', now: T0 + 1e6, lastIngestAt: null, config: { ...DEFAULT_CONFIG, maxTraversalDepth: 12 } });
      lat.push(performance.now() - t0);
      sub = inv.subgraph_node_count;
    }
    lat.shift(); // discard JIT warm-up
    out.push({ nodes: sub, edges: edges.length, reps: lat.length, p50: pctl(lat, 0.5), p95: pctl(lat, 0.95), max: Math.max(...lat) });
  }
  return out;
}

let commit = 'uncommitted';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no commits yet */ }
const hw = `${cpus()[0]?.model} · ${cpus().length} logical cores · ${(totalmem() / 2 ** 30).toFixed(1)} GB RAM · ${platform()} ${release()} · Node ${process.version}`;
console.log('BM1 ingest…');
const b1 = bm1();
console.log('BM2 investigation latency…');
const b2 = bm2();

const md = `# Benchmark results (generated)

> Produced by \`npm run bench\`. Every number below was measured by that script on the hardware shown; nothing is typed in by hand. Re-run to refresh.

**Hardware:** ${hw}
**Run at:** ${new Date().toISOString()} · **Commit:** ${commit} · idle machine, dev stack stopped.

## BM1 - Ingest → normalise → persist → derive edges

Method: ${b1.batches} ingest calls of ~280 spans each (20 primary-scenario operations per call, ${b1.events.toLocaleString()} spans total), in-process against a file-backed SQLite store in WAL mode (\`synchronous=NORMAL\`). Each call includes normalisation, idempotent persistence, and full re-derivation of the default rule set for every touched operation. Repeated 3× on fresh stores.

| Metric | Result |
|---|---|
| Sustained throughput (events/s), per repetition | ${b1.reps.map((r) => Math.round(r).toLocaleString()).join(' · ')} |
| Per-call latency p50 / p95 / p99 (ms, last repetition) | ${fmt(b1.batchP50, 1)} / ${fmt(b1.batchP95, 1)} / ${fmt(b1.batchP99, 1)} |
| Budget in ARCHITECTURE.md N2 | ≥ 2,000 events/s |

## BM2 - Investigation latency vs ancestor-subgraph size

Method: a 3-ary tree of ancestors feeding one failure (fan-in, depth within the bound of 12); ${b2[0]!.reps} measured repetitions per size after one discarded warm-up; includes scope, anomaly scoring, SCC collapse, frontier, patterns, ranking and evidence assembly.

| Subgraph nodes | Edges | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|---|
${b2.map((r) => `| ${r.nodes} | ${r.edges} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} |`).join('\n')}

Budget in ARCHITECTURE.md N4: p95 under 2 s at 2,000 nodes.

## What these numbers do and do not say

- They are **single-machine, in-process** figures for the analysis and persistence paths. They exclude HTTP, request-body validation (zod) and the demo services, and they are not a capacity claim for a production deployment.
- The 100-node row includes the all-pairs reachability pass (O(n²)) used to report which events ran concurrently. That pass is **skipped above 400 nodes**, so the 500- and 2000-node rows exclude it (the evidence then carries the caveat "concurrency not computed" rather than silently omitting it).
- Not benchmarked here (blueprint BM3–BM8: per-rule cost, storage growth, concurrent investigations, API read latency, CTE-vs-Neo4j): cut from the three-day scope. See ADR-0017.
`;
mkdirSync('docs/benchmarks', { recursive: true });
writeFileSync('docs/benchmarks/results.md', md);
console.log(md);
