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

---

# Results (added 2026-10-13, after the run — everything above this line is unchanged)

10 runs of each scenario, `npm run eval -- 10`. The generated, machine-graded version is
[results.md](results.md); the run *before* the one defect fix below is preserved in
[results-before-redelivery-fix.md](results-before-redelivery-fix.md).

## S5 — handler throws: 6 of 6 confirmed

| # | Prediction | Result |
|---|---|---|
| P1 | every run fails `RETRY_EXHAUSTED` | ✔ 10/10 |
| P2 | default Hit@1 = 100% | ✔ 100% (first-instance 100%) |
| P3 | label `STRONG`/`SUPPORTED`; `TIMEOUT_CASCADE` + `RETRY_STORM` | ✔ `STRONG` ×10, both patterns ×10 |
| P4 | tracing-only Hit@1 = 0% | ✔ 0% / 0% |
| P5 | without `awaited_correlation_id`, Hit@1 = 0% | ✔ 0% |
| P6 | redeliveries collide on one event id (a defect), Hit@1 unaffected | ✔ **3.0** stored `inventory.reserve` events per run where 9 = every delivery kept; Hit@1 100% |

**P6 was a real defect, and it was fixed — as a defect, not as tuning.** `consumeEventId(message, group)` was
deterministic so a timeout can name the consumer it awaited, but it assumed one delivery. When a handler fails
and the bus redelivers, all deliveries shared one id and two of three were silently discarded at ingest, so the
evidence of the redeliveries was lost. Fix: the first delivery keeps the bare id (the only one a waiter can
compute); redeliveries get `#<n>`. A unit test pins it and was mutation-checked (it fails with the old
behaviour). After the fix: **9.0 stored events per run**, and every S5 result above is unchanged.

## S6 — deliberate rejection: 1 confirmed, 1 refuted, 1 partly

| # | Prediction | Result |
|---|---|---|
| Q1 | every run fails `INSUFFICIENT_STOCK` | ✔ 10/10 |
| Q2 | Hit@1 = 0%, and the top candidate is in the order service | ✘ **refuted in detail.** Hit@1 is 0%, but there is **no top candidate at all**: the analyser returned zero candidates on all 10 runs. |
| Q3 | `COMPLETE`, origin connected, *and* a confident-looking wrong answer | ~ **partly.** `COMPLETE` ×10 and the origin is in the ancestor subgraph ×10 — but there was no wrong answer to be confident about. |
| Q4 | the analyser localises anomalies, not decisions | supported (interpretive) |

**Why it abstained.** The ancestor subgraph is the correct 6-event chain, fully proven. Nothing in it is
anomalous: every upstream span is `OK` and sub-millisecond. The only error is `order.failed` itself, and
`order.failed` has **no baseline** (healthy traffic never produces it), so its error cannot be rated against
one and scores 0.25 — below the 0.35 anomaly threshold. With no anomalous event, there is no candidate; the
Investigation page shows "No anomalous event found in the ancestor subgraph".

**Reading it honestly.** My prediction of a *wrong* confident answer was too pessimistic: the analyser
declined to guess rather than blaming the order service. That is the better failure mode, but it is still a
failure: the user gets nothing. The class of fault this cannot localise is a correct-but-undesired decision.
I did **not** change the analyser to rescue S6 (rule 1), and the abstention is not a fix-by-design — it is a
limitation to state.

## What changed after seeing the results (full disclosure)

1. The redelivery event-id defect (above). Analyser untouched.
2. The grader's Q3 check was too lenient: it passed on connectivity alone while the prediction also claimed a
   confident wrong answer. I made it stricter, so it now reports "partly". This made my own result look *worse*.
3. The generated P6 line now reads "fixed — confirmed before the fix" instead of "refuted", because after the
   fix the defect no longer exists and a bare "refuted" would mislead.

## What this does and does not show

- S5 does **not** exercise the self-time / callee-attribution heuristics, and this is now **measured**, not
  argued (the "What the two fitted heuristics buy" table in [results.md](results.md), added after the first
  version of this section). With either heuristic — or both — switched off, the results for S1, S4, S5 and S6
  do not change at all; only S2 and S3 move (Hit@1 100% → 0%: self-time matters for S2, callee attribution for
  S2 *and* S3). Those are exactly the two scenarios the heuristics were fitted to. So **no held-out scenario
  validates them**: the weakness I started from stands, and the ablation shows what they buy, not that they
  generalise. What S5 does show is that the rest of the pipeline works on a failure it was not developed
  against; it is structurally close to S4, so that is a modest result.
- S6 is a genuinely different failure class, and the analyser does not handle it.
- "Held-out" here means *predicted in writing before implementation and not tuned afterwards*. It is not
  independent: the same person wrote the app, the analyser and the scenarios, and each scenario is 10
  near-identical runs.
