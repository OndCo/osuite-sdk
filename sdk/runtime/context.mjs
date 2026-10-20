import { canonicalJson, isObject, safeId, sha256, toolInputDigest } from './protocol.mjs';
import { classifyShell } from './shell.mjs';
import { collectGitPublication } from './git.mjs';

const contentKeys = new Set(['content', 'new_string', 'old_string', 'new_source', 'old_source', 'file_text', 'patch', 'diff', 'input']);
const publicHosts = new Set(['file.io', 'transfer.sh', '0x0.st', 'pastebin.com', 'gofile.io', 'wetransfer.com', 'tmpfiles.org']);
const contentSummary = value => { const raw = typeof value === 'string' ? value : canonicalJson(value); return { length: [...raw].length, sha256: sha256(raw) }; };

export function summarizeToolInput(input, capture = 'summary') {
  if (capture === 'full') return input;
  if (!isObject(input)) return contentSummary(input);
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    contentKeys.has(key) ? contentSummary(value) : key === 'edits' && Array.isArray(value) ? { count: value.length, ...contentSummary(value) }
      : typeof value === 'string' ? value.length <= 500 ? value : { ...contentSummary(value) }
        : value !== null && typeof value === 'object' ? contentSummary(value) : value]));
}

export function deriveToolUseId(data) {
  const explicit = data.tool_use_id ?? data.event_id ?? data.id;
  if ((typeof explicit === 'string' || typeof explicit === 'number') && String(explicit)) return String(explicit);
  return `tool_${sha256(canonicalJson({ session_id: data.session_id || '', tool_name: data.tool_name || '', tool_input: data.tool_input ?? {} })).slice(0, 32)}`;
}

export function deriveSessionId(data, config) {
  const explicit = data.session_id || config.runtimeSessionId;
  if (explicit) {
    if (!safeId(String(explicit)) || String(explicit).length > 128) throw new Error('Invalid runtime session evidence');
    return String(explicit);
  }
  return `sess_${sha256(canonicalJson([config.agentId, config.runtimeId, data.cwd || process.cwd()])).slice(0, 32)}`;
}

export function autonomySignal(data, config) {
  const raw = String(data.runtime_permission_mode || data.runtimePermissionMode || data.permission_mode || data.permissionMode || config.runtimePermissionMode || '').replace(/[- _]/g, '').toLowerCase();
  const mode = ({ default: 'manual', manual: 'manual', ask: 'manual', askfirst: 'manual', prompt: 'manual', confirm: 'manual',
    acceptedits: 'accept_edits', accepteditsmode: 'accept_edits', bypass: 'bypass', bypasspermissions: 'bypass', dangerouslyskippermissions: 'bypass',
    auto: 'auto', automode: 'auto', automatic: 'auto', autonomous: 'auto', plan: 'plan', planning: 'plan', readonly: 'plan' })[raw] || 'unknown';
  return { runtime_permission_mode: mode,
    runtime_permission_decision: ({ manual: 'manual_prompt_required', accept_edits: 'edit_acceptance_mode', bypass: 'permissions_bypassed', auto: 'auto_mode_observed', plan: 'plan_only' })[mode] || 'unknown',
    runtime_permission_source: config.host === 'claude' ? 'claude_code' : config.host,
    runtime_autonomy_level: ({ manual: 'human_prompted', accept_edits: 'bounded_edit_autonomy', bypass: 'runtime_permission_bypass', auto: 'runtime_classifier', plan: 'no_side_effects_expected' })[mode] || 'unknown' };
}

function genericContext(tool, input, capture = 'summary') {
  const serialized = canonicalJson(input), lower = `${tool} ${serialized}`.toLowerCase();
  let host = '';
  try { host = new URL(serialized.match(/https?:\/\/[^\s"\\<>]+/)?.[0]).hostname.toLowerCase(); } catch { /* No literal destination. */ }
  const sensitive = [];
  if (/customer|client.data|user.data|personal.data|\bpii\b/.test(lower)) sensitive.push('customer_data');
  if (/credential|secret|api[_ -]?key|private[_ -]?key|password/.test(lower)) sensitive.push('credentials');
  if (/source.code|proprietary|internal.document/.test(lower)) sensitive.push('internal_data');
  let risk = /upload|share|publish|export|send|attach|link/.test(lower) ? 35 : 10;
  const summary = { tool_name: tool, tool_category: 'tool_observation', tool_input_summary: summarizeToolInput(input, capture) };
  if (host) {
    summary.endpoint_host = host; summary.tool_category = 'network_egress'; summary.persists_remote = true;
    summary.destination_type = publicHosts.has(host) ? 'public_file_host' : /notion|drive|dropbox|slack|confluence|jira|mcp/.test(lower) ? 'external_workspace' : 'public_api';
    summary.destination_visibility = publicHosts.has(host) ? 'external_public' : 'external_private';
    risk = Math.max(risk, publicHosts.has(host) ? 70 : summary.destination_type === 'external_workspace' ? 45 : 40);
  }
  if (/public link|publicly accessible|anyone with the link|public upload/.test(lower)) {
    summary.destination_type ||= 'public_share_link'; summary.destination_visibility = 'external_public'; summary.persists_remote = true; risk = Math.max(risk, 75);
  }
  if (/notion|google drive|dropbox|slack|confluence|jira/.test(lower)) {
    summary.destination_type ||= 'external_workspace'; summary.destination_visibility ||= 'external_private'; summary.persists_remote = true;
  }
  const extra = {};
  if (/okta|cloudtrail|mfa|sign.in|access log|security log|audit log/.test(lower)) {
    summary.payload_class = 'identity_security_logs'; risk = Math.max(risk, 65);
    Object.assign(extra, { personal_data_likelihood: 75, privacy_review_required: true, data_minimization_declared: false, authorization_scope: 'identity.logs.export external.processor.share' });
    if (summary.destination_type || /vendor|forensic|third.party/.test(lower)) extra.external_data_processors = ['approved_external_vendor'];
  } else if (sensitive.length) {
    extra.personal_data_likelihood = sensitive.includes('customer_data') ? 55 : 35;
    if (summary.destination_type) { risk = Math.max(risk, 50); Object.assign(extra, { privacy_review_required: true, data_minimization_declared: false, authorization_scope: 'external.share review_required' }); }
  }
  if (sensitive.length) { summary.sensitive_categories = sensitive; extra.sensitive_data_categories = sensitive; }
  return { action_type: risk >= 35 ? 'api' : 'other', risk_score: risk, reversible: true, systems_touched: ['tool_runtime', tool, ...(host ? [host] : [])], summary, ...extra };
}

export function buildActionContext(data, config) {
  if (!isObject(data) || typeof data.tool_name !== 'string' || !data.tool_name || data.tool_name.length > 128 || !safeId(config.agentId) || config.agentId.length > 128) throw new Error('Invalid tool invocation evidence');
  const tool = data.tool_name, input = data.tool_input ?? {}, objectInput = isObject(input) ? input : {};
  let mapped, goal;
  if (tool === 'Bash' || (config.host === 'cursor' && tool === 'Shell')) {
    if (typeof objectInput.command !== 'string' || !objectInput.command) throw new Error('Missing Bash command evidence');
    if (config.host === 'cursor' && objectInput.working_directory !== undefined
        && (typeof objectInput.working_directory !== 'string' || !objectInput.working_directory || objectInput.working_directory.includes('\0'))) throw new Error('Invalid Shell working directory');
    const cwd = config.host === 'cursor' ? objectInput.working_directory || data.cwd || process.cwd() : data.cwd || process.cwd();
    goal = `${tool}: ${objectInput.command}`;
    mapped = classifyShell(objectInput.command, cwd);
    const publication = collectGitPublication(objectInput.command, cwd);
    if (publication) mapped.summary.git_publication = publication;
    // Keep the reference externality hints in addition to structural shell semantics.
    const external = genericContext(tool, input, config.captureToolInput);
    if (external.summary.destination_type || external.sensitive_data_categories?.length) {
      mapped = { ...external, ...mapped, risk_score: Math.max(mapped.risk_score, external.risk_score), summary: { ...external.summary, ...mapped.summary } };
    }
  } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(tool)) {
    const file = objectInput.path || objectInput.file_path || objectInput.notebook_path || 'unknown';
    goal = `${tool}: ${file}`;
    const lower = String(file).toLowerCase();
    const type = /\.env|secret|credential|private_key|id_rsa/.test(lower) ? ['security', 85, true]
      : /migration|schema|seed/.test(lower) ? ['migrate', 70, false]
        : /deploy|infra|terraform|kubernetes|k8s/.test(lower) ? ['deploy', 75, true]
          : /auth|login|oauth|jwt|token|password/.test(lower) ? ['security', 75, true] : ['other', 15, true];
    mapped = { action_type: type[0], risk_score: type[1], reversible: type[2], systems_touched: ['filesystem'], summary: { tool_input_summary: summarizeToolInput(input, config.captureToolInput) } };
    if (tool === 'apply_patch') { mapped.action_type = 'review'; mapped.risk_score = 40; mapped.summary.classification_status = 'incomplete'; }
  } else {
    mapped = genericContext(tool, input, config.captureToolInput);
    goal = `${tool}: ${canonicalJson(summarizeToolInput(input)).slice(0, 120)}`;
  }
  if (goal.length > 2000) throw new Error('Tool evidence exceeds declared_goal schema; not truncated');
  const { summary, reversible, ...fields } = mapped;
  const signal = autonomySignal(data, config);
  const context = { ...fields, ...(typeof reversible === 'boolean' ? { reversible } : {}), agent_id: config.agentId, declared_goal: goal,
    runtime_session_id: deriveSessionId(data, config), tool_use_id: deriveToolUseId(data), tool_input_digest: toolInputDigest(tool, input),
    runtime_family: 'tool_hook_runtime', adapter_mode: 'hook', install_channel: config.installChannel, settings_scope: config.settingsScope,
    trusted_project_required: config.trustedProjectRequired === true, ...signal,
    input_summary: JSON.stringify({ ...summary, ...signal, runtime_adapter_id: config.runtimeId, runtime_family: 'tool_hook_runtime', adapter_mode: 'hook' }) };
  if (context.input_summary.length > 4000 || context.tool_use_id.length > 128 || !safeId(context.tool_use_id)) throw new Error('Tool evidence exceeds action schema; not truncated');
  if (config.installCheck) context.health_check = true;
  return context;
}
