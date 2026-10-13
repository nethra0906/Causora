import { useEffect, useMemo, useState } from 'react';
import { api, usePoll, type CausalEdge, type GraphNode, type Investigation } from '../api.ts';
import { GraphView, fmtMs, type Selection } from '../components/GraphView.tsx';

const LABEL_COPY: Record<string, string> = {
  STRONG: 'Proven path, in the origin frontier, pattern-matched, baseline available, telemetry complete.',
  SUPPORTED: 'Proven or derived path and in the origin frontier, but not every strengthening condition holds.',
  WEAK: 'The path contains an inferred hop, lacks a baseline, or telemetry is still arriving.',
  SPECULATIVE: 'Low path confidence, degraded telemetry, or no clean frontier. Treat as a lead, not a finding.',
};
const CLASS_LABEL: Record<string, string> = { proven: 'Proven', derived: 'Derived', inferred: 'Inferred', weak: 'Weak' };

export function InvestigationPage({ failureId }: { failureId: string }) {
  const ruleSets = usePoll(api.ruleSets, 600_000);
  const [ruleSet, setRuleSet] = useState('default');
  const [reveal, setReveal] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [rerunning, setRerunning] = useState(false);

  const inv = usePoll(() => api.investigation(failureId, ruleSet), 3000, [failureId, ruleSet]);
  const investigation = inv.data?.investigation;
  const opId = investigation?.business_operation_id ?? null;
  const graph = usePoll(() => (opId ? api.graph(opId, ruleSet, reveal) : Promise.resolve(undefined)), 3000, [opId, ruleSet, reveal]);

  useEffect(() => { setCandidateId(null); setSelection(null); }, [ruleSet, failureId]);
  useEffect(() => { if (!candidateId && investigation?.candidates[0]) setCandidateId(investigation.candidates[0].event_id); }, [investigation, candidateId]);

  const candidate = investigation?.candidates.find((c) => c.event_id === candidateId);
  const focusPath = useMemo(() => new Set((candidate?.evidence.path_to_failure ?? []).map((s) => `${s.from_event_id}>${s.to_event_id}`)), [candidate]);
  const nodes: GraphNode[] = graph.data?.nodes ?? [];
  const edges: CausalEdge[] = graph.data?.edges ?? [];
  const byId = useMemo(() => new Map(nodes.map((n) => [n.event_id, n])), [nodes]);
  const name = (id: string) => { const n = byId.get(id); return n ? `${n.service?.replace('-service', '')}/${n.operation}${(n.attempt_number ?? 1) > 1 ? ` #${n.attempt_number}` : ''}` : id.slice(0, 10); };

  const rerun = async () => {
    setRerunning(true);
    try { await api.reinvestigate(failureId, ruleSet); inv.reload(); graph.reload(); } finally { setRerunning(false); }
  };

  const activeRuleSet = ruleSets.data?.find((r) => r.id === ruleSet);

  return (
    <div className="page wide">
      <div className="crumbs"><a href="#/">← All failures</a></div>

      {inv.error && !investigation && <div className="banner error" role="alert">Could not load this investigation: {inv.error}</div>}
      {!investigation && !inv.error && <div className="banner running"><span className="spinner" /> Loading investigation…</div>}

      {investigation && (
        <>
          <div className="inv-head">
            <div>
              <h1>Investigation <span className="mono small">{investigation.business_operation_id}</span></h1>
              <p className="muted">
                Most likely origin of the failure chain - presented as hypotheses with support, never as “the root cause”.
                {' '}{investigation.subgraph_node_count} events and {investigation.subgraph_edge_count} edges in the ancestor subgraph · analysed in {investigation.duration_ms.toFixed(1)} ms.
              </p>
            </div>
            <div className="controls">
              <label>
                <span>Metadata available to the analyser</span>
                <select value={ruleSet} onChange={(e) => setRuleSet(e.target.value)}>
                  {ruleSets.data?.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
                <span>Reveal injected fault <small>(does not change the ranking)</small></span>
              </label>
              <button className="ghost" onClick={rerun} disabled={rerunning}>{rerunning ? 'Re-running…' : 'Re-run on latest telemetry'}</button>
            </div>
          </div>

          {activeRuleSet && ruleSet !== 'default' && (
            <div className="banner warn" role="status">
              <strong>Ablation view - {activeRuleSet.title}.</strong> {activeRuleSet.description} The events are identical; only the contract fields the analyser may use differ. Compare with “Full contract” to see what that metadata was buying.
            </div>
          )}
          <div className={`banner comp-${investigation.completeness.toLowerCase()}`} role="status">
            <strong>Telemetry {investigation.completeness.toLowerCase()}.</strong>{' '}
            {investigation.completeness === 'COMPLETE' ? 'Every reference resolves and nothing more is arriving.' : investigation.completeness_reasons.join(' · ')}
          </div>

          <div className="inv-grid">
            <section className="graph-col" aria-label="Causal graph">
              {graph.error && <div className="banner error">Could not load the graph: {graph.error}</div>}
              <GraphView nodes={nodes} edges={edges} investigation={investigation} focusPath={focusPath} selection={selection} reveal={reveal} onSelect={setSelection} />
              <SelectionPanel selection={selection} nodes={byId} edges={edges} name={name} />
            </section>

            <aside className="side" aria-label="Candidates and evidence">
              <h2>Candidates</h2>
              {investigation.candidates.length === 0 && (
                <div className="empty small">
                  <strong>No anomalous event found in the ancestor subgraph.</strong>
                  <p>Either the causal links needed to reach the cause are missing under this rule set, or everything upstream behaved normally - for example a deliberate decision such as a stock rejection. Causora ranks anomalies; it cannot flag a correct-but-undesired decision, and it will not guess.</p>
                </div>
              )}
              <ol className="cands">
                {investigation.candidates.slice(0, 6).map((c) => (
                  <li key={c.event_id}>
                    <button className={`cand ${c.event_id === candidateId ? 'on' : ''}`} onClick={() => { setCandidateId(c.event_id); setSelection({ kind: 'node', id: c.event_id }); }}>
                      <span className="rank">#{c.rank}</span>
                      <span className="cand-main">
                        <span className="mono">{c.service.replace('-service', '')} / {c.operation}{c.attempt_number > 1 ? ` · attempt ${c.attempt_number}` : ''}</span>
                        <span className="small muted">{c.in_frontier ? 'origin of the chain' : 'downstream effect'} · depth {c.depth} · score {c.score.toFixed(2)}</span>
                      </span>
                      <span className={`chip ${c.label.toLowerCase()}`}>{c.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
              {candidate && <Evidence key={candidate.event_id} c={candidate} name={name} onPick={(from, to) => setSelection({ kind: 'edge', from, to })} />}
              <details className="config">
                <summary>Scoring details &amp; reproducibility</summary>
                <p className="small muted">Every weight and threshold used is recorded with the investigation, so the result can be reproduced exactly.</p>
                <pre className="small">{JSON.stringify({ rule_set: investigation.rule_set_id, ...investigation.config_snapshot }, null, 1)}</pre>
              </details>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function Evidence({ c, name, onPick }: { c: Investigation['candidates'][number]; name: (id: string) => string; onPick: (from: string, to: string) => void }) {
  const b = c.evidence.anomaly_breakdown;
  const bars: Array<[string, number, string]> = [
    ['latency', b.latency.contribution, b.latency.exclusive_ms === null ? 'n/a' : `${fmtMs(b.latency.exclusive_ms)} vs p95 ${fmtMs(b.latency.baseline_p95)}`],
    ['error', b.error.contribution, b.error.discounted_for_callee_error ? 'explained by a failing callee - discounted' : b.error.status],
    ['error rate', b.error_rate.contribution, `${(b.error_rate.observed * 100).toFixed(0)}% observed`],
    ['retries', b.retries.contribution, `${b.retries.descendant_retry_count} downstream`],
    ['dwell', b.dwell.contribution, b.dwell.dwell_ms === null ? 'n/a' : `${fmtMs(b.dwell.dwell_ms)} (cross-clock ±${b.dwell.clock_uncertainty_ms} ms)`],
  ];
  return (
    <div className="evidence">
      <h3>Evidence for #{c.rank}</h3>
      <p className="small"><span className={`chip ${c.label.toLowerCase()}`}>{c.label}</span> {LABEL_COPY[c.label]}</p>

      <h4>Path to the failure</h4>
      {c.evidence.path_to_failure.length === 0 ? <p className="muted small">This event is the failure itself.</p> : (
        <ol className="path">
          {c.evidence.path_to_failure.map((s, i) => (
            <li key={i}>
              <button className="linklike" onClick={() => onPick(s.from_event_id, s.to_event_id)}>
                <span className="mono">{name(s.from_event_id)}</span> → <span className="mono">{name(s.to_event_id)}</span>
              </button>
              <div className="small">
                <span className={`chip cls-${s.evidence_class}`}>{CLASS_LABEL[s.evidence_class]}</span> <span className="mono">{s.type}</span> · <span className="muted">{s.derived_by_rule}</span>
              </div>
              {s.matched_fields.map((m, k) => <div key={k} className="small mono kv">{m.field}: {m.from_value === m.to_value ? m.from_value : `${m.from_value} → ${m.to_value}`}</div>)}
            </li>
          ))}
        </ol>
      )}

      <h4>Why it scored {c.anomaly.toFixed(2)} anomalous</h4>
      <div className="bars">
        {bars.map(([label, v, note]) => (
          <div key={label} className="bar-row">
            <span className="bar-label">{label}</span>
            <span className="bar"><i style={{ width: `${Math.min(100, v * 250)}%` }} /></span>
            <span className="bar-note small muted">{note}</span>
          </div>
        ))}
      </div>

      {c.evidence.patterns.length > 0 && (<><h4>Patterns</h4><ul className="small">{[...new Set(c.evidence.patterns.map((p) => p.pattern))].map((p) => <li key={p}><span className="mono">{p}</span></li>)}</ul></>)}
      {c.evidence.concurrent_with.length > 0 && (<><h4>Concurrent</h4><p className="small muted">No causal path either way with {c.evidence.concurrent_with.length} other event(s) - they ran in parallel, not in sequence.</p></>)}
      {c.evidence.caveats.length > 0 && (<><h4>Caveats</h4><ul className="caveats small">{c.evidence.caveats.map((x, i) => <li key={i}>{x}</li>)}</ul></>)}
    </div>
  );
}

function SelectionPanel({ selection, nodes, edges, name }: { selection: Selection; nodes: Map<string, GraphNode>; edges: CausalEdge[]; name: (id: string) => string }) {
  if (!selection) return <p className="muted small hint">Click an event or an edge to see exactly how Causora knows what it claims.</p>;
  if (selection.kind === 'edge') {
    const es = edges.filter((e) => e.from_event_id === selection.from && e.to_event_id === selection.to);
    return (
      <div className="selection" role="region" aria-label="Selected edge">
        <h3>{name(selection.from)} → {name(selection.to)}</h3>
        {es.map((e) => (
          <div key={e.type} className="edge-ev">
            <div><span className={`chip cls-${e.evidence_class}`}>{CLASS_LABEL[e.evidence_class]}</span> <strong className="mono">{e.type}</strong> · <span className="muted">{e.derived_by_rule}</span></div>
            {e.evidence.matched_fields.map((m, i) => <div key={i} className="mono small kv">{m.field}: {m.from_value === m.to_value ? m.from_value : `${m.from_value} → ${m.to_value}`}</div>)}
            {e.evidence.notes && <div className="small muted">{e.evidence.notes}</div>}
            {e.evidence_class === 'inferred' && <div className="small">Declared weight {e.confidence.toFixed(2)} - a label of evidence class, not a probability.</div>}
          </div>
        ))}
      </div>
    );
  }
  const n = nodes.get(selection.id);
  if (!n) return null;
  return (
    <div className="selection" role="region" aria-label="Selected event">
      <h3>{n.service} · {n.operation}</h3>
      <div className="small mono kv">event_id: {n.event_id}</div>
      <div className="small">{n.event_type} · {fmtMs(n.duration_ms)} · {n.status}{n.error_type ? ` (${n.error_type})` : ''}</div>
      {n.idempotency_key && <div className="small mono kv">idempotency_key (hashed): {n.idempotency_key}</div>}
      {n.causation_id ? <div className="small mono kv">causation_id: {n.causation_id}</div> : <div className="small muted">causation_id: not available</div>}
      {n.contract_violations && n.contract_violations.length > 0 && <div className="small warn-text">contract: {n.contract_violations.join(', ')}</div>}
      {n.resource_ids && Object.keys(n.resource_ids).length > 0 && <div className="small mono kv">{Object.entries(n.resource_ids).map(([k, v]) => `${k}=${v}`).join(' ')}</div>}
    </div>
  );
}
