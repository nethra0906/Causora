import { useState } from 'react';
import { api, usePoll, type EvaluationDoc, type Health } from '../api.ts';
import { JobBanner } from '../components/JobBanner.tsx';

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Cell({ v }: { v: number }) {
  return (
    <td className="num">
      <span className="cellbar" aria-hidden="true"><i style={{ width: `${Math.round(v * 100)}%` }} /></span>
      {pct(v)}
    </td>
  );
}

export function Evaluation({ health }: { health: Health | undefined }) {
  const latest = usePoll(api.evaluation, 3000);
  const job = usePoll(api.job, 1000);
  const [n, setN] = useState(10);
  const [err, setErr] = useState<string | null>(null);
  const running = job.data?.status === 'RUNNING';
  const doc: EvaluationDoc | null | undefined = latest.data?.doc;
  const baselineReady = (health?.baselines ?? 0) > 0;

  const run = () => {
    setErr(null);
    api.runEvaluation(n).then(() => job.reload(), (e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="page">
      <section className="hero">
        <h1>What is lost when causality isn’t propagated?</h1>
        <p>
          Causality here is <em>propagated, not discovered</em>. This experiment replays the <strong>same stored events</strong> through rule sets that may
          use fewer and fewer contract fields, and scores whether the ranking still names the fault the injector actually planted.
          Ground truth comes from the injector’s record; the ranker never sees it.
        </p>
      </section>

      <JobBanner job={job.data ?? null} />
      {err && <div className="banner error" role="alert">{err}</div>}

      <div className="actions row">
        <label>Runs per scenario <input type="number" min={1} max={20} value={n} onChange={(e) => setN(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} /></label>
        <button className="primary" onClick={run} disabled={running || !baselineReady}>Run evaluation</button>
        {!baselineReady && <span className="muted small">Seed a baseline on the Failures page first.</span>}
        <span className="muted small">{4 * n} headline runs + {2 * n} held-out · takes roughly {Math.round(20 + 5 * n)} s</span>
      </div>

      {!doc && <div className="empty"><strong>No evaluation has been run yet.</strong><p>Run one above. Every number on this page is produced by a real run; nothing is typed in by hand.</p></div>}

      {doc && (
        <>
          <section aria-labelledby="abl">
            <h2 id="abl">Ablation</h2>
            <p className="muted small">{doc.total_runs} scored failure runs · {doc.hardware.cpu} · {doc.hardware.cores} threads · {doc.hardware.ram_gb} GB · Node {doc.hardware.node}</p>
            <div className="scroll">
              <table className="table eval">
                <thead>
                  <tr>
                    <th>Metadata the analyser may use</th>
                    <th title="Top candidate is the injected service + operation">Hit@1</th>
                    <th title="…and it is the earliest instance, e.g. attempt 1 rather than its retry">Hit@1 first</th>
                    <th>Hit@3</th>
                    <th>MRR</th>
                    <th title="Injected operation appears in the failure's ancestor subgraph at all">Cause reachable</th>
                    <th title="Share of the full-contract graph's edges still recovered">Edge recall</th>
                    <th title="Share of edges that are heuristic rather than proven">Inferred</th>
                    <th title="IDEMPOTENCY_FAILURE diagnosed in the S1 runs">Bug diagnosed</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.summaries.map((s) => (
                    <tr key={s.rule_set_id} className={s.rule_set_id === 'default' ? 'baseline-row' : ''}>
                      <th scope="row"><div>{s.title}</div><div className="mono small muted">{s.rule_set_id}</div></th>
                      <Cell v={s.hit1} /><Cell v={s.hit1_first} /><Cell v={s.hit3} />
                      <td className="num">{s.mrr.toFixed(2)} <span className="muted small">± {s.mrr_std.toFixed(2)}</span></td>
                      <Cell v={s.truth_in_subgraph} /><Cell v={s.edge_recall} />
                      <td className="num">{pct(s.inferred_share)}</td>
                      <Cell v={s.idempotency_diagnosed} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="per">
            <h2 id="per">Hit@1 by scenario</h2>
            <div className="scroll">
              <table className="table eval">
                <thead><tr><th>Metadata the analyser may use</th>{doc.scenarios.filter((s) => doc.summaries[0]?.by_scenario[s]).map((s) => <th key={s}>{s}</th>)}</tr></thead>
                <tbody>
                  {doc.summaries.map((s) => (
                    <tr key={s.rule_set_id}>
                      <th scope="row">{s.title}</th>
                      {doc.scenarios.filter((x) => s.by_scenario[x]).map((x) => <Cell key={x} v={s.by_scenario[x]!.hit1} />)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {doc.heuristic_ablation && doc.heuristic_ablation.length > 0 && (
            <section aria-labelledby="heur">
              <h2 id="heur">What the two fitted heuristics buy</h2>
              <p className="muted small">
                Self-time latency and callee error attribution were added <strong>after</strong> S2/S3 failed. Same stored events, each heuristic switched off,
                over every failure run (headline + held-out). This shows what they <em>buy</em>; it does <strong>not</strong> show they generalise.
              </p>
              <div className="scroll">
                <table className="table eval">
                  <thead>
                    <tr>
                      <th>Variant</th><th>Hit@1 (all {doc.heuristic_ablation[0]!.runs})</th><th>MRR</th>
                      {Object.keys(doc.heuristic_ablation[0]!.by_scenario).map((s) => <th key={s}>{s}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {doc.heuristic_ablation.map((r) => (
                      <tr key={r.variant} className={r.variant === 'full' ? 'baseline-row' : ''}>
                        <th scope="row">{r.title}</th>
                        <Cell v={r.hit1} />
                        <td className="num">{r.mrr.toFixed(2)}</td>
                        {Object.keys(r.by_scenario).map((s) => <Cell key={s} v={r.by_scenario[s]!.hit1} />)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section aria-labelledby="ctl">
            <h2 id="ctl">Control</h2>
            {doc.controls.map((c) => (
              <p key={c.scenario}><span className="mono">{c.scenario}</span>: {c.confirmed}/{c.runs} orders confirmed, <strong>{c.duplicate_edges}</strong> DUPLICATE_OF edges. Same fault as S1 with the corrected idempotency guard - the failure and exactly that one edge disappear.</p>
            ))}
          </section>

          {doc.held_out && doc.held_out.length > 0 && (
            <section aria-labelledby="held">
              <h2 id="held">Held-out scenarios</h2>
              <p className="muted small">
                Written with predictions <strong>before</strong> they were implemented, with the analyser frozen (see <span className="mono">docs/experiments/held-out.md</span>).
                Not part of the table above. The graded verdicts are in the generated <span className="mono">docs/experiments/results.md</span>.
              </p>
              <div className="scroll">
                <table className="table eval">
                  <thead><tr><th>Scenario</th><th>Reproduced</th><th>Hit@1 (full contract)</th><th>Hit@1 (tracing only)</th><th>Rank-1 candidate(s)</th><th>Completeness</th></tr></thead>
                  <tbody>
                    {doc.held_out.map((h) => (
                      <tr key={h.scenario}>
                        <th scope="row"><div>{h.title}</div><div className="mono small muted">{h.scenario}</div></th>
                        <td className="num">{h.reproduced}/{Object.values(h.observed_outcomes).reduce((a, b) => a + b, 0)}</td>
                        <Cell v={h.by_rule_set['default']?.hit1 ?? 0} />
                        <Cell v={h.by_rule_set['ablation.tracing_only.no_inference']?.hit1 ?? 0} />
                        <td className="mono small">{Object.entries(h.default.top_candidates).map(([k, n]) => `${k} ×${n}`).join(', ') || '-'}</td>
                        <td className="small">{Object.entries(h.default.completeness).map(([k, n]) => `${k} ×${n}`).join(', ') || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="caveats-box">
            <h2>Read this before quoting a number</h2>
            <ul>
              <li><strong>{doc.total_runs} runs of 4 scenario types.</strong> This measures reliability and the value of each contract field on a deliberately small system; it does not claim generalisation to unseen failures.</li>
              <li>Runs within a scenario are structurally near-identical, so the ± is mostly between-scenario spread, not statistical noise.</li>
              <li>Weights are declared defaults and were not tuned on these results.</li>
              <li>Hit@1 for S1 and S4 is operation-level; “Hit@1 first” is the stricter claim that the top candidate is attempt 1.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
