# Benchmarking Plan

> **Build status — blueprint document.** Only **BM1** (ingest throughput) and **BM2** (investigation latency vs subgraph size) were run, in-process; results with hardware, repetitions and percentiles are in [results.md](results.md). BM3–BM8 (per-rule cost, storage growth, concurrency, API read latency, CTE-vs-Neo4j) were cut. The rule below still holds: no number appears here that a run did not produce.

> **No results appear in this document or anywhere in this repository until the
> implementation phase produces them.** Every number below is a placeholder marked `TBD`.
> Fabricated benchmarks are worse than no benchmarks: they are the one thing in a portfolio
> project that cannot be defended when questioned.

Results land in `bench/results/<date>-<commit>.json` plus a committed summary table, always
with the hardware and methodology attached.

---

## 1. Methodology

**Hardware disclosure.** Every result records CPU model and core count, total RAM, disk type,
OS and kernel/build, Docker version, Node version and the Postgres and Redpanda image tags.
A number without its hardware is meaningless.

**Protocol.**

| Rule | Value |
|---|---|
| Warm-up | 60 s discarded |
| Measurement window | 180 s |
| Repetitions | 5 independent runs (fresh containers each time) |
| Reported statistics | median, p95, p99, min, max, **and the inter-run spread** |
| Environment | `docker-compose.bench.yml`; no IDE, no browser, no other containers |
| Container limits | explicit CPU and memory limits so runs are comparable |
| Isolation | database reset between runs; the same seed dataset reloaded each time |

**Reporting the spread matters.** A laptop benchmark with thermal throttling and a background
OS has real variance. Reporting a single number implies a precision that does not exist;
reporting median plus spread across 5 runs is honest and still useful.

---

## 2. Datasets

| Dataset | Content | Purpose |
|---|---|---|
| `D1-baseline` | 200 healthy orders (~3,600 events) | populates baselines; the floor |
| `D2-mixed` | 1,000 orders, 10% failing via `delayed_inventory` | realistic steady state |
| `D3-storm` | 25 orders with `retry_storm` (~7,000 events in a few operations) | pathological subgraph size |
| `D4-synthetic-scale` | generated OTLP: 10k / 100k / 1M events, controlled fan-out | storage and traversal scaling without waiting for real traffic |
| `D5-ablation` | `D2-mixed` replayed through each rule set | ablation comparison on identical input |

`D5` reuses `D2`'s raw telemetry via the replay path. Comparing rule sets on *identical input
bytes* is what makes the ablation a controlled experiment rather than two different runs.

---

## 3. Benchmarks

### BM1 — Ingestion throughput

*Question:* how many normalised events per second can one worker sustain before lag grows
without bound?

*Method:* k6 posts pre-recorded OTLP batches at increasing rates. Lag measured as
`now - max(ingested_at)`. Sustained rate = the highest rate at which lag stays bounded over
180 s.

| Metric | Result |
|---|---|
| Sustained events/s | TBD |
| p50 / p95 / p99 ingest-request latency | TBD |
| Lag at the sustained rate | TBD |
| Worker CPU at the sustained rate | TBD |
| Breaking rate (lag grows unbounded) | TBD |

*Design budget: 2,000 events/s (N2). Expect to discover the real limit is elsewhere — most
likely correlation-index writes rather than normalisation CPU. Either outcome is a finding.*

### BM2 — Per-event pipeline latency

*Question:* where does time go between ingest and edges being queryable?

Instrumented per stage from Causora's self-telemetry:

| Stage | p50 | p95 | p99 |
|---|---|---|---|
| normalise | TBD | TBD | TBD |
| correlate + persist | TBD | TBD | TBD |
| derive edges | TBD | TBD | TBD |
| **ingest → edges queryable** | TBD | TBD | TBD |

### BM3 — Edge derivation cost per rule

*Question:* which rules are expensive, and is the expense justified?

Per-rule invocation count, total time, mean time, edges emitted. Run with each rule disabled
in turn to get its marginal cost.

*This drives real decisions: if `rule.proximity` costs 30% of derivation time to produce edges
that are excluded from analysis anyway, it should stay disabled by default — and the benchmark
will say so.*

### BM4 — Investigation latency vs subgraph size

**The headline chart.** Subgraph node count on the x-axis, latency on the y-axis, with stages
broken out.

| Nodes | CTE | Score | Frontier | Patterns | Rank+Evidence | Total p95 |
|---|---|---|---|---|---|---|
| 50 | TBD | TBD | TBD | TBD | TBD | TBD |
| 250 | | | | | | |
| 1,000 | | | | | | |
| 2,000 | | | | | | |
| 5,000 | | | | | | |

*Design budget: p95 under 2 s at 2,000 nodes (N4). The interesting question is the shape — if
total time grows superlinearly, the cause is almost certainly the CTE materialising, and that
finding is what would justify the subgraph cache or the graph-database comparison.*

### BM5 — Storage growth

| Metric | Result |
|---|---|
| Bytes/event: `events` heap | TBD |
| Bytes/event: `events` indexes | TBD |
| Bytes/event: `event_correlations` (heap + index) | TBD |
| Bytes/event: `edges` | TBD |
| Bytes/event: `raw_telemetry` (JSONB, pre-retention) | TBD |
| **Total bytes/event** | TBD |
| Projected GB/day at 1,000 events/s | TBD |

*Expected finding: `raw_telemetry` and `event_correlations` dominate, not `events`. If so,
that quantifies the cost of the replay capability and of the index-table design — both
deliberate trade-offs that deserve a measured price tag.*

### BM6 — Concurrent investigations

Investigations in parallel: 1, 2, 4, 8. Reported: p95 latency per level, worker CPU, pool
saturation, and — critically — **ingest lag during analysis**, which tests whether the
separate connection pools actually protect intake.

### BM7 — API read latency

p50/p95/p99 for `/overview`, `/operations/:id/events`, `/graph/operations/:id`,
`/investigations/:id` at `D2` and `D4-100k`. Design budget: p95 under 300 ms (N5).

### BM8 — Recursive CTE vs Neo4j · **post-MVP, optional**

*Question:* does a graph database actually beat Postgres for k-hop ancestor queries at this
scale?

Same graph loaded into both; identical traversals at depths 3, 6, 12 over subgraphs of 100,
1,000 and 5,000 nodes. Measured: query latency, memory, and the cost of keeping a second store
in sync.

*This is the honest way to justify [ADR-0003](../../DECISIONS.md#adr-0003). The
prediction is that Postgres wins at these sizes and the crossover is far beyond MVP scale — but
it is a prediction, and the benchmark either supports it or corrects it. If Neo4j wins, the ADR
gets a documented revision, which is a better outcome than a defended guess.*

---

## 4. Interpretation rules

1. **A benchmark that does not change a decision is not worth running.** Each one above has a
   stated decision attached.
2. **Report the limiting resource**, not just the number — CPU, disk, lock contention or pool
   saturation.
3. **Never extrapolate beyond the measured range.** A 1M-event result does not license a claim
   about 1B.
4. **Never compare across hardware.** Results from different machines are different experiments.
5. **Record negative results.** "Redis caching produced no measurable improvement, so it was
   not adopted" is a stronger statement than any positive number, and it is the kind of thing
   that distinguishes measurement from decoration.
6. **Publish the raw data**, not only the summary, so the numbers can be checked.
