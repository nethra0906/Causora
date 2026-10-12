import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFaultGate, type GateEnv } from '../../src/services/faultGate.ts';
import { FaultController, faultRequestSchema } from '../../src/services/faults.ts';
import { setTelemetrySink, startSpan } from '../../src/telemetry/index.ts';
import type { WireSpan } from '../../src/contracts/index.ts';

const TOKEN = 'a'.repeat(32);
const good: GateEnv = { CAUSORA_FAULTS_ENABLED: 'true', NODE_ENV: 'development', CAUSORA_FAULT_TOKEN: TOKEN };
const req = { token: TOKEN, remoteAddress: '127.0.0.1' };

test('gate 1: opt-in. Disabled by default and the route pretends not to exist (404)', () => {
  assert.deepEqual(checkFaultGate({}, req), { allowed: false, status: 404, reason: 'not found' });
  assert.equal(checkFaultGate({ ...good, CAUSORA_FAULTS_ENABLED: 'false' }, req).allowed, false);
  assert.equal(checkFaultGate({ ...good, CAUSORA_FAULTS_ENABLED: '1' }, req).allowed, false, 'only the literal "true" opts in');
});

test('gate 2: NODE_ENV=production refuses even with the flag AND a valid token', () => {
  const d = checkFaultGate({ ...good, NODE_ENV: 'production' }, req);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.status, 403);
});

test('gate 3: a credential is mandatory — unset, short, wrong, or missing tokens are refused', () => {
  assert.equal(checkFaultGate({ ...good, CAUSORA_FAULT_TOKEN: undefined }, req).allowed, false);
  assert.equal(checkFaultGate({ ...good, CAUSORA_FAULT_TOKEN: 'short' }, { token: 'short', remoteAddress: '127.0.0.1' }).allowed, false, 'weak tokens are refused');
  const wrong = checkFaultGate(good, { ...req, token: 'b'.repeat(32) });
  assert.equal(wrong.allowed, false);
  if (!wrong.allowed) assert.equal(wrong.status, 401);
  assert.equal(checkFaultGate(good, { remoteAddress: '127.0.0.1' }).allowed, false, 'missing token');
  assert.equal(checkFaultGate(good, { ...req, token: 'a'.repeat(31) }).allowed, false, 'length mismatch is handled without throwing');
});

test('gate 3b: non-loopback callers are refused even with the right token', () => {
  assert.equal(checkFaultGate(good, { ...req, remoteAddress: '10.0.0.7' }).allowed, false);
  assert.equal(checkFaultGate(good, { token: TOKEN }).allowed, false);
  assert.equal(checkFaultGate(good, { ...req, remoteAddress: '::1' }).allowed, true);
});

test('all three gates satisfied → allowed', () => {
  assert.deepEqual(checkFaultGate(good, req), { allowed: true });
});

test('fault requests are validated: bounded delay, bounded TTL, bounded count', () => {
  const ok = faultRequestSchema.safeParse({ faults: [{ type: 'handler_delay', target: 'inventory.reserve', ms: 1700 }], experimentId: 'e1' });
  assert.ok(ok.success && ok.data.ttlSeconds === 60, 'TTL defaults to 60s');
  assert.ok(!faultRequestSchema.safeParse({ faults: [{ type: 'handler_delay', ms: 999_999 }], experimentId: 'e' }).success, 'unbounded delay');
  assert.ok(!faultRequestSchema.safeParse({ faults: [{ type: 'handler_delay', ms: 10 }], experimentId: 'e', ttlSeconds: 99_999 }).success, 'unbounded ttl');
  assert.ok(!faultRequestSchema.safeParse({ faults: [], experimentId: 'e' }).success, 'empty');
  assert.ok(!faultRequestSchema.safeParse({ faults: [{ type: 'rm_rf' }], experimentId: 'e' }).success, 'unknown fault type');
});

test('faults expire by TTL, stamp the affected span with the experiment id, and announce themselves', async () => {
  const seen: WireSpan[] = [];
  setTelemetrySink((s) => seen.push(...s));
  try {
    const fc = new FaultController();
    fc.set([{ type: 'handler_delay', target: 'inventory.reserve', ms: 5 }], 1, 'exp_9');
    const span = startSpan({ name: 's', operation: 'inventory.reserve', eventType: 'messaging.consume', kind: 'consumer', parent: 'none' });
    assert.equal(fc.apply('handler_delay', 'inventory.reserve', span)?.ms, 5);
    assert.equal(span.attrs['causora.experiment_id'], 'exp_9');
    assert.equal(fc.apply('handler_delay', 'some.other.op', span), undefined, 'targets a single operation');
    assert.ok(seen.some((s) => s.attributes['causora.event_type'] === 'fault.injected' && s.attributes['causora.source'] === 'fault'));

    fc.clear();
    assert.equal(fc.list().length, 0);
    assert.equal(fc.apply('handler_delay', 'inventory.reserve', span), undefined);
    assert.ok(seen.some((s) => s.attributes['causora.event_type'] === 'fault.cleared'));
  } finally {
    setTelemetrySink(null);
  }
});
