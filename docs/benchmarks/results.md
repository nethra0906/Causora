# Benchmark results (generated)

> Produced by `npm run bench`. Every number below was measured by that script on the hardware shown; nothing is typed in by hand. Re-run to refresh.

**Hardware:** Intel(R) Core(TM) Ultra 5 225H · 14 logical cores · 15.4 GB RAM · win32 10.0.26300 · Node v24.17.0
**Run at:** 2026-10-12T07:15:41.661Z · **Commit:** uncommitted · idle machine, dev stack stopped.

## BM1 — Ingest → normalise → persist → derive edges

Method: 30 ingest calls of ~280 spans each (20 primary-scenario operations per call, 8,400 spans total), in-process against a file-backed SQLite store in WAL mode (`synchronous=NORMAL`). Each call includes normalisation, idempotent persistence, and full re-derivation of the default rule set for every touched operation. Repeated 3× on fresh stores.

| Metric | Result |
|---|---|
| Sustained throughput (events/s), per repetition | 16,677 · 18,565 · 20,585 |
| Per-call latency p50 / p95 / p99 (ms, last repetition) | 11.1 / 22.2 / 23.6 |
| Budget in ARCHITECTURE.md N2 | ≥ 2,000 events/s |

## BM2 — Investigation latency vs ancestor-subgraph size

Method: a 3-ary tree of ancestors feeding one failure (fan-in, depth within the bound of 12); 24 measured repetitions per size after one discarded warm-up; includes scope, anomaly scoring, SCC collapse, frontier, patterns, ranking and evidence assembly.

| Subgraph nodes | Edges | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|---|
| 100 | 99 | 0.45 | 0.83 | 0.84 |
| 500 | 499 | 1.66 | 2.15 | 2.64 |
| 2000 | 1999 | 7.33 | 12.67 | 13.70 |

Budget in ARCHITECTURE.md N4: p95 under 2 s at 2,000 nodes.

## What these numbers do and do not say

- They are **single-machine, in-process** figures for the analysis and persistence paths. They exclude HTTP, request-body validation (zod) and the demo services, and they are not a capacity claim for a production deployment.
- The 100-node row includes the all-pairs reachability pass (O(n²)) used to report which events ran concurrently. That pass is **skipped above 400 nodes**, so the 500- and 2000-node rows exclude it (the evidence then carries the caveat "concurrency not computed" rather than silently omitting it).
- Not benchmarked here (blueprint BM3–BM8: per-rule cost, storage growth, concurrent investigations, API read latency, CTE-vs-Neo4j): cut from the three-day scope. See ADR-0017.
