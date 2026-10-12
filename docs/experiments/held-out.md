# Held-out scenarios — pre-registered predictions

**Why this file exists.** Two analysis heuristics (self-time latency, and attributing a caller's
error/timeout to its callee) were added *after* I watched S2/S3 fail. They are therefore fitted to
those scenarios, and the 40-run evaluation cannot tell me whether they generalise.

These two scenarios are written **before they are implemented or run**. The predictions below are
the commitment. Rules for this experiment:

1. The analysis (`src/platform/analysis.ts`, `rules.ts`, weights, thresholds) is **frozen**. A held-out
   result must never be "fixed" by tuning the analyser and re-running.
2. If a held-out run exposes a genuine *defect* (a bug that is wrong regardless of scenario), it may be
   fixed, but the original result and the fix are both reported.
3. Misses are reported as limitations, not hidden or re-scoped.

Written: 2026-10-12, before any code for S5/S6 exists.

---

## S5 — inventory handler throws (`inventory-crash`)

*Fault.* An injected exception inside the reservation handler (`error_response`, rate 1.0). The bus
redelivers up to 3 times, then dead-letters; no `inventory.reserved` is ever published; the order
service times out, retries (attempt 2, 3) and gives up with `RETRY_EXHAUSTED`.
*Ground truth.* `inventory-service` / `inventory.reserve`.

| # | Prediction | Confidence | Reasoning |
|---|---|---|---|
| P1 | Every run fails with `RETRY_EXHAUSTED`. | high | Same saga path as S4; nothing else can answer. |
| P2 | **Default rule set: Hit@1 = 100%.** | medium | The failing consume span has its own `ERROR` status and no failing child, so it carries an undiscounted error signal and is anomalous with no anomalous ancestor. |
| P3 | The top candidate is labelled `STRONG` or `SUPPORTED`; patterns include `TIMEOUT_CASCADE` and `RETRY_STORM`. | medium | Proven path, baseline available, ≥ 3 attempts. |
| P4 | `ablation.tracing_only*`: Hit@1 = 0%. | high | The broker boundary is not crossed by parentage; same as S1–S4. |
| P5 | `ablation.no_awaited`: Hit@1 = 0%. | medium-high | Without `awaited_correlation_id` the consumer is not an ancestor of the failure. |
| P6 | **Risk I expect to be real:** redeliveries of one message share one event id (`consume:<message>:<group>`), so the 2nd/3rd delivery's span is silently discarded as a "duplicate" at ingest. I predict this does **not** change Hit@1, but it is a defect: evidence of the redeliveries is lost and `ingest` reports them as duplicates. | medium | The id is deliberately deterministic so a timeout can name the awaited consumer, but it was designed assuming one delivery. |

## S6 — inventory rejects for lack of stock (`inventory-reject`)

*Fault.* The reservation handler is told to treat stock as exhausted. It publishes
`inventory.rejected` quickly and *correctly*; the order fails `INSUFFICIENT_STOCK`.
*Ground truth.* `inventory-service` / `inventory.reserve`.

| # | Prediction | Confidence | Reasoning |
|---|---|---|---|
| Q1 | Every run fails with `INSUFFICIENT_STOCK`. | high | Existing saga branch. |
| Q2 | **Default rule set: Hit@1 = 0%.** The top candidate will be in the order service (`order.failed` or the reply handler), not inventory. | high | A business rejection is a *normal outcome* of `inventory.reserve`: its span is `OK`, fast, error-free. Anomaly scoring has nothing to find upstream, so the only anomalous event is the failure itself. |
| Q3 | Completeness will be `COMPLETE` and the chain will be fully proven — i.e. Causora will be *confidently* and *correctly connected* but *wrong about the origin*. | high | The edges do not depend on anomaly. |
| Q4 | The honest reading: the analyser localises **anomalies**, not **decisions**. A rejection that the code made on purpose is invisible to it. | — | This is a limitation to report, not to repair by tuning. |

## How the result will be reported

Each prediction is marked ✔ confirmed / ✘ refuted / ~ partly, in `docs/experiments/results.md` (generated)
and summarised in the README, **including every refuted prediction.**
