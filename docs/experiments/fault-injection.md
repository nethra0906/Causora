# Fault Injection Design

> **Build status — blueprint document.** Built: S1 (inventory delay → duplicate), S2 (payment latency), S3 (payment 503), S4 (retry exhaustion) and the `inventory-fix` control. Not built: crash-after and clock-offset scenarios (the clock-offset fault type exists, no scenario uses it) and S5–S7. Timing is scaled as described in the demo-application note. A fault `target` is the logical **operation name** (e.g. `inventory.reserve`), not a route.

Fault injection serves two purposes, and the second one is the important one:

1. It makes failures **reproducible**, so the demo works every time.
2. It makes failures **labelled**, so root-cause ranking can be **measured**.

Purpose 2 is what elevates Causora from a visualisation to an evaluated system. Design for it
from the first commit; retrofitting ground truth later is painful.

---

## 1. Mechanism

Each demo service runs an in-process `FaultController`:

```ts
interface FaultController {
  apply(faults: Fault[], ttlSeconds: number, experimentId: string): void
  clear(): void
  active(): Fault[]
  /** Called at each injection point. Returns the matching fault or null. */
  check(kind: FaultKind, target: string): Fault | null
}
```

Properties, all deliberate:

- **In memory only.** Nothing persists. A restart clears all faults. A fault cannot survive
  into a state nobody intended.
- **TTL-expiring.** Default 60 s, hard maximum 300 s. A forgotten fault expires itself.
- **Narrowly targeted.** `target` is an exact operation name, never a wildcard. There is no
  "fail everything" mode.
- **Experiment-tagged.** Every affected operation stamps `causora.experiment_id`, which is how
  ground truth links to telemetry.
- **Observable.** `GET /internal/faults` and `GET /api/v1/experiments/active-faults` so the UI
  can always show what is currently broken on purpose.

### Injection points

| Fault kind | Injection point | Implementation |
|---|---|---|
| `handler_delay` | start of a Kafka message handler | `await sleep(ms)` before the work, inside the span |
| `http_latency` | HTTP route handler entry | `await sleep(ms)` before the handler body |
| `error_response` | HTTP route handler entry | return the configured status, with `rate` sampling |
| `crash_after` | after N handled messages | `process.exit(1)` — uncommitted offsets cause redelivery |
| `clock_offset` | the service's time source | an injected `now()` shifted by `ms`; all timestamps shift |
| `consumer_pause` | consumer loop | `consumer.pause()` for `ms`, which grows broker lag |
| `duplicate_publish` | producer wrapper | publish the same message twice with distinct `message_id` |

`clock_offset` requires that **no service calls `Date.now()` directly** — all time goes
through an injected clock from `packages/telemetry`. Enforce with an ESLint rule
(`no-restricted-globals`). This is the kind of constraint that is trivial on day one and
miserable to add in week four.

---

## 2. Scenarios

Declarative definitions in `experiments/scenarios/*.ts`, so adding a scenario is data, not code.

```ts
interface ScenarioDefinition {
  id: string
  title: string
  description: string
  faults: Array<{ service: string; fault: Fault }>
  workload: { kind: 'orders'; count: number; ratePerSecond?: number }
  groundTruth: {
    service: string
    operation: string
    faultType: FaultKind
    expectedPatterns: PatternId[]
    expectedEdges: Array<{ fromType: string; toType: string; edgeType: EdgeType }>
  }
  expectedDurationMs: number
  mvp: boolean
}
```

`groundTruth.expectedEdges` doubles as the automated graph assertion and as the denominator
for the graph-completeness metric. One declaration, two uses.

### S1 — `delayed_inventory` ⭐ PRIMARY DEMO SCENARIO · MVP

| | |
|---|---|
| **Trigger** | `handler_delay` 5000 ms on `inventory-service` / `order.created` |
| **Workload** | 1 order |
| **Expected behaviour** | Reservation stalls → order watchdog times out at 2 s → retry → both attempts run concurrently through the broken idempotency guard → two reservations → payment rejects on amount mismatch |
| **Expected telemetry** | ~34 events, 4 services' worth of spans, 1 timeout span event, 1 `idempotency.miss` at attempt 2, 2 `inventory.reserved` messages |
| **Expected graph** | The 8 edges in `docs/architecture/demo-application.md` §3; 7 proven, 1 derived, 0 inferred |
| **Expected failure** | `payment-service` 422 `RESERVATION_AMOUNT_MISMATCH`; order `FAILED` |
| **Expected analysis** | Rank 1 = `inventory-service` / `inventory.reserve` attempt 1, label `STRONG`; patterns `DUPLICATE_WORK` + `IDEMPOTENCY_FAILURE` |
| **Demo narration** | "Payment failed. Jaeger shows a 300 ms payment span that looks fine and a trace that ends at the broker. Causora shows the chain: a 5-second reservation 7 seconds earlier, a timeout, a retry, two concurrent reservations, and the duplicate. Here is the evidence for each link. Now re-run it." |

**Why this is the primary scenario.** The symptom is four hops from the cause, in a different
trace, after an intervening retry, with two concurrent operations that a waterfall renders
misleadingly — every weakness of conventional tracing in one failure, with a genuinely
realistic underlying bug.

### S2 — `payment_timeout` · MVP

| | |
|---|---|
| **Trigger** | `http_latency` 3000 ms on `payment-service` / `POST /payments/authorize`; caller deadline 1500 ms |
| **Expected behaviour** | Order times out waiting on payment; payment *succeeds server-side after the client gave up* |
| **Expected graph** | `TIMED_OUT_WAITING_FOR` from the payment server span to the order timeout event; concurrent group showing the server span outliving the client |
| **Expected analysis** | Rank 1 = payment authorise span, label `SUPPORTED` (no pattern bonus), pattern `TIMEOUT_CASCADE` if the retry also times out |
| **Teaching value** | The classic orphaned-success: the client believes it failed, the server believes it succeeded. Causora shows both and shows they are concurrent, not ordered. |

### S3 — `slow_consumer` · MVP

| | |
|---|---|
| **Trigger** | `consumer_pause` 8000 ms on `inventory-service` / `orders.events` |
| **Workload** | 20 orders at 5/s |
| **Expected behaviour** | Broker lag builds; every order's reservation dwells; many time out and retry simultaneously |
| **Expected graph** | High `dwell_ms` on consume events; a retry cluster per order |
| **Expected analysis** | Pattern `SLOW_CONSUMER` with dwell evidence; `RETRY_STORM` once chains reach 3 |
| **Teaching value** | Distinguishes *the operation was slow* from *the message waited*. Those have completely different fixes, and `dwell_ms` is the only way to tell them apart. Jaeger cannot show this at all. |

### S4 — `consumer_crash` · post-MVP

| | |
|---|---|
| **Trigger** | `crash_after` 1 message on `inventory-service` |
| **Expected behaviour** | Offsets uncommitted → redelivery after rebalance → duplicate processing |
| **Expected graph** | Two consume events, same `message_id`, distinct spans, `DUPLICATE_OF` derived |
| **Teaching value** | At-least-once delivery is not a theoretical concern. Also exercises the ingestion gap while the service is down, which should surface as `PROVISIONAL` completeness. |

### S5 — `retry_storm` · post-MVP

| | |
|---|---|
| **Trigger** | `error_response` 503 at rate 1.0 on `payment-service`; `MAX_ATTEMPTS` raised to 8; 25 orders |
| **Expected behaviour** | ~200 retry events |
| **Expected graph** | Large retry clusters; tests `MAX_SUBGRAPH_NODES`, SCC collapse and UI clustering |
| **Expected analysis** | Rank 1 must be the payment 503, **not** any of the 200 retries — this is the test of the "pattern bonus goes to the earliest member" rule |
| **Teaching value** | Scale and the correct handling of symptom-vs-cause under high fan-out. Also where performance bottlenecks will first appear. |

### S6 — `clock_offset` · post-MVP

| | |
|---|---|
| **Trigger** | `clock_offset` +1500 ms on `inventory-service`, plus the S1 delay |
| **Expected behaviour** | Inventory timestamps are 1.5 s ahead; `dwell_ms` becomes nonsensical (possibly negative) |
| **Expected graph** | **Identical proven edges to S1** — because proven edges never use wall clock |
| **Expected analysis** | Same rank 1; `dwell` contribution zeroed and a caveat `"clock skew detected: dwell unreliable"` |
| **Teaching value** | The payoff for the "time is evidence, not truth" design rule. This scenario is the proof that the rule was followed, and it is the best single answer to "how do you handle clock skew?" |

### S7 — `inventory_fix` (control) · post-MVP

Same fault as S1, but the Inventory Service runs the **correct** transactional idempotency
guard (`INSERT processed_messages` first, in the same transaction, catching the unique
violation).

| | |
|---|---|
| **Expected behaviour** | Attempt 2 hits the unique constraint, emits `idempotency.hit`, publishes nothing new. One reservation. Payment succeeds. Order `CONFIRMED` despite the 5-second delay. |
| **Expected graph** | Timeout and retry edges present; **no `DUPLICATE_OF` edge**; no failure |
| **Teaching value** | The strongest beat in the whole demo. Same injected fault, correct idempotency implementation, no failure — and Causora's graph shows exactly which edge disappeared. It demonstrates that the tool is measuring something real about the system rather than rendering a fixed story. |

---

## 3. Scenario runner

`experiments/runner/` drives a scenario end to end:

```
1. Create fault_experiments row with ground_truth. Status RUNNING.
2. POST /internal/faults to each targeted service, with experimentId and TTL.
3. Verify faults are active (GET /internal/faults) — fail loudly if not.
4. Drive the workload against Order Service, recording the business operation ids.
5. Wait for terminal order state, or scenario timeout.
6. Clear all faults (and again in a finally block — never leave a fault active).
7. Wait for telemetry quiescence (completeness verdict leaves PROVISIONAL, max 15 s).
8. For each failure found, POST /api/v1/investigations with the scenario's ruleSetId.
9. Record business_operation_ids and investigation ids on the experiment. Status COMPLETE.
10. If evaluation mode: compute Hit@k, MRR and completeness, write evaluation_results.
```

Step 6's `finally` block matters: an aborted scenario that leaves a 5-second delay injected
will make every subsequent demo mysteriously broken. Also enforced by the TTL, belt and braces.

Step 7 matters because investigating before telemetry settles produces a `PROVISIONAL`
verdict and an unstable ranking — which would make the evaluation noisy and the numbers wrong.

---

## 4. Safety

Fault injection is a deliberate availability-destruction capability. Gating, in full:

| Gate | Where |
|---|---|
| `CAUSORA_ALLOW_FAULT_INJECTION=true` | Causora API + each service; default **false** |
| `NODE_ENV !== 'production'` | hard refusal, not overridable by config |
| `CAUSORA_EXPERIMENT_TOKEN` | separate from read and write tokens |
| Service `/internal/faults` bound to the compose-internal network only | not published in `docker-compose.yml` |
| TTL ≤ 300 s, enforced server-side | `FaultController` |
| No wildcard targets | validated at the Zod schema level |
| Audit log line per application and clear | includes experimentId, actor token id, targets |

All three primary gates are checked in **one** module (`experiments/guard.ts`) with a unit
test per gate, including a test asserting that `NODE_ENV=production` refuses even when the
other two gates pass. Scattering this logic across call sites is how a debugging tool becomes
an attack surface. See `docs/security.md`.
