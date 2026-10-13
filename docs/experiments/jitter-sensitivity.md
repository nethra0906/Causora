# Jitter sensitivity: a defect found by CI

## What happened

The first GitHub Actions run failed one end-to-end test. In the `payment-error` scenario (the payment service
returns 503) the analyser ranked **`inventory-service` first instead of `payment-service`**. Nothing had been
injected into inventory in that scenario. The same test had passed on every local run, including the 40-run
evaluation, three clean-copy runs, and runs under artificial CPU load.

## Mechanism

1. The baseline for a healthy `inventory.reserve` is sub-millisecond (p95 about 0.9 ms).
2. The latency score is `z = (self_time - p95) / max(p95 - p50, 5 ms)`, saturating at `z = 10`, weighted 0.4.
   With a 5 ms spread floor, a self-time of about **45 ms** is enough to reach the anomaly threshold (0.35).
3. In scenario S3 the payment error is *downstream* of the inventory reservation (reserve, reply, settle,
   payment call, payment error). The frontier rule says the origin is the earliest anomalous event with no
   anomalous ancestor.
4. So a single ~45 ms stall in a perfectly healthy upstream span (a GC pause, a disk flush, CPU steal on a
   shared runner) makes that span the "origin" and demotes the real fault to a downstream effect.

The analyser was behaving exactly as designed; the design was too sensitive to noise.

## Measurement (before and after)

Method: inject the real fault (payment 503) plus a small artificial stall on the healthy `inventory.reserve`,
3 runs per level, fresh stack and baseline each time. Correct means the payment service is ranked first.

| Stall on a healthy upstream span | Before the fix | After the fix |
|---|---|---|
| 0 ms | 3/3 correct | 3/3 correct |
| 20 ms | 3/3 correct | 3/3 correct |
| 40 ms | **0/3** (inventory anomaly 0.37, self-time 46 ms vs p95 0.90 ms) | 3/3 correct |
| 60 ms | **0/3** (0.40) | 3/3 correct |
| 100 ms | **0/3** (0.40) | 3/3 correct |
| 200 ms | **0/3** (0.41) | 3/3 correct |

The flip point matches the analytic estimate (about 45 ms), which is the strongest evidence for the mechanism.

## The fix

A declared, snapshotted config constant, `minLatencyAnomalyMs = 250`: a span whose self-time is below it
contributes **no latency anomaly**, whatever its baseline. It is about 5 times the stall that flipped the
ranking and far below every injected fault (all at least 1.5 s).

Regression coverage:

- Unit tests pin the defect and the fix together. A 60 ms upstream stall must not hijack rank 1, and with the
  floor set to 0 (the old behaviour) it must. A 1.7 s stall must still be found.
- An end-to-end test injects a 100 ms stall next to the payment 503 and asserts the payment service stays first.
  Mutation-checked: with the floor disabled it fails with `rank 1 was inventory-service/inventory.reserve`,
  the same symptom as the CI log.
- The end-to-end failure message now prints the top candidates with their latency evidence, so any future
  failure is diagnosable from the CI log alone.

## What this does not establish

- **I never reproduced the CI failure itself.** Full-CPU load and pinning the whole process tree to 2 cores both
  passed. The diagnosis rests on (a) the mechanism, (b) the flip point matching the analytic prediction, and
  (c) the injected stall reproducing the exact CI symptom. What actually stalled on the GitHub runner is
  unmeasured. If CI still fails after this change, the new failure message will say why.
- **This is an analyser change made after the held-out experiment.** It is a defect fix, allowed by the
  protocol in ADR-0018 provided the before and after are reported. They are: the 40-run headline table, the
  heuristic ablation and the held-out verdicts in `docs/experiments/results.md` are identical before and after.
- **Cost: slowdowns smaller than 250 ms are now invisible to the analyser.** A genuine 100 ms regression in a
  service would not be flagged. That is a deliberate trade for robustness, and it fits this demo (1 s deadlines,
  1.5 s or longer faults) but would need rethinking for a system with tight latency budgets.
- **The structural weakness remains.** The frontier rule still promotes the earliest anomalous ancestor, so a
  stall above the floor that is real but unrelated would still hijack the ranking. I expect this but did not
  measure it. The floor reduces false positives; it does not make the rule noise-proof.
