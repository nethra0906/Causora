# The Causal Graph - node and edge model

The heart of Causora. This document defines what the graph *is*; `causality-algorithm.md`
defines how it is built.

---

## 1. Nodes

A node is a **normalised event** (see `event-model.md`). One row in `events`, one node.

Node categories as rendered:

| Category | Source | Shape in UI |
|---|---|---|
| Operation | span | rounded rectangle, width proportional to duration |
| Signal | span_event, error log | small diamond |
| Fault | fault injector | red hexagon with a flask badge |
| Cluster | synthesised | dashed container holding its members |

**Synthesised nodes** are created only by the analysis phase, are always marked
`evidence_source = causora_analysis`, and always carry the member `event_id`s in their
attributes. They are a presentation and ranking convenience - never a claim that an extra
thing happened.

---

## 2. Edge types

An edge is a directed, typed, evidenced assertion that information flowed from one event to
another. Edges live in the `edges` table, unique on `(from_event_id, to_event_id, type)`.

### 2.1 The taxonomy

| Type | Detection | Class | Deterministic | Confidence | In traversal |
|---|---|---|---|---|---|
| `PARENT_OF` | `b.parent_span_id == a.span_id` | Proven | yes | 1.00 | yes |
| `TRIGGERED` | `b.causation_id == a.event_id` | Proven | yes | 1.00 | yes |
| `RETRY_OF` | `b.retry_of_event_id == a.event_id` | Proven | yes | 1.00 | yes |
| `TIMED_OUT_WAITING_FOR` | `b.awaited_correlation_id == a.event_id`, `b.event_type == timeout.fired` | Proven | yes | 1.00 | yes |
| `FAULT_AFFECTED` | `a.source == fault`, `b.experiment_id == a.experiment_id`, b within the fault window and on the targeted service+operation | Proven | yes | 1.00 | yes (eval only) |
| `DUPLICATE_OF` | same `idempotency_key`, distinct `event_id`, both mutating, intervals overlap or are within `retry_window_ms`, distinct resource ids produced | Derived | yes | 0.90 | yes |
| `SAME_BUSINESS_OP` | shared `business_operation_id` | Derived (grouping) | yes | n/a | **no** - scoping only |
| `LIKELY_TRIGGERED` | `causation_id` absent; matched by `(topic, message key, offset ordering)` and `produced_at` within window | Inferred | no | 0.45–0.75, computed | yes, weighted |
| `LIKELY_RETRY_OF` | `retry_of_event_id` absent; same operation + same `idempotency_key` + increasing `attempt_number` | Inferred | no | 0.60 | yes, weighted |
| `TEMPORAL_PROXIMITY` | same service, within `proximity_window_ms`, no other path exists | Weak | no | 0.10 | **no - never** |

### 2.2 Evidence classes and what they are allowed to do

| Class | Meaning | Allowed in ancestor traversal | Allowed to contribute to ranking | Default visibility |
|---|---|---|---|---|
| **Proven** | A field in the telemetry states the relationship. No judgement applied. | yes, weight 1.0 | yes | on |
| **Derived** | A deterministic rule over proven facts. The rule could be wrong about *meaning*, never about the *facts*. | yes, weight 0.9 | yes | on |
| **Inferred** | A scored heuristic used only where a contract field is missing. | yes, weight = computed confidence | yes, capped at 0.75 | on, visually distinct |
| **Weak** | Co-occurrence only. | **no** | **no** | off by default |

The cap on inferred edges is a hard constant in code (`MAX_INFERRED_CONFIDENCE = 0.75`) so
that **no chain of inferences can ever outrank a proven chain.** A unit test asserts this
property directly.

`FAULT_AFFECTED` edges are a special case: they are proven, but because the fault is the
thing being evaluated, they are **excluded from the ranking traversal** and included only
when the graph is requested in `mode=ground_truth` (used by the evaluation harness and the
UI's "reveal answer" toggle). Keeping them out of the default path is the same integrity
rule as `is_fault_injected`.

### 2.3 Edge record

```ts
CausalEdge {
  from_event_id:   string
  to_event_id:     string
  type:            EdgeType
  evidence_class:  "proven" | "derived" | "inferred" | "weak"
  confidence:      number        // [0,1], DECLARED by class, not learned
  derived_by_rule: string        // e.g. "rule.triggered.causation_id@v1"
  evidence:        {
    matched_fields: Array<{ field: string, from_value: string, to_value: string }>
    notes?:         string
    window_ms?:     number
    clock_uncertainty_ms?: number
  }
  created_at:      timestamptz
}
```

`derived_by_rule` is mandatory and versioned. Every edge in the UI can answer *which rule
created you, and on what grounds* - and when a rule changes, old edges remain attributable.

### 2.4 On the word "confidence"

These numbers are **declared weights reflecting evidence class**, not calibrated
probabilities. Causora has no training data and makes no probabilistic claim. The UI must
therefore render them as labels, not percentages:

| Confidence | Label shown |
|---|---|
| 1.00 | **Proven** |
| 0.85–0.99 | **Derived** |
| 0.50–0.84 | **Inferred** |
| below 0.50 | **Speculative** |

Writing "87% likely" would be a lie. Writing "Derived - same idempotency key, overlapping
intervals" is true and more useful. This is a documented product decision:
[ADR-0006](../../DECISIONS.md#adr-0006).

---

## 3. Graph shape and structural handling

### 3.1 It is a DAG - mostly

Proven edges always point forward in logical time, so the proven subgraph is acyclic by
construction. Two things can introduce apparent cycles:

1. **`DUPLICATE_OF` symmetry.** Attempt 1 and attempt 2 are duplicates of each other. Fixed
   by canonicalisation: the edge always points from the **earlier-starting** attempt to the
   later one, tie-broken by `event_id` lexical order. Deterministic, documented, tested.
2. **Inferred edges.** A bad heuristic can close a loop. Handled by running Tarjan's SCC
   algorithm before traversal; any SCC of size > 1 is collapsed into a `cluster.*`
   supernode for ranking purposes, with the internal edges preserved for display.

Both must be tested with explicit cyclic fixtures. "It is a DAG so cycles cannot happen" is
the kind of assumption that produces an infinite loop in a demo.

### 3.2 Concurrency

Events with no directed path between them are **concurrent**. The UI must represent this
honestly - parallel lanes, not a false vertical order. In the primary scenario, attempt 1
and attempt 2 of the reservation are genuinely concurrent, and showing that is the whole
insight. A timeline that implied attempt 1 finished before attempt 2 started would be wrong.

### 3.3 Clusters

| Cluster | Formed when | Why |
|---|---|---|
| `cluster.retry_chain` | 2+ events linked by `RETRY_OF` / `LIKELY_RETRY_OF` | A retry storm is one phenomenon, not 200 nodes |
| `cluster.duplicate_work` | 2+ events linked by `DUPLICATE_OF` | Duplicate work is the finding; the members are the evidence |
| SCC collapse | Tarjan finds a cycle | Keeps traversal terminating |

Clustering happens at **analysis time, not ingest time**, so the raw graph is never
destroyed and clustering parameters can change without re-ingesting.

### 3.4 Bounds

| Bound | Default | Why |
|---|---|---|
| `MAX_TRAVERSAL_DEPTH` | 12 | Deeper than any realistic saga; prevents runaway |
| `MAX_SUBGRAPH_NODES` | 5,000 | Protects the analysis worker and the browser |
| `MAX_UI_NODES` | 800 | Above this, the UI renders clusters collapsed by default |
| `retry_window_ms` | 30,000 | Duplicate-detection window |
| `proximity_window_ms` | 100 | Weak edges only |

When a bound truncates a subgraph the investigation records `truncated: true` plus the
reason, and the UI says so. Silent truncation in a debugging tool is a correctness bug.

---

## 4. Worked example - the primary scenario graph

```
            [fault.injected: inventory.handler.delay 5000ms]
                       |
                       | FAULT_AFFECTED (proven, eval-only, hidden by default)
                       v
 [order.created #1] --TRIGGERED--> [inventory.reserve #1  5.04s  <-- 63x baseline]
         |                                      |
         |                                      | TIMED_OUT_WAITING_FOR
         |                                      v
         |                         [timeout.fired  awaited=#1]
         |                                      |
         |                                      | RETRY_OF
         |                                      v
         |                              [order.created #2]
         |                                      |
         |                                      | TRIGGERED
         |                                      v
         |                         [inventory.reserve #2  5.01s]
         |                                      ^
         +---- (concurrent, no path) -----------+
                                                |
         [inventory.reserve #1] --DUPLICATE_OF--+   (derived: same idempotency_key K,
                                                     overlapping intervals,
                                                     distinct reservation_ids R1 R2)
                                                |
                           +--------------------+
                           | TRIGGERED
                           v
                 [payment.authorize  status=ERROR
                  RESERVATION_AMOUNT_MISMATCH]
                           |
                           | PARENT_OF
                           v
                 [order.failed  reason=PAYMENT_FAILED]   <-- the failure the user reports
```

Reading the graph backwards from the failure gives the propagation frontier at
`inventory.reserve #1` - the first anomalous node with no anomalous ancestor. That is the
answer, and it is reached without the fault edge, which is exactly what makes the evaluation
meaningful.
