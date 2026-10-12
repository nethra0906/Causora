/**
 * End-to-end: boots the REAL stack (platform + order + inventory + payment, separate processes,
 * real HTTP, real SQLite bus) on isolated ports and a temp data dir, then asserts the primary
 * failure's causal graph and ranking. This is the executable form of MVP Definition-of-Done items
 * 2, 3, 5, 6, 7 and the control experiment. No sleeps: every wait is on state.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const BASE = 14000 + Math.floor(Math.random() * 2000);
const API = `http://127.0.0.1:${BASE}`;
const dataDir = mkdtempSync(join(tmpdir(), 'causora-e2e-'));
let stack: ChildProcess;

const json = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  assert.ok(res.ok, `${path} -> ${res.status} ${await res.clone().text()}`);
  return res.json() as Promise<any>;
};
const runScenario = async (scenarioId: string, count: number) => {
  const job = await json('/api/v1/experiments/runs?wait=1', { method: 'POST', body: JSON.stringify({ scenarioId, count }) });
  assert.equal(job.status, 'DONE', job.error);
  return job.result as { runs: Array<{ operationId: string; status: string; reason: string | null; failureEventId: string | null; matchedExpectation: boolean }> };
};

before(async () => {
  stack = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/stack.ts', '--fresh'], {
    env: { ...process.env, CAUSORA_PORT_BASE: String(BASE), CAUSORA_DATA_DIR: dataDir, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  stack.stdout!.on('data', (d) => (log += d));
  stack.stderr!.on('data', (d) => (log += d));
  const deadline = Date.now() + 45_000;
  while (!log.includes('Causora is up')) {
    if (Date.now() > deadline || stack.exitCode !== null) throw new Error(`stack failed to start:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const seed = await json('/api/v1/baseline/seed?wait=1', { method: 'POST', body: JSON.stringify({ count: 24 }) });
  assert.equal(seed.status, 'DONE', seed.error);
});

after(() => {
  // Windows has no process groups for kill(): terminate the whole tree explicitly.
  if (process.platform === 'win32' && stack?.pid) spawn('taskkill', ['/pid', String(stack.pid), '/T', '/F'], { stdio: 'ignore' });
  else stack?.kill('SIGTERM');
  setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 1500).unref();
});

const has = (edges: any[], fromOp: string, toOp: string, type: string, nodes: Map<string, any>) =>
  edges.some((e) => e.type === type && nodes.get(e.from_event_id)?.operation === fromOp && nodes.get(e.to_event_id)?.operation === toOp);

test('S1 reproduces in ≥ 9 of 10 runs, and every reproduced run has the exact expected causal chain', { timeout: 120_000 }, async () => {
  const { runs } = await runScenario('inventory-delay-duplicate', 10);
  const reproduced = runs.filter((r) => r.matchedExpectation);
  assert.ok(reproduced.length >= 9, `reproduced ${reproduced.length}/10 (statuses: ${runs.map((r) => `${r.status}/${r.reason}`).join(', ')})`);

  for (const run of reproduced) {
    assert.ok(run.failureEventId, 'the failure was detected and recorded');
    const g = await json(`/api/v1/operations/${run.operationId}/graph`);
    const nodes = new Map<string, any>(g.nodes.map((n: any) => [n.event_id, n]));

    // The chain the blueprint predicts, asserted on edge TYPE and the OPERATIONS they connect.
    assert.ok(has(g.edges, 'order.publish_created', 'inventory.reserve', 'TRIGGERED', nodes), 'order.created → reserve');
    assert.ok(has(g.edges, 'inventory.reserve', 'order.inventory_wait.timeout', 'TIMED_OUT_WAITING_FOR', nodes), 'reserve#1 → timeout');
    assert.ok(has(g.edges, 'order.publish_created', 'order.publish_created', 'RETRY_OF', nodes), 'attempt 1 → attempt 2');
    assert.ok(has(g.edges, 'inventory.reserve', 'inventory.reserve', 'DUPLICATE_OF', nodes), 'duplicate reservation');
    assert.ok(has(g.edges, 'payment.authorize', 'order.failed', 'TRIGGERED', nodes), 'payment rejection → order.failed');

    // Honest classes: seven-plus proven, one derived, ZERO inferred (the contract was honoured).
    assert.equal(g.edges.filter((e: any) => e.evidence_class === 'inferred').length, 0);
    assert.equal(g.edges.filter((e: any) => e.evidence_class === 'derived').length, 1);
    // Every edge exposes type, class, rule and matched field values (DoD 6).
    for (const e of g.edges) {
      assert.ok(e.type && e.evidence_class && /^rule\./.test(e.derived_by_rule) && e.evidence.matched_fields.length > 0);
    }
    // Ground truth is withheld from the default graph.
    assert.ok(g.nodes.every((n: any) => n.experiment_id === undefined && n.is_fault_injected === undefined));
  }
});

test('S1: rank 1 is the injected fault’s service and operation, as the FIRST attempt, labelled STRONG', { timeout: 60_000 }, async () => {
  const { runs } = await runScenario('inventory-delay-duplicate', 3);
  for (const run of runs.filter((r) => r.failureEventId)) {
    const { investigation } = await json(`/api/v1/failures/${run.failureEventId}/investigation`);
    const top = investigation.candidates[0];
    assert.equal(top.service, 'inventory-service');
    assert.equal(top.operation, 'inventory.reserve');
    assert.equal(top.attempt_number, 1);
    assert.equal(top.in_frontier, true);
    assert.equal(top.label, 'STRONG');
    assert.equal(investigation.completeness, 'COMPLETE');
    const patterns = investigation.patterns.map((p: any) => p.pattern);
    assert.ok(patterns.includes('DUPLICATE_WORK') && patterns.includes('IDEMPOTENCY_FAILURE'));
    assert.ok(top.evidence.path_to_failure.every((s: any) => s.evidence_class === 'proven' || s.evidence_class === 'derived'));
  }
});

test('control: the same fault with the corrected guard confirms the order and has no DUPLICATE_OF edge', { timeout: 60_000 }, async () => {
  const { runs } = await runScenario('inventory-fix', 3);
  for (const run of runs) {
    assert.equal(run.status, 'CONFIRMED');
    assert.equal(run.failureEventId, null);
    const g = await json(`/api/v1/operations/${run.operationId}/graph`);
    assert.equal(g.edges.filter((e: any) => e.type === 'DUPLICATE_OF').length, 0);
    assert.ok(g.edges.some((e: any) => e.type === 'RETRY_OF'), 'the retry still happened — only the duplicate vanished');
  }
});

/** Per-scenario graph assertions: the edges that make each failure's story provable. */
const GRAPH_ASSERTIONS: Record<string, (g: any, nodes: Map<string, any>) => void> = {
  'payment-latency': (g, nodes) => {
    assert.ok(has(g.edges, 'payment.authorize', 'order.payment_wait.timeout', 'TIMED_OUT_WAITING_FOR', nodes), 'the timeout names the exact payment call it awaited');
    const srv = g.nodes.find((n: any) => n.operation === 'payment.authorize');
    assert.equal(srv.status, 'OK', 'the server span finished later, successfully — the caller gave up, not the callee');
    assert.ok(srv.duration_ms > 1000);
  },
  'payment-error': (g, nodes) => {
    assert.ok(has(g.edges, 'payment.authorize', 'order.failed', 'TRIGGERED', nodes));
    assert.equal(g.nodes.find((n: any) => n.operation === 'payment.authorize').status, 'ERROR');
  },
  'retry-exhaustion': (g, nodes) => {
    const count = (type: string, from: string, to: string) => g.edges.filter((e: any) => e.type === type && nodes.get(e.from_event_id)?.operation === from && nodes.get(e.to_event_id)?.operation === to).length;
    assert.equal(count('RETRY_OF', 'order.publish_created', 'order.publish_created'), 2, 'three attempts = two retry edges');
    assert.equal(count('TIMED_OUT_WAITING_FOR', 'inventory.reserve', 'order.inventory_wait.timeout'), 3, 'each attempt’s timeout names its own reservation');
    assert.ok(count('DUPLICATE_OF', 'inventory.reserve', 'inventory.reserve') >= 2, 'the late reservations are duplicates of each other');
  },
};

test('the other scenarios: each produces its failure, an asserted graph, and ranks its injected fault first', { timeout: 120_000 }, async () => {
  const expected: Record<string, [string, string]> = {
    'payment-latency': ['payment-service', 'payment.authorize'],
    'payment-error': ['payment-service', 'payment.authorize'],
    'retry-exhaustion': ['inventory-service', 'inventory.reserve'],
  };
  for (const [id, [service, operation]] of Object.entries(expected)) {
    const { runs } = await runScenario(id, 2);
    for (const run of runs) {
      assert.ok(run.matchedExpectation, `${id}: expected the scenario’s failure, got ${run.status}/${run.reason}`);
      const g = await json(`/api/v1/operations/${run.operationId}/graph`);
      GRAPH_ASSERTIONS[id]!(g, new Map<string, any>(g.nodes.map((n: any) => [n.event_id, n])));
      assert.equal(g.edges.filter((e: any) => e.evidence_class === 'inferred').length, 0, `${id}: no inferred edges when the contract is honoured`);
      const { investigation } = await json(`/api/v1/failures/${run.failureEventId}/investigation`);
      assert.equal(investigation.candidates[0].service, service, id);
      assert.equal(investigation.candidates[0].operation, operation, id);
    }
  }
});

test('faults are cleared after every run: a healthy order afterwards confirms', { timeout: 30_000 }, async () => {
  const res = await fetch(`http://127.0.0.1:${BASE + 101}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const { orderId } = (await res.json()) as { orderId: string };
  const end = Date.now() + 15_000;
  for (;;) {
    const o = (await (await fetch(`http://127.0.0.1:${BASE + 101}/orders/${orderId}`)).json()) as any;
    if (o.status === 'CONFIRMED') return;
    assert.notEqual(o.status, 'FAILED', 'a leaked fault would fail this order');
    assert.ok(Date.now() < end, 'order did not reach a terminal state');
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('the fault API is unreachable without the token (gate 3), even locally', async () => {
  const res = await fetch(`http://127.0.0.1:${BASE + 102}/internal/faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ faults: [{ type: 'handler_delay', target: 'inventory.reserve', ms: 1 }], experimentId: 'x' }) });
  assert.equal(res.status, 401);
});
