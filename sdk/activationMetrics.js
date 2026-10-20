import crypto from 'node:crypto';
import { acquireCredentialLock, readCredentialFile, writeCredentialFile } from './credentials.js';

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function readJournal(cwd, file) {
  const stored = readCredentialFile(cwd, file);
  if (stored === null) return { version: 2, attempts: [] };
  const journal = JSON.parse(stored);
  const credentials = new Set();
  if (journal?.version !== 2 || !Array.isArray(journal.attempts) || journal.attempts.length > 128) throw new Error('Invalid measurement journal');
  for (const attempt of journal.attempts) {
    if (!attempt || !isDigest(attempt.credential) || credentials.has(attempt.credential)
        || !(attempt.scope === null || isDigest(attempt.scope))
        || !['started', 'finished'].includes(attempt.state) || typeof attempt.reported !== 'boolean'
        || (attempt.state === 'finished' && typeof attempt.passed !== 'boolean')
        || (attempt.reported && (attempt.state !== 'finished' || !attempt.scope))
        || (attempt.install_started_at !== undefined && !isTime(attempt.install_started_at))) throw new Error('Invalid measurement attempt');
    credentials.add(attempt.credential);
  }
  return journal;
}

// Opt-in only. Reconnection and a later successful doctor must not erase a first failure.
export async function runDoctorWithMeasurement(run, {
  config, cwd = process.cwd(), env = process.env, fetchImpl = fetch,
  emit = () => {},
} = {}) {
  if (env.OSUITE_ONBOARDING_METRICS !== '1') return run();
  emit('Opt-in diagnostics: only the first pass/fail result and optional installer timestamp are reported; no commands or local paths.');
  let journal; let file; let attempt; let baseUrl; let apiKey; let agentId; let release; let first = false;
  const unlock = () => { try { release?.(); } catch { /* Measurement cleanup must not change the doctor's result. */ } };
  const save = () => writeCredentialFile(cwd, file, `${JSON.stringify(journal)}\n`);
  try {
    const url = new URL(config?.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || typeof config?.apiKey !== 'string' || !config.apiKey.trim()
        || typeof config?.agentId !== 'string' || !config.agentId.trim()) throw new Error('Connected runtime required');
    baseUrl = url.href.replace(/\/$/, ''); apiKey = config.apiKey.trim(); agentId = config.agentId;
    file = `.osuite/diagnostics/v2-${digest([baseUrl, agentId])}.json`;
    release = acquireCredentialLock(cwd, file);
    // Old state has no credential/workspace binding. Never guess its tenant.
    for (const base of new Set([config.baseUrl, baseUrl])) {
      if (readCredentialFile(cwd, `.osuite/diagnostics/${digest([base, agentId])}.json`) !== null) throw new Error('Unscoped legacy measurement');
    }
    journal = readJournal(cwd, file);
    const credential = digest(apiKey);
    attempt = journal.attempts.find((value) => value.credential === credential);
    if (!attempt) {
      if (journal.attempts.length >= 128) throw new Error('Measurement journal is full');
      attempt = { credential, scope: null, state: 'started', reported: false,
        ...(isTime(env.OSUITE_INSTALL_STARTED_AT) ? { install_started_at: env.OSUITE_INSTALL_STARTED_AT } : {}) };
      journal.attempts.push(attempt);
      save();
      first = true;
    }
  } catch {
    unlock();
    emit('Diagnostic measurement is unavailable; the doctor check will still run.');
    return run();
  }
  try {
    let verified = false;
    try {
      const response = await fetchImpl(`${baseUrl}/api/onboarding/measurement`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { 'x-api-key': apiKey },
      });
      if (!response.ok) throw new Error('Identity unavailable');
      const identity = await response.json();
      if (identity?.version !== 1 || typeof identity.org_id !== 'string' || !identity.org_id.trim()
          || identity.org_id.length > 256 || identity.agent_id !== agentId) throw new Error('Identity mismatch');
      const scope = digest([baseUrl, identity.org_id, identity.agent_id]);
      if (attempt.scope && attempt.scope !== scope) throw new Error('Credential identity changed');
      attempt.scope = scope;
      save();
      verified = true;
    } catch {
      emit('Diagnostic identity is unverified; the first result will remain local and unmeasured.');
    }
    const result = await run();
    try {
      if (first) {
        attempt.state = 'finished'; attempt.passed = result === true;
        save();
      }
      if (!verified) return result;
      const index = journal.attempts.findIndex((value) => value.scope === attempt.scope);
      const original = journal.attempts[index];
      // A rotated but unresolved earlier credential might belong to this cohort.
      // Keep the sample unavailable until that binding can actually be verified.
      if (journal.attempts.slice(0, index).some((value) => value.scope === null)) {
        emit('An earlier diagnostic identity is unresolved; no later result was reported as first.');
        return result;
      }
      if (original.state !== 'finished' || original.reported) return result;
      const payload = {
        version: 1, event: 'doctor_first_result', passed: original.passed,
        source: original.install_started_at ? 'installer' : 'manual_cli',
        ...(original.install_started_at ? { install_started_at: original.install_started_at } : {}),
      };
      const response = await fetchImpl(`${baseUrl}/api/onboarding/measurement`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify(payload),
      });
      if (response.ok) { original.reported = true; save(); }
      else emit('The first diagnostic result is retained locally; it was not acknowledged by Studio.');
    } catch {
      emit('The first diagnostic result is retained locally; reporting failed without changing the check result.');
    }
    return result;
  } finally {
    unlock();
  }
}
