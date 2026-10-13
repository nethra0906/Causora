# Scalability Analysis

> **Build status - blueprint document.** Unchanged: nothing in this document is implemented. The bus is a single-node SQLite table, not a partitioned log.

**Nothing in this document is implemented at MVP.** Its purpose is to establish that the
architecture has a credible growth path and that the limits are known rather than discovered
in front of an audience.

The honest framing: Causora runs on one laptop. These are **analysed bottlenecks with
designed remedies**, and the benchmarking milestone measures where the real limits sit.

---

## 1. Growth dimensions

| Dimension | MVP | First limit | Breaks at |
|---|---|---|---|
| Services | 3 | ~20 | edge-rule lookup fan-out |
| Events/s | ~50 | ~2,000 (budget) | single worker event loop |
| Events stored | ~10⁵ | ~10⁸ | unpartitioned `events` table |
| Events per business operation | 18–34 (7,000 in retry storm) | ~5,000 | subgraph bound, UI rendering |
| Concurrent investigations | 1–2 | ~4 | analysis concurrency, pool size |
| Failures/min | <1 | ~100 | investigation job queue depth |

---

## 2. Bottleneck analysis

### B1 - Single worker event loop · **the first real limit**

One Node process does normalisation, correlation, edge derivation and analysis. Normalisation
is CPU-bound JSON/protobuf work; traversal is CPU-bound graph work.

*Symptoms:* ingest lag grows; Kafka heartbeat misses cause consumer-group rebalances
mid-investigation (a bug that presents as a Kafka problem and is actually an event loop
problem).

*Mitigations, in order:*

1. `setImmediate` yielding in long loops - **implemented at MVP**, because without it the
   retry-storm scenario triggers rebalances.
2. Move analysis to `worker_threads`.
3. Split the analysis consumer into its own process (the code is already a separate consumer
   group, so this is a deployment change, not a rewrite).
4. Scale the pipeline consumer horizontally. **Safe because the Kafka message key is
   `business_operation_id`**, so all events for one saga land on one partition and one
   consumer - correlation and re-derivation stay single-writer per saga without any
   distributed coordination.

Point 4 is the payoff of a partitioning decision made on day one for a different reason. Worth
noting: it is the single most important scalability property of the design, and it was free.

### B2 - `events` table growth

At 2,000 events/s a day is ~170M rows. Indexes alone exceed the useful working set.

*Mitigations:* monthly RANGE partitioning on `occurred_at` (sketched in
[ADR-0011](../DECISIONS.md#adr-0011)); drop old partitions rather than
`DELETE`; then move `events` to ClickHouse keeping Postgres for investigations and metadata
([ADR-0003](../DECISIONS.md#adr-0003) names this as the intended evolution).

### B3 - Correlation index write amplification

3–8 rows per event, so 2,000 events/s is up to 16,000 index rows/s.

*Mitigations:* batch inserts via `COPY` instead of multi-row `INSERT`; drop `key_type`s no rule
consumes (measured, not guessed); eventually a Redis hash index for the hot keys with Postgres
as the durable record - only if measurement justifies it.

### B4 - Recursive CTE traversal

Depth 12 over a 5,000-node subgraph with a 7,000-event business operation. Postgres recursive
CTEs do not stream; the whole working set materialises.

*Mitigations:* `MAX_SUBGRAPH_NODES` bound (MVP); `MIN_PATH_CONFIDENCE` pruning (MVP);
materialised `investigation_subgraphs` cache keyed on `(failure_event_id, rule_set_id)`;
then an in-memory graph for a hot business operation; then the Neo4j/Cypher comparison, which
is a **benchmark** and not an assumption.

### B5 - UI rendering

React Flow degrades visibly above ~1,000 nodes.

*Mitigations:* `MAX_UI_NODES` 800 with clusters collapsed by default (MVP); progressive
expansion on demand; canvas rendering instead of SVG if needed. The retry-storm scenario is
the test case and must be run against the browser, not only the API.

### B6 - Kafka / Redpanda

Not a bottleneck at this scale, and saying so is more useful than inventing a concern. The
`causora.ingest` topic needs partitions ≥ the target worker count, keyed by
`business_operation_id` for the single-writer property in B1.

### B7 - Baseline recomputation

A full recompute every 60 s over the trailing window is O(events in window).

*Mitigation:* incremental percentile sketches (t-digest) updated per event instead of
recomputing. Mentioned because exact percentiles do not scale and approximate ones do - a
reasonable thing to be able to discuss.

---

## 3. Latency budget

| Stage | Budget | Dominated by |
|---|---|---|
| Service → Collector | ~2 s | collector batch timeout (configurable) |
| Collector → ingest 202 | < 20 ms | body parse + raw insert + produce |
| Kafka queue | < 50 ms | consumer poll interval |
| Normalise | < 5 ms/envelope | JSON/protobuf decode |
| Correlate + persist | < 20 ms/envelope | round trips (batched) |
| Derive edges | < 50 ms/event p95 | ~9 indexed lookups |
| Re-derivation sweep | < 500 ms | timer interval |
| **Failure visible in UI** | **< 5 s** | dominated by the collector batch |
| Investigation | < 2 s p95 at 2,000 nodes | CTE + scoring |

The collector batch timeout dominates end-to-end latency. Lowering it to 200 ms makes the demo
feel instant at the cost of more, smaller requests - a knob worth exposing and worth
mentioning, because "it takes 2 seconds to appear" has a one-line explanation.

---

## 4. Failure modes of Causora itself

Causora is a distributed system and must not be exempt from its own analysis.

| Failure | Effect | Design response |
|---|---|---|
| Postgres down | ingest 503s, Collector retries with backoff | collector `retry_on_failure` buffers; no data loss for the buffer window |
| Redpanda down | ingest 503s | same |
| Worker down | ingest continues, `raw_telemetry` accumulates `pending` | on restart, replay drains the backlog; **this is why raw storage is separate from processing** |
| Worker crash mid-batch | offsets uncommitted, batch redelivered | idempotent writes make reprocessing harmless |
| Duplicate telemetry delivery | none | `ON CONFLICT DO NOTHING` on events and edges |
| Analysis job crash | investigation stuck `RUNNING` | job timeout marks it `FAILED` with the stage name; UI offers retry |
| Clock skew on a service | dwell estimates unreliable | proven edges unaffected by design; caveat surfaced; scenario S6 proves it |
| Telemetry gap (service not instrumented) | incomplete graph | `missing_hops` reported, completeness `DEGRADED`, dashed gap node in the UI |

The row that matters most: **a worker outage degrades freshness, not correctness**, because
raw telemetry is durable and processing is idempotent and replayable. That separation is the
central reliability property of the platform.

---

## 5. What is deliberately not built

| Not built | Why |
|---|---|
| Horizontal worker scaling | one worker handles the design budget; the partitioning key makes it a later config change |
| Partitioning | unnecessary at 10⁵ rows; adds migration complexity now |
| ClickHouse | correct at scale, large complexity cost, nothing to demonstrate at MVP volumes |
| Graph database | recursive CTE is faster at this size; the comparison is a benchmark |
| Redis caching | no measured cache need; adding it without measurement is resume padding |
| Kubernetes | adds operational surface, zero architectural insight here |
| Autoscaling | nothing to autoscale |

Premature implementation of any of these would make the project larger and worse. The
discipline of not building them is part of the design.

---

## 6. If this became a product

A plausible evolution, for the "how would you productionise it?" conversation:

1. **Storage split.** Events to ClickHouse (columnar, TTL, cheap scans); Postgres keeps
   investigations, experiments and baselines.
2. **Stream processing.** Edge derivation as a Flink or Kafka Streams job keyed by
   `business_operation_id` - the same single-writer property, with managed state and exactly-once
   sinks.
3. **Multi-tenancy.** Tenant id on every row, row-level security, per-tenant rate limits, and
   the hard part: telemetry crosses team boundaries, so authorisation on traces is genuinely
   harder than on application data.
4. **Sampling with causal awareness.** The real research problem. Head sampling destroys causal
   chains. Tail sampling that retains any trace in a business operation containing an error
   preserves them - at the cost of buffering until the operation completes. Quantifying that
   trade-off is the research direction in `docs/experiments/research.md`.
5. **Agent-side contract enforcement.** Ship the `packages/kafka` wrappers as an SDK so the
   contract is impossible to violate, and report compliance per service as a product feature.
   Causora's `contract_violations` field is already the metric for it.

Item 5 is the strongest product insight in the whole design: the tool's value is bounded by
instrumentation quality, so **measuring and enforcing instrumentation quality is the product**,
not a prerequisite for it.
