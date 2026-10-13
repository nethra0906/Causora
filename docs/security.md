# Security Design

> **Build status - blueprint document.** Fault-injection gating is implemented as specified (opt-in flag, production refusal, ≥16-char token, loopback only). The ingest and read APIs have **no authentication** and bind to loopback; there is no Collector redaction layer, so the SDK hashes idempotency keys instead.

Causora has two unusual security properties: it **ingests telemetry that may contain sensitive
data**, and it **ships a deliberate availability-destruction capability**. Both need designing,
not hoping.

Scope note: this is a single-operator development project, not a multi-tenant SaaS. The
controls below are proportionate to that, and the places where a production system would need
more are named rather than pretended away.

---

## 1. Threat model

| # | Threat | Likelihood here | Control |
|---|---|---|---|
| T1 | Fault injection reachable in a real environment | **High if ungated** | Triple gate, §3 |
| T2 | Sensitive data (PII, card numbers, SQL, auth headers) persisted in telemetry | **High by default** | Collector-side redaction, §4 |
| T3 | Unauthenticated telemetry injection poisoning the graph | Medium | Ingest token, §2 |
| T4 | SQL injection via filter parameters | Medium | Parameterised queries only, §5 |
| T5 | Resource exhaustion via oversized OTLP payload or huge subgraph request | Medium | Caps and bounds, §6 |
| T6 | Read token escalating to fault injection | Medium | Separate token scopes, §2 |
| T7 | Secrets committed to the repository | Medium | `.env.example` only, §7 |
| T8 | Stack traces or SQL leaking to API clients | Low | Error sanitisation, §5 |
| T9 | Cross-origin abuse of the dev API | Low | Strict CORS allowlist |

---

## 2. Authentication & authorisation

Bearer tokens, four scopes, read from the environment and validated at startup (the process
refuses to boot with a missing or default token value):

| Token | Grants | Held by |
|---|---|---|
| `CAUSORA_INGEST_TOKEN` | `POST /v1/traces`, `/v1/logs` | the OTel Collector |
| `CAUSORA_READ_TOKEN` | all `GET /api/v1/*` | the web UI |
| `CAUSORA_WRITE_TOKEN` | investigation create/delete | the web UI |
| `CAUSORA_EXPERIMENT_TOKEN` | `/api/v1/experiments/*` | the Fault Lab, entered by the operator |

**Why four tokens in a one-person project.** T6. The Collector's token must not be able to
break the system, and a read token must not be able to inject a fault. Token scope separation
costs about 20 lines and removes an entire class of mistake.

Not built, and honestly labelled as such: user accounts, OIDC, RBAC, sessions, refresh
tokens. A production deployment would need OIDC with role claims and per-tenant data
scoping; `docs/scalability.md` §6 sketches it.

---

## 3. Fault-injection safety (T1)

Fault injection can take down every service. **Three independent gates, all required**, all
checked in one module (`platform/api/src/experiments/guard.ts`):

```
1. CAUSORA_ALLOW_FAULT_INJECTION === 'true'     default: false
2. NODE_ENV !== 'production'                     NOT overridable by any config
3. Authorization: Bearer <CAUSORA_EXPERIMENT_TOKEN>
```

Plus defence in depth:

| Control | Detail |
|---|---|
| Network isolation | service `/internal/faults` ports are **not** published in `docker-compose.yml`; reachable only on the compose network |
| TTL | every fault expires; default 60 s, server-enforced maximum 300 s |
| No wildcards | `target` must be an exact known operation name; validated by a Zod enum, not a string |
| Memory only | nothing persisted; restart clears everything |
| Mandatory cleanup | the runner clears faults in a `finally` block as well as relying on TTL |
| Audit log | one structured line per apply and clear: experimentId, token id, service, target, TTL |
| Visibility | active faults are shown in the UI header at all times |

**Required tests** (these are correctness tests, not formalities):

1. Gate 1 false → 503, with gates 2 and 3 satisfied.
2. `NODE_ENV=production` → 503, **even with gates 1 and 3 satisfied**.
3. Read token on an experiment endpoint → 403.
4. Wildcard target → 422.
5. `ttlSeconds: 86400` → 422.
6. TTL expiry actually clears the fault (fake timers).
7. Runner `finally` clears faults even when the workload throws.

---

## 4. Telemetry sanitisation (T2)

Telemetry is the highest-risk data in the system: it passes through automatically and nobody
reviews it. Controls, in order of application:

**At the service.** Never put secrets, card numbers, emails or free-text PII into span
attributes or log messages. Enforced by an ESLint rule banning a denylist of attribute key
patterns, and by code review of the instrumentation helpers in `packages/telemetry` (which are
the only place attributes are set).

**At the Collector** - the authoritative control, because it is one auditable place rather
than three services' worth of discipline:

| Attribute | Action | Why |
|---|---|---|
| `causora.idempotency_key` | **hash** | Duplicate detection needs identity, never the value |
| `enduser.id` | **hash** | Correlation preserved, identity removed |
| `db.statement` | delete | SQL frequently embeds literal values |
| `http.request.header.authorization` | delete | Credentials |
| `order.customer_email` | delete | PII |
| `payment.card_number` | delete | Never acceptable to store |

**`hash` rather than `delete` where the analytical property depends on equality** is the
interesting decision here. Duplicate detection asks "are these two keys the same?", which a
stable hash answers perfectly while destroying the content. The same reasoning applies to
`enduser.id`. Stating that trade-off precisely is a real privacy-engineering point.

**At Causora.** `error_message` is length-capped at 2 KB; stack traces are stored only as
`error_stack_digest` (a SHA-256 prefix), which is enough to group identical failures and
insufficient to leak source paths. An attribute-key allowlist is applied before writing
`attributes` JSONB, so an unexpected new attribute from a service upgrade cannot silently
start persisting PII - unknown keys are dropped and counted.

**At the API.** Hashed and dropped fields are never reconstructed; responses echo
`idempotencyKeyHash`, never a key.

---

## 5. Input validation & injection (T4, T8)

- **Every** inbound payload, query string and path parameter is parsed by a Zod schema from
  `packages/contracts`. Fastify's type provider makes an unvalidated route a compile error.
- All SQL is parameterised. No string interpolation into SQL anywhere, including in the
  recursive CTE - depth and limit are bound parameters. A CI grep rejects template literals
  containing `SELECT`/`INSERT`/`UPDATE`/`DELETE`.
- Enumerations (`status`, `evidenceClass`, `eventType`, `ruleSetId`, scenario ids) are Zod
  enums, so they cannot carry arbitrary strings into a query.
- `configOverrides` is allowlisted to known analysis constants with numeric range checks;
  unknown keys are rejected, not ignored.
- Error responses are RFC 7807 with a generic `detail` for 5xx. Stack traces and SQL go to
  the server log only. A single Fastify error handler enforces this.
- `statement_timeout` is set on the pool (default 5,000 ms; 30,000 ms for the analysis pool)
  so a pathological traversal cannot pin a connection indefinitely.

---

## 6. Resource limits (T5)

| Limit | Default | Enforced at |
|---|---|---|
| OTLP body size | 4 MB | Fastify `bodyLimit` on ingest routes |
| Ingest rate | 1,000 req/min | token bucket per token |
| Investigation creation | 30/min | token bucket |
| Experiment runs | 10/min, 1 concurrent | token bucket + a 409 on an active run |
| Read endpoints | 600/min | token bucket |
| `limit` on list endpoints | max 200 | Zod |
| `maxDepth` | max 20 | Zod |
| `maxNodes` | max 10,000 | Zod |
| Postgres pool | 10 (API), 5 (worker), 3 (analysis) | separate pools so analysis cannot starve ingest |
| Collector memory | `memory_limiter` at 75% | collector config |

Separate connection pools for ingest and analysis is the control that prevents a heavy
investigation from stalling telemetry intake - a self-inflicted outage in a tool whose job is
diagnosing outages.

---

## 7. Secrets & configuration (T7)

- `.env.example` is committed with placeholder values; `.env` is gitignored.
- Startup validates configuration with Zod and **refuses to boot** on a missing token or on a
  token still equal to its example placeholder. Failing loudly beats running insecurely.
- No secrets in `docker-compose.yml`; it reads from `.env`.
- Database credentials differ per database: the services get `app` only, the platform gets
  `causora` only. The platform cannot read business data and the services cannot read the graph.
- No cloud credentials exist in this project; nothing is deployed anywhere by default.

---

## 8. Honestly out of scope

Named explicitly so the gaps are deliberate rather than overlooked:

| Not built | What production would need |
|---|---|
| User authentication | OIDC with role claims |
| Multi-tenancy | tenant id on every row, RLS policies, per-tenant rate limits |
| Encryption at rest | managed Postgres with disk encryption, or `pgcrypto` for sensitive columns |
| TLS between components | mTLS on the compose network, or a service mesh |
| Audit trail persistence | audit events to an append-only store, not just stdout |
| Secret rotation | a secret manager with short-lived credentials |
| Telemetry access control | per-service read scoping so team A cannot read team B's traces |

The last row is the genuinely interesting one for a real observability platform, and it is a
good thing to be able to discuss: traces routinely cross team boundaries, which makes
authorisation on telemetry much harder than authorisation on application data.
