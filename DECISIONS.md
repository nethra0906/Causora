# Architecture Decision Record

Every significant decision, its context, its rejected alternatives and its consequences.
This is the authoritative record; ADRs live here rather than in one-file-per-decision until
the set grows large enough to justify splitting.

**Status key:** `ACCEPTED` · `SUPERSEDED` · `REVISIT` (has a documented trigger for revision).

| ADR | Decision | Status |
|---|---|---|
| [0001](#adr-0001) | TypeScript end-to-end | ACCEPTED |
| [0002](#adr-0002) | Redpanda via the Kafka API | ACCEPTED |
| [0003](#adr-0003) | PostgreSQL only; no graph database | ACCEPTED · REVISIT |
| [0004](#adr-0004) | The normalised event is the graph node | ACCEPTED |
| [0005](#adr-0005) | Causal metadata as OTel span attributes, not a side channel | ACCEPTED |
| [0006](#adr-0006) | Declared evidence classes, not learned probabilities | ACCEPTED |
| [0007](#adr-0007) | OTel Collector in the pipeline | ACCEPTED |
| [0008](#adr-0008) | Modular platform: one API + one worker | ACCEPTED |
| [0009](#adr-0009) | A correlation index table | ACCEPTED |
| [0010](#adr-0010) | Incremental re-derivation for late arrivals | ACCEPTED · REVISIT |
| [0011](#adr-0011) | Table partitioning deferred | ACCEPTED · REVISIT |
| [0012](#adr-0012) | Docker Compose, not Kubernetes | ACCEPTED |
| [0013](#adr-0013) | Three demo services | ACCEPTED |
| [0014](#adr-0014) | Fault injector as evaluation ground truth | ACCEPTED |
| [0015](#adr-0015) | No sampling at MVP | ACCEPTED |
| [0016](#adr-0016) | The demo app ships a deliberate concurrency bug | ACCEPTED |

---

<a id="adr-0001"></a>
## ADR-0001: TypeScript end-to-end

**Context.** Backend language for three demo services and the Causora platform. Candidates:
Go, Java 21 + Spring Boot, TypeScript, a Java/Go hybrid. Constraints: 4–6 weeks part-time, the
author is already fluent in TypeScript, and the whole stack must run on one laptop.

**Decision.** TypeScript (Node 20) for demo services, platform and frontend. React + TypeScript
for the UI.

**Rejected alternatives.**

- **Go everywhere** — initially recommended: ~20 MB containers, explicit goroutine/`context`
  concurrency, a race detector. Rejected because learning it would consume ~20–25% of a 4–6
  week part-time budget, and that time is better spent on the causality engine, which is where
  the project's value is. Also, the code produced during the learning period would be
  unidiomatic — the worst outcome for something meant to be shown.
- **Java 21 + Spring Boot** — strongest option on one axis: the OTel auto-instrumentation agent
  produces realistic telemetry with no application code, which partly answers the "you
  instrumented exactly what your analyser needs" criticism. Rejected on footprint (4 JVMs plus
  Kafka, Postgres and the Collector approaches 8 GB), slow startup hurting the demo loop, and
  because Spring hides the distributed-systems mechanics the project exists to show.
- **Java services + Go platform** — the best technical story; rejected as two toolchains and
  ~30–40% more effort against a tight budget.

**Consequences.**

- Positive: one language across ten workspaces; `packages/contracts` gives end-to-end type
  safety across the **ingestion boundary**, which is the project's most important contract;
  fast iteration; small containers.
- Negative: Node's single event loop makes CPU-bound graph work a real constraint. Mitigated
  deliberately rather than hidden — it is the reason for the API/worker split
  ([0008](#adr-0008)) and for `setImmediate` yielding in traversal.
- Negative: no race detector. Mitigated by explicit barrier-based concurrency tests.
- Honest framing for interviews: *this project demonstrates distributed systems design; the
  language is incidental and Go is a week of syntax away.*

---

<a id="adr-0002"></a>
## ADR-0002: Redpanda via the Kafka API

> **Status (build):** Superseded in scope by ADR-0017: built as a SQLite-backed bus with Kafka-shaped semantics. The decision this ADR protects (the contract lives in message headers, so the transport is replaceable) is exactly what made the swap a one-file change.

**Context.** The demo needs a broker whose observable behaviour (consumer lag, offsets,
partitions, consumer groups, redelivery) is itself part of the failure story.

**Decision.** Redpanda, accessed via the Kafka API with KafkaJS.

**Rejected alternatives.**

- **Apache Kafka in KRaft mode** — identical semantics and client code, heavier footprint. The
  only advantage is the literal name; since the client code is byte-identical, the experience
  transfers either way.
- **RabbitMQ** — easier DLQ and delayed-message plugins, but routing-centric. Rejected because
  it loses the consumer-lag and offset model, and **lag is the observable signal** for the
  `slow_consumer` scenario.
- **NATS JetStream** — lightest and cleanest, but the smallest ecosystem and the fewest
  backpressure signals to observe.

**Consequences.** Kafka-API semantics available at ~1/3 the RAM; migrating to Apache Kafka
later is a Compose change. Partitioning by `business_operation_id` gives per-saga ordering and
the single-writer property that makes horizontal scaling possible later
([scalability.md](docs/scalability.md) §B1).

---

<a id="adr-0003"></a>
## ADR-0003: PostgreSQL only; no graph database

> **Status (build):** Partly superseded by ADR-0017: relational storage and no graph database stand, but on SQLite, and traversal is a bounded in-memory walk (same depth/node bounds and cycle guard) so ablations can derive alternative edge sets without persisting them. The CTE-vs-Neo4j benchmark was not run.

**Context.** The core data structure is a graph, and the core query is k-hop reverse
reachability. A graph database is the obvious-looking choice.

**Decision.** One PostgreSQL 16 instance. Adjacency stored in an `edges` table; traversal via
a recursive CTE.

**Rejected alternatives.**

- **Neo4j alongside Postgres** — rejected for MVP: an extra container, a second query language,
  a second data model, and a synchronisation problem. At 2,000-node subgraphs a recursive CTE
  is expected to beat a network round-trip to a separate store. Critically, **this is a
  prediction, not an assumption** — BM8 in [benchmarks/plan.md](docs/benchmarks/plan.md) is
  designed to test it, and if Neo4j wins this ADR gets revised with data.
- **ClickHouse for events + Postgres for metadata** — the correct answer at real scale and what
  production observability backends do. Rejected as large complexity for no MVP-visible benefit.
  Named as the evolution path.
- **Redis for the correlation index** — rejected: no measured cache need. Adding it without
  measurement would be resume padding.

**Consequences.** One container, one mental model, transactional consistency across events,
edges and investigations. JSONB covers flexible attributes; recursive CTEs cover traversal.
Negative: traversal performance will become the first query bottleneck, and the CTE
materialises its whole working set.

**Revisit trigger.** BM4 shows superlinear growth in investigation latency, or BM8 shows Neo4j
winning at MVP-scale subgraphs.

---

<a id="adr-0004"></a>
## ADR-0004: The normalised event is the graph node

**Context.** The node abstraction determines what the graph can express. Candidates: span,
operation, business action, normalised event.

**Decision.** A normalised event — one occurrence of one unit of work or one significant
observation, with an optional duration.

**Rejected alternatives.**

- **Span** — the natural choice given OTel, but cannot represent a message dwelling in a topic,
  a fault injection, a watchdog firing, or an analysis-time cluster. It is also trace-scoped,
  and Causora's whole point is crossing trace boundaries.
- **Operation (service + name)** — loses per-occurrence identity, which retries and duplicates
  absolutely require. Attempt 1 and attempt 2 must be distinct nodes.
- **Business action** — too coarse; one action contains the entire failure chain.

**Consequences.** A span maps to one event with a duration; span events, error logs, fault
records and synthesised clusters all map cleanly. Negative: the type carries both point-in-time
and interval semantics, which is slightly impure — accepted, because two node types would
double the graph model's complexity for no analytical gain.

---

<a id="adr-0005"></a>
## ADR-0005: Causal metadata as OTel span attributes, not a side channel

**Context.** Causora needs fields OTel does not define: `causation_id`, `idempotency_key`,
`attempt_number`, `retry_of_event_id`, `awaited_correlation_id`, `business_operation_id`.

**Decision.** Carry them as transport headers between services and as `causora.*` span
attributes into the telemetry pipeline. No separate domain-event stream to Causora.

**Rejected alternatives.**

- **A dedicated domain-event stream** — services publish structured causal events directly to
  Causora. Rejected: two telemetry paths to keep consistent, two failure modes, and services
  would need to know Causora exists.
- **OTel baggage** — semantically close, but baggage is size-limited, propagates to every
  downstream span whether relevant or not, and is conventionally a user-defined bag. These
  fields are structural.

**Consequences.** One pipeline, one failure mode. The telemetry stream remains **valid,
portable OTLP** readable by Jaeger or Tempo, with Causora's additions as extra attributes —
so Causora is an additive consumer of standard telemetry, not a proprietary format. The
contract becomes a concrete list of attribute names, which is exactly what makes the ablation
experiment implementable as configuration.

---

<a id="adr-0006"></a>
## ADR-0006: Declared evidence classes, not learned probabilities

**Context.** Edges need a notion of strength. The tempting approach is a learned or calibrated
confidence score.

**Decision.** Four declared evidence classes — proven, derived, inferred, weak — with fixed
per-rule confidence weights. The UI renders **labels, never percentages**. Inferred edges are
capped at `MAX_INFERRED_CONFIDENCE = 0.75` so no chain of inferences can outrank a proven chain.

**Rejected alternatives.**

- **Learned confidence from labelled scenario runs** — rejected. Thirty runs is nowhere near
  enough data, and a learned score would destroy the honesty that is the project's entire
  position. It would also make the ablation study circular.
- **A single scalar "causality score"** — rejected: it collapses *how we know* into *how much
  we believe*, which are different questions. Collapsing them is exactly the failure mode
  Causora is positioned against.

**Consequences.** Every edge can answer *how do you know this?* with a rule name and the
matched field values. "87% likely" would be a fabrication; "Derived — same idempotency key,
overlapping intervals, distinct reservation ids" is true and more useful. Negative: declared
weights are unvalidated priors, which is why the evaluation harness exists and why weights are
not tuned until there is data.

---

<a id="adr-0007"></a>
## ADR-0007: OTel Collector in the pipeline

> **Status (build):** Superseded by ADR-0017: no Collector. Redaction happens in the SDK (idempotency keys are hashed before export); the "side-by-side with Jaeger" demo is replaced by an in-app tracing-only rule set.

**Context.** Services could export OTLP directly to Causora.

**Decision.** Route all telemetry through an OTel Collector.

**Consequences / rationale.**

1. It is how real deployments work: services should not know their backend's name.
2. **Fan-out to Jaeger is free**, which enables the project's strongest demo beat — the same
   telemetry as a trace waterfall beside Causora's causal graph. Without the Collector this
   would need double-exporting from application code.
3. Redaction lives in **one auditable place** rather than being a discipline repeated across
   three services.
4. `memory_limiter` and batching protect Causora from the retry-storm telemetry burst the demo
   deliberately produces.
5. `retry_on_failure` buffers when Causora is down — harmless precisely because ingestion is
   idempotent on `event_id`. Two decisions that reinforce each other.

Cost: one container, ~128 MB, and a config file. Clearly worth it.

---

<a id="adr-0008"></a>
## ADR-0008: Modular platform — one API plus one worker

> **Status (build):** Superseded in scope by ADR-0017: a single platform process. The reasoning about event-loop contention is still the reason to move analysis to a worker thread at larger scale.

**Context.** The brief listed seven platform components (ingestion, normalisation, correlation,
causality, failure analysis, investigation API, fault injection) and asked which should be
services.

**Decision.** They are **modules inside two processes**: `platform/api` and `platform/worker`.

**Rejected alternative.** Six or seven microservices. Rejected: they share one data store and
one schema, so splitting them would create distributed transactions for no benefit; they are
built and deployed by one person; and splitting them multiplies the debugging surface of a
debugging tool.

**Why the API/worker split specifically is justified.** Graph traversal and ranking are
CPU-bound, and Node has one event loop per process. Long synchronous analysis in the API
process would stall ingestion and reads. **The boundary is drawn exactly where the runtime
demands it** — which is the correct reason to split a process, and a better answer than
"microservices are good practice".

**Consequences.** Module boundaries are enforced by directory structure and by communication
through `packages/contracts` types, so any module could be extracted later without redesign.
Negative: one deployable means one blast radius; acceptable at this scale.

---

<a id="adr-0009"></a>
## ADR-0009: A correlation index table

> **Status (build):** Not built (ADR-0017): derivation re-runs over the events of one business operation, which is cheap at this scale and needs no correlation index.

**Context.** Edge rules need fast lookups by nine different keys (span, trace, causation,
business op, idempotency, message, topic-offset, awaited, retry-of).

**Decision.** A narrow `event_correlations (event_id, key_type, key_value)` table indexed on
`(key_type, key_value)`. Each event writes 3–8 rows.

**Rejected alternative.** Composite indexes directly on `events`. Rejected because **each new
rule would need its own index and therefore a migration**. With the index table, adding a rule
requires no schema change at all — which matters enormously for a 4–6 week build where the
rule set is the part most likely to evolve.

**Consequences.** Edge derivation is O(log n) per lookup. Negative: 3–8× write amplification,
and `event_correlations` is expected to be one of the two largest contributors to storage
(BM5 will quantify it). Accepted as the price of a schema-stable rule set.

---

<a id="adr-0010"></a>
## ADR-0010: Incremental re-derivation for late arrivals

> **Status (build):** Realised differently: late arrivals are handled by re-deriving the whole operation on every batch (idempotent on from/to/type), verified by a unit test where a consumer arrives before its producer.

**Context.** Telemetry arrives out of order; a consumer span routinely precedes the producer
span it references, so a rule may find nothing on first pass.

**Decision.** Mark the business operation `dirty` on any new event; a 500 ms sweep re-runs
derivation for all events in dirty operations (bounded batch). Safe because edge writes are
idempotent on `(from, to, type)`.

**Rejected alternative.** Pending-edge resolution: record the missing `event_id` and resolve on
its arrival. O(1) amortised and the right answer at scale — but more state, more edge cases,
and unnecessary at MVP volumes where a saga is tens of events.

**Consequences.** ~60 lines of code; cost proportional to saga size, not total event count.
Negative: up to 500 ms of edge latency, and repeated re-derivation of a long-lived operation.

**Revisit trigger.** BM2 shows the sweep dominating pipeline latency, or business operations
routinely exceed a few hundred events.

---

<a id="adr-0011"></a>
## ADR-0011: Table partitioning deferred

**Context.** At 2,000 events/s, `events` would grow ~170M rows/day.

**Decision.** No partitioning at MVP. Document the migration: monthly RANGE partitions on
`occurred_at`, with partition pruning for time-filtered queries and `DROP PARTITION` for
retention instead of `DELETE`.

**Rationale.** At MVP volumes (~10⁵ rows) partitioning adds migration complexity and query
planning surprises for zero benefit. The migration path is straightforward because
`occurred_at` is already present on every row and every time-filtered query already uses it.

**Revisit trigger.** `events` exceeds ~50M rows, or BM7 shows read latency degrading with table
size.

---

<a id="adr-0012"></a>
## ADR-0012: Docker Compose, not Kubernetes

> **Status (build):** Superseded by ADR-0017: no Docker at all. `npm install && npm start`.

**Context.** Ten containers need orchestrating for development and demonstration.

**Decision.** Docker Compose as the only supported environment.

**Rejected alternative.** Kubernetes (kind/minikube/k3d). Rejected: it adds manifests,
networking complexity, image-loading friction and a slower iteration loop, while teaching
nothing about the problem Causora addresses. A k8s manifest set may be added in M15 as a
packaging exercise — but it must never become the development environment.

**Consequences.** `docker compose up` is the quickstart, which directly serves the
"actually runnable, reproducible" requirement. Negative: no demonstration of k8s skills, which
is an honest and acceptable trade.

---

<a id="adr-0013"></a>
## ADR-0013: Three demo services

**Context.** The brief suggested up to five (gateway, order, inventory, payment, notification).

**Decision.** Three: Order, Inventory, Payment.

**Rationale.** Three services plus a broker already produce every failure semantic the project
needs: a synchronous chain, an asynchronous hop, a timeout, a retry, a concurrency race, a
duplicate, and a downstream failure located far from its cause. A notification service adds a
container and **zero new semantics**. An API gateway adds a hop with no failure behaviour of
its own.

**Consequences.** Smaller footprint, faster startup, less code to maintain. Payment is
deliberately kept — not for its logic, but because it places the *symptom* three hops from the
*cause*, which is the product's entire reason to exist.

---

<a id="adr-0014"></a>
## ADR-0014: Fault injector as evaluation ground truth

**Context.** Root-cause ranking is a heuristic. Without measurement it is an opinion.

**Decision.** Every scenario declares `groundTruth` before it runs. The harness computes Hit@1,
Hit@3, MRR and graph completeness against it. **Ground truth is structurally prevented from
reaching the analysis pipeline.**

**Enforcement** (all three required):
1. The ranker's input type omits `is_fault_injected` and `experiment_id` — leakage is a
   compile error.
2. `FAULT_AFFECTED` edges are excluded from traversal unless `mode=ground_truth`.
3. A unit test asserts ranking is byte-identical with and without the fault flags set.

**Consequences.** This single decision converts the project from "I built a visualisation" into
"I built an evaluated system and here are the numbers" — the largest single increase in the
project's value, and the enabler of the ablation study. Negative: it constrains the design
permanently; the integrity tests must never be relaxed for convenience.

**Known limitation, stated rather than argued away.** The injected fault is the *intervention*,
not necessarily the *defect*. In the primary scenario the fault is a delay while the defect is
a non-transactional idempotency guard. Causora ranks the delayed operation first, which answers
"where did the chain start" and not "what should I fix". Scenario S7 demonstrates the
distinction. See [evaluation.md](docs/experiments/evaluation.md) §5.

---

<a id="adr-0015"></a>
## ADR-0015: No sampling at MVP

**Context.** Production tracing almost always samples. OTel defaults invite it.

**Decision.** `AlwaysOnSampler` at MVP.

**Rationale.** Sampling is **causally destructive**: a sampled-away producer span orphans its
consumer, which is exactly the chain Causora depends on. A chain of length k survives
independent sampling at rate p with probability ~p^k, so an 8-edge chain barely survives even
generous sampling. Sampling at MVP would mean debugging the sampler instead of the engine.

**Consequences.** Higher telemetry volume, which is irrelevant at demo scale. The interesting
consequence is that this becomes a measurable research question — *at what sampling rate does
causal graph completeness collapse, and does error-biased tail sampling preserve
diagnosability?* — specified in [research.md](docs/experiments/research.md) §3. The design
decision came first; the experiment validates it.

---

<a id="adr-0016"></a>
## ADR-0016: The demo app ships a deliberate concurrency bug

**Context.** The primary scenario needs a duplicate reservation. It could be produced by simply
omitting the idempotency check.

**Decision.** The Inventory Service implements a **real check-then-act race**: it reads
`processed_messages`, does the (slow) work, then writes the idempotency record — all
non-transactionally. A control variant (`inventory_fix`) writes the record first, in the same
transaction, relying on the unique constraint.

**Rationale.** Omitting the check would be a contrived failure and would invite the fair
criticism that the demo is staged. A non-transactional idempotency guard is one of the most
common genuine correctness bugs in event-driven systems. Shipping the real bug means the
project demonstrates understanding of *why* idempotency guards must be transactional — a
stronger signal than any diagram.

**Consequences.** The bug is prominently commented as intentional, with a reference to the
scenario document, so no reader mistakes it for an oversight. The control variant provides an
**executed counterfactual**: same injected fault, corrected guard, no failure, and exactly one
edge missing from the graph. That comparison is the most persuasive thing the project can show,
and it is available essentially for free.

---

<a id="adr-0017"></a>
## ADR-0017: Three-day lightweight scope (supersedes parts of ADR-0002, 0003, 0007, 0008, 0012)

**Context.** The original blueprint (~82 h MVP, Redpanda + OTel Collector + Jaeger + Postgres +
Compose) was re-scoped to a hard three-day deadline on a 16 GB laptop with no GPU. The thesis
and the novel parts — the causal metadata contract, the evidence-classed edge model, the
frontier-based ranking, the injector-as-ground-truth evaluation and the metadata ablation — are
unchanged. Only the plumbing around them shrinks.

**Decision.**

| Blueprint | Built | Why it is safe to change |
|---|---|---|
| Redpanda / Kafka | A durable SQLite-backed bus (`src/bus`) with topics, keys, consumer groups, at-least-once delivery, visibility timeout and redelivery. `publish()` / `subscribe()` keep the causal fields as **required parameters**. | The contract lives in message headers, not in the broker. Swapping in KafkaJS touches one file. |
| PostgreSQL | `node:sqlite` (WAL mode), one file per service plus `causora.db` | Zero infrastructure: `npm install && npm start`. Recursive CTEs and `INSERT ... ON CONFLICT` behave identically. |
| OTel SDK + Collector + Jaeger | A small OTel-shaped tracer (`src/telemetry`) that exports spans to `POST /v1/spans`. W3C `traceparent` is propagated on every hop. Redaction (hashing the idempotency key) happens in the SDK. | The research question is about *which causal fields survive a hop*, not about OTLP encoding. Jaeger's "side-by-side" beat is replaced by an in-app **tracing-only** view that shows exactly the edges a tracing tool would. |
| API + worker | One `platform` process | At this scale the event-loop argument (ADR-0008) does not bite; analysis is a pure function and can move to a worker thread later without redesign. |
| Recursive-CTE traversal | Bounded, cycle-guarded traversal in TypeScript over the per-operation subgraph | The ablation derives edges for alternative rule sets *in memory* without persisting them; a CTE would force a write per rule set. The bounds and cycle guard are retained and tested. |
| Raw telemetry table + replay | Events are stored normalised; **re-derivation with a different rule set is the replay** | Edge derivation is a pure function of stored events, so replay reduces to "derive again". |
| Kubernetes, k6, Testcontainers, Neo4j | Dropped | Not needed for the claims being made. |
| Screens | Overview + Fault Lab (merged), Investigation, Evaluation | Timeline tab, Trace/Service explorers dropped (M15). |
| Scenarios | S1 inventory delay → duplicate reservation, S2 payment latency, S3 payment error, S4 retry exhaustion, plus the `inventory_fix` control | Each exercises a different edge type. |

**Two corrections to the blueprint discovered while designing the build.**

1. *Retry arithmetic.* The blueprint's 5 s delay against a 2 s deadline yields **three** attempts
   (t = 0, 2, 4) before the first completes at t = 5, not two. The scenario therefore uses
   `deadline D = 1000 ms`, `delay L = 1700 ms` (`D < L < 2D`), giving exactly one retry, and the
   settle window must exceed the gap between the two completions (≈ D), not 500 ms.
2. *Caller-allocated event ids.* A timeout can only name the awaited event (`awaited_correlation_id`)
   if its id is known *before* the callee runs. The contract therefore lets the caller allocate the
   callee's event id: HTTP via `x-causora-event-id`, messaging via the deterministic
   `consume:<message_id>:<group>`. This is what makes `TIMED_OUT_WAITING_FOR` provable.

**Alternatives considered and rejected.**

- *Keep Postgres + Redpanda + Collector + Jaeger in Compose.* Rejected: roughly 2 GB of containers plus Docker Desktop's own overhead on a 16 GB laptop that also runs an IDE and a browser, and more than a day of wiring OTLP and KafkaJS for no change to the research claim.
- *Redis Streams / NATS as a lighter broker.* Rejected: still a service to install and run, and still not the point of the project.
- *An in-memory bus inside one process.* Rejected: it would erase the process and persistence boundaries that make the causal metadata contract mean something (a header must survive serialisation to disk and a hop between processes).
- *PGlite / SQLite via a native addon.* Rejected: PGlite cannot be shared across processes; native addons add install risk on Windows. `node:sqlite` is built in.

**Measured footprint.** Five Node processes (launcher, platform, three services) total ≈ 407 MB working set, measured with `Get-Process` immediately after a full evaluation run (launcher 64 · platform 102 · order 84 · inventory 80 · payment 78 MB).

**Consequences.** Faster to run (≈ 0.4 GB, no Docker), easier to review, and the
benchmark/Compose DoD items (1, 12, 16) are replaced by `npm start` equivalents and a
measured micro-benchmark. Anything that was in the blueprint and is absent here is listed in
README "Scope" so no one assumes it exists.
