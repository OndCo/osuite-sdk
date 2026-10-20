import { buildReviewSurface } from './reviewSurface.js';

class ApprovalDeniedError extends Error {
  constructor(message, decision) {
    super(message);
    this.name = 'ApprovalDeniedError';
    this.decision = decision;
  }
}

class GuardBlockedError extends Error {
  constructor(decision) {
    super(decision?.reason || 'Action blocked by policy');
    this.name = 'GuardBlockedError';
    this.decision = decision;
  }
}

class OSuite {
  constructor({ baseUrl, apiKey, agentId, agentKeyId = null, provenanceVersion = 'osuite-prov-v1', requestTimeoutMs = 30000 } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!apiKey) throw new Error('apiKey is required');
    if (!agentId) throw new Error('agentId is required');
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 900000) {
      throw new Error('requestTimeoutMs must be a positive integer no greater than 900000');
    }

    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.agentKeyId = agentKeyId;
    this.provenanceVersion = provenanceVersion;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  _withProvenance(payload = {}) {
    const body = { ...payload };
    const signature = body.agentSignature || body.agent_signature || body._signature || null;
    delete body.agentSignature;
    delete body.agent_signature;

    if (signature) body._signature = signature;
    if (body.agent_key_id === undefined && this.agentKeyId) body.agent_key_id = this.agentKeyId;
    if (body.provenance_version === undefined && this.provenanceVersion) {
      body.provenance_version = this.provenanceVersion;
    }
    return body;
  }

  async _request(path, method = 'GET', body = null, params = null) {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const query = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
      });
      const qs = query.toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    let text;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
      // Keep the deadline active until the response body is read, not just its headers.
      text = await response.text();
    } catch (cause) {
      if (controller.signal.aborted) {
        const error = new Error('Request timed out; the remote outcome may be unknown. Inspect the existing action before retrying.');
        error.code = 'OSUITE_REQUEST_TIMEOUT';
        throw error;
      }
      throw cause;
    } finally {
      clearTimeout(deadline);
    }
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      if (response.status === 403 && data.decision?.decision === 'block') {
        throw new GuardBlockedError(data.decision);
      }
      const error = new Error(data.reason || data.error || `Request failed with status ${response.status}`);
      error.status = response.status;
      error.details = data.details;
      error.response = data;
      throw error;
    }

    return data;
  }

  async guard(context = {}) {
    return this._request('/api/guard', 'POST', this._withProvenance({
      ...context,
      agent_id: context.agent_id || this.agentId,
    }));
  }

  async createAction(action = {}) {
    return this._request('/api/actions', 'POST', this._withProvenance({
      ...action,
      agent_id: action.agent_id || this.agentId,
    }));
  }

  async updateOutcome(actionId, outcome = {}) {
    return this._request(`/api/actions/${encodeURIComponent(actionId)}`, 'PATCH', {
      ...outcome,
      timestamp_end: outcome.timestamp_end || new Date().toISOString(),
    });
  }

  async getActions(filters = {}) {
    return this._request('/api/actions', 'GET', null, filters);
  }

  async getAction(actionId) {
    return this._request(`/api/actions/${encodeURIComponent(actionId)}`, 'GET');
  }

  async getPendingApprovals(limit = 20, offset = 0) {
    return this.getActions({ status: 'pending_approval', limit, offset });
  }

  async approveAction(actionId, decision, reasoning = null) {
    return this._request(`/api/approvals/${encodeURIComponent(actionId)}`, 'POST', {
      decision,
      ...(reasoning ? { reasoning } : {}),
    });
  }

  async waitForApproval(actionId, { timeout = 300000, interval = 5000, print = true } = {}) {
    const startedAt = Date.now();
    let wasPending = false;
    let printed = false;

    while (Date.now() - startedAt < timeout) {
      const payload = await this.getAction(actionId);
      const action = payload.action || payload;

      if (print && !printed) {
        printed = true;
        process.stdout.write(`\n${buildReviewSurface(action, { baseUrl: this.baseUrl })}\n\nWaiting for approval... Ctrl+C to abort.\n\n`);
      }

      if (action.status === 'pending_approval') wasPending = true;
      if (action.status === 'expired') {
        throw new ApprovalDeniedError(
          action.error_message || 'The approval request expired before anyone reviewed it. Ask again.',
          'expired',
        );
      }
      if (['failed', 'cancelled', 'blocked'].includes(action.status)) {
        throw new ApprovalDeniedError(action.error_message || 'Operator denied the action.', action.status);
      }
      // Denials also carry reviewer metadata; it is not permission on its own.
      if (action.status === 'running' && (action.approved_by || action.approved_at)) return action;
      if (wasPending && action.status !== 'pending_approval') {
        throw new Error(`Action ${actionId} left pending_approval without explicit approval metadata.`);
      }
      if (!wasPending && action.status === 'running') return action;

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`Timed out waiting for approval of action ${actionId}`);
  }

  async recordAssumption(assumption = {}) {
    return this._request('/api/assumptions', 'POST', assumption);
  }

  async registerAssumption(assumption = {}) {
    return this.recordAssumption({
      agent_id: this.agentId,
      ...assumption,
    });
  }

  async getAssumption(assumptionId) {
    return this._request(`/api/assumptions/${encodeURIComponent(assumptionId)}`);
  }

  async registerOpenLoop(actionId, loopType, description, metadata = null) {
    const payload = typeof actionId === 'object'
      ? { agent_id: this.agentId, ...actionId }
      : { action_id: actionId, loop_type: loopType, description, metadata, agent_id: this.agentId };
    return this._request('/api/actions/loops', 'POST', payload);
  }

  async getOpenLoops(filters = {}) {
    return this._request('/api/actions/loops', 'GET', null, filters);
  }

  async resolveOpenLoop(loopId, status, resolution = null) {
    return this._request(`/api/actions/loops/${encodeURIComponent(loopId)}`, 'PATCH', { status, resolution });
  }

  async getSignals() {
    return this._request('/api/signals');
  }

  async reportTokenUsage(usage = {}) {
    return this._request('/api/actions', 'POST', {
      agent_id: this.agentId,
      action_type: 'token_usage',
      status: 'completed',
      declared_goal: 'Report token usage',
      ...usage,
    });
  }

  async heartbeat(status = 'online', metadata = null) {
    return this._request('/api/agents/heartbeat', 'POST', {
      agent_id: this.agentId,
      status,
      metadata,
    });
  }

  async reportConnections(connections = []) {
    return this._request('/api/agents/connections', 'POST', {
      agent_id: this.agentId,
      connections,
    });
  }

  async getActionTrace(actionId) {
    return this._request(`/api/actions/${encodeURIComponent(actionId)}/trace`);
  }

  async getGovernanceProof({ actionId, format } = {}) {
    return this._request('/api/governance/proof', 'GET', null, {
      ...(actionId ? { action_id: actionId } : {}),
      ...(format ? { format } : {}),
    });
  }

  async getGovernanceProofBundle({ actionId } = {}) {
    return this.getGovernanceProof({ actionId, format: 'bundle' });
  }

  async verifyGovernanceProof(actionId) {
    return this._request('/api/governance/proof/verify', 'POST', { action_id: actionId });
  }

  async exportProof({ actionId, bundleId } = {}) {
    return this._request('/api/proof/export', 'GET', null, {
      ...(actionId ? { action_id: actionId } : {}),
      ...(bundleId ? { bundle_id: bundleId } : {}),
    });
  }

  async getExternalVerifierConfig() {
    return this._request('/api/external-verifiers/config');
  }

  async configureExternalVerifier(config = {}) {
    return this._request('/api/external-verifiers/config', 'POST', config);
  }

  async disableExternalVerifier(providerId = 'babyblue_invinoveritas') {
    return this._request('/api/external-verifiers/config', 'DELETE', null, {
      provider: providerId,
    });
  }

  async getComplianceEvidence(params = {}) {
    return this._request('/api/compliance/evidence', 'GET', null, params);
  }

  async getPcaaHealth(params = {}) {
    return this._request('/api/governance/proof', 'GET', null, {
      view: 'pcaa_health',
      ...params,
    });
  }

  async getPcaaAction(actionId) {
    return this._request(`/api/actions/${encodeURIComponent(actionId)}`, 'GET', null, {
      view: 'pcaa',
    });
  }

  async events({ signal } = {}) {
    const response = await fetch(`${this.baseUrl}/api/stream`, {
      headers: { 'x-api-key': this.apiKey },
      signal,
    });
    if (!response.ok) throw new Error(`Event stream failed with status ${response.status}`);
    return response;
  }

  async createScorer(name, scorer_type, config = null, description = null) {
    return this._request('/api/evaluations/scorers', 'POST', { name, scorer_type, config, description });
  }

  async createScoringProfile(profile) {
    return this._request('/api/scoring/profiles', 'POST', profile);
  }

  async listScoringProfiles(filters = {}) {
    return this._request('/api/scoring/profiles', 'GET', null, filters);
  }

  async getScoringProfile(profileId) {
    return this._request(`/api/scoring/profiles/${encodeURIComponent(profileId)}`);
  }

  async updateScoringProfile(profileId, updates) {
    return this._request(`/api/scoring/profiles/${encodeURIComponent(profileId)}`, 'PATCH', updates);
  }

  async deleteScoringProfile(profileId) {
    return this._request(`/api/scoring/profiles/${encodeURIComponent(profileId)}`, 'DELETE');
  }

  async addScoringDimension(profileId, dimension) {
    return this._request(`/api/scoring/profiles/${encodeURIComponent(profileId)}/dimensions`, 'POST', dimension);
  }

  async updateScoringDimension(profileId, dimensionId, updates) {
    return this._request(`/api/scoring/profiles/${encodeURIComponent(profileId)}/dimensions/${encodeURIComponent(dimensionId)}`, 'PATCH', updates);
  }

  async deleteScoringDimension(profileId, dimensionId) {
    return this._request(`/api/scoring/profiles/${encodeURIComponent(profileId)}/dimensions/${encodeURIComponent(dimensionId)}`, 'DELETE');
  }

  async scoreWithProfile(profileId, action) {
    return this._request('/api/scoring/score', 'POST', { profile_id: profileId, action });
  }

  async batchScoreWithProfile(profileId, actions) {
    return this._request('/api/scoring/score', 'POST', { profile_id: profileId, actions });
  }

  async getProfileScores(filters = {}) {
    return this._request('/api/scoring/score', 'GET', null, filters);
  }

  async getProfileScoreStats(profileId) {
    return this._request('/api/scoring/score', 'GET', null, { profile_id: profileId, view: 'stats' });
  }

  async createRiskTemplate(template) {
    return this._request('/api/scoring/risk-templates', 'POST', template);
  }

  async listRiskTemplates(filters = {}) {
    return this._request('/api/scoring/risk-templates', 'GET', null, filters);
  }

  async updateRiskTemplate(templateId, updates) {
    return this._request(`/api/scoring/risk-templates/${encodeURIComponent(templateId)}`, 'PATCH', updates);
  }

  async deleteRiskTemplate(templateId) {
    return this._request(`/api/scoring/risk-templates/${encodeURIComponent(templateId)}`, 'DELETE');
  }

  async autoCalibrate(options = {}) {
    return this._request('/api/scoring/calibrate', 'POST', options);
  }

  async sendMessage({ to, type, subject, body, threadId, urgent, actionId }) {
    return this._request('/api/messages', 'POST', {
      from_agent_id: this.agentId,
      to_agent_id: to,
      message_type: type,
      subject,
      body,
      thread_id: threadId,
      urgent,
      action_id: actionId,
    });
  }

  async getInbox({ type, unread, limit } = {}) {
    return this._request('/api/messages', 'GET', null, {
      agent_id: this.agentId,
      direction: 'inbox',
      ...(type ? { type } : {}),
      ...(unread != null ? { unread } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  async createHandoff(handoff) {
    return this._request('/api/_archive/handoffs', 'POST', { agent_id: this.agentId, ...handoff });
  }

  async getHandoffs(filters = {}) {
    return this._request('/api/_archive/handoffs', 'GET', null, {
      agent_id: this.agentId,
      ...filters,
    });
  }

  async getLatestHandoff() {
    return this._request('/api/_archive/handoffs', 'GET', null, { agent_id: this.agentId, latest: 'true' });
  }

  async scanPromptInjection(text, { source } = {}) {
    return this._request('/api/security/prompt-injection', 'POST', { text, source, agent_id: this.agentId });
  }

  async scanContent(text, destination = null) {
    return this._request('/api/security/scan', 'POST', {
      text,
      destination,
      agent_id: this.agentId,
      store: false,
    });
  }

  async submitFeedback({ action_id, rating, comment, category, tags, metadata }) {
    return this._request('/api/feedback', 'POST', {
      action_id,
      agent_id: this.agentId,
      rating,
      comment,
      category,
      tags,
      metadata,
    });
  }

  async createThread(thread) {
    return this._request('/api/messages/threads', 'POST', {
      created_by: this.agentId,
      participants: [this.agentId],
      ...thread,
    });
  }

  async getThreads(filters = {}) {
    return this._request('/api/messages/threads', 'GET', null, {
      agent_id: this.agentId,
      ...filters,
    });
  }

  async addThreadEntry(threadId, content, entryType) {
    return this._request(`/api/context/threads/${encodeURIComponent(threadId)}/entries`, 'POST', {
      content,
      entry_type: entryType,
    });
  }

  async closeThread(threadId, summary) {
    return this._request('/api/messages/threads', 'PATCH', {
      thread_id: threadId,
      status: 'resolved',
      ...(summary ? { summary } : {}),
    });
  }

  async saveSnippet(snippet = {}) {
    return this._request('/api/_archive/snippets', 'POST', {
      agent_id: this.agentId,
      ...snippet,
    });
  }

  async getSnippet(snippetId) {
    return this._request(`/api/_archive/snippets/${encodeURIComponent(snippetId)}`);
  }

  async setPreference(preference = {}) {
    return this._request('/api/_archive/preferences', 'POST', {
      type: 'preference',
      agent_id: this.agentId,
      ...preference,
    });
  }

  async getPreferenceSummary() {
    return this._request('/api/_archive/preferences', 'GET', null, {
      type: 'summary',
      agent_id: this.agentId,
    });
  }

  async getDailyDigest(date = null) {
    return this._request('/api/_archive/digest', 'GET', null, {
      agent_id: this.agentId,
      ...(date ? { date } : {}),
    });
  }

  async getSentMessages({ type, threadId, limit } = {}) {
    return this._request('/api/messages', 'GET', null, {
      agent_id: this.agentId,
      direction: 'sent',
      ...(type ? { type } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  async getWebhooks() {
    return this._request('/api/webhooks');
  }

  async syncState(state) {
    return this._request('/api/sync', 'POST', { agent_id: this.agentId, ...state });
  }

  actionContext(actionId) {
    return {
      sendMessage: (message) => this.sendMessage({ ...message, actionId }),
      recordAssumption: (assumption) => this.recordAssumption({ ...assumption, action_id: actionId }),
      updateOutcome: (outcome) => this.updateOutcome(actionId, outcome),
    };
  }

  renderReview(action, options = {}) {
    return buildReviewSurface(action, { baseUrl: this.baseUrl, ...options });
  }
}

const DashClaw = OSuite;
const Osuite = OSuite;
const OpenClawAgent = OSuite;

export default OSuite;
export { ApprovalDeniedError, DashClaw, GuardBlockedError, OSuite, Osuite, OpenClawAgent, buildReviewSurface };
