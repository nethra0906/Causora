import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_RULE_SET_ID, PORTS, RULE_SETS, getRuleSet, ingestSchema } from '../contracts/index.ts';
import { dataDir } from '../lib/db.ts';
import { wallMs } from '../lib/time.ts';
import { toRankable } from './analysis.ts';
import { Engine } from './engine.ts';
import { runEvaluation, type EvaluationDoc } from './evaluation.ts';
import { SCENARIOS, ScenarioRunner, getScenario } from './scenarios.ts';
import { Store } from './store.ts';

const problem = (status: number, title: string, detail?: unknown) => ({ type: 'about:blank', title, status, detail });

type Job = { kind: string; status: 'RUNNING' | 'DONE' | 'ERROR'; startedAt: number; finishedAt?: number; result?: unknown; error?: string };

export async function startPlatform(port: number = PORTS.platform): Promise<{ stop(): Promise<void>; engine: Engine }> {
  const store = new Store(join(dataDir(), 'causora.db'));
  const engine = new Engine(store);
  const runner = new ScenarioRunner(engine);
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] });

  let job: Job | null = null;
  const startJob = (kind: string, fn: () => Promise<unknown>): Job | null => {
    if (job?.status === 'RUNNING') return null;
    const j: Job = { kind, status: 'RUNNING', startedAt: wallMs() };
    job = j;
    void fn().then(
      (r) => { j.status = 'DONE'; j.result = r; j.finishedAt = wallMs(); },
      (e) => { j.status = 'ERROR'; j.error = e instanceof Error ? e.message : String(e); j.finishedAt = wallMs(); },
    );
    return j;
  };

  // ───────────────────────── ingest ─────────────────────────
  app.post('/v1/spans', async (req, reply) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).type('application/problem+json').send(problem(422, 'Invalid telemetry payload', parsed.error.issues.slice(0, 5)));
    const res = engine.ingest(parsed.data.spans);
    return reply.code(202).send(res);
  });

  // ───────────────────────── read API ─────────────────────────
  app.get('/api/v1/health', async () => {
    const check = async (name: string, url: string) => {
      try {
        const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) });
        return { name, up: r.ok };
      } catch {
        return { name, up: false };
      }
    };
    const services = await Promise.all([
      check('order-service', `http://127.0.0.1:${PORTS.order}`),
      check('inventory-service', `http://127.0.0.1:${PORTS.inventory}`),
      check('payment-service', `http://127.0.0.1:${PORTS.payment}`),
    ]);
    return { ok: true, services, ...store.counts(), baselines: store.baselines().length };
  });

  app.get('/api/v1/rulesets', async () => RULE_SETS.map(({ id, title, description, masked, enabled }) => ({ id, title, description, masked, enabled })));
  app.get('/api/v1/scenarios', async () => SCENARIOS);
  app.get('/api/v1/baseline', async () => store.baselines());

  app.get('/api/v1/failures', async () => {
    const rows = store.listFailures(100);
    return rows.map((r) => ({
      failure_event_id: r.failure_event_id, business_operation_id: r.business_operation_id, reason: r.reason, occurred_at: r.occurred_at, kind: r.kind,
      experiment: store.experimentRunByOp(r.business_operation_id) ?? null,
      top: r.top?.candidates[0]
        ? { service: r.top.candidates[0].service, operation: r.top.candidates[0].operation, label: r.top.candidates[0].label, completeness: r.top.completeness }
        : null,
    }));
  });

  app.get<{ Params: { id: string }; Querystring: { ruleSet?: string } }>('/api/v1/failures/:id/investigation', async (req, reply) => {
    const ruleSetId = req.query.ruleSet ?? DEFAULT_RULE_SET_ID;
    try { getRuleSet(ruleSetId); } catch { return reply.code(400).send(problem(400, 'Unknown rule set')); }
    if (!store.failureById(req.params.id)) return reply.code(404).send(problem(404, 'Unknown failure'));
    const cached = ruleSetId === DEFAULT_RULE_SET_ID ? store.getInvestigation(req.params.id, ruleSetId) : undefined;
    return { investigation: cached ?? engine.investigateNow(req.params.id, ruleSetId), cached: !!cached };
  });

  app.post<{ Params: { id: string }; Body: { ruleSet?: string } }>('/api/v1/failures/:id/investigate', async (req, reply) => {
    const ruleSetId = req.body?.ruleSet ?? DEFAULT_RULE_SET_ID;
    if (!store.failureById(req.params.id)) return reply.code(404).send(problem(404, 'Unknown failure'));
    return { investigation: engine.investigateNow(req.params.id, ruleSetId), cached: false };
  });

  app.get<{ Params: { id: string }; Querystring: { ruleSet?: string; reveal?: string } }>('/api/v1/operations/:id/graph', async (req, reply) => {
    try { getRuleSet(req.query.ruleSet ?? DEFAULT_RULE_SET_ID); } catch { return reply.code(400).send(problem(400, 'Unknown rule set')); }
    return engine.graph(req.params.id, req.query.ruleSet ?? DEFAULT_RULE_SET_ID, req.query.reveal === '1');
  });

  app.get<{ Params: { id: string } }>('/api/v1/operations/:id/events', async (req) =>
    store.loadOperationEvents(req.params.id).filter((e) => e.source !== 'fault').map(toRankable));

  // ───────────────────────── experiments ─────────────────────────
  app.get('/api/v1/experiments/runs', async () => store.listExperimentRuns(100));
  app.get('/api/v1/jobs/current', async () => job);

  const runBody = z.object({ scenarioId: z.string(), count: z.number().int().min(1).max(20).default(1) });
  app.post<{ Querystring: { wait?: string } }>('/api/v1/experiments/runs', async (req, reply) => {
    const body = runBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send(problem(422, 'Invalid request', body.error.issues));
    try { getScenario(body.data.scenarioId); } catch { return reply.code(404).send(problem(404, 'Unknown scenario')); }
    const j = startJob(`scenario:${body.data.scenarioId}`, () => runner.runScenario(body.data.scenarioId, body.data.count));
    if (!j) return reply.code(409).send(problem(409, 'Another run is in progress'));
    if (req.query.wait === '1') {
      while (j.status === 'RUNNING') await new Promise((r) => setTimeout(r, 100));
      return j;
    }
    return reply.code(202).send(j);
  });

  app.post<{ Querystring: { wait?: string } }>('/api/v1/baseline/seed', async (req, reply) => {
    const count = Math.min(200, Math.max(20, Number((req.body as any)?.count ?? 40)));
    const j = startJob('baseline', () => runner.seedBaseline(count));
    if (!j) return reply.code(409).send(problem(409, 'Another run is in progress'));
    if (req.query.wait === '1') {
      while (j.status === 'RUNNING') await new Promise((r) => setTimeout(r, 100));
      return j;
    }
    return reply.code(202).send(j);
  });

  app.post('/api/v1/evaluation/run', async (req, reply) => {
    const n = Math.min(20, Math.max(1, Number((req.body as any)?.runsPerScenario ?? 8)));
    const hardware: EvaluationDoc['hardware'] = { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, ram_gb: Math.round((totalmem() / 2 ** 30) * 10) / 10, node: process.version };
    if (store.baselines().length === 0) return reply.code(409).send(problem(409, 'Seed a baseline first (POST /api/v1/baseline/seed)'));
    const j = startJob('evaluation', () => runEvaluation(engine, runner, n, hardware));
    if (!j) return reply.code(409).send(problem(409, 'Another run is in progress'));
    return reply.code(202).send(j);
  });
  app.get('/api/v1/evaluation/latest', async () => store.latestEvaluation() ?? null);

  // ───────────────────────── static web UI ─────────────────────────
  const webRoot = resolve('web/dist');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') || req.url.startsWith('/v1/') ? reply.code(404).send(problem(404, 'Not found')) : reply.sendFile('index.html')));
  }

  await app.listen({ port, host: '127.0.0.1' });
  return { engine, stop: async () => { await app.close(); store.close(); } };
}
