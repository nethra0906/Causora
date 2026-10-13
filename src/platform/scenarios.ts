/**
 * Fault scenarios and the runner that drives them. The runner is the ONLY component that knows the
 * ground truth: it injects the fault, records which service+operation it targeted, and the
 * evaluation harness later checks whether Causora's ranking - which never sees that record -
 * names the same place. Faults are always cleared in a `finally`, even when the runner throws.
 */
import { HTTP_HEADERS, PORTS, TIMING } from '../contracts/index.ts';
import { sleep, uuid } from '../lib/ids.ts';
import { wallMs } from '../lib/time.ts';
import type { FaultSpec } from '../services/faults.ts';
import type { Engine } from './engine.ts';

export type ServiceName = 'order' | 'inventory' | 'payment';

export interface Scenario {
  id: string;
  title: string;
  description: string;
  /** What the user sees go wrong, and the first thing they would wrongly blame. */
  symptom: string;
  faults: Array<{ service: ServiceName; faults: FaultSpec[] }>;
  truth: { service: string; operation: string } | null;
  expectFailure: boolean;
  expectedReason: string | null;
  control?: boolean;
  /**
   * Written (with predictions) BEFORE it was implemented or run - docs/experiments/held-out.md. Reported
   * separately from the headline evaluation, and the analyser is frozen with respect to it.
   */
  heldOut?: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'inventory-delay-duplicate',
    title: 'S1 · Slow inventory → timeout → retry → duplicate reservation',
    description: 'A delay inside the reservation handler outlasts the order deadline. The retry races the original through a non-atomic idempotency guard; both reserve stock, and payment rejects the doubled quantity.',
    symptom: 'Payment fails with RESERVATION_AMOUNT_MISMATCH - a different service, a different trace, seconds later.',
    faults: [{ service: 'inventory', faults: [{ type: 'handler_delay', target: 'inventory.reserve', ms: 1700 }] }],
    truth: { service: 'inventory-service', operation: 'inventory.reserve' },
    expectFailure: true,
    expectedReason: 'PAYMENT_FAILED',
  },
  {
    id: 'payment-latency',
    title: 'S2 · Slow payment provider → client timeout',
    description: 'The payment service answers slower than the caller’s deadline. The caller gives up; the server span finishes later, successfully.',
    symptom: 'The order fails with PAYMENT_TIMEOUT; the failing span is in the order service.',
    faults: [{ service: 'payment', faults: [{ type: 'http_latency', target: 'payment.authorize', ms: 1500 }] }],
    truth: { service: 'payment-service', operation: 'payment.authorize' },
    expectFailure: true,
    expectedReason: 'PAYMENT_TIMEOUT',
  },
  {
    id: 'payment-error',
    title: 'S3 · Payment provider returns 503',
    description: 'A synchronous failure one hop from its symptom. The easy case: the control that shows the ranker is not only good at exotic chains.',
    symptom: 'The order fails with PAYMENT_FAILED.',
    faults: [{ service: 'payment', faults: [{ type: 'error_response', target: 'payment.authorize', status: 503, rate: 1 }] }],
    truth: { service: 'payment-service', operation: 'payment.authorize' },
    expectFailure: true,
    expectedReason: 'PAYMENT_FAILED',
  },
  {
    id: 'retry-exhaustion',
    title: 'S4 · Inventory so slow every retry times out',
    description: 'The handler delay exceeds the total retry budget. Three attempts time out; the order fails before any reservation completes, and the late reservations arrive after the verdict.',
    symptom: 'The order fails with RETRY_EXHAUSTED, and telemetry keeps arriving for seconds afterwards (completeness is PROVISIONAL until it settles).',
    faults: [{ service: 'inventory', faults: [{ type: 'handler_delay', target: 'inventory.reserve', ms: 3500 }] }],
    truth: { service: 'inventory-service', operation: 'inventory.reserve' },
    expectFailure: true,
    expectedReason: 'RETRY_EXHAUSTED',
  },
  {
    id: 'inventory-fix',
    title: 'Control · S1’s fault with the corrected idempotency guard',
    description: 'Identical fault to S1, but the guard writes its record in the same transaction as the reservation. The retry is suppressed, the order is confirmed, and exactly the DUPLICATE_OF edge disappears.',
    symptom: 'No failure. The graph differs from S1 by one edge - that is the point.',
    faults: [{ service: 'inventory', faults: [{ type: 'handler_delay', target: 'inventory.reserve', ms: 1700 }, { type: 'config', target: 'idempotency_guard', value: 'transactional' }] }],
    truth: null,
    expectFailure: false,
    expectedReason: null,
    control: true,
  },
  {
    id: 'inventory-crash',
    title: 'S5 · Inventory handler throws (held-out)',
    description: 'An exception inside the reservation handler. The bus redelivers up to three times, then dead-letters; no reply is ever published, so the order service times out, retries and gives up. Pre-registered predictions: docs/experiments/held-out.md.',
    symptom: 'The order fails with RETRY_EXHAUSTED - the same symptom as S4, from a different cause (an error, not slowness).',
    faults: [{ service: 'inventory', faults: [{ type: 'error_response', target: 'inventory.reserve', rate: 1 }] }],
    truth: { service: 'inventory-service', operation: 'inventory.reserve' },
    expectFailure: true,
    expectedReason: 'RETRY_EXHAUSTED',
    heldOut: true,
  },
  {
    id: 'inventory-reject',
    title: 'S6 · Inventory rejects for lack of stock (held-out)',
    description: 'The reservation handler correctly publishes inventory.rejected because stock is exhausted. Nothing is slow and nothing errors: the rejection is a deliberate decision. Pre-registered prediction: the analyser will be confidently connected and wrong about the origin.',
    symptom: 'The order fails with INSUFFICIENT_STOCK. Every span upstream looks healthy.',
    faults: [{ service: 'inventory', faults: [{ type: 'config', target: 'force_out_of_stock', value: 'true' }] }],
    truth: { service: 'inventory-service', operation: 'inventory.reserve' },
    expectFailure: true,
    expectedReason: 'INSUFFICIENT_STOCK',
    heldOut: true,
  },
];

export const getScenario = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
};

const urls: Record<ServiceName, string> = {
  order: process.env.ORDER_URL ?? `http://127.0.0.1:${PORTS.order}`,
  inventory: process.env.INVENTORY_URL ?? `http://127.0.0.1:${PORTS.inventory}`,
  payment: process.env.PAYMENT_URL ?? `http://127.0.0.1:${PORTS.payment}`,
};
const faultToken = () => process.env.CAUSORA_FAULT_TOKEN ?? '';
const faultHeaders = () => ({ 'content-type': 'application/json', [HTTP_HEADERS.faultToken]: faultToken() });

export async function createOrder(quantity = 1): Promise<string> {
  const res = await fetch(`${urls.order}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity }) });
  if (res.status !== 202) throw new Error(`POST /orders -> ${res.status}`);
  return ((await res.json()) as { orderId: string }).orderId;
}

export async function orderState(orderId: string): Promise<{ status: string; reason: string | null; saga?: { step: string; attempt: number } }> {
  const res = await fetch(`${urls.order}/orders/${orderId}`);
  return (await res.json()) as any;
}

/** Wait on STATE, never on a fixed sleep. */
export async function waitOrderTerminal(orderId: string, timeoutMs = 20_000): Promise<{ status: string; reason: string | null }> {
  const deadline = wallMs() + timeoutMs;
  for (;;) {
    const s = await orderState(orderId);
    if (s.status === 'CONFIRMED' || s.status === 'FAILED') return s;
    if (wallMs() > deadline) throw new Error(`order ${orderId} not terminal after ${timeoutMs}ms (status ${s.status}, step ${s.saga?.step})`);
    await sleep(100);
  }
}

async function setFaults(service: ServiceName, faults: FaultSpec[], experimentId: string, ttlSeconds: number): Promise<void> {
  const res = await fetch(`${urls[service]}/internal/faults`, { method: 'POST', headers: faultHeaders(), body: JSON.stringify({ faults, experimentId, ttlSeconds }) });
  if (!res.ok) throw new Error(`fault injection on ${service} refused: ${res.status} ${await res.text()}`);
}

/** Cleanup must never fail silently: a leaked fault would silently corrupt every later experiment's ground truth. */
export async function clearAllFaults(): Promise<void> {
  const results = await Promise.all(
    (Object.keys(urls) as ServiceName[]).map(async (s) => {
      try {
        // No content-type: Fastify rejects an empty body that claims to be JSON.
        const res = await fetch(`${urls[s]}/internal/faults`, { method: 'DELETE', headers: { [HTTP_HEADERS.faultToken]: faultToken() } });
        return res.ok ? null : `${s}: HTTP ${res.status}`;
      } catch (e) {
        return `${s}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }),
  );
  const failed = results.filter(Boolean);
  if (failed.length) throw new Error(`could not clear faults - ${failed.join('; ')}`);
}

export interface RunResult {
  experimentId: string;
  scenarioId: string;
  runs: Array<{ operationId: string; status: string; reason: string | null; failureEventId: string | null; matchedExpectation: boolean }>;
}

export class ScenarioRunner {
  private readonly engine: Engine;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  /** One scenario at a time: faults are process-global, and overlapping them would corrupt ground truth. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  runScenario(scenarioId: string, count = 1): Promise<RunResult> {
    return this.exclusive(() => this.runScenarioNow(scenarioId, count));
  }

  private async runScenarioNow(scenarioId: string, count: number): Promise<RunResult> {
    const sc = getScenario(scenarioId);
    const experimentId = `exp_${uuid().slice(0, 8)}`;
    const store = this.engine.store;
    try {
      for (const f of sc.faults) await setFaults(f.service, f.faults, experimentId, 90);
      const startedAt = wallMs();
      const ids = await Promise.all(Array.from({ length: count }, () => createOrder()));
      for (const id of ids) {
        store.setOperationKind(id, 'experiment', startedAt);
        store.recordExperimentRun({ id: `${experimentId}:${id}`, experimentId, scenarioId, opId: id, truthService: sc.truth?.service ?? null, truthOperation: sc.truth?.operation ?? null, expectFailure: sc.expectFailure, startedAt });
      }
      const outcomes = await Promise.all(ids.map((id) => waitOrderTerminal(id)));
      await clearAllFaults(); // clear BEFORE waiting for telemetry so a long wait cannot leak the fault
      ids.forEach((id, i) => store.setExperimentOutcome(id, outcomes[i]!.status, outcomes[i]!.reason));
      await this.waitQuiescent(ids);

      const runs = ids.map((operationId, i) => {
        const failure = store.failureForOperation(operationId);
        const o = outcomes[i]!;
        const matched = sc.expectFailure ? o.status === 'FAILED' && o.reason === sc.expectedReason : o.status === 'CONFIRMED';
        if (failure) this.engine.investigateNow(failure.failure_event_id);
        return { operationId, status: o.status, reason: o.reason, failureEventId: failure?.failure_event_id ?? null, matchedExpectation: matched };
      });
      return { experimentId, scenarioId, runs };
    } finally {
      await clearAllFaults();
    }
  }

  /** Healthy traffic that defines "normal" for every operation. Baseline orders are marked by the runner, not by telemetry. */
  seedBaseline(count = 40, concurrency = 6): Promise<{ orders: number; baselines: number }> {
    return this.exclusive(async () => {
      await clearAllFaults();
      const all: string[] = [];
      for (let done = 0; done < count; done += concurrency) {
        const n = Math.min(concurrency, count - done);
        const ids = await Promise.all(Array.from({ length: n }, () => createOrder()));
        const now = wallMs();
        ids.forEach((id) => this.engine.store.setOperationKind(id, 'baseline', now));
        await Promise.all(ids.map((id) => waitOrderTerminal(id)));
        all.push(...ids);
      }
      await this.waitQuiescent(all);
      return { orders: all.length, baselines: this.engine.recomputeBaselines().length };
    });
  }

  /**
   * Wait on STATE, not on a guess about silence: the terminal event has arrived, every reference
   * resolves, and telemetry has been quiet for TIMING.quietMs (long enough for completeness to
   * report COMPLETE). Gives up after maxMs and reports false.
   */
  async waitQuiescent(opIds: string[], maxMs = 15_000): Promise<boolean> {
    const deadline = wallMs() + maxMs;
    for (;;) {
      const settled = opIds.every((id) => {
        const last = this.engine.store.lastIngestAt(id);
        return last !== null && this.engine.hasTerminalEvent(id) && wallMs() - last >= TIMING.quietMs + 100 && this.engine.dangling(id) === 0;
      });
      if (settled) return true;
      if (wallMs() > deadline) return false;
      await sleep(150);
    }
  }
}

