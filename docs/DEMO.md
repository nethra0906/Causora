# Demo walkthrough (about 4 minutes)

A script for showing Causora live or recording it. Every number quoted here is in a generated file
(`docs/experiments/results.md`, `docs/benchmarks/results.md`); say them as written, with their caveats.

## Before you start

```bash
npm install
npm start -- --fresh      # wait for "Causora is up", then open http://127.0.0.1:4000
```

Use a browser window at least 1400 px wide: the Investigation graph is a tall chain and reads best at that size.

---

## 1 · The problem (30 s) - Failures & Fault Lab page

> "In an event-driven system a failure surfaces far from its cause: a different service, a different trace,
> after a retry, seconds later. A trace waterfall stops at the message broker. Causora's claim is that
> causality is *propagated, not discovered*: if the services carry a small metadata contract, the chain is
> provable, and I can measure exactly what is lost when the metadata is missing."

Click **Seed baseline (40 healthy orders)**. *"That teaches it what normal looks like per operation."*

## 2 · Inject a real bug (45 s)

Click **Inject & run** on **S1**. While the banner says *Running scenario…*:

> "A delay in the inventory handler outlasts the order service's deadline, so the order service times out
> and retries. The retry races a **non-atomic idempotency guard** - check, slow work, record - so both
> attempts reserve stock. Payment then rejects the doubled quantity. That is a real, common bug, not a
> staged error."

A row appears: **Payment rejected** → origin `inventory / inventory.reserve`, `STRONG`, `COMPLETE`.

> "The symptom is in the payment service. The origin it points to is two services and one retry away."

## 3 · The evidence (90 s) - click the row

- **Graph:** the highlighted path runs from the origin (badge **#1 / ORIGIN**) down to the red failure node.
  *"Line style is the evidence class: solid is proven, dashed is derived, dotted is inferred - never colour alone."*
- Click an **edge**: it shows the **rule that created it** and the **actual field values that matched**.
  *"I don't ask you to trust me; you can check the claim."*
- **Candidates → Evidence:** the path with every rule, the anomaly breakdown (1.71 s against a 0.83 ms p95
  baseline), the patterns `DUPLICATE_WORK`, `IDEMPOTENCY_FAILURE`, `TIMEOUT_CASCADE`, and the caveats.
- Tick **Reveal injected fault**: the flask badge appears on the injected operation.
  *"It doesn't change the ranking - the ranker never sees it. Ground truth and analysis are kept apart on
  purpose, so the evaluation isn't circular."*

## 4 · What the metadata buys (45 s) - same page

Open **Metadata available to the analyser** and choose **Tracing only (what a trace UI shows)**.

> "Same events, same failure - but now the analyser may only use parent/child spans, which is what a trace
> UI has. The chain shatters at the broker, there is no origin, and the page says the telemetry is degraded."

Switch back to **Full contract**. Then choose **Without idempotency_key**: *"Localisation survives, but it
can no longer diagnose the duplicate-reservation bug - each field earns its place differently."*

## 5 · The experiment (45 s) - Evaluation page

Click **Run evaluation** (10 runs per scenario, about a minute) or show the last result.

> "Forty runs of four scenarios, replayed through eight rule sets. Full contract: the injected fault is
> ranked first in every run. Tracing only: none of them. That is measured against the fault injector's record,
> not asserted."

Scroll to **Held-out scenarios**:

> "I was worried two of my analysis heuristics were fitted to the scenarios I'd watched fail. So I wrote two
> new scenarios *and my predictions for them* before implementing either, and froze the analyser. One
> prediction was a real bug - redelivered messages colliding on an event id - which I then fixed. One I got
> wrong: on a deliberate stock rejection I expected a wrong answer; the analyser returned *no candidate at all*.
> That's a genuine limit: it finds anomalies, not correct-but-undesired decisions."

## 6 · Close (15 s)

> "It runs on a laptop with no Docker: five small Node processes, about 400 MB. Everything on screen is
> reproducible with `npm start`, and the project's own docs say what it does **not** show."

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Scenario buttons disabled | Seed the baseline first. |
| "Another run is in progress" | A scenario/evaluation is still running; wait for its banner to finish. |
| Empty failures list after restart | Data is kept in `./data`; `npm start -- --fresh` wipes it. |
| Port 4000 busy | `$env:CAUSORA_PORT_BASE=5000` (PowerShell) in **every** terminal, then `npm start`. |
