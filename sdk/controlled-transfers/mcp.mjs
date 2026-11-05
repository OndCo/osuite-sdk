import { createControlledTransfers } from './client.mjs';
import { CONTROLLED_TRANSFER_PROFILE as PROFILE, ControlledTransferError, fail,
  identifier, record, snapshot } from './contract.mjs';
import { snapshotWithProjection } from './projection.mjs';

const instructions = 'Only the Matoi controlled-ledger transfer profile is covered, not arbitrary MCP tools or direct resource access. '
  + 'Financial transfers require native Studio review on the slow-approved route. Preparation and status never execute. '
  + 'Do not auto-approve or resend mutations. OUTCOME_UNKNOWN requires status-only recovery with the original operation ID. '
  + 'Projection freshness describes only the derived evidence view, never execution authority. '
  + 'A pending, stale, failed or unavailable view does not invalidate a verified receipt or permit resending.';
const idSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$' };
const tool = (name, description, properties, required, readOnly = false) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: name === 'osuite_transfer_execute', idempotentHint: readOnly } });
const tools = snapshot([
  tool('osuite_transfer_prepare', 'Prepare one signed controlled-ledger transfer operation for native Studio review. Never executes or approves.',
    { operationId: idSchema, grantId: idSchema }, ['operationId', 'grantId']),
  tool('osuite_transfer_execute', 'Explicitly request one ordinal of the exact signed preparation. The server enforces native approval; never retry automatically.',
    { prepared: { type: 'object', description: 'The unchanged signed preparation returned by prepare or verified status recovery.' },
      ordinal: { type: 'integer', minimum: 0, maximum: 63, default: 0 } }, ['prepared']),
  tool('osuite_transfer_status', 'Read the original operation and verify available signed evidence. No preparation, approval, execution or automatic retry.',
    { operationId: idSchema }, ['operationId'], true),
]);

const preparationFields = ['profile', 'operationId', 'grantId', 'preparationDigest', 'actionId', 'fingerprint',
  'lease', 'effects', 'state', 'code', 'reviewUrl', 'retryAutomatically'];
const publicFields = [...preparationFields, 'receipt', 'newlyCommitted', 'lastDenial', 'reason', 'httpStatus', 'recovery'];
const effectFields = ['operation', 'paymentId', 'sourceAccount', 'destination', 'asset', 'network', 'amountMinor', 'decimals'];
function select(value, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function publicResult(value, executing) {
  // Do not echo configuration, arbitrary server metadata or caller arguments into the model context.
  const result = select(value, publicFields);
  if (value.effects) result.effects = value.effects.map(effect => select(effect, effect.operation === 'transfer'
    ? effectFields : ['ordinal', 'paymentId', 'state', 'receipt', 'receiptVerified']));
  if (value.prepared) result.prepared = select(value.prepared, preparationFields);
  result.effect_executed = value.state === 'unknown' || value.code === 'OUTCOME_UNKNOWN'
    ? null : executing && value.state === 'committed' && value.newlyCommitted === true;
  result.retryAutomatically = false;
  return snapshotWithProjection({ ...result, projection: value.projection });
}

function response(value, executing = false) {
  const data = publicResult(value, executing);
  return Object.freeze({ content: Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(data) })]),
    structuredContent: data, ...(['denied', 'unknown', 'rejected'].includes(data.state) ? { isError: true } : {}) });
}

export function createControlledTransferMcpServer(config) {
  const client = createControlledTransfers({ config });

  async function callTool(name, args = {}) {
    try {
      const definition = tools.find(item => item.name === name);
      if (!definition) fail('UNKNOWN_TOOL');
      args = snapshot(args, 'INVALID_TOOL_ARGUMENTS');
      if (!record(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))
        || definition.inputSchema.required.some(key => !Object.hasOwn(args, key))) fail('INVALID_TOOL_ARGUMENTS');
      if (name === 'osuite_transfer_execute') {
        if (!record(args.prepared)) fail('INVALID_PREPARATION');
        return response(await client.execute(args.prepared, args.ordinal), true);
      }
      if (!identifier(args.operationId)) fail('INVALID_OPERATION_ID');
      if (name === 'osuite_transfer_prepare') {
        if (!identifier(args.grantId)) fail('INVALID_GRANT_ID');
        return response(await client.prepare(args.operationId, args.grantId));
      }
      return response(await client.status(args.operationId));
    } catch (error) {
      const known = error instanceof ControlledTransferError;
      const code = known ? error.code : 'REQUEST_FAILED';
      return response({ profile: PROFILE, operationId: known ? error.operationId : null,
        state: code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'rejected', code, newlyCommitted: false,
        ...(known ? { reason: error.reason, httpStatus: error.httpStatus, recovery: error.recovery } : {}) });
    }
  }

  const listTools = () => Object.freeze({ tools });
  async function handleRequest(input) {
    let request;
    try { request = snapshot(input, 'INVALID_REQUEST'); } catch { /* Return a protocol error without echoing input. */ }
    if (!record(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || (Object.hasOwn(request, 'id') && request.id !== null && typeof request.id !== 'string' && !Number.isSafeInteger(request.id))) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (!Object.hasOwn(request, 'id')) return null;
    const envelope = { jsonrpc: '2.0', id: request.id };
    if (request.method === 'initialize') return { ...envelope, result: {
      protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(request.params?.protocolVersion)
        ? request.params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} }, serverInfo: { name: 'osuite_controlled_transfers', version: '1' }, instructions,
    } };
    if (request.method === 'ping') return { ...envelope, result: {} };
    if (request.method === 'tools/list') return { ...envelope, result: listTools() };
    if (request.method === 'tools/call') return { ...envelope,
      result: await callTool(request.params?.name, request.params?.arguments ?? {}) };
    return { ...envelope, error: { code: -32601, message: 'Method not found' } };
  }

  return Object.freeze({ tools, listTools, callTool, handleRequest });
}
