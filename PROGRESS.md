# Progress

Live implementation tracker. **Update at the end of every working session** — milestone
status, decisions taken, blockers, and anything that diverged from the blueprint.

Current phase: **Implemented (three-day lightweight scope, ADR-0017). Remaining: items marked ✗/◐ below.**

Status key: ☐ not started · ◐ partly done / reduced scope · ☑ done · ⊘ deliberately descoped

---

## Milestone status

The blueprint's 82 h plan was re-scoped to three days on a 16 GB laptop ([ADR-0017](DECISIONS.md#adr-0017)).
The ordering principles held (contract before services → replay before rules → fault injection before analysis).

| # | Milestone | Status | What exists / what was cut |
|---|---|---|---|
| M0 | Foundation | ◐ | Single npm package, native TS (no build step), `node:test`, strict `tsc` incl. `erasableSyntaxOnly`. ⊘ Turborepo/pnpm workspaces, ESLint/Prettier, GitHub Actions. |
| M1 | Contracts + telemetry + bus | ☑ | `src/contracts`, `src/telemetry`, `src/bus`. Causal fields are **required parameters** of `publish()`; round-trip test proves every header survives a hop; convention rules enforced as tests. |
| M2 | Demo application | ☑ | order / inventory / payment, saga with timeout + retry + settle window, deliberate check-then-act race (commented as intentional), corrected-guard control. |
| M3 | Observability pipeline | ◐ | OTel-*shaped* tracer exporting batched JSON; SDK-side hashing of idempotency keys. ⊘ Collector, redaction processor, Jaeger, OTLP fixtures. |
| M4 | Ingest + replay | ◐ | `POST /v1/spans` (zod-validated, RFC 7807 errors, idempotent). Replay = re-derivation from stored events. ⊘ raw-telemetry table, auth, rate limit, protobuf. |
| M5 | Normalise + correlate + persist | ☑ | Pure `normalise()`; contract violations recorded, not thrown; late arrivals linked on re-derivation. ⊘ correlation-index table. |
| M6 | Edge rules | ☑ | 9 rules, 8 rule sets (the ablation *is* configuration), property tests for self-loops/duplicates/inferred cap. |
| M7 | Fault injection + scenarios | ☑ | 3-gated fault API with TTL, scenario runner with `finally` cleanup, S1–S4 + control. |
| M8 | Failure analysis | ☑ | Scope, exclusive-time scoring, callee error attribution, Tarjan SCC, frontier, 5 patterns, ranking, evidence, labels, completeness. Integrity tests mutation-checked. |
| M9 | Frontend | ◐ | Failures & Fault Lab, Investigation (React Flow + dagre, evidence panel, ablation selector, reveal toggle), Evaluation. ⊘ timeline tab, concurrency lanes, trace/service explorers. |
| M10 | Test hardening | ◐ | 55 unit + 6 e2e. ⊘ Playwright, Testcontainers, CI matrix. |
| M11 | Evaluation harness | ◐ | Hit@1/Hit@3/MRR + 4 extra metrics over **40 runs**, no hand-entered numbers. ⊘ S5–S7. |
| M12 | Ablation study | ☑ | 8 rule sets on identical stored events; results + caveats in `docs/experiments/results.md`. |
| M13 | Benchmarks | ◐ | BM1 (ingest) and BM2 (investigation vs size) only. ⊘ BM3–BM8. |
| M14 | Documentation | ◐ | README, ADR-0017, build-status banners on blueprint docs, generated results, `docs/interview-prep.md` rewritten and mechanically checked (`npm run check:docs`). ✗ no recorded demo, ✗ quickstart not run by a second person. |
| M15 | Advanced | ☐ | Not started. |

---

## MVP Definition of Done

Tick only when verified, not when believed. Evidence in the right-hand column.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | One-command start on a clean checkout | ☑ *(replaced)* | `docker compose up` → `npm install && npm start`. Run from a copy with no `node_modules`/`data`/`dist`: install 5 s, UI auto-built, seed → happy path → primary failure all passed. |
| 2 | `demo:happy-path` reaches `CONFIRMED`; Jaeger shows the trace | ◐ | CONFIRMED with 9 events / 9 proven edges. Jaeger ⊘ → in-app *tracing-only* view. |
| 3 | `demo:primary-failure` produces the chain in ≥ 9/10 runs | ☑ | e2e asserts ≥ 9/10 with the exact chain; last evaluation: 10/10 S1 runs failed as designed. |
| 4 | UI lists the failure within 5 s | ☑ | Measured: failure → listed by API 212–338 ms (5 runs); UI polls every 2 s ⇒ ≈ 2.3 s worst. |
| 5 | Graph matches the expected chain, asserted by a test | ☑ | `test/e2e/primary.test.ts` (edge type + the operations connected, per run). |
| 6 | Every edge exposes type, class, rule and matched values | ☑ | Asserted in unit and e2e tests; shown in the UI evidence panel. |
| 7 | Rank 1 is the injected fault's service and operation | ☑ | e2e (attempt 1, `STRONG`, frontier); eval Hit@1 100% / "first instance" 100% over 40 runs. |
| 8 | Fault Lab can re-run the scenario from the UI | ☑ | Verified by a real click in a browser: banner → run finished in 3.2 s → new failure row with the correct origin. **No automated UI test** (Playwright cut). |
| 9 | No inferred/weak edge above its declared weight | ☑ | Property test + "inferred chain cannot outrank proven" test. |
| 10 | `is_fault_injected` absent from ranking inputs | ☑ | 3 integrity tests; **mutation-checked**: leaking the fields into the scorer turned all 3 red. |
| 11 | Coverage ≥ 80% on rules and analysis | ☑ | `src/platform/rules.ts` 97%, `src/platform/analysis.ts` 98.5% lines (branches 96% / 90%). |
| 12 | Someone else followed the quickstart on a clean machine | ✗ | **Not done.** The author ran it from a clean copy only. |

## Project Definition of Done

| # | Item | Status | Evidence |
|---|---|---|---|
| 13 | ≥ 4 scenarios, each with an automated graph assertion | ☑ | S1–S4 + control, `GRAPH_ASSERTIONS` in the e2e suite. |
| 14 | Hit@1 / Hit@3 / MRR over ≥ 30 runs | ☑ | 40 scored runs. |
| 15 | Ablation with `causation_id` disabled | ☑ | Plus 6 more rule sets. |
| 16 | Benchmarks with hardware, method, repetitions, percentiles | ◐ | BM1, BM2 only (`docs/benchmarks/results.md`). |
| 17 | All ADRs complete with rationale and rejected alternatives | ☑ | ADR-0001…0017; superseded ones annotated. |
| 18 | `docs/interview-prep.md` verified against real code paths | ☑ | Rewritten (the blueprint version described Kafka, Postgres, the Collector, S6/S7, `setImmediate` yielding — none built). `npm run check:docs` resolves every path, "symbol in file" claim, quoted test name and relative link (README + interview-prep). It checks *references*, not the truth of every sentence — the prose was reviewed by hand against the code. |

---

## Session log

### 2026-10-12 — Implementation (three-day scope)

**Decision.** Deadline 15 Oct, 16 GB, no GPU ⇒ cut the infrastructure, keep the idea. Node 24 provides
`node:sqlite` and native TypeScript, which removed Docker, Redpanda, the Collector, Jaeger, Postgres and
the build step in one move. See ADR-0017 (including two corrections to the blueprint's own arithmetic).

**Built, in order:** contracts → telemetry SDK → bus → services → normalise/rules/analysis (pure) →
store/engine/server → scenario runner/evaluation → CLI → unit tests → UI → e2e → benchmarks → docs.

**Results.** Primary scenario ranks the delayed reservation first (`STRONG`) with the full proven chain;
40-run ablation: tracing alone localises 0% of failures; `idempotency_key` buys the duplicate-bug diagnosis
(100% → 0%) though not localisation. Numbers below are copied from generated files.

**Bugs that verification caught — none were found by the first green test run.**

| Found by | Bug | Fix |
|---|---|---|
| Reading scenario output | Fault `DELETE` returned 400 (JSON content-type, empty body) and the runner **swallowed it**, so faults leaked between scenarios and S2–S4 all looked like S1. | No content-type on DELETE; `clearAllFaults()` now throws on any failure. |
| Reading scenario output | "No telemetry for 700 ms" as a quiescence signal is racy (an 800 ms payment call is itself a longer gap) → failures not yet ingested. | Wait on state: terminal event present ∧ no dangling refs ∧ quiet window. |
| Inspecting edge lists | `LIKELY_RETRY_OF` fired in the **default** graph (inherited attempt numbers on downstream messages). | Requires a deadline firing in the same service. |
| Inspecting edge lists | Consumer span inherited `retry_of`, adding a shortcut edge past the timeout. | Retry relation lives only between the two PRODUCE events. |
| Inspecting edge lists | Orphan inference linked `order.failed` → its own parent (50 ms clock tolerance admitted descendants). | Same service only; exclude the event's descendants. |
| Cold-booting three times | `database is locked` when two services opened the shared bus file at once (WAL switch before `busy_timeout`). | `busy_timeout` first. |
| Browser check of the ablation view | Operation id taken from the *masked* failure event → null → graph skipped. | Pass identity from the failure record; regression test. |
| Writing the convention tests | Fault TTL read from an attribute namespace the normaliser strips (always the default); one header spelled as a literal. | Neutral key surfaced by `normalise()`; constant used. |
| Re-reading my own README | An invented "285× baseline" figure. | Replaced with the measured 1.71 s vs 0.83 ms p95. |

**Resolved open questions.** (1) Race reproduces 10/10 with D = 1 s, L = 1.7 s; the blueprint's 5 s/2 s would give
three attempts. (2) Async context survives the bus handler boundary (round-trip test). (3) OTLP decoding: dropped.
(4) Four vs six weeks: moot.

**Next, in priority order.**
1. Have someone else run the README quickstart on their machine (DoD 12) — the one remaining MVP item.
2. Record a 2-minute walkthrough (S1 → investigation → switch to "tracing only").
3. Write one **held-out scenario before looking at the output** (see the weakness in `docs/interview-prep.md` §3: two heuristics were added after seeing S2/S3 fail).
4. Optional: Playwright for the three UI journeys; S5–S7; BM3+; commit the work (the repository has no commits yet).

---

## Divergences from the blueprint

Record anything built differently from the plan, with the reason. An entry here plus an ADR is
the correct response to a changed decision; silent divergence is not.

| Date | What changed | Why | ADR |
|---|---|---|---|
| 2026-10-12 | SQLite bus, SQLite storage, OTel-shaped SDK; no Redpanda/Collector/Jaeger/Postgres/Docker | 3-day deadline, 16 GB RAM | ADR-0017 |
| 2026-10-12 | Timing: deadline 1 s, delay 1.7 s, settle 1.5 s | Blueprint's 5 s/2 s yields three attempts; faster evaluation | ADR-0017 |
| 2026-10-12 | Callers allocate callee event ids (`x-causora-event-id`, `consume:<msg>:<group>`) | A timeout can only name what it awaited if the id exists before the callee runs | ADR-0017 |
| 2026-10-12 | Latency is self-time; caller errors attributed to callees; `http.client`/`timeout.fired` carry no error signal | Without it the client span of a slow/failed call becomes the "origin" in S2/S3 | `docs/algorithms/failure-analysis.md` banner |
| 2026-10-12 | Ranking lists frontier candidates first, then downstream effects | Keeps Hit@k meaningful when the frontier is wrong under ablation | same |
| 2026-10-12 | Traversal in memory, not a recursive CTE | Ablations derive edges without persisting them | ADR-0003 note |

---

## Benchmark results

Populated only by real runs. Source: [docs/benchmarks/results.md](docs/benchmarks/results.md)
(`npm run bench`; Intel Core Ultra 5 225H, 14 logical cores, 15.4 GB, Windows 11, Node 24.17).

| Benchmark | Result | Date | Commit |
|---|---|---|---|
| BM1 ingest → persist → derive edges | 14.6 k / 17.5 k / 16.6 k events/s (3 reps) | 2026-10-12 | uncommitted |
| BM2 investigation, 2,000-node subgraph | p50 6.84 ms · p95 10.99 ms (24 reps) | 2026-10-12 | uncommitted |
| Footprint, whole stack (5 Node processes) | ≈ 407 MB working set after a full evaluation | 2026-10-12 | uncommitted |
| BM3–BM8 | not run (cut) | | |

## Evaluation results

Source: [docs/experiments/results.md](docs/experiments/results.md) (`npm run eval`, 10 runs × 4 scenarios = 40 scored runs).

| Rule set | Hit@1 | Hit@3 | MRR | Cause reachable | Edge recall | Dup. bug diagnosed |
|---|---|---|---|---|---|---|
| `default` | 100% | 100% | 1.00 | 100% | 100% | 100% |
| `ablation.no_retry_of` | 100% | 100% | 1.00 | 100% | 100% | 100% |
| `ablation.no_idempotency_key` | 100% | 100% | 1.00 | 100% | 96% | 0% |
| `ablation.no_awaited` | 50% | 50% | 0.50 | 50% | 93% | 100% |
| `ablation.no_causation_id` | 50% | 50% | 0.50 | 50% | 87% | 100% |
| `ablation.no_causation_id.no_inference` | 25% | 25% | 0.25 | 25% | 58% | 0% |
| `ablation.tracing_only` | 0% | 0% | 0.00 | 0% | 66% | 0% |
| `ablation.tracing_only.no_inference` | 0% | 0% | 0.00 | 0% | 44% | 0% |

Caveat that travels with these numbers: 40 runs of four scenario types; measures reliability and the value of each
contract field, not generalisation.
