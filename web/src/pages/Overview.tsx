import { useState } from 'react';
import { api, usePoll, type Health, type Job } from '../api.ts';
import { JobBanner } from '../components/JobBanner.tsx';

const REASON_COPY: Record<string, string> = {
  PAYMENT_FAILED: 'Payment rejected',
  PAYMENT_TIMEOUT: 'Payment timed out',
  RETRY_EXHAUSTED: 'Retries exhausted',
  INSUFFICIENT_STOCK: 'Insufficient stock',
};

export function Overview({ health }: { health: Health | undefined }) {
  const failures = usePoll(api.failures, 2000);
  const scenarios = usePoll(api.scenarios, 60_000);
  const job = usePoll(api.job, 1000);
  const [actionError, setActionError] = useState<string | null>(null);

  const running = job.data?.status === 'RUNNING';
  const baselineReady = (health?.baselines ?? 0) > 0;
  const start = (fn: () => Promise<Job>) => {
    setActionError(null);
    fn().then(() => job.reload(), (e) => setActionError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="page">
      <section className="hero">
        <h1>Find where a failure chain <em>started</em> — not where it surfaced.</h1>
        <p>
          Causora ingests telemetry from three event-driven services, derives typed and evidenced causal edges between events, and ranks
          the most likely origin of a failure with the proof attached. Inject a fault below, then open the investigation.
        </p>
      </section>

      <JobBanner job={job.data ?? null} />
      {actionError && <div className="banner error" role="alert">{actionError}</div>}

      <section aria-labelledby="lab">
        <div className="section-head">
          <h2 id="lab">Fault Lab</h2>
          <div className="actions">
            <span className="muted small">
              {baselineReady ? `Baseline ready · ${health?.baselines} operations from ${health?.baselineOps} healthy orders` : 'No baseline yet — latency can’t be judged without knowing what “normal” is.'}
            </span>
            <button className={baselineReady ? 'ghost' : 'primary'} disabled={running} onClick={() => start(() => api.seed(40))}>
              {baselineReady ? 'Re-seed baseline' : 'Seed baseline (40 healthy orders)'}
            </button>
          </div>
        </div>
        {scenarios.error && <div className="banner error">Could not load scenarios: {scenarios.error}</div>}
        <div className="cards">
          {scenarios.data?.map((s) => (
            <article key={s.id} className={`card ${s.control ? 'control' : ''}`}>
              <h3>{s.title}</h3>
              <p>{s.description}</p>
              <p className="symptom"><strong>What you’d see:</strong> {s.symptom}</p>
              <div className="card-actions">
                <button className="primary" disabled={running || !baselineReady} onClick={() => start(() => api.runScenario(s.id, 1))}>
                  {s.control ? 'Run control' : 'Inject & run'}
                </button>
                <button className="ghost" disabled={running || !baselineReady} onClick={() => start(() => api.runScenario(s.id, 5))} title="Five orders in parallel">×5</button>
                {!baselineReady && <span className="muted small">seed a baseline first</span>}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="failures">
        <div className="section-head">
          <h2 id="failures">Failures</h2>
          <span className="muted small">updates every 2 s</span>
        </div>
        {failures.error && <div className="banner error">Could not load failures: {failures.error}</div>}
        {failures.data && failures.data.length === 0 && (
          <div className="empty">
            <strong>No failures yet.</strong>
            <p>Seed a baseline, then inject a fault above. A failed order appears here within a few seconds of the failure.</p>
          </div>
        )}
        {failures.data && failures.data.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>When</th><th>Order</th><th>Symptom</th><th>Most likely origin</th><th>Evidence</th><th>Run</th></tr>
            </thead>
            <tbody>
              {failures.data.map((f) => (
                <tr key={f.failure_event_id}>
                  <td className="mono small">{new Date(f.occurred_at).toLocaleTimeString()}</td>
                  <td className="mono"><a href={`#/failure/${f.failure_event_id}`}>{f.business_operation_id}</a></td>
                  <td>{REASON_COPY[f.reason ?? ''] ?? f.reason ?? 'Failed'}</td>
                  <td>
                    {f.top ? <span className="mono">{f.top.service.replace('-service', '')} / {f.top.operation}</span> : <span className="muted">analysing…</span>}
                  </td>
                  <td>{f.top ? <><span className={`chip ${f.top.label.toLowerCase()}`}>{f.top.label}</span> <span className={`chip comp ${f.top.completeness.toLowerCase()}`}>{f.top.completeness}</span></> : null}</td>
                  <td className="small muted">{f.experiment?.scenario_id ?? f.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
