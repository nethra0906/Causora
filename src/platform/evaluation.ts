/**
 * Evaluation harness. Ground truth comes from the fault injector's record of what it broke — never
 * from the telemetry the ranker sees. For every recorded failure we replay the SAME stored events
 * through every rule set (the ablation) and ask: does the ranking name the injected service +
 * operation, and how much of the proven graph survived?
 *
 * Every number in a results table is produced here from real runs. Nothing is typed by hand.
 */
import { RULE_SETS, type Investigation } from '../contracts/index.ts';
import { uuid } from '../lib/ids.ts';
import { wallMs } from '../lib/time.ts';
import type { Engine } from './engine.ts';
import { SCENARIOS, type ScenarioRunner } from './scenarios.ts';

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

export interface EvaluationDoc {
  runs_per_scenario: number;
  scenarios: string[];
  total_runs: number;
  summaries: RuleSetSummary[];
  controls: Array<{ scenario: string; runs: number; confirmed: number; duplicate_edges: number }>;
  hardware: { platform: string; cpu: string; cores: number; ram_gb: number; node: string };
  note: string;
}

export async function runEvaluation(engine: Engine, runner: ScenarioRunner, runsPerScenario: number, hardware: EvaluationDoc['hardware']): Promise<EvaluationDoc> {
  const id = `eval_${uuid().slice(0, 8)}`;
  const startedAt = wallMs();
  engine.store.saveEvaluation(id, startedAt, null, 'RUNNING', { runs_per_scenario: runsPerScenario });

  const scores = new Map<string, Array<RunScore & { scenario: string }>>(RULE_SETS.map((r) => [r.id, []]));
  const controls: EvaluationDoc['controls'] = [];
  const defaultRs = RULE_SETS[0]!;

  for (const sc of SCENARIOS) {
    const result = await runner.runScenario(sc.id, runsPerScenario);
    if (!sc.expectFailure) {
      let dup = 0;
      for (const r of result.runs) dup += engine.store.edgesForOperation(r.operationId).filter((e) => e.type === 'DUPLICATE_OF').length;
      controls.push({ scenario: sc.id, runs: result.runs.length, confirmed: result.runs.filter((r) => r.status === 'CONFIRMED').length, duplicate_edges: dup });
      continue;
    }
    for (const run of result.runs) {
      if (!run.failureEventId) continue; // the scenario did not produce its failure; recorded via matchedExpectation
      const events = engine.store.loadOperationEvents(run.operationId);
      const truthEventIds = events.filter((e) => e.source === 'span' && e.service === sc.truth!.service && e.operation === sc.truth!.operation).sort((a, b) => a.occurred_at - b.occurred_at).map((e) => e.event_id);
      const edgesDefault = engine.graph(run.operationId, defaultRs.id, false).edges.filter((e) => e.evidence_class !== 'weak');
      const defaultPairs = new Set(edgesDefault.map((e) => `${e.from_event_id}>${e.to_event_id}`));
      for (const rs of RULE_SETS) {
        const inv = engine.investigateNow(run.failureEventId, rs.id);
        const edges = engine.graph(run.operationId, rs.id, false).edges.filter((e) => e.evidence_class !== 'weak');
        const edgePairs = new Set(edges.map((e) => `${e.from_event_id}>${e.to_event_id}`));
        const inferred = edges.filter((e) => e.evidence_class === 'inferred').length;
        scores.get(rs.id)!.push({ scenario: sc.id, ...scoreInvestigation(inv, sc.truth!, truthEventIds, defaultPairs, edgePairs, inferred, edges.length, sc.id === 'inventory-delay-duplicate') });
      }
    }
  }

  const summaries: RuleSetSummary[] = RULE_SETS.map((rs) => {
    const list = scores.get(rs.id)!;
    const by: RuleSetSummary['by_scenario'] = {};
    for (const sc of SCENARIOS.filter((s) => s.expectFailure)) {
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

  const doc: EvaluationDoc = {
    runs_per_scenario: runsPerScenario,
    scenarios: SCENARIOS.map((s) => s.id),
    total_runs: scores.get(defaultRs.id)!.length,
    summaries,
    controls,
    hardware,
    note: 'Ground truth is the fault injector’s record; the ranker never sees experiment_id or is_fault_injected. Ablated rule sets are evaluated on the SAME stored events as the default.',
  };
  engine.store.saveEvaluation(id, startedAt, wallMs(), 'COMPLETE', doc);
  return doc;
}
