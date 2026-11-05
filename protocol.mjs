export const PROTOCOL_VERSION = 2;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TERMINAL_STATES = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
export const LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  messageBytes: 48 * 1024,
  resultBytes: 256 * 1024,
  nativeBytes: 4 * 1024 * 1024,
  argumentBytes: 64 * 1024,
  jsonDepth: 32,
  schemaNodes: 2048,
  validationTimeoutMs: 2_000,
  validationConcurrency: 2,
  validationQueue: 32,
  validationHeapMb: 64,
  requests: 256,
  pending: 64,
  tools: 16,
  toolCalls: 64,
  events: 256,
  hostDrainMs: 1_500,
  timeoutMs: 300_000,
  maxTimeoutMs: 3_600_000,
  toolTimeoutMs: 60_000,
  maxToolTimeoutMs: 300_000,
  leaseMs: 30_000,
  maxLeaseMs: 60_000,
  artifactBytes: 20 * 1024 * 1024,
  requestArtifactBytes: 64 * 1024 * 1024,
  instanceArtifactBytes: 256 * 1024 * 1024,
  artifacts: 16,
  artifactTtlMs: 30 * 60 * 1000,
});

export function failure(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, ...(details === undefined ? {} : { details }) });
}

export function validateIdentity(value) {
  if (!value || !UUID_PATTERN.test(value.instanceId ?? '') || !Number.isSafeInteger(value.generation) || value.generation <= 0) {
    throw failure(400, 'invalid_identity', 'instanceId must be a UUID and generation a positive safe integer');
  }
}

export function validateId(value, label = 'requestId') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw failure(400, label === 'requestId' ? 'invalid_request_id' : 'invalid_request', `${label} must contain 1..128 ASCII letters, digits, underscores or hyphens`);
  }
  return value;
}
