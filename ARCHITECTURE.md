# Causora - Architecture

> **Build status - blueprint document.** The system diagram and container inventory below describe the **blueprint**. What was built has no containers: one platform process, three service processes, a SQLite-backed bus and SQLite storage (see the README and [ADR-0017](DECISIONS.md#adr-0017)). The requirements, the causal model, the Definition of Done and the repository-structure intent still hold; [PROGRESS.md](PROGRESS.md) records each DoD item as verified, replaced or not done.

Master architecture document. Audience: the engineer (or agent) implementing Causora.

---

## 1. Executive summary

Causora is a **causality-aware distributed debugging platform**. It ingests OpenTelemetry
data from a deliberately fault-prone demo application, normalises it into a single event
model, derives typed and evidence-scored causal edges between events, and - given a failure -
reconstructs the ancestor subgraph, detects known failure patterns, and ranks candidate
origins with explicit evidence.

The project has three deliverables:

1. **An engineering artefact** - a runnable distributed system plus an analysis platform.
2. **An evaluated system** - root-cause ranking measured against fault-injector ground truth.
3. **An experiment** - an ablation showing how graph completeness and ranking accuracy
   degrade as causal metadata is removed.

Deliverable 3 is what distinguishes Causora from a dashboard.

### Core thesis

Causality is propagated, not discovered. The hard engineering problem is not "guess what
caused what" - it is:

- defining a metadata contract that makes causality **provable**,
- propagating it correctly across HTTP *and* message-broker boundaries,
- reconstructing the graph from telemetry that arrives late, out of order and incomplete,
- and being honest about what is proven versus derived versus inferred.

### Non-goals

Not built, deliberately: ML/LLM root-cause analysis, metrics dashboards (Grafana exists),
log search (Loki exists), alerting, service mesh, multi-tenancy, horizontal autoscaling,
Kubernetes as the dev environment, a graph database.

---

## 2. Problem definition

**Who.** A backend or SRE engineer debugging a failure in an event-driven system.

**The failure they are debugging.** The symptom surfaces in a service that is not at fault,
in a different trace from the cause, after an intervening retry, seconds later.

**What they do today.** Open a trace, find it truncated at the broker boundary. Grep logs
across three services by correlation id. Reconstruct the ordering by hand in a scratch file.
Form a hypothesis. Try to reproduce it. Typically 30–90 minutes per incident.

**What Causora does instead.** Presents the ancestor subgraph of the failure with every
relationship typed and evidenced, the propagation frontier highlighted, retry and duplicate
clusters collapsed, and a ranked candidate list - then lets the engineer re-run the exact
scenario to confirm.

**Concrete scope boundary.** Causora answers *what chain of events led to this failure, and
where did the chain start?* It does not answer *is my system healthy?*

---

## 3. Requirements

### 3.1 Functional (MVP)

| ID | Requirement |
|---|---|
| F1 | Run a 3-service event-driven demo application with a realistic saga |
| F2 | Emit OpenTelemetry traces and logs carrying the causal metadata contract |
| F3 | Ingest telemetry idempotently and durably; support replay of a recorded run |
| F4 | Normalise heterogeneous telemetry into one event model |
| F5 | Derive typed, evidence-scored causal edges, each attributable to a named rule |
| F6 | Detect failures and persist them as investigable entities |
| F7 | Build the ancestor subgraph of a failure with bounded depth and size |
| F8 | Detect failure patterns: retry storm, duplicate work, timeout cascade, slow consumer |
| F9 | Rank candidate origins with evidence and a qualitative confidence label |
| F10 | Inject reproducible faults through a gated API, recording ground truth |
| F11 | Present overview, investigation and fault-lab screens in a web UI |
| F12 | Render the causal graph interactively with edge class visually distinct |

### 3.2 Functional (post-MVP)

| ID | Requirement |
|---|---|
| F13 | Evaluation harness computing Hit@1, Hit@3, MRR over scenario runs |
| F14 | Metadata-ablation experiment with reported accuracy degradation |
| F15 | Remaining fault scenarios (payment timeout, service crash, retry storm, clock skew) |
| F16 | Trace comparison against a healthy baseline run |
| F17 | Watermark-based completeness with pending-edge resolution |
| F18 | Trace explorer and service explorer screens |

### 3.3 Non-functional

| ID | Requirement | Target |
|---|---|---|
| N1 | Reproducibility | `docker compose up` yields a working system on a 16GB laptop |
| N2 | Ingestion throughput | 2,000+ normalised events/s sustained, single worker |
| N3 | Edge derivation latency | p95 under 50 ms per event from ingest to edges persisted |
| N4 | Investigation latency | p95 under 2 s for a subgraph of 2,000 nodes or fewer |
| N5 | API latency | p95 under 300 ms for read endpoints excluding investigation runs |
| N6 | Correctness | ingestion idempotent on `event_id`; edges idempotent on (from, to, type) |
| N7 | Honesty | no edge participates in ranking above its declared evidence class |
| N8 | Safety | fault injection refuses to run unless triple-gated (see Security) |
| N9 | Observability of self | Causora emits its own telemetry on separate topics |
| N10 | Understandability | every module has a documented purpose; no component without a reason |

Targets in N2–N5 are **design budgets, not measured results.** The implementation phase
replaces them with real numbers.

---

## 4. System architecture

```
+------------------------ DEMO APPLICATION (the system under study) ------------------------+
|                                                                                           |
|   client --HTTP--> Order Service --HTTP--> Inventory Service        Payment Service        |
|                        |  ^                      |                      ^                 |
|                    produce consume           produce                  HTTP                |
|                        |  |                      |                      |                 |
|                        v  |                      v                      |                 |
|                  +------------- REDPANDA (Kafka API) --------------+                      |
|                  |  orders.events        inventory.events          |                      |
|                  +-------------------------------------------------+                      |
|                                                                                           |
|                  PostgreSQL  (app db: orders, stock, idempotency)                         |
+-------------------------------------------------------------------------------------------+
                                         |
                             OTel SDK (traces + logs)
                                         |
                                         v
                             +----------------------+
                             |  OTel Collector      |
                             |  batch, redact, fan  |
                             +----------+-----------+
                          OTLP/HTTP     |      OTLP/gRPC
                    +-------------------+      +--------------> Jaeger (side-by-side demo)
                    v
+---------------------------- CAUSORA PLATFORM ------------------------------+
|                                                                            |
|  platform/api  (Fastify)                     platform/worker               |
|  |- POST /v1/traces, /v1/logs                 |- consume causora.ingest     |
|  |- /api/v1 read endpoints                    |- normalise                  |
|  |- /api/v1/investigations                    |- correlate (index keys)     |
|  |- /api/v1/experiments (gated)               |- derive edges (rule set)    |
|        |                                      |- detect failures            |
|        |              write raw               |- update baselines           |
|        |              + enqueue               |- run analysis jobs          |
|        |                   |                           |                    |
|        v                   v                           v                    |
|   +---------------- PostgreSQL (causora db) ----------------------+          |
|   | raw_telemetry . events . event_correlations . edges .         |          |
|   | business_operations . failures . investigations .             |          |
|   | investigation_candidates . operation_baselines .              |          |
|   | fault_experiments . patterns_detected                         |          |
|   +---------------------------------------------------------------+          |
|                                                                            |
|   Redpanda topic: causora.ingest  (decoupling + backpressure + replay)     |
+----------------------------------------------------------------------------+
                    ^
                    | REST /api/v1
                    |
             +--------------+
             |  web (React) |  Overview . Investigation . Fault Lab
             +--------------+
```

### Container inventory

| Container | Purpose | Approx RAM |
|---|---|---|
| `redpanda` | Kafka-API broker: app events + Causora ingest | 512 MB |
| `postgres` | both `app` and `causora` databases | 256 MB |
| `otel-collector` | batching, attribute redaction, fan-out | 128 MB |
| `jaeger` | comparison trace UI | 256 MB |
| `order-service` | demo | 96 MB |
| `inventory-service` | demo | 96 MB |
| `payment-service` | demo | 96 MB |
| `causora-api` | ingest + REST | 160 MB |
| `causora-worker` | pipeline + analysis | 192 MB |
| `web` | Vite dev server / nginx static | 128 MB |

Approximately 2 GB total. Comfortable on a 16 GB machine alongside an IDE.

### Why the platform is one deployable plus one worker

Ingestion, normalisation, correlation, causality, analysis and the query API are **modules
inside two processes**, not six services. Reasons:

- They share one data store and one schema; splitting them would create distributed
  transactions for no benefit.
- They are developed and deployed together by one person.
- Splitting them multiplies the debugging surface of a debugging tool, which is absurd.

The split that *is* justified is **API vs worker**, for one specific reason: graph traversal
and ranking are CPU-bound, and Node has a single event loop per process. Long synchronous
analysis in the API process would stall ingestion and reads. The boundary is drawn exactly
where the runtime demands it - and that reasoning is itself a design talking point.

Module boundaries inside each process are enforced by directory structure and by the rule
that modules communicate through typed interfaces in `packages/contracts`, so any module
could later be extracted without redesign.

---

## 5. Reading order for the implementer

1. [docs/architecture/demo-application.md](docs/architecture/demo-application.md) - the system under study and how it breaks
2. [docs/algorithms/event-model.md](docs/algorithms/event-model.md) - **the causal metadata contract; read before writing any instrumentation**
3. [docs/architecture/observability.md](docs/architecture/observability.md) - telemetry pipeline
4. [docs/database/schema.md](docs/database/schema.md) - persistence
5. [docs/architecture/platform.md](docs/architecture/platform.md) - platform internals
6. [docs/algorithms/causal-graph.md](docs/algorithms/causal-graph.md) - node and edge model
7. [docs/algorithms/causality-algorithm.md](docs/algorithms/causality-algorithm.md) - pipeline algorithm
8. [docs/algorithms/failure-analysis.md](docs/algorithms/failure-analysis.md) - investigation algorithm
9. [docs/experiments/fault-injection.md](docs/experiments/fault-injection.md) - scenarios and ground truth
10. [docs/api/rest-api.md](docs/api/rest-api.md) - API surface
11. [docs/frontend/product-design.md](docs/frontend/product-design.md) - screens and UX flow
12. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) - build order

Supporting: [docs/security.md](docs/security.md), [docs/scalability.md](docs/scalability.md),
[docs/testing-strategy.md](docs/testing-strategy.md),
[docs/benchmarks/plan.md](docs/benchmarks/plan.md),
[docs/experiments/evaluation.md](docs/experiments/evaluation.md),
[docs/experiments/research.md](docs/experiments/research.md),
[docs/interview-prep.md](docs/interview-prep.md).

---

## 6. Repository structure

```
causora/
|-- README.md
|-- ARCHITECTURE.md                  <- this file
|-- IMPLEMENTATION_PLAN.md
|-- DECISIONS.md
|-- PROGRESS.md
|-- docker-compose.yml               full stack
|-- docker-compose.bench.yml         overrides for benchmark runs
|-- package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
|
|-- packages/
|   |-- contracts/      Zod schemas: normalised event, edges, API DTOs, causal contract
|   |                   SINGLE SOURCE OF TRUTH - imported by services, platform and web
|   |-- telemetry/      OTel bootstrap + causal-context propagators (HTTP + Kafka headers)
|   |-- kafka/          KafkaJS wrappers that enforce header propagation by construction
|   |-- testkit/        Testcontainers fixtures, scenario drivers, graph assertions
|
|-- services/           THE SYSTEM UNDER STUDY
|   |-- order-service/
|   |-- inventory-service/
|   |-- payment-service/
|
|-- platform/           CAUSORA ITSELF
|   |-- api/            ingest endpoints + REST API
|   |-- worker/         normalise -> correlate -> derive -> detect; analysis jobs
|   |-- shared/         db access, repositories, rule registry, config
|
|-- web/                React + Vite dashboard
|
|-- infra/
|   |-- otel-collector/ collector config incl. redaction processor
|   |-- postgres/       init SQL, migrations
|   |-- redpanda/       topic bootstrap
|
|-- experiments/
|   |-- scenarios/      declarative scenario definitions
|   |-- evaluation/     Hit@k / MRR / completeness harness
|   |-- ablation/       metadata-removal study runner
|
|-- bench/              k6 scripts + result files (results committed, never invented)
|-- scripts/            dev helpers: seed, replay, reset, demo
|-- docs/               as mapped in README
```

Every directory above exists because something in the requirements needs it. There are no
placeholder directories.

---

## 7. Definition of Done

### MVP Definition of Done

1. `docker compose up` on a clean checkout brings up the full stack with no manual steps.
2. `pnpm demo:happy-path` creates an order that reaches `CONFIRMED`, and Jaeger shows the trace.
3. `pnpm demo:primary-failure` reliably produces the delayed-inventory → timeout → retry →
   duplicate-reservation → payment-failure chain, in at least 9 runs out of 10.
4. The Causora UI lists that failure within 5 s of it occurring.
5. Opening the investigation shows a causal graph whose proven edges match the expected
   chain exactly, asserted by an automated E2E test - not by eye.
6. Every edge in the graph exposes its type, evidence class, the rule that derived it, and
   the specific field values that matched.
7. The top-ranked candidate is the injected fault's service and operation.
8. The Fault Lab can re-run the scenario from the UI and the new investigation appears.
9. No edge of class *inferred* or *weak* contributes to ranking above its declared weight,
   verified by a unit test over the scoring function.
10. `is_fault_injected` is provably absent from the ranking inputs, verified by a unit test.
11. Unit coverage at or above 80% on `platform/worker/rules` and the analysis module.
12. A clean-machine run of the README quickstart by someone else succeeds.

### Project Definition of Done (post-MVP)

13. Four or more fault scenarios, each with an automated assertion of its expected graph.
14. Evaluation harness reports Hit@1, Hit@3 and MRR over 30 or more scenario runs.
15. Ablation study reports accuracy and completeness with `causation_id` propagation disabled.
16. Benchmark results committed with hardware, methodology, repetition count and percentiles.
17. ADRs cover every decision in DECISIONS.md with rationale and rejected alternatives.
18. `docs/interview-prep.md` questions all map to real code paths.
