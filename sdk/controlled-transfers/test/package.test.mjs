import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('../../', import.meta.url));

test('the entry is an additive ESM package export and preserves ordinary SDK entry points', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports['./controlled-transfers'], { import: './controlled-transfers.mjs' });
  assert.deepEqual(pkg.exports['.'], { import: './osuite.js', require: './index.cjs' });
  assert.deepEqual(pkg.exports['./legacy'], { import: './legacy/osuite-v1.js', require: './legacy/index-v1.cjs' });
  assert.deepEqual(pkg.exports['./governed-tools'], { import: './governed-tools.mjs' });
  assert.equal(pkg.engines.node, '>=18.0.0');
  assert.deepEqual(pkg.dependencies, {});
  for (const file of ['controlled-transfers.mjs', 'controlled-transfers-stdio.mjs', 'controlled-transfers/*.mjs', 'CONTROLLED_TRANSFERS.md', 'matoiDoctor.mjs']) {
    assert.ok(pkg.files.includes(file), `package must include ${file}`);
  }
  const entry = await import('osuite/controlled-transfers');
  assert.equal(typeof entry.createControlledTransfers, 'function');
  assert.equal(typeof entry.ControlledTransferError, 'function');
  assert.equal(typeof entry.createControlledTransferMcpServer, 'function');
  assert.equal(entry.CONTROLLED_TRANSFER_PROFILE, 'matoi.controlled-transfer.v1');
});

test('npm pack dry-run contains all new runtime modules and doctor but excludes contract tests', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], {
    cwd: sdk, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, npm_config_update_notifier: 'false' },
  });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  for (const file of ['controlled-transfers.mjs', 'controlled-transfers-stdio.mjs', 'controlled-transfers/cli-config.mjs', 'controlled-transfers/client.mjs', 'controlled-transfers/contract.mjs',
    'controlled-transfers/verification.mjs', 'controlled-transfers/mcp.mjs', 'controlled-transfers/projection.mjs',
    'matoiDoctor.mjs', 'CONTROLLED_TRANSFERS.md', 'runtime/protocol.mjs']) {
    assert.ok(files.includes(file), `packed SDK must include ${file}`);
  }
  assert.ok(!files.some(file => file.startsWith('controlled-transfers/test/')));
});

test('Node 24 is required only for the new client and does not change ordinary SDK import compatibility', () => {
  const node22 = '/Users/jw/.nvm/versions/node/v22.18.0/bin/node';
  if (!existsSync(node22)) return;
  const entry = new URL('../../controlled-transfers.mjs', import.meta.url).href;
  const ordinary = new URL('../../osuite.js', import.meta.url).href;
  const result = spawnSync(node22, ['--input-type=module', '-e', `
    const { OSuite } = await import(${JSON.stringify(ordinary)});
    const { createControlledTransfers } = await import(${JSON.stringify(entry)});
    try { createControlledTransfers({ config: {} }); process.exitCode = 1; }
    catch (error) { console.log(typeof OSuite, error.code); }
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'function NODE_24_REQUIRED');
});
