# The Causality Algorithm - building the graph

> **Build status - blueprint document.** Implemented in `src/platform/{normalise,rules}.ts` as pure functions, with rule ids defined in `src/contracts`. Differences: there is no raw-telemetry table or correlation index; derivation re-runs per business operation on every batch (idempotent, handles late arrivals). `LIKELY_RETRY_OF` additionally requires a deadline firing in the same service, and an orphan-event inference branch exists for timer-driven spans.

How telemetry becomes a causal graph. Seven phases, each independently testable.

```
OTLP in
  |
  (1) INGEST          durable, idempotent, replayable
  |
  (2) NORMALISE       pure function, OTLP -> NormalisedEvent[]
  |
  (3) CORRELATE       build the key index
  |
  (4) DERIVE EDGES    independent rules, each attributable
  |
  (5) RESOLVE         handle out-of-order / late arrivals
  |
  (6) DETECT          failures, patterns, baselines
  |
  (7) ASSESS          completeness / provisionality
  |
Graph ready for investigation
```

---

## 1. Phase 1 - Ingest

**Where:** `platform/api/src/ingest`

```
POST /v1/traces   (OTLP/HTTP protobuf or JSON)
POST /v1/logs

1. Enforce body size cap (default 4 MB) and auth token.
2. Write the whole envelope to raw_telemetry:
     (envelope_id, received_at, kind, payload jsonb, status='pending')
   -> this is what makes replay possible without re-running the demo.
3. Extract event ids cheaply (no full normalisation) and publish one Kafka
   message per envelope to topic `causora.ingest`:
     { envelope_id }
4. Return 202 immediately.
```

**Why Kafka between API and worker.** Three concrete reasons, not fashion:

1. **Backpressure.** A burst from a retry storm must not block the collector or the API.
2. **Replay.** Re-processing a captured failure is `UPDATE raw_telemetry SET status='pending'`
   followed by re-enqueue. During development you will do this dozens of times a day; it is
   the difference between a 3-second iteration loop and a 90-second one.
3. **At-least-once semantics force idempotency**, which is the correctness property Causora
   diagnoses in others and must therefore demonstrate itself.

**Idempotency.** The consumer may see an envelope twice. Phase 2 writes events with
`ON CONFLICT (event_id) DO NOTHING`; phase 4 writes edges with
`ON CONFLICT (from_event_id, to_event_id, type) DO NOTHING`. Both are therefore safe to
re-run any number of times. Offsets are committed only after the database transaction
commits - at-least-once, never at-most-once.

**Causora's own telemetry** goes to topic `causora.self` and is never fed into the graph.
Otherwise the tool diagnoses itself diagnosing itself, which is funny exactly once.

---

## 2. Phase 2 - Normalise

**Where:** `platform/worker/src/normalise` - **a pure function with no I/O.**

```ts
normalise(envelope: OtlpEnvelope): { events: NormalisedEvent[], rejected: RejectionRecord[] }
```

Rules are tabulated in `event-model.md` §6. Implementation requirements:

- No database access, no clock reads except a single injected `now` parameter, no randomness.
  `event_id` for span events is a **hash of stable inputs**, never a random UUID, so
  re-ingest produces identical ids.
- Unit-tested against committed OTLP fixtures in `platform/worker/test/fixtures/otlp/`,
  captured from real runs via a collector file exporter. Fixture-driven, not hand-written -
  hand-written OTLP diverges from reality.
- Contract violations recorded, not thrown.

---

## 3. Phase 3 - Correlate

**Where:** `platform/worker/src/correlate`

Correlation is not edge creation; it is building the index that makes edge creation an
indexed lookup instead of a scan.

For each event, write rows into `event_correlations (event_id, key_type, key_value)`:

| `key_type` | `key_value` |
|---|---|
| `span` | `span_id` |
| `trace` | `trace_id` |
| `causation` | `causation_id` |
| `business_op` | `business_operation_id` |
| `idempotency` | `idempotency_key` |
| `message` | `message_id` |
| `topic_offset` | `topic:partition:offset` |
| `awaited` | `awaited_correlation_id` |
| `retry_of` | `retry_of_event_id` |

One event produces 3–8 rows. Indexed on `(key_type, key_value)`.

This costs write amplification and buys O(log n) edge derivation. The trade is deliberate and
is documented in [ADR-0009](../../DECISIONS.md#adr-0009). The alternative -
deriving edges from `events` with multi-column indexes - was rejected because each rule would
need its own composite index and adding a rule would require a migration. With the index
table, **a new rule needs no schema change**, which matters a lot for a 4-week build.

Also upsert `business_operations (id, type, status, started_at, ended_at, event_count)` so the
overview screen does not need to aggregate `events` on every page load.

---

## 4. Phase 4 - Derive edges

**Where:** `platform/worker/src/rules/` - the intellectual core.

### 4.1 Rule interface

```ts
interface EdgeRule {
  id: string                    // "rule.triggered.causation_id"
  version: number
  evidenceClass: EvidenceClass
  enabledByDefault: boolean
  /** Pure given the lookup port. No side effects. */
  derive(event: NormalisedEvent, lookup: CorrelationLookup): Promise<CausalEdge[]>
}
```

`CorrelationLookup` is a narrow port (`findByKey`, `findEventsByBusinessOp`,
`findMutationsByIdempotencyKey`) with an in-memory implementation for tests and a Postgres
implementation for production. This means **every rule is unit-testable without a database.**

Rules are registered in `rules/registry.ts` and selected by a `RuleSetConfig`:

```ts
{ ruleSetId: "default", disabled: [] }
{ ruleSetId: "ablation.no_causation", disabled: ["rule.triggered.causation_id"] }
```

**This is why the ablation experiment is nearly free.** Disabling a rule is configuration,
not code. Designing for the experiment on day one rather than bolting it on later is the
single highest-leverage decision in the build order.

### 4.2 The rule set

| Rule id | Emits | Logic |
|---|---|---|
| `rule.parent.span` | `PARENT_OF` | `lookup('span', e.parent_span_id)` → edge parent→e |
| `rule.triggered.causation_id` | `TRIGGERED` | `lookup('span', e.causation_id)` or event-id lookup → edge cause→e |
| `rule.retry.explicit` | `RETRY_OF` | `lookup(e.retry_of_event_id)` → edge original→e |
| `rule.timeout.awaited` | `TIMED_OUT_WAITING_FOR` | for `timeout.fired`, `lookup(e.awaited_correlation_id)` → edge awaited→e |
| `rule.fault.window` | `FAULT_AFFECTED` | for fault events, find events with matching `experiment_id`, service and operation inside `[started_at, ended_at]` |
| `rule.duplicate.idempotency` | `DUPLICATE_OF` | see §4.3 |
| `rule.triggered.inferred` | `LIKELY_TRIGGERED` | see §4.4 |
| `rule.retry.inferred` | `LIKELY_RETRY_OF` | same operation + same `idempotency_key` + `attempt_number` increases + no explicit `retry_of_event_id` |
| `rule.proximity` | `TEMPORAL_PROXIMITY` | disabled by default; same service, within window, no other path |

### 4.3 Duplicate detection (the one rule worth writing out)

```
INPUT  e : a mutating event with an idempotency_key

candidates = lookup('idempotency', e.idempotency_key)
             minus e
             filtered to mutating events on the same service+operation

for each c in candidates:
    # order canonically so the edge direction is deterministic
    (a, b) = (c, e) if c.occurred_at < e.occurred_at
             else (e, c) if e.occurred_at < c.occurred_at
             else sort_by_event_id(c, e)

    overlapping = intervals_overlap(a, b, slack = clock_uncertainty_ms)
    within      = (b.occurred_at - a.occurred_at) <= retry_window_ms
    if not (overlapping or within): continue

    # distinct effects are what make it a DUPLICATE rather than a suppressed retry
    a_ids = a.resource_ids ; b_ids = b.resource_ids
    if a_ids and b_ids and disjoint(a_ids, b_ids):
        emit DUPLICATE_OF a -> b
             confidence 0.90
             evidence: idempotency_key, both resource id sets, overlap ms
    elif a_ids and b_ids and a_ids == b_ids:
        skip   # same effect: the guard worked, this is a correct retry
    else:
        emit DUPLICATE_OF a -> b
             confidence 0.70     # lower: effects unknown
             evidence: idempotency_key, overlap ms, note "resource ids unavailable"
```

Note what this rule does **not** do: it never calls two operations duplicates merely because
they happened close together. The idempotency key is load-bearing, and the distinction
between "same effect" (guard worked) and "different effects" (guard failed) is the actual
finding. Without `resource_ids` the confidence drops and the evidence says why.

### 4.4 Inferred producer→consumer (the ablation fallback)

Used only when `causation_id` is absent on a `messaging.consume` event.

```
candidates = lookup('topic_offset', "{topic}:{partition}:{offset}")      # strongest
if candidates: emit LIKELY_TRIGGERED, confidence 0.75
               evidence: exact topic/partition/offset match
               # 0.75 because the broker coordinates agree, but no value
               # actually flowed from producer to consumer that we can see

else:
candidates = produce events on the same topic, same message key,
             with produced_at in [e.occurred_at - max_dwell, e.occurred_at]
             widened by clock_uncertainty_ms

confidence = 0.65  if exactly one candidate
             0.45  if 2-5 candidates   (ambiguous; emit all, flag ambiguity)
             skip   if more than 5     (too ambiguous to be useful; record a
                                        completeness gap instead of guessing)
```

**Declining to guess is a feature.** A tool that emits a wrong edge is worse than one that
says "I cannot prove this hop - `causation_id` was missing on 14 events."

### 4.5 Execution

For each new event: run all enabled rules, collect edges, bulk-insert with
`ON CONFLICT DO NOTHING`. Rules run in parallel (`Promise.all`) because each is independent
and read-only. Edge writes are one transaction per event, so a rule failure cannot leave a
partial edge set.

Complexity: `O(E × R × log N)` where E = events, R = rules (~9), N = index size. At design
budget 2,000 events/s that is ~18,000 indexed lookups/s, which Postgres handles comfortably
with prepared statements and a connection pool.

---

## 5. Phase 5 - Out-of-order and late arrival

Telemetry does not arrive in causal order. A consumer span routinely arrives before the
producer span it references. Two strategies:

**MVP: incremental re-derivation per business operation.**

```
on new event e:
  derive edges for e now (some will find nothing)
  mark business_operations[e.business_operation_id].dirty = true

every 500 ms, for each dirty business operation (bounded batch of 50):
  re-run derivation for all events in that operation
  clear dirty
```

Idempotent writes make re-derivation free of side effects. Bounded by business operation, so
cost is proportional to saga size (tens of events), not to total event count. Simple, correct,
and roughly 60 lines of code.

**Post-MVP: pending-edge resolution.** When a rule references a missing `event_id`, write
`pending_edges (missing_event_id, source_event_id, rule_id)`. On ingest of an event, look up
`pending_edges` by its id and resolve. O(1) amortised instead of periodic re-derivation -
the right answer at scale, and unnecessary at MVP scale. Documented in
[ADR-0010](../../DECISIONS.md#adr-0010) so the choice is visible rather than
accidental.

**Missing telemetry entirely.** If a span is sampled away or a service is not instrumented,
the gap is real and unrecoverable. Causora records it explicitly: when a `business_operation`
has events on services A and C but a known dependency A→C passes through B with no events,
the completeness assessment reports `missing_hop: B`. The UI draws a dashed gap node labelled
"no telemetry". Showing the hole is the honest response; silently connecting A to C is not.

---

## 6. Phase 6 - Detect

### 6.1 Failure detection

An event is a **failure** when `status ∈ {ERROR, TIMEOUT}` **and** it is the outermost such
event in its business operation (no ancestor already ERROR via proven edges). This makes one
user-visible failure produce one `failures` row, not one per affected span. Rows are upserted
on `(business_operation_id, event_id)`.

### 6.2 Baselines

`operation_baselines (service, operation, p50_ms, p95_ms, p99_ms, error_rate, sample_count,
window_start, window_end)`, recomputed every 60 s over the trailing window from events whose
business operation **succeeded** - healthy traffic only. Without this, "abnormally slow" has
no meaning and anomaly detection is hand-waving. A `scripts/seed-baseline.ts` run generates
200 healthy orders so baselines exist before the first failure demo; the bootstrap problem is
real and must be scripted, not improvised during a demo.

### 6.3 Pattern detection

Patterns are rules over the subgraph, each emitting a `patterns_detected` row with evidence.

| Pattern | Condition | Evidence |
|---|---|---|
| `RETRY_STORM` | retry chain length ≥ 3, or ≥ 10 retries on one operation inside 60 s | chain members, interval |
| `DUPLICATE_WORK` | ≥ 1 `DUPLICATE_OF` edge with disjoint resource ids | member events, resource ids |
| `TIMEOUT_CASCADE` | ≥ 2 `timeout.fired` events on a single proven path | the path |
| `SLOW_CONSUMER` | `dwell_ms` > 10× the operation's p95, or consumer lag above threshold | dwell, baseline, clock uncertainty |
| `ERROR_AMPLIFICATION` | one error node has ≥ 3 error descendants | fan-out count |
| `IDEMPOTENCY_FAILURE` | `idempotency.miss` on an event whose `attempt_number` > 1 | the miss event, attempt numbers |

`IDEMPOTENCY_FAILURE` is the pattern that names the primary scenario's real bug. When the
graph, the patterns and the ranking all independently point at the same operation, the
investigation is persuasive in a way a single score never is.

---

## 7. Phase 7 - Completeness assessment

Before an investigation is served, compute:

```ts
Completeness {
  events_total:            number
  contract_violation_count: number
  violated_fields:         Record<string, number>   // "causation_id" -> 14
  open_intervals:          number     // spans with start and no end
  missing_hops:            string[]   // services expected but silent
  quiet_for_ms:            number     // now - max(ingested_at) for this business op
  truncated:               boolean
  verdict: "COMPLETE" | "PROVISIONAL" | "DEGRADED"
}
```

| Verdict | When | UI |
|---|---|---|
| `COMPLETE` | `quiet_for_ms > QUIET_PERIOD` (2 s), no open intervals, no missing hops, no violations | green |
| `PROVISIONAL` | still receiving events, or open intervals remain | amber, "still arriving - results may change" |
| `DEGRADED` | contract violations or missing hops present | red, lists exactly which fields were missing on how many events |

A result computed on incomplete data **must say so**. This is where most observability tools
quietly mislead, and where Causora's whole position obliges it to do better.
