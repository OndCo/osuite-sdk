import { createGovernedTools } from '../executor.mjs';
import { recoveryBindings, namespace, operationId, params } from './native-recovery.fixture.mjs';

const inbox = [], waiters = [];
process.on('message', message => {
  const index = waiters.findIndex(item => item.type === message.type);
  if (index < 0) inbox.push(message);
  else waiters.splice(index, 1)[0].resolve(message);
});
const command = type => {
  const index = inbox.findIndex(message => message.type === type);
  return index < 0 ? new Promise(resolve => waiters.push({ type, resolve })) : Promise.resolve(inbox.splice(index, 1)[0]);
};
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
let tools;
try {
  const { config, journalPath, resourceUrl, mode } = await command('init');
  const bindings = recoveryBindings(resourceUrl, 'settled-absence', {
    async afterExecute(result) {
      await send({ type: 'effect', result });
      if (mode === 'crash') process.exit(73);
      if (mode === 'pause') await command('release');
      return result;
    },
  });
  tools = createGovernedTools({ config, journalPath, namespace, bindings });
  await send({ type: 'ready' }); await command('recover');
  let outcome;
  try { outcome = { ok: true, result: await tools.recover(operationId, params()) }; }
  catch (error) { outcome = { ok: false, code: error.code, retryAutomatically: error.retryAutomatically }; }
  await send({ type: 'outcome', ...outcome, status: await tools.status(operationId) });
} catch (error) {
  await send({ type: 'fatal', message: error.message, code: error.code }); process.exitCode = 1;
} finally { tools?.close(); if (process.connected) process.disconnect(); }
