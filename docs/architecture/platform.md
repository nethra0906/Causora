# Causora Platform — internal architecture

> **Build status — blueprint document.** Built as **one** platform process (ingest, normalise, derive, detect, analyse, REST, static UI) rather than API + worker; analysis is a pure function and can move to a worker thread without redesign. Storage is SQLite. See [ADR-0017](../../DECISIONS.md#adr-0017).

Two processes, clear module boundaries, no microservices.

---

## 1. `platform/api` — Fastify

```
platform/api/src/
├── index.ts                 bootstrap: telemetry FIRST, then server
├── server.ts                Fastify instance, plugins, error handler
├── ingest/
│   ├── routes.ts            POST /v1/traces, POST /v1/logs  (OTLP receiver)
│   ├── envelope.ts          size cap, content-type negotiation (protobuf + JSON)
│   └── enqueue.ts           write raw_telemetry, publish to causora.ingest
├── read/
│   ├── overview.routes.ts
│   ├── operations.routes.ts
│   ├── events.routes.ts
│   ├── graph.routes.ts
│   ├── failures.routes.ts
│   └── investigations.routes.ts
├── experiments/
│   ├── routes.ts            scenario run/stop  (TRIPLE-GATED, see docs/security.md)
│   └── guard.ts             the three gates, in one place, heavily tested
├── middleware/
│   ├── auth.ts              bearer token
│   ├── ratelimit.ts         per-route token bucket
│   └── problem.ts           RFC 7807 error responses
└── jobs/
    └── enqueue-investigation.ts   publishes an analysis job, returns 202
```

**The API never runs analysis.** `POST /api/v1/investigations` writes a `RUNNING` row,
publishes a job to `causora.jobs`, and returns 202 with the investigation id. The client
polls or subscribes via SSE. This is the API/worker boundary doing its job.

**Why Fastify over Express.** Schema-based validation and serialisation compiled from the
same Zod schemas in `packages/contracts` (via `fastify-type-provider-zod`), measurably faster
JSON handling, and first-class async error handling. On an OTLP ingest path the serialisation
cost is not academic.

---

## 2. `platform/worker`

```
platform/worker/src/
├── index.ts                 bootstrap, consumer group wiring, shutdown hooks
├── pipeline/
│   ├── consumer.ts          consume causora.ingest
│   ├── normalise/           PURE: OTLP -> NormalisedEvent[]   (no I/O, no clock)
│   ├── correlate.ts         write event_correlations, upsert business_operations
│   └── persist.ts           idempotent writes, one transaction per envelope
├── rules/
│   ├── types.ts             EdgeRule, CorrelationLookup (the port)
│   ├── registry.ts          rule set configuration + selection
│   ├── parent-span.ts
│   ├── triggered-causation.ts
│   ├── retry-explicit.ts
│   ├── timeout-awaited.ts
│   ├── fault-window.ts
│   ├── duplicate-idempotency.ts
│   ├── triggered-inferred.ts
│   ├── retry-inferred.ts
│   └── proximity.ts         (disabled by default)
├── detect/
│   ├── failures.ts
│   ├── baselines.ts         periodic recompute over healthy traffic
│   └── patterns.ts          the pattern library
├── analysis/
│   ├── job-consumer.ts      consume causora.jobs
│   ├── scope.ts             the recursive CTE + Tarjan SCC collapse
│   ├── score.ts             anomaly scoring  (takes RankableEvent only)
│   ├── frontier.ts          reverse topological pass
│   ├── rank.ts              declared weighted scoring
│   ├── evidence.ts          evidence bundle assembly
│   └── label.ts             qualitative confidence labelling
├── maintenance/
│   ├── rederive.ts          dirty business-operation sweep (every 500 ms)
│   ├── prune-raw.ts         retention
│   └── baseline-tick.ts     every 60 s
└── shared/                  re-exported from platform/shared
```

### Concurrency model

Node has one event loop per process, so concurrency here is explicit and bounded:

| Concern | Mechanism |
|---|---|
| Envelope processing | KafkaJS `eachBatch` with `p-limit(INGEST_CONCURRENCY)`, default 8 |
| Backpressure | bounded in-flight count; pause the consumer above the high-water mark |
| Analysis jobs | separate consumer group, `p-limit(ANALYSIS_CONCURRENCY)`, default 2 |
| Long CPU sections | `scope.ts` and `frontier.ts` yield via `setImmediate` every 500 nodes so the Kafka heartbeat is not starved |
| Timers | `rederive`, `baseline-tick`, `prune-raw` on independent intervals with overrun guards |
| Shutdown | SIGTERM → stop consuming → drain in-flight → commit offsets → close pool |

The `setImmediate` yielding detail is not optional. A 5,000-node traversal that blocks the
loop for 400 ms will cause KafkaJS to miss its heartbeat and trigger a consumer-group
rebalance mid-investigation — a bug that looks like a Kafka problem and is actually an event
loop problem. Worth knowing, worth testing, and an excellent thing to be able to explain.

If analysis later outgrows this, the next step is `worker_threads` for `scope`/`frontier`,
then a separate analysis process. Documented as the evolution path; not built now.

### Transaction boundaries

```
per envelope (one transaction):
  INSERT events              ON CONFLICT (event_id) DO NOTHING
  INSERT event_correlations  ON CONFLICT DO NOTHING
  UPSERT business_operations (set dirty = true)
  INSERT edges               ON CONFLICT (from, to, type) DO NOTHING
  UPDATE raw_telemetry SET status = 'processed'
COMMIT
then commit the Kafka offset
```

Offset after commit, never before. That is at-least-once, and the `ON CONFLICT` clauses are
what make at-least-once safe. This is precisely the property the demo app gets wrong on
purpose — the platform gets it right, and the contrast is deliberate and worth pointing out
in the README.

---

## 3. `platform/shared`

```
platform/shared/src/
├── config.ts        env parsing via Zod; fails fast and loud at startup
├── db/
│   ├── pool.ts      pg Pool, statement timeout, pool metrics
│   ├── migrate.ts   numbered SQL runner
│   └── repositories/   events, edges, correlations, investigations, failures,
│                       baselines, experiments, businessOperations
├── kafka.ts         producer/consumer factories for causora.* topics
├── lookup/
│   ├── postgres.ts  CorrelationLookup over the index table
│   └── memory.ts    CorrelationLookup for unit tests
└── telemetry.ts     Causora's own OTel -> topic causora.self, NEVER into the graph
```

Repositories return `packages/contracts` types. No raw rows escape the repository layer, and
no SQL exists outside it — so the schema can change without touching the rules or the
analysis code.

`lookup/memory.ts` exists so that **all nine edge rules are unit-testable with no database
and no containers.** That makes the rules fast to iterate on, which matters because the rules
are where the thinking is.

---

## 4. `packages/*` — the shared layer

### `packages/contracts`
The single source of truth. Zod schemas for `NormalisedEvent`, `CausalEdge`, `Completeness`,
`Investigation`, every API request/response, and the causal-header names as **constants, not
string literals** (`CAUSAL_HEADERS.CAUSATION_ID`). Imported by services, platform *and* web,
so a contract change breaks compilation everywhere it should.

### `packages/telemetry`
```
initTelemetry({ serviceName })      // call FIRST, before any other import
withCausalContext(ctx, fn)          // AsyncLocalStorage-backed causal context
getCausalContext()
injectHttpHeaders(headers)          // write the x-causora-* set
extractHttpHeaders(headers)
injectKafkaHeaders(headers)         // write the causora-* set
extractKafkaHeaders(headers)
recordCausalAttributes(span)        // stamp causora.* attributes onto a span
```
Causal context rides on `AsyncLocalStorage`, propagated alongside OTel's own context. The
contract fields are *not* OTel baggage: baggage is size-limited and semantically a
user-defined bag, while these are structural. Keeping them explicit makes the contract legible
and the ablation implementable.

### `packages/kafka`
Thin KafkaJS wrappers whose signatures make the contract unforgettable:

```ts
publish<T>(topic, { key, payload, causation, idempotencyKey, attempt })
// headers are set by the wrapper; there is no way to publish without them

subscribe<T>(topic, groupId, handler)
// extracts causal headers, opens the causal context, starts the consume span,
// stamps causora.* attributes — all before the handler body runs
```

Required fields are *required parameters*. A developer cannot forget `causation` because the
code will not compile. **Enforcing the architectural contract in the type system rather than
in a code-review checklist is the single most valuable engineering decision in the
project** — and it is the honest answer to "how do you know your services are instrumented
correctly?"

### `packages/testkit`
Testcontainers fixtures (Postgres, Redpanda), a scenario driver that runs a fault scenario
end to end, OTLP fixture loaders, and graph assertion helpers:

```ts
expectEdge(graph, { from: 'order.created#1', to: 'inventory.reserve#1',
                    type: 'TRIGGERED', evidenceClass: 'proven' })
expectChain(graph, ['fault.injected', 'inventory.reserve#1',
                    'timeout.fired', 'order.created#2', ...])
expectNoWeakEdgeInRanking(investigation)
```

These assertions are what make Definition-of-Done item 5 ("asserted by a test, not by eye")
achievable.
