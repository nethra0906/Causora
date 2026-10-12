/** Demo / evaluation CLI. Talks to a running stack (npm start). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PORTS, type Investigation } from '../src/contracts/index.ts';
import { sleep } from '../src/lib/ids.ts';
import { createOrder, waitOrderTerminal } from '../src/platform/scenarios.ts';
import type { EvaluationDoc } from '../src/platform/evaluation.ts';

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
      const n = Number(arg) || 8;
      console.log(`Running the evaluation (${n} runs per scenario × ${5} scenarios × ${8} rule sets)…`);
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
  return lines.join('\n') + '\n';
}

await main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
