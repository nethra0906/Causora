# Evaluation results — BEFORE the redelivery event-id fix (snapshot, 2026-10-13)

> Snapshot of the first run that exercised the held-out scenarios, kept so the before/after of the P6 defect fix is reproducible. Superseded by `results.md`; not regenerated.

- Runs per scenario: **10** · scored failure runs: **40**
- Hardware: Intel(R) Core(TM) Ultra 5 225H · 14 logical cores · 15.4 GB RAM · win32 10.0.26300 · Node v24.17.0
- Ground truth is the fault injector’s record; the ranker never sees experiment_id or is_fault_injected. Ablated rule sets are evaluated on the SAME stored events as the default.

## Ablation: what is lost as causal metadata is removed

| Rule set | Hit@1 | Hit@1 (first instance) | Hit@3 | MRR (± sd) | Truth reachable | Edge recall | Inferred share | Duplicate bug diagnosed (S1) |
|---|---|---|---|---|---|---|---|---|
| `default` | 100% | 100% | 100% | 1.00 ± 0.00 | 100% | 100% | 0% | 100% |
| `ablation.no_causation_id` | 50% | 50% | 50% | 0.50 ± 0.51 | 50% | 87% | 36% | 100% |
| `ablation.no_causation_id.no_inference` | 25% | 25% | 25% | 0.25 ± 0.44 | 25% | 58% | 0% | 0% |
| `ablation.no_retry_of` | 100% | 100% | 100% | 1.00 ± 0.00 | 100% | 100% | 4% | 100% |
| `ablation.no_awaited` | 50% | 50% | 50% | 0.50 ± 0.51 | 50% | 93% | 0% | 100% |
| `ablation.no_idempotency_key` | 100% | 100% | 100% | 1.00 ± 0.00 | 100% | 96% | 0% | 0% |
| `ablation.tracing_only` | 0% | 0% | 0% | 0.00 ± 0.00 | 0% | 66% | 34% | 0% |
| `ablation.tracing_only.no_inference` | 0% | 0% | 0% | 0.00 ± 0.00 | 0% | 44% | 0% | 0% |

Hit@1 matches the injected service + operation. "First instance" additionally requires the top candidate to be the earliest occurrence (attempt 1, not its retry) — it is the stricter localisation claim. "Truth reachable" = the injected operation is in the ancestor subgraph of the failure at all. "Edge recall" = share of the full-contract graph’s edges (by endpoint pair) that the rule set still recovers.

"Duplicate bug diagnosed" = the investigation reports `IDEMPOTENCY_FAILURE` (the non-atomic guard) for the S1 runs — what `idempotency_key` buys beyond localisation.

## Per-scenario Hit@1

| Rule set | inventory-delay-duplicate | payment-latency | payment-error | retry-exhaustion |
|---|---|---|---|---|
| `default` | 100% | 100% | 100% | 100% |
| `ablation.no_causation_id` | 100% | 0% | 0% | 100% |
| `ablation.no_causation_id.no_inference` | 0% | 0% | 0% | 100% |
| `ablation.no_retry_of` | 100% | 100% | 100% | 100% |
| `ablation.no_awaited` | 100% | 0% | 100% | 0% |
| `ablation.no_idempotency_key` | 100% | 100% | 100% | 100% |
| `ablation.tracing_only` | 0% | 0% | 0% | 0% |
| `ablation.tracing_only.no_inference` | 0% | 0% | 0% | 0% |

## How to read this

- This is **40 runs of 4 scenario types**: it measures reliability and the effect of each contract field, not generalisation to unseen failure modes. Runs within a scenario are structurally near-identical, so the ± is mostly between-scenario spread.
- Rule sets differ only in which contract fields are treated as absent and which rules run; every row is computed on the **same stored events**.

## Control

- `inventory-fix`: 10/10 orders confirmed, 0 DUPLICATE_OF edges (expected 0 — the corrected guard removes exactly that edge).

## Held-out scenarios — pre-registered predictions vs. what happened

Predictions were written **before** these scenarios were implemented ([held-out.md](held-out.md)); the analyser was frozen for them. Verdicts below are computed, not judged.

### S5 · Inventory handler throws (held-out)

| Prediction | Verdict | Observed |
|---|---|---|
| P1 every run fails with RETRY_EXHAUSTED | ✔ confirmed | 10/10 reproduced; outcomes: FAILED/RETRY_EXHAUSTED ×10 |
| P2 default Hit@1 = 100% | ✔ confirmed | Hit@1 100% · first-instance 100% · Hit@3 100% |
| P3 label STRONG/SUPPORTED; TIMEOUT_CASCADE + RETRY_STORM detected | ✔ confirmed | labels: STRONG ×10; patterns: RETRY_STORM ×10, TIMEOUT_CASCADE ×10 |
| P4 tracing-only Hit@1 = 0% | ✔ confirmed | 0% / 0% |
| P5 without awaited_correlation_id Hit@1 = 0% | ✔ confirmed | 0% |
| P6 redeliveries collide on one event id (defect), without changing Hit@1 | ✔ confirmed | mean 3.0 stored inventory.reserve events per run (9 = every delivery kept, 3 = one per message) |

| Rule set | Hit@1 | Hit@3 | MRR | Origin reachable |
|---|---|---|---|---|
| `default` | 100% | 100% | 1.00 | 100% |
| `ablation.no_causation_id` | 100% | 100% | 1.00 | 100% |
| `ablation.no_causation_id.no_inference` | 100% | 100% | 1.00 | 100% |
| `ablation.no_retry_of` | 100% | 100% | 1.00 | 100% |
| `ablation.no_awaited` | 0% | 0% | 0.00 | 0% |
| `ablation.no_idempotency_key` | 100% | 100% | 1.00 | 100% |
| `ablation.tracing_only` | 0% | 0% | 0.00 | 0% |
| `ablation.tracing_only.no_inference` | 0% | 0% | 0.00 | 0% |

### S6 · Inventory rejects for lack of stock (held-out)

| Prediction | Verdict | Observed |
|---|---|---|
| Q1 every run fails with INSUFFICIENT_STOCK | ✔ confirmed | 10/10 reproduced; outcomes: FAILED/INSUFFICIENT_STOCK ×10 |
| Q2 default Hit@1 = 0%; top candidate is in the order service | ✘ refuted | Hit@1 0%; top: (no candidate) ×10 |
| Q3 COMPLETE and the origin is connected — confidently connected, wrongly ranked | ✔ confirmed | completeness: COMPLETE ×10; origin in subgraph 100%; labels: (none) ×10 |

| Rule set | Hit@1 | Hit@3 | MRR | Origin reachable |
|---|---|---|---|---|
| `default` | 0% | 0% | 0.00 | 100% |
| `ablation.no_causation_id` | 0% | 0% | 0.00 | 100% |
| `ablation.no_causation_id.no_inference` | 0% | 0% | 0.00 | 0% |
| `ablation.no_retry_of` | 0% | 0% | 0.00 | 100% |
| `ablation.no_awaited` | 0% | 0% | 0.00 | 100% |
| `ablation.no_idempotency_key` | 0% | 0% | 0.00 | 100% |
| `ablation.tracing_only` | 0% | 0% | 0.00 | 100% |
| `ablation.tracing_only.no_inference` | 0% | 0% | 0.00 | 0% |

Held-out runs are **not** included in the headline table above. Q4 (the analyser localises anomalies, not decisions) is interpretive and not machine-graded.

