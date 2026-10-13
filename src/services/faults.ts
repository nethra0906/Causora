import { z } from 'zod';
import { ATTR } from '../contracts/index.ts';
import { uuid } from '../lib/ids.ts';
import { wallMs } from '../lib/time.ts';
import { type Span, clock, emitEvent } from '../telemetry/index.ts';

export const faultSpecSchema = z.object({
  type: z.enum(['handler_delay', 'http_latency', 'error_response', 'clock_offset', 'config']),
  /** The logical OPERATION the fault targets, e.g. "inventory.reserve" or "payment.authorize". */
  target: z.string().min(1).max(100).optional(),
  ms: z.number().int().min(0).max(30_000).optional(),
  status: z.number().int().min(400).max(599).optional(),
  rate: z.number().min(0).max(1).optional(),
  value: z.string().max(100).optional(),
});
export type FaultSpec = z.infer<typeof faultSpecSchema>;

export const faultRequestSchema = z.object({
  faults: z.array(faultSpecSchema).min(1).max(10),
  ttlSeconds: z.number().int().min(1).max(600).default(60),
  experimentId: z.string().min(1).max(64),
});

interface ActiveFault extends FaultSpec {
  id: string;
  experimentId: string;
  expiresAt: number;
  announcedClear: boolean;
}

/**
 * Faults live in memory only and expire by TTL. Applying a fault stamps the affected span with the
 * experiment id - that is how the injector becomes ground truth (and why `experiment_id` must never
 * reach the ranker; see RankableEvent).
 */
export class FaultController {
  private active: ActiveFault[] = [];

  set(faults: FaultSpec[], ttlSeconds: number, experimentId: string): void {
    const expiresAt = wallMs() + ttlSeconds * 1000;
    for (const f of faults) {
      const fault: ActiveFault = { ...f, id: uuid(), experimentId, expiresAt, announcedClear: false };
      this.active.push(fault);
      if (f.type === 'clock_offset') clock.offsetMs = f.ms ?? 0;
      emitEvent({
        name: `fault ${f.type}`,
        operation: f.target ?? f.type,
        eventType: 'fault.injected',
        kind: 'internal',
        parent: 'none',
        attributes: { [ATTR.source]: 'fault', [ATTR.experimentId]: experimentId, [ATTR.faultTarget]: f.target ?? f.type, [ATTR.faultTtlMs]: ttlSeconds * 1000 },
      });
    }
  }

  clear(): void {
    for (const f of this.active) this.announceClear(f);
    this.active = [];
  }

  private announceClear(f: ActiveFault): void {
    if (f.announcedClear) return;
    f.announcedClear = true;
    if (f.type === 'clock_offset') clock.offsetMs = 0;
    emitEvent({
      name: `fault cleared ${f.type}`,
      operation: f.target ?? f.type,
      eventType: 'fault.cleared',
      kind: 'internal',
      parent: 'none',
      attributes: { [ATTR.source]: 'fault', [ATTR.experimentId]: f.experimentId, [ATTR.faultTarget]: f.target ?? f.type },
    });
  }

  private live(): ActiveFault[] {
    const now = wallMs();
    for (const f of this.active) if (f.expiresAt <= now) this.announceClear(f);
    this.active = this.active.filter((f) => f.expiresAt > now);
    return this.active;
  }

  list(): Array<Omit<ActiveFault, 'announcedClear'>> {
    return this.live().map(({ announcedClear: _a, ...rest }) => rest);
  }

  /** Find an active fault for this operation and mark the span as affected by its experiment. */
  apply(type: FaultSpec['type'], operation: string, span: Span): FaultSpec | undefined {
    const f = this.live().find((x) => x.type === type && x.target === operation);
    if (!f) return undefined;
    if (f.rate !== undefined && Math.random() >= f.rate) return undefined;
    span.set(ATTR.experimentId, f.experimentId);
    return f;
  }

  config(key: string): string | undefined {
    return this.live().find((x) => x.type === 'config' && x.target === key)?.value;
  }
}
