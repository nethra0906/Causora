# Event Model & the Causal Metadata Contract

**This is the most important document in the project.** The causal metadata contract is what
makes Causora's claims defensible. Read it before writing any instrumentation code.

---

## 1. Why an *event* and not a *span*

Options for the unit of analysis:

| Candidate | Problem |
|---|---|
| Span | Cannot represent things that are not operations: a message dwelling in a topic, an injector action, a watchdog firing. Also tied to one trace. |
| Operation (service + name) | Loses per-occurrence identity, which retries and duplicates absolutely require. |
| Business action | Too coarse; one business action contains the whole failure chain. |
| **Normalised event** | Chosen. |

A **normalised event** is *one occurrence of one unit of work or one significant
observation*, with optional duration. A span maps to exactly one event with a duration. A
span event, an error log, a fault injection and a synthesised cluster each map to an event
with duration zero (or a derived interval).

The decision and its consequences: [ADR-0004](../../DECISIONS.md#adr-0004).

Trade-off accepted: an event carries both a point-in-time semantic (`occurred_at`) and an
interval semantic (`started_at`/`ended_at`). This is slightly impure, but the alternative -
two node types - doubles the graph model's complexity for no analytical gain.

---

## 2. The causal metadata contract

This is a contract on the **demo application**, enforced by `packages/kafka` and
`packages/telemetry`, and validated at ingest. It is the thing being ablated in the research
experiment.

### 2.1 Transport: HTTP headers

| Header | Required | Purpose |
|---|---|---|
| `traceparent` | yes | W3C trace context. Gives `trace_id`, parent `span_id`. |
| `tracestate` | optional | W3C vendor state. Passed through untouched. |
| `x-causora-business-operation-id` | yes | The saga/order identity that joins work across traces. |
| `x-causora-causation-id` | yes | `event_id` of the event that directly caused this request. |
| `x-causora-idempotency-key` | on mutations | Stable key identifying the logical intent. |
| `x-causora-attempt` | yes | Attempt number, starting at 1. |
| `x-causora-deadline-ms` | yes | Remaining budget; enables timeout propagation. |

### 2.2 Transport: Kafka headers

| Header | Required | Purpose |
|---|---|---|
| `traceparent` | yes | Links consumer span to producer span across the broker. |
| `causora-event-id` | yes | Unique id of *this* message as an event. |
| `causora-causation-id` | yes | `event_id` of what caused this message to be produced. **The ablation target.** |
| `causora-business-operation-id` | yes | Saga identity. |
| `causora-idempotency-key` | on mutations | Duplicate detection. |
| `causora-attempt` | yes | Attempt number. |
| `causora-retry-of-event-id` | when attempt > 1 | Makes the retry relationship provable. |
| `causora-produced-at` | yes | Producer wall clock at publish, for dwell-time estimation. |
| `causora-schema-version` | yes | Event payload schema version. |

### 2.3 Span attributes (the Causora namespace)

Every span emitted by a demo service carries these as OTel attributes, mirroring the
transport headers. This is how the metadata reaches Causora - through the ordinary OTLP
pipeline, with no side channel.

| Attribute | Required | Derivation |
|---|---|---|
| `causora.event_id` | yes | For spans: equals `span_id`. For emitted messages: a UUIDv7. |
| `causora.event_type` | yes | Enum, see §4. |
| `causora.business_operation_id` | yes | From context. |
| `causora.causation_id` | yes on consumers and downstream calls | From the inbound header. |
| `causora.idempotency_key` | on mutations | From context. |
| `causora.attempt_number` | yes | From context, default 1. |
| `causora.retry_of_event_id` | when attempt > 1 | Set by the retry initiator. |
| `causora.awaited_correlation_id` | on timeout events | The `event_id` whose response never arrived. |
| `causora.message_id` / `topic` / `partition` / `offset` | on produce and consume spans | From broker metadata. |
| `causora.produced_at` | on consume spans | From the inbound `causora-produced-at` header. |
| `causora.experiment_id` | when a fault is active | From the fault controller. |
| `causora.resource_ids` | optional | Domain identifiers touched, e.g. `reservation_id`, `sku`. |

Rule enforced in code: **a span that crosses a service boundary without
`causora.business_operation_id` and `causora.causation_id` is a contract violation**, counted
in a metric and surfaced in the UI as a completeness warning. Visible violations are far more
useful than silent ones.

---

## 3. The normalised event

The canonical Zod schema lives in `packages/contracts/src/event.ts`. Specified here.

```ts
NormalisedEvent {
  // ---------- identity ----------
  event_id:            string    // REQUIRED, globally unique, stable across re-ingest
  event_type:          EventType // REQUIRED, enum (see section 4)
  source:              EventSource // REQUIRED: span | span_event | log | fault | synthesised

  // ---------- origin ----------
  service:             string    // REQUIRED
  service_instance_id: string?   // OPTIONAL, distinguishes replicas
  operation:           string    // REQUIRED, e.g. "consume orders.events" / "POST /orders"

  // ---------- time ----------
  occurred_at:         timestamptz // REQUIRED, event clock (point or interval start)
  ended_at:            timestamptz?// OPTIONAL, interval end for spans
  duration_ms:         number?     // DERIVED from ended_at - occurred_at
  ingested_at:         timestamptz // DERIVED, Causora clock, set at ingest
  clock_source:        string      // REQUIRED, the reporting service identity

  // ---------- tracing linkage ----------
  trace_id:            string?   // OPTIONAL (absent for fault/synthesised events)
  span_id:             string?   // OPTIONAL
  parent_span_id:      string?   // OPTIONAL

  // ---------- causal linkage (THE CONTRACT) ----------
  business_operation_id: string? // OPTIONAL at the type level, REQUIRED by contract
  causation_id:          string? // OPTIONAL at the type level, REQUIRED by contract on consumers
  idempotency_key:       string? // OPTIONAL, REQUIRED on mutations
  attempt_number:        number  // DEFAULT 1
  retry_of_event_id:     string? // REQUIRED when attempt_number > 1
  awaited_correlation_id: string?// REQUIRED on timeout events

  // ---------- messaging ----------
  message_id:          string?
  topic:               string?
  partition:           number?
  offset:              bigint?
  produced_at:         timestamptz? // producer clock, for dwell estimation
  dwell_ms:            number?      // DERIVED = occurred_at - produced_at, CROSS-CLOCK

  // ---------- outcome ----------
  status:              "OK" | "ERROR" | "TIMEOUT" | "CANCELLED" | "UNKNOWN" // REQUIRED
  error_type:          string?
  error_message:       string?   // redacted at the collector
  error_stack_digest:  string?   // hash, not the stack itself

  // ---------- experiment linkage ----------
  experiment_id:       string?   // present when a fault was active
  is_fault_injected:   boolean   // DERIVED. NEVER an input to ranking. See warning below.

  // ---------- provenance & payload ----------
  evidence_source:     EvidenceSource // REQUIRED: how Causora learned of this event
  attributes:          jsonb     // remaining OTel attributes, redacted
  resource_attributes: jsonb     // OTel resource: sdk, version, host
  schema_version:      number    // REQUIRED
  contract_violations: string[]  // DERIVED, list of missing required contract fields
}
```

### Field categories

**Required** - `event_id`, `event_type`, `source`, `service`, `operation`, `occurred_at`,
`clock_source`, `status`, `evidence_source`, `schema_version`, `attempt_number` (defaulted).
An event missing any of these is rejected at ingest with a 422 and counted; it is never
silently dropped.

**Optional** - tracing and messaging fields, because fault and synthesised events legitimately
have none.

**Contract-required** - `business_operation_id`, `causation_id` (on consumers),
`idempotency_key` (on mutations), `retry_of_event_id` (when retrying). These are optional in
the *type* but required by the *contract*; their absence is recorded in `contract_violations`
rather than rejected. That distinction is deliberate: it lets Causora ingest telemetry from an
imperfectly instrumented service and then tell you exactly what it could not prove. It is also
the mechanism the ablation experiment uses.

**Derived** - `duration_ms`, `ingested_at`, `dwell_ms`, `is_fault_injected`,
`contract_violations`.

### Why each contract field exists

| Field | Without it | With it |
|---|---|---|
| `business_operation_id` | Causality cannot cross trace boundaries; one saga looks like unrelated traces. | A saga is one queryable unit regardless of trace count. |
| `causation_id` | A consumer's work cannot be linked to the specific producer event. Only inference remains. | Producer→consumer causality is **proven**, including across traces and seconds of delay. |
| `idempotency_key` | Duplicate work is indistinguishable from legitimate repeated work. | Duplicates are detected by a deterministic rule, not a guess. |
| `attempt_number` + `retry_of_event_id` | A retry chain looks like N independent operations. | The retry chain is a first-class, collapsible structure. |
| `awaited_correlation_id` | A timeout says *something* was slow, not *what*. | The timeout points at the exact operation that did not respond. |
| `produced_at` | Broker dwell time is invisible, and dwell is the primary symptom of a slow consumer. | Dwell is measurable (with declared cross-clock uncertainty). |
| `experiment_id` | No ground truth; evaluation is impossible. | Hit@k and MRR can be computed. |

### The integrity rule

`is_fault_injected` and `experiment_id` **must never be inputs to anomaly scoring or
candidate ranking.** They exist solely to (a) label ground truth for evaluation and (b) draw
the fault badge in the UI *after* ranking has run.

If the ranker could see them, the evaluation would be circular and the project worthless.
This is enforced three ways:

1. The ranking function takes a `RankableEvent` type that **structurally omits** both fields
   (`Omit<NormalisedEvent, 'is_fault_injected' | 'experiment_id'>`), so leakage is a compile error.
2. A unit test asserts that ranking output is identical for inputs differing only in those fields.
3. A code comment at the projection site explains why, so nobody "helpfully" adds them back.

---

## 4. Event type taxonomy

| `event_type` | Source | Meaning |
|---|---|---|
| `http.server.request` | span | Inbound HTTP handled |
| `http.client.request` | span | Outbound HTTP issued |
| `messaging.produce` | span | Message published |
| `messaging.consume` | span | Message consumed and handled |
| `db.query` | span | Database operation |
| `domain.state_change` | span / log | Business state transition (order PENDING→FAILED) |
| `retry.initiated` | span_event | A retry was started |
| `timeout.fired` | span_event | A deadline elapsed |
| `idempotency.hit` | span_event | A duplicate was correctly suppressed |
| `idempotency.miss` | span_event | The guard did not fire (useful for the race) |
| `error.raised` | span_event / log | An error with trace context |
| `fault.injected` | fault | The injector activated a fault |
| `fault.cleared` | fault | TTL expiry or explicit clear |
| `cluster.duplicate_work` | synthesised | Analysis-time duplicate cluster |
| `cluster.retry_chain` | synthesised | Analysis-time retry cluster |

`EvidenceSource` values: `otlp_span`, `otlp_span_event`, `otlp_log`, `fault_injector`,
`causora_analysis`. Every node in the UI can therefore answer *how do you know this
happened?*

---

## 5. Clock handling

**Rule: wall-clock time never determines a causal relationship.**

| Use of time | Allowed? |
|---|---|
| Display ordering in the timeline | Yes |
| Duration anomaly detection against a baseline | Yes, same-service comparison so one clock |
| Dwell-time estimation (`produced_at` → `occurred_at`) | Yes, but cross-clock: tagged with `clock_uncertainty_ms` |
| Tie-breaking between two otherwise-equal candidates | Yes, and labelled as a tie-break in the evidence |
| Establishing that A caused B | **No.** Only contract fields and the edge DAG do that. |
| Creating an edge from "A was just before B" | **No** for any causal edge; the `TEMPORAL_PROXIMITY` edge type is display-only and excluded from traversal. |

Ordering comes from the edge DAG, which is a genuine happens-before partial order in
Lamport's sense: an edge exists only where a value actually flowed from A to B (a header, a
field, a parentage). Events with no path between them are **concurrent**, and the UI says so
rather than implying an order.

`clock_uncertainty_ms` is a configuration value (default 50 ms in Compose, where all
containers share the host clock) used to widen any time-window comparison. The `clock_offset`
fault scenario shifts one service's clock by 1.5 s specifically to demonstrate that proven
edges are unaffected while dwell estimates degrade and are correctly flagged.

---

## 6. Ingest-time normalisation rules

| Input | Rule |
|---|---|
| OTLP span | → one event. `event_id = span_id`. `occurred_at = startTimeUnixNano`, `ended_at = endTimeUnixNano`. `status` from span status, overridden to `TIMEOUT` if `error_type` matches the timeout set. |
| OTLP span event | → one event only if `event_type` is in the causally-significant set (§4). `event_id = sha256(span_id + name + time)[0:32]` for stability across re-ingest. `parent_span_id = span_id` of the owning span. |
| OTLP log record | → one event only if it has trace context **and** severity ≥ ERROR. Otherwise stored as evidence attached to the owning span, not as a node. Keeps the graph from drowning in INFO logs. |
| Fault injector record | → one event, `trace_id = null`, `evidence_source = fault_injector`. |
| Duplicate `event_id` | `INSERT ... ON CONFLICT (event_id) DO NOTHING`, counter incremented. Required because telemetry delivery is at-least-once. |
| Missing contract field | recorded in `contract_violations`, event still ingested. |
| Unparseable payload | rejected 422, written to `raw_telemetry` with `status = rejected` so it is debuggable. |

Normalisation must be a **pure function** `(OtlpResourceSpans) => NormalisedEvent[]` with no
I/O, so it can be exhaustively unit-tested against recorded OTLP fixtures. This is a hard
requirement, not a preference.
