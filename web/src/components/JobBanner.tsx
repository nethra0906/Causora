import type { Job } from '../api.ts';

export function JobBanner({ job }: { job: Job | null }) {
  if (!job) return null;
  const secs = (((job.finishedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1);
  if (job.status === 'RUNNING') {
    return (
      <div className="banner running" role="status">
        <span className="spinner" aria-hidden="true" /> Running <strong>{job.kind}</strong> · {secs}s — faults are cleared automatically when the run ends.
      </div>
    );
  }
  if (job.status === 'ERROR') return <div className="banner error" role="alert">{job.kind} failed: {job.error}</div>;
  // A finished job is only worth a line for a few seconds.
  if (job.finishedAt && Date.now() - job.finishedAt > 20_000) return null;
  return <div className="banner ok" role="status">{job.kind} finished in {secs}s.</div>;
}
