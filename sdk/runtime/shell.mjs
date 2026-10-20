import path from 'node:path';
import { canonicalJson, sha256 } from './protocol.mjs';

const basename = token => path.basename(String(token || '')).toLowerCase();
const set = text => new Set(text.split(' '));
const shells = set('sh bash zsh dash');
const gitValueFlags = set('-C -c --git-dir --work-tree --namespace --exec-path --config-env');
const protectedRef = ref => /^(?:(?:refs\/heads\/)?(?:main|master|prod|production|stable)|(?:refs\/heads\/)?release(?:\/.*)?)$/.test(ref || '');

export function parseShell(command) {
  const segments = [], errors = [];
  let current = '', quote = null, started = false, segment = [], operator = null;
  const flush = () => { if (started) { segment.push(current); current = ''; started = false; operator = null; } };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") { if (char === quote) quote = null; else current += char; continue; }
    if (char === '\\') {
      if (i + 1 === command.length) { errors.push('dangling_escape'); break; }
      const next = command[i + 1];
      if (quote === '"' && !'$`"\\\n'.includes(next)) { current += char; continue; }
      i += 1;
      if (next !== '\n') { current += next; started = true; }
      continue;
    }
    if ('$`'.includes(char)) errors.push('unsupported_expansion');
    if (quote === '"') { if (char === quote) quote = null; else current += char; continue; }
    if ('"\''.includes(char)) { quote = char; started = true; continue; }
    if (char === '#' && !started) { errors.push('unsupported_comment'); while (i < command.length && command[i] !== '\n') i += 1; continue; }
    if (char === '<' && command[i + 1] === '<') { errors.push('unsupported_heredoc'); break; }
    if ('*?['.includes(char)) errors.push('unsupported_glob_expansion');
    if ('<>(){}'.includes(char)) errors.push('unsupported_shell_syntax');
    if (char === '&' && command[i + 1] !== '&') errors.push('unsupported_background');
    const separator = ';|\n'.includes(char) || (char === '&' && command[i + 1] === '&');
    if (separator || /\s/.test(char)) {
      flush();
      if (separator) {
        const nextOperator = (char === '&' || char === '|') && command[i + 1] === char ? char + command[++i] : char;
        if (segment.length) segments.push(segment);
        else if (nextOperator !== '\n') errors.push('empty_segment');
        segment = []; operator = nextOperator;
      }
    } else { current += char; started = true; }
  }
  flush();
  if (segment.length) segments.push(segment);
  if (quote) errors.push('unclosed_quote');
  if (['&&', '||', '|'].includes(operator)) errors.push('missing_operand');
  return { segments, errors: [...new Set(errors)] };
}

function unwrap(tokens) {
  let argv = [...tokens];
  for (let depth = 0; depth < 8 && argv.length; depth += 1) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] || '')) argv.shift();
    const exe = basename(argv[0]);
    if (set('command builtin noglob').has(exe)) { argv.shift(); while ((argv[0] || '').startsWith('-')) argv.shift(); continue; }
    if (!set('env sudo doas').has(exe)) break;
    argv.shift();
    const valueFlags = exe === 'env' ? set('-u --unset -C --chdir -S --split-string') : set('-u -g -h -p -C -T');
    while (argv.length && (argv[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))) {
      const flag = argv.shift();
      // env -S evaluates another argument string; do not guess at its grammar.
      if (flag === '-S' || flag.startsWith('--split-string')) return [];
      if (valueFlags.has(flag)) argv.shift();
      if (flag === '--') break;
    }
  }
  return argv;
}

function result(type, risk, reversible, canonical) {
  return { action_type: type, risk_score: risk, reversible, systems_touched: canonical.systems_touched,
    summary: { tool_name: canonical.executable, tool_category: canonical.tool_category, canonical_action: canonical,
      action_fingerprint: sha256(canonicalJson(canonical)).slice(0, 32), classification_source: 'osuite_shell_semantics',
      classification_status: canonical.classification_status || 'complete' } };
}

function incomplete(argv, cwd, reasons) {
  return result('review', 40, null, { runtime: 'bash', executable: basename(argv[0]) || 'shell', operation: argv.slice(1).join(' '),
    tool_category: 'other', cwd, systems_touched: ['shell'], classification_status: 'incomplete',
    uncertainty_reasons: reasons, command_commitment: sha256(canonicalJson(argv)).slice(0, 32) });
}

function boundedObservation(exe, args) {
  const switches = {
    rg: set('--files --hidden --no-ignore --no-ignore-vcs --no-ignore-dot --follow --fixed-strings --ignore-case --case-sensitive --smart-case --line-number --files-with-matches --files-without-match --count --count-matches --only-matching --quiet --word-regexp --line-regexp --no-heading --heading --with-filename --no-filename --text --multiline --pcre2 --stats --sort-files --no-messages'),
    sed: set('-n -E --quiet --silent --regexp-extended'),
    jq: set('-r -c -e -s -n -R -S -M -C --raw-output --compact-output --exit-status --slurp --null-input --raw-input --sort-keys --monochrome-output --color-output'),
  }[exe];
  const values = { rg: set('-g --glob --iglob -e --regexp -t --type -T --type-not --max-count -m --max-depth --encoding --color --context -C --after-context -A --before-context -B'), sed: set('-e --expression'), jq: set('--arg --argjson') }[exe];
  const operands = [], expressions = [];
  let flags = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { flags = false; continue; }
    if (flags && arg.startsWith('-')) {
      if (switches.has(arg) || (exe === 'rg' && /^-[niFlovqwsSHh]+$/.test(arg))) continue;
      const flag = arg.split('=')[0];
      if (!values.has(flag)) return false;
      const count = exe === 'jq' ? 2 : 1;
      if (arg.includes('=')) { if (exe === 'sed') expressions.push(arg.slice(arg.indexOf('=') + 1)); continue; }
      if (i + count >= args.length) return false;
      if (exe === 'sed') expressions.push(args[i + 1]);
      i += count;
    } else operands.push(arg);
  }
  if (exe === 'sed') {
    if (!expressions.length) expressions.push(operands[0] || '');
    return expressions.every(value => /^(?:(?:[0-9]+(?:,(?:[0-9]+|\$))?|\$))?p$/.test(value));
  }
  return true;
}

function classifyArgv(tokens, cwd, depth) {
  const argv = unwrap(tokens), exe = basename(argv[0]), args = argv.slice(1);
  if (!exe) return incomplete(tokens, cwd, ['unsupported_wrapper']);
  if (shells.has(exe)) {
    const index = args.findIndex(arg => /^-[a-z]*c$/.test(arg));
    return index >= 0 && typeof args[index + 1] === 'string' && depth < 4
      ? classifyShell(args[index + 1], cwd, depth + 1) : incomplete(argv, cwd, ['unsupported_shell_invocation']);
  }
  const canonical = { runtime: 'bash', executable: exe, operation: args[0] || '', tool_category: 'other', cwd, systems_touched: [exe] };
  const classified = (type, risk, reversible, category = 'deployment') => result(type, risk, reversible, { ...canonical, tool_category: category });
  if (exe === 'git') {
    let index = 0;
    while (index < args.length && args[index].startsWith('-')) { const flag = args[index++]; if (gitValueFlags.has(flag)) index += 1; }
    const operation = args[index], rest = args.slice(index + 1);
    canonical.operation = operation || '';
    if (set('push merge rebase reset').has(operation)) {
      const positional = rest.filter(value => !value.startsWith('-'));
      canonical.remote = positional[0] || null; canonical.ref = positional[1] || null;
      const destructive = rest.some(arg => ['--force', '--delete', '-f', '-d', '--mirror', '--all'].includes(arg) || arg.startsWith('--force-with-lease') || arg.startsWith(':'));
      return classified('deploy', destructive ? 92 : protectedRef(canonical.ref) ? 80 : 62, false);
    }
    const risks = { status: 10, log: 10, branch: 10, show: 12, remote: 14, diff: 18 };
    // Listing branches/remotes is an observation, but those subcommands can also mutate.
    if ((operation === 'branch' && rest.some(arg => !arg.startsWith('-')) && !rest.includes('--list')) ||
        (operation === 'branch' && rest.some(arg => /^-(?:[dDmMcC]|-delete|-move|-copy)/.test(arg))) ||
        (operation === 'remote' && rest.some(arg => !arg.startsWith('-')))) return incomplete(argv, cwd, ['git_mutation_not_classified']);
    if (risks[operation] !== undefined) return classified('monitor', risks[operation], true, 'observation');
    return incomplete(argv, cwd, ['unsupported_git_operation']);
  }
  if (set('rg sed jq').has(exe)) return boundedObservation(exe, args) ? classified('other', 20, true, 'observation') : incomplete(argv, cwd, ['unbounded_observation']);
  if (exe === 'rm' && args.slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--')).some(arg => /^-[rf]+$/.test(arg) && arg.includes('r') && arg.includes('f'))) return classified('security', 90, false);
  if (exe === 'npm' && args[0] === 'run' && args[1] === 'deploy') return classified('deploy', 75, false);
  if ((exe === 'npm' && args[0] === 'run' && args[1] === 'build') || (set('npm pip pip3').has(exe) && args[0] === 'install') || (exe === 'yarn' && args[0] === 'add')) return classified('build', 30, true, 'build');
  if (set('vercel netlify heroku railway fly').has(exe) && args.includes('deploy')) return classified('deploy', 75, false);
  if (exe === 'kubectl') {
    if (set('api-resources api-versions cluster-info describe diff explain get logs top version').has(args[0])) return classified('monitor', 28, true, 'observation');
    if (set('annotate apply autoscale cordon create delete drain edit label patch replace rollout scale set taint uncordon').has(args[0])) return classified('deploy', 85, false);
    return incomplete(argv, cwd, ['unsupported_kubectl_operation']);
  }
  const infra = {
    terraform: [set('fmt graph output plan providers show validate version workspace'), 38, set('apply destroy force-unlock import init state taint untaint'), 90, 78],
    helm: [set('diff get history lint list show status template test version'), 36, set('install rollback uninstall upgrade'), 84, 72],
    pulumi: [set('about preview stack version whoami'), 38, set('cancel destroy import refresh up'), 88, 76],
  }[exe];
  if (infra) return infra[0].has(args[0]) ? classified('review', infra[1], true, 'planning') : classified('deploy', infra[2].has(args[0]) ? infra[3] : infra[4], false);
  if (set('ansible ansible-playbook').has(exe)) return args.some(arg => set('--check --diff -C').has(arg)) ? classified('review', 40, true, 'planning') : classified('deploy', 82, false);
  if (exe === 'az') {
    canonical.raw_operation = args.join(' ');
    if (args[0] === 'keyvault' && args[1] === 'secret') {
      canonical.operation = args.slice(0, 3).join(' '); canonical.systems_touched = ['azure-keyvault'];
      const read = set('backup download list show').has(args[2]);
      return classified('security', read ? 74 : 88, read, 'secret_access');
    }
    if (args[0] === 'role' && args[1] === 'assignment') return classified('security', 86, false, 'access_control');
    // Unresolved Azure resource scope must never be called a complete bounded operation.
    const unknown = incomplete(argv, cwd, ['unresolved_azure_scope']);
    return args.includes('delete') ? { ...unknown, action_type: 'security', risk_score: 90, reversible: false } : unknown;
  }
  return incomplete(argv, cwd, ['unsupported_executable']);
}

export function classifyShell(command, cwd = '', depth = 0) {
  const parsed = parseShell(command);
  const results = parsed.segments.map(argv => classifyArgv(argv, cwd, depth));
  if (parsed.errors.length || !results.length) results.push(incomplete([command], cwd, parsed.errors.length ? parsed.errors : ['empty_command']));
  if (results.length === 1) return results[0];
  const primary = [...results].sort((a, b) => b.risk_score - a.risk_score || Number(b.reversible === false) - Number(a.reversible === false))[0];
  return { ...primary, reversible: results.some(value => value.reversible === false) ? false : results.some(value => value.reversible === null) ? null : true,
    systems_touched: [...new Set(results.flatMap(value => value.systems_touched))],
    summary: { ...primary.summary, canonical_actions: results.map(value => value.summary.canonical_action),
      classification_status: results.some(value => value.summary.classification_status === 'incomplete') ? 'incomplete' : 'complete',
      compound_command_commitment: sha256(command).slice(0, 32) } };
}
