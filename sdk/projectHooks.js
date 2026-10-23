// Project hook install and verification for `osuite connect`, `osuite init` and `osuite doctor`.
// Settings files are merged, never replaced: most projects already have them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK_SCRIPT_RE = /osuite_(?:pretool|posttool|stop|session)\.(?:py|mjs)/;

export const RUNTIME_HOOKS = {
  claude: {
    label: 'Claude Code',
    dir: '.claude',
    settings: ['.claude/settings.json', '.claude/settings.local.json'],
  },
  codex: {
    label: 'Codex',
    dir: '.codex',
    settings: ['.codex/hooks.json'],
    config: '.codex/config.toml',
  },
  cursor: {
    label: 'Cursor', dir: '.cursor', settings: ['.cursor/hooks.json'],
    preEvent: 'preToolUse', postEvent: 'postToolUse', flatHooks: true,
  },
};

const MERGED_FILES = {
  '.claude/settings.json': 'json',
  '.claude/settings.local.json': 'json',
  '.codex/hooks.json': 'json',
  '.codex/config.toml': 'toml',
  '.mcp.json': 'mcp',
  '.cursor/hooks.json': 'cursor-hooks',
  '.cursor/mcp.json': 'mcp',
};

export const DOCTOR_COMMAND = 'echo "OSuite doctor hook check"';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hookScriptName(command) {
  const match = String(command || '').match(HOOK_SCRIPT_RE);
  return match ? match[0] : '';
}

// An OSuite hook already in the file counts as present even when its path differs,
// so a re-run never registers a second copy that would govern each call twice.
function sameHook(existing, wanted) {
  const existingScript = hookScriptName(existing?.command);
  const wantedScript = hookScriptName(wanted?.command);
  if (existingScript && wantedScript) return existingScript.replace(/\.(py|mjs)$/, '') === wantedScript.replace(/\.(py|mjs)$/, '');
  return String(existing?.command || '').trim() === String(wanted?.command || '').trim();
}

function countHooks(hooks) {
  if (!isPlainObject(hooks)) return 0;
  return Object.values(hooks).reduce((total, groups) => total + (Array.isArray(groups)
    ? groups.reduce((sum, group) => sum + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0)
    : 0), 0);
}

function templateHooks(template) {
  const hooks = isPlainObject(template?.hooks) ? template.hooks : {};
  return Object.entries(hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : [])
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])
      .map((hook) => ({ event, matcher: group.matcher, command: hook.command }))));
}

function disabledHookSettings(settings) {
  return settings?.disableAllHooks === true
    ? ['disableAllHooks = true keeps hooks disabled; intentional disablement was preserved']
    : [];
}

/**
 * Add the OSuite PreToolUse/PostToolUse entries to a JSON settings file.
 * The user's own hooks and every other key stay as they are.
 */
export function mergeHookSettings(existingText, templateText) {
  const template = JSON.parse(templateText);
  if (existingText === null || existingText === undefined) {
    return { status: 'created', body: templateText, added: templateHooks(template), keptHooks: 0, keptKeys: [], conflicts: disabledHookSettings(template) };
  }

  let settings = {};
  if (existingText.trim()) {
    try {
      settings = JSON.parse(existingText);
    } catch (error) {
      return { status: 'error', error: `not valid JSON (${error.message})` };
    }
  }
  if (!isPlainObject(settings)) return { status: 'error', error: 'expected a JSON object at the top level' };

  let hooks = settings.hooks;
  if (hooks === undefined || hooks === null || (Array.isArray(hooks) && hooks.length === 0)) hooks = {};
  if (!isPlainObject(hooks)) return { status: 'error', error: '"hooks" must be an object keyed by event name' };

  const wanted = isPlainObject(template.hooks) ? template.hooks : {};
  const merged = { ...hooks };
  const added = [];
  const migrated = [];
  const migrationConflicts = [];
  for (const [event, groups] of Object.entries(wanted)) {
    const current = merged[event] === undefined ? [] : merged[event];
    if (!Array.isArray(current)) return { status: 'error', error: `"hooks.${event}" must be a list` };
    const requested = (Array.isArray(groups) ? groups : []).flatMap(group => group.hooks || []);
    const next = current.map(group => ({ ...group, hooks: (group.hooks || []).map(existing => {
      const replacement = requested.find(hook => sameHook(existing, hook));
      if (!replacement || !hookScriptName(existing.command).endsWith('.py') || !hookScriptName(replacement.command).endsWith('.mjs')) return existing;
      const script = hookScriptName(existing.command);
      const stock = [`python3 .claude/hooks/${script}`, `python3 .codex/hooks/${script}`,
        `python3 "$(git rev-parse --show-toplevel)/.codex/hooks/${script}"`];
      if (!stock.includes(existing.command)) {
        migrationConflicts.push(`custom legacy ${script} command was preserved; review its Node migration before relying on this installation`);
        return existing;
      }
      migrated.push({ event, matcher: group.matcher, command: replacement.command });
      // Migrating a stock command is not consent to change its host failure policy.
      const runtimeReplacement = { ...replacement };
      delete runtimeReplacement.onFailure;
      return { ...existing, ...runtimeReplacement };
    }) }));
    const present = next.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []));
    for (const group of Array.isArray(groups) ? groups : []) {
      const missing = (group.hooks || []).filter((hook) => !present.some((existing) => sameHook(existing, hook)));
      if (!missing.length) continue;
      next.push({ ...group, hooks: missing });
      missing.forEach((hook) => added.push({ event, matcher: group.matcher, command: hook.command }));
    }
    if (next.length !== current.length || migrated.some(item => item.event === event)) merged[event] = next;
  }

  const result = {
    added, migrated,
    keptHooks: countHooks(hooks),
    keptKeys: Object.keys(settings).filter((key) => key !== 'hooks'),
    conflicts: [...disabledHookSettings(settings), ...migrationConflicts],
  };
  if (!added.length && !migrated.length) return { ...result, status: 'unchanged', body: existingText };
  return { ...result, status: 'merged', body: `${JSON.stringify({ ...settings, hooks: merged }, null, 2)}\n` };
}

function mergeMcpSettings(existingText, templateText) {
  const template = JSON.parse(templateText);
  const existing = existingText ? JSON.parse(existingText) : {};
  if (!isPlainObject(existing) || (existing.mcpServers !== undefined && !isPlainObject(existing.mcpServers))) return { status: 'error', error: 'expected an MCP configuration object' };
  const servers = { ...(existing.mcpServers || {}) };
  const added = [], conflicts = [];
  for (const [name, server] of Object.entries(template.mcpServers || {})) {
    if (servers[name] && JSON.stringify(servers[name]) !== JSON.stringify(server)) {
      conflicts.push(`${name} MCP registration differs; it was preserved for explicit operator review`);
    } else if (!servers[name]) { servers[name] = server; added.push(name); }
  }
  return { status: existingText == null ? 'created' : added.length ? 'merged' : 'unchanged', added, conflicts,
    body: added.length || existingText == null ? `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n` : existingText };
}

export function mergeCursorHookSettings(existingText, templateText) {
  const template = JSON.parse(templateText);
  const existing = existingText == null ? { version: 1, hooks: {} } : JSON.parse(existingText);
  if (!isPlainObject(existing) || existing.version !== 1 || !isPlainObject(existing.hooks ?? {})) {
    return { status: 'error', error: 'Cursor hooks require version 1 and a hooks object; existing configuration was preserved' };
  }
  const hooks = { ...(existing.hooks || {}) }, added = [], conflicts = [...disabledHookSettings(existing)];
  for (const [event, handlers] of Object.entries(hooks)) {
    if (!Array.isArray(handlers)) return { status: 'error', error: `hooks.${event} must be a list; existing configuration was preserved` };
  }
  // Cursor does not document this flag. Do not rely on it to suppress newly
  // added hooks when preserving an operator's explicit disablement intent.
  if (existing.disableAllHooks === true) return { status: 'unchanged', body: existingText, added: [],
    conflicts: ['Existing disableAllHooks intent was preserved; no Cursor hook registrations were added'],
    keptHooks: Object.values(hooks).reduce((count, handlers) => count + handlers.length, 0),
    keptKeys: Object.keys(existing).filter(key => key !== 'hooks') };
  for (const [event, handlers] of Object.entries(template.hooks)) {
    const next = [...(hooks[event] || [])];
    for (const handler of handlers) {
      const present = next.find(current => sameHook(current, handler));
      if (!present) { next.push(handler); added.push({ event, ...handler }); }
      else if (present.command !== handler.command || present.enabled === false || present.disabled === true || !['command', undefined].includes(present.type)
          || (event === 'preToolUse' && (present.failClosed !== true || !['', '*', undefined].includes(present.matcher)))) {
        conflicts.push(`custom Cursor ${event} command or safety flags were preserved; review before relying on this installation`);
      }
    }
    hooks[event] = next;
  }
  return { status: existingText == null ? 'created' : added.length ? 'merged' : 'unchanged', added, conflicts,
    keptHooks: Object.values(existing.hooks || {}).reduce((count, handlers) => count + handlers.length, 0),
    keptKeys: Object.keys(existing).filter(key => key !== 'hooks'),
    body: existingText == null || added.length ? `${JSON.stringify({ ...existing, hooks }, null, 2)}\n` : existingText };
}

function packagedRuntimeFiles(directory) {
  const source = fileURLToPath(new URL('./runtime/', import.meta.url));
  return Object.fromEntries(fs.readdirSync(source).sort().filter(name => /^[a-zA-Z0-9-]+\.mjs$/.test(name))
    .map(name => [`${directory}/runtime/${name}`, fs.readFileSync(path.join(source, name), 'utf8')]));
}

function buildCursorBootstrap(bootstrap) {
  const files = { ...bootstrap.files, ...packagedRuntimeFiles('.cursor') };
  const events = { preToolUse: 'pretool', postToolUse: 'posttool', sessionStart: 'session', stop: 'stop' };
  const hooks = {};
  for (const [event, script] of Object.entries(events)) {
    files[`.cursor/hooks/osuite_${script}.mjs`] = `#!/usr/bin/env node\nimport { fileURLToPath } from 'node:url';\nimport { runCursorHookCli } from '../runtime/cursor.mjs';\nawait runCursorHookCli({ installDir: fileURLToPath(new URL('..', import.meta.url)), event: ${JSON.stringify(event)} });\n`;
    hooks[event] = [{ command: `node .cursor/hooks/osuite_${script}.mjs`, timeout: 60, ...(event === 'preToolUse' ? { failClosed: true } : {}) }];
  }
  hooks.postToolUseFailure = hooks.postToolUse;
  hooks.sessionEnd = hooks.sessionStart;
  files['.cursor/hooks.json'] = `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
  files['.cursor/server/osuite_runtime_mcp.mjs'] = "#!/usr/bin/env node\nimport { fileURLToPath } from 'node:url';\nimport { runMcpCli } from '../runtime/mcp.mjs';\nawait runMcpCli({ host: 'cursor', runtimeId: 'cursor_hooks', installDir: fileURLToPath(new URL('..', import.meta.url)) });\n";
  files['.cursor/mcp.json'] = `${JSON.stringify({ mcpServers: { osuite_runtime_governance: {
    type: 'stdio', command: 'node', args: ['${workspaceFolder}/.cursor/server/osuite_runtime_mcp.mjs'],
  } } }, null, 2)}\n`;
  files['.cursor/README.node-runtime.md'] = '# OSuite Cursor Node runtime\n\nNode.js 18+; no Python or runtime dependency installation.\nProject hooks run from the project root in a trusted workspace. Preserve explicit disabled settings.\nGeneric Agent hooks are installed, not Tab hooks. Session start does not block; every preflight refreshes verified posture.\nThe MCP bridge is advisory and does not execute upstream tools.\nDirect diagnostics and wire fixtures do not establish native host invocation or all-action coverage.\n';
  return { ...bootstrap, files, runtime: { ...bootstrap.runtime, id: 'cursor_hooks', implementation: 'node', implementation_version: 1 },
    node_runtime: { schema_version: 'osuite.node_runtime.v1', minimum_node_major: 18, settings_path: '.cursor/hooks.json', requires_host_trust_review: true } };
}

/** Locally packaged, dependency-free runtime code replaces downloaded legacy launchers. */
export function buildNodeRuntimeBootstrap(runtime, bootstrap = {}, { projectRoot = process.cwd() } = {}) {
  if (['cursor', 'cursor_hooks'].includes(runtime)) return buildCursorBootstrap(bootstrap);
  const host = ['claude', 'claude-code', 'claude_code_hooks'].includes(runtime) ? 'claude'
    : ['codex', 'codex_hooks'].includes(runtime) ? 'codex' : null;
  if (!host) throw new Error('Node bootstrap supports Claude Code, Codex and Cursor project hooks only');
  const directory = host === 'claude' ? '.claude' : '.codex';
  const runtimeId = host === 'claude' ? 'claude_code_hooks' : 'codex_hooks';
  const files = Object.fromEntries(Object.entries(bootstrap.files || {}).filter(([name]) => !/osuite_(pretool|posttool|stop)\.py$/.test(name)
    && !['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.codex/config.toml'].includes(name)));
  Object.assign(files, packagedRuntimeFiles(directory));
  const literal = value => JSON.stringify(value);
  const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
  const events = { PreToolUse: 'pretool', PostToolUse: 'posttool', SessionStart: 'session', Stop: 'stop' };
  const settings = { hooks: {} };
  for (const [event, script] of Object.entries(events)) {
    files[`${directory}/hooks/osuite_${script}.mjs`] = `#!/usr/bin/env node\nimport { fileURLToPath } from 'node:url';\nimport { runHookCli } from '../runtime/hook.mjs';\nawait runHookCli({ host: ${literal(host)}, runtimeId: ${literal(runtimeId)}, installDir: fileURLToPath(new URL('..', import.meta.url)), event: ${literal(event)} });\n`;
    const absolute = path.join(path.resolve(projectRoot), directory, `hooks/osuite_${script}.mjs`);
    const handler = { type: 'command', command: `node ${shellQuote(absolute)}`, timeout: 60 };
    if (host === 'claude' && event === 'PreToolUse') handler.onFailure = 'block';
    if (host === 'codex') handler.commandWindows = `node "${absolute.replace(/"/g, '""')}"`;
    settings.hooks[event] = [{ hooks: [handler] }];
  }
  if (host === 'claude') settings.hooks.PostToolUseFailure = settings.hooks.PostToolUse;
  let settingsPath = host === 'claude' ? '.claude/settings.json' : '.codex/hooks.json';
  if (host === 'claude') {
    // Do not duplicate an existing registration across project and local layers.
    for (const candidate of ['.claude/settings.json', '.claude/settings.local.json']) {
      try {
        const current = JSON.parse(fs.readFileSync(path.join(projectRoot, candidate), 'utf8'));
        if (Object.values(current.hooks || {}).some(groups => Array.isArray(groups) && groups.some(group => (group.hooks || []).some(hook => HOOK_SCRIPT_RE.test(hook.command || ''))))) { settingsPath = candidate; break; }
      } catch { /* The installer reports malformed settings without overwriting them. */ }
    }
  }
  files[settingsPath] = `${JSON.stringify(settings, null, 2)}\n`;
  files[`${directory}/server/osuite_runtime_mcp.mjs`] = `#!/usr/bin/env node\nimport { fileURLToPath } from 'node:url';\nimport { runMcpCli } from '../runtime/mcp.mjs';\nawait runMcpCli({ host: ${literal(host)}, runtimeId: ${literal(runtimeId)}, installDir: fileURLToPath(new URL('..', import.meta.url)) });\n`;
  const mcpScript = path.join(path.resolve(projectRoot), directory, 'server/osuite_runtime_mcp.mjs');
  if (host === 'claude') files['.mcp.json'] = `${JSON.stringify({ mcpServers: { osuite_runtime_governance: { command: 'node', args: [mcpScript] } } }, null, 2)}\n`;
  else files['.codex/config.toml'] = `[features]\nhooks = true\n\n[mcp_servers.osuite_runtime_governance]\ncommand = "node"\nargs = [${literal(mcpScript)}]\n`;
  files[`${directory}/README.node-runtime.md`] = '# OSuite Node runtime\n\nNode.js 18+ is required. No Python or runtime package installation is used.\nHooks read only this installation\'s .env and the process environment.\nRemote posture is refreshed at session start and preflight; expired enforce configuration blocks.\nReview changed hook definitions in the host. Existing disabled settings are preserved.\nDoctor is a direct diagnostic, not proof that the host has trusted or invoked a hook.\nThe MCP bridge does not execute upstream tools or prevent direct resource access.\n';
  return { ...bootstrap, files, runtime: { ...bootstrap.runtime, implementation: 'node', implementation_version: 1 },
    node_runtime: { schema_version: 'osuite.node_runtime.v1', minimum_node_major: 18, settings_path: settingsPath, requires_host_trust_review: host === 'codex' } };
}

// --- TOML ------------------------------------------------------------------
// Line-based on purpose: the CLI has no dependencies, and the partial only sets
// plain keys. Lines inside multi-line strings and arrays are skipped.

function normalizeTomlKey(raw) {
  return String(raw || '')
    .split('.')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .join('.');
}

function stripTomlValue(raw) {
  const value = String(raw || '').trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  const hash = value.indexOf('#');
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

function withoutStrings(text) {
  return String(text || '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '');
}

function bracketDelta(text) {
  const bare = withoutStrings(text).replace(/#.*$/, '');
  return (bare.match(/[[{]/g) || []).length - (bare.match(/[\]}]/g) || []).length;
}

function parseInlineTable(raw) {
  const inner = withoutStrings(raw).includes('{') ? String(raw).trim().replace(/^\{|\}\s*(#.*)?$/g, '') : '';
  return inner.split(',').map((part) => part.split('=')).filter((pair) => pair.length >= 2)
    .map(([key, ...rest]) => [normalizeTomlKey(key), stripTomlValue(rest.join('='))]);
}

function scanToml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const values = new Map();
  const tables = new Map();
  const inlineTables = new Set();
  const root = { lastIndex: -1 };
  let current = root;
  let tableName = '';
  let firstHeaderIndex = -1;
  let multiline = null;
  let depth = 0;

  lines.forEach((line, index) => {
    if (multiline) {
      if (line.includes(multiline)) multiline = null;
      current.lastIndex = index;
      return;
    }
    if (depth > 0) {
      depth += bracketDelta(line);
      current.lastIndex = index;
      return;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const header = trimmed.match(/^\[(\[)?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (header) {
      if (firstHeaderIndex < 0) firstHeaderIndex = index;
      tableName = normalizeTomlKey(header[2]);
      const isArrayTable = Boolean(header[1]);
      current = { headerIndex: index, lastIndex: index, arrayTable: isArrayTable };
      if (!isArrayTable && !tables.has(tableName)) tables.set(tableName, current);
      return;
    }

    const pair = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!pair) return;
    current.lastIndex = index;
    const value = pair[2];
    if (!current.arrayTable) {
      const key = tableName ? `${tableName}.${normalizeTomlKey(pair[1])}` : normalizeTomlKey(pair[1]);
      values.set(key, stripTomlValue(value));
      if (value.trim().startsWith('{')) {
        inlineTables.add(key);
        parseInlineTable(value).forEach(([innerKey, innerValue]) => values.set(`${key}.${innerKey}`, innerValue));
      }
    }
    const tripleDouble = (value.match(/"""/g) || []).length;
    const tripleSingle = (value.match(/'''/g) || []).length;
    if (tripleDouble % 2 === 1) multiline = '"""';
    else if (tripleSingle % 2 === 1) multiline = "'''";
    else depth = Math.max(0, bracketDelta(value));
  });

  return { lines, values, tables, inlineTables, root, firstHeaderIndex };
}

function tomlEntries(text) {
  const entries = [];
  let table = '';
  String(text || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const header = trimmed.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (header) {
      table = normalizeTomlKey(header[1]);
      return;
    }
    const pair = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (pair) entries.push({ table, key: normalizeTomlKey(pair[1]), value: stripTomlValue(pair[2]) });
  });
  return entries;
}

function describeTomlEntry(entry) {
  return `${entry.table ? `[${entry.table}] ` : ''}${entry.key} = ${entry.value}`;
}

const HOOK_FLAGS = ['features.hooks', 'features.codex_hooks'];

/**
 * Add the keys of the OSuite config.toml partial that the file does not set yet.
 * Values the user already chose are kept and reported; running it again changes nothing.
 */
export function mergeTomlPartial(existingText, partialText) {
  const entries = tomlEntries(partialText);
  if (existingText === null || existingText === undefined) {
    return { status: 'created', body: partialText, added: entries.map(describeTomlEntry), kept: [], conflicts: [] };
  }

  const scan = scanToml(existingText);
  const added = [];
  const kept = [];
  const conflicts = [];
  const rootLines = [];
  const tableLines = new Map();
  const newTables = new Map();

  HOOK_FLAGS.forEach((flag) => {
    if (scan.values.get(flag) === 'false') {
      conflicts.push(`${flag.replace('features.', '[features] ')} = false turns Codex hooks off; set it to true`);
    }
  });

  for (const entry of entries) {
    const fullKey = entry.table ? `${entry.table}.${entry.key}` : entry.key;
    if (HOOK_FLAGS.includes(fullKey) && conflicts.length && !scan.values.has(fullKey)) continue;
    if (scan.values.has(fullKey)) {
      const current = scan.values.get(fullKey);
      if (current !== entry.value && !HOOK_FLAGS.includes(fullKey)) {
        kept.push({ key: describeTomlEntry({ ...entry, value: current }), suggested: entry.value });
        if (entry.table === 'mcp_servers.osuite_runtime_governance') {
          conflicts.push(`OSuite MCP ${entry.key} differs; the existing registration was preserved for explicit operator review`);
        }
      }
      continue;
    }
    const line = `${entry.key} = ${entry.value}`;
    if (!entry.table) {
      rootLines.push(line);
    } else if (scan.inlineTables.has(entry.table) || (scan.values.has(entry.table) && !scan.tables.has(entry.table))) {
      kept.push({ key: `${entry.table} (inline)`, suggested: `add ${line}` });
      continue;
    } else if (scan.tables.has(entry.table)) {
      if (!tableLines.has(entry.table)) tableLines.set(entry.table, []);
      tableLines.get(entry.table).push(line);
    } else if ([...scan.values.keys()].some((key) => key.startsWith(`${entry.table}.`))) {
      // The table only exists through dotted keys; a [table] header would redefine it.
      rootLines.push(`${entry.table}.${line}`);
    } else {
      if (!newTables.has(entry.table)) newTables.set(entry.table, []);
      newTables.get(entry.table).push(line);
    }
    added.push(describeTomlEntry(entry));
  }

  if (!added.length) return { status: 'unchanged', body: existingText, added, kept, conflicts };

  const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
  const lines = [...scan.lines];
  const inserts = [];
  tableLines.forEach((items, table) => {
    inserts.push({ index: scan.tables.get(table).lastIndex + 1, lines: items });
  });
  if (rootLines.length) {
    const index = scan.root.lastIndex >= 0 ? scan.root.lastIndex + 1 : (scan.firstHeaderIndex >= 0 ? 0 : lines.length);
    const spacer = scan.firstHeaderIndex >= index && String(lines[index] || '').trim() ? [''] : [];
    inserts.push({ index, lines: ['# Added by OSuite', ...rootLines, ...spacer] });
  }
  inserts.sort((a, b) => b.index - a.index).forEach(({ index, lines: items }) => lines.splice(index, 0, ...items));

  let body = lines.join(eol);
  if (newTables.size) {
    body = body.replace(/\s*$/, '');
    newTables.forEach((items, table) => {
      body += `${eol}${eol}# Added by OSuite${eol}[${table}]${eol}${items.join(eol)}`;
    });
  }
  if (!body.endsWith(eol)) body += eol;
  return { status: 'merged', body, added, kept, conflicts };
}

// --- Install ---------------------------------------------------------------

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function resolveProjectPath(projectRoot, relativePath) {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, String(relativePath || '').replace(/^\/+/, ''));
  if (!isInside(root, absolute)) {
    throw new Error(`Refusing to write outside the project root: ${relativePath}`);
  }

  const realRoot = fs.realpathSync(root);
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let resolved = realRoot;
  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(resolved, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (error.code === 'ENOENT') return path.join(next, ...parts.slice(index + 1));
      throw error;
    }
    // Check each existing parent, not just the leaf. lstat also catches dangling
    // links, which existsSync would mistake for safe new files.
    try {
      resolved = fs.realpathSync(next);
    } catch (error) {
      if (stat.isSymbolicLink()) throw new Error(`Cannot resolve project symlink safely: ${relativePath}`);
      throw error;
    }
    if (!isInside(realRoot, resolved)) {
      throw new Error(`Refusing to write outside the project root through a symlink: ${relativePath}`);
    }
  }
  return resolved;
}

function readIfExists(absolute) {
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
}

function writeFile(absolute, body) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, String(body ?? ''));
}

/**
 * Install one bootstrap file. Settings files are merged; OSuite's own files
 * are created, left alone when identical, and replaced only with --force.
 */
export function installProjectFile(projectRoot, relativePath, body, { force = false } = {}) {
  const absolute = resolveProjectPath(projectRoot, relativePath);
  const existing = readIfExists(absolute);
  const kind = MERGED_FILES[relativePath];

  if (kind) {
    let merge;
    try {
      merge = kind === 'json' ? mergeHookSettings(existing, String(body ?? '')) : kind === 'cursor-hooks' ? mergeCursorHookSettings(existing, String(body ?? ''))
        : kind === 'mcp' ? mergeMcpSettings(existing, String(body ?? '')) : mergeTomlPartial(existing, String(body ?? ''));
    } catch (error) {
      merge = { status: 'error', error: `OSuite template could not be read (${error.message})` };
    }
    if (merge.status === 'created' || merge.status === 'merged') writeFile(absolute, merge.body);
    const { body: _body, ...report } = merge;
    return { relativePath, kind, ...report };
  }

  if (existing === null) {
    writeFile(absolute, body);
    return { relativePath, status: 'created' };
  }
  if (existing === String(body ?? '')) return { relativePath, status: 'unchanged' };
  if (force) {
    writeFile(absolute, body);
    return { relativePath, status: 'replaced' };
  }
  return { relativePath, status: 'kept' };
}

export function installBlockers(results = []) {
  return results.flatMap((result) => [
    ...(result.status === 'error' ? [`${result.relativePath}: ${result.error}`] : []),
    ...(result.conflicts || []).map((conflict) => `${result.relativePath}: ${conflict}`),
  ]);
}

/** Lines that say exactly what an install changed, for the terminal. */
export function describeInstallResult(result) {
  const lines = [];
  const name = result.relativePath;
  if (result.status === 'error') {
    lines.push(`failed     ${name}: ${result.error}. Nothing was changed; fix the file and run this again.`);
    return lines;
  }
  if (result.kind === 'json' || result.kind === 'cursor-hooks') {
    if (result.status === 'unchanged') lines.push(`unchanged  ${name} (OSuite hooks already there)`);
    else lines.push(`${result.status === 'created' ? 'created' : 'merged '}    ${name}`);
    if (result.status !== 'unchanged') {
      result.added.forEach((hook) => lines.push(`             + ${hook.event} ${hook.matcher || '*'} → ${hook.command}`));
      (result.migrated || []).forEach((hook) => lines.push(`             migrated ${hook.event} to Node; review the changed hook in the host`));
    }
    if (result.status === 'merged') {
      const others = result.keptKeys.length ? ` and your other settings (${result.keptKeys.join(', ')})` : '';
      lines.push(`             kept ${result.keptHooks} existing hook${result.keptHooks === 1 ? '' : 's'}${others}`);
    }
    (result.conflicts || []).forEach((conflict) => lines.push(`             ! ${conflict}`));
    return lines;
  }
  if (result.kind === 'toml') {
    if (result.status === 'unchanged') lines.push(`unchanged  ${name} (OSuite settings already there)`);
    else lines.push(`${result.status === 'created' ? 'created' : 'merged '}    ${name}`);
    if (result.status !== 'unchanged') result.added.forEach((entry) => lines.push(`             + ${entry}`));
    result.kept.forEach((entry) => lines.push(`             kept your ${entry.key} (OSuite suggests ${entry.suggested})`));
    result.conflicts.forEach((conflict) => lines.push(`             ! ${conflict}`));
    return lines;
  }
  const labels = {
    created: `created    ${name}`,
    unchanged: `unchanged  ${name}`,
    replaced: `replaced   ${name}`,
    kept: `kept       ${name} (differs from this OSuite version; use --force to replace)`,
  };
  lines.push(labels[result.status] || `${result.status} ${name}`);
  return lines;
}

// --- Verify ----------------------------------------------------------------

function readJson(absolute) {
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function eventHooks(settings, event, flat = false) {
  const groups = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
  return flat ? groups : groups.flatMap(group => Array.isArray(group?.hooks) ? group.hooks : []);
}

function findCommand(settings, event, script, flat = false) {
  return eventHooks(settings, event, flat)
    .find((hook) => typeof hook?.command === 'string' && hookScriptName(hook.command).replace(/\.(py|mjs)$/, '') === script.replace(/\.(py|mjs)$/, '')) || null;
}

function managedFileStatus(projectRoot, relativePath, expected) {
  try {
    let absolute = fs.realpathSync(projectRoot);
    const parts = relativePath.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      absolute = path.join(absolute, parts[index]);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return 'unverified';
      if (index === parts.length - 1 && expected !== undefined && stat.size !== Buffer.byteLength(expected)) return 'different';
    }
    // Only callers' known managed paths reach here, never a path parsed from a command.
    return expected === undefined || fs.readFileSync(absolute).equals(Buffer.from(expected)) ? 'current' : 'different';
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unverified';
  }
}

function isManagedHookCommand(command, projectRoot, relativePath) {
  if (typeof command !== 'string') return false;
  const executable = relativePath.endsWith('.py') ? 'python3' : 'node';
  const text = command.trim();
  // Recognize the former stock Codex template without evaluating its substitution.
  if (relativePath.startsWith('.codex/') && executable === 'python3'
      && text === `python3 "$(git rev-parse --show-toplevel)/${relativePath}"`) return true;
  if (!text.startsWith(`${executable} `)) return false;
  const word = text.slice(executable.length + 1).trim();
  let file;
  if (word.startsWith("'") && word.endsWith("'")) {
    file = word.slice(1, -1).replace(/'\\''/g, "'");
    if (`'${file.replace(/'/g, "'\\''")}'` !== word) return false;
  } else if (/^"[^"$`\\]*"$/.test(word)) file = word.slice(1, -1);
  else if (/^[a-zA-Z0-9_./:@+-]+$/.test(word)) file = word;
  else return false;
  if (file === relativePath || file === `./${relativePath}`) return true;
  const suffix = `${path.sep}${relativePath.split('/').join(path.sep)}`;
  if (!path.isAbsolute(file) || !file.endsWith(suffix)) return false;
  try {
    // A project-root alias is still this installation; arbitrary script paths are not.
    return fs.realpathSync(file.slice(0, -suffix.length) || path.parse(file).root) === fs.realpathSync(projectRoot);
  } catch {
    return false;
  }
}

function diagnoseHookInstallation(projectRoot, installation, registered) {
  const spec = RUNTIME_HOOKS[installation.runtime];
  const warnings = [];
  const files = [];
  const registrations = [];
  let canProbe = Boolean(installation.pretool);
  let bundle;
  try {
    bundle = buildNodeRuntimeBootstrap(installation.runtime, {}, { projectRoot });
  } catch {
    warnings.push('Packaged Node runtime could not be read; installation freshness is not verified');
    canProbe = false;
  }
  const expectedSettings = bundle && JSON.parse(bundle.files[bundle.node_runtime.settings_path]);
  const hasNode = registered.some(hook => hookScriptName(hook.command).endsWith('.mjs'));
  if (hasNode && bundle) {
    for (const [relativePath, expected] of Object.entries(bundle.files)) {
      if (!relativePath.startsWith(`${spec.dir}/runtime/`) && !relativePath.startsWith(`${spec.dir}/hooks/`)) continue;
      const status = managedFileStatus(projectRoot, relativePath, expected);
      files.push({ relativePath, status });
      if (status !== 'current') {
        canProbe = false;
        warnings.push(status === 'different'
          ? `${relativePath} differs from this CLI's packaged Node bytes (outdated or customized); not verified`
          : status === 'missing' ? `${relativePath} is missing; not verified`
            : `${relativePath} is a symlink, not a regular managed file, or unreadable; not verified`);
      }
    }
  }
  for (const hook of registered) {
    const script = hookScriptName(hook.command);
    const relativePath = `${spec.dir}/hooks/${script}`;
    const legacy = script.endsWith('.py');
    const expected = expectedSettings && eventHooks(expectedSettings, hook.event, spec.flatHooks)
      .find(item => hookScriptName(item.command).replace(/\.mjs$/, '') === script.replace(/\.(py|mjs)$/, ''));
    const recognized = Boolean(expected) && ['command', undefined].includes(hook.type)
      && isManagedHookCommand(hook.command, projectRoot, relativePath)
      && (hook.commandWindows === undefined || hook.commandWindows === expected.commandWindows
        || isManagedHookCommand(hook.commandWindows, projectRoot, relativePath));
    const status = recognized ? legacy ? 'legacy' : 'current' : 'unverified';
    registrations.push({ settingsPath: hook.settingsPath, event: hook.event, command: hook.command, status });
    const location = `${hook.settingsPath} ${hook.event}`;
    if (installation.runtime === 'claude' && hook.event === 'PreToolUse' && hook.onFailure !== 'block') {
      warnings.push(`${location} lacks onFailure: 'block'; native crashes/timeouts may fail open. Review explicitly: this option requires Claude Code 2.1.295 or newer; installed host version support is not verified. Existing settings were preserved.`);
    }
    if (legacy) warnings.push(`${location} registers legacy Python ${script}; current Node version is not verified`);
    if (!recognized) {
      canProbe = false;
      warnings.push(`${location}: custom path or unrecognized command for ${script} was preserved; not verified and will not be executed by doctor`);
    } else if (legacy && managedFileStatus(projectRoot, relativePath) !== 'current') {
      // The direct probe invokes pre/post only; legacy Stop/Session gaps remain warnings.
      if ([spec.preEvent || 'PreToolUse', spec.postEvent || 'PostToolUse'].includes(hook.event)) canProbe = false;
      warnings.push(`${relativePath} is missing or is not a regular managed file; legacy installation is not verified`);
    }
  }
  const byEvent = new Map();
  for (const hook of registrations) {
    const key = `${hook.event}:${hookScriptName(hook.command).replace(/\.(py|mjs)$/, '')}`;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(hook);
  }
  for (const group of byEvent.values()) {
    if (group.length < 2) continue;
    canProbe = false;
    warnings.push(`Duplicate ${group[0].event} registrations were preserved in ${group.map(hook => hook.settingsPath).join(', ')}; not verified as a single invocation, even while disabled`);
  }
  if (hasNode && expectedSettings) {
    for (const event of Object.keys(expectedSettings.hooks)) {
      if (!registrations.some(hook => hook.event === event)) warnings.push(`No packaged ${event} registration found; the complete Node installation is not verified`);
    }
  }
  return { status: hasNode && !warnings.length ? 'current' : 'not_verified', canProbe, registrations, files, warnings };
}

/**
 * OSuite hooks registered in this project, with anything that stops them from running.
 * Opt-in diagnosis adds read-only byte/registration checks without changing the legacy
 * inventory shape. It compares this CLI's package, not registry or global/plugin copies.
 */
export function findHookInstallations(projectRoot, runtimes = Object.keys(RUNTIME_HOOKS), { diagnose = false } = {}) {
  return runtimes.flatMap((runtime) => {
    const spec = RUNTIME_HOOKS[runtime];
    if (!spec) return [];
    const problems = [];
    const disabledReasons = [];
    const registrations = [];
    let pretoolCount = 0;
    let posttoolCount = 0;
    let pretool = null;
    let posttool = null;
    spec.settings.forEach((settingsPath) => {
      const absolute = path.join(projectRoot, settingsPath);
      if (!fs.existsSync(absolute)) return;
      let settings;
      try {
        settings = readJson(absolute);
      } catch {
        problems.push(`${settingsPath} is not valid JSON, so ${spec.label} cannot load its hooks`);
        return;
      }
      if (!isPlainObject(settings)) {
        problems.push(`${settingsPath} must contain a JSON object, so ${spec.label} cannot load its hooks`);
        return;
      }
      disabledHookSettings(settings).forEach((reason) => disabledReasons.push(`${settingsPath}: ${runtime === 'cursor'
        ? 'explicit disableAllHooks intent was preserved; this is not a documented Cursor host control' : reason}`));
      if (diagnose) {
        for (const event of Object.keys(settings.hooks || {})) {
          eventHooks(settings, event, spec.flatHooks).filter(hook => typeof hook?.command === 'string' && hookScriptName(hook.command))
            .forEach(hook => registrations.push({ ...hook, settingsPath, event }));
        }
      }
      const preEvent = spec.preEvent || 'PreToolUse', postEvent = spec.postEvent || 'PostToolUse';
      const pre = findCommand(settings, preEvent, 'osuite_pretool.py', spec.flatHooks);
      const post = findCommand(settings, postEvent, 'osuite_posttool.py', spec.flatHooks);
      pretoolCount += eventHooks(settings, preEvent, spec.flatHooks)
        .filter(hook => /osuite_pretool\.(?:py|mjs)/.test(hook?.command || '')).length;
      posttoolCount += eventHooks(settings, postEvent, spec.flatHooks)
        .filter(hook => /osuite_posttool\.(?:py|mjs)/.test(hook?.command || '')).length;
      if (runtime === 'cursor') {
        if (settings.version !== 1) problems.push(`${settingsPath} is not Cursor hooks schema version 1`);
        if ([pre, post].some(handler => handler && !['command', undefined].includes(handler.type))) problems.push('Cursor OSuite hooks must use command execution type, not a prompt');
        if (pre && pre.failClosed !== true) problems.push('Cursor preToolUse must have failClosed: true to block hook process failures');
        if (pre && !['', '*', undefined].includes(pre.matcher)) problems.push('Cursor preToolUse matcher restricts coverage; the custom matcher was preserved');
        if (pre?.disabled === true || pre?.enabled === false) disabledReasons.push('Cursor preToolUse contains explicit disabled intent; it was preserved');
      }
      if (pre && !pretool) pretool = { settingsPath, command: pre.command };
      if (post && !posttool) posttool = { settingsPath, command: post.command };
    });
    if (!disabledReasons.length && (pretoolCount > 1 || posttoolCount > 1)) problems.push('Multiple OSuite hook registrations were preserved; resolve duplicate hooks before relying on a single governed invocation');

    const scriptPath = `${spec.dir}/hooks/osuite_pretool.py`;
    const scriptPresent = fs.existsSync(path.join(projectRoot, scriptPath)) || fs.existsSync(path.join(projectRoot, scriptPath.replace(/\.py$/, '.mjs')));
    if (!pretool && !scriptPresent && !problems.length) return [];
    if (!pretool) {
      problems.push(`no ${spec.preEvent || 'PreToolUse'} hook in ${spec.settings.join(' or ')} runs osuite_pretool.${runtime === 'cursor' ? 'mjs' : 'py'}`);
    }
    if (spec.config) {
      const config = readIfExists(path.join(projectRoot, spec.config));
      if (config !== null) {
        const values = scanToml(config).values;
        HOOK_FLAGS.forEach((flag) => {
          if (values.get(flag) === 'false') disabledReasons.push(`${spec.config} turns hooks off (${flag} = false)`);
        });
      }
    }
    const installation = { runtime, label: spec.label, installDir: spec.dir, pretool, posttool,
      hostEnabled: disabledReasons.length === 0, disabledReasons, problems: [...problems, ...disabledReasons] };
    if (diagnose) installation.diagnostics = diagnoseHookInstallation(projectRoot, installation, registrations);
    return [installation];
  });
}

export function parseDotenv(body) {
  const values = {};
  String(body || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;
    const [rawKey, ...rawValue] = trimmed.split('=');
    const key = rawKey.trim();
    let value = rawValue.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (value.includes(' #')) value = value.slice(0, value.indexOf(' #')).trim();
    if (key) values[key] = value;
  });
  return values;
}

/** The credentials the installed hook will use: shell values first, then its own .env. */
export function hookCredentials(projectRoot, installation, shellEnv = process.env) {
  const dotenv = parseDotenv(readIfExists(path.join(projectRoot, installation.installDir, '.env')));
  const env = { ...dotenv };
  Object.entries(shellEnv || {}).forEach(([key, value]) => {
    if (value !== undefined) env[key] = value;
  });
  return {
    baseUrl: String(env.OSUITE_BASE_URL || env.DASHCLAW_BASE_URL || '').replace(/\/$/, ''),
    apiKey: String(env.OSUITE_API_KEY || env.DASHCLAW_API_KEY || ''),
    envFile: `${installation.installDir}/.env`,
    hookMode: String(env.OSUITE_HOOK_MODE || env.DASHCLAW_HOOK_MODE || (installation.runtime === 'cursor' ? 'observe' : 'enforce')),
  };
}

function runShell(command, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code) => finish({ code }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function hookMessages(stdout) {
  return String(stdout || '').split(/\r?\n/).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return [...new Set(['systemMessage', 'user_message', 'agent_message', 'additional_context']
        .map(field => parsed?.[field]).filter(value => typeof value === 'string' && value))];
    } catch {
      return [];
    }
  });
}

function hookWarnings(stdout, stderr) {
  return [...new Set([
    ...hookMessages(stdout),
    ...String(stderr || '').split(/\r?\n/).map((line) => line.trim())
      .filter((line) => /\bWarning:|Not governed|\[observe\]|Guard unavailable/i.test(line)),
  ])];
}

function lastLine(text) {
  return String(text || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
}

async function fetchSessionEvents(fetchImpl, { baseUrl, apiKey, sessionId }) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/runtime-sessions/${encodeURIComponent(sessionId)}/events?limit=50`, {
      headers: { 'x-api-key': apiKey },
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, items: Array.isArray(payload?.items) ? payload.items : [] };
  } catch (error) {
    return { status: 0, items: [], error: error.message };
  }
}

/**
 * Directly probe the registered hook with an inert shell call. Configuration,
 * telemetry, and policy outcomes are separate checks; this is not a host launch.
 */
export async function runHookCheck({
  projectRoot,
  installation,
  shellEnv = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  const steps = [];
  const warnings = [];
  const state = { configured: false, hostEnabled: false, connected: false, telemetry: false, governed: false };
  let sessionId;
  const result = (ok) => ({ ok, ...state, steps, runtime: installation?.runtime, sessionId, warnings });
  const fail = (label, detail) => {
    steps.push({ label, ok: false, detail });
    return result(false);
  };

  if (!installation?.pretool) return fail('Hook installed', installation?.problems?.join('; ') || 'no OSuite hook found');
  const disabledReasons = installation.disabledReasons || [];
  const problems = (installation.problems || []).filter((problem) => !disabledReasons.includes(problem));
  if (problems.length) return fail('Hook installed', problems.join('; '));
  state.configured = true;
  steps.push({ label: 'Hook installed', ok: true, detail: `${installation.pretool.settingsPath} runs ${installation.pretool.command}` });
  if (installation.hostEnabled === false || disabledReasons.length) {
    return fail('Host hooks enabled', disabledReasons.join('; ') || 'hooks are disabled in project settings');
  }
  state.hostEnabled = true;
  steps.push({ label: 'Host hooks enabled', ok: true, detail: 'project settings permit hooks; actual host invocation is not verified by this direct probe' });

  if (installation.diagnostics?.canProbe === false) {
    steps.push({ label: 'Hook probe', ok: false, warning: true,
      detail: 'Not verified: direct probe skipped because installation bytes or registered commands need review; nothing was reinstalled or enabled' });
    return result(false);
  }

  const credentials = hookCredentials(projectRoot, installation, shellEnv);
  if (!credentials.baseUrl || !credentials.apiKey) {
    return fail('Hook credentials', `OSUITE_BASE_URL and OSUITE_API_KEY are not set in ${credentials.envFile} or the shell; governance cannot be verified`);
  }
  steps.push({ label: 'Hook credentials', ok: true, detail: `base URL and API key configured for ${credentials.baseUrl}` });

  const id = crypto.randomBytes(4).toString('hex');
  sessionId = `osuite-doctor-${id}`;
  const toolUseId = `osuite_doctor_${id}`;
  const cursor = installation.runtime === 'cursor';
  const sample = {
    ...(cursor ? { conversation_id: sessionId, generation_id: `osuite-doctor-generation-${id}` } : { session_id: sessionId }),
    cwd: projectRoot,
    hook_event_name: cursor ? 'preToolUse' : 'PreToolUse',
    tool_name: cursor ? 'Shell' : 'Bash',
    tool_input: { command: DOCTOR_COMMAND, description: 'OSuite doctor hook check' },
    tool_use_id: toolUseId,
  };
  // OSUITE_HOOK_CHECK tells the hook and OSuite this is a probe: a call that
  // would need approval is reported, not sent to reviewers.
  const env = { ...shellEnv, OSUITE_APPROVAL_WAIT_SECONDS: '3', OSUITE_HOOK_CHECK: '1' };
  const run = await runShell(installation.pretool.command, {
    cwd: projectRoot, env, input: JSON.stringify(sample), timeoutMs,
  });
  const messages = hookMessages(run.stdout);
  warnings.push(...hookWarnings(run.stdout, run.stderr));
  const said = messages[0] || lastLine(run.stderr);

  if (run.timedOut) return fail('Hook test', `the hook did not finish within ${Math.round(timeoutMs / 1000)}s`);
  if (run.code === 127 && /^python3?\b/.test(installation.pretool.command)) {
    return fail('Hook test', 'python3 was not found. The hook runs with Python 3.8 or newer: install it (macOS: xcode-select --install), then run osuite doctor');
  }
  if (run.error || (run.code !== 0 && run.code !== 2)) {
    return fail('Hook test', `the hook command failed (${run.error ? run.error.message : `exit ${run.code}`})${said ? `: ${said}` : ''}`);
  }
  steps.push({
    ok: true,
    label: 'Hook test',
    detail: `sample ${sample.tool_name} call (${DOCTOR_COMMAND}) ${run.code === 0 ? 'allowed' : 'stopped'} by the hook${run.code === 2 && said ? `: ${said}` : ''}`,
  });

  let lookup = await fetchSessionEvents(fetchImpl, { ...credentials, sessionId });
  if (!lookup.items.some((event) => event?.tool_use_id === toolUseId) && lookup.status !== 401 && lookup.status !== 403) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    lookup = await fetchSessionEvents(fetchImpl, { ...credentials, sessionId });
  }
  const seen = lookup.items.filter((event) => event?.tool_use_id === toolUseId && event?.runtime_session_id === sessionId);

  if (installation.posttool && run.code === 0) {
    // Closes the sample action in the ledger; not part of the verdict.
    await runShell(installation.posttool.command, {
      cwd: projectRoot,
      env,
      timeoutMs,
      input: JSON.stringify({
        ...sample,
        hook_event_name: cursor ? 'postToolUse' : 'PostToolUse',
        ...(cursor ? { tool_output: JSON.stringify({ exitCode: 0 }) }
          : { tool_response: { stdout: 'OSuite doctor hook check', stderr: '', interrupted: false, exit_code: 0 } }),
      }),
    });
  }

  state.connected = lookup.status >= 200 && lookup.status < 300;
  if (state.connected) steps.push({ ok: true, label: 'Studio connection', detail: `runtime event endpoint answered HTTP ${lookup.status}` });
  if (!state.connected || !seen.length) {
    const reason = lookup.status === 401 || lookup.status === 403
      ? `OSuite rejected the API key in ${credentials.envFile} (HTTP ${lookup.status})`
      : said || (lookup.error ? `could not reach ${credentials.baseUrl} (${lookup.error})` : `no runtime event for session ${sessionId}`);
    return fail(state.connected ? 'Studio event' : 'Studio connection', `the sample call did not reach OSuite: ${reason}`);
  }
  state.telemetry = true;
  steps.push({
    ok: true,
    label: 'Studio event',
    detail: `${[...new Set(seen.map((event) => event.event_type))].join(', ')} reached OSuite (session ${sessionId})`,
  });

  const nodeHook = /\bosuite_pretool\.mjs\b/.test(installation.pretool.command);
  const preflightModes = seen.filter((event) => event.event_type === 'tool_preflight')
    .map((event) => event.payload?.hook_mode).filter((mode) => ['observe', 'enforce', 'strict'].includes(mode));
  const observing = (!preflightModes.length && credentials.hookMode === 'observe') || seen.some((event) => (
    event.payload?.hook_mode === 'observe' || event.payload?.observe_only === true
    || String(event.payload?.decision || '').startsWith('observe_')
  ));
  if (observing) return fail('Governance', 'Not governed: observation-only mode records telemetry but does not enforce policy; the mode was not changed');
  const unavailable = seen.some((event) => ['guard_unavailable', 'guard_unavailable_blocked'].includes(event.payload?.decision));
  if (unavailable) return fail('Governance', `Not governed: guard unavailable; the hook ${run.code === 0 ? 'failed open' : 'failed closed'}, and telemetry alone does not verify governance`);
  const ungoverned = warnings.find((warning) => /Not governed/i.test(warning));
  if (ungoverned) return fail('Governance', ungoverned);
  if (nodeHook && !preflightModes.some((mode) => mode === 'enforce' || mode === 'strict')) {
    return fail('Governance', 'Not verified: no matching event-time enforcing posture was recorded for the sample call');
  }

  const outcome = seen.find((event) => {
    const decision = event.payload?.decision;
    if (run.code === 0) {
      return event.event_type === 'tool_allowed' && typeof event.action_id === 'string' && event.action_id.trim()
        && ['allow', 'warn', 'approved_by_reviewer'].includes(decision);
    }
    if (event.event_type === 'install_check_policy_result') {
      return run.code === 2 && event.payload?.install_check === true
        && event.payload?.approval_state === 'not_requested'
        && ['require_approval', 'require_dual_approval'].includes(decision);
    }
    if (event.event_type === 'tool_blocked' && decision === 'block') {
      if (nodeHook) return event.payload?.reason === 'policy_block';
      return event.payload?.reason !== 'action_creation_not_authorized'
        && !String(event.payload?.reason || '').startsWith('Unsupported guard decision:');
    }
    return event.event_type === 'tool_requires_approval' && typeof event.action_id === 'string' && event.action_id.trim()
      && ['require_approval', 'require_dual_approval'].includes(decision);
  });
  if (!outcome) return fail('Governance', 'Not verified: telemetry arrived, but no matching enforced policy outcome was recorded for the sample call');
  state.governed = true;
  const detail = outcome.event_type === 'install_check_policy_result'
    ? `verified policy would require ${outcome.payload.decision === 'require_dual_approval' ? 'two-person approval' : 'approval'}; the probe was not executed and no request was sent to reviewers`
    : `verified ${outcome.payload.decision} policy outcome for the direct hook probe; the sample command was not executed`;
  steps.push({ ok: true, label: 'Governance', detail });
  return result(true);
}
