# Causora

**Find where a failure chain *started* — not where it surfaced.**

Causora is a causality-aware debugging platform for event-driven systems. It watches three small
services (orders, inventory, payment) that talk over HTTP *and* a message bus, derives typed,
evidence-classed causal edges between their events, and — given a failed order — reconstructs the
chain that led to it, ranks the most likely origin, and shows the proof.

> **The thesis: causality is *propagated*, not *discovered*.** The hard problem isn't guessing what
> caused what. It's defining a metadata contract that makes causality provable, carrying it across
> HTTP *and* message-broker boundaries, and being honest about what is **proven** versus **derived**
> versus **inferred**. Then measuring what you lose when the metadata goes missing.

It runs on a laptop with **no Docker, no broker, no GPU** — five small Node processes (≈ 0.4 GB working set, measured) and a browser tab.

---

## Quickstart

Requires **Node ≥ 24** (it uses the built-in `node:sqlite` and native TypeScript). Nothing else.

```bash
npm install
npm start            # platform + 3 services; builds the UI on first run
```

Open **http://127.0.0.1:4000**, then:

1. **Seed baseline** — 40 healthy orders teach Causora what "normal" looks like per operation.
2. **Inject & run** the first scenario in the Fault Lab. A failure appears in the table within seconds.
3. Click it. You get the causal graph, a ranked list of candidate origins, and for each one the
   exact path to the failure with the **rule that created every edge and the field values that matched**.
4. Use **"Metadata available to the analyser"** to replay the *same events* with `causation_id`
   removed, or with plain tracing only. Watch the chain fall apart.

Prefer a terminal?

```bash
npm run seed                  # healthy baseline
npm run demo:happy-path       # an order reaches CONFIRMED; 9 events, 9 proven edges
npm run demo:primary-failure  # inject S1, print the ranked investigation + evidence
npm run eval                  # 40 scored runs × 8 rule sets → docs/experiments/results.md
npm run bench                 # → docs/benchmarks/results.md
npm test                      # 59 unit tests, no processes
npm run test:e2e              # boots the real stack on isolated ports (~40 s)
npm run check:docs            # every path/symbol/test name/link cited in the docs resolves
```

---

## The primary scenario (and why it's a real bug, not a staged one)

A delay injected into the inventory handler outlasts the order service's deadline. The order service
**times out and retries**. The retry races the original through a **non-atomic idempotency guard**
(check → slow work → record). Both attempts reserve stock. Payment then rejects the doubled quantity.

```
 order.created#1 ──TRIGGERED──▶ inventory.reserve#1  (1.71 s vs 0.83 ms p95)      ◀── the origin
        │                              │ TIMED_OUT_WAITING_FOR                         ranked #1
        │ RETRY_OF                     ▼
        ▼                       timeout.fired ──▶ order.created#2 ──▶ inventory.reserve#2
   order.created#2                                                          │
                                  inventory.reserve#1 ──DUPLICATE_OF──▶ ────┘  (derived: same key,
                                                                               overlapping, 2 reservations)
   …→ payment.authorize  ERROR RESERVATION_AMOUNT_MISMATCH  →  order.failed   ◀── what the user sees
```

The symptom surfaces in a *different service*, in a *different trace*, seconds later, after a retry.
The guard is a genuine, common correctness bug — the Fault Lab also ships the **corrected guard** as a
control: same fault, order confirmed, and exactly the `DUPLICATE_OF` edge disappears.

Six failure scenarios and a control, each with an automated check (S1–S4 assert their full graph; S5/S6 assert their mechanics):

| | Fault | Failure | Exercises |
|---|---|---|---|
| **S1** | slow inventory handler | `PAYMENT_FAILED` (doubled reservation) | timeout → retry → duplicate across the broker |
| **S2** | slow payment | `PAYMENT_TIMEOUT` | caller gives up while the callee finishes *successfully, later* |
| **S3** | payment returns 503 | `PAYMENT_FAILED` | the easy synchronous case |
| **S4** | handler slower than the whole retry budget | `RETRY_EXHAUSTED` | late-arriving telemetry; completeness is `PROVISIONAL` until it settles |
| **control** | S1's fault + corrected guard | none | the counterfactual |
| **S5** *(held-out)* | handler throws | `RETRY_EXHAUSTED` | an error, not slowness; broker redelivery |
| **S6** *(held-out)* | inventory deliberately rejects (no stock) | `INSUFFICIENT_STOCK` | a *decision* that looks healthy to anomaly scoring |

---

## How it works

### 1 · A contract, enforced by construction

Every `causora.*` attribute and header lives in [`src/contracts`](src/contracts/index.ts) and is imported,
never typed as a string. [`publish()`](src/bus/index.ts) takes `causationId`, `businessOperationId`
and `attempt` as **required parameters** (omitting one is a compile error), and `subscribe()` opens
the causal context before the handler body runs. Two details that make timeouts *provable*:

- **Callers allocate the callee's event id.** HTTP carries it in `x-causora-event-id`; a message
  consumer's id is the deterministic `consume:<message_id>:<group>`. So when a deadline fires, the
  timeout can name *exactly* the event it was waiting for, before that event even exists.
- **The idempotency key reaches telemetry only as a hash.** Equality is preserved (all the duplicate
  rule needs); the raw key never leaves the process.

### 2 · Edges that carry their own evidence

| Class | Example | May it influence ranking? |
|---|---|---|
| **Proven** | `PARENT_OF`, `TRIGGERED`, `RETRY_OF`, `TIMED_OUT_WAITING_FOR` — *a field in the telemetry states it* | yes |
| **Derived** | `DUPLICATE_OF` — a deterministic rule over proven facts | yes |
| **Inferred** | `LIKELY_TRIGGERED` — a heuristic used only where a field is missing | yes, **capped at 0.75** so no chain of guesses can outrank a proven one (tested) |
| **Weak** | `TEMPORAL_PROXIMITY` — co-occurrence | **never** |

Every edge records `derived_by_rule` (versioned) and the **actual matched field values**, so an
engineer can verify a claim without trusting Causora. "Confidence" is a *declared weight by
evidence class*, not a calibrated probability, and the UI shows labels, not percentages.

### 3 · Frontier-based ranking

Walk the ancestor subgraph backwards from the failure, score each event for anomaly against
healthy baselines (self-time latency, own errors, retry density, broker dwell), and find the
**frontier**: anomalous events with *no anomalous ancestor*. The payment error and the failed order
are anomalous too — but each has an anomalous ancestor, so they are effects, not origins. Two small
heuristics keep the origin honest: a caller's timeout/error is *attributed to its callee*, and
latency is measured as self-time (a caller waiting on a slow callee mustn't look slower than it).

Output is a ranked list of **hypotheses with evidence**, a label (`STRONG` / `SUPPORTED` / `WEAK` /
`SPECULATIVE`) derived from *rules about the evidence* (not a score threshold), and mandatory
**caveats** ("2 inferred hops", "telemetry still arriving"). The UI never says "root cause".

### 4 · The ground truth can't leak

The fault injector records what it broke. The ranker receives a `RankableEvent` that structurally
**omits** `experiment_id` and `is_fault_injected`; the evaluation compares the ranking to the
injector's record. Three tests defend this — and I checked they fail by deliberately leaking the
fields into the scorer (3 tests went red) before restoring it.

---

## Results (from real runs — `npm run eval`)

**40 scored failure runs** (10 × 4 scenarios), same stored events replayed through every rule set.
Full table, per-scenario breakdown and hardware: [docs/experiments/results.md](docs/experiments/results.md).

| Metadata the analyser may use | Hit@1 | MRR | Cause reachable | Edge recall | Duplicate bug diagnosed |
|---|---|---|---|---|---|
| Full contract | **100%** | 1.00 | 100% | 100% | 100% |
| − `retry_of_event_id` | 100% | 1.00 | 100% | 100% | 100% |
| − `idempotency_key` | 100% | 1.00 | 100% | 96% | **0%** |
| − `awaited_correlation_id` | 50% | 0.50 | 50% | 93% | 100% |
| − `causation_id` (inference on) | 50% | 0.50 | 50% | 87% | 100% |
| − `causation_id` (inference off) | 25% | 0.25 | 25% | 58% | 0% |
| Tracing only + inference | **0%** | 0.00 | 0% | 66% | 0% |
| Tracing only (what a trace UI shows) | **0%** | 0.00 | 0% | 44% | 0% |

What the table actually says:

- **W3C tracing alone localises none of the 40 failures.** The chain breaks at the broker, which is
  why the contract exists.
- **Not every field buys localisation.** `retry_of` and `idempotency_key` cost nothing in Hit@1 — but
  without `idempotency_key` the system can *find* the slow reservation yet **can no longer diagnose the
  duplicate-reservation bug** (100% → 0%). Each field earns its place differently.
- **Heuristics help, but unevenly.** Inference rescues S1 across the broker (0% → 100%) but cannot
  recover a lost link on a *synchronous reply* (S2/S3 stay at 0%): the rules only bridge consumers.
- The control: **10/10 orders confirmed, 0 `DUPLICATE_OF` edges.**

**Read this before quoting a number:** it is 40 runs of *four* scenario types on a deliberately small
system. It measures reliability and the value of each field; it does **not** claim generalisation to
unseen failures. Runs within a scenario are structurally near-identical, so the ± is mostly
between-scenario spread. Weights are the declared defaults and were not tuned on these results.

### Held-out scenarios: predicted in writing first, analyser frozen

Two heuristics (self-time latency, attributing a caller's error to its callee) were added *after* I watched
S2/S3 fail, so the 40-run table can't show they generalise. So I wrote two new scenarios and my
predictions for them in [docs/experiments/held-out.md](docs/experiments/held-out.md) **before** implementing
either, froze the analyser, and let `npm run eval` grade the predictions mechanically
([results.md](docs/experiments/results.md)). The held-out runs are not in the table above.

| | Predicted | What happened |
|---|---|---|
| **S5** handler throws | ranked correctly; `STRONG`; tracing-only 0%; needs `awaited_correlation_id`; and a *defect*: redeliveries collide on one event id | **6 of 6 confirmed.** Hit@1 100%, `STRONG` ×10, tracing-only 0%, no-`awaited` 0%. The defect was real: **3.0 stored events/run where 9 means every delivery kept** |
| **S6** deliberate rejection | Hit@1 = 0%, top candidate wrongly in the order service; confidently connected | Hit@1 **0%** ✔, but **refuted in detail**: there was *no candidate at all*. The analyser **abstained** (nothing upstream is anomalous; `order.failed` has no baseline). Connected and `COMPLETE` ✔, but "partly" on Q3 since there was no wrong answer to be confident about |

- The defect was fixed **as a defect, not by tuning**: the first delivery keeps its awaitable id, redeliveries
  get `#n`. A unit test pins it (mutation-checked); S5 is unchanged afterwards (9.0 events/run). The pre-fix
  run is preserved in [results-before-redelivery-fix.md](docs/experiments/results-before-redelivery-fix.md).
- **What I changed after seeing results, in full:** that fix; and my grader's Q3 check, which I made *stricter*
  because it had flattered me. The analyser was not touched.
- **The honest limit:** S6 is a failure class the analyser cannot localise — a correct-but-undesired
  *decision*. Abstaining beats guessing, but the user still gets nothing.
- **What this doesn't show:** S5 does not exercise the two heuristics, so it **does not validate them** — and
  that is measured (next table), not assumed. "Held-out" means predicted-first and not tuned-after, not
  independent: one author wrote the app, the analyser and the scenarios.

**What the two fitted heuristics actually buy** (same stored events, each switched off, all 60 failure runs):

| Variant | Hit@1 (60 runs) | S1 | S2 | S3 | S4 | S5 | S6 |
|---|---|---|---|---|---|---|---|
| Both heuristics (shipped) | 83% | 100% | 100% | 100% | 100% | 100% | 0% |
| Without self-time latency | 67% | 100% | **0%** | 100% | 100% | 100% | 0% |
| Without callee error attribution | 50% | 100% | **0%** | **0%** | 100% | 100% | 0% |
| Without either (naive scoring) | 50% | 100% | **0%** | **0%** | 100% | 100% | 0% |

They are **necessary on exactly S2 and S3** — the two scenarios they were fitted to — and change nothing on
S1, S4, S5 or S6. So the ablation shows what they buy, not that they generalise: no scenario I have *not*
already seen fail exercises them. That claim remains unvalidated. (S6 is 0% under every variant: the
analyser abstains, as above.)

**Performance** ([docs/benchmarks/results.md](docs/benchmarks/results.md), single machine, in-process):
~15–17 k events/s through ingest → persist → edge derivation; a 2,000-node investigation in
**6.8 ms p50 / 11 ms p95**. Failure → listed in the API: ≤ 338 ms worst of 5 (the UI polls every 2 s).

---

## Architecture

```
  demo app (the system under study)                         Causora platform (one process)
 ┌────────────────────────────────────────┐   spans      ┌───────────────────────────────────┐
 │ order-service ──HTTP──▶ payment-service │ ───────────▶ │ POST /v1/spans                    │
 │      │  ▲                               │  (OTel-shaped│  normalise (pure) → events table  │
 │ publish  consume                        │   JSON,      │  derive edges (pure rules, per    │
 │      ▼  │                               │   batched)   │  operation, idempotent, handles   │
 │  durable bus ◀──▶ inventory-service     │              │  late arrivals) → edges table     │
 │  (SQLite, Kafka-shaped semantics)       │              │  detect failures → investigate    │
 └────────────────────────────────────────┘              │  REST + serves the React UI       │
        ▲ fault injection (3-gated, TTL'd)               └───────────────────────────────────┘
        └────────────── scenario runner / evaluation harness (owns the ground truth)
```

- **Pure core.** `normalise`, every edge rule and the whole analysis are pure functions: no I/O, no
  clock, no randomness. That is why 59 unit tests need no containers, derivation is idempotent,
  and **replay is just "derive again"** — the ablation is a config file, not a code path.
- **Late and out-of-order telemetry is normal.** Derivation re-runs per business operation on every
  batch, so a consumer that arrives before its producer is linked the moment the producer lands.
  Dangling references are surfaced as *completeness*, never hidden.
- **Fault injection is triple-gated:** explicit opt-in flag, refuses `NODE_ENV=production` even with
  a valid token, and a ≥16-char token from a loopback address. Faults are in-memory, TTL'd, validated,
  and **always cleared in a `finally`** — a failed clear is an error, not a shrug.

### What was built vs. the original blueprint

Re-scoped to three days on a 16 GB laptop ([ADR-0017](DECISIONS.md#adr-0017)). The novel parts —
the contract, the evidence classes, the frontier ranking, injector-as-ground-truth and the ablation —
are intact. The plumbing shrank:

| Blueprint | Built | Consequence |
|---|---|---|
| Redpanda/Kafka | SQLite-backed bus with Kafka-shaped semantics (topics, keys, groups, at-least-once, redelivery) | Not Kafka. The contract lives in message headers, so swapping the transport touches one file. |
| OTel SDK + Collector + Jaeger | A small OTel-*shaped* tracer exporting JSON; W3C `traceparent` on every hop | Not OTLP. The in-app **tracing-only** view replaces the Jaeger comparison. |
| Postgres | `node:sqlite` (WAL) | Zero infrastructure; the recursive-CTE traversal became a bounded in-memory one so ablations don't need writes. |
| API + worker, Kubernetes, k6, Testcontainers, Neo4j | one platform process; none | Fewer moving parts; BM3–8 not run. |
| 8 screens | Failures & Fault Lab, Investigation, Evaluation | No timeline tab, no trace/service explorers. |

---

## Honest limitations

- A **small system by design**: three services, one saga, six failure scenarios. The evaluation is about the
  value of the contract, not a claim of production coverage.
- **The analyser localises anomalies, not decisions.** A correct-but-undesired outcome (S6: an inventory
  rejection) leaves nothing anomalous upstream, so it returns *no candidate*. It abstains instead of guessing,
  but the user gets no answer.
- Two analysis heuristics were fitted after seeing S2/S3 fail. An ablation shows they are necessary on exactly
  those two scenarios and irrelevant elsewhere; **no scenario validates that they generalise.**
- The bus is a **SQLite table**, not a distributed log: no partitions, no scale-out, single node.
- Heuristic weights are **declared, not learned**, and not tuned. Anything resembling a probability is a
  label of evidence class.
- Inference only bridges *consumer* events and orphaned timer-driven events; it cannot recover a
  missing causal link on a synchronous reply (the evaluation shows this).
- Timing is scaled down (1 s deadline, 1.7 s delay) so a full evaluation takes ~30 s. The blueprint's
  5 s-vs-2 s figures would actually trigger *three* attempts, not two — see ADR-0017.
- Telemetry is trusted: the ingest endpoint has no auth (it binds to loopback). See
  [docs/security.md](docs/security.md) for what a deployment would add.

## Verification

| | |
|---|---|
| Unit tests | **59**, no processes; `rules` **100%** and `analysis` **98.5%** line coverage (gate: 80%) |
| End-to-end | **8**, real stack on isolated ports: S1 reproduces ≥ 9/10 with the exact expected chain, rank 1 + `STRONG`, S2–S4 graphs, control, held-out S5/S6 mechanics, fault cleanup, gate |
| Held-out experiment | predictions written before the code; graded mechanically in `docs/experiments/results.md`; one defect found (event-id collision) and fixed with a mutation-checked regression test |
| Integrity | ground-truth leak into the ranker → 3 tests fail (mutation-checked) |
| Conventions as tests | no `Date.now()`, no `causora.*` / header literals outside `contracts`, no direct bus-table access |
| Clean-copy run | `npm install` (5 s) → `npm start` → seed → happy path → primary failure, from a copy with no `node_modules`, `data` or build output |

Not done: a run of the quickstart **by someone other than the author** (see [PROGRESS.md](PROGRESS.md)). The
interview notes in [docs/interview-prep.md](docs/interview-prep.md) are checked mechanically — every path, symbol,
quoted test name and link resolves (`npm run check:docs`).

## Repository map

```
src/contracts/    the causal metadata contract: headers, attributes, taxonomy, rule sets, types, config
src/telemetry/    tracer, async context, injectable clock, HTTP propagation, hashed idempotency keys
src/bus/          durable bus; publish()/subscribe() make the contract impossible to omit
src/services/     order · inventory (the deliberate race lives here) · payment · fault gate + controller
src/platform/     normalise · rules · analysis · engine · store · scenarios · evaluation · server
web/              React UI: Fault Lab, Investigation (React Flow + dagre), Evaluation
scripts/          stack launcher, CLI, benchmarks
test/             unit/ (pure) · e2e/ (real stack)
docs/             design docs (blueprint) + generated experiments/ and benchmarks/ results
```

Design docs from the original blueprint remain in `docs/` and [ARCHITECTURE.md](ARCHITECTURE.md);
where the build diverges, [DECISIONS.md](DECISIONS.md) ADR-0017 and [PROGRESS.md](PROGRESS.md) say so.
