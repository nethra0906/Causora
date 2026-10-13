# Observability Architecture

> **Build status - blueprint document.** Not built: the OTel Collector, its redaction processor, Jaeger and OTLP/protobuf ingest. Built instead: a small OTel-shaped tracer (`src/telemetry`) exporting batched JSON to `POST /v1/spans`, with idempotency keys **hashed in the SDK**, and an in-app *tracing-only* rule set that stands in for the Jaeger comparison. See [ADR-0017](../../DECISIONS.md#adr-0017).

How telemetry gets from the demo services into Causora, and why the pipeline looks like this.

---

## 1. Pipeline

```
Demo service
  OTel Node SDK
    - auto-instrumentation: http, pg, kafkajs
    - manual spans:         domain operations, saga steps
    - span events:          retry.initiated, timeout.fired, idempotency.hit/miss
    - log records:          structured, with trace context
    - causora.* attributes: the causal metadata contract
  |
  | OTLP/gRPC  (batch: 512 spans or 2s)
  v
OTel Collector
    receivers:  otlp (grpc 4317, http 4318)
    processors: memory_limiter -> attributes/redact -> batch
    exporters:  otlphttp/causora   (traces + logs)
                otlp/jaeger        (traces only)
  |
  +--------------------------------> Jaeger   :16686   (the comparison baseline)
  |
  v  OTLP/HTTP protobuf
Causora  POST /v1/traces, /v1/logs
```

## 2. Why use a Collector at all

A one-person project could export directly to Causora. The Collector earns its container:

1. **It is how real deployments work.** Services should not know the name of their
   observability backend. Being able to say that, and show it, is worth a container.
2. **Fan-out to Jaeger is free.** This is what enables the strongest demo beat in the
   project: the same telemetry rendered as a trace waterfall next to Causora's causal graph.
   "Here is what tracing shows you. Here is what it misses." Without the Collector you would
   have to double-export from application code.
3. **Redaction belongs outside the application.** The `attributes/redact` processor is a
   single auditable place where sensitive fields are removed, rather than a discipline
   repeated in three services. See `docs/security.md`.
4. **Batching and `memory_limiter` protect Causora** from a retry-storm telemetry burst,
   which is a thing the demo deliberately produces.

Decision and rejected alternatives: [ADR-0007](../../DECISIONS.md#adr-0007).

## 3. Collector configuration (shape)

```yaml
receivers:
  otlp:
    protocols: { grpc: { endpoint: 0.0.0.0:4317 }, http: { endpoint: 0.0.0.0:4318 } }

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 15

  attributes/redact:
    actions:
      # hash rather than drop: Causora still needs identity, never the value
      - key: causora.idempotency_key   action: hash
      - key: enduser.id                action: hash
      - key: db.statement              action: delete
      - key: http.request.header.authorization  action: delete
      - key: order.customer_email      action: delete
      - key: payment.card_number       action: delete

  batch:
    send_batch_size: 512
    timeout: 2s

exporters:
  otlphttp/causora:
    endpoint: http://causora-api:8080
    headers: { authorization: "Bearer ${CAUSORA_INGEST_TOKEN}" }
    retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s }
  otlp/jaeger:
    endpoint: jaeger:4317
    tls: { insecure: true }

service:
  pipelines:
    traces: { receivers: [otlp], processors: [memory_limiter, attributes/redact, batch],
              exporters: [otlphttp/causora, otlp/jaeger] }
    logs:   { receivers: [otlp], processors: [memory_limiter, attributes/redact, batch],
              exporters: [otlphttp/causora] }
```

**`hash` not `delete` for `idempotency_key`** is an important subtlety: duplicate detection
needs to know that two events share a key, but never needs the key's value. Hashing preserves
the analytical property and removes the sensitive content. The same reasoning applies to
`enduser.id`. Being able to articulate that trade-off is a genuine privacy-engineering point.

`retry_on_failure` means the Collector buffers if Causora is down - and because Causora's
ingest is idempotent on `event_id`, the resulting duplicate delivery is harmless. The two
decisions are connected by design.

## 4. Instrumentation requirements per service

| Layer | Approach |
|---|---|
| HTTP server/client | auto (`@opentelemetry/instrumentation-http`) + manual causal attributes |
| Postgres | auto (`@opentelemetry/instrumentation-pg`); `db.statement` deleted at the Collector |
| Kafka | `packages/kafka` wrappers - **manual**, because auto-instrumentation does not know about `causation_id` |
| Domain operations | manual spans named `<entity>.<action>` (e.g. `inventory.reserve`) |
| Saga steps | manual spans plus span events at each transition |
| Logs | pino + OTel log bridge so `trace_id`/`span_id` are attached automatically |

**Sampling: none at MVP (`AlwaysOnSampler`).** This is a deliberate, documented choice.
Sampling destroys causal chains - a sampled-away producer span orphans its consumer, which is
exactly the failure Causora is meant to detect. The interesting consequence is that this
becomes a post-MVP research question: *at what sampling rate does causal graph completeness
collapse?* See `docs/experiments/research.md`.

## 5. Span naming and attribute conventions

```
http.server.request     "POST /orders"
http.client.request     "POST payment-service /payments/authorize"
messaging.produce       "produce orders.events"
messaging.consume       "consume orders.events"
db.query                "pg.insert reservations"
domain.state_change     "order.status PENDING->FAILED"
```

Follow OTel semantic conventions for `http.*`, `messaging.*` and `db.*`. Everything Causora
adds lives under the `causora.*` prefix so the telemetry remains a valid, portable OTLP
stream - it is readable by Jaeger, Tempo or anything else, with Causora's additions as extra
attributes. Causora is an additive consumer of standard telemetry, not a proprietary format.
That is the correct position and should be stated in the README.

## 6. Causora's own telemetry

Causora instruments itself and exports to **topic `causora.self`**, which the pipeline never
reads. A small `scripts/self-metrics.ts` prints ingestion rate, derivation latency and queue
depth for the benchmarking milestone.

Keeping self-telemetry out of the graph is not just hygiene: feeding it in would create
unbounded feedback, since analysing an event produces events. Stating that clearly in the
docs demonstrates that the recursion was considered rather than stumbled into.
