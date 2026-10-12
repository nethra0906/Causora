/**
 * The fault-injection gate (docs/security.md, N8). Fault injection can degrade a service on
 * purpose, so it must be impossible to reach by accident. THREE independent conditions must all
 * hold; failing any one refuses the request:
 *
 *   1. opt-in      CAUSORA_FAULTS_ENABLED=true          (default: off, and the route answers 404)
 *   2. environment NODE_ENV !== 'production'            (refuses even with a valid token)
 *   3. credential  a configured token (>= 16 chars) matching the request, from a loopback address
 */
import { timingSafeEqual } from 'node:crypto';

export interface GateEnv {
  CAUSORA_FAULTS_ENABLED?: string;
  NODE_ENV?: string;
  CAUSORA_FAULT_TOKEN?: string;
}

export type GateDecision = { allowed: true } | { allowed: false; status: 401 | 403 | 404; reason: string };

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkFaultGate(env: GateEnv, req: { token?: string; remoteAddress?: string }): GateDecision {
  if (env.CAUSORA_FAULTS_ENABLED !== 'true') return { allowed: false, status: 404, reason: 'not found' };
  if (env.NODE_ENV === 'production') return { allowed: false, status: 403, reason: 'fault injection is disabled in production' };
  const expected = env.CAUSORA_FAULT_TOKEN;
  if (!expected || expected.length < 16) return { allowed: false, status: 403, reason: 'fault token is not configured' };
  if (!req.remoteAddress || !LOOPBACK.has(req.remoteAddress)) return { allowed: false, status: 403, reason: 'loopback only' };
  if (!req.token || !safeEqual(req.token, expected)) return { allowed: false, status: 401, reason: 'invalid fault token' };
  return { allowed: true };
}
