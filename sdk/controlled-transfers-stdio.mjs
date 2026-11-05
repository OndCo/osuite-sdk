import { createControlledTransferMcpServer } from './controlled-transfers/mcp.mjs';
import { CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES as MAX_FRAME_BYTES } from './controlled-transfers/contract.mjs';

const MAX_BUFFER_BYTES = 2 * MAX_FRAME_BYTES;

export async function runControlledTransferStdio(config, { input = process.stdin, output = process.stdout } = {}) {
  const server = createControlledTransferMcpServer(config);
  const write = payload => new Promise((resolve, reject) => {
    if (payload === null) { resolve(); return; }
    output.write(`${JSON.stringify(payload)}\n`, error => error ? reject(error) : resolve());
  });
  async function invalid(code, message) {
    await write({ jsonrpc: '2.0', id: null, error: { code, message } });
    return false;
  }
  async function dispatch(frame) {
    if (frame.length > MAX_FRAME_BYTES) return invalid(-32600, 'Frame too large');
    let request;
    try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
    catch { return invalid(-32700, 'Parse error'); }
    await write(await server.handleRequest(request));
    return true;
  }
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    if (buffer.length + chunk.length > MAX_BUFFER_BYTES) return invalid(-32600, 'Input buffer limit exceeded');
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    // Await each request and output before consuming the next frame; no background mutation queue.
    while ((end = buffer.indexOf(10)) !== -1) {
      const frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (!await dispatch(frame)) return false;
    }
    if (buffer.length > MAX_FRAME_BYTES) return invalid(-32600, 'Frame too large');
  }
  return buffer.length ? dispatch(buffer) : true;
}
