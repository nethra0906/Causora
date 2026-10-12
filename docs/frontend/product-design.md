# Frontend Product Design

> **Build status — blueprint document.** Built screens: **Failures & Fault Lab** (merged), **Investigation** (graph, candidates, evidence, ablation selector, reveal toggle) and **Evaluation**. Not built: Trace explorer, Service explorer, timeline tab, concurrency lanes, SSE. Evidence class is encoded by line style **and** label, never colour alone.

The UI is where Causora's position either lands or collapses. A graph that renders proven and
guessed relationships identically would undo the entire architecture. **Evidence class must be
visually unmistakable.**

Stack: React 18, TypeScript, Vite, TanStack Query, React Flow (graph), Tailwind, Zod types
imported from `packages/contracts`.

---

## 1. Screens

### MVP

| Screen | Route | Purpose |
|---|---|---|
| Overview | `/` | What is happening, what failed, what can be proven |
| Investigation | `/investigations/:id` | **The product.** Causal graph + timeline + evidence + candidates |
| Fault Lab | `/lab` | Run a scenario, watch it fail, open the investigation |

### Post-MVP

| Screen | Route | Purpose |
|---|---|---|
| Operation Explorer | `/operations`, `/operations/:id` | Browse business operations, succeeded and failed |
| Trace Explorer | `/traces/:id` | Span waterfall — the deliberate point of comparison |
| Service Explorer | `/services` | Dependency map, per-operation health, contract compliance |
| Analytics | `/analytics` | Failure rates, pattern frequency, latency trends |
| Evaluation | `/evaluation` | Hit@k, MRR, ablation comparison |

Three screens for MVP, not eight. Each of the three is on the critical path of the core user
journey; the rest are browsing conveniences that a 4–6 week budget cannot afford and the demo
does not need.

---

## 2. Overview — `/`

**Purpose.** Answer three questions in one screen: is anything failing, how much can Causora
prove right now, and is a fault currently injected.

**Layout.**

```
+--------------------------------------------------------------------------+
| Causora          [ 15m v ]              Contract health: COMPLETE  (o)   |
+--------------------------------------------------------------------------+
| Operations 214 | Succeeded 201 | Failed 13 | Ingest lag 180ms            |
+--------------------------------------------------------------------------+
| (!) Fault active: delayed_inventory on inventory-service — expires 0:42  |
+--------------------------------------------------------------------------+
| RECENT FAILURES                                                          |
| +----------------------------------------------------------------------+ |
| | payment-service  POST /payments/authorize                            | |
| | RESERVATION_AMOUNT_MISMATCH          ord_8891        11:58:12         | |
| | Origin: inventory-service / inventory.reserve   [STRONG]  -> Investigate| |
| +----------------------------------------------------------------------+ |
+--------------------------------------------------------------------------+
```

**Data.** `GET /api/v1/overview?window=15m`, polled every 5 s via TanStack Query.

**Key interaction.** Each failure card shows the top candidate's service, operation and label
*before* the user clicks. The user's first action is a decision about whether to investigate,
so the card must contain enough to make it.

**Contract health is in the header, not buried.** The first thing the tool says is how much it
can actually prove. If telemetry is degraded, the user learns it before they trust a result.

| State | Presentation |
|---|---|
| Empty | "No telemetry yet." Primary button: "Run a scenario" → `/lab`. Secondary: `pnpm demo:happy-path` command shown. |
| Error | Inline banner naming the failed dependency from `/health`, with retry. Never a blank page. |
| Degraded contract | Header chip turns red; clicking shows the violated fields and counts. |

---

## 3. Investigation — `/investigations/:id`

The centrepiece. Four coordinated panels; selection is shared state across all of them.

```
+--------------------------------------------------------------------------+
| ord_8891 · payment-service RESERVATION_AMOUNT_MISMATCH                   |
| Completeness: COMPLETE · 34 events · 45 edges · analysed in 212ms        |
| [ Graph ] [ Timeline ]     Evidence: [x] Proven [x] Derived [x] Inferred |
|                                      [ ] Weak      [ ] Reveal fault      |
+----------------------------------------------+---------------------------+
|                                              | MOST LIKELY ORIGIN        |
|   [fault] (hidden unless Reveal)             | 1. inventory.reserve #1   |
|                                              |    inventory-service      |
|   (order.created#1)                          |    [STRONG]               |
|        | TRIGGERED (proven)                  |    5041ms vs p95 79ms     |
|        v                                     |                           |
|   [inventory.reserve#1  5041ms] <<FRONTIER>> | 2. order.created #2       |
|        | TIMED_OUT_WAITING_FOR (proven)      |    [SUPPORTED]            |
|        v                                     |                           |
|   <timeout.fired>                            | PATTERNS                  |
|        | RETRY_OF (proven)                   | - IDEMPOTENCY_FAILURE     |
|        v                                     | - DUPLICATE_WORK          |
|   (order.created#2)                          |                           |
|        | TRIGGERED (proven)                  | CAVEATS                   |
|        v                                     | (none)                    |
|   [inventory.reserve#2] ~~DUPLICATE_OF~~     |                           |
|        | TRIGGERED (proven)                  |                           |
|        v                                     |                           |
|   [payment.authorize ERROR]                  |                           |
+----------------------------------------------+---------------------------+
| EVIDENCE — selected edge: inventory.reserve#1 -> timeout.fired           |
| Rule: rule.timeout.awaited@1            Class: PROVEN   Confidence: 1.00 |
| Matched: awaited_correlation_id = evt_b1  ==  event_id = evt_b1          |
+--------------------------------------------------------------------------+
```

### Visual language for evidence class — non-negotiable

| Class | Edge rendering | Label |
|---|---|---|
| Proven | solid, 2px, full-opacity | `PROVEN` |
| Derived | solid, 2px, dash-dot pattern | `DERIVED` |
| Inferred | dashed, 1.5px, 60% opacity | `INFERRED` |
| Weak | dotted, 1px, 30% opacity, **off by default** | `WEAK — not used in analysis` |

Never colour-only: evidence class is encoded in **line style plus a text label**, so it
survives colour blindness, greyscale printing and screenshots in a slide deck. Colour is
reserved for status (error red, anomaly amber, normal neutral).

### Node rendering

| Element | Encoding |
|---|---|
| Width | proportional to `durationMs` (log scale, floor for point events) |
| Border | red = ERROR/TIMEOUT, amber = anomalous, neutral = normal |
| Badge `FRONTIER` | `anomaly.isFrontier` — the propagation origin |
| Badge `#2` | `attemptNumber > 1` |
| Badge flask | `is_fault_injected`, **only when Reveal is on** |
| Dashed container | cluster; shows member count, expandable |
| Hatched node | `missing_hop` placeholder, "no telemetry" |

### Concurrency

Concurrent events (from `concurrentGroups`) render in **parallel vertical lanes with an
explicit "concurrent" bracket**. The two reservation attempts must never appear stacked in a
way that implies ordering. This is the honesty requirement that most directly contradicts how
a trace waterfall would draw it, and it is the visual payoff of the whole design.

### Timeline tab

Same data, time on the x-axis, one lane per concurrent group. Spans as bars, point events as
ticks, dwell time as a distinct hatched segment preceding a consume event. Brush to zoom.
Selection synchronised with the graph.

Dwell time rendered as its own visual segment is important: it is what makes `SLOW_CONSUMER`
legible at a glance, and no trace viewer draws it.

### Interactions

| Action | Result |
|---|---|
| Click node | Evidence panel shows the event, attributes, baseline, anomaly breakdown |
| Click edge | Evidence panel shows rule, class, confidence, matched field values |
| Click candidate | Highlights its full path to the failure; dims everything else |
| Toggle evidence class | Re-filters the graph client-side; counts update |
| Toggle Reveal fault | Shows `FAULT_AFFECTED` edges and the flask badge. **Default off.** |
| Collapse/expand cluster | Local state |
| Re-run | `POST /api/v1/investigations`, navigates to the new id |
| Copy evidence | Markdown summary to clipboard, for pasting into an incident channel |

**Reveal fault defaults to off and is labelled "Reveal injected fault (ground truth)".** The
user should form a conclusion from the evidence before seeing the answer. That ordering is
what makes a demo convincing — and it mirrors how the evaluation harness works.

### States

| State | Presentation |
|---|---|
| `RUNNING` | Skeleton graph, progress via SSE (`/stream`), stage name shown |
| `PROVISIONAL` | Amber banner: "Telemetry still arriving — results may change." Re-run button. |
| `DEGRADED` | Red banner listing missing contract fields and counts, with a link to the contract doc |
| `truncated` | Banner: "Subgraph truncated at 5000 nodes. Showing the 5000 nearest the failure." |
| `frontierFallback` | Banner explaining that no clean frontier was found and what was used instead |
| `FAILED` | Error with the stage that failed, and a retry button |
| Empty candidates | "No candidate origin could be identified" plus the reasons from `caveats` — never a blank panel |

Every degraded state has copy written in advance. Vague or absent empty states are where
debugging tools lose credibility.

---

## 4. Fault Lab — `/lab`

**Purpose.** Reproduce a failure on demand. This closes the user journey loop and is the
screen that makes the project feel alive in a demo.

```
+--------------------------------------------------------------------------+
| FAULT LAB                              (!) Enabled: non-production only  |
+--------------------------------------------------------------------------+
| SCENARIOS                          | delayed_inventory                   |
| > delayed_inventory      PRIMARY   | Delays inventory reservation so the |
|   payment_timeout                  | order saga times out and retries,   |
|   slow_consumer                    | racing a non-transactional          |
|                                    | idempotency guard.                  |
|                                    |                                     |
|                                    | delayMs    [ 5000 ]                 |
|                                    | orderCount [    1 ]                 |
|                                    | ruleSet    [ default v ]            |
|                                    |                                     |
|                                    | Expect: ~12s, payment failure        |
|                                    | Ground truth hidden until complete   |
|                                    |                                     |
|                                    |        [ Run scenario ]              |
+--------------------------------------------------------------------------+
| RUN exp_01HX...   RUNNING                                                |
| [x] Faults applied   [x] Workload driving   [ ] Awaiting terminal state  |
| [ ] Telemetry settling   [ ] Investigating                               |
+--------------------------------------------------------------------------+
```

**Live progress against the runner's steps**, so the user sees that something real is
happening rather than a spinner. On completion: "Failure captured → Investigate" linking
straight to the investigation. The ground-truth panel unlocks only *after* the investigation
exists, preserving the evidence-before-answer ordering.

**States.** Disabled (503 from the API) → the whole screen shows an explanatory panel naming
the three gates and the env var to set, not a broken form. Already-running (409) → shows the
active run instead of letting a second start.

---

## 5. The core user journey

This is the experience the product is built around; every MVP screen exists to serve it.

```
1. Open Causora                          -> Overview
2. See a failed order, with a named likely origin and a STRONG label
3. Click Investigate                     -> Investigation
4. Read the chain backwards from the failure; the frontier node is marked
5. Click the suspicious edge             -> Evidence: the exact matched field values
6. Switch to Timeline                    -> see the two reservations are CONCURRENT,
                                            and see the dwell segment
7. Read the patterns                     -> IDEMPOTENCY_FAILURE names the actual bug
8. (optional) Open the Trace Explorer    -> see that the waterfall does not show any of this
9. Toggle Reveal fault                   -> ground truth confirms the frontier node
10. Go to Fault Lab, re-run              -> same chain, reproducible
11. Run the `inventory_fix` variant      -> same fault, no DUPLICATE_OF edge, no failure
```

Step 11 is the close. Same injected fault, corrected idempotency implementation, and the graph
visibly loses exactly one edge. It proves the tool measures the system rather than narrating a
script.

---

## 6. Frontend architecture

```
web/src/
├── main.tsx, App.tsx, router.tsx
├── api/
│   ├── client.ts            fetch wrapper, auth, RFC7807 -> typed errors
│   ├── queries.ts           TanStack Query hooks, keys, stale times
│   └── sse.ts               investigation progress stream
├── screens/
│   ├── overview/
│   ├── investigation/
│   │   ├── InvestigationScreen.tsx
│   │   ├── CausalGraph.tsx         React Flow + custom node/edge components
│   │   ├── Timeline.tsx            SVG, no chart library needed
│   │   ├── EvidencePanel.tsx
│   │   ├── CandidateList.tsx
│   │   └── layout.ts               dagre layered DAG layout, concurrency lanes
│   └── lab/
├── components/              EvidenceBadge, ConfidenceLabel, StatusDot, Caveats,
│                            EmptyState, ErrorBanner, CompletenessChip
└── lib/                     time formatting, duration scales, colour tokens
```

**React Flow, not D3 from scratch.** Pan, zoom, selection, custom nodes and edge routing are
solved problems; the project's time belongs in the causality engine. Layout via `dagre` in
layered mode, with a post-pass that assigns concurrent groups to sibling lanes.

**Performance.** Above `MAX_UI_NODES` (800), clusters render collapsed by default and a banner
explains it. React Flow virtualises off-viewport nodes. The retry-storm scenario is the test
case, and it must be run against the UI, not just the API.

**Accessibility.** The graph has a keyboard-navigable list equivalent (tab through candidates
and their paths); evidence class is never colour-only; all interactive nodes have accessible
names; the timeline has a table equivalent. A visualisation-heavy tool still needs to be
readable by a screen reader, and the list equivalent is also what makes "copy evidence" useful.
