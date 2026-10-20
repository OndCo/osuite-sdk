import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const inventoryFile = path.join(root, 'source-manifest.json');
const inventoryStat = fs.lstatSync(inventoryFile);
if (!inventoryStat.isFile() || inventoryStat.isSymbolicLink() || inventoryStat.nlink !== 1 || inventoryStat.size > 2_000_000) throw new Error('Unsafe source inventory file.');
const manifest = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid source inventory.');
const expected = new Set(), folded = new Set();
for (const file of manifest.files) {
  if (typeof file?.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0
      || ![0o644, 0o755].includes(file.mode) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || file.path.split('/').some(part => !part || part === '..' || part === '.')
      || file.path.includes('\\') || path.isAbsolute(file.path) || folded.has(file.path.toLowerCase())) throw new Error('Unsafe or duplicate inventory path.');
  expected.add(file.path); folded.add(file.path.toLowerCase());
  const location = path.join(root, file.path);
  let current = root;
  for (const part of file.path.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink: ${file.path}`);
  }
  const stat = fs.statSync(location);
  if (!stat.isFile() || stat.nlink !== 1 || process.platform !== 'win32' && (stat.mode & 0o777) !== file.mode) throw new Error(`Unsafe file or mode: ${file.path}`);
  const bytes = fs.readFileSync(location);
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Changed source: ${file.path}`);
}
function walk(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!prefix && ['.git', 'node_modules', 'output'].includes(entry.name)) continue;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(path.join(directory, entry.name), `${name}/`);
    else if (name !== 'source-manifest.json' && !expected.has(name)) throw new Error(`Unreviewed file: ${name}`);
  }
}
walk(root);
console.log(`Verified ${manifest.files.length} explicit source files. This inventory is not a publisher signature.`);
