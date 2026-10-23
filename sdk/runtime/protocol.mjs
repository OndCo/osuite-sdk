import { createHash, createPrivateKey, sign } from 'node:crypto';

export const RULE_ROLLOUT_CAPABILITY = 'osuite.scoped_rule_rollout.v1';

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/.test(value) && !value.includes('..');

export const isTransientFailure = response => response?.ok === false && (
  (response.status === 0 && ['timeout', 'transport_failure'].includes(response.error))
  || (response.error === 'http_error' && [500, 502, 503, 504].includes(response.status))
);

const transientCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
function transientTransport(error) {
  const cause = error?.cause || error;
  if (cause?.errors !== undefined) return Array.isArray(cause.errors) && cause.errors.length > 0
    && cause.errors.length <= 32 && (cause.code === undefined || transientCodes.has(cause.code))
    && cause.errors.every(item => transientCodes.has(item?.code) && item.errors === undefined);
  return transientCodes.has(cause?.code);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function toolInputDigest(toolName, toolInput) {
  return sha256(canonicalJson({ tool_name: toolName || '', tool_input: toolInput ?? {} }));
}

export function validatedBaseUrl(value, { allowInsecureHttp = false } = {}) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureHttp))) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

export function createApiClient(config, { fetchImpl = globalThis.fetch, timeoutMs = 2500,
  maxResponseBytes = config.ruleRolloutCapability === RULE_ROLLOUT_CAPABILITY ? 1048576 : 262144 } = {}) {
  return {
    async request(method, endpoint, body, options = {}) {
      const baseUrl = validatedBaseUrl(config.baseUrl, config);
      if (!baseUrl) return { ok: false, status: 0, error: 'invalid_base_url' };
      if (!config.apiKey) return { ok: false, status: 0, error: 'not_configured' };
      if (typeof config.apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(config.apiKey)
          || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
        return { ok: false, status: 0, error: 'invalid_request' };
      }
      if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
        return { ok: false, status: 0, error: 'invalid_endpoint' };
      }
      let payload;
      if (body !== undefined) {
        if (!isObject(body)) return { ok: false, status: 0, error: 'invalid_request' };
        // Canonicalize the JSON wire shape, not properties JSON would omit.
        try { payload = JSON.parse(JSON.stringify(body)); } catch {
          return { ok: false, status: 0, error: 'invalid_request' };
        }
        if (!isObject(payload)) return { ok: false, status: 0, error: 'invalid_request' };
        delete payload._signature;
        if (config.privateKeyBase64) {
          try {
            const key = createPrivateKey(Buffer.from(config.privateKeyBase64, 'base64'));
            payload._signature = sign('sha256', Buffer.from(canonicalJson(payload)), key).toString('base64');
          } catch {
            // A supplied but invalid key is never an instruction to send unsigned.
            return { ok: false, status: 0, error: 'signing_unavailable' };
          }
        } else if (config.signatureMode === 'required') {
          return { ok: false, status: 0, error: 'signing_unavailable' };
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(options.timeoutMs ?? timeoutMs, 30000)));
      let status = 0;
      try {
        const response = await fetchImpl(baseUrl + endpoint, {
          method, redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey,
            ...(config.ruleRolloutCapability === RULE_ROLLOUT_CAPABILITY ? { 'x-osuite-runtime-capability': RULE_ROLLOUT_CAPABILITY } : {}),
            ...(config.ruleRollout?.enabled ? { 'x-osuite-rule-rollout-version': String(config.ruleRollout.version) } : {}) },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        status = response.status;
        if (status < 200 || status >= 300) {
          await response.body?.cancel();
          return { ok: false, status, error: 'http_error' };
        }
        const reader = response.body?.getReader();
        if (!reader) return { ok: false, status, error: 'invalid_response' };
        const chunks = [];
        let length = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxResponseBytes) {
            await reader.cancel();
            return { ok: false, status, error: 'invalid_response' };
          }
          chunks.push(Buffer.from(value));
        }
        let parsed;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch {
          return { ok: false, status, error: 'invalid_response' };
        }
        if (!isObject(parsed)) return { ok: false, status, error: 'invalid_response' };
        return { ok: true, status, body: parsed };
      } catch (error) {
        return { ok: false, status, error: status ? 'invalid_response' : controller.signal.aborted ? 'timeout'
          : transientTransport(error) ? 'transport_failure' : 'request_failed' };
      } finally { clearTimeout(timer); }
    },
  };
}
