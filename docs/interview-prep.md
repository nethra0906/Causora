# Interview Preparation

Causora's value in an interview is not that it is impressive. It is that **every concept it
touches is demonstrable in code you wrote and can defend**. This document maps likely questions
to the specific places the answer lives.

> **Verified against the code on 2026-10-12** with `node scripts/check-docs.mjs` (see the end of this file):
> every path, every "symbol in file" claim, every quoted test name and every relative link resolves. Where the blueprint promised
> something that was *not* built, the answer says so - saying "I designed that and cut it, here's the
> design" is a good answer; claiming it exists is a fatal one.

---

## 0. Numbers you can quote (each produced by a run, with its source)

| Claim | Number | Source |
|---|---|---|
| Primary failure ranked first, full contract | Hit@1 **100%** over 40 runs (10 × 4 scenarios) | `docs/experiments/results.md` (`npm run eval`) |
| Tracing-only analysis (what a trace UI shows) | Hit@1 **0%** over the same 40 runs | same |
| Removing `idempotency_key` | localisation unchanged (100%) but duplicate-bug diagnosis **100% → 0%** | same |
| Removing `causation_id` | 50% with heuristics, 25% without; heuristics help S1, not S2/S3 | same |
| Ingest → persist → derive edges | **~15–17 k events/s**, in-process, 3 reps | `docs/benchmarks/results.md` (`npm run bench`) |
| Investigation of a 2,000-node subgraph | **6.8 ms p50 / 11 ms p95** | same |
| Failure → visible in the API | ≤ **338 ms** (5 runs); UI polls every 2 s | PROGRESS.md DoD #4 |
| Whole stack footprint | **≈ 407 MB** across 5 Node processes | PROGRESS.md |
| Tests | 63 unit (no processes) + 9 e2e (real stack); `rules` 100%, `analysis` 98.5% line coverage | `npm test`, `npm run test:e2e` |
| Held-out S5 (handler throws), predictions written first | **6 of 6 confirmed**; Hit@1 100%, `STRONG` ×10 | `docs/experiments/results.md`, `docs/experiments/held-out.md` |
| Held-out S6 (deliberate rejection) | Hit@1 **0%**; the analyser returned **no candidate** (abstained); one prediction refuted, one partly | same |
| What the two fitted heuristics buy | Switching either off drops **S2 and S3 from 100% to 0%** Hit@1 and changes **nothing** on S1/S4/S5/S6 - so they are needed on the scenarios they were fitted to, and **unvalidated elsewhere** | `docs/experiments/results.md`, section "What the two fitted heuristics buy" |
| Event-id collision found by prediction P6 | **3.0 → 9.0** stored events per run after the fix | `docs/experiments/results-before-redelivery-fix.md` vs `docs/experiments/results.md` |

Do **not** quote anything not in this table. Always attach the caveat: *40 runs of four scenario
types on a deliberately small system - reliability and the value of each field, not generalisation.*

---

## 1. The questions you will definitely be asked

### "Walk me through the project."

Ninety seconds, in this order - the framing matters more than the detail:

1. **The problem.** In event-driven systems a failure surfaces far from its cause - different
   service, different trace, after a retry, seconds later. A trace waterfall truncates at the
   broker.
2. **The honest position.** You cannot infer causality from observational telemetry. Causality
   is *propagated*, not discovered. So Causora defines a metadata contract that makes causality
   provable (`src/contracts/index.ts`), and labels every relationship by its evidence class.
3. **The system.** A 3-service order saga (HTTP + a durable message bus) that fails in a realistic way
   - a slow handler outlasts a deadline, the retry races a non-atomic idempotency guard, payment
   rejects the doubled reservation. Telemetry flows to a platform that derives edges with nine pure
   rules, finds the propagation *frontier*, and ranks candidate origins with the evidence attached.
4. **The result.** Because a fault injector causes the failure, the answer is known - so the ranking
   is *measured*, not asserted: 100% Hit@1 with the full contract, 0% with tracing alone, over 40 runs,
   plus an ablation showing what each contract field buys.
5. **The limitation.** You built both the app and the analyser, and two of the analysis heuristics
   were added after seeing a scenario fail (see §3). The ablation controls for the contract, not for
   that. Leading with this is what makes the rest credible.

### "How is this different from Jaeger or Datadog?"

Three specific things, not a general claim:

1. **Cross-trace causality.** A consumer starts a *new trace* (`parent: 'none'` in `src/bus/index.ts` -
   the standard messaging pattern), so span parentage cannot cross the broker. Causora links producer
   and consumer through the propagated `causation_id`.
2. **Retry chains as first-class structure.** A waterfall renders three attempts as three unrelated
   subtrees; here `RETRY_OF` and `TIMED_OUT_WAITING_FOR` connect them.
3. **Duplicate work detection.** Nothing in a trace view says "this reservation happened twice"
   (`duplicate` rule in `src/platform/rules.ts`).

Then, instead of "see Jaeger side by side" (not built): *"the Investigation page has a 'Tracing only
(what a trace UI shows)' view that replays the same stored events through parent/child spans alone -
the chain shatters at the broker, and across 40 runs it localised none of the failures."*

### "How do you know A caused B?"

*"In most cases I don't infer it - the telemetry states it. When the inventory consumer handles a
message, its span carries a `causation_id` equal to the producing event's id, so the link is a field
match, not a guess. I classify every edge: **proven** means a field states it; **derived** means a
deterministic rule over proven facts, like two consumptions sharing an idempotency key that each
produced a different reservation; **inferred** means a heuristic used only where the contract field is
missing; **weak** means co-occurrence, and weak edges are never traversed. Inferred confidence is
capped at 0.75 (`MAX_INFERRED_CONFIDENCE`) so no chain of guesses can outrank a proven one - there's a
test for exactly that. And every edge records the rule that made it and the matched field values, so
you can verify the claim without trusting me. The UI shows labels, not percentages, because I have no
calibrated probability to offer."*

Code: `src/platform/rules.ts` (`mk()` applies the cap), `test/unit/analysis.test.ts`
("a chain of inferred edges can never outrank a proven chain").

### "Why not a graph database?"

*"The core query is bounded reverse reachability over a few thousand nodes. I originally planned a
recursive CTE on Postgres; in the build I did it as a bounded in-memory traversal over the events of
one business operation on SQLite, because the ablation derives alternative edge sets on the fly and I
didn't want a write per rule set. A 2,000-node investigation takes 6.8 ms p50 end to end. What I did
**not** do is benchmark Neo4j - that comparison was cut - so I can say a graph database wasn't
needed at this size, but not that it would lose."*

Code: `investigate()` stage 1 in `src/platform/analysis.ts`; bound/cycle tests in
`test/unit/analysis.test.ts`; numbers in `docs/benchmarks/results.md`.

### "What was the hardest part?"

Pick one and go deep:

- **Making the contract unforgettable.** `publish()` in `src/bus/index.ts` takes `causationId`,
  `businessOperationId` and `attempt` as *required parameters*, so omitting them is a type error -
  and, because running TypeScript natively **strips** types without checking them, a runtime check
  as well (`test/unit/pipeline.test.ts`: "publish() refuses to send without the causal contract").
  A convention test also bans `causora.*` string literals outside `contracts`.
- **Making timeouts provable.** A timeout can only name the event it awaited if that id exists
  *before* the callee runs. So callers **allocate the callee's event id**: HTTP carries it in
  `x-causora-event-id`; a consumer's id is the deterministic `consume:<message_id>:<group>`
  (`consumeEventId` in `src/contracts`). That one idea turns `TIMED_OUT_WAITING_FOR` from a guess into a
  field match.
- **Out-of-order telemetry.** A consumer span routinely arrives before its producer. `Engine.rederive()`
  (`src/platform/engine.ts`) re-derives the whole operation on every batch; it's safe because edges are
  idempotent on `(from, to, type)`. Test: "a consumer that arrives BEFORE its producer is linked when the
  producer lands" (`test/unit/pipeline.test.ts`).
- **Finding origins instead of symptoms.** The frontier condition - anomalous *and no anomalous
  ancestor* - fixes the obvious failure (ranking the payment error first). It still wasn't enough:
  in S2 the caller's client span *looked* like the origin until I measured latency as self-time and
  attributed a caller's error to its callee (see §3).

### "Tell me about a bug you found in your own work."

You have unusually good material, because the green tests did **not** find these (PROGRESS.md has
the full table). **Lead with this one - it is the cleanest story:**

- *A bug I predicted, then measured.* Before writing a held-out scenario I wrote down that "redeliveries of one
  message will collide on a single event id and two of three will be silently dropped". Then I ran it: 3.0 stored
  events per run where 9 means every delivery kept. The id was deterministic *on purpose* (so a timeout can name
  the consumer it awaits before it runs) and silently assumed one delivery. I fixed it as a **defect, not by
  tuning**: first delivery keeps the awaitable id, later ones get `#n`; a regression test fails on the old code,
  and the before/after runs are both kept in the repo. The same run also refuted a different prediction of
  mine (I expected the analyser to blame the wrong service on a deliberate rejection; it returned *nothing*), and
  I reported that too.

- *CI caught what a fast laptop hid.* The first GitHub run failed one end-to-end test: the analyser ranked an
  inventory span first in a scenario where only payment was broken. Cause: with sub-millisecond baselines and a 5 ms
  spread floor, a ~45 ms stall in a *healthy* upstream span scores as anomalous, and because the frontier rule promotes
  the earliest anomalous ancestor, that blip hijacked rank 1. I measured the flip point (0/3 correct from 40 ms up,
  matching my analytic estimate of ~45 ms), added a 250 ms noise floor, and proved the fix with a regression test that
  fails with the CI symptom when the floor is off. Be upfront about two things: **I never reproduced the CI failure
  itself** (CPU load and 2-core pinning both passed), only its mechanism; and the fix has a cost, since **slowdowns under
  250 ms are now invisible**. Details: `docs/experiments/jitter-sensitivity.md`.

- *The runner swallowed a 400.* Fault cleanup sent `DELETE` with a JSON content-type and no body;
  Fastify rejected it and my `.catch(() => undefined)` hid it. Faults leaked between scenarios, so S2–S4
  all looked like S1. I only saw it because the *ranking output* was wrong for the scenario I thought
  I was running. Fix: `clearAllFaults()` throws, and an e2e test asserts a healthy order confirms
  afterwards.
- *Silence is not quiescence.* I waited for "no telemetry for 700 ms" before analysing; an 800 ms payment
  call is itself a longer gap. Now it waits on state: terminal event present, no dangling references, then
  quiet.
- *False positives hiding in the default graph.* Reading edge lists (not summaries) showed
  `LIKELY_RETRY_OF` firing between two unrelated messages, a consumer inheriting `retry_of`, and an
  inference linking `order.failed` to its own parent. Each now has a regression test.

---

## 2. Question bank by topic

### Distributed systems

| Question | Where the answer lives |
|---|---|
| What is happens-before, and how do you establish it? | Edges are the partial order; timestamps never create a causal edge (`docs/algorithms/event-model.md` §5). Concurrency is *absence* of a path: `concurrent_with` in the evidence. |
| How do you handle clock skew? | Proven edges never read the clock. The mechanism exists - an injectable clock (`clock.offsetMs` in `src/telemetry/index.ts`) and a `clock_offset` fault type - and dwell is flagged `clock_uncertainty_ms`. **No clock-skew scenario was built or run**, so describe the design, not a measured result. |
| At-least-once vs exactly-once? | The bus (`src/bus/index.ts`) is at-least-once: visibility timeout, redelivery, dead-letter after 3 (tested). Safety comes from idempotent writes: `INSERT OR IGNORE` on `events`, primary key `(from,to,type)` on edges; re-ingest changes nothing (`test/unit/pipeline.test.ts`). |
| Duplicate vs legitimate retry? | The `duplicate` rule: same idempotency key, **different** resource ids produced, close in time. A correct guard produces no second resource, hence no `DUPLICATE_OF` edge - the `inventory-fix` control demonstrates it (e2e). |
| How would you scale the pipeline? | Design only (`docs/scalability.md`): the bus is a single-node SQLite table. Partition by business operation for single-writer-per-saga. Nothing here is implemented or measured. |
| A service is uninstrumented? | Completeness: dangling references and missing contract fields are counted and shown (`assessCompleteness` in `src/platform/analysis.ts`, a banner in the UI). A dashed "gap node" was designed, not built. |
| CAP / consistency position? | An eventually-consistent read model over a telemetry stream; the three completeness states (`COMPLETE`/`PROVISIONAL`/`DEGRADED`) expose staleness instead of hiding it. |

### Concurrency

| Question | Where |
|---|---|
| Describe a race you debugged | The demo's deliberate check-then-act idempotency race: the `INTENTIONAL BUG` block in `src/services/inventory.ts` (check → slow work → record), and the corrected variant (insert the key in the same transaction as the reservation, unique constraint decides). ADR-0016. |
| Node is single-threaded; how is this a concurrency project? | Concurrency is I/O and coordination: the inventory consumer runs handlers **concurrently** (`concurrency: 64`) - that is precisely what lets attempt 2 pass the guard while attempt 1 sleeps. Deadlines are `AbortController`s in `tracedFetch` (`src/telemetry/http.ts`). |
| Event-loop starvation? | Not a problem *measured here*: a 2,000-node investigation takes ~7 ms. The blueprint's Kafka-heartbeat story does not apply (no Kafka). Moving analysis to a worker thread is the noted next step. Don't claim to have fixed it. |
| How do you test a race? | Deterministically by construction, not by a barrier: the timing is chosen so `deadline < delay < 2×deadline` (exactly one retry; ADR-0017), and the e2e test requires ≥ 9/10 reproductions with the exact chain. |

### Messaging

| Question | Where |
|---|---|
| Is that Kafka? | **No.** It's a SQLite-backed bus with Kafka-shaped semantics: topics, keys, consumer groups, at-least-once, visibility timeout, dead-letter. No partitions, no ordering guarantee (consumers are concurrent on purpose). It's honest because the contract lives in headers, so swapping the transport touches one file (ADR-0002 note, ADR-0017). |
| How do you propagate context through a broker? | `publish()` sets the `MSG_HEADERS` set (`traceparent`, event id, causation id, business-operation id, idempotency key, attempt, retry-of, produced-at); `subscribe()` extracts them and opens the consume span *before* the handler runs. Round-trip test in `test/unit/pipeline.test.ts`. |
| What is consumer lag and why care? | `dwell_ms` = consume time − `produced_at`, scored against a baseline p95. Note it is **cross-clock**, so it carries a declared uncertainty. In these scenarios the delay is *inside* the handler, so dwell stays small; the dwell signal is implemented but not the star of any scenario. |
| Why key by order id? | The key is recorded (`message_key`) and used by the inference rule to match consumers to producers; there are no partitions to key into. |
| How do you identify a redelivered message as an event? | `consumeEventId(message, group, delivery)` in `src/contracts`: the first delivery keeps the bare, awaitable id; redeliveries get `#n`. Found as a defect via held-out prediction P6 (they used to collide and be dropped); regression test in `test/unit/pipeline.test.ts`. |
| What failures can't it localise? | A correct-but-undesired *decision* (held-out S6: inventory rejects for lack of stock). Every upstream span is healthy, so nothing is anomalous, and `order.failed` has no baseline; the analyser returns no candidate rather than guessing. It localises anomalies, not decisions. `docs/experiments/held-out.md`. |

### Databases

| Question | Where |
|---|---|
| Walk me through your schema | `SCHEMA` in `src/platform/store.ts`: `events` (indexed columns + JSON doc), `edges`, `business_operations`, `failures`, `investigations`, `baselines`, `experiment_runs`, `evaluation_runs`. |
| Why a separate correlation index table? | **Not built.** Derivation re-runs over one operation's events on every batch, which is cheap at this scale (ADR-0009 note). The blueprint's trade-off discussion still stands as design. |
| Show me a non-trivial query | The bus claim in `src/bus/index.ts`: `UPDATE … WHERE (message_pk, grp) IN (SELECT … LIMIT ?) RETURNING` - an atomic claim with a visibility timeout, the SQLite analogue of `FOR UPDATE SKIP LOCKED`. Also `loadOperationEvents` in `src/platform/store.ts` (a UNION that pulls in the fault events of every experiment touching the operation). |
| How do you avoid unbounded traversal? | Depth bound, node cap with a reported `truncated` flag, `MIN_PATH_CONFIDENCE` pruning, and a relaxation scheme that cannot loop because path confidence never increases around a cycle (`test/unit/analysis.test.ts`, "bounds" and "Tarjan"). |
| How are writes idempotent? | `INSERT OR IGNORE` keyed on `event_id`; `(from,to,type)` primary key on edges. |
| WAL / locking? | `openDb` in `src/lib/db.ts`: `busy_timeout` **before** `journal_mode=WAL` - otherwise two services opening the shared bus file at first boot raise "database is locked" (a real bug found by cold-booting three times). |

### Algorithms

| Question | Where |
|---|---|
| What graph algorithms did you implement? | Bounded reverse reachability with max-product path confidence; Tarjan SCC for cycle collapse (`stronglyConnected`); frontier computed on the SCC-condensed DAG with memoisation; connected components for pattern clusters. All in `src/platform/analysis.ts`. |
| Your graph should be a DAG - why handle cycles? | `DUPLICATE_OF` is symmetric (canonicalised by start time, ties by `event_id`) and an inferred edge can close a loop. There's a cyclic fixture test. "It's a DAG so cycles can't happen" is how a demo hangs. |
| Complexity of edge derivation? | Each rule scans the operation's event list; a few are O(n²) in the worst case (inference candidate search). Fine for tens of events per operation; BM1 measures ~15–17 k events/s overall. I haven't characterised the worst case beyond that. |
| How is the ranking deterministic? | Full tie-break chain ending in `event_id`; `DETERMINISM` test over 100 shuffled input orderings (`test/unit/analysis.test.ts`). |
| How is the ground truth kept out of the ranker? | `toRankable()` strips `experiment_id`/`is_fault_injected`; three tests defend it, and I mutation-checked them by deliberately leaking the fields (3 tests went red). |

### Observability

| Question | Where |
|---|---|
| Why not an OTel Collector? | The blueprint had one (central redaction, Jaeger fan-out). I cut it for a three-day scope and hash sensitive values in the SDK instead (`hashKey` in `src/lib/ids.ts`; test: the raw key never appears in exported spans). Trade-off: no central redaction point. |
| Is your telemetry portable? | It's OTel-**shaped** JSON with the same attribute model and W3C `traceparent`, **not** OTLP. An OTLP adapter would be a mapping layer; it isn't built. Don't say "valid OTLP". |
| Why no sampling? | The tracer exports everything (`AlwaysOn`); sampling is causally destructive - a k-edge chain survives at roughly p^k. The sampling experiment (ADR-0015) is **not built**; it's the natural follow-up. |
| What does the tracer guarantee? | Causal fields are inherited from the enclosing span by default, so a developer must opt *out* of causality (`startSpan` in `src/telemetry/index.ts`); time is injectable. |

### System design & trade-offs

| Question | Where |
|---|---|
| Why not microservices for the platform? | Shared store, one operator; splitting multiplies the debugging surface of a debugging tool. One process; analysis is pure and can move to a worker thread. ADR-0008 note. |
| What would you do differently? | Build the evaluation harness *first*. Three of the nine bugs I found were visible only in edge lists or ablation output, not in unit tests. Also: the 1.5 s settle window makes the happy path slow (a real trade-off I'd revisit). |
| What is the biggest weakness? | See §3: two heuristics were added after observing failures in my own scenarios; I then pre-registered two held-out scenarios (results in `docs/experiments/results.md`). Plus: one author for app and analyser, and a small system. |
| How would you productionise it? | ClickHouse for events, stream processing keyed by saga for derivation, multi-tenancy (authorisation on telemetry crossing teams is the hard part), causally-aware tail sampling, and shipping the contract as a real SDK. `docs/scalability.md` - design only. |
| Where would it break first? | Honestly: unmeasured beyond BM1/BM2. Likely the single SQLite writer, then per-batch re-derivation cost on very long operations. |

---

## 3. Things to be careful about

| Do not say | Say instead |
|---|---|
| "It infers root cause" | "It reconstructs the propagation chain and ranks candidate origins with evidence" |
| "AI-powered analysis" | "A declared, inspectable heuristic over a mostly-proven graph" |
| "87% confident" | "Proven - these two fields matched, here are the values" |
| "It runs on Kafka / Postgres / OTLP" | "Kafka-shaped bus on SQLite; OTel-shaped telemetry; the contract is transport-independent" |
| "It scales to millions of events/s" | "~15–17 k events/s in-process on a laptop, single node; here is what I measured and what I didn't" |
| "Novel research" | "A reproducible testbed and one controlled ablation; the field is crowded and *The Mystery Machine* (Chow et al., OSDI 2014) is the closest prior work" |
| "It found the bug" | "It ranked the origin of the chain first. The *defect* was the non-transactional guard - a different question, and the `inventory-fix` control shows the fix." |
| "100% accuracy" | "100% Hit@1 over 40 runs of four scenario types on my own system - reliable on this testbed, not a generalisation claim" |

**The weakness to volunteer.** Two analysis heuristics - measuring latency as *self-time* and attributing
a caller's error/timeout to its *callee* - exist because my first version ranked the HTTP client span as
the origin in S2/S3. They are principled (a caller waiting on a slow callee must not look slower than the
callee), but I added them after seeing those scenarios fail, so they are fitted to my scenarios. The
ablation controls for the contract, not for this. So I wrote two held-out scenarios - `inventory-crash` and
`inventory-reject` - with **predictions written in `docs/experiments/held-out.md` before the code existed** (git history
cannot prove the order - nothing was committed before the run - so say "I wrote them down first" and show the
prediction table, which `docs/experiments/results.md` grades line by line; do not claim a timestamped commit), and froze the analyser for them. The graded verdicts are generated into `docs/experiments/results.md` by
`npm run eval`; quote them exactly, **including any refuted prediction** (I expected S6, a deliberate
rejection that looks healthy to anomaly scoring, to be missed). Saying all this unprompted is worth more
than any number above.

**Be ready for the obvious follow-up: "so did the held-out scenarios validate those two heuristics?"** No - and
you can show why. A heuristic ablation (section "What the two fitted heuristics buy" of `docs/experiments/results.md`)
switches each one off over all 60 failure runs: S2 and S3 fall from 100% to 0% Hit@1, and S1/S4/S5/S6 do not
change at all. They are *necessary* on the scenarios they were fitted to and *irrelevant* on the rest, so no
current scenario tests whether they generalise. The next experiment would be a scenario written without ever
having seen it fail.

The most valuable row in the table is the last pair: volunteering the difference between *where the
chain started* and *what should be fixed* demonstrates a precision about causality that is rare.

---

## 4. Concepts to genuinely understand

Not memorise - understand well enough to be questioned about.

**Must:** happens-before and partial ordering · at-least-once vs exactly-once and why idempotency is the
bridge · why check-then-act idempotency guards race · consumer groups, redelivery, visibility timeouts ·
W3C trace context propagation · exclusive (self) time vs inclusive time · why correlation is not
causation · topological ordering and SCCs · Node's event loop.

**Should:** Lamport and vector clocks · tail vs head sampling (designed here, not built) · saga patterns ·
precision/recall/MRR and what Hit@k hides · recursive CTEs (designed here, replaced by an in-memory walk) ·
backpressure strategies.

**Nice:** causal inference fundamentals (Pearl) and why observational data is insufficient · t-digest and
approximate percentiles · graph database internals · Flink/Kafka Streams state management.

The middle group is where this project gives you real material - particularly the evaluation design:
a fault injector as ground truth, a structurally enforced no-leak rule, and an ablation on identical stored
events. That is the part to be able to explain from first principles.

---

## 5. How this file was verified

Every backticked repository path in this document was checked to exist, and every named test was checked
to be present in the suite (`npm test`). Re-run the check after any refactor:

```bash
node scripts/check-docs.mjs
```
