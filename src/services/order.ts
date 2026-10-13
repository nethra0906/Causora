/**
 * Order Service - owns the order aggregate and orchestrates the saga:
 *
 *   POST /orders → order.created ─> (inventory) ─> inventory.reserved → SETTLING → payment → CONFIRMED
 *                      ^                                                                    └> FAILED
 *                      └── watchdog: no reply within the deadline → timeout.fired → retry (attempt+1)
 *
 * `saga.awaiting_event_id` and `saga.deadline_at` are what make the timeout edge PROVABLE: the
 * watchdog knows exactly which event it was waiting for, because event ids for consumers are
 * deterministic (consumeEventId) and for HTTP callees are caller-allocated.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { ATTR, GROUPS, PORTS, TIMING, TOPICS, consumeEventId } from '../contracts/index.ts';
import { openBus, publish, subscribe } from '../bus/index.ts';
import { dataDir, openDb, tx } from '../lib/db.ts';
import { uuid } from '../lib/ids.ts';
import { wallMs } from '../lib/time.ts';
import { serverSpan, tracedFetch } from '../telemetry/http.ts';
import { type Span, emitEvent, withSpan } from '../telemetry/index.ts';
import { createService } from './common.ts';

const orderSchema = z.object({
  customerId: z.string().min(1).max(64).default('cust_demo'),
  sku: z.string().min(1).max(64).default('WIDGET'),
  quantity: z.number().int().min(1).max(100).default(1),
  unitPrice: z.number().positive().default(25),
});

interface Saga {
  order_id: string;
  step: string;
  attempt: number;
  idempotency_key: string;
  awaiting_event_id: string | null;
  last_produce_event_id: string | null;
  last_reserved_event_id: string | null;
  deadline_at: number;
  settle_at: number;
  reservations: string; // JSON [{id, quantity}]
  sku: string;
  quantity: number;
  amount: number;
}

export async function startOrderService(port: number = PORTS.order): Promise<void> {
  const db = openDb(join(dataDir(), 'order.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, sku TEXT NOT NULL, quantity INTEGER NOT NULL, total_amount REAL NOT NULL,
      status TEXT NOT NULL, reason TEXT, idempotency_key TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS saga_state(order_id TEXT PRIMARY KEY, step TEXT NOT NULL, attempt INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      awaiting_event_id TEXT, last_produce_event_id TEXT, last_reserved_event_id TEXT, deadline_at REAL NOT NULL DEFAULT 0, settle_at REAL NOT NULL DEFAULT 0,
      reservations TEXT NOT NULL DEFAULT '[]', sku TEXT NOT NULL, quantity INTEGER NOT NULL, amount REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS saga_step ON saga_state(step);
  `);
  const bus = openBus(join(dataDir(), 'bus.db'));
  const { app, listen } = createService('order-service');
  const paymentUrl = process.env.PAYMENT_URL ?? `http://127.0.0.1:${PORTS.payment}`;

  const setStep = (orderId: string, step: string) => db.prepare('UPDATE saga_state SET step = ? WHERE order_id = ?').run(step, orderId);
  const setStatus = (orderId: string, status: string, reason: string | null) =>
    db.prepare('UPDATE orders SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, wallMs(), orderId);

  /** The failure event the whole product exists to investigate. `causationId` names what directly caused it. */
  const failOrder = async (orderId: string, reason: string, causationId: string): Promise<string> => {
    setStatus(orderId, 'FAILED', reason);
    setStep(orderId, 'FAILED');
    return withSpan(
      { name: 'order.failed', operation: 'order.failed', eventType: 'domain.state_change', kind: 'internal', businessOperationId: orderId, causationId },
      (span) => {
        span.fail(reason);
        return span.eventId;
      },
    );
  };

  const confirmOrder = async (orderId: string, causationId: string) => {
    setStatus(orderId, 'CONFIRMED', null);
    setStep(orderId, 'DONE');
    await withSpan({ name: 'order.confirmed', operation: 'order.confirmed', eventType: 'domain.state_change', kind: 'internal', businessOperationId: orderId, causationId }, () => undefined);
  };

  // ───────────────────────── POST /orders ─────────────────────────
  app.post('/orders', async (req, reply) => {
    const parsed = orderSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: 'invalid order', issues: parsed.error.issues });
    const { customerId, sku, quantity, unitPrice } = parsed.data;

    const orderId = await serverSpan(req.headers, { name: 'POST /orders', operation: 'order.create', mutating: true }, async (span) => {
      const id = `ord_${uuid().slice(0, 8)}`;
      const key = `idem:${id}`;
      span.set(ATTR.businessOperationId, id);
      span.setIdempotencyKey(key);
      const now = wallMs();
      const amount = quantity * unitPrice;
      tx(db, () => {
        db.prepare('INSERT INTO orders(id,customer_id,sku,quantity,total_amount,status,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, customerId, sku, quantity, amount, 'PENDING', key, now, now);
        db.prepare('INSERT INTO saga_state(order_id,step,attempt,idempotency_key,sku,quantity,amount) VALUES(?,?,?,?,?,?,?)').run(id, 'PUBLISHING', 1, key, sku, quantity, amount);
      });
      const pub = await publish({
        bus, topic: TOPICS.orders, key: id, type: 'order.created', operation: 'order.publish_created',
        payload: { orderId: id, sku, quantity },
        causationId: span.eventId, businessOperationId: id, attempt: 1, idempotencyKey: key, mutating: true,
      });
      db.prepare('UPDATE saga_state SET step = ?, awaiting_event_id = ?, last_produce_event_id = ?, deadline_at = ? WHERE order_id = ?').run(
        'AWAIT_INVENTORY', consumeEventId(pub.messageId, GROUPS.inventoryReserver), pub.eventId, wallMs() + TIMING.inventoryWaitDeadlineMs, id,
      );
      return id;
    });
    return reply.code(202).send({ orderId });
  });

  app.get('/orders/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const order = db.prepare('SELECT id,status,reason,quantity,total_amount,created_at,updated_at FROM orders WHERE id = ?').get(id);
    if (!order) return reply.code(404).send({ error: 'not found' });
    const saga = db.prepare('SELECT step, attempt FROM saga_state WHERE order_id = ?').get(id);
    return { ...order, saga };
  });

  // ───────────────────────── inventory replies ─────────────────────────
  subscribe({
    bus, topic: TOPICS.inventory, group: GROUPS.orderSaga, operation: 'order.on_inventory_reply', concurrency: 16,
    handler: async (msg, span: Span) => {
      const p = msg.payload as { orderId: string; reservationId?: string; quantity?: number; reason?: string };
      if (msg.type === 'inventory.rejected') {
        await failOrder(p.orderId, 'INSUFFICIENT_STOCK', span.eventId);
        return;
      }
      // Synchronous read-modify-write: atomic with respect to other handlers on this event loop.
      const saga = db.prepare('SELECT * FROM saga_state WHERE order_id = ?').get(p.orderId) as Saga | undefined;
      if (!saga) return;
      const list = JSON.parse(saga.reservations) as Array<{ id: string; quantity: number }>;
      if (saga.step === 'AWAIT_INVENTORY' || saga.step === 'SETTLING') {
        list.push({ id: p.reservationId!, quantity: p.quantity! });
        db.prepare('UPDATE saga_state SET step = ?, settle_at = ?, reservations = ?, last_reserved_event_id = ? WHERE order_id = ?').run(
          'SETTLING', saga.step === 'AWAIT_INVENTORY' ? wallMs() + TIMING.settleWindowMs : saga.settle_at, JSON.stringify(list), span.eventId, p.orderId,
        );
      } else {
        span.set('order.late_reply', true); // reply arrived after the saga moved on
      }
    },
  });

  // ───────────────────────── watchdog + settler ─────────────────────────
  const onInventoryTimeout = (s: Saga) =>
    withSpan(
      {
        name: 'order.inventory_wait.timeout', operation: 'order.inventory_wait.timeout', eventType: 'timeout.fired', kind: 'internal', parent: 'none',
        businessOperationId: s.order_id, attempt: s.attempt, idempotencyKey: s.idempotency_key,
        causationId: s.last_produce_event_id!, // the publish that started the clock
        awaitedCorrelationId: s.awaiting_event_id!, // the consumer event that never answered
      },
      async (span) => {
        span.timeout(`no inventory reply within ${TIMING.inventoryWaitDeadlineMs}ms`);
        if (s.attempt >= TIMING.maxAttempts) {
          await failOrder(s.order_id, 'RETRY_EXHAUSTED', span.eventId);
          return;
        }
        const attempt = s.attempt + 1;
        const pub = await publish({
          bus, topic: TOPICS.orders, key: s.order_id, type: 'order.created', operation: 'order.publish_created',
          payload: { orderId: s.order_id, sku: s.sku, quantity: s.quantity },
          causationId: span.eventId, businessOperationId: s.order_id, attempt, idempotencyKey: s.idempotency_key, mutating: true,
          retryOfEventId: s.last_produce_event_id!, initiatesRetry: true,
        });
        db.prepare('UPDATE saga_state SET step = ?, attempt = ?, awaiting_event_id = ?, last_produce_event_id = ?, deadline_at = ? WHERE order_id = ?').run(
          'AWAIT_INVENTORY', attempt, consumeEventId(pub.messageId, GROUPS.inventoryReserver), pub.eventId, wallMs() + TIMING.inventoryWaitDeadlineMs, s.order_id,
        );
      },
    );

  const settleAndPay = (s: Saga) =>
    withSpan(
      {
        name: 'order.settle', operation: 'order.settle', eventType: 'domain.state_change', kind: 'internal', parent: 'none',
        businessOperationId: s.order_id, attempt: s.attempt, idempotencyKey: s.idempotency_key, causationId: s.last_reserved_event_id!,
      },
      async (span) => {
        const reservations = JSON.parse(s.reservations) as Array<{ id: string; quantity: number }>;
        const res = await tracedFetch({
          url: `${paymentUrl}/payments/authorize`, method: 'POST', name: 'POST payment-service /payments/authorize', operation: 'order.call_payment',
          deadlineMs: TIMING.paymentDeadlineMs, mutating: true,
          body: { orderId: s.order_id, amount: s.amount, orderQuantity: s.quantity, reservations },
        });
        if (res.status === 200) return confirmOrder(s.order_id, res.calleeEventId);
        if (res.timedOut) {
          const t = emitEvent({
            name: 'order.payment_wait.timeout', operation: 'order.payment_wait.timeout', eventType: 'timeout.fired', kind: 'internal',
            causationId: res.clientEventId, awaitedCorrelationId: res.calleeEventId, errorType: 'TIMEOUT',
          });
          span.fail('PAYMENT_TIMEOUT');
          await failOrder(s.order_id, 'PAYMENT_TIMEOUT', t.eventId);
          return;
        }
        span.fail('PAYMENT_FAILED');
        // The failure is caused by the payment server's reply, whose event id this service allocated.
        await failOrder(s.order_id, 'PAYMENT_FAILED', res.calleeEventId);
      },
    );

  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    try {
      const now = wallMs();
      for (const s of db.prepare("SELECT * FROM saga_state WHERE step = 'AWAIT_INVENTORY' AND deadline_at <= ? AND deadline_at > 0").all(now) as unknown as Saga[]) {
        setStep(s.order_id, 'TIMING_OUT'); // claim synchronously so the next tick skips it
        void onInventoryTimeout(s).catch(() => setStep(s.order_id, 'AWAIT_INVENTORY'));
      }
      for (const s of db.prepare("SELECT * FROM saga_state WHERE step = 'SETTLING' AND settle_at <= ?").all(now) as unknown as Saga[]) {
        setStep(s.order_id, 'PAYING');
        void settleAndPay(s).catch(() => setStep(s.order_id, 'FAILED'));
      }
    } finally {
      ticking = false;
    }
  };
  setInterval(tick, 100).unref();

  await listen(port);
}
