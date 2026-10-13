# REST API Specification

> **Build status - blueprint document.** The implemented surface is the subset in `src/platform/server.ts`: `POST /v1/spans`; `/api/v1/{health,rulesets,scenarios,baseline,failures,jobs/current}`; `failures/:id/{investigation,investigate}`; `operations/:id/{graph,events}`; `experiments/runs`; `baseline/seed`; `evaluation/{run,latest}`. Errors use RFC 7807 problem details. No auth, no SSE (the UI polls), no rate limiting; the server binds to loopback.

Base: `/api/v1`. All responses JSON. Errors follow RFC 7807 Problem Details.
Request and response schemas are the Zod schemas in `packages/contracts/src/api/`; this
document is the human-readable view of them, and the schemas are authoritative.

---

## 0. Conventions

**Auth.** `Authorization: Bearer <token>`.

| Token | Scope |
|---|---|
| `CAUSORA_READ_TOKEN` | all `GET` endpoints |
| `CAUSORA_WRITE_TOKEN` | investigations |
| `CAUSORA_INGEST_TOKEN` | `/v1/traces`, `/v1/logs` only |
| `CAUSORA_EXPERIMENT_TOKEN` | `/experiments/*` only - separate on purpose |

A single-user project does not need four tokens. It has four because **fault injection must
not be reachable with a read token**, and demonstrating least-privilege separation costs
almost nothing here. See `docs/security.md`.

**Pagination.** Cursor-based, never offset:

```
GET /api/v1/events?limit=50&cursor=eyJvIjoiMjAyNi0xMC0wOFQxMjowMDowMFoiLCJpIjoiZXZ0XzEyMyJ9
→ { "data": [...], "page": { "nextCursor": "...", "hasMore": true } }
```

The cursor is base64 of `{ occurred_at, event_id }`. Offset pagination over an
append-heavy table skips and repeats rows as new events arrive - unacceptable in a tool whose
job is not to mislead.

**Time.** All timestamps RFC 3339 UTC with milliseconds. Range filters are
`from`/`to`, half-open `[from, to)`.

**Error shape.**

```json
{
  "type": "https://causora.dev/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "limit must be <= 200",
  "instance": "/api/v1/events",
  "errors": [{ "path": "query.limit", "message": "must be <= 200" }]
}
```

| Status | Used for |
|---|---|
| 400 | malformed request |
| 401 / 403 | missing token / wrong scope |
| 404 | unknown id |
| 409 | conflicting state (e.g. scenario already running) |
| 422 | validation failure |
| 429 | rate limited (`Retry-After` set) |
| 503 | fault injection disabled by configuration |

**Rate limits.** Ingest 1,000 req/min; investigation creation 30/min; experiments 10/min;
reads 600/min.

---

## 1. Ingestion (OTLP receiver - not under `/api/v1`)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/traces` | OTLP/HTTP, `application/x-protobuf` or `application/json`. 4 MB cap. Returns **202** with `{ envelopeId }`. |
| POST | `/v1/logs` | As above. |

Paths deliberately match the OTLP/HTTP standard so the Collector needs no custom exporter.

---

## 2. System & services

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Liveness: db, kafka, worker heartbeat |
| GET | `/api/v1/overview` | Dashboard payload |
| GET | `/api/v1/services` | Discovered services with health rollups |
| GET | `/api/v1/services/:name/operations` | Operations + baselines for a service |
| GET | `/api/v1/services/dependencies` | Service dependency edges derived from the graph |

```http
GET /api/v1/overview?window=15m
```
```json
{
  "window": { "from": "2026-10-08T11:45:00.000Z", "to": "2026-10-08T12:00:00.000Z" },
  "counters": {
    "businessOperations": 214, "succeeded": 201, "failed": 13, "active": 0,
    "events": 4182, "edges": 5037, "ingestLagMs": 180
  },
  "contractHealth": {
    "eventsWithViolations": 0,
    "violatedFields": {},
    "verdict": "COMPLETE"
  },
  "recentFailures": [
    { "failureId": "fail_01HX...", "businessOperationId": "ord_8891",
      "service": "payment-service", "operation": "POST /payments/authorize",
      "errorType": "RESERVATION_AMOUNT_MISMATCH",
      "firstSeenAt": "2026-10-08T11:58:12.441Z",
      "investigationId": "inv_01HX...", "topCandidateLabel": "STRONG" }
  ],
  "activeFaults": [
    { "experimentId": "exp_01HX...", "scenarioId": "delayed_inventory",
      "service": "inventory-service", "expiresAt": "2026-10-08T12:01:00.000Z" }
  ]
}
```

`contractHealth` on the overview is a product statement: the first thing the tool tells you is
how much it can actually prove.

---

## 3. Business operations, traces, events

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/operations` | List business operations. Filters: `status`, `experimentId`, `from`, `to` |
| GET | `/api/v1/operations/:id` | One operation with summary + completeness |
| GET | `/api/v1/operations/:id/events` | Its events, causally ordered |
| GET | `/api/v1/operations/:id/timeline` | Timeline view with concurrency lanes |
| GET | `/api/v1/traces/:traceId` | Span tree for one trace (the Jaeger-equivalent view) |
| GET | `/api/v1/events` | Query events. Filters: `service`, `operation`, `status`, `traceId`, `businessOperationId`, `eventType`, `hasViolations`, `from`, `to` |
| GET | `/api/v1/events/:id` | One event with all attributes and its direct edges |

```http
GET /api/v1/operations/ord_8891/timeline
```
```json
{
  "businessOperationId": "ord_8891",
  "lanes": [
    { "lane": 0, "service": "order-service",     "events": ["evt_a1","evt_a4","evt_a7"] },
    { "lane": 1, "service": "inventory-service", "events": ["evt_b1"] },
    { "lane": 2, "service": "inventory-service", "events": ["evt_b2"] },
    { "lane": 3, "service": "payment-service",   "events": ["evt_c1"] }
  ],
  "concurrentGroups": [["evt_b1","evt_b2"]],
  "span": { "from": "...T11:58:05.100Z", "to": "...T11:58:12.441Z" }
}
```

Note `concurrentGroups`: the API states explicitly which events have no causal ordering
between them. The UI must not render them as sequential. Two separate lanes for the same
service is how two concurrent reservation attempts are shown honestly.

---

## 4. Graph

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/graph/operations/:id` | Full causal graph for a business operation |
| GET | `/api/v1/graph/events/:id/ancestors` | Ancestor subgraph of one event |
| GET | `/api/v1/graph/events/:id/descendants` | Descendant subgraph |

Query parameters, all three endpoints:

| Param | Default | Meaning |
|---|---|---|
| `maxDepth` | 12 | Traversal bound |
| `maxNodes` | 2000 | Size bound |
| `evidenceClasses` | `proven,derived,inferred` | Which classes to include |
| `mode` | `analysis` | `analysis` hides `FAULT_AFFECTED`; `ground_truth` includes it |
| `cluster` | `true` | Collapse retry/duplicate clusters |

```json
{
  "nodes": [
    { "eventId": "evt_b1", "service": "inventory-service", "operation": "inventory.reserve",
      "eventType": "messaging.consume", "status": "OK",
      "occurredAt": "...T11:58:05.161Z", "durationMs": 5041.2,
      "attemptNumber": 1, "evidenceSource": "otlp_span",
      "anomaly": { "score": 0.81, "latency": 0.95, "isFrontier": true },
      "baseline": { "p50Ms": 38.1, "p95Ms": 79.4, "sampleCount": 201 },
      "contractViolations": [], "clusterId": null }
  ],
  "edges": [
    { "from": "evt_a1", "to": "evt_b1", "type": "TRIGGERED",
      "evidenceClass": "proven", "confidence": 1.0,
      "derivedByRule": "rule.triggered.causation_id@1",
      "evidence": { "matchedFields": [
        { "field": "causation_id", "fromValue": "evt_a1", "toValue": "evt_a1" }] } }
  ],
  "clusters": [
    { "clusterId": "cl_dup_1", "type": "cluster.duplicate_work",
      "memberEventIds": ["evt_b1","evt_b2"],
      "evidence": { "idempotencyKeyHash": "9f2c...", "overlapMs": 2963,
                    "resourceIds": [["res_R1"],["res_R2"]] } }
  ],
  "concurrentGroups": [["evt_b1","evt_b2"]],
  "truncated": false,
  "completeness": { "verdict": "COMPLETE", "eventsTotal": 34,
                    "contractViolationCount": 0, "violatedFields": {},
                    "openIntervals": 0, "missingHops": [], "quietForMs": 4210 }
}
```

Every edge carries the rule that made it and the values that matched. This is the response
that makes the product verifiable rather than merely confident.

---

## 5. Failures & investigations

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/failures` | List failures. Filters: `service`, `errorType`, `investigated`, `from`, `to` |
| GET | `/api/v1/failures/:id` | One failure plus its latest investigation id |
| POST | `/api/v1/investigations` | Start an investigation (202, async) |
| GET | `/api/v1/investigations` | List investigations |
| GET | `/api/v1/investigations/:id` | Full investigation record |
| GET | `/api/v1/investigations/:id/stream` | SSE: status transitions until COMPLETE |
| GET | `/api/v1/investigations/:id/candidates/:rank` | One candidate's full evidence bundle |
| DELETE | `/api/v1/investigations/:id` | Delete a cached investigation |

```http
POST /api/v1/investigations
Authorization: Bearer <write>
{ "failureEventId": "evt_c1", "ruleSetId": "default", "mode": "analysis",
  "configOverrides": { "anomalyThreshold": 0.35 } }
```
```json
202 Accepted
{ "investigationId": "inv_01HX...", "status": "RUNNING",
  "statusUrl": "/api/v1/investigations/inv_01HX...",
  "streamUrl": "/api/v1/investigations/inv_01HX.../stream" }
```

`configOverrides` is allowlisted to the known analysis constants and validated; it exists so
the UI can offer a "sensitivity" control and so the evaluation harness can sweep thresholds.
Whatever is used is recorded in `configSnapshot` on the result.

Investigation response (abridged):

```json
{
  "id": "inv_01HX...", "status": "COMPLETE", "failureEventId": "evt_c1",
  "businessOperationId": "ord_8891",
  "subgraphNodeCount": 34, "subgraphEdgeCount": 45,
  "truncated": false, "frontierFallback": false,
  "completeness": { "verdict": "COMPLETE", "contractViolationCount": 0 },
  "ruleSetId": "default", "durationMs": 212,
  "patterns": [
    { "pattern": "IDEMPOTENCY_FAILURE", "memberEventIds": ["evt_b2"],
      "evidence": { "attemptNumber": 2, "missEventId": "evt_b2_miss" } },
    { "pattern": "DUPLICATE_WORK", "memberEventIds": ["evt_b1","evt_b2"],
      "evidence": { "resourceIds": [["res_R1"],["res_R2"]] } }
  ],
  "candidates": [
    {
      "rank": 1, "eventId": "evt_b1", "score": 0.8731, "label": "STRONG",
      "service": "inventory-service", "operation": "inventory.reserve",
      "evidence": {
        "pathToFailure": [
          { "from": "evt_b1", "to": "evt_a4", "type": "TIMED_OUT_WAITING_FOR",
            "evidenceClass": "proven", "confidence": 1.0,
            "derivedByRule": "rule.timeout.awaited@1",
            "matchedFields": [{ "field": "awaited_correlation_id",
                                "fromValue": "evt_b1", "toValue": "evt_b1" }] }
        ],
        "anomalyBreakdown": {
          "latency": { "durationMs": 5041.2, "baselineP50": 38.1, "baselineP95": 79.4,
                       "z": 62.6, "contribution": 0.40 },
          "error":   { "status": "OK", "contribution": 0.0 },
          "retries": { "descendantRetryCount": 1, "contribution": 0.02 }
        },
        "patterns": ["DUPLICATE_WORK", "IDEMPOTENCY_FAILURE"],
        "concurrentWith": ["evt_b2"],
        "caveats": []
      }
    }
  ],
  "configSnapshot": { "anomalyThreshold": 0.35, "wAnomaly": 0.45, "wProximity": 0.15,
                      "wPath": 0.25, "wPattern": 0.15, "maxTraversalDepth": 12 }
}
```

The UI labels rank 1 **"Most likely origin of the failure chain"** - never "root cause".

---

## 6. Experiments (fault injection) - gated

All endpoints require `CAUSORA_EXPERIMENT_TOKEN` **and** `CAUSORA_ALLOW_FAULT_INJECTION=true`
**and** `NODE_ENV !== 'production'`. Any gate unmet → `503` with
`type: .../problems/fault-injection-disabled`. The guard lives in one tested module.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/experiments/scenarios` | Available scenario definitions |
| POST | `/api/v1/experiments/runs` | Run a scenario (202) |
| GET | `/api/v1/experiments/runs` | List runs |
| GET | `/api/v1/experiments/runs/:id` | Run status, business operations produced, investigations |
| POST | `/api/v1/experiments/runs/:id/abort` | Clear faults immediately |
| GET | `/api/v1/experiments/active-faults` | Currently active faults across services |

```http
POST /api/v1/experiments/runs
{ "scenarioId": "delayed_inventory",
  "params": { "delayMs": 5000, "orderCount": 1 },
  "ruleSetId": "default" }
```
```json
202 Accepted
{ "experimentId": "exp_01HX...", "status": "RUNNING",
  "groundTruth": { "service": "inventory-service", "operation": "inventory.reserve",
                   "faultType": "handler_delay",
                   "expectedPatterns": ["DUPLICATE_WORK","IDEMPOTENCY_FAILURE"] },
  "expectedDurationMs": 12000 }
```

`groundTruth` is returned up front and stored. It is used by the evaluation harness and by the
UI's "reveal answer" toggle - and it is **never** sent to the analysis pipeline.

---

## 7. Analytics & evaluation (post-MVP)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/analytics/failure-rates` | Failure rate by service/operation over time |
| GET | `/api/v1/analytics/latency` | Latency percentiles by operation |
| GET | `/api/v1/analytics/patterns` | Pattern frequency |
| GET | `/api/v1/analytics/contract-health` | Contract violations by field and service |
| GET | `/api/v1/evaluation/results` | Hit@1, Hit@3, MRR, completeness; group by `ruleSetId` |
| POST | `/api/v1/evaluation/runs` | Run the evaluation suite (N scenario repetitions) |
| GET | `/api/v1/evaluation/ablation` | Side-by-side comparison across rule sets |

```http
GET /api/v1/evaluation/results?groupBy=ruleSetId
```
```json
{
  "groups": [
    { "ruleSetId": "default",               "runs": 30, "hitAt1": null, "hitAt3": null,
      "mrr": null, "graphCompleteness": null },
    { "ruleSetId": "ablation.no_causation", "runs": 30, "hitAt1": null, "hitAt3": null,
      "mrr": null, "graphCompleteness": null }
  ],
  "note": "Values are null until the implementation phase runs the suite. No figures in this repository are estimated."
}
```

Those nulls are deliberate and should remain in the API contract documentation until real runs
populate them.
