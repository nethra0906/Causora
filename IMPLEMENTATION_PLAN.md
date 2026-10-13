# Implementation Plan

> **Build status - blueprint document.** This is the original ~82 h plan. The build followed its **ordering principles** (contract before services, replay before rules, fault injection before analysis) but collapsed M0–M9 into a three-day lightweight scope and pulled parts of M10–M13 forward (tests, evaluation, ablation, two benchmarks). [PROGRESS.md](PROGRESS.md) has the real milestone status.

Build order, acceptance criteria and risks. Written for an implementation agent or engineer
who has read [ARCHITECTURE.md](ARCHITECTURE.md) and the docs it links.

---

## 0. Budget and the honest arithmetic

Stated budget: **4–6 weeks part-time**, which at 13–15 h/week is **55–85 hours**.

MVP (M0–M9) is estimated at **~82 hours**. That lands at the **upper end** of the budget:
roughly six weeks at 14 h/week. It does not fit four weeks without de-scoping.

Two honest options, both legitimate:

- **Take the six weeks.** The MVP as specified is a complete, demonstrable, defensible project.
- **De-scope to ~58 hours** using the levers in §3, landing in four weeks with a smaller but
  still coherent product.

What must **not** happen is attempting M0–M14 in four weeks. That produces a half-built
platform with no working demo, which is worth less than a small finished one. Rule 10 of the
original brief, and it is the right rule.

---

## 1. Dependency graph and why this order

```
M0 Foundation
  |
M1 Contracts + telemetry + kafka packages      <-- THE CRITICAL-PATH DECISION
  |
M2 Demo application (happy path)
  |
M3 Observability pipeline  ---------> Jaeger visible here (early win)
  |
M4 Ingest + raw storage + REPLAY               <-- unlocks fast iteration for M5-M8
  |
M5 Normalise + correlate + persist
  |
M6 Edge rules                                  <-- the intellectual core
  |
M7 Fault injection + primary scenario          <-- first real causal chain
  |
M8 Failure analysis
  |
M9 Frontend
======================= MVP CUTOFF ==========================
M10 Test hardening -> M11 Evaluation -> M12 Ablation -> M13 Benchmarks -> M14 Docs
M15 Advanced (optional, open-ended)
```

### Three ordering decisions that prevent rewrites

**1. Contracts and propagation packages before any service (M1 before M2).**
The causal metadata contract is the project. Retrofitting header propagation into three
services, two transports and an OTel pipeline after they exist is a multi-day rewrite and the
most likely way this project goes wrong. Building `packages/kafka` first - with required
parameters that make the contract impossible to omit - means every service is correct by
construction from its first line.

**2. Replay (M4) before the rules (M6).**
Without replay, every rule iteration requires re-running the demo: ~90 seconds per change.
With replay, it is a few seconds against recorded telemetry. Over M6 and M8 - the two longest
and most iterative milestones - this is worth several hours and a great deal of patience.

**3. Fault injection (M7) before failure analysis (M8).**
Analysis needs a real failure graph to develop against. Building the analyser first means
developing against hand-written fixtures that will not match reality, then debugging the
difference. Get the real chain first, then analyse it.

**The rule-set configuration mechanism ships in M6, not later.** The ablation experiment is
the project's research contribution; if rules are not individually disableable from day one,
M12 becomes a refactor instead of a config file. This is a one-hour decision in M6 that saves
a day in M12.

---

## 2. Milestones

Each milestone ends with something that runs. There is no milestone whose deliverable is
"infrastructure".

---

### M0 - Foundation · 4 h

**Objective.** A repository that builds, lints, types and tests on an empty codebase.

**Tasks.** pnpm workspaces + Turborepo + shared `tsconfig.base.json` · ESLint + Prettier ·
Vitest configured at the root · `docker-compose.yml` with Postgres and Redpanda only ·
`.env.example` · the migration runner · GitHub Actions: lint → typecheck → test · `PROGRESS.md`
initialised.

**Deliverables.** `pnpm install && pnpm build && pnpm test` passes. `docker compose up postgres
redpanda` is healthy.

**Acceptance.** CI green on an empty repo. Migration runner applies a no-op migration.

**Risks.** Turborepo configuration rabbit-holing. *Mitigation:* a minimal `turbo.json` with
`build`, `test`, `lint`; tune later or never.

---

### M1 - Contracts, telemetry and messaging packages · 8 h · **CRITICAL PATH**

**Objective.** Make the causal metadata contract impossible to violate.

**Tasks.**
- `packages/contracts`: `NormalisedEvent`, `CausalEdge`, `EvidenceClass`, `EdgeType`,
  `EventType`, `Completeness`, `Investigation`; header and attribute names as **exported
  constants**, never literals.
- `packages/telemetry`: `initTelemetry()`; `AsyncLocalStorage` causal context; HTTP and Kafka
  header inject/extract; `recordCausalAttributes(span)`; **an injected clock** (`now()`) so
  `clock_offset` injection works later.
- `packages/kafka`: `publish()` and `subscribe()` wrappers where the causal fields are
  **required parameters**. Opening the causal context, starting the consume span and stamping
  attributes all happen before the handler body runs.
- ESLint rules: no direct `kafkajs` import outside `packages/kafka`; no `Date.now()` outside
  `packages/telemetry`.

**Deliverables.** Packages with unit tests and a two-process round-trip test proving every
contract field survives a Kafka hop.

**Acceptance.**
1. `publish()` does not compile without `causation` and `businessOperationId`.
2. Round-trip test: every contract header set by the producer is readable by the consumer.
3. The ESLint rules actually fail on a violating file (test the rules, not just write them).

**Risks.** `AsyncLocalStorage` context lost across KafkaJS callbacks - a real and well-known
trap. *Mitigation:* the round-trip test exists specifically to catch it; if context does not
propagate, pass it explicitly through the wrapper rather than fighting the runtime.

---

### M2 - Demo application, happy path · 10 h

**Objective.** Three services completing an order saga.

**Tasks.** `app` database migrations · Order Service (POST `/orders`, saga state, watchdog
scaffolding, produce `order.created`, consume `inventory.reserved`) · Inventory Service
(consume `order.created`, reserve, **the deliberate check-then-act idempotency guard, with a
comment explaining it is intentional**, produce `inventory.reserved`) · Payment Service
(authorise, reservation-amount validation) · `scripts/demo-happy-path.ts` · Compose entries.

**Deliverables.** `pnpm demo:happy-path` creates an order reaching `CONFIRMED`.

**Acceptance.**
1. Happy path succeeds consistently.
2. Every cross-service hop carries all contract headers (asserted by an integration test, not
   by inspection).
3. Insufficient stock produces `inventory.rejected` and a failed order.
4. The buggy idempotency guard is clearly commented as deliberate, referencing the scenario doc.

**Risks.** Saga complexity creep. *Mitigation:* no compensation logic, no partial reservations,
no cancellation. The saga has exactly the steps in `docs/architecture/demo-application.md` §2.

---

### M3 - Observability pipeline · 6 h

**Objective.** Telemetry flowing, visible in Jaeger.

**Tasks.** OTel SDK bootstrap per service (auto: http, pg; manual: domain spans, span events) ·
pino + OTel log bridge · Collector config with the redaction processor · Jaeger in Compose ·
`AlwaysOnSampler` with a comment explaining why · Collector file exporter run once to capture
OTLP fixtures for M5 tests.

**Deliverables.** Jaeger shows a complete happy-path trace. OTLP fixtures committed.

**Acceptance.**
1. Jaeger shows spans from all three services for one order.
2. `causora.*` attributes are present on every cross-boundary span.
3. A span carrying `payment.card_number` and `db.statement` has both removed by the Collector
   (verified end to end).
4. `causora.idempotency_key` arrives **hashed**, not dropped.

**Risks.** The Kafka hop does not link producer to consumer in Jaeger. *Mitigation:* that is
expected and is partly the point - but verify the `traceparent` header is present; the
`packages/kafka` wrapper is responsible for it.

---

### M4 - Ingest, raw storage and replay · 7 h

**Objective.** Telemetry durably captured and replayable. **This milestone pays for itself
twice over in M6 and M8.**

**Tasks.** `causora` database migrations (`raw_telemetry` first) · Fastify API skeleton with
auth, rate limiting and the RFC 7807 error handler · `POST /v1/traces`, `/v1/logs` with
protobuf and JSON support and a body cap · write raw + publish to `causora.ingest` · worker
skeleton consuming the topic (no-op for now) · `scripts/replay.ts` · Collector exporter
pointed at Causora.

**Deliverables.** `pnpm demo:happy-path` results in `raw_telemetry` rows. `pnpm replay --since
10m` re-enqueues them.

**Acceptance.**
1. Running the demo produces raw rows with `status = pending`.
2. Replay re-enqueues without duplicating raw rows.
3. Oversized payload → 413; bad token → 401.
4. The Collector retries successfully when the API is restarted mid-run (no telemetry lost).

**Risks.** OTLP protobuf decoding friction in Node. *Mitigation:* `@opentelemetry/otlp-transformer`
handles it; if it resists, configure the Collector to export OTLP/**JSON** for MVP and record the
trade-off as an ADR. Do not spend more than 90 minutes here.

---

### M5 - Normalisation, correlation and persistence · 7 h

**Objective.** Raw telemetry becomes queryable events.

**Tasks.** `events`, `event_correlations`, `business_operations` migrations · the **pure**
`normalise()` function · correlation key extraction · idempotent persistence in one transaction
per envelope · `GET /api/v1/events` and `/operations/:id/events` · unit tests against the M3
fixtures.

**Deliverables.** Running the demo produces normalised events queryable by business operation.

**Acceptance.**
1. One happy-path order produces ~18 events across 3 services.
2. Re-processing the same envelope produces no duplicates.
3. `normalise()` is pure: a test asserts no I/O and stable `event_id`s across two calls.
4. Contract violations are recorded, not thrown.
5. Replay produces a byte-identical event set.

**Risks.** Normalisation sprawls into an untestable mess. *Mitigation:* the purity constraint is
not negotiable; if a rule needs the database, it belongs in correlation or in a rule, not here.

---

### M6 - Edge rules · 9 h · **the intellectual core**

**Objective.** A causal graph from real telemetry.

**Tasks.** `edges` migration · `EdgeRule` interface + `CorrelationLookup` port (memory and
Postgres implementations) · the rule registry and **rule-set configuration** · the five proven
rules · `rule.duplicate.idempotency` · the two inferred rules · `rule.proximity` (disabled) ·
re-derivation sweep for late arrivals · `GET /api/v1/graph/operations/:id`.

**Deliverables.** A happy-path order renders as a connected causal graph via the API.

**Acceptance.**
1. All nine rules unit-tested against the in-memory lookup, **no containers**.
2. Happy-path graph is fully connected with zero inferred edges.
3. Ingesting a consumer event before its producer creates no edge; the producer's arrival
   creates it via the sweep.
4. Running the rule set twice produces an identical edge set.
5. `ruleSetId: 'ablation.no_causation'` demonstrably disables one rule and changes the graph.
6. Property test: no self-loops; no inferred edge above `MAX_INFERRED_CONFIDENCE`.

**Risks.** `DUPLICATE_OF` direction instability producing flapping graphs. *Mitigation:*
canonical ordering with a full tie-break chain, property-tested under input permutation.

---

### M7 - Fault injection and the primary scenario · 6 h

**Objective.** The primary failure, reproducibly, end to end.

**Tasks.** `FaultController` per service with TTL · `POST /internal/faults` · the triple-gated
guard module with its seven tests · `fault_experiments` migration · scenario definitions S1, S2,
S3 · the scenario runner with its `finally` cleanup · `POST /api/v1/experiments/runs` ·
`failures` detection · baseline computation + `scripts/seed-baseline.ts`.

**Deliverables.** `pnpm demo:primary-failure` reliably produces the full chain.

**Acceptance.**
1. S1 produces the failure in ≥ 9 of 10 runs.
2. The resulting graph contains all 8 expected edges: 7 proven, 1 derived, **0 inferred**.
3. All seven security gate tests pass, including the `NODE_ENV=production` refusal.
4. Faults are cleared even when the runner throws.
5. Baseline seeding yields ≥ 200 samples for `inventory.reserve`.

**Risks.** The duplicate race does not reproduce reliably. *Mitigation:* this is the highest
scenario-level risk. The `SETTLING` window in the Order Service exists to make it deterministic.
If it is still flaky, lengthen the injected delay relative to the deadline - a 5 s delay against
a 2 s deadline leaves a 3 s race window, which is generous. Verify reproducibility before M8
begins; do not build the analyser on a flaky scenario.

---

### M8 - Failure analysis · 11 h

**Objective.** A ranked, evidenced investigation.

**Tasks.** `investigations`, `investigation_candidates`, `patterns_detected` migrations ·
the recursive CTE with bounds and cycle guard · Tarjan SCC collapse · anomaly scoring (with the
`RankableEvent` projection) · frontier identification · the six patterns · ranking · evidence
assembly · labelling · completeness assessment · the job queue (`causora.jobs`) · the
investigation endpoints + SSE · the `setImmediate` yielding.

**Deliverables.** Investigating the S1 failure ranks the delayed reservation first.

**Acceptance.**
1. S1 rank 1 = `inventory-service` / `inventory.reserve` attempt 1, label `STRONG`.
2. Patterns `DUPLICATE_WORK` and `IDEMPOTENCY_FAILURE` detected.
3. Every candidate's evidence contains the full path with matched field **values**.
4. **Both integrity tests pass** (fault flags ignored; inferred chains cannot outrank proven).
5. Determinism test: identical results over 100 shuffled input orderings.
6. Retry-storm subgraph traversal causes no Kafka rebalance.
7. Completeness verdict correct in all three states.

**Risks.** Weight tuning becomes an endless fiddle. *Mitigation:* ship the declared defaults.
Tuning without the M11 evaluation harness is guesswork dressed as engineering; wait for data.

---

### M9 - Frontend · 14 h

**Objective.** The product.

**Tasks.** Vite + React + TanStack Query + the typed API client · Overview (4 h) · Investigation:
React Flow graph with custom nodes and edges, dagre layering with concurrency lanes, evidence
panel, candidate list, timeline (7 h) · Fault Lab (3 h) · all empty, error and degraded states ·
the keyboard-navigable graph equivalent.

**Deliverables.** The full user journey (`docs/frontend/product-design.md` §5) works in a browser.

**Acceptance.**
1. Overview shows failures within 5 s of occurrence.
2. Evidence classes are distinguishable **in greyscale** (line style + label, never colour alone).
3. Clicking an edge shows the rule and the matched values.
4. Concurrent events render in parallel lanes.
5. Reveal-fault defaults to off and does not change the ranking.
6. The retry-storm scenario renders without freezing the browser.
7. Every empty and error state has written copy - no blank panels.

**Risks.** Graph layout consumes the entire milestone. *Mitigation:* use `dagre` layered output
as-is; add only the concurrency-lane post-pass. Hand-tuned layout is a bottomless pit. Timebox
layout polish to 2 hours.

---

## ═══ MVP CUTOFF - ~82 h ═══

At this point the project satisfies the MVP Definition of Done and is demonstrable,
defensible and complete. Everything below increases its value; nothing below is required for it
to be a finished thing.

---

### M10 - Test hardening · 8 h
Fill coverage to the gates (rules ≥ 90%, analysis ≥ 85%). Add the concurrency tests, the
Testcontainers integration suite, the E2E scenario assertions including the `inventory_fix`
control, and the three Playwright journeys. Wire the full CI matrix.

### M11 - Evaluation harness · 8 h
Scenarios S4–S7. `evaluation_results`, Hit@1/Hit@3/MRR/completeness, the evaluation endpoints,
the run protocol with resets and quiescence waits. **Acceptance: ≥ 30 runs with reported mean
and standard deviation, and no hand-entered numbers anywhere.**

### M12 - Ablation study · 6 h
Define the seven rule sets, implement replay-based comparison on identical input, produce the
results table, write up against the pre-registered hypotheses - **including any that are
disconfirmed**. Add the Evaluation screen.

### M13 - Benchmarks · 8 h
k6 scripts, `docker-compose.bench.yml`, BM1–BM7 to the stated protocol, results committed with
hardware and spread. Optionally BM8 (Neo4j comparison) if time allows.

### M14 - Documentation and polish · 8 h
README quickstart verified on a clean machine by someone else · architecture diagrams ·
a recorded demo walkthrough · all ADRs completed · `docs/interview-prep.md` verified against
real code paths · the project report if desired.

### M15 - Advanced · open-ended
Trace comparison against a healthy baseline · pending-edge resolution · the sampling experiment ·
Trace and Service Explorer screens · counterfactual scenario pairs · Kubernetes manifests.

---

## 3. De-scoping levers (to reach ~58 h / four weeks)

Apply in this order. Each is a real loss, named honestly.

| # | Lever | Saves | What is lost |
|---|---|---|---|
| 1 | Cut scenarios S2 and S3 from M7; ship S1 only | 2 h | Breadth of demo; S1 alone still proves the thesis |
| 2 | Cut the Timeline tab from M9; graph only | 3 h | Dwell-time visualisation; concurrency still shown in the graph |
| 3 | Cut the two inferred rules from M6 | 2 h | **Blocks the ablation study later** - only take this if abandoning M12 |
| 4 | Cut three of six patterns (keep `DUPLICATE_WORK`, `IDEMPOTENCY_FAILURE`, `SLOW_CONSUMER`) | 2 h | Analytical richness |
| 5 | Cut the Fault Lab screen; run scenarios by CLI | 3 h | **The demo loses its closing beat.** Take this last. |
| 6 | Cut Jaeger from Compose | 1 h | **The side-by-side comparison, the single best demo beat.** Do not take this. |
| 7 | Cut SSE; poll the investigation status instead | 1 h | Minor polish only. Take this first. |

Recommended four-week set: **7, 1, 4, 2** → saves 8 h; plus trimming M9 polish and M10 → ~58 h.

Levers 3, 5 and 6 cut the things that make the project distinctive. Reach for them only after
everything else is gone.

---

## 4. Top risks across the project

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Contract retrofitted after services exist | Medium | **Severe** - multi-day rewrite | M1 strictly before M2; required parameters make omission a compile error |
| R2 | The duplicate race does not reproduce reliably | Medium | **Severe** - the primary demo fails | Deterministic `SETTLING` window; verify 10/10 before M8; generous delay-to-deadline ratio |
| R3 | Scope creep into a fourth service or an eighth screen | **High** | High | The MVP Definition of Done is the contract. Anything not on it goes to M15. |
| R4 | Graph layout consumes M9 | Medium | High | `dagre` as-is; layout polish timeboxed to 2 h |
| R5 | `AsyncLocalStorage` context lost across Kafka callbacks | Medium | High | The M1 round-trip test exists to catch it on day one |
| R6 | Weight tuning without data | Medium | Medium | Ship declared defaults; tune only after M11 |
| R7 | Event loop starvation causing consumer rebalances | Medium | Medium | `setImmediate` yielding in M8; explicit test |
| R8 | Benchmarks invented under time pressure | Low | **Fatal to credibility** | `TBD` placeholders are committed; CI fails if a result file lacks a hardware block |
| R9 | OTLP protobuf decoding friction | Medium | Low | 90-minute timebox, then fall back to OTLP/JSON with an ADR |
| R10 | Finishing M0–M8 with no UI | Medium | High | M9 is inside the MVP for a reason: a platform with no interface does not demo |

R3 is the one that actually kills portfolio projects. The Definition of Done exists to be
pointed at when a new idea arrives at week three.

---

## 5. Working agreement for the implementation agent

1. **Read `docs/algorithms/event-model.md` before writing any instrumentation.**
2. **Never add a `causora.*` attribute as a string literal.** Use the constants in
   `packages/contracts`.
3. **Never let `is_fault_injected` or `experiment_id` reach the ranker.** The `RankableEvent`
   projection and its two tests are load-bearing; if they are in the way, the change is wrong.
4. **Never commit a benchmark number that was not produced by a run**, and always attach the
   hardware block.
5. **Never write a sleep into an E2E test.** Wait on state.
6. **Update `PROGRESS.md` at the end of every session** - milestone, status, decisions, blockers.
7. **If a decision differs from this blueprint, write an ADR.** Divergence is fine; silent
   divergence is not.
8. **Every edge must carry its `derived_by_rule` and matched field values.** An edge without
   evidence violates the project's central claim.
9. **When a milestone's acceptance criteria are met, stop and move on.** Polish belongs in M14.
