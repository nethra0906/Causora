/**
 * Payment Service. Synchronous by design (no events produced) so the demo mixes sync and async
 * topologies. Its job in the story is to place the SYMPTOM far from the CAUSE: it rejects a payment
 * whose reserved quantity does not match the ordered quantity, four hops after the real fault.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { ATTR, PORTS } from '../contracts/index.ts';
import { dataDir, openDb } from '../lib/db.ts';
import { sleep, uuid } from '../lib/ids.ts';
import { serverSpan } from '../telemetry/http.ts';
import { createService } from './common.ts';

const bodySchema = z.object({
  orderId: z.string().min(1),
  amount: z.number().nonnegative(),
  orderQuantity: z.number().int().positive(),
  reservations: z.array(z.object({ id: z.string(), quantity: z.number().int().positive() })).min(1),
});

export async function startPaymentService(port: number = PORTS.payment): Promise<void> {
  const db = openDb(join(dataDir(), 'payment.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS payments(
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, amount REAL NOT NULL, status TEXT NOT NULL)`);
  const { app, faults, listen } = createService('payment-service');

  app.post('/payments/authorize', async (req, reply) => {
    const out = await serverSpan(req.headers, { name: 'POST /payments/authorize', operation: 'payment.authorize', mutating: true }, async (span) => {
      const latency = faults.apply('http_latency', 'payment.authorize', span);
      if (latency) await sleep(latency.ms ?? 0);

      const err = faults.apply('error_response', 'payment.authorize', span);
      if (err) {
        span.fail('PROVIDER_UNAVAILABLE');
        return { status: err.status ?? 503, body: { error: 'PROVIDER_UNAVAILABLE' } };
      }

      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        span.fail('INVALID_REQUEST');
        return { status: 400, body: { error: 'INVALID_REQUEST' } };
      }
      const { orderId, amount, orderQuantity, reservations } = parsed.data;
      span.set(ATTR.businessOperationId, orderId);
      span.setResourceIds({ order_id: orderId, reservation_ids: reservations.map((r) => r.id).join(',') });

      // The user-visible symptom of the primary scenario: a duplicate reservation doubles the
      // reserved quantity, and payment refuses to authorise the mismatch.
      const reserved = reservations.reduce((sum, r) => sum + r.quantity, 0);
      if (reserved !== orderQuantity) {
        span.fail('RESERVATION_AMOUNT_MISMATCH', `reserved ${reserved} != ordered ${orderQuantity}`);
        return { status: 422, body: { error: 'RESERVATION_AMOUNT_MISMATCH', reserved, ordered: orderQuantity } };
      }

      const id = `pay_${uuid().slice(0, 8)}`;
      db.prepare('INSERT OR IGNORE INTO payments(id,order_id,amount,status) VALUES(?,?,?,?)').run(id, orderId, amount, 'AUTHORIZED');
      return { status: 200, body: { paymentId: id, status: 'AUTHORIZED' } };
    });
    return reply.code(out.status).send(out.body);
  });

  app.get('/payments/:orderId', async (req, reply) => {
    const row = db.prepare('SELECT * FROM payments WHERE order_id = ?').get((req.params as any).orderId);
    return row ? row : reply.code(404).send({ error: 'not found' });
  });

  await listen(port);
}
