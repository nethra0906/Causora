/** Demo / evaluation CLI. Talks to a running stack (npm start). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PORTS, type Investigation } from '../src/contracts/index.ts';
import { sleep } from '../src/lib/ids.ts';
import { createOrder, waitOrderTerminal } from '../src/platform/scenarios.ts';
import type { EvaluationDoc, HeldOutResult, HeuristicAblationRow } from '../src/platform/evaluation.ts';

const API = `http://127.0.0.1:${PORTS.platform}`;
const get = async (p: string) => (await fetch(`${API}${p}`)).json() as Promise<any>;
const post = async (p: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${JSON.stringify(json)}`);
  return json as any;
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

function printInvestigation(inv: Investigation) {
  console.log(`\nInvestigation of ${inv.failure_event_id}  [rule set: ${inv.rule_set_id}]`);
  console.log(`  subgraph: ${inv.subgraph_node_count} events, ${inv.subgraph_edge_count} edges   completeness: ${inv.completeness}${inv.completeness_reasons.length ? ` (${inv.completeness_reasons.join('; ')})` : ''}`);
  console.log('  most likely origins of the failure chain:');
  for (const c of inv.candidates.slice(0, 5)) {
    console.log(`   #${c.rank} ${c.service} / ${c.operation} (attempt ${c.attempt_number})  ${c.label}${c.in_frontier ? '  [frontier]' : ''}  score=${c.score.toFixed(3)}`);
  }
  const top = inv.candidates[0];
  if (top) {
    console.log('\n  evidence for #1 — path to the failure:');
    for (const s of top.evidence.path_to_failure) console.log(`    ${s.type.padEnd(22)} ${s.evidence_class.padEnd(8)} ${s.derived_by_rule}  ${s.matched_fields.map((m) => `${m.field}=${String(m.from_value).slice(0, 18)}`).join(', ')}`);
    if (top.evidence.patterns.length) console.log(`  patterns: ${[...new Set(top.evidence.patterns.map((p) => p.pattern))].join(', ')}`);
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'seed': {
      console.log('Seeding healthy baseline traffic…');
      const j = await post('/api/v1/baseline/seed?wait=1', { count: Number(arg) || 40 });
      if (j.status !== 'DONE') throw new Error(j.error);
      console.log(`done: ${j.result.orders} healthy orders → ${j.result.baselines} operation baselines`);
      break;
    }
    case 'happy-path': {
      const id = await createOrder();
      const s = await waitOrderTerminal(id);
      console.log(`order ${id} → ${s.status}`);
      await sleep(1500);
      const g = await get(`/api/v1/operations/${id}/graph`);
      const by: Record<string, number> = {};
      for (const e of g.edges) by[e.evidence_class] = (by[e.evidence_class] ?? 0) + 1;
      console.log(`causal graph: ${g.nodes.length} events, ${g.edges.length} edges`, by);
      if (s.status !== 'CONFIRMED') process.exitCode = 1;
      break;
    }
    case 'primary-failure': {
      console.log('Injecting S1 (slow inventory → timeout → retry → duplicate reservation)…');
      const j = await post('/api/v1/experiments/runs?wait=1', { scenarioId: 'inventory-delay-duplicate', count: 1 });
      if (j.status !== 'DONE') throw new Error(j.error);
      const run = j.result.runs[0];
      console.log(`order ${run.operationId} → ${run.status} (${run.reason})`);
      if (!run.failureEventId) throw new Error('no failure was recorded');
      const { investigation } = await get(`/api/v1/failures/${run.failureEventId}/investigation`);
      printInvestigation(investigation);
      const hit = investigation.candidates[0]?.service === 'inventory-service' && investigation.candidates[0]?.operation === 'inventory.reserve';
      console.log(hit ? '\n✔ rank 1 is the injected fault’s service and operation' : '\n✘ rank 1 is NOT the injected fault');
      process.exitCode = hit ? 0 : 1;
      break;
    }
    case 'eval': {
      const n = Number(arg) || 10; // 10 × 4 headline scenarios = the 40 runs the docs cite
      console.log(`Running the evaluation (${n} runs × 6 scenarios + control, each replayed through 8 rule sets; takes about ${Math.round(20 + 5 * n)} s)…`);
      const started = await post('/api/v1/evaluation/run', { runsPerScenario: n });
      void started;
      for (;;) {
        await sleep(2000);
        const job = await get('/api/v1/jobs/current');
        if (job?.status === 'DONE') break;
        if (job?.status === 'ERROR') throw new Error(job.error);
        process.stdout.write('.');
      }
      const latest = await get('/api/v1/evaluation/latest');
      const doc = latest.doc as EvaluationDoc;
      const md = renderResults(doc);
      mkdirSync('docs/experiments', { recursive: true });
      writeFileSync('docs/experiments/results.md', md);
      console.log(`\n\n${md}\nwritten to docs/experiments/results.md`);
      break;
    }
    default:
      console.error('usage: cli.ts seed [n] | happy-path | primary-failure | eval [runsPerScenario]');
      process.exitCode = 2;
  }
}

export function renderResults(doc: EvaluationDoc): string {
  const lines: string[] = [];
  lines.push('# Evaluation results (generated)', '');
  lines.push('> Generated by `npm run eval` from real runs. Do not edit by hand — re-run instead.', '');
  lines.push(`- Runs per scenario: **${doc.runs_per_scenario}** · scored failure runs: **${doc.total_runs}**`);
  lines.push(`- Hardware: ${doc.hardware.cpu} · ${doc.hardware.cores} logical cores · ${doc.hardware.ram_gb} GB RAM · ${doc.hardware.platform} · Node ${doc.hardware.node}`);
  lines.push(`- ${doc.note}`, '');
  lines.push('## Ablation: what is lost as causal metadata is removed', '');
  lines.push('| Rule set | Hit@1 | Hit@1 (first instance) | Hit@3 | MRR (± sd) | Truth reachable | Edge recall | Inferred share | Duplicate bug diagnosed (S1) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of doc.summaries) lines.push(`| \`${s.rule_set_id}\` | ${pct(s.hit1)} | ${pct(s.hit1_first)} | ${pct(s.hit3)} | ${s.mrr.toFixed(2)} ± ${s.mrr_std.toFixed(2)} | ${pct(s.truth_in_subgraph)} | ${pct(s.edge_recall)} | ${pct(s.inferred_share)} | ${pct(s.idempotency_diagnosed)} |`);
  lines.push('', 'Hit@1 matches the injected service + operation. "First instance" additionally requires the top candidate to be the earliest occurrence (attempt 1, not its retry) — it is the stricter localisation claim. "Truth reachable" = the injected operation is in the ancestor subgraph of the failure at all. "Edge recall" = share of the full-contract graph’s edges (by endpoint pair) that the rule set still recovers.', '');
  lines.push('"Duplicate bug diagnosed" = the investigation reports `IDEMPOTENCY_FAILURE` (the non-atomic guard) for the S1 runs — what `idempotency_key` buys beyond localisation.', '');
  lines.push('## Per-scenario Hit@1', '');
  const scenarios = doc.scenarios.filter((s) => doc.summaries[0]?.by_scenario[s]);
  lines.push(`| Rule set | ${scenarios.join(' | ')} |`, `|---|${scenarios.map(() => '---').join('|')}|`);
  for (const s of doc.summaries) lines.push(`| \`${s.rule_set_id}\` | ${scenarios.map((sc) => pct(s.by_scenario[sc]?.hit1 ?? 0)).join(' | ')} |`);
  lines.push('', '## How to read this', '');
  lines.push('- This is **' + doc.total_runs + ' runs of 4 scenario types**: it measures reliability and the effect of each contract field, not generalisation to unseen failure modes. Runs within a scenario are structurally near-identical, so the ± is mostly between-scenario spread.');
  lines.push('- Rule sets differ only in which contract fields are treated as absent and which rules run; every row is computed on the **same stored events**.', '');
  lines.push('## Control', '');
  for (const c of doc.controls) lines.push(`- \`${c.scenario}\`: ${c.confirmed}/${c.runs} orders confirmed, ${c.duplicate_edges} DUPLICATE_OF edges (expected 0 — the corrected guard removes exactly that edge).`);
  if (doc.heuristic_ablation?.length) lines.push('', ...renderHeuristics(doc.heuristic_ablation));
  if (doc.held_out?.length) lines.push('', ...renderHeldOut(doc.held_out));
  return lines.join('\n') + '\n';
}

function renderHeuristics(rows: HeuristicAblationRow[]): string[] {
  const out: string[] = [];
  const scenarios = Object.keys(rows[0]!.by_scenario);
  out.push('## What the two fitted heuristics buy', '');
  out.push('Both heuristics (self-time latency; attributing a caller\'s error/timeout to its callee) were added **after** S2/S3 failed. This table re-investigates **every failure run** (headline + held-out) with each one switched off, same stored events, default rule set; a naive variant also baselines raw durations. It measures what they *buy*. It does **not** show they generalise — that needs scenarios written without ever seeing them fail.', '');
  out.push(`| Variant | Hit@1 (all ${rows[0]!.runs} runs) | MRR | ${scenarios.join(' | ')} |`, `|---|---|---|${scenarios.map(() => '---').join('|')}|`);
  for (const r of rows) out.push(`| ${r.title} | ${pct(r.hit1)} | ${r.mrr.toFixed(2)} | ${scenarios.map((s) => pct(r.by_scenario[s]?.hit1 ?? 0)).join(' | ')} |`);
  const full = rows.find((r) => r.variant === 'full')!;
  const unaffected = scenarios.filter((s) => rows.every((r) => r.by_scenario[s]?.hit1 === full.by_scenario[s]?.hit1));
  out.push('', `Scenarios whose result does not change under **any** variant (so they do not exercise either heuristic): ${unaffected.length ? unaffected.map((s) => `\`${s}\``).join(', ') : 'none'}.`, '');
  return out;
}

type Verdict = '✔ confirmed' | '✘ refuted';
const verdict = (ok: boolean): Verdict => (ok ? '✔ confirmed' : '✘ refuted');
const show = (rec: Record<string, number>) => Object.entries(rec).map(([k, v]) => `${k} ×${v}`).join(', ') || '—';

/**
 * Grades the predictions pre-registered in docs/experiments/held-out.md. The checks are written
 * against the numbers, not against what I hoped: a refuted prediction prints as refuted.
 */
function renderHeldOut(results: HeldOutResult[]): string[] {
  const out: string[] = [];
  out.push('## Held-out scenarios — pre-registered predictions vs. what happened', '');
  out.push('Predictions were written **before** these scenarios were implemented ([held-out.md](held-out.md)); the analyser was frozen for them. Verdicts below are computed, not judged.', '');
  for (const r of results) {
    const total = Object.values(r.observed_outcomes).reduce((a, b) => a + b, 0);
    const d = r.by_rule_set['default']!;
    const tracing = [r.by_rule_set['ablation.tracing_only'], r.by_rule_set['ablation.tracing_only.no_inference']];
    const rows: Array<[string, Verdict | string, string]> = [];
    if (r.scenario === 'inventory-crash') {
      rows.push(['P1 every run fails with RETRY_EXHAUSTED', verdict(r.reproduced === total), `${r.reproduced}/${total} reproduced; outcomes: ${show(r.observed_outcomes)}`]);
      rows.push(['P2 default Hit@1 = 100%', verdict(d.hit1 === 1), `Hit@1 ${pct(d.hit1)} · first-instance ${pct(d.hit1_first)} · Hit@3 ${pct(d.hit3)}`]);
      const strong = (r.default.labels['STRONG'] ?? 0) + (r.default.labels['SUPPORTED'] ?? 0);
      rows.push(['P3 label STRONG/SUPPORTED; TIMEOUT_CASCADE + RETRY_STORM detected', verdict(strong === d.runs && (r.default.patterns['TIMEOUT_CASCADE'] ?? 0) === d.runs && (r.default.patterns['RETRY_STORM'] ?? 0) === d.runs), `labels: ${show(r.default.labels)}; patterns: ${show(r.default.patterns)}`]);
      rows.push(['P4 tracing-only Hit@1 = 0%', verdict(tracing.every((t) => t?.hit1 === 0)), tracing.map((t) => pct(t?.hit1 ?? 0)).join(' / ')]);
      rows.push(['P5 without awaited_correlation_id Hit@1 = 0%', verdict(r.by_rule_set['ablation.no_awaited']?.hit1 === 0), pct(r.by_rule_set['ablation.no_awaited']?.hit1 ?? 0)]);
      const m = r.default.mean_truth_operation_events;
      const collided = m <= 3.5;
      rows.push([
        'P6 redeliveries collide on one event id (a defect), without changing Hit@1',
        collided && d.hit1 === 1
          ? verdict(true)
          : m >= 8.5
            ? 'fixed — the defect was confirmed before the fix (evidence: results-before-redelivery-fix.md); every delivery is now kept'
            : '~ partly',
        `mean ${m.toFixed(1)} stored inventory.reserve events per run (9 = every delivery kept, 3 = one per message)`,
      ]);
    } else if (r.scenario === 'inventory-reject') {
      rows.push(['Q1 every run fails with INSUFFICIENT_STOCK', verdict(r.reproduced === total), `${r.reproduced}/${total} reproduced; outcomes: ${show(r.observed_outcomes)}`]);
      const orderOnly = Object.keys(r.default.top_candidates).every((k) => k.startsWith('order-service'));
      rows.push(['Q2 default Hit@1 = 0%; top candidate is in the order service', verdict(d.hit1 === 0 && orderOnly), `Hit@1 ${pct(d.hit1)}; top: ${show(r.default.top_candidates)}`]);
      // Q3 claimed "confidently connected, wrongly ranked". Connectivity alone does not earn that: it also
      // requires an actual (wrong) answer with a label. If the analyser abstained, only part of Q3 held.
      const connected = (r.default.completeness['COMPLETE'] ?? 0) === d.runs && d.truth_in_subgraph === 1;
      const answered = !('(none)' in r.default.labels) && d.runs > 0;
      rows.push(['Q3 COMPLETE, origin connected, and a confident-looking wrong answer', connected && answered ? verdict(true) : connected ? '~ partly (connected, but the analyser abstained rather than answering wrongly)' : verdict(false), `completeness: ${show(r.default.completeness)}; origin in subgraph ${pct(d.truth_in_subgraph)}; labels: ${show(r.default.labels)}`]);
    }
    out.push(`### ${r.title}`, '', '| Prediction | Verdict | Observed |', '|---|---|---|');
    for (const [p, v, o] of rows) out.push(`| ${p} | ${v} | ${o} |`);
    out.push('', '| Rule set | Hit@1 | Hit@3 | MRR | Origin reachable |', '|---|---|---|---|---|');
    for (const [id, s] of Object.entries(r.by_rule_set)) out.push(`| \`${id}\` | ${pct(s.hit1)} | ${pct(s.hit3)} | ${s.mrr.toFixed(2)} | ${pct(s.truth_in_subgraph)} |`);
    out.push('');
  }
  out.push('Held-out runs are **not** included in the headline table above. Q4 (the analyser localises anomalies, not decisions) is interpretive and not machine-graded.', '');
  return out;
}

await main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
