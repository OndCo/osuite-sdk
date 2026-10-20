import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function renderNodeRuntime() {
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: "export { runHookCli } from './sdk/runtime/hook.mjs';\nexport { runMcpCli } from './sdk/runtime/mcp.mjs';", resolveDir: root, sourcefile: 'osuite-plugin-runtime-entry.mjs' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node18',
    legalComments: 'none', logLevel: 'silent',
    banner: { js: '// Generated from sdk/runtime by hooks/build-node-runtime.mjs. Do not edit this distribution file.' },
  });
  return result.outputFiles[0].text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  writeFileSync(new URL('./osuite_runtime.mjs', import.meta.url), await renderNodeRuntime());
}
