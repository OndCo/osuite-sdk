import { loadRuntimeConfig } from './config.mjs';
import { deny, readHookInput, runHook } from './hook.mjs';
import { isObject, safeId } from './protocol.mjs';

const EVENTS = {
  preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure',
  sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', stop: 'Stop',
};
const toolEvents = new Set(['preToolUse', 'postToolUse', 'postToolUseFailure']);

export function normalizeCursorInput(data) {
  if (!isObject(data) || !Object.hasOwn(EVENTS, data.hook_event_name)) throw new Error('Unsupported Cursor hook event');
  const session = data.conversation_id;
  if (!safeId(session) || session.length > 128 || (data.session_id !== undefined && data.session_id !== session)) {
    throw new Error('Invalid Cursor conversation identity');
  }
  const normalized = { hook_event_name: EVENTS[data.hook_event_name], session_id: session };
  if (!toolEvents.has(data.hook_event_name)) return normalized;
  if (!safeId(data.tool_use_id) || data.tool_use_id.length > 128 || typeof data.tool_name !== 'string'
      || !data.tool_name || data.tool_name.length > 128 || !isObject(data.tool_input)
      || typeof data.cwd !== 'string' || !data.cwd || data.cwd.includes('\0')) throw new Error('Invalid Cursor tool evidence');
  Object.assign(normalized, { cwd: data.cwd, tool_name: data.tool_name, tool_use_id: data.tool_use_id, tool_input: data.tool_input });
  if (data.hook_event_name === 'postToolUseFailure') {
    if (!['timeout', 'error', 'permission_denied'].includes(data.failure_type) || typeof data.error_message !== 'string') {
      throw new Error('Invalid Cursor failure evidence');
    }
    normalized.tool_response = { isError: true };
  } else if (data.hook_event_name === 'postToolUse' && typeof data.tool_output === 'string') {
    // Cursor documents a JSON-serialized result here, unlike Codex's arbitrary
    // text response. Never inspect stdout or another nested output as metadata.
    let result;
    try { result = JSON.parse(data.tool_output); } catch { return normalized; }
    if (data.tool_name === 'Shell' && isObject(result) && Number.isSafeInteger(result.exitCode)
        && !result.backgroundTaskId && !result.background_task_id && !result.session_id
        && data.tool_input.run_in_background !== true) {
      const error = result.error || result.isError === true || result.is_error === true || result.interrupted === true;
      normalized.tool_response = { exit_code: result.exitCode, ...(error ? { isError: true } : {}) };
    }
  }
  return normalized;
}

function cursorReply(event, result) {
  const message = result.stdout?.systemMessage || result.stdout?.reason || result.stderr || '';
  if (event === 'preToolUse') {
    const blocked = result.exitCode !== 0;
    // Cursor's user/agent messages are deny-only. Keep allowed-mode notices in
    // hook logs too, without claiming that the host displays them to the user.
    return { exitCode: blocked ? 2 : 0, stdout: { permission: blocked ? 'deny' : 'allow',
      ...(message ? { user_message: message, agent_message: message } : {}) }, stderr: result.stderr || (!blocked ? message : '') };
  }
  // A stop follow-up is an automatic new user turn in Cursor, not a notice.
  if (event === 'stop' || event === 'sessionEnd') return { exitCode: 0, stdout: {}, stderr: message };
  return { exitCode: 0, stdout: message ? { additional_context: message } : {}, stderr: result.stderr || '' };
}

export async function runCursorHook(data, config, dependencies = {}) {
  const event = Object.hasOwn(EVENTS, data?.hook_event_name) ? data.hook_event_name : 'preToolUse';
  try {
    return cursorReply(event, await runHook(normalizeCursorInput(data), { ...config, host: 'cursor' }, dependencies));
  } catch {
    return cursorReply(event, event === 'preToolUse' ? deny('Invalid Cursor hook evidence. No execution was authorized.')
      : { exitCode: 0, stdout: {}, stderr: '[OSuite] Cursor evidence was not recorded; no completion is claimed.' });
  }
}

export async function runCursorHookCli({ installDir, event = 'preToolUse' } = {}) {
  let result;
  try {
    const data = await readHookInput();
    const allowed = event === 'postToolUse' ? ['postToolUse', 'postToolUseFailure']
      : event === 'sessionStart' ? ['sessionStart', 'sessionEnd'] : [event];
    if (data.hook_event_name && !allowed.includes(data.hook_event_name)) throw new Error('Unexpected Cursor hook event');
    data.hook_event_name ||= event;
    result = await runCursorHook(data, loadRuntimeConfig({ host: 'cursor', runtimeId: 'cursor_hooks', installDir }));
  } catch {
    result = cursorReply(event, event === 'preToolUse' ? deny('Invalid Cursor hook input. No execution was authorized.')
      : { exitCode: 0, stdout: {}, stderr: '[OSuite] Cursor event was not processed; no completion is claimed.' });
  }
  process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}
