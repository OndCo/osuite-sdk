import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { canonicalJson } from './protocol.mjs';

export function collectGitPublication(command, cwd = process.cwd(), env = process.env) {
  const match = /^git push ([A-Za-z0-9][A-Za-z0-9_-]*) ([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(command);
  if (!match || match[0] !== command || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_NAMESPACE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'].some(key => env[key])) return null;
  const [, remote, branch] = match;
  // All subprocesses are local metadata reads. Bound the whole collection, not
  // just each read, so evidence gathering cannot consume the host hook timeout.
  const deadline = performance.now() + 1500;
  function git(args, optional = false) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('Git evidence deadline');
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: Math.min(500, remaining), maxBuffer: 65536, windowsHide: true });
    if (result.error) throw new Error('Git evidence unavailable');
    if (optional && result.status === 1) return '';
    if (result.status !== 0) throw new Error('Git evidence unavailable');
    return result.stdout.trim();
  }
  try {
    for (const [key, allowed] of [[`remote.${remote}.mirror`, ['', 'false']], ['push.followTags', ['', 'false']],
      ['push.recurseSubmodules', ['', 'no']], [`remote.${remote}.receivepack`, ['']], ['push.pushOption', ['']]]) {
      if (!allowed.includes(git(['config', '--get-all', key], true))) return null;
    }
    const urls = git(['remote', 'get-url', '--push', '--all', remote]).split(/\r?\n/);
    if (urls.length !== 1) return null;
    const repository = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/.exec(urls[0]);
    if (!repository) return null;
    const commit = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return null;
    return { schema_version: 'osuite.git_publication.v1', repository: `github.com/${repository[1]}`, remote, branch,
      working_directory: realpathSync(cwd), push_url: urls[0], source_commit: commit, command };
  } catch { return null; }
}

export function validateGitPublication(context, payload) {
  try {
    const expected = JSON.parse(context.input_summary || '{}').git_publication;
    if (!expected) return true;
    const current = collectGitPublication(expected.command, expected.working_directory);
    const returned = payload?.action || payload;
    const actual = JSON.parse(returned?.input_summary || '{}').git_publication;
    return canonicalJson(expected) === canonicalJson(current) && canonicalJson(expected) === canonicalJson(actual);
  } catch { return false; }
}
