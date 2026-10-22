import { types } from 'node:util';
import { safeId } from '../runtime/protocol.mjs';
import { GovernedToolError, jsonSnapshot, reject } from './contract.mjs';

const boundedId = value => safeId(value) && value.length <= 128;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

function method(receiver, name) {
  // SDK class methods may be inherited; never invoke getters or proxy traps.
  let current = receiver;
  for (let depth = 0; current != null && depth < 16; depth++) {
    if (!['object', 'function'].includes(typeof current) || types.isProxy(current)) reject('INVALID_CONFIGURATION');
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
          || types.isProxy(descriptor.value)) reject('INVALID_CONFIGURATION');
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  reject('INVALID_CONFIGURATION');
}

function paramsSnapshot(params) {
  const native = jsonSnapshot(params, 32768);
  if (!native || typeof native !== 'object' || Array.isArray(native)
      || !Object.hasOwn(native, 'name') || !boundedId(native.name) || !Object.hasOwn(native, 'arguments')
      || !native.arguments || typeof native.arguments !== 'object' || Array.isArray(native.arguments)
      || Object.keys(native).some(key => key !== 'name' && key !== 'arguments')) reject('INVALID_INPUT');
  return native;
}

function isAborted(signal) {
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)) reject('INVALID_OPTIONS');
  // Use the native brand check rather than reading caller-controlled .aborted.
  try { return Reflect.apply(signalAborted, signal, []); } catch { reject('INVALID_OPTIONS'); }
}

function optionsSnapshot(options) {
  if (options === undefined) return undefined;
  if (!options || typeof options !== 'object' || types.isProxy(options)) reject('INVALID_OPTIONS');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) reject('INVALID_OPTIONS');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const safeOptions = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if ((key !== 'signal' && key !== 'timeout') || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) reject('INVALID_OPTIONS');
    const value = descriptor.value;
    if (key === 'signal') isAborted(value);
    else if (!Number.isInteger(value) || value < 1 || value > 30000) reject('INVALID_OPTIONS');
    safeOptions[key] = value;
  }
  return Object.freeze(safeOptions);
}

function coordinatorError(error) {
  let governed = false;
  try { governed = !types.isProxy(error) && error instanceof GovernedToolError; } catch { /* Untrusted thrown values stay opaque. */ }
  if (governed) throw error;
  reject('UNCERTAIN');
}

// Bounded MCP profile: required record arguments and safeId tool names (1..128, no '..').
// Not arbitrary all-MCP compatibility; covers only wrapped calls, not a production gateway.
export function wrapMcpClient(client, tools) {
  const originalCallTool = method(client, 'callTool');
  const originalRun = method(tools, 'run');
  const originalStatus = method(tools, 'status');
  return Object.freeze({
    operation(operationId) {
      if (!boundedId(operationId)) reject('INVALID_OPERATION_ID');
      return Object.freeze({
        async callTool(params, resultSchema, options) {
          const native = paramsSnapshot(params);
          const safeOptions = optionsSnapshot(options);
          const signal = safeOptions?.signal;
          if (signal && isAborted(signal)) reject('ABORTED');
          // Native timeout is not the coordinator's approval wait budget.
          const runOptions = Object.freeze(signal ? { signal } : {});
          try {
            return await Reflect.apply(originalRun, tools, [operationId, native,
              p => Reflect.apply(originalCallTool, client, [p, resultSchema, safeOptions]), runOptions]);
          } catch (error) { coordinatorError(error); }
        },
      });
    },
    async status(operationId) {
      if (!boundedId(operationId)) reject('INVALID_OPERATION_ID');
      try { return await Reflect.apply(originalStatus, tools, [operationId]); }
      catch (error) { coordinatorError(error); }
    },
  });
}
