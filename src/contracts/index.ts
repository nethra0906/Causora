/**
 * THE CAUSAL METADATA CONTRACT - single source of truth.
 *
 * Every header name, span attribute name, event type and edge type used anywhere in Causora is
 * defined here and imported. Never write a `causora.*` string literal elsewhere: the ablation
 * study works precisely because these names are a closed, enumerable set.
 */
import { z } from 'zod';

// ───────────────────────────── transport: HTTP headers ─────────────────────────────
export const HTTP_HEADERS = {
  traceparent: 'traceparent',
  businessOperationId: 'x-causora-business-operation-id',
  causationId: 'x-causora-causation-id',
  idempotencyKey: 'x-causora-idempotency-key',
  attempt: 'x-causora-attempt',
  deadlineMs: 'x-causora-deadline-ms',
  /** Caller-ALLOCATED id of the server-side event (lets a timeout name the event it awaited). */
  eventId: 'x-causora-event-id',
  faultToken: 'x-causora-fault-token',
} as const;

// ───────────────────────────── transport: bus (Kafka-shaped) headers ─────────────────────────────
export const MSG_HEADERS = {
  traceparent: 'traceparent',
  eventId: 'causora-event-id',
  causationId: 'causora-causation-id',
  businessOperationId: 'causora-business-operation-id',
  idempotencyKey: 'causora-idempotency-key',
  attempt: 'causora-attempt',
  retryOfEventId: 'causora-retry-of-event-id',
  producedAt: 'causora-produced-at',
  schemaVersion: 'causora-schema-version',
} as const;

// ───────────────────────────── span attributes (the Causora namespace) ─────────────────────────────
export const ATTR = {
  eventId: 'causora.event_id',
  eventType: 'causora.event_type',
  operation: 'causora.operation',
  businessOperationId: 'causora.business_operation_id',
  causationId: 'causora.causation_id',
  idempotencyKey: 'causora.idempotency_key',
  attemptNumber: 'causora.attempt_number',
  retryOfEventId: 'causora.retry_of_event_id',
  awaitedCorrelationId: 'causora.awaited_correlation_id',
  messageId: 'causora.message_id',
  topic: 'causora.topic',
  messageKey: 'causora.message_key',
  producedAt: 'causora.produced_at',
  experimentId: 'causora.experiment_id',
  resourceIds: 'causora.resource_ids',
  mutating: 'causora.mutating',
  errorType: 'causora.error_type',
  source: 'causora.source',
  faultTarget: 'causora.fault_target',
  faultTtlMs: 'causora.fault_ttl_ms',
} as const;

export const SCHEMA_VERSION = 1;

// ───────────────────────────── taxonomy ─────────────────────────────
export const EVENT_TYPES = [
  'http.server.request',
  'http.client.request',
  'messaging.produce',
  'messaging.consume',
  'domain.state_change',
  'timeout.fired',
  'idempotency.hit',
  'error.raised',
  'fault.injected',
  'fault.cleared',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type EventSource = 'span' | 'fault';
export type EventStatus = 'OK' | 'ERROR' | 'TIMEOUT' | 'UNKNOWN';
export type EvidenceSource = 'otlp_span' | 'fault_injector' | 'causora_analysis';

export const EDGE_TYPES = [
  'PARENT_OF',
  'TRIGGERED',
  'RETRY_OF',
  'TIMED_OUT_WAITING_FOR',
  'FAULT_AFFECTED',
  'DUPLICATE_OF',
  'LIKELY_TRIGGERED',
  'LIKELY_RETRY_OF',
  'TEMPORAL_PROXIMITY',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export type EvidenceClass = 'proven' | 'derived' | 'inferred' | 'weak';

/** Declared (not learned) weight per class. See ADR-0006. */
export const EDGE_META: Record<EdgeType, { cls: EvidenceClass; confidence: number }> = {
  PARENT_OF: { cls: 'proven', confidence: 1.0 },
  TRIGGERED: { cls: 'proven', confidence: 1.0 },
  RETRY_OF: { cls: 'proven', confidence: 1.0 },
  TIMED_OUT_WAITING_FOR: { cls: 'proven', confidence: 1.0 },
  FAULT_AFFECTED: { cls: 'proven', confidence: 1.0 },
  DUPLICATE_OF: { cls: 'derived', confidence: 0.9 },
  LIKELY_TRIGGERED: { cls: 'inferred', confidence: 0.6 },
  LIKELY_RETRY_OF: { cls: 'inferred', confidence: 0.6 },
  TEMPORAL_PROXIMITY: { cls: 'weak', confidence: 0.1 },
};

/** Hard cap so that no chain of inferences can ever outrank a proven chain. Tested. */
export const MAX_INFERRED_CONFIDENCE = 0.75;

export function confidenceLabel(c: number): 'Proven' | 'Derived' | 'Inferred' | 'Speculative' {
  if (c >= 1) return 'Proven';
  if (c >= 0.85) return 'Derived';
  if (c >= 0.5) return 'Inferred';
  return 'Speculative';
}

// ───────────────────────────── the normalised event ─────────────────────────────
export interface NormalisedEvent {
  event_id: string;
  event_type: EventType;
  source: EventSource;
  service: string;
  operation: string;
  occurred_at: number; // epoch ms (event clock)
  ended_at: number | null;
  duration_ms: number | null;
  ingested_at: number; // Causora clock
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  business_operation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  attempt_number: number;
  retry_of_event_id: string | null;
  awaited_correlation_id: string | null;
  message_id: string | null;
  topic: string | null;
  message_key: string | null;
  produced_at: number | null;
  dwell_ms: number | null; // CROSS-CLOCK: occurred_at - produced_at
  status: EventStatus;
  error_type: string | null;
  /** DERIVED. NEVER an input to ranking. See RankableEvent. */
  experiment_id: string | null;
  /** DERIVED. NEVER an input to ranking. See RankableEvent. */
  is_fault_injected: boolean;
  resource_ids: Record<string, string>;
  mutating: boolean;
  evidence_source: EvidenceSource;
  attributes: Record<string, string | number | boolean>;
  schema_version: number;
  contract_violations: string[];
}

/**
 * INTEGRITY RULE (event-model.md §3). The ranker receives this projection, which structurally
 * omits the two ground-truth fields. If you are tempted to add them back, the change is wrong:
 * the evaluation would become circular.
 */
export type RankableEvent = Omit<NormalisedEvent, 'is_fault_injected' | 'experiment_id'>;

export interface MatchedField {
  field: string;
  from_value: string;
  to_value: string;
}

export interface CausalEdge {
  from_event_id: string;
  to_event_id: string;
  type: EdgeType;
  evidence_class: EvidenceClass;
  confidence: number;
  derived_by_rule: string;
  evidence: { matched_fields: MatchedField[]; notes?: string; window_ms?: number };
}

// ───────────────────────────── wire format (OTel-shaped span) ─────────────────────────────
export const wireSpanSchema = z.object({
  traceId: z.string().min(1).max(64),
  spanId: z.string().min(1).max(64),
  parentSpanId: z.string().max(64).nullish(),
  name: z.string().min(1).max(200),
  service: z.string().min(1).max(100),
  kind: z.enum(['server', 'client', 'producer', 'consumer', 'internal']),
  startTimeMs: z.number().finite(),
  endTimeMs: z.number().finite(),
  status: z.object({ code: z.enum(['OK', 'ERROR', 'UNSET']), message: z.string().max(500).optional() }),
  attributes: z.record(z.union([z.string().max(2000), z.number(), z.boolean()])),
});
export type WireSpan = z.infer<typeof wireSpanSchema>;
export const ingestSchema = z.object({ spans: z.array(wireSpanSchema).max(2000) });

// ───────────────────────────── rule sets (the ablation is configuration) ─────────────────────────────
export type ContractField =
  | 'causation_id'
  | 'retry_of_event_id'
  | 'awaited_correlation_id'
  | 'idempotency_key'
  | 'business_operation_id'
  | 'attempt_number';

export const RULE_IDS = {
  parentOf: 'rule.parent_of@v1',
  triggered: 'rule.triggered.causation_id@v1',
  retryOf: 'rule.retry_of@v1',
  timedOut: 'rule.timeout.awaited@v1',
  faultAffected: 'rule.fault_affected@v1',
  duplicate: 'rule.duplicate.idempotency@v1',
  likelyTriggered: 'rule.inferred.triggered@v1',
  likelyRetry: 'rule.inferred.retry_of@v1',
  proximity: 'rule.proximity@v1',
} as const;
export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

export interface RuleSet {
  id: string;
  title: string;
  description: string;
  enabled: RuleId[];
  /** Contract fields treated as ABSENT before any rule runs - this is how metadata loss is simulated. */
  masked: ContractField[];
}

const PROVEN: RuleId[] = [RULE_IDS.parentOf, RULE_IDS.triggered, RULE_IDS.retryOf, RULE_IDS.timedOut, RULE_IDS.faultAffected, RULE_IDS.duplicate];
const INFERRED: RuleId[] = [RULE_IDS.likelyTriggered, RULE_IDS.likelyRetry];
const ALL_FIELDS: ContractField[] = ['causation_id', 'retry_of_event_id', 'awaited_correlation_id', 'idempotency_key', 'business_operation_id', 'attempt_number'];

export const DEFAULT_RULE_SET_ID = 'default';

export const RULE_SETS: RuleSet[] = [
  { id: 'default', title: 'Full contract', description: 'Every contract field propagated. Inferred rules are enabled but only fire where a field is missing.', enabled: [...PROVEN, ...INFERRED], masked: [] },
  { id: 'ablation.no_causation_id', title: 'Without causation_id', description: 'Producer→consumer causality is no longer carried; heuristics must reconstruct it.', enabled: [...PROVEN, ...INFERRED], masked: ['causation_id'] },
  { id: 'ablation.no_causation_id.no_inference', title: 'Without causation_id, no inference', description: 'As above with the heuristic rules switched off: the raw cost of the loss.', enabled: [...PROVEN], masked: ['causation_id'] },
  { id: 'ablation.no_retry_of', title: 'Without retry_of_event_id', description: 'Retry chains are no longer provable.', enabled: [...PROVEN, ...INFERRED], masked: ['retry_of_event_id'] },
  { id: 'ablation.no_awaited', title: 'Without awaited_correlation_id', description: 'A timeout says something was slow, not what.', enabled: [...PROVEN, ...INFERRED], masked: ['awaited_correlation_id'] },
  { id: 'ablation.no_idempotency_key', title: 'Without idempotency_key', description: 'Duplicate work is indistinguishable from legitimate repetition.', enabled: [...PROVEN, ...INFERRED], masked: ['idempotency_key'] },
  { id: 'ablation.tracing_only', title: 'Tracing only + inference', description: 'Only W3C span parentage survives; heuristics try to bridge the broker.', enabled: [RULE_IDS.parentOf, RULE_IDS.faultAffected, ...INFERRED], masked: ALL_FIELDS },
  { id: 'ablation.tracing_only.no_inference', title: 'Tracing only (what a trace UI shows)', description: 'Parent/child spans and nothing else.', enabled: [RULE_IDS.parentOf, RULE_IDS.faultAffected], masked: ALL_FIELDS },
];

export function getRuleSet(id: string): RuleSet {
  const rs = RULE_SETS.find((r) => r.id === id);
  if (!rs) throw new Error(`unknown rule set: ${id}`);
  return rs;
}

// ───────────────────────────── analysis configuration (snapshotted into every investigation) ─────────────────────────────
export interface AnalysisConfig {
  maxTraversalDepth: number;
  maxSubgraphNodes: number;
  minPathConfidence: number;
  minBaselineSamples: number;
  minSpreadMs: number;
  zSaturation: number;
  retrySaturation: number;
  dwellSaturation: number;
  anomalyThreshold: number;
  anomalyWeights: { latency: number; error: number; errorRate: number; retry: number; dwell: number };
  rankWeights: { anomaly: number; proximity: number; path: number; pattern: number };
  patternBonus: Record<string, number>;
  retryWindowMs: number;
  inferenceWindowMs: number;
  clockUncertaintyMs: number;
  /** Heuristic H1: latency is self-time (duration minus child spans). Switched off ONLY to measure what it buys. */
  selfTimeLatency: boolean;
  /** Heuristic H2: a caller's error/timeout is attributed to its callee. Switched off ONLY to measure what it buys. */
  calleeErrorAttribution: boolean;
}

export const DEFAULT_CONFIG: AnalysisConfig = {
  maxTraversalDepth: 12,
  maxSubgraphNodes: 5000,
  minPathConfidence: 0.2,
  minBaselineSamples: 20,
  minSpreadMs: 5,
  zSaturation: 10,
  retrySaturation: 5,
  dwellSaturation: 10,
  anomalyThreshold: 0.35,
  anomalyWeights: { latency: 0.4, error: 0.25, errorRate: 0.15, retry: 0.1, dwell: 0.1 },
  rankWeights: { anomaly: 0.45, proximity: 0.15, path: 0.25, pattern: 0.15 },
  patternBonus: { IDEMPOTENCY_FAILURE: 0.2, DUPLICATE_WORK: 0.15, SLOW_CONSUMER: 0.15, RETRY_STORM: 0.1, TIMEOUT_CASCADE: 0.1 },
  retryWindowMs: 30_000,
  inferenceWindowMs: 5_000,
  clockUncertaintyMs: 50,
  selfTimeLatency: true,
  calleeErrorAttribution: true,
};

// ───────────────────────────── analysis result types ─────────────────────────────
export type ConfidenceLabel = 'STRONG' | 'SUPPORTED' | 'WEAK' | 'SPECULATIVE';
export type Completeness = 'COMPLETE' | 'PROVISIONAL' | 'DEGRADED';

export interface PathStep {
  from_event_id: string;
  to_event_id: string;
  type: EdgeType;
  evidence_class: EvidenceClass;
  confidence: number;
  derived_by_rule: string;
  matched_fields: MatchedField[];
}

export interface PatternMatch {
  pattern: string;
  member_event_ids: string[];
  earliest_event_id: string;
  evidence: Record<string, unknown>;
}

export interface CandidateEvidence {
  candidate_event_id: string;
  path_to_failure: PathStep[];
  anomaly_breakdown: {
    latency: { exclusive_ms: number | null; baseline_p50: number | null; baseline_p95: number | null; z: number; contribution: number };
    error: { status: EventStatus; error_type: string | null; discounted_for_callee_error: boolean; contribution: number };
    error_rate: { observed: number; baseline: number | null; contribution: number };
    retries: { descendant_retry_count: number; contribution: number };
    dwell: { dwell_ms: number | null; baseline_p95: number | null; clock_uncertainty_ms: number; contribution: number };
  };
  patterns: PatternMatch[];
  concurrent_with: string[];
  caveats: string[];
}

export interface Candidate {
  rank: number;
  event_id: string;
  service: string;
  operation: string;
  attempt_number: number;
  in_frontier: boolean;
  score: number;
  anomaly: number;
  depth: number;
  label: ConfidenceLabel;
  evidence: CandidateEvidence;
}

export interface Investigation {
  failure_event_id: string;
  business_operation_id: string | null;
  rule_set_id: string;
  mode: 'default' | 'ground_truth';
  completeness: Completeness;
  completeness_reasons: string[];
  subgraph_node_count: number;
  subgraph_edge_count: number;
  subgraph_event_ids: string[];
  truncated: boolean;
  frontier_fallback: boolean;
  candidates: Candidate[];
  patterns: PatternMatch[];
  config_snapshot: AnalysisConfig;
  duration_ms: number;
  created_at: number;
}

export interface Baseline {
  service: string;
  operation: string;
  sample_count: number;
  p50_ms: number;
  p95_ms: number;
  error_rate: number;
  dwell_p95_ms?: number | null;
}

// ───────────────────────────── deployment constants shared by services & platform ─────────────────────────────
const PORT_BASE = typeof process !== 'undefined' && process.env?.CAUSORA_PORT_BASE ? Number(process.env.CAUSORA_PORT_BASE) : 4000;
export const PORTS = { platform: PORT_BASE, order: PORT_BASE + 101, inventory: PORT_BASE + 102, payment: PORT_BASE + 103 } as const;
export const TOPICS = { orders: 'orders.events', inventory: 'inventory.events' } as const;
export const GROUPS = { inventoryReserver: 'inventory-reserver', orderSaga: 'order-saga' } as const;

/**
 * Deterministic id of "message M consumed by group G" - computable by anyone who knows M, which is
 * what lets a timeout name the consumer it awaited before that consumer has run.
 *
 * The FIRST delivery keeps the bare id (that is the one a waiter can name). A REDELIVERY of the same
 * message after a handler failure is a different occurrence and gets a `#<n>` suffix; before this,
 * redeliveries shared one id and all but the first were silently discarded at ingest (held-out
 * prediction P6, docs/experiments/held-out.md).
 */
export function consumeEventId(messageId: string, group: string, delivery = 1): string {
  const base = `consume:${messageId}:${group}`;
  return delivery > 1 ? `${base}#${delivery}` : base;
}

/**
 * Scenario timing. Scaled down from the blueprint so a full evaluation takes seconds, and chosen
 * so that DEADLINE < INVENTORY_DELAY < 2*DEADLINE (exactly ONE retry; see ADR-0017).
 */
export const TIMING = {
  inventoryWaitDeadlineMs: 1000,
  settleWindowMs: 1500,
  paymentDeadlineMs: 800,
  maxAttempts: 3,
  /** Telemetry silence after which an operation may be called COMPLETE (> exporter flush interval). */
  quietMs: 1000,
} as const;
