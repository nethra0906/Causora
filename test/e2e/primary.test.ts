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
/** Known token so a test can drive the (triple-gated) fault API directly. */
const FAULT_TOKEN = 'e2e-fault-token-0123456789abcdef';
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
    env: { ...process.env, CAUSORA_PORT_BASE: String(BASE), CAUSORA_DATA_DIR: dataDir, NODE_ENV: 'test', CAUSORA_FAULT_TOKEN: FAULT_TOKEN },
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
    assert.ok(g.edges.some((e: any) => e.type === 'RETRY_OF'), 'the retry still happened - only the duplicate vanished');
  }
});

/** Per-scenario graph assertions: the edges that make each failure's story provable. */
const GRAPH_ASSERTIONS: Record<string, (g: any, nodes: Map<string, any>) => void> = {
  'payment-latency': (g, nodes) => {
    assert.ok(has(g.edges, 'payment.authorize', 'order.payment_wait.timeout', 'TIMED_OUT_WAITING_FOR', nodes), 'the timeout names the exact payment call it awaited');
    const srv = g.nodes.find((n: any) => n.operation === 'payment.authorize');
    assert.equal(srv.status, 'OK', 'the server span finished later, successfully - the caller gave up, not the callee');
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
      // On failure, say WHY: the top candidates with their latency evidence, so a CI log is diagnosable.
      const why = investigation.candidates.slice(0, 3).map((c: any) => {
        const l = c.evidence.anomaly_breakdown.latency;
        return `${c.service}/${c.operation} anomaly=${c.anomaly.toFixed(2)} self=${Math.round(l.exclusive_ms ?? -1)}ms p95=${Number(l.baseline_p95 ?? -1).toFixed(2)}ms`;
      }).join(' | ');
      assert.equal(investigation.candidates[0].service, service, `${id}: ${why}`);
      assert.equal(investigation.candidates[0].operation, operation, `${id}: ${why}`);
    }
  }
});

// Held-out scenarios (docs/experiments/held-out.md). These tests pin down MECHANICS only - that each
// scenario reproduces and that its causal chain is wired as designed. They deliberately do NOT assert
// the ranking or the redelivery behaviour: those are pre-registered predictions, graded by `npm run eval`.
test('held-out S5 (handler throws): reproduces RETRY_EXHAUSTED with failing spans and provable timeouts', { timeout: 60_000 }, async () => {
  const { runs } = await runScenario('inventory-crash', 2);
  for (const run of runs) {
    assert.ok(run.matchedExpectation, `expected FAILED/RETRY_EXHAUSTED, got ${run.status}/${run.reason}`);
    const g = await json(`/api/v1/operations/${run.operationId}/graph`);
    const nodes = new Map<string, any>(g.nodes.map((n: any) => [n.event_id, n]));
    const failing = g.nodes.filter((n: any) => n.operation === 'inventory.reserve' && n.status === 'ERROR');
    assert.ok(failing.length >= 1, 'the injected exception ends the consume span in ERROR');
    assert.ok(failing.every((n: any) => n.error_type === 'EXCEPTION'));
    assert.ok(has(g.edges, 'inventory.reserve', 'order.inventory_wait.timeout', 'TIMED_OUT_WAITING_FOR', nodes), 'each timeout still names the consumer it awaited');
    assert.equal(g.edges.filter((e: any) => e.evidence_class === 'inferred').length, 0);
  }
});

test('held-out S6 (deliberate rejection): reproduces INSUFFICIENT_STOCK with a fully proven chain and healthy upstream spans', { timeout: 60_000 }, async () => {
  const { runs } = await runScenario('inventory-reject', 2);
  for (const run of runs) {
    assert.ok(run.matchedExpectation, `expected FAILED/INSUFFICIENT_STOCK, got ${run.status}/${run.reason}`);
    const g = await json(`/api/v1/operations/${run.operationId}/graph`);
    const nodes = new Map<string, any>(g.nodes.map((n: any) => [n.event_id, n]));
    assert.ok(has(g.edges, 'inventory.publish_rejected', 'order.on_inventory_reply', 'TRIGGERED', nodes), 'the rejection crosses the broker as a proven edge');
    assert.ok(has(g.edges, 'order.on_inventory_reply', 'order.failed', 'PARENT_OF', nodes));
    assert.equal(g.edges.filter((e: any) => e.evidence_class === 'inferred').length, 0);
    const reserve = g.nodes.filter((n: any) => n.operation === 'inventory.reserve');
    assert.ok(reserve.length >= 1 && reserve.every((n: any) => n.status === 'OK'), 'the rejecting handler looks perfectly healthy - that is the point of the scenario');
  }
});

// Regression for a real CI failure (docs/experiments/jitter-sensitivity.md): on a loaded runner a ~45 ms stall in a
// HEALTHY upstream span scored as anomalous and, being upstream of the payment error, was promoted to rank 1.
// Here the stall is injected deliberately (100 ms, well above the old ~45 ms trigger, below the 250 ms floor).
test('noise floor: a 100 ms stall on a healthy upstream span does not hijack the ranking from the real fault', { timeout: 90_000 }, async () => {
  const hdr = { 'content-type': 'application/json', 'x-causora-fault-token': FAULT_TOKEN };
  const svc = { order: `http://127.0.0.1:${BASE + 101}`, inventory: `http://127.0.0.1:${BASE + 102}`, payment: `http://127.0.0.1:${BASE + 103}` };
  const inject = (url: string, faults: unknown[]) => fetch(`${url}/internal/faults`, { method: 'POST', headers: hdr, body: JSON.stringify({ experimentId: 'e2e-jitter', ttlSeconds: 60, faults }) });
  let orderId = '';
  try {
    assert.ok((await inject(svc.payment, [{ type: 'error_response', target: 'payment.authorize', status: 503, rate: 1 }])).ok);
    assert.ok((await inject(svc.inventory, [{ type: 'handler_delay', target: 'inventory.reserve', ms: 100 }])).ok);
    orderId = ((await (await fetch(`${svc.order}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { orderId: string }).orderId;
    const end = Date.now() + 20_000;
    for (;;) {
      const o = (await (await fetch(`${svc.order}/orders/${orderId}`)).json()) as any;
      if (o.status === 'FAILED') break;
      assert.ok(Date.now() < end, `order never failed (status ${o.status})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    for (const url of [svc.payment, svc.inventory]) await fetch(`${url}/internal/faults`, { method: 'DELETE', headers: { 'x-causora-fault-token': FAULT_TOKEN } });
  }
  // Wait on STATE: the failure is recorded and the investigation reports COMPLETE telemetry.
  let top: any;
  const deadline = Date.now() + 25_000;
  for (;;) {
    const failure = ((await json('/api/v1/failures')) as any[]).find((f) => f.business_operation_id === orderId);
    if (failure) {
      const inv = (await json(`/api/v1/failures/${failure.failure_event_id}/investigate`, { method: 'POST', body: '{}' })).investigation;
      if (inv.completeness === 'COMPLETE') { top = inv.candidates[0]; break; }
    }
    assert.ok(Date.now() < deadline, 'investigation never became COMPLETE');
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(top.service, 'payment-service', `rank 1 was ${top.service}/${top.operation}; a 100 ms stall upstream must not outrank the real fault`);
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
