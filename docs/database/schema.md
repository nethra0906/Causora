# Database Design

> **Build status - blueprint document.** Built on SQLite with a smaller schema: `events` (indexed columns plus a JSON document), `edges`, `business_operations`, `failures`, `investigations`, `baselines`, `experiment_runs`, `evaluation_runs` (see `src/platform/store.ts`). Not built: `raw_telemetry`, `event_correlations`, `patterns_detected`, partitioning. Replay is "derive edges again" from stored events.

One PostgreSQL 16 instance, two databases: `app` (the system under study) and `causora` (the
platform). Separate databases, not schemas, so the demo app's load and the platform's load are
visibly independent and either can be reset without the other.

Rationale for Postgres-only: [ADR-0003](../../DECISIONS.md#adr-0003).

Migrations: plain numbered SQL files in `infra/postgres/migrations/`, applied by a small
runner on startup. No ORM-driven migrations - the schema is the design and it should be
readable as SQL.

---

## 1. `app` database (demo application)

Owned by the services, never read by Causora. Separation is enforced by distinct credentials.

```sql
-- ============ orders schema (Order Service) ============
CREATE TABLE orders (
  id               TEXT PRIMARY KEY,             -- also the business_operation_id
  customer_id      TEXT NOT NULL,
  status           TEXT NOT NULL,                -- PENDING|SETTLING|CONFIRMED|FAILED
  total_amount     NUMERIC(12,2) NOT NULL,
  failure_reason   TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id   TEXT NOT NULL REFERENCES orders(id),
  sku        TEXT NOT NULL,
  quantity   INT  NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (order_id, sku)
);

CREATE TABLE saga_state (
  order_id                TEXT PRIMARY KEY REFERENCES orders(id),
  step                    TEXT NOT NULL,     -- AWAIT_INVENTORY|SETTLING|AWAIT_PAYMENT|DONE
  attempt_number          INT  NOT NULL DEFAULT 1,
  awaiting_correlation_id TEXT,              -- makes the timeout edge PROVABLE
  deadline_at             TIMESTAMPTZ,
  observed_reservations   TEXT[] NOT NULL DEFAULT '{}',
  last_event_id           TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the watchdog's query; SKIP LOCKED documents the multi-replica path
CREATE INDEX saga_state_deadline_idx ON saga_state (deadline_at)
  WHERE step IN ('AWAIT_INVENTORY','AWAIT_PAYMENT');

-- ============ inventory schema (Inventory Service) ============
CREATE TABLE stock (
  sku       TEXT PRIMARY KEY,
  available INT NOT NULL CHECK (available >= 0),
  reserved  INT NOT NULL DEFAULT 0,
  version   INT NOT NULL DEFAULT 0            -- optimistic locking
);

CREATE TABLE reservations (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL,
  sku        TEXT NOT NULL,
  quantity   INT  NOT NULL,
  status     TEXT NOT NULL,                   -- HELD|RELEASED|CONSUMED
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reservations_order_idx ON reservations (order_id);

-- The idempotency guard. NOTE: the demo deliberately writes this row AFTER
-- doing the work, which is the check-then-act bug the primary scenario exploits.
-- The corrected variant (scenario `inventory_fix`) writes it in the same
-- transaction BEFORE the work and relies on this unique constraint.
CREATE TABLE processed_messages (
  idempotency_key TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL,
  reservation_id  TEXT,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ payments schema (Payment Service) ============
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  reservation_ids TEXT[] NOT NULL,
  status          TEXT NOT NULL,              -- AUTHORIZED|DECLINED|ERROR
  decline_reason  TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 2. `causora` database (the platform)

### 2.1 Raw telemetry - durability and replay

```sql
CREATE TABLE raw_telemetry (
  envelope_id   TEXT PRIMARY KEY,              -- UUIDv7
  kind          TEXT NOT NULL,                 -- traces|logs
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|processed|rejected
  rejection     TEXT,
  byte_size     INT NOT NULL,
  payload       JSONB NOT NULL
);
CREATE INDEX raw_telemetry_status_idx   ON raw_telemetry (status, received_at);
CREATE INDEX raw_telemetry_received_idx ON raw_telemetry (received_at DESC);
```

This table is the replay substrate. `UPDATE raw_telemetry SET status='pending' WHERE ...`
plus a re-enqueue re-runs the entire pipeline against a captured failure, which is how the
graph engine gets developed without re-running the demo every time.

Retention: a `scripts/prune-raw.ts` job drops envelopes older than `RAW_RETENTION_HOURS`
(default 24). Growth is the main storage cost and is measured in the benchmarks.

### 2.2 Events - the nodes

```sql
CREATE TABLE events (
  event_id               TEXT PRIMARY KEY,
  event_type             TEXT NOT NULL,
  source                 TEXT NOT NULL,        -- span|span_event|log|fault|synthesised
  evidence_source        TEXT NOT NULL,

  service                TEXT NOT NULL,
  service_instance_id    TEXT,
  operation              TEXT NOT NULL,

  occurred_at            TIMESTAMPTZ NOT NULL,
  ended_at               TIMESTAMPTZ,
  duration_ms            NUMERIC(12,3),        -- derived, stored for index-only scans
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_source           TEXT NOT NULL,

  trace_id               TEXT,
  span_id                TEXT,
  parent_span_id         TEXT,

  business_operation_id  TEXT,
  causation_id           TEXT,
  idempotency_key        TEXT,
  attempt_number         INT NOT NULL DEFAULT 1,
  retry_of_event_id      TEXT,
  awaited_correlation_id TEXT,

  message_id             TEXT,
  topic                  TEXT,
  partition              INT,
  "offset"               BIGINT,
  produced_at            TIMESTAMPTZ,
  dwell_ms               NUMERIC(12,3),

  status                 TEXT NOT NULL,        -- OK|ERROR|TIMEOUT|CANCELLED|UNKNOWN
  error_type             TEXT,
  error_message          TEXT,
  error_stack_digest     TEXT,

  experiment_id          TEXT,
  is_fault_injected      BOOLEAN NOT NULL DEFAULT false,

  resource_ids           TEXT[] NOT NULL DEFAULT '{}',
  contract_violations    TEXT[] NOT NULL DEFAULT '{}',
  attributes             JSONB NOT NULL DEFAULT '{}',
  resource_attributes    JSONB NOT NULL DEFAULT '{}',
  schema_version         INT NOT NULL
);

CREATE INDEX events_business_op_idx ON events (business_operation_id, occurred_at);
CREATE INDEX events_trace_idx       ON events (trace_id, occurred_at);
CREATE INDEX events_service_op_idx  ON events (service, operation, occurred_at DESC);
CREATE INDEX events_status_idx      ON events (status, occurred_at DESC)
  WHERE status IN ('ERROR','TIMEOUT');
CREATE INDEX events_occurred_idx    ON events (occurred_at DESC);
CREATE INDEX events_experiment_idx  ON events (experiment_id) WHERE experiment_id IS NOT NULL;
CREATE INDEX events_violations_idx  ON events USING GIN (contract_violations);
```

Partitioning by `occurred_at` (monthly RANGE) is **documented, not implemented**. At MVP
volumes it is unnecessary complexity; the migration is sketched in
[ADR-0011](../../DECISIONS.md#adr-0011) so the path is clear.

### 2.3 Correlation index

```sql
CREATE TABLE event_correlations (
  event_id  TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  key_type  TEXT NOT NULL,   -- span|trace|causation|business_op|idempotency|
                             -- message|topic_offset|awaited|retry_of
  key_value TEXT NOT NULL,
  PRIMARY KEY (event_id, key_type, key_value)
);
CREATE INDEX event_correlations_lookup_idx ON event_correlations (key_type, key_value);
```

Write amplification of 3–8 rows per event, bought in exchange for adding edge rules without
schema migrations. [ADR-0009](../../DECISIONS.md#adr-0009).

### 2.4 Edges

```sql
CREATE TABLE edges (
  from_event_id   TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  to_event_id     TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  evidence_class  TEXT NOT NULL,              -- proven|derived|inferred|weak
  confidence      NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  derived_by_rule TEXT NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_event_id, to_event_id, type),
  CHECK (from_event_id <> to_event_id)
);
-- the hot path: reverse traversal from a failure
CREATE INDEX edges_to_idx   ON edges (to_event_id)   INCLUDE (from_event_id, confidence, evidence_class);
CREATE INDEX edges_from_idx ON edges (from_event_id) INCLUDE (to_event_id, confidence, evidence_class);
CREATE INDEX edges_class_idx ON edges (evidence_class, type);
```

`PRIMARY KEY (from, to, type)` is what makes edge derivation idempotent, which is what makes
re-derivation and replay safe. The `CHECK (from <> to)` prevents a buggy rule from creating a
self-loop that would hang traversal.

### 2.5 Business operations, failures, baselines

```sql
CREATE TABLE business_operations (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                 -- "order"
  status       TEXT NOT NULL,                 -- ACTIVE|SUCCEEDED|FAILED|UNKNOWN
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,
  event_count  INT NOT NULL DEFAULT 0,
  service_count INT NOT NULL DEFAULT 0,
  dirty        BOOLEAN NOT NULL DEFAULT true, -- drives incremental re-derivation
  experiment_id TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX business_operations_dirty_idx  ON business_operations (updated_at) WHERE dirty;
CREATE INDEX business_operations_status_idx ON business_operations (status, started_at DESC);

CREATE TABLE failures (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  business_operation_id TEXT NOT NULL,
  service               TEXT NOT NULL,
  operation             TEXT NOT NULL,
  error_type            TEXT,
  first_seen_at         TIMESTAMPTZ NOT NULL,
  investigated          BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (business_operation_id, event_id)
);
CREATE INDEX failures_recent_idx ON failures (first_seen_at DESC);

CREATE TABLE operation_baselines (
  service      TEXT NOT NULL,
  operation    TEXT NOT NULL,
  p50_ms       NUMERIC(12,3) NOT NULL,
  p95_ms       NUMERIC(12,3) NOT NULL,
  p99_ms       NUMERIC(12,3) NOT NULL,
  error_rate   NUMERIC(5,4)  NOT NULL,
  sample_count INT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (service, operation)
);
```

Baselines are computed **only from succeeded business operations** - see
`causality-algorithm.md` §6.2. Including failed traffic would make the anomaly threshold drift
toward the thing being detected.

### 2.6 Investigations

```sql
CREATE TABLE investigations (
  id                    TEXT PRIMARY KEY,
  failure_event_id      TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  business_operation_id TEXT NOT NULL,
  status                TEXT NOT NULL,        -- RUNNING|COMPLETE|FAILED
  completeness          JSONB NOT NULL,
  subgraph_node_count   INT,
  subgraph_edge_count   INT,
  truncated             BOOLEAN NOT NULL DEFAULT false,
  frontier_fallback     BOOLEAN NOT NULL DEFAULT false,
  rule_set_id           TEXT NOT NULL,
  config_snapshot       JSONB NOT NULL,
  supersedes            TEXT REFERENCES investigations(id),
  duration_ms           INT,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investigations_failure_idx ON investigations (failure_event_id, created_at DESC);

CREATE TABLE investigation_candidates (
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  rank             INT  NOT NULL,
  event_id         TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  score            NUMERIC(6,4) NOT NULL,
  label            TEXT NOT NULL,             -- STRONG|SUPPORTED|WEAK|SPECULATIVE
  evidence         JSONB NOT NULL,
  PRIMARY KEY (investigation_id, rank)
);

CREATE TABLE patterns_detected (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT REFERENCES investigations(id) ON DELETE CASCADE,
  business_operation_id TEXT NOT NULL,
  pattern          TEXT NOT NULL,
  member_event_ids TEXT[] NOT NULL,
  evidence         JSONB NOT NULL,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.7 Experiments - ground truth

```sql
CREATE TABLE fault_experiments (
  id                TEXT PRIMARY KEY,
  scenario_id       TEXT NOT NULL,
  params            JSONB NOT NULL,
  -- the ground truth the evaluation harness scores against
  ground_truth      JSONB NOT NULL,   -- { service, operation, fault_type, expected_patterns[] }
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  status            TEXT NOT NULL,    -- RUNNING|COMPLETE|ABORTED
  business_operation_ids TEXT[] NOT NULL DEFAULT '{}',
  rule_set_id       TEXT NOT NULL DEFAULT 'default',
  notes             TEXT
);
CREATE INDEX fault_experiments_scenario_idx ON fault_experiments (scenario_id, started_at DESC);

CREATE TABLE evaluation_results (
  id              TEXT PRIMARY KEY,
  experiment_id   TEXT NOT NULL REFERENCES fault_experiments(id) ON DELETE CASCADE,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  hit_at_1        BOOLEAN NOT NULL,
  hit_at_3        BOOLEAN NOT NULL,
  reciprocal_rank NUMERIC(5,4) NOT NULL,
  ground_truth_rank INT,                     -- null if not in the candidate list at all
  graph_completeness NUMERIC(5,4) NOT NULL,  -- derived / expected proven edges
  rule_set_id     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`evaluation_results` is the table that turns Causora from a demo into a measured system.
Every row is produced by a real scenario run; none are written by hand.

---

## 3. Expected volumes (MVP)

| Entity | Per order (happy) | Per order (primary failure) |
|---|---|---|
| events | ~18 | ~34 |
| event_correlations | ~90 | ~170 |
| edges | ~22 | ~45 |
| raw_telemetry envelopes | ~4 | ~7 |

A 200-order baseline seed is roughly 3,600 events and 18,000 correlation rows - trivial. A
retry-storm scenario producing 200 retries reaches ~7,000 events in one business operation,
which is deliberately near the UI clustering threshold so the clustering behaviour is
exercised rather than theoretical.

Storage growth per event is measured in the benchmarks, not estimated here.

---

## 4. Query patterns the indexes must serve

| # | Query | Index |
|---|---|---|
| 1 | Recent failures for the overview | `failures_recent_idx` |
| 2 | All events for a business operation | `events_business_op_idx` |
| 3 | Reverse edge traversal (the CTE) | `edges_to_idx` |
| 4 | Edge-rule lookups by correlation key | `event_correlations_lookup_idx` |
| 5 | Baseline recompute over healthy traffic | `events_service_op_idx` + join on `business_operations` |
| 6 | Dirty business operations for re-derivation | `business_operations_dirty_idx` |
| 7 | Contract-violation reporting | `events_violations_idx` (GIN) |
| 8 | Trace view | `events_trace_idx` |

Every index above exists for a numbered query. There are no speculative indexes; `EXPLAIN
ANALYZE` output for queries 2, 3 and 4 is committed to `docs/benchmarks/` during the
benchmarking milestone.
