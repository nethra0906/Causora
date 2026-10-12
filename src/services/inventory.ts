/**
 * Inventory Service — where the primary fault is injected and where the duplicate-work race lives.
 *
 * There is deliberately NO HTTP reservation endpoint: reservation happens only through the bus
 * consumer, which forces the primary causal chain across the broker boundary — the boundary that
 * distributed tracing handles worst and Causora handles best.
 */
import { join } from 'node:path';
import { GROUPS, MSG_HEADERS, PORTS, TOPICS } from '../contracts/index.ts';
import { openBus, publish, subscribe } from '../bus/index.ts';
import { type Db, dataDir, openDb, tx } from '../lib/db.ts';
import { sleep, uuid } from '../lib/ids.ts';
import { wallMs } from '../lib/time.ts';
import { emitEvent, type Span } from '../telemetry/index.ts';
import { createService } from './common.ts';

interface Reservation {
  reservationId: string | null; // null => insufficient stock
}

function reserveStock(db: Db, orderId: string, sku: string, quantity: number): Reservation {
  const row = db.prepare('SELECT available FROM stock WHERE sku = ?').get(sku) as { available: number } | undefined;
  if (!row || row.available < quantity) return { reservationId: null };
  const reservationId = `res_${uuid().slice(0, 8)}`;
  db.prepare('UPDATE stock SET available = available - ?, reserved = reserved + ?, version = version + 1 WHERE sku = ?').run(quantity, quantity, sku);
  db.prepare('INSERT INTO reservations(id,order_id,sku,quantity,status,created_at) VALUES(?,?,?,?,?,?)').run(reservationId, orderId, sku, quantity, 'RESERVED', wallMs());
  return { reservationId };
}

export async function startInventoryService(port: number = PORTS.inventory): Promise<void> {
  const db = openDb(join(dataDir(), 'inventory.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock(sku TEXT PRIMARY KEY, available INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sku TEXT NOT NULL, quantity INTEGER NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS reservations_order ON reservations(order_id);
    CREATE TABLE IF NOT EXISTS processed_messages(idempotency_key TEXT PRIMARY KEY, message_id TEXT NOT NULL, reservation_id TEXT, processed_at REAL NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO stock(sku, available) VALUES(?, ?)').run('WIDGET', 1_000_000);
  const bus = openBus(join(dataDir(), 'bus.db'));
  const { app, faults, listen } = createService('inventory-service');

  const announce = async (span: Span, orderId: string, key: string | undefined, outcome: Reservation, quantity: number) => {
    if (outcome.reservationId) {
      span.setResourceIds({ reservation_id: outcome.reservationId, order_id: orderId });
      await publish({
        bus, topic: TOPICS.inventory, key: orderId, type: 'inventory.reserved', operation: 'inventory.publish_reserved',
        payload: { orderId, reservationId: outcome.reservationId, quantity },
        causationId: span.eventId, businessOperationId: orderId, attempt: span.attempt, idempotencyKey: key,
      });
    } else {
      await publish({
        bus, topic: TOPICS.inventory, key: orderId, type: 'inventory.rejected', operation: 'inventory.publish_rejected',
        payload: { orderId, reason: 'INSUFFICIENT_STOCK' },
        causationId: span.eventId, businessOperationId: orderId, attempt: span.attempt, idempotencyKey: key,
      });
    }
  };

  subscribe({
    bus,
    topic: TOPICS.orders,
    group: GROUPS.inventoryReserver,
    operation: 'inventory.reserve',
    mutating: true,
    concurrency: 64,
    handler: async (msg, span) => {
      const { orderId, sku, quantity } = msg.payload as { orderId: string; sku: string; quantity: number };
      const key = msg.headers[MSG_HEADERS.idempotencyKey];
      const injected = faults.apply('handler_delay', 'inventory.reserve', span);

      if (faults.config('idempotency_guard') === 'transactional') {
        // ── CORRECT implementation (control scenario `inventory_fix`): the idempotency record is
        // written in the SAME transaction as the reservation and a unique constraint decides.
        if (injected) await sleep(injected.ms ?? 0);
        const result = tx(db, () => {
          const claimed = db.prepare('INSERT OR IGNORE INTO processed_messages(idempotency_key,message_id,processed_at) VALUES(?,?,?)').run(key ?? msg.messageId, msg.messageId, wallMs());
          if (claimed.changes === 0) return null; // duplicate suppressed
          const r = reserveStock(db, orderId, sku, quantity);
          db.prepare('UPDATE processed_messages SET reservation_id = ? WHERE idempotency_key = ?').run(r.reservationId, key ?? msg.messageId);
          return r;
        });
        if (result === null) {
          emitEvent({ name: 'idempotency hit', operation: 'inventory.idempotency_hit', eventType: 'idempotency.hit', kind: 'internal', causationId: span.eventId });
          return;
        }
        return announce(span, orderId, key, result, quantity);
      }

      // ── INTENTIONAL BUG (ADR-0016, docs/experiments/fault-injection.md, scenario S1) ──────────
      // A non-transactional check-then-act idempotency guard. The check happens BEFORE the slow
      // work and the record is written AFTER it, so a retry arriving inside that window passes the
      // check too and both attempts reserve stock. This is one of the most common real correctness
      // bugs in event-driven systems; do not "fix" it here — the control variant above is the fix.
      const seen = key ? db.prepare('SELECT 1 FROM processed_messages WHERE idempotency_key = ?').get(key) : undefined; // CHECK
      if (seen) {
        emitEvent({ name: 'idempotency hit', operation: 'inventory.idempotency_hit', eventType: 'idempotency.hit', kind: 'internal', causationId: span.eventId });
        return;
      }
      if (injected) await sleep(injected.ms ?? 0); // the injected fault widens the race window
      const result = reserveStock(db, orderId, sku, quantity); // ACT
      db.prepare('INSERT OR IGNORE INTO processed_messages(idempotency_key,message_id,reservation_id,processed_at) VALUES(?,?,?,?)').run(key ?? msg.messageId, msg.messageId, result.reservationId, wallMs()); // RECORD
      return announce(span, orderId, key, result, quantity);
    },
  });

  app.get('/stock/:sku', async (req, reply) => {
    const row = db.prepare('SELECT * FROM stock WHERE sku = ?').get((req.params as any).sku);
    return row ? row : reply.code(404).send({ error: 'not found' });
  });
  app.get('/reservations', async (req) => {
    const orderId = (req.query as any).orderId as string | undefined;
    return { reservations: orderId ? db.prepare('SELECT * FROM reservations WHERE order_id = ?').all(orderId) : [] };
  });

  await listen(port);
}

