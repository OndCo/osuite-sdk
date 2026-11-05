import { record, snapshot } from './contract.mjs';

const PROFILE = 'matoi.controlled-transfer.projection.v1';
const states = new Set(['current', 'pending_reconciliation', 'stale', 'failed', 'unavailable']);
const uuid = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const generation = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
const timestamp = value => typeof value === 'string' && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const errorCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const fields = { incarnation: uuid, requestedGeneration: generation, projectedGeneration: generation,
  artifactIncarnation: uuid, artifactGeneration: generation, generatedAt: timestamp, observedAt: timestamp,
  lastError: errorCode };
const unavailable = Object.freeze({ profile: PROFILE, state: 'unavailable', scope: 'derived-view',
  incarnation: null, requestedGeneration: null, projectedGeneration: null, artifactIncarnation: null,
  artifactGeneration: null, generatedAt: null, observedAt: null, lastError: null, authorizesExecution: false });

export function normalizeProjection(value, { cached = false } = {}) {
  if (!record(value)) return unavailable;
  // Inspect only public scalar fields; auxiliary graphs, accessors and debug data
  // must not participate in receipt validation or enter the model context.
  const read = key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor ? descriptor.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined : null;
  };
  const state = read('state');
  if (read('profile') !== PROFILE || read('scope') !== 'derived-view'
    || read('authorizesExecution') !== false || !states.has(state)) return unavailable;
  const result = { ...unavailable, state };
  for (const [key, valid] of Object.entries(fields)) {
    const field = read(key);
    if (field !== null && !valid(field)) return unavailable;
    result[key] = field;
  }
  if (state !== 'unavailable' && result.observedAt === null) return unavailable;
  // Check only wire consistency; canonical UTC timestamps sort chronologically.
  if (state === 'current') {
    if (result.incarnation === null || result.incarnation !== result.artifactIncarnation
      || result.requestedGeneration === null || result.requestedGeneration === '0'
      || result.requestedGeneration !== result.projectedGeneration || result.projectedGeneration !== result.artifactGeneration
      || result.generatedAt === null || result.generatedAt > result.observedAt) return unavailable;
    if (cached) result.state = 'stale';
  }
  return Object.freeze(result);
}

export function snapshotWithProjection(value, code) {
  if (!record(value)) return snapshot(value, code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const projection = normalizeProjection(descriptors.projection?.value);
  delete descriptors.projection;
  // Freshness has its own fixed bound and cannot spend the resource snapshot's
  // byte/node budget. Keep all other descriptors subject to the existing checks.
  const resource = snapshot(Object.defineProperties(Object.create(Object.getPrototypeOf(value)), descriptors), code);
  return Object.freeze({ ...resource, projection });
}
