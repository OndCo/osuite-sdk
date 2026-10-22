import { createGovernedTools } from '../executor.mjs';
import { bindings, params } from './studio.fixture.mjs';

const commands = [], waiting = [];
process.on('message', message => {
  const index = waiting.findIndex(item => item.type === message.type);
  if (index === -1) commands.push(message);
  else waiting.splice(index, 1)[0].resolve(message);
});

function command(type) {
  const index = commands.findIndex(message => message.type === type);
  if (index !== -1) return Promise.resolve(commands.splice(index, 1)[0]);
  return new Promise(resolve => { waiting.push({ type, resolve }); });
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.send({ ...message, pid: process.pid }, error => error ? reject(error) : resolve());
  });
}

function errorRecord(error) {
  return { name: error.name, code: error.code ?? null, message: error.message,
    status: error.status ?? null, retryAutomatically: error.retryAutomatically ?? null };
}

let tools;
try {
  await send({ type: 'booted', nodeVersion: process.versions.node });
  const { config, journalPath, namespace, operationId, mode } = await command('init');
  if (!['normal', 'pause-after-effect', 'exit-after-effect'].includes(mode)) throw new Error('invalid child fixture mode');
  tools = createGovernedTools({ config, journalPath, namespace, bindings, initializeJournal: false });
  await send({ type: 'ready', journalPath, operationId });
  await command('run');
  let nativeCalls = 0;
  const execute = async native => {
    nativeCalls++;
    if (!Object.isFrozen(native) || !Object.isFrozen(native.arguments)) throw new Error('expected frozen native input');
    const response = await fetch(config.baseUrl + '/resource', { method: 'POST', body: JSON.stringify(native) });
    if (!response.ok) throw new Error('native HTTP write failed');
    const result = await response.json();
    await send({ type: 'effect', result, nativeCalls });
    // Both fault boundaries are inside execute: no settle or outcome report has run.
    if (mode === 'exit-after-effect') process.exit(73);
    if (mode === 'pause-after-effect') await command('release');
    return result;
  };
  let outcome;
  try { outcome = { ok: true, result: await tools.run(operationId, params(), execute) }; }
  catch (error) { outcome = { ok: false, error: errorRecord(error) }; }
  await send({ type: 'outcome', ...outcome, nativeCalls, status: await tools.status(operationId) });
} catch (error) {
  await send({ type: 'fatal', error: errorRecord(error) });
  process.exitCode = 1;
} finally {
  tools?.close();
  if (process.connected) process.disconnect();
}
