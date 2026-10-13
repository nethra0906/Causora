# Failure Analysis - the investigation algorithm

> **Build status - blueprint document.** Implemented in `src/platform/analysis.ts`. Differences from this text: scope traversal is bounded in memory (not a recursive CTE); latency is **self-time** (duration minus child spans); a caller's error or timeout is **attributed to its callee** (`http.client.request` and `timeout.fired` carry no error signal of their own, and an error that bubbled up from a failing child is discounted); ranking lists frontier candidates first, then downstream effects; completeness has three states with explicit reasons; a latency noise floor (`minLatencyAnomalyMs`, 250 ms; ADR-0019) means self-times below it are not evidence; the ablation is evaluated on the same stored events.

Given a failure event, produce a ranked list of candidate origins with evidence. Eight
stages. **Nothing here is machine learning and nothing here is causal inference** - it is a
declared, inspectable heuristic over a graph whose edges are mostly proven.

```
failure_event_id
  |
  (1) SCOPE          reverse-reachable ancestor subgraph, bounded
  (2) BASELINE       attach healthy-traffic statistics per operation
  (3) SCORE          per-node anomaly score
  (4) FRONTIER       find anomalous nodes with no anomalous ancestor
  (5) PATTERNS       match the pattern library over the subgraph
  (6) RANK           declared weighted score over frontier candidates
  (7) EVIDENCE       assemble the path and the facts for each candidate
  (8) LABEL          qualitative confidence, never a fake percentage
  |
Investigation record
```

Runs in `platform/worker` as a job, not in the API process. CPU-bound graph work must not
share an event loop with ingestion.

---

## 1. Stage 1 - Scope

Reverse-reachability from the failure over **traversable** edges (proven, derived, inferred -
never weak, never `FAULT_AFFECTED` unless `mode=ground_truth`).

```sql
WITH RECURSIVE ancestors(event_id, depth, path_confidence, path) AS (
    SELECT $1::text, 0, 1.0::numeric, ARRAY[$1::text]
  UNION ALL
    SELECT e.from_event_id,
           a.depth + 1,
           a.path_confidence * e.confidence,
           a.path || e.from_event_id
    FROM edges e
    JOIN ancestors a ON e.to_event_id = a.event_id
    WHERE a.depth < $2                            -- MAX_TRAVERSAL_DEPTH
      AND e.evidence_class <> 'weak'
      AND ($3 OR e.type <> 'FAULT_AFFECTED')      -- ground-truth mode flag
      AND NOT e.from_event_id = ANY(a.path)       -- cycle guard
      AND a.path_confidence * e.confidence >= $4  -- MIN_PATH_CONFIDENCE, default 0.2
)
SELECT event_id, MIN(depth) AS depth, MAX(path_confidence) AS best_path_confidence
FROM ancestors GROUP BY event_id
LIMIT $5;                                         -- MAX_SUBGRAPH_NODES
```

Three things worth noting:

- **`NOT from_event_id = ANY(path)`** is the cycle guard. Without it, an inferred edge that
  closes a loop makes this query run until the connection dies. Tarjan collapse (see
  `causal-graph.md` §3.1) runs first, but the guard is kept as defence in depth.
- **`path_confidence` is multiplicative**, so a long chain of inferences decays. Three
  inferred hops at 0.75 give 0.42 - below a single proven chain, which is the intended
  ordering. `MIN_PATH_CONFIDENCE` prunes paths that have decayed into noise.
- If the `LIMIT` is hit, `truncated = true` is recorded and surfaced.

Recursive CTE rather than a graph database:
[ADR-0003](../../DECISIONS.md#adr-0003). At 2,000 nodes this is a few
milliseconds; the Neo4j comparison is a post-MVP benchmark, not an assumption.

---

## 2. Stage 2 - Baseline attachment

For each distinct `(service, operation)` in the subgraph, join `operation_baselines`.
Nodes whose operation has `sample_count < MIN_BASELINE_SAMPLES` (default 20) are marked
`baseline_unavailable` and **cannot be scored on latency** - they can still be candidates via
error status, but the evidence says "no baseline available". Scoring an operation against
three samples would be a fabricated statistic.

---

## 3. Stage 3 - Per-node anomaly score

Five signals, each in [0,1], combined with declared weights.

```
latency_anomaly:
    if baseline_unavailable or duration_ms is null: 0
    else:
        spread = max(p95 - p50, MIN_SPREAD_MS)        # MIN_SPREAD_MS = 5
        z      = (duration_ms - p95) / spread
        clamp(z / Z_SATURATION, 0, 1)                  # Z_SATURATION = 10

error_signal:
    1.0 if status in (ERROR, TIMEOUT) else 0

error_rate_anomaly:
    if baseline_unavailable: 0
    else clamp((observed_op_error_rate - baseline_error_rate) / 0.5, 0, 1)

retry_density:
    clamp(retry_descendants(node) / RETRY_SATURATION, 0, 1)   # RETRY_SATURATION = 5

dwell_anomaly:
    if dwell_ms is null or baseline_unavailable: 0
    else clamp((dwell_ms / max(p95, 1)) / DWELL_SATURATION, 0, 1)  # DWELL_SATURATION = 10
    # carries clock_uncertainty_ms in its evidence because dwell crosses two clocks

anomaly = 0.40*latency_anomaly
        + 0.25*error_signal
        + 0.15*error_rate_anomaly
        + 0.10*retry_density
        + 0.10*dwell_anomaly
```

A node is **anomalous** when `anomaly >= ANOMALY_THRESHOLD` (default 0.35).

Every constant above lives in one config object, is snapshotted into the investigation record
(`config_snapshot`), and appears in the UI's "scoring details" panel. An investigation whose
weights cannot be inspected is not reproducible, and reproducibility is the point.

**Not in this list, deliberately:** `is_fault_injected` and `experiment_id`. The scorer
receives `RankableEvent`, which structurally omits them. See `event-model.md` §3 integrity rule.

---

## 4. Stage 4 - Frontier identification

This stage is what makes Causora find *origins* rather than *symptoms*.

```
anomalous = { n in subgraph : anomaly(n) >= ANOMALY_THRESHOLD }

frontier  = { n in anomalous :
                no ancestor m of n (over traversable edges) has anomaly(m) >= THRESHOLD }
```

A failure propagates: the payment error, the order failure and the timeout are all anomalous,
but each has an anomalous ancestor. The slow reservation does not. It is the frontier, and it
is the answer.

Implementation: a single reverse topological pass over the already-materialised subgraph,
memoising `has_anomalous_ancestor`. O(V + E). Must handle the collapsed-SCC supernodes, whose
anomaly score is the **max** over members.

Fallback: if `frontier` is empty (every anomalous node has an anomalous ancestor - possible
with a cycle or a fully-degraded graph), fall back to the anomalous nodes of greatest depth
and record `frontier_fallback: true` in the investigation. Never return an empty result
without explaining why.

---

## 5. Stage 5 - Pattern matching

Run the pattern library (`causality-algorithm.md` §6.3) over the subgraph. Each match yields:

```ts
PatternMatch { pattern: string, member_event_ids: string[], evidence: object, bonus: number }
```

| Pattern | Bonus to members |
|---|---|
| `IDEMPOTENCY_FAILURE` | 0.20 |
| `DUPLICATE_WORK` | 0.15 |
| `SLOW_CONSUMER` | 0.15 |
| `RETRY_STORM` | 0.10 |
| `TIMEOUT_CASCADE` | 0.10 |
| `ERROR_AMPLIFICATION` | 0.05 |

Bonuses apply to the pattern's **causally earliest** member, not to all members - otherwise a
retry storm would promote all 200 of its retries over the one slow operation that caused it.
This detail matters and is easy to get wrong.

---

## 6. Stage 6 - Ranking

```
score(candidate) =
      W_ANOMALY   * anomaly(candidate)                   # 0.45
    + W_PROXIMITY * (1 / (1 + depth_from_failure))       # 0.15
    + W_PATH      * best_path_confidence(candidate)      # 0.25
    + W_PATTERN   * pattern_bonus(candidate)             # 0.15

Ties broken by: (a) greater depth from the failure (prefer the more upstream cause),
                (b) earlier occurred_at,
                (c) event_id lexical  -- so results are fully deterministic
```

Note the deliberate tension between `W_PROXIMITY` (prefer nearby) and the tie-break (prefer
upstream). Proximity is a weak prior that short chains are more likely to be the relevant
explanation; the tie-break resolves genuine ties toward the origin. Both are declared, both
are tunable, and the evaluation harness is what justifies whichever weights ship.

**Deterministic by construction.** Same inputs, same config → byte-identical candidate list.
A property test asserts this over shuffled input orderings. A debugging tool that returns
different answers on re-run cannot be trusted and cannot be evaluated.

### What this is and is not

| It is | It is not |
|---|---|
| A declared weighted heuristic over a mostly-proven graph | Causal inference |
| Reproducible and inspectable | Learned, trained or probabilistic |
| Evaluated against injector ground truth | Validated against production incidents |
| A ranking of candidates | A statement of fact |

The UI never says "root cause". It says **"most likely origin of the failure chain"** and
shows the evidence. Every candidate is presented as a hypothesis with support.

---

## 7. Stage 7 - Evidence assembly

For each candidate, the evidence bundle is the product. The score is just the sort order.

```ts
CandidateEvidence {
  candidate_event_id: string
  path_to_failure: Array<{
    from_event_id: string
    to_event_id:   string
    type:          EdgeType
    evidence_class: EvidenceClass
    confidence:    number
    derived_by_rule: string
    matched_fields: Array<{ field, from_value, to_value }>   // the actual values
  }>
  anomaly_breakdown: {
    latency:    { duration_ms, baseline_p50, baseline_p95, z, contribution }
    error:      { status, error_type, contribution }
    error_rate: { observed, baseline, contribution }
    retries:    { descendant_retry_count, contribution }
    dwell:      { dwell_ms, baseline_p95, clock_uncertainty_ms, contribution }
  }
  patterns: PatternMatch[]
  concurrent_with: string[]       // events with no causal path either way
  caveats: string[]               // "baseline unavailable", "2 inferred hops in path",
                                  // "subgraph truncated at 5000 nodes",
                                  // "causation_id missing on 14 events"
}
```

`caveats` is mandatory and must be rendered prominently. It is the mechanism by which the
tool declines to overstate itself.

`matched_fields` carries the **actual values** that matched - `causation_id =
7f3a9b...` on both sides. An engineer can verify the claim without trusting Causora. That
verifiability is worth more than any score.

---

## 8. Stage 8 - Confidence labelling

A single qualitative label per candidate, derived from the evidence, never a percentage.

| Label | Conditions |
|---|---|
| **STRONG** | All path edges proven or derived; candidate is in the frontier; ≥ 1 pattern matched; baseline available; completeness `COMPLETE` |
| **SUPPORTED** | All path edges proven or derived; candidate in frontier; baseline available |
| **WEAK** | Path contains ≥ 1 inferred edge, or baseline unavailable, or completeness `PROVISIONAL` |
| **SPECULATIVE** | `path_confidence < 0.5`, or completeness `DEGRADED`, or `frontier_fallback` was used |

Rules, not thresholds on the score. The score orders candidates; the label describes the
quality of the evidence. Those are different questions and conflating them is how
observability tools end up claiming 94% confidence in nonsense.

---

## 9. The investigation record

```ts
Investigation {
  id:                 string
  failure_event_id:   string
  business_operation_id: string
  status:             "RUNNING" | "COMPLETE" | "FAILED"
  completeness:       Completeness
  subgraph_node_count: number
  subgraph_edge_count: number
  truncated:          boolean
  frontier_fallback:  boolean
  candidates:         Array<{ rank, event_id, score, label, evidence: CandidateEvidence }>
  patterns:           PatternMatch[]
  config_snapshot:    AnalysisConfig      // every weight and threshold used
  rule_set_id:        string              // which rules were enabled
  duration_ms:        number
  created_at:         timestamptz
}
```

`config_snapshot` + `rule_set_id` make every investigation reproducible months later, and
make the ablation study a matter of comparing two records rather than re-deriving history.

Investigations are **cached and immutable**. Re-running against newer telemetry creates a new
investigation and links `supersedes`. The UI shows "newer telemetry is available - re-run"
rather than silently changing a result the engineer is reading. Mutating a conclusion under
someone mid-debug is a usability failure.
