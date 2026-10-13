# The Demo Application - the system under study

> **Build status - blueprint document.** Timing differs from the figures below so a full evaluation takes seconds: deadline **1 s**, injected delay **1.7 s**, settle window **1.5 s** (the 5 s / 2 s ratio shown here would trigger *three* attempts, not two; see [ADR-0017](../../DECISIONS.md#adr-0017)). The "Kafka" bus is a SQLite-backed bus with Kafka-shaped semantics, and consumers handle messages concurrently, which is what makes the race real. Payment is called by the order service from a timer-driven settle step.

Causora needs a distributed system that fails in interesting ways. This document specifies it.

**Design principle: the minimum number of services that produce genuinely different failure
semantics.** Three services and one broker give synchronous chains, asynchronous hops, a
timeout, a retry, a duplicate-work race and a downstream failure. A fourth service
(notifications, shipping) adds a container and zero new semantics, so it is not built.

---

## 1. Services

### 1.1 Order Service

**Responsibility.** Owns the order aggregate and orchestrates the order saga. The only
service the client talks to.

**Data owned** (`app` database, `orders` schema):

| Table | Columns of note |
|---|---|
| `orders` | `id`, `customer_id`, `status`, `total_amount`, `idempotency_key`, `created_at`, `updated_at` |
| `order_items` | `order_id`, `sku`, `quantity`, `unit_price` |
| `saga_state` | `order_id`, `step`, `attempt_number`, `awaiting_correlation_id`, `deadline_at`, `last_event_id` |

`saga_state` is load-bearing for Causora: `awaiting_correlation_id` and `deadline_at` are
what make the timeout edge **provable** rather than guessed.

**HTTP API**

| Method | Path | Purpose |
|---|---|---|
| POST | `/orders` | Create an order and start the saga |
| GET | `/orders/:id` | Order status plus saga state |
| GET | `/healthz` | Liveness |

**Events produced** → topic `orders.events`

| Event type | When |
|---|---|
| `order.created` | Order accepted; requests inventory reservation |
| `order.confirmed` | Payment authorised |
| `order.failed` | Saga terminated unsuccessfully |

**Events consumed** ← topic `inventory.events`: `inventory.reserved`, `inventory.rejected`

**Internal timers.** A watchdog loop (every 250 ms) scans `saga_state` for rows past
`deadline_at` and emits an `order.inventory_wait.timeout` span event, then republishes
`order.created` with `attempt_number + 1` and `retry_of_event_id` set.

**Failure modes**

| Mode | Cause | Observable |
|---|---|---|
| Inventory wait timeout | reservation event not received before `deadline_at` | timeout span event + retry |
| Retry exhaustion | `attempt_number` exceeds `MAX_ATTEMPTS` (3) | `order.failed` with reason `RETRY_EXHAUSTED` |
| Payment rejection | Payment Service returns 4xx/5xx | `order.failed` with reason `PAYMENT_FAILED` |
| Reservation conflict | two distinct `reservation_id`s observed for one order | `order.failed`, reason `DUPLICATE_RESERVATION` |

**Dependencies.** Postgres, Redpanda, Inventory Service (HTTP, read-only queries),
Payment Service (HTTP).

**Scaling characteristics.** Stateless except for the watchdog. The watchdog must not run
in two replicas without leader election - noted as a known single-replica constraint rather
than solved, with the reasoning documented (`SELECT ... FOR UPDATE SKIP LOCKED` is the
intended fix and is a good interview answer).

---

### 1.2 Inventory Service

**Responsibility.** Owns stock levels and reservations. This is where the primary fault is
injected, and where the duplicate-work race lives.

**Data owned** (`app` database, `inventory` schema):

| Table | Columns of note |
|---|---|
| `stock` | `sku`, `available`, `reserved`, `version` |
| `reservations` | `id`, `order_id`, `sku`, `quantity`, `status`, `created_at` |
| `processed_messages` | `idempotency_key`, `message_id`, `reservation_id`, `processed_at` |

`processed_messages` is the idempotency guard. **Its write placement is the deliberate bug
that makes the primary scenario work** - see §3.

**HTTP API**

| Method | Path | Purpose |
|---|---|---|
| GET | `/stock/:sku` | Current availability |
| GET | `/reservations?orderId=` | Reservations for an order |
| POST | `/internal/faults` | Fault control (gated, see security) |
| GET | `/healthz` | Liveness |

Note there is **no** HTTP reservation endpoint. Reservation happens only via the event
consumer. This is intentional: it forces the primary causal chain through the broker, which
is the boundary distributed tracing handles worst and Causora handles best.

**Events produced** → topic `inventory.events`

| Event type | When |
|---|---|
| `inventory.reserved` | Stock successfully reserved |
| `inventory.rejected` | Insufficient stock |

**Events consumed** ← topic `orders.events`: `order.created` (consumer group `inventory-reserver`)

**Failure modes**

| Mode | Cause | Observable |
|---|---|---|
| Processing delay | injected sleep in handler | span duration far above baseline; consumer lag grows |
| Duplicate reservation | retry arrives while attempt 1 is inside its idempotency race window | two `reservations` rows for one `order_id` |
| Insufficient stock | genuine stock exhaustion, including exhaustion *caused by* duplicate reservation | `inventory.rejected` |
| Consumer crash | injected process exit | offsets not committed; messages redelivered |

**Scaling characteristics.** Partitioned by `order_id` as the Kafka message key, so all
events for one order land on one partition and are processed in order. This matters: it
means the duplicate race is a *concurrency* race within one partition's consumer, not a
cross-partition ordering artefact. Document that distinction - interviewers probe it.

---

### 1.3 Payment Service

**Responsibility.** Authorises payment. Exists to place the *symptom* far from the *cause*,
which is the entire point of the product.

**Data owned** (`app` database, `payments` schema):

| Table | Columns of note |
|---|---|
| `payments` | `id`, `order_id`, `amount`, `status`, `reservation_ids`, `idempotency_key` |

**HTTP API**

| Method | Path | Purpose |
|---|---|---|
| POST | `/payments/authorize` | Authorise a payment for an order |
| GET | `/payments/:id` | Payment status |
| POST | `/internal/faults` | Fault control (gated) |
| GET | `/healthz` | Liveness |

`POST /payments/authorize` takes `{ orderId, amount, reservationIds[], idempotencyKey }`
and **validates that the reserved quantity matches the ordered quantity.** When a duplicate
reservation exists, the reserved total is double the order total, and payment rejects with
`RESERVATION_AMOUNT_MISMATCH`. That is the failure the user sees, four hops from its cause.

**Events produced.** None. Payment is synchronous by design, to show that Causora handles
mixed sync/async topologies.

**Failure modes**

| Mode | Cause | Observable |
|---|---|---|
| Amount mismatch | reserved total ≠ order total | 422 `RESERVATION_AMOUNT_MISMATCH` |
| Timeout | injected latency above the caller's deadline | caller-side timeout; server span completes later |
| Provider error | injected 5xx | 502 `PROVIDER_UNAVAILABLE` |

---

## 2. The happy path

```
1. POST /orders                               Order Service
     create order (PENDING), write saga_state (step=AWAIT_INVENTORY,
     deadline_at = now + 2s, awaiting_correlation_id = <order.created event_id>)
     produce order.created -> orders.events   key = order_id

2. consume order.created                      Inventory Service   (~40 ms)
     check processed_messages[idempotency_key]
     reserve stock, insert reservation
     insert processed_messages
     produce inventory.reserved -> inventory.events
       causation_id = <order.created event_id>      <-- the provable async edge

3. consume inventory.reserved                 Order Service
     match saga_state by business_operation_id
     POST /payments/authorize                 Payment Service
     reserved total == order total -> AUTHORIZED

4. order.status = CONFIRMED
   produce order.confirmed
```

Total latency on a developer laptop: roughly 150–250 ms.

---

## 3. The primary failure scenario - and why it is a *real* bug

**Fault injected:** `inventory.handler.delay = 5000ms` on the `order.created` consumer.

```
t=0.00  Order Service   create order, deadline_at = t+2.0s
                        produce order.created (attempt 1, idempotency_key=K)

t=0.05  Inventory       consume attempt 1
                        processed_messages[K] -> MISS
                        <<< injected 5s delay inside the handler >>>
                        (reservation not yet written, processed_messages[K] not yet written)

t=2.00  Order Service   watchdog: deadline_at passed, no inventory.reserved received
                        emit order.inventory_wait.timeout
                          awaited_correlation_id = <attempt 1 event_id>   <-- provable
                        produce order.created (attempt 2, idempotency_key=K,
                          retry_of_event_id = <attempt 1 event_id>)       <-- provable

t=2.05  Inventory       consume attempt 2 concurrently with attempt 1
                        processed_messages[K] -> STILL A MISS
                        <<< injected 5s delay >>>

t=5.05  Inventory       attempt 1 completes: insert reservation R1,
                        insert processed_messages[K]
                        produce inventory.reserved (reservation_id = R1)

t=7.05  Inventory       attempt 2 completes: insert reservation R2
                        (the handler read processed_messages BEFORE the delay,
                         so it does not re-check)                          <-- the bug
                        insert processed_messages ON CONFLICT DO NOTHING
                        produce inventory.reserved (reservation_id = R2)

        Stock is now decremented twice for one order.

t=5.06  Order Service   consume inventory.reserved (R1)
                        POST /payments/authorize  reservationIds=[R1]
                        -> AUTHORIZED? No: see below

t=7.06  Order Service   consume inventory.reserved (R2)
                        second reserved event for the same order
                        POST /payments/authorize  reservationIds=[R1, R2]
                        reserved total (2x) != order total (1x)
                        -> 422 RESERVATION_AMOUNT_MISMATCH

                        order.status = FAILED, reason = PAYMENT_FAILED
```

To keep the scenario deterministic, the Order Service holds payment until the saga's
expected reservation set is stable (a short 500 ms settle window) so both reserved events
are observed before authorisation. This is documented in `saga_state.step = SETTLING`.

### Why this bug is realistic, not contrived

The Inventory handler does:

```
1. read processed_messages[K]        <- check
2. ... do work (slow) ...
3. insert reservation               <- act
4. insert processed_messages[K]     <- record
```

That is a **check-then-act race with a non-atomic idempotency guard** - one of the most
common correctness bugs in real event-driven systems. The correct implementation inserts
the idempotency record *first*, in the same transaction as the reservation, and relies on a
unique-constraint violation to detect the duplicate. The demo ships the buggy version on
purpose, and `docs/experiments/fault-injection.md` defines a scenario variant that enables
the correct version, so you can demonstrate that Causora's graph changes accordingly.

**This matters for interviews.** You are not showing a toy failure; you are showing that
you understand why idempotency guards must be transactional.

### The causal chain Causora must reconstruct

| # | From | To | Edge type | Class | Evidence |
|---|---|---|---|---|---|
| 1 | `fault.injected(inventory.delay)` | `inventory.reserve#1` | `FAULT_AFFECTED` | Proven | injector record: service, operation, time window |
| 2 | `order.created#1` | `inventory.reserve#1` | `TRIGGERED` | Proven | `causation_id` = producer `event_id` |
| 3 | `inventory.reserve#1` | `order.inventory_wait.timeout` | `TIMED_OUT_WAITING_FOR` | Proven | `awaited_correlation_id` |
| 4 | `order.inventory_wait.timeout` | `order.created#2` | `RETRY_OF` | Proven | `retry_of_event_id`, `attempt_number` 1→2 |
| 5 | `order.created#2` | `inventory.reserve#2` | `TRIGGERED` | Proven | `causation_id` |
| 6 | `inventory.reserve#1` | `inventory.reserve#2` | `DUPLICATE_OF` | Derived | same `idempotency_key`, overlapping intervals, distinct `reservation_id` |
| 7 | `inventory.reserve#2` | `payment.authorize` | `TRIGGERED` | Proven | `causation_id` via `inventory.reserved#2` |
| 8 | `payment.authorize` | `order.failed` | `PARENT_OF` / explicit | Proven | span parentage + error reference |

Eight edges, seven of them provable, one derived by a deterministic rule. **Zero inferred
edges in the primary scenario.** That is the point: when the contract is honoured, the graph
is not guesswork. The ablation experiment then removes `causation_id` and forces edges 2, 5
and 7 to be re-derived as *inferred*, and measures the cost.

---

## 4. Cross-cutting implementation requirements

Every service must:

1. **Bootstrap telemetry from `packages/telemetry`** before any other import, so
   instrumentation hooks are installed first.
2. **Use `packages/kafka` wrappers, never KafkaJS directly.** The wrappers set and read the
   causal headers by construction, so a developer cannot forget them. This is the single
   most important code-level guarantee in the project.
3. **Validate every inbound payload with the Zod schema from `packages/contracts`.**
4. **Carry a deadline.** HTTP clients send `x-causora-deadline-ms`; handlers wire it into an
   `AbortController`. Timeout propagation is a design requirement, not an accident.
5. **Expose `POST /internal/faults`** guarded as described in `docs/security.md`.
6. **Emit a structured log on every state transition** with trace context attached, so logs
   are joinable to spans.
7. **Never log** `idempotency_key` values, customer identifiers or amounts in free text;
   they belong in redaction-aware span attributes.

### Fault control surface (per service)

```
POST /internal/faults
{
  "faults": [
    { "type": "handler_delay",  "target": "order.created",       "ms": 5000 },
    { "type": "http_latency",   "target": "POST /payments/authorize", "ms": 3000 },
    { "type": "error_response", "target": "POST /payments/authorize", "status": 503, "rate": 1.0 },
    { "type": "crash_after",    "target": "order.created",       "count": 1 },
    { "type": "clock_offset",   "ms": 1500 }
  ],
  "ttlSeconds": 60,
  "experimentId": "exp_01HX..."
}
```

Faults are held **in memory only**, expire via TTL, and are reported by
`GET /internal/faults` so the UI can show active faults. `experimentId` is echoed into the
telemetry of every affected operation, which is how the injector becomes ground truth.
