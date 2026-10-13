# Research Direction

> **Build status - blueprint document.** Experiment 1 (metadata ablation) is built and reported in [results.md](results.md). The sampling experiment and counterfactual pairs beyond the single `inventory-fix` control are not built.

**Novelty claim: none.** Causal and graph-based root-cause analysis for microservices is an
active research area with substantial prior work. Causora does not advance the state of the
art and must not claim to.

What Causora can honestly offer is a **reproducible, instrumented testbed** plus one
well-executed controlled experiment. That is a real contribution for a portfolio project, and
overclaiming would destroy its credibility faster than any technical flaw.

---

## 1. Separating the three contributions

| | Claim | Strength |
|---|---|---|
| **Engineering** | A runnable event-driven system with a propagated causal-metadata contract, an evidence-classified causal graph, and a failure-analysis pipeline with explicit uncertainty | **Solid.** This is the project. |
| **Experimental** | A controlled ablation quantifying how root-cause accuracy and explanatory quality degrade as causal metadata is removed, on identical replayed input | **Solid but bounded.** Valid for these scenarios; no production claim. |
| **Research** | A testbed and a methodology others could reuse for causality-aware observability experiments | **Modest.** Worth stating; not worth inflating. |

Phrasing to use: *"a reproducible testbed and a controlled ablation study"*.
Phrasing never to use: *"a novel causal inference engine"*.

---

## 2. The primary research experiment

**Already specified** in [evaluation.md](evaluation.md) §4 - the metadata ablation. It is the
realistic single experiment this project should execute well.

Why it qualifies as a real experiment rather than a demonstration:

- A clear question with a falsifiable answer.
- Hypotheses stated **before** the runs.
- Controlled input: identical raw telemetry bytes replayed through different rule sets, so the
  only varying factor is the rule set.
- Objective metrics (Hit@1, Hit@3, MRR, graph completeness).
- An honest threats-to-validity section.
- Fully reproducible by anyone who clones the repository and runs one command.

The last point is the one most portfolio projects cannot claim.

---

## 3. Secondary question - the best post-MVP extension

**Sampling versus diagnostic capability.**

*Question:* at what head-sampling rate does causal graph completeness collapse, and does
error-biased tail sampling preserve diagnosability at a fraction of the storage cost?

*Why it is interesting.* Head sampling is near-universal in production because full-fidelity
tracing is expensive. But head sampling is **causally destructive**: dropping a producer span
orphans its consumer, which is precisely the chain Causora depends on. The trade-off is
widely assumed and rarely quantified on a system where the ground truth is known.

*Method.* Add a sampling processor to the Collector. Replay `D2-mixed` at head-sampling rates
of 100%, 50%, 20%, 10%, 5%, 1%, and separately with a tail sampler that retains any trace
belonging to a business operation containing an error. Measure graph completeness, Hit@1, MRR,
mean inferred edges per graph and bytes stored per failure diagnosed.

*Expected shape of the result.* Completeness should fall faster than linearly with the
sampling rate, because a chain of length k survives only if all k spans survive - roughly `p^k`
under independent sampling. For the primary scenario's 8-edge chain, 50% sampling would be
expected to preserve the full chain only rarely. If the data shows that, it is a clean,
quantified statement of something practitioners assume but seldom measure.

*Why error-biased tail sampling should win.* It conditions retention on the business operation
rather than the individual span, preserving whole chains for the operations that matter while
discarding whole chains for the ones that do not. The predicted result is near-`default`
diagnosability at a small fraction of the storage - and the cost is buffering until the
business operation completes, which is a real operational trade-off worth quantifying.

**Note the connection back to the architecture:** `AlwaysOnSampler` at MVP
(`observability.md` §4) was chosen *because* sampling destroys causal chains. This experiment
turns that design decision into a measured claim. The decision came first and the measurement
validates it - which is the right order.

---

## 4. Other directions, honestly rated

| Direction | Feasibility | Value | Verdict |
|---|---|---|---|
| Trace comparison against a healthy baseline (structural diff of a failing graph vs the modal healthy graph for the same operation type) | Medium | High | **Best third extension.** Would make Causora say "this graph has an edge the healthy version does not", which is closer to defect identification than ranking is. |
| Causal graph completeness as a service-level instrumentation metric | High | Medium | Cheap: `contract_violations` is already collected. A per-service compliance score is a small feature with a real product story. |
| Learned edge confidence from labelled scenario runs | Low | Low | Rejected. 30 runs is nowhere near enough data, and a learned score would destroy the declared-confidence honesty that is the project's whole position. |
| Counterfactual analysis ("would the failure have occurred without this fault?") | Medium | High | Genuinely interesting and partly achievable: scenario S7 (`inventory_fix`) **is** a counterfactual, executed rather than inferred. Running the pair automatically and diffing the graphs is a strong, honest extension. |
| Multi-failure correlation (do these 12 failures share an origin?) | Medium | Medium | Natural extension; clustering investigations by frontier node. Useful, not novel. |
| Clock-skew-robust ordering | High | Low | Already handled by design (time is evidence, not truth). S6 demonstrates it. Nothing further to research. |

**The counterfactual row deserves emphasis.** Causora can *execute* a counterfactual rather
than estimate one, because it controls the fault injector and the system. "Same fault, fixed
idempotency guard, no failure, and here is the exact edge that disappeared" is a stronger
statement than any statistical causal estimate from observational data - and it is available
essentially for free given the architecture. It is the most intellectually satisfying thing
this project can do.

---

## 5. Prior art to read and cite

Not optional. Writing about causal root-cause analysis without engaging the literature is how
a project gets dismissed in an interview with a single question.

| Work | Relevance |
|---|---|
| Lamport, *Time, Clocks, and the Ordering of Events* (1978) | The happens-before foundation. Causora's "edges are the partial order, not timestamps" rule is directly this. |
| Sigelman et al., *Dapper* (Google, 2010) | The distributed tracing model, and where its sampling trade-offs come from. |
| Chow et al., *The Mystery Machine* (OSDI 2014) | Infers causal relationships from large volumes of logs - the closest thing to what Causora deliberately does *not* claim to do. Cite as the contrast. |
| Mace et al., *Pivot Tracing* (SOSP 2015) | Dynamic causal-metadata propagation; the baggage idea Causora's contract echoes. |
| Kaldor et al., *Canopy* (Facebook, SOSP 2017) | End-to-end performance tracing at scale; event modelling and the normalisation problem. |
| Weng et al. / Wu et al., microservice RCA surveys (2018–2023) | Situates graph-based RCA; establishes that this is a crowded field. |
| OpenTelemetry specification | The actual contract Causora extends; `causora.*` as additive attributes. |

**The Mystery Machine is the most important citation**, because it defines the position
Causora takes by contrast: that paper infers causal models from observational logs at
scale; Causora argues that propagated metadata makes much of that inference unnecessary, and
then *measures what is lost when the metadata is absent* - which is, in effect, measuring how
much the inference approach has to recover.

---

## 6. If this were written up

A 6–8 page report, structured:

1. Introduction - async failures surface far from their causes
2. Background - distributed tracing, happens-before, prior RCA work
3. Position - causality is propagated, not discovered
4. The causal metadata contract
5. System design - pipeline, edge taxonomy, evidence classes
6. Failure analysis - scoping, frontier identification, ranking
7. Evaluation - scenarios, ground truth, Hit@k/MRR
8. The ablation study - the central result
9. Threats to validity
10. Related work
11. Conclusion and limitations

**Not** submittable to a venue, and should not be described as such. Entirely suitable as a
project report, a blog series, or the document that makes a technical interview go well -
because it demonstrates knowing the difference between engineering, experiment and research,
which is itself a senior-level signal.
