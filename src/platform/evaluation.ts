/**
 * Evaluation harness. Ground truth comes from the fault injector's record of what it broke — never
 * from the telemetry the ranker sees. For every recorded failure we replay the SAME stored events
 * through every rule set (the ablation) and ask: does the ranking name the injected service +
 * operation, and how much of the proven graph survived?
 *
 * Every number in a results table is produced here from real runs. Nothing is typed by hand.
 *
 * HELD-OUT scenarios (docs/experiments/held-out.md) are run in the same pass but kept OUT of the
 * headline summaries, so the published 40-run table is unchanged; they get their own section.
 */
import { DEFAULT_CONFIG, RULE_SETS, type Investigation } from '../contracts/index.ts';
import { uuid } from '../lib/ids.ts';
import { wallMs } from '../lib/time.ts';
import type { Engine } from './engine.ts';
import { SCENARIOS, type Scenario, type ScenarioRunner } from './scenarios.ts';

export interface RunScore {
  rank: number; // 0 = truth not among candidates
  hit1: boolean;
  /** Stricter: the top candidate is the EARLIEST instance of the injected operation (e.g. attempt 1, not its retry). */
  hit1First: boolean;
  hit3: boolean;
  rr: number;
  truthInSubgraph: boolean;
  edgeRecall: number;
  inferredShare: number;
  completeness: string;
  topLabel: string | null;
  /** Did the investigation diagnose the non-atomic idempotency guard? (null when the scenario has no such bug) */
  idempotencyDiagnosed: boolean | null;
}

export function scoreInvestigation(inv: Investigation, truth: { service: string; operation: string }, truthEventIds: string[], defaultPairs: Set<string>, edgePairs: Set<string>, inferredEdges: number, totalEdges: number, expectsDuplicate = false): RunScore {
  const idx = inv.candidates.findIndex((c) => c.service === truth.service && c.operation === truth.operation);
  const rank = idx === -1 ? 0 : idx + 1;
  const recovered = [...defaultPairs].filter((p) => edgePairs.has(p)).length;
  const sub = new Set(inv.subgraph_event_ids);
  return {
    rank,
    hit1: rank === 1,
    hit1First: truthEventIds.length > 0 && inv.candidates[0]?.event_id === truthEventIds[0],
    hit3: rank >= 1 && rank <= 3,
    rr: rank === 0 ? 0 : 1 / rank,
    truthInSubgraph: truthEventIds.some((id) => sub.has(id)),
    edgeRecall: defaultPairs.size === 0 ? 1 : recovered / defaultPairs.size,
    inferredShare: totalEdges === 0 ? 0 : inferredEdges / totalEdges,
    completeness: inv.completeness,
    topLabel: inv.candidates[0]?.label ?? null,
    idempotencyDiagnosed: expectsDuplicate ? inv.patterns.some((p) => p.pattern === 'IDEMPOTENCY_FAILURE') : null,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const inc = (rec: Record<string, number>, key: string) => {
  rec[key] = (rec[key] ?? 0) + 1;
};

export interface RuleSetSummary {
  rule_set_id: string;
  title: string;
  runs: number;
  hit1: number;
  hit1_first: number;
  hit3: number;
  mrr: number;
  mrr_std: number;
  truth_in_subgraph: number;
  edge_recall: number;
  inferred_share: number;
  /** Share of S1 runs in which IDEMPOTENCY_FAILURE was diagnosed. */
  idempotency_diagnosed: number;
  by_scenario: Record<string, { runs: number; hit1: number; hit3: number; mrr: number }>;
}

/** Observations for one held-out scenario — the raw material for checking pre-registered predictions. */
export interface HeldOutResult {
  scenario: string;
  title: string;
  expected_reason: string | null;
  runs: number;
  /** Runs that ended in the scenario's expected failure. */
  reproduced: number;
  /** "FAILED/RETRY_EXHAUSTED" -> count, across all runs (including ones that did not reproduce). */
  observed_outcomes: Record<string, number>;
  by_rule_set: Record<string, { runs: number; hit1: number; hit1_first: number; hit3: number; mrr: number; truth_in_subgraph: number }>;
  /** Default rule set only. */
  default: {
    /** "service / operation" of the rank-1 candidate -> number of runs. */
    top_candidates: Record<string, number>;
    labels: Record<string, number>;
    completeness: Record<string, number>;
    /** Pattern name -> number of runs in which it was detected. */
    patterns: Record<string, number>;
    /** Mean number of stored events for the injected operation per run (exposes event-id collisions). */
    mean_truth_operation_events: number;
  };
}

/** What each of the two fitted heuristics buys, measured on EVERY failure run (headline + held-out). */
export interface HeuristicAblationRow {
  variant: string;
  title: string;
  self_time: boolean;
  callee_attribution: boolean;
  runs: number;
  hit1: number;
  mrr: number;
  by_scenario: Record<string, { runs: number; hit1: number }>;
}

const HEURISTIC_VARIANTS = [
  { variant: 'full', title: 'Both heuristics (shipped)', selfTime: true, callee: true },
  { variant: 'no_self_time', title: 'Without self-time latency', selfTime: false, callee: true },
  { variant: 'no_callee_attribution', title: 'Without callee error attribution', selfTime: true, callee: false },
  { variant: 'neither', title: 'Without either (naive scoring)', selfTime: false, callee: false },
] as const;

export interface EvaluationDoc {
  runs_per_scenario: number;
  scenarios: string[];
  total_runs: number;
  summaries: RuleSetSummary[];
  controls: Array<{ scenario: string; runs: number; confirmed: number; duplicate_edges: number }>;
  held_out?: HeldOutResult[];
  heuristic_ablation?: HeuristicAblationRow[];
  hardware: { platform: string; cpu: string; cores: number; ram_gb: number; node: string };
  note: string;
}

interface HeldAcc {
  sc: Scenario;
  outcomes: Record<string, number>;
  reproduced: number;
  top: Record<string, number>;
  labels: Record<string, number>;
  completeness: Record<string, number>;
  patterns: Record<string, number>;
  truthEventCounts: number[];
}

export async function runEvaluation(engine: Engine, runner: ScenarioRunner, runsPerScenario: number, hardware: EvaluationDoc['hardware']): Promise<EvaluationDoc> {
  const id = `eval_${uuid().slice(0, 8)}`;
  const startedAt = wallMs();
  engine.store.saveEvaluation(id, startedAt, null, 'RUNNING', { runs_per_scenario: runsPerScenario });

  const scores = new Map<string, Array<RunScore & { scenario: string }>>(RULE_SETS.map((r) => [r.id, []]));
  const controls: EvaluationDoc['controls'] = [];
  const held = new Map<string, HeldAcc>();
  const defaultRs = RULE_SETS[0]!;
  const heldIds = new Set(SCENARIOS.filter((s) => s.heldOut).map((s) => s.id));
  const failureRuns: Array<{ scenarioId: string; truth: { service: string; operation: string }; failureEventId: string }> = [];

  for (const sc of SCENARIOS) {
    const result = await runner.runScenario(sc.id, runsPerScenario);
    if (!sc.expectFailure) {
      let dup = 0;
      for (const r of result.runs) dup += engine.store.edgesForOperation(r.operationId).filter((e) => e.type === 'DUPLICATE_OF').length;
      controls.push({ scenario: sc.id, runs: result.runs.length, confirmed: result.runs.filter((r) => r.status === 'CONFIRMED').length, duplicate_edges: dup });
      continue;
    }

    const acc: HeldAcc | null = sc.heldOut
      ? { sc, outcomes: {}, reproduced: 0, top: {}, labels: {}, completeness: {}, patterns: {}, truthEventCounts: [] }
      : null;
    if (acc) {
      held.set(sc.id, acc);
      for (const r of result.runs) {
        inc(acc.outcomes, `${r.status}/${r.reason ?? '-'}`);
        if (r.matchedExpectation) acc.reproduced++;
      }
    }

    for (const run of result.runs) {
      if (!run.failureEventId) continue; // the scenario did not produce its failure; recorded via matchedExpectation
      failureRuns.push({ scenarioId: sc.id, truth: sc.truth!, failureEventId: run.failureEventId });
      const events = engine.store.loadOperationEvents(run.operationId);
      const truthEventIds = events.filter((e) => e.source === 'span' && e.service === sc.truth!.service && e.operation === sc.truth!.operation).sort((a, b) => a.occurred_at - b.occurred_at).map((e) => e.event_id);
      acc?.truthEventCounts.push(truthEventIds.length);
      const edgesDefault = engine.graph(run.operationId, defaultRs.id, false).edges.filter((e) => e.evidence_class !== 'weak');
      const defaultPairs = new Set(edgesDefault.map((e) => `${e.from_event_id}>${e.to_event_id}`));
      for (const rs of RULE_SETS) {
        const inv = engine.investigateNow(run.failureEventId, rs.id);
        const edges = engine.graph(run.operationId, rs.id, false).edges.filter((e) => e.evidence_class !== 'weak');
        const edgePairs = new Set(edges.map((e) => `${e.from_event_id}>${e.to_event_id}`));
        const inferred = edges.filter((e) => e.evidence_class === 'inferred').length;
        scores.get(rs.id)!.push({ scenario: sc.id, ...scoreInvestigation(inv, sc.truth!, truthEventIds, defaultPairs, edgePairs, inferred, edges.length, sc.id === 'inventory-delay-duplicate') });
        if (acc && rs.id === defaultRs.id) {
          const top = inv.candidates[0];
          inc(acc.top, top ? `${top.service} / ${top.operation}` : '(no candidate)');
          inc(acc.labels, top?.label ?? '(none)');
          inc(acc.completeness, inv.completeness);
          for (const name of new Set(inv.patterns.map((p) => p.pattern))) inc(acc.patterns, name);
        }
      }
    }
  }

  // Headline summaries cover the pre-existing scenarios only; held-out runs are reported separately.
  const mainScenarios = SCENARIOS.filter((s) => s.expectFailure && !s.heldOut);
  const summaries: RuleSetSummary[] = RULE_SETS.map((rs) => {
    const list = scores.get(rs.id)!.filter((x) => !heldIds.has(x.scenario));
    const by: RuleSetSummary['by_scenario'] = {};
    for (const sc of mainScenarios) {
      const sub = list.filter((x) => x.scenario === sc.id);
      by[sc.id] = { runs: sub.length, hit1: mean(sub.map((x) => +x.hit1)), hit3: mean(sub.map((x) => +x.hit3)), mrr: mean(sub.map((x) => x.rr)) };
    }
    return {
      rule_set_id: rs.id, title: rs.title, runs: list.length,
      hit1: mean(list.map((x) => +x.hit1)), hit1_first: mean(list.map((x) => +x.hit1First)), hit3: mean(list.map((x) => +x.hit3)), mrr: mean(list.map((x) => x.rr)), mrr_std: std(list.map((x) => x.rr)),
      truth_in_subgraph: mean(list.map((x) => +x.truthInSubgraph)), edge_recall: mean(list.map((x) => x.edgeRecall)), inferred_share: mean(list.map((x) => x.inferredShare)),
      idempotency_diagnosed: mean(list.filter((x) => x.idempotencyDiagnosed !== null).map((x) => +x.idempotencyDiagnosed!)),
      by_scenario: by,
    };
  });

  const held_out: HeldOutResult[] = [...held.values()].map((a) => {
    const by: HeldOutResult['by_rule_set'] = {};
    for (const rs of RULE_SETS) {
      const sub = scores.get(rs.id)!.filter((x) => x.scenario === a.sc.id);
      by[rs.id] = {
        runs: sub.length, hit1: mean(sub.map((x) => +x.hit1)), hit1_first: mean(sub.map((x) => +x.hit1First)), hit3: mean(sub.map((x) => +x.hit3)),
        mrr: mean(sub.map((x) => x.rr)), truth_in_subgraph: mean(sub.map((x) => +x.truthInSubgraph)),
      };
    }
    return {
      scenario: a.sc.id, title: a.sc.title, expected_reason: a.sc.expectedReason, runs: by[defaultRs.id]!.runs, reproduced: a.reproduced,
      observed_outcomes: a.outcomes, by_rule_set: by,
      default: { top_candidates: a.top, labels: a.labels, completeness: a.completeness, patterns: a.patterns, mean_truth_operation_events: mean(a.truthEventCounts) },
    };
  });

  // Heuristic ablation: same stored events, default rule set, only the two analysis heuristics vary.
  const failureScenarioIds = SCENARIOS.filter((s) => s.expectFailure).map((s) => s.id);
  const heuristic_ablation: HeuristicAblationRow[] = HEURISTIC_VARIANTS.map((v) => {
    const cfg = { ...DEFAULT_CONFIG, selfTimeLatency: v.selfTime, calleeErrorAttribution: v.callee };
    const rows = failureRuns.map((r) => {
      const inv = engine.investigateNow(r.failureEventId, defaultRs.id, wallMs(), cfg);
      const idx = inv.candidates.findIndex((c) => c.service === r.truth.service && c.operation === r.truth.operation);
      return { scenario: r.scenarioId, hit1: idx === 0, rr: idx === -1 ? 0 : 1 / (idx + 1) };
    });
    const by: HeuristicAblationRow['by_scenario'] = {};
    for (const id of failureScenarioIds) {
      const sub = rows.filter((x) => x.scenario === id);
      by[id] = { runs: sub.length, hit1: mean(sub.map((x) => +x.hit1)) };
    }
    return { variant: v.variant, title: v.title, self_time: v.selfTime, callee_attribution: v.callee, runs: rows.length, hit1: mean(rows.map((x) => +x.hit1)), mrr: mean(rows.map((x) => x.rr)), by_scenario: by };
  });

  const doc: EvaluationDoc = {
    runs_per_scenario: runsPerScenario,
    scenarios: mainScenarios.map((s) => s.id),
    total_runs: summaries[0]!.runs,
    summaries,
    controls,
    held_out,
    heuristic_ablation,
    hardware,
    note: 'Ground truth is the fault injector’s record; the ranker never sees experiment_id or is_fault_injected. Ablated rule sets are evaluated on the SAME stored events as the default.',
  };
  engine.store.saveEvaluation(id, startedAt, wallMs(), 'COMPLETE', doc);
  return doc;
}
