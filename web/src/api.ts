import { useCallback, useEffect, useRef, useState } from 'react';
import type { CausalEdge, Investigation, NormalisedEvent, RuleSet } from '../../src/contracts/index.ts';
import type { EvaluationDoc } from '../../src/platform/evaluation.ts';
import type { Scenario } from '../../src/platform/scenarios.ts';

export type { CausalEdge, Investigation, EvaluationDoc, Scenario };
export type GraphNode = Partial<NormalisedEvent> & { event_id: string; service: string; operation: string };

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.title ? `${body.title}${body.detail ? `: ${JSON.stringify(body.detail)}` : ''}` : `HTTP ${res.status}`);
  return body as T;
}

export interface FailureRow {
  failure_event_id: string;
  business_operation_id: string;
  reason: string | null;
  occurred_at: number;
  kind: string;
  experiment: { scenario_id: string } | null;
  top: { service: string; operation: string; label: string; completeness: string } | null;
}
export interface Health {
  ok: boolean;
  services: Array<{ name: string; up: boolean }>;
  events: number;
  edges: number;
  failures: number;
  baselineOps: number;
  baselines: number;
}
export interface Job { kind: string; status: 'RUNNING' | 'DONE' | 'ERROR'; startedAt: number; finishedAt?: number; error?: string; result?: unknown }
export type RuleSetInfo = Pick<RuleSet, 'id' | 'title' | 'description' | 'masked'>;

export const api = {
  health: () => j<Health>('/api/v1/health'),
  failures: () => j<FailureRow[]>('/api/v1/failures'),
  scenarios: () => j<Scenario[]>('/api/v1/scenarios'),
  ruleSets: () => j<RuleSetInfo[]>('/api/v1/rulesets'),
  job: () => j<Job | null>('/api/v1/jobs/current'),
  investigation: (id: string, ruleSet: string) => j<{ investigation: Investigation; cached: boolean }>(`/api/v1/failures/${id}/investigation?ruleSet=${encodeURIComponent(ruleSet)}`),
  reinvestigate: (id: string, ruleSet: string) => j<{ investigation: Investigation }>(`/api/v1/failures/${id}/investigate`, { method: 'POST', body: JSON.stringify({ ruleSet }) }),
  graph: (op: string, ruleSet: string, reveal: boolean) => j<{ nodes: GraphNode[]; edges: CausalEdge[] }>(`/api/v1/operations/${op}/graph?ruleSet=${encodeURIComponent(ruleSet)}&reveal=${reveal ? 1 : 0}`),
  runScenario: (scenarioId: string, count: number) => j<Job>('/api/v1/experiments/runs', { method: 'POST', body: JSON.stringify({ scenarioId, count }) }),
  seed: (count: number) => j<Job>('/api/v1/baseline/seed', { method: 'POST', body: JSON.stringify({ count }) }),
  runEvaluation: (runsPerScenario: number) => j<Job>('/api/v1/evaluation/run', { method: 'POST', body: JSON.stringify({ runsPerScenario }) }),
  evaluation: () => j<{ status: string; doc: EvaluationDoc | null; finished_at: number | null } | null>('/api/v1/evaluation/latest'),
};

/** Poll an async source; keeps the last good value on error and exposes the error. */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const run = useCallback(() => {
    fn().then(
      (v) => { if (alive.current) { setData(v); setError(null); } },
      (e) => { if (alive.current) setError(e instanceof Error ? e.message : String(e)); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    alive.current = true;
    run();
    const t = setInterval(run, intervalMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [run, intervalMs]);
  return { data, error, reload: run };
}
