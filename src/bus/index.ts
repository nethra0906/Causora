/**
 * A small durable message bus with Kafka-shaped semantics (topics, keys, consumer groups,
 * at-least-once delivery, visibility timeout, redelivery) backed by SQLite. See ADR-0017.
 *
 * THE POINT OF THIS FILE: `publish()` makes the causal contract impossible to forget.
 * `causationId`, `businessOperationId` and `attempt` are REQUIRED parameters (omitting one is a
 * compile error), and `retryOfEventId` is required at runtime whenever `initiatesRetry` is set.
 * `subscribe()` opens the causal context, starts the consume span and stamps the contract
 * attributes BEFORE the handler body runs, so handlers cannot lose causality by accident.
 */
import { ATTR, MSG_HEADERS, SCHEMA_VERSION, consumeEventId } from '../contracts/index.ts';
import { type Db, bind, openDb, tx } from '../lib/db.ts';
import { formatTraceparent, parseTraceparent, sleep } from '../lib/ids.ts';
import { wallMs } from '../lib/time.ts';
import { type Span, clock, withSpan } from '../telemetry/index.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages(
  pk INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, msg_key TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL,
  headers TEXT NOT NULL, produced_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS groups(topic TEXT NOT NULL, grp TEXT NOT NULL, PRIMARY KEY(topic, grp));
CREATE TABLE IF NOT EXISTS deliveries(
  message_pk INTEGER NOT NULL, grp TEXT NOT NULL, topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', available_at REAL NOT NULL,
  claimed_until REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(message_pk, grp));
CREATE INDEX IF NOT EXISTS deliveries_poll ON deliveries(grp, topic, status, available_at);
`;

export interface Bus {
  db: Db;
  close(): void;
}

export function openBus(file: string): Bus {
  const db = openDb(file);
  db.exec(SCHEMA);
  return { db, close: () => db.close() };
}

export interface PublishInput {
  bus: Bus;
  topic: string;
  key: string;
  type: string;
  payload: unknown;
  // ── the causal contract: REQUIRED ──
  causationId: string;
  businessOperationId: string;
  attempt: number;
  idempotencyKey?: string;
  /** Required (runtime-checked) when this message initiates a retry. */
  retryOfEventId?: string;
  /** True only for the producer re-sending an earlier attempt; downstream messages merely carry `attempt`. */
  initiatesRetry?: boolean;
  operation: string;
  mutating?: boolean;
}

export interface Published {
  messageId: string;
  /** The produce span's event id == the message's event id == what consumers name as causation. */
  eventId: string;
}

export function publish(input: PublishInput): Promise<Published> {
  if (!input.causationId) throw new Error('publish: causationId is required by the causal contract');
  if (!input.businessOperationId) throw new Error('publish: businessOperationId is required by the causal contract');
  if (input.initiatesRetry && !input.retryOfEventId) throw new Error('publish: retryOfEventId is required when the message initiates a retry');

  return withSpan(
    {
      name: `publish ${input.topic}`,
      operation: input.operation,
      eventType: 'messaging.produce',
      kind: 'producer',
      causationId: input.causationId,
      businessOperationId: input.businessOperationId,
      attempt: input.attempt,
      idempotencyKey: input.idempotencyKey,
      retryOfEventId: input.retryOfEventId,
      mutating: input.mutating,
      attributes: { [ATTR.topic]: input.topic, [ATTR.messageKey]: input.key },
    },
    (span) => {
      const messageId = span.eventId;
      span.set(ATTR.messageId, messageId);
      const producedAt = clock.now();
      span.set(ATTR.producedAt, producedAt);
      const headers: Record<string, string> = {
        [MSG_HEADERS.traceparent]: formatTraceparent(span.traceId, span.spanId),
        [MSG_HEADERS.eventId]: span.eventId,
        [MSG_HEADERS.causationId]: input.causationId,
        [MSG_HEADERS.businessOperationId]: input.businessOperationId,
        [MSG_HEADERS.attempt]: String(input.attempt),
        [MSG_HEADERS.producedAt]: String(producedAt),
        [MSG_HEADERS.schemaVersion]: String(SCHEMA_VERSION),
      };
      if (input.idempotencyKey) headers[MSG_HEADERS.idempotencyKey] = input.idempotencyKey;
      if (input.retryOfEventId) headers[MSG_HEADERS.retryOfEventId] = input.retryOfEventId;

      const db = input.bus.db;
      tx(db, () => {
        const r = db
          .prepare('INSERT INTO messages(topic,msg_key,message_id,type,payload,headers,produced_at) VALUES(?,?,?,?,?,?,?)')
          .run(input.topic, input.key, messageId, input.type, JSON.stringify(input.payload), JSON.stringify(headers), producedAt);
        db.prepare(
          `INSERT INTO deliveries(message_pk,grp,topic,available_at)
           SELECT ?, grp, topic, ? FROM groups WHERE topic = ?`,
        ).run(bind(r.lastInsertRowid), wallMs(), input.topic);
      });
      return { messageId, eventId: span.eventId };
    },
  );
}

export interface ConsumedMessage {
  messageId: string;
  topic: string;
  key: string;
  type: string;
  payload: any;
  headers: Record<string, string>;
  deliveryAttempt: number;
}

export interface SubscribeInput {
  bus: Bus;
  topic: string;
  group: string;
  /** Logical operation name for the consume span, e.g. "inventory.reserve". */
  operation: string;
  concurrency?: number;
  pollMs?: number;
  mutating?: boolean;
  handler: (msg: ConsumedMessage, span: Span) => Promise<void>;
}

const MAX_DELIVERIES = 3;
const VISIBILITY_MS = 30_000;

export function subscribe(input: SubscribeInput): { stop(): void } {
  const { bus, topic, group } = input;
  const concurrency = input.concurrency ?? 8;
  bus.db.prepare('INSERT OR IGNORE INTO groups(topic,grp) VALUES(?,?)').run(topic, group);
  let running = true;
  let inflight = 0;

  const claim = (limit: number): Array<{ pk: number; attempts: number }> => {
    const now = wallMs();
    return tx(bus.db, () =>
      bus.db
        .prepare(
          `UPDATE deliveries SET claimed_until = ?, attempts = attempts + 1
           WHERE (message_pk, grp) IN (
             SELECT message_pk, grp FROM deliveries
             WHERE grp = ? AND topic = ? AND status = 'pending' AND available_at <= ? AND claimed_until <= ?
             ORDER BY message_pk LIMIT ?)
           RETURNING message_pk AS pk, attempts`,
        )
        .all(now + VISIBILITY_MS, group, topic, now, now, limit) as Array<{ pk: number; attempts: number }>,
    );
  };

  const settle = (pk: number, status: 'done' | 'dead' | 'retry') => {
    if (status === 'retry') {
      bus.db.prepare(`UPDATE deliveries SET claimed_until = 0, available_at = ? WHERE message_pk = ? AND grp = ?`).run(wallMs() + 200, pk, group);
    } else {
      bus.db.prepare(`UPDATE deliveries SET status = ? WHERE message_pk = ? AND grp = ?`).run(status, pk, group);
    }
  };

  const run = async (pk: number, attempts: number) => {
    const row = bus.db.prepare('SELECT * FROM messages WHERE pk = ?').get(pk) as any;
    if (!row) return settle(pk, 'dead');
    const headers = JSON.parse(row.headers) as Record<string, string>;
    const msg: ConsumedMessage = {
      messageId: row.message_id,
      topic: row.topic,
      key: row.msg_key,
      type: row.type,
      payload: JSON.parse(row.payload),
      headers,
      deliveryAttempt: attempts,
    };
    const producedAt = Number(headers[MSG_HEADERS.producedAt]);
    try {
      await withSpan(
        {
          name: `consume ${topic}`,
          operation: input.operation,
          eventType: 'messaging.consume',
          kind: 'consumer',
          // A consumer starts a NEW trace (the standard messaging pattern): W3C parentage does not
          // cross the broker, which is precisely why the causal contract exists.
          parent: 'none',
          eventId: consumeEventId(msg.messageId, group, attempts),
          businessOperationId: headers[MSG_HEADERS.businessOperationId],
          causationId: headers[MSG_HEADERS.eventId],
          idempotencyKey: headers[MSG_HEADERS.idempotencyKey],
          attempt: Number(headers[MSG_HEADERS.attempt]) || 1,
          // retry_of is deliberately NOT copied onto the consumer: the retry relationship is between
          // the two PRODUCE events (P1 → P2); the consumer is merely triggered by P2.
          mutating: input.mutating,
          attributes: {
            [ATTR.topic]: topic,
            [ATTR.messageKey]: msg.key,
            [ATTR.messageId]: msg.messageId,
            'messaging.delivery_attempt': attempts,
            ...(Number.isFinite(producedAt) ? { [ATTR.producedAt]: producedAt } : {}),
            'messaging.link.trace_id': parseTraceparent(headers[MSG_HEADERS.traceparent])?.traceId ?? '',
          },
        },
        (span) => input.handler(msg, span),
      );
      settle(pk, 'done');
    } catch {
      settle(pk, attempts >= MAX_DELIVERIES ? 'dead' : 'retry');
    }
  };

  void (async () => {
    while (running) {
      const free = concurrency - inflight;
      if (free > 0) {
        for (const c of claim(free)) {
          inflight++;
          void run(c.pk, c.attempts).finally(() => inflight--);
        }
      }
      await sleep(input.pollMs ?? 25);
    }
  })();

  return { stop: () => { running = false; } };
}

