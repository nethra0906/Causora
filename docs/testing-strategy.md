# Testing Strategy

> **Build status — blueprint document.** Built with `node:test` (no Vitest, Testcontainers or Playwright): 59 unit tests with no processes and 8 end-to-end tests that boot the real stack on isolated ports. Convention rules (no `Date.now()`, no contract literals outside `contracts`) are enforced as tests rather than ESLint rules. UI journeys were exercised manually in a browser, not by Playwright.

A 4–6 week part-time budget cannot support exhaustive testing. It can support **testing
concentrated where correctness actually matters**, which is a better answer anyway.

Priority order: edge rules → analysis → the scenario E2E → everything else.

| Layer | Tool | Count (target) | Runs in |
|---|---|---|---|
| Unit | Vitest | ~140 | < 10 s, no containers |
| Integration | Vitest + Testcontainers | ~25 | < 90 s |
| Contract | Vitest + Zod | ~15 | < 5 s |
| E2E scenario | Vitest + full Compose | ~6 | < 4 min |
| Frontend component | Vitest + Testing Library | ~20 | < 20 s |
| Frontend E2E | Playwright | ~3 | < 2 min |
| Concurrency | Vitest, fake timers + real races | ~8 | < 30 s |
| Performance | k6 | 4 scripts | manual / CI nightly |

---

## 1. Unit tests — where the thinking is

### 1.1 Edge rules (highest value in the project)

Nine rules, each tested against the in-memory `CorrelationLookup` — **no database, no
containers, millisecond feedback**. This is why the lookup port exists.

Per rule: the positive case, each negative case, and the boundary. Specifically:

| Rule | Must test |
|---|---|
| `rule.parent.span` | match; no parent; parent not yet ingested (no edge, no throw) |
| `rule.triggered.causation_id` | match; absent `causation_id`; dangling reference |
| `rule.retry.explicit` | match; `attempt_number > 1` with missing `retry_of_event_id` → recorded as a violation, not an edge |
| `rule.timeout.awaited` | match; non-timeout event with the field set (must not fire) |
| `rule.fault.window` | inside window; outside window; right service wrong operation; matching `experiment_id` but different service |
| `rule.duplicate.idempotency` | disjoint resource ids → 0.90; identical resource ids → **no edge** (guard worked); missing resource ids → 0.70 with a note; outside `retry_window_ms` → no edge; **direction canonicalisation under equal timestamps** |
| `rule.triggered.inferred` | exact topic/partition/offset → 0.75; single key candidate → 0.65; 2–5 candidates → 0.45 and ambiguity flagged; >5 → **no edge** and a completeness gap |
| `rule.retry.inferred` | match; explicit field present → must **not** fire (no duplicate edge) |
| `rule.proximity` | disabled by default; when enabled, never emitted if any other path exists |

**Property tests** (fast-check):

- No rule ever emits a self-loop.
- No rule emits `confidence > MAX_INFERRED_CONFIDENCE` for an inferred edge.
- `DUPLICATE_OF` direction is stable under input permutation.
- Running the full rule set twice over the same events produces an identical edge set
  (idempotence).

### 1.2 Normalisation

Pure function, tested against **committed OTLP fixtures captured from real runs** via the
collector's file exporter — never hand-written OTLP, which diverges from what the SDK emits.

Cases: span → event; span event filtering; log below ERROR → not a node; log at ERROR with
trace context → node; missing contract fields → recorded in `contract_violations`, event still
produced; malformed payload → rejection record, no throw; **stable `event_id` across two
normalisations of the same input** (the property that makes replay safe).

### 1.3 Analysis

| Module | Must test |
|---|---|
| `score` | each signal in isolation; `baseline_unavailable` → latency contributes 0; saturation clamps |
| `frontier` | linear chain; diamond; disconnected anomalies; all-anomalous (fallback path); SCC supernode scoring = max of members |
| `rank` | ordering; full tie-break chain to `event_id`; determinism over 100 shuffled input orderings |
| `label` | each of the four labels at its boundary conditions |
| `scope` | depth bound; node bound sets `truncated`; cycle guard terminates; `MIN_PATH_CONFIDENCE` prunes |
| `patterns` | each of the six patterns, positive and negative; **bonus applied only to the causally earliest member** |

**The two integrity tests** — these protect the project's central claim and must never be
deleted:

```ts
it('ranking ignores is_fault_injected and experiment_id', () => {
  const clean  = rank(subgraph, config)
  const marked = rank(withFaultFlagsSet(subgraph), config)
  expect(marked).toEqual(clean)          // byte-identical
})

it('no chain of inferred edges can outrank a proven chain', () => {
  // 5 inferred hops at MAX_INFERRED_CONFIDENCE vs 1 proven hop,
  // anomaly scores held equal
  expect(rank(graph, config)[0].eventId).toBe(provenCandidateId)
})
```

### 1.4 Demo application logic

Saga transitions, deadline computation, the retry decision, the amount-mismatch check in
Payment, and the `FaultController` TTL behaviour (fake timers).

---

## 2. Integration tests (Testcontainers)

Real Postgres and real Redpanda. No mocks at this layer — a mocked broker tests the mock.

| Area | Tests |
|---|---|
| Repositories | each query; `ON CONFLICT` idempotence verified by double-insert |
| Recursive CTE | known fixture graph; depth bound; node bound; cycle; confidence pruning; `EXPLAIN` asserts the expected index is used |
| Ingest | OTLP protobuf accepted; JSON accepted; oversized rejected 413; duplicate envelope → one event set; bad auth → 401 |
| Pipeline | envelope in → events, correlations and edges out, in one transaction |
| Late arrival | consumer event ingested **before** its producer → no edge; producer arrives → re-derivation creates it |
| Replay | mark processed envelopes pending, re-enqueue, assert identical final graph |
| Kafka semantics | worker killed mid-batch → messages redelivered → graph identical (at-least-once safety) |
| Baselines | computed from succeeded operations only; failed traffic excluded |

The late-arrival and replay tests are the ones that catch real bugs. Ordering assumptions are
the most common source of defects in this kind of pipeline, and a test that ingests
deliberately backwards is the only reliable way to find them.

---

## 3. Contract tests

The ingestion boundary and the API boundary are the contracts that matter.

- Zod round-trip for every schema in `packages/contracts`.
- A **golden-file test** per API endpoint: committed response fixtures, so an accidental shape
  change fails CI instead of silently breaking the UI.
- A test asserting that every `causora.*` attribute name in the demo services comes from the
  `CAUSAL_HEADERS` / `CAUSAL_ATTRS` constants, not from a string literal. This is what keeps
  the contract from drifting.
- Schema-version compatibility: an event at `schema_version: 1` still normalises when the
  current version is 2.

---

## 4. E2E scenario tests — the Definition-of-Done tests

Full Compose stack. One test per scenario, using `packages/testkit` assertions.

```ts
it('delayed_inventory produces the expected causal chain', async () => {
  const run = await runScenario('delayed_inventory', { delayMs: 5000, orderCount: 1 })
  await waitForCompleteness(run.businessOperationIds[0], 'COMPLETE')

  const failure = await getFailure(run)
  expect(failure.errorType).toBe('RESERVATION_AMOUNT_MISMATCH')

  const graph = await getGraph(run.businessOperationIds[0])
  expectChain(graph, [
    { op: 'order.created',      attempt: 1 },
    { op: 'inventory.reserve',  attempt: 1, via: 'TRIGGERED',              class: 'proven' },
    { op: 'timeout.fired',                   via: 'TIMED_OUT_WAITING_FOR', class: 'proven' },
    { op: 'order.created',      attempt: 2, via: 'RETRY_OF',               class: 'proven' },
    { op: 'inventory.reserve',  attempt: 2, via: 'TRIGGERED',              class: 'proven' },
  ])
  expectEdge(graph, { from: 'inventory.reserve#1', to: 'inventory.reserve#2',
                      type: 'DUPLICATE_OF', evidenceClass: 'derived' })
  expectNoEdgeOfClass(graph, 'inferred')      // the contract was honoured
  expectConcurrent(graph, 'inventory.reserve#1', 'inventory.reserve#2')

  const inv = await investigate(failure.eventId)
  expect(inv.candidates[0].service).toBe('inventory-service')
  expect(inv.candidates[0].operation).toBe('inventory.reserve')
  expect(inv.candidates[0].label).toBe('STRONG')
  expect(inv.patterns.map(p => p.pattern))
    .toEqual(expect.arrayContaining(['DUPLICATE_WORK', 'IDEMPOTENCY_FAILURE']))
})
```

Plus the **control test**, which is the most persuasive test in the suite:

```ts
it('inventory_fix: same fault, correct idempotency guard, no duplicate and no failure', async () => {
  const run = await runScenario('inventory_fix', { delayMs: 5000, orderCount: 1 })
  expect(await getOrderStatus(run)).toBe('CONFIRMED')
  const graph = await getGraph(run.businessOperationIds[0])
  expectEdge(graph, { type: 'RETRY_OF' })              // the retry still happened
  expectNoEdge(graph, { type: 'DUPLICATE_OF' })        // the guard worked
  expect(await getFailures(run)).toHaveLength(0)
})
```

Flakiness policy: E2E tests wait on **state**, never on sleeps. `waitForCompleteness` polls the
completeness verdict; `waitForTerminalOrder` polls order status. A scenario test containing a
bare `sleep` is rejected in review — timing-based E2E tests in a system whose whole subject is
timing will flake forever.

---

## 5. Concurrency tests

The project is about concurrency, so this layer earns its place.

| Test | Method |
|---|---|
| Idempotency race (the demo bug) | two handlers for one `idempotency_key` released simultaneously via a barrier; assert two reservations in the buggy variant, one in the fixed variant |
| Watchdog double-fire | two watchdog ticks on one saga row; assert exactly one retry published |
| Ingest concurrency | 500 envelopes with overlapping events in parallel; assert final event and edge counts exactly match the sequential result |
| Re-derivation vs ingest | continuous ingest while the sweep runs; assert no duplicate edges and no lost edges |
| Analysis during ingest | run an investigation while 1,000 events/s arrive; assert the result matches the same investigation run on a quiesced system |
| Event loop starvation | retry-storm subgraph traversal; assert no Kafka rebalance occurs (the `setImmediate` yield is load-bearing) |
| Graceful shutdown | SIGTERM mid-batch; assert no offset committed for an uncommitted transaction |

The last two are the tests that would catch the bugs most likely to embarrass a live demo.

---

## 6. Frontend tests

**Component (Vitest + Testing Library).** Evidence class renders the correct line style *and*
text label; `ConfidenceLabel` never renders a percentage (asserted by regex — this guards a
product principle in code); every empty and error state renders its copy; concurrent events
render in separate lanes; `Caveats` renders when present and is visible without scrolling.

**E2E (Playwright), three journeys only:**

1. Overview → failure card → Investigation → select edge → evidence shows matched field values.
2. Fault Lab → run `delayed_inventory` → progress advances → Investigate → rank 1 is the
   inventory reservation.
3. Reveal-fault toggle: off by default, flask badge appears when on, `FAULT_AFFECTED` edges
   appear, candidate ranking **does not change** (a UI-level restatement of the integrity rule).

---

## 7. Performance tests (k6)

Scripts in `bench/`, methodology in `docs/benchmarks/plan.md`. They produce the numbers; they
are not pass/fail gates except for two regression guards: ingest throughput must not drop more
than 20% from the committed baseline, and investigation p95 at 2,000 nodes must stay under 2 s.

---

## 8. Security tests

The seven fault-injection gate tests in `docs/security.md` §3, plus: read token rejected on
write endpoints; ingest token rejected on read endpoints; redaction verified end-to-end by
sending a span carrying `db.statement` and `payment.card_number` through the real Collector
and asserting neither reaches `events`; `limit=10000` rejected; a SQL metacharacter in a
filter returns a normal empty result rather than an error; 5xx responses contain no stack
trace.

The end-to-end redaction test is the important one — unit-testing the collector config is not
possible, and a redaction rule that silently stops matching is a privacy incident.

---

## 9. CI

```
on push:   lint -> typecheck -> unit -> contract          (target < 2 min)
on PR:     + integration (Testcontainers)                 (target < 5 min)
on main:   + E2E scenarios + frontend E2E                 (target < 12 min)
nightly:   + k6 benchmarks -> commit results to bench/results/
```

Coverage gates: `platform/worker/rules` ≥ 90%, `platform/worker/analysis` ≥ 85%, overall ≥ 70%.
High gates only where correctness is the product; a uniform 90% target across a React codebase
would be busywork that crowds out the tests above.
