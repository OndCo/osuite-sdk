// Generated from sdk/runtime by hooks/build-node-runtime.mjs. Do not edit this distribution file.

// sdk/runtime/hook.mjs
import { randomUUID as randomUUID2 } from "node:crypto";

// sdk/runtime/protocol.mjs
import { createHash, createPrivateKey, sign } from "node:crypto";
var isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var sha256 = (value) => createHash("sha256").update(value).digest("hex");
var safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/.test(value) && !value.includes("..");
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function toolInputDigest(toolName, toolInput) {
  return sha256(canonicalJson({ tool_name: toolName || "", tool_input: toolInput ?? {} }));
}
function validatedBaseUrl(value, { allowInsecureHttp = false } = {}) {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || allowInsecureHttp))) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}
function createApiClient(config, { fetchImpl = globalThis.fetch, timeoutMs = 2500, maxResponseBytes = 262144 } = {}) {
  return {
    async request(method, endpoint, body, options = {}) {
      const baseUrl = validatedBaseUrl(config.baseUrl, config);
      if (!baseUrl) return { ok: false, status: 0, error: "invalid_base_url" };
      if (!config.apiKey) return { ok: false, status: 0, error: "not_configured" };
      if (typeof endpoint !== "string" || !endpoint.startsWith("/") || endpoint.startsWith("//")) {
        return { ok: false, status: 0, error: "invalid_endpoint" };
      }
      let payload;
      if (body !== void 0) {
        if (!isObject(body)) return { ok: false, status: 0, error: "invalid_request" };
        try {
          payload = JSON.parse(JSON.stringify(body));
        } catch {
          return { ok: false, status: 0, error: "invalid_request" };
        }
        if (!isObject(payload)) return { ok: false, status: 0, error: "invalid_request" };
        delete payload._signature;
        if (config.privateKeyBase64) {
          try {
            const key = createPrivateKey(Buffer.from(config.privateKeyBase64, "base64"));
            payload._signature = sign("sha256", Buffer.from(canonicalJson(payload)), key).toString("base64");
          } catch {
            return { ok: false, status: 0, error: "signing_unavailable" };
          }
        } else if (config.signatureMode === "required") {
          return { ok: false, status: 0, error: "signing_unavailable" };
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(options.timeoutMs ?? timeoutMs, 3e4)));
      let status = 0;
      try {
        const response = await fetchImpl(baseUrl + endpoint, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: { "content-type": "application/json", "x-api-key": config.apiKey },
          ...payload === void 0 ? {} : { body: JSON.stringify(payload) }
        });
        status = response.status;
        if (status < 200 || status >= 300) {
          await response.body?.cancel();
          return { ok: false, status, error: "http_error" };
        }
        const reader = response.body?.getReader();
        if (!reader) return { ok: false, status, error: "invalid_response" };
        const chunks = [];
        let length = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxResponseBytes) {
            await reader.cancel();
            return { ok: false, status, error: "invalid_response" };
          }
          chunks.push(Buffer.from(value));
        }
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return { ok: false, status, error: "invalid_response" };
        }
        if (!isObject(parsed)) return { ok: false, status, error: "invalid_response" };
        return { ok: true, status, body: parsed };
      } catch {
        return { ok: false, status, error: controller.signal.aborted ? "timeout" : "transport_failure" };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

// sdk/runtime/state.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
var MAX_STATE_BYTES = 2 * 1024 * 1024;
function checkedFile(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe runtime state file");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function createStateStore(config) {
  const root = path.resolve(config.stateDir || path.join(os.tmpdir(), `osuite-node-${process.getuid?.() ?? "user"}`));
  fs.mkdirSync(root, { recursive: true, mode: 448 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe runtime state directory");
  if (process.getuid && (rootStat.uid !== process.getuid() || rootStat.mode & 18)) {
    throw new Error("Runtime state directory is not owner-controlled");
  }
  const scope = sha256(canonicalJson({
    base_url: config.baseUrl || "",
    credential: sha256(config.apiKey || ""),
    agent_id: config.agentId || "",
    runtime_id: config.runtimeId || "",
    provider: config.provider || ""
  }));
  const filename = (name) => path.join(root, `osuite_${scope.slice(0, 24)}_${sha256(name)}.json`);
  const store = {
    path: filename,
    read(name) {
      const file = filename(name);
      if (!checkedFile(file)) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STATE_BYTES) throw new Error("Invalid runtime state file");
        return JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally {
        fs.closeSync(fd);
      }
    },
    write(name, value) {
      const file = filename(name);
      checkedFile(file);
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new Error("Runtime state too large");
      const pending2 = path.join(root, `.osuite_pending_${randomUUID()}`);
      let fd;
      try {
        fd = fs.openSync(pending2, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 384);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = void 0;
        checkedFile(file);
        fs.renameSync(pending2, file);
      } finally {
        if (fd !== void 0) fs.closeSync(fd);
        try {
          fs.unlinkSync(pending2);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    },
    remove(name) {
      const file = filename(name);
      if (checkedFile(file)) fs.unlinkSync(file);
    },
    update(name, transform) {
      const lock = `${filename(name)}.lock`;
      try {
        fs.mkdirSync(lock, { mode: 448 });
      } catch (error) {
        if (error.code === "EEXIST") throw new Error("Runtime state is busy");
        throw error;
      }
      try {
        const next = transform(store.read(name));
        store.write(name, next);
        return next;
      } finally {
        fs.rmdirSync(lock);
      }
    }
  };
  return store;
}

// sdk/runtime/config.mjs
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import path2 from "node:path";
function readDotenv(installDir, filename = ".env") {
  let fd;
  try {
    fd = openSync(path2.join(installDir, filename), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return {};
    const values = {};
    for (const line of readFileSync(fd, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?((?:OSUITE|DASHCLAW)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function loadRuntimeConfig({ installDir, env = process.env, host = "claude", runtimeId } = {}) {
  const plugin = runtimeId === "codex_plugin";
  const hardened = plugin || host === "cursor";
  const source = { ...installDir ? readDotenv(installDir) : {}, ...plugin && installDir ? readDotenv(installDir, ".env.osuite") : {}, ...env };
  const get = (name, fallback = "") => source[`OSUITE_${name}`] ?? source[`DASHCLAW_${name}`] ?? fallback;
  const number = (name, fallback, min, max) => {
    const value = Number(get(name, fallback));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const requestedMode = get("HOOK_MODE", host === "cursor" ? "observe" : "enforce");
  const mode = ["observe", "enforce", "strict"].includes(requestedMode) ? requestedMode : "strict";
  return {
    host,
    runtimeId: get("RUNTIME_ADAPTER_ID", runtimeId || (host === "cursor" ? "cursor_hooks" : host === "codex" ? "codex_hooks" : "claude_code_hooks")),
    agentId: get("AGENT_ID", plugin ? "codex-plugin-runtime" : host === "cursor" ? "cursor" : host === "codex" ? "codex" : "claude-code"),
    orgId: get("ORG_ID"),
    provider: get("RUNTIME_PROVIDER") || null,
    baseUrl: get("BASE_URL").replace(/\/+$/, ""),
    apiKey: get("API_KEY"),
    privateKeyBase64: get("PRIVATE_KEY_BASE64").trim(),
    signatureMode: get("SIGNATURE_MODE", hardened ? "required" : "workspace_key_optional"),
    mode,
    guardFailureMode: mode === "strict" ? "block" : get("GUARD_FAILURE_MODE", hardened ? "block" : "allow") === "allow" ? "allow" : "block",
    requireAssumptionCapture: get("REQUIRE_ASSUMPTION_CAPTURE") === "true",
    approvalTimeoutSeconds: number("APPROVAL_TIMEOUT_SECONDS", 300, 1, 3600),
    approvalWaitMs: number("APPROVAL_WAIT_SECONDS", 30, 0, 40) * 1e3,
    stopWaitMs: number("STOP_WAIT_SECONDS", 0, 0, 40) * 1e3,
    installCheck: get("HOOK_CHECK") === "1",
    installChannel: get("INSTALL_CHANNEL", plugin ? "plugin" : "project_settings"),
    settingsScope: get("SETTINGS_SCOPE", plugin ? "managed" : "project"),
    trustedProjectRequired: get("TRUSTED_PROJECT_REQUIRED", hardened ? "true" : "false") === "true",
    runtimeSessionId: get("RUNTIME_SESSION_ID"),
    runtimePermissionMode: get("RUNTIME_PERMISSION_MODE"),
    stateDir: get("STATE_DIR") || void 0,
    captureToolInput: get("CAPTURE_TOOL_INPUT", "summary"),
    allowInsecureHttp: get("ALLOW_INSECURE_HTTP") === "1"
  };
}

// sdk/runtime/posture.mjs
import { createHmac, timingSafeEqual } from "node:crypto";
var POSTURE_SCHEMA = "osuite.runtime_posture.v1";
var MAX_FRESHNESS_MS = 3e5;
var MODE_STRENGTH = { observe: 0, enforce: 1, strict: 2 };
function localPosture(config) {
  return {
    runtime_id: config.runtimeId,
    mode: Object.hasOwn(MODE_STRENGTH, config.mode) ? config.mode : "enforce",
    on_guard_unavailable: config.guardFailureMode === "block" || config.mode === "strict" ? "block" : "allow",
    require_signature: config.signatureMode === "required",
    require_assumption_capture: config.requireAssumptionCapture === true,
    approval_timeout_seconds: config.approvalTimeoutSeconds || 600
  };
}
function offlinePosture(local, cached) {
  if (!cached) return local;
  return {
    ...cached,
    mode: MODE_STRENGTH[local.mode] > MODE_STRENGTH[cached.mode] ? local.mode : cached.mode,
    on_guard_unavailable: local.on_guard_unavailable === "block" || cached.on_guard_unavailable === "block" ? "block" : "allow",
    require_signature: local.require_signature || cached.require_signature,
    require_assumption_capture: local.require_assumption_capture || cached.require_assumption_capture,
    approval_timeout_seconds: Math.min(local.approval_timeout_seconds, cached.approval_timeout_seconds)
  };
}
function validDocument(value, config, now, allowExpired = false) {
  if (!isObject(value) || value.schema_version !== POSTURE_SCHEMA || value.runtime_id !== config.runtimeId) return false;
  if (typeof value.org_id !== "string" || !value.org_id || typeof value.credential_id !== "string" || !value.credential_id) return false;
  if (config.orgId && config.orgId !== value.org_id) return false;
  if (value.credential_fingerprint !== sha256(config.apiKey || "")) return false;
  if (value.targeting?.agent_id !== config.agentId || (value.targeting?.provider || null) !== (config.provider || null)) return false;
  if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) return false;
  const posture = value.posture;
  if (!isObject(posture) || posture.runtime_id !== config.runtimeId || !Object.hasOwn(MODE_STRENGTH, posture.mode)) return false;
  if (!["allow", "block"].includes(posture.on_guard_unavailable)) return false;
  if (typeof posture.require_signature !== "boolean" || typeof posture.require_assumption_capture !== "boolean") return false;
  if (!Number.isSafeInteger(posture.approval_timeout_seconds) || posture.approval_timeout_seconds < 1 || posture.approval_timeout_seconds > 3600) return false;
  const issued = Date.parse(value.issued_at);
  const until = Date.parse(value.valid_until);
  return Number.isFinite(issued) && Number.isFinite(until) && issued <= now + 3e4 && until > issued && until - issued <= MAX_FRESHNESS_MS && (allowExpired || until > now);
}
function configurationOnly(document) {
  return Object.fromEntries([
    "schema_version",
    "runtime_id",
    "org_id",
    "credential_id",
    "credential_fingerprint",
    "targeting",
    "posture",
    "revision",
    "issued_at",
    "valid_until"
  ].map((key) => [key, document[key]]));
}
function mac(document, config) {
  return createHmac("sha256", config.apiKey || "").update("osuite.posture-cache.v1\n").update(canonicalJson(document)).digest("hex");
}
function cachedDocument(value, config, now) {
  try {
    if (!isObject(value) || !validDocument(value.document, config, now, true) || !/^[a-f0-9]{64}$/.test(value.mac)) return null;
    if (!timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(mac(value.document, config), "hex"))) return null;
    return value.document;
  } catch {
    return null;
  }
}
function readCache(store, config, now) {
  try {
    return cachedDocument(store.read("posture"), config, now);
  } catch {
    return null;
  }
}
async function resolveRemotePosture(config, { api, store, now = Date.now() }) {
  const query = new URLSearchParams({ agent_id: config.agentId });
  if (config.provider) query.set("provider", config.provider);
  const response = await api.request("GET", `/api/runtimes/${encodeURIComponent(config.runtimeId)}/posture?${query}`, void 0, { timeoutMs: 2e3 });
  let cached = readCache(store, config, now);
  if (response.ok && response.status === 200 && validDocument(response.body, config, now) && (!cached || Date.parse(response.body.issued_at) >= Date.parse(cached.issued_at))) {
    const document = configurationOnly(response.body);
    try {
      const saved = store.update("posture", (value) => {
        const latest = cachedDocument(value, config, now);
        return latest && Date.parse(latest.issued_at) > Date.parse(document.issued_at) ? value : { document, mac: mac(document, config) };
      });
      cached = cachedDocument(saved, config, now);
      if (cached && canonicalJson(cached) === canonicalJson(document)) {
        return { available: true, blocked: false, source: "remote", posture: document.posture, revision: document.revision };
      }
    } catch {
      const posture2 = offlinePosture(offlinePosture(localPosture(config), readCache(store, config, now)?.posture), document.posture);
      return { available: false, blocked: posture2.mode !== "observe", source: "unavailable", posture: posture2, revision: cached?.revision || null };
    }
  }
  const posture = offlinePosture(localPosture(config), cached?.posture);
  if (response.status !== 401 && response.status !== 403 && cached && Date.parse(cached.valid_until) > now) {
    return { available: true, blocked: false, source: "cache", posture, revision: cached.revision };
  }
  return { available: false, blocked: posture.mode !== "observe", source: "unavailable", posture, revision: cached?.revision || null };
}

// sdk/runtime/shell.mjs
import path3 from "node:path";
var basename = (token) => path3.basename(String(token || "")).toLowerCase();
var set = (text) => new Set(text.split(" "));
var shells = set("sh bash zsh dash");
var gitValueFlags = set("-C -c --git-dir --work-tree --namespace --exec-path --config-env");
var protectedRef = (ref) => /^(?:(?:refs\/heads\/)?(?:main|master|prod|production|stable)|(?:refs\/heads\/)?release(?:\/.*)?)$/.test(ref || "");
function parseShell(command) {
  const segments = [], errors = [];
  let current = "", quote = null, started = false, segment = [], operator = null;
  const flush = () => {
    if (started) {
      segment.push(current);
      current = "";
      started = false;
      operator = null;
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\\") {
      if (i + 1 === command.length) {
        errors.push("dangling_escape");
        break;
      }
      const next = command[i + 1];
      if (quote === '"' && !'$`"\\\n'.includes(next)) {
        current += char;
        continue;
      }
      i += 1;
      if (next !== "\n") {
        current += next;
        started = true;
      }
      continue;
    }
    if ("$`".includes(char)) errors.push("unsupported_expansion");
    if (quote === '"') {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (`"'`.includes(char)) {
      quote = char;
      started = true;
      continue;
    }
    if (char === "#" && !started) {
      errors.push("unsupported_comment");
      while (i < command.length && command[i] !== "\n") i += 1;
      continue;
    }
    if (char === "<" && command[i + 1] === "<") {
      errors.push("unsupported_heredoc");
      break;
    }
    if ("*?[".includes(char)) errors.push("unsupported_glob_expansion");
    if ("<>(){}".includes(char)) errors.push("unsupported_shell_syntax");
    if (char === "&" && command[i + 1] !== "&") errors.push("unsupported_background");
    const separator = ";|\n".includes(char) || char === "&" && command[i + 1] === "&";
    if (separator || /\s/.test(char)) {
      flush();
      if (separator) {
        const nextOperator = (char === "&" || char === "|") && command[i + 1] === char ? char + command[++i] : char;
        if (segment.length) segments.push(segment);
        else if (nextOperator !== "\n") errors.push("empty_segment");
        segment = [];
        operator = nextOperator;
      }
    } else {
      current += char;
      started = true;
    }
  }
  flush();
  if (segment.length) segments.push(segment);
  if (quote) errors.push("unclosed_quote");
  if (["&&", "||", "|"].includes(operator)) errors.push("missing_operand");
  return { segments, errors: [...new Set(errors)] };
}
function unwrap(tokens) {
  let argv = [...tokens];
  for (let depth = 0; depth < 8 && argv.length; depth += 1) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] || "")) argv.shift();
    const exe = basename(argv[0]);
    if (set("command builtin noglob").has(exe)) {
      argv.shift();
      while ((argv[0] || "").startsWith("-")) argv.shift();
      continue;
    }
    if (!set("env sudo doas").has(exe)) break;
    argv.shift();
    const valueFlags = exe === "env" ? set("-u --unset -C --chdir -S --split-string") : set("-u -g -h -p -C -T");
    while (argv.length && (argv[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))) {
      const flag = argv.shift();
      if (flag === "-S" || flag.startsWith("--split-string")) return [];
      if (valueFlags.has(flag)) argv.shift();
      if (flag === "--") break;
    }
  }
  return argv;
}
function result(type, risk, reversible, canonical) {
  return {
    action_type: type,
    risk_score: risk,
    reversible,
    systems_touched: canonical.systems_touched,
    summary: {
      tool_name: canonical.executable,
      tool_category: canonical.tool_category,
      canonical_action: canonical,
      action_fingerprint: sha256(canonicalJson(canonical)).slice(0, 32),
      classification_source: "osuite_shell_semantics",
      classification_status: canonical.classification_status || "complete"
    }
  };
}
function incomplete(argv, cwd, reasons) {
  return result("review", 40, null, {
    runtime: "bash",
    executable: basename(argv[0]) || "shell",
    operation: argv.slice(1).join(" "),
    tool_category: "other",
    cwd,
    systems_touched: ["shell"],
    classification_status: "incomplete",
    uncertainty_reasons: reasons,
    command_commitment: sha256(canonicalJson(argv)).slice(0, 32)
  });
}
function boundedObservation(exe, args) {
  const switches = {
    rg: set("--files --hidden --no-ignore --no-ignore-vcs --no-ignore-dot --follow --fixed-strings --ignore-case --case-sensitive --smart-case --line-number --files-with-matches --files-without-match --count --count-matches --only-matching --quiet --word-regexp --line-regexp --no-heading --heading --with-filename --no-filename --text --multiline --pcre2 --stats --sort-files --no-messages"),
    sed: set("-n -E --quiet --silent --regexp-extended"),
    jq: set("-r -c -e -s -n -R -S -M -C --raw-output --compact-output --exit-status --slurp --null-input --raw-input --sort-keys --monochrome-output --color-output")
  }[exe];
  const values = { rg: set("-g --glob --iglob -e --regexp -t --type -T --type-not --max-count -m --max-depth --encoding --color --context -C --after-context -A --before-context -B"), sed: set("-e --expression"), jq: set("--arg --argjson") }[exe];
  const operands = [], expressions = [];
  let flags = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      flags = false;
      continue;
    }
    if (flags && arg.startsWith("-")) {
      if (switches.has(arg) || exe === "rg" && /^-[niFlovqwsSHh]+$/.test(arg)) continue;
      const flag = arg.split("=")[0];
      if (!values.has(flag)) return false;
      const count = exe === "jq" ? 2 : 1;
      if (arg.includes("=")) {
        if (exe === "sed") expressions.push(arg.slice(arg.indexOf("=") + 1));
        continue;
      }
      if (i + count >= args.length) return false;
      if (exe === "sed") expressions.push(args[i + 1]);
      i += count;
    } else operands.push(arg);
  }
  if (exe === "sed") {
    if (!expressions.length) expressions.push(operands[0] || "");
    return expressions.every((value) => /^(?:(?:[0-9]+(?:,(?:[0-9]+|\$))?|\$))?p$/.test(value));
  }
  return true;
}
function classifyArgv(tokens, cwd, depth) {
  const argv = unwrap(tokens), exe = basename(argv[0]), args = argv.slice(1);
  if (!exe) return incomplete(tokens, cwd, ["unsupported_wrapper"]);
  if (shells.has(exe)) {
    const index = args.findIndex((arg) => /^-[a-z]*c$/.test(arg));
    return index >= 0 && typeof args[index + 1] === "string" && depth < 4 ? classifyShell(args[index + 1], cwd, depth + 1) : incomplete(argv, cwd, ["unsupported_shell_invocation"]);
  }
  const canonical = { runtime: "bash", executable: exe, operation: args[0] || "", tool_category: "other", cwd, systems_touched: [exe] };
  const classified = (type, risk, reversible, category = "deployment") => result(type, risk, reversible, { ...canonical, tool_category: category });
  if (exe === "git") {
    let index = 0;
    while (index < args.length && args[index].startsWith("-")) {
      const flag = args[index++];
      if (gitValueFlags.has(flag)) index += 1;
    }
    const operation = args[index], rest = args.slice(index + 1);
    canonical.operation = operation || "";
    if (set("push merge rebase reset").has(operation)) {
      const positional = rest.filter((value) => !value.startsWith("-"));
      canonical.remote = positional[0] || null;
      canonical.ref = positional[1] || null;
      const destructive = rest.some((arg) => ["--force", "--delete", "-f", "-d", "--mirror", "--all"].includes(arg) || arg.startsWith("--force-with-lease") || arg.startsWith(":"));
      return classified("deploy", destructive ? 92 : protectedRef(canonical.ref) ? 80 : 62, false);
    }
    const risks = { status: 10, log: 10, branch: 10, show: 12, remote: 14, diff: 18 };
    if (operation === "branch" && rest.some((arg) => !arg.startsWith("-")) && !rest.includes("--list") || operation === "branch" && rest.some((arg) => /^-(?:[dDmMcC]|-delete|-move|-copy)/.test(arg)) || operation === "remote" && rest.some((arg) => !arg.startsWith("-"))) return incomplete(argv, cwd, ["git_mutation_not_classified"]);
    if (risks[operation] !== void 0) return classified("monitor", risks[operation], true, "observation");
    return incomplete(argv, cwd, ["unsupported_git_operation"]);
  }
  if (set("rg sed jq").has(exe)) return boundedObservation(exe, args) ? classified("other", 20, true, "observation") : incomplete(argv, cwd, ["unbounded_observation"]);
  if (exe === "rm" && args.slice(0, args.indexOf("--") < 0 ? void 0 : args.indexOf("--")).some((arg) => /^-[rf]+$/.test(arg) && arg.includes("r") && arg.includes("f"))) return classified("security", 90, false);
  if (exe === "npm" && args[0] === "run" && args[1] === "deploy") return classified("deploy", 75, false);
  if (exe === "npm" && args[0] === "run" && args[1] === "build" || set("npm pip pip3").has(exe) && args[0] === "install" || exe === "yarn" && args[0] === "add") return classified("build", 30, true, "build");
  if (set("vercel netlify heroku railway fly").has(exe) && args.includes("deploy")) return classified("deploy", 75, false);
  if (exe === "kubectl") {
    if (set("api-resources api-versions cluster-info describe diff explain get logs top version").has(args[0])) return classified("monitor", 28, true, "observation");
    if (set("annotate apply autoscale cordon create delete drain edit label patch replace rollout scale set taint uncordon").has(args[0])) return classified("deploy", 85, false);
    return incomplete(argv, cwd, ["unsupported_kubectl_operation"]);
  }
  const infra = {
    terraform: [set("fmt graph output plan providers show validate version workspace"), 38, set("apply destroy force-unlock import init state taint untaint"), 90, 78],
    helm: [set("diff get history lint list show status template test version"), 36, set("install rollback uninstall upgrade"), 84, 72],
    pulumi: [set("about preview stack version whoami"), 38, set("cancel destroy import refresh up"), 88, 76]
  }[exe];
  if (infra) return infra[0].has(args[0]) ? classified("review", infra[1], true, "planning") : classified("deploy", infra[2].has(args[0]) ? infra[3] : infra[4], false);
  if (set("ansible ansible-playbook").has(exe)) return args.some((arg) => set("--check --diff -C").has(arg)) ? classified("review", 40, true, "planning") : classified("deploy", 82, false);
  if (exe === "az") {
    canonical.raw_operation = args.join(" ");
    if (args[0] === "keyvault" && args[1] === "secret") {
      canonical.operation = args.slice(0, 3).join(" ");
      canonical.systems_touched = ["azure-keyvault"];
      const read = set("backup download list show").has(args[2]);
      return classified("security", read ? 74 : 88, read, "secret_access");
    }
    if (args[0] === "role" && args[1] === "assignment") return classified("security", 86, false, "access_control");
    const unknown = incomplete(argv, cwd, ["unresolved_azure_scope"]);
    return args.includes("delete") ? { ...unknown, action_type: "security", risk_score: 90, reversible: false } : unknown;
  }
  return incomplete(argv, cwd, ["unsupported_executable"]);
}
function classifyShell(command, cwd = "", depth = 0) {
  const parsed = parseShell(command);
  const results = parsed.segments.map((argv) => classifyArgv(argv, cwd, depth));
  if (parsed.errors.length || !results.length) results.push(incomplete([command], cwd, parsed.errors.length ? parsed.errors : ["empty_command"]));
  if (results.length === 1) return results[0];
  const primary = [...results].sort((a, b) => b.risk_score - a.risk_score || Number(b.reversible === false) - Number(a.reversible === false))[0];
  return {
    ...primary,
    reversible: results.some((value) => value.reversible === false) ? false : results.some((value) => value.reversible === null) ? null : true,
    systems_touched: [...new Set(results.flatMap((value) => value.systems_touched))],
    summary: {
      ...primary.summary,
      canonical_actions: results.map((value) => value.summary.canonical_action),
      classification_status: results.some((value) => value.summary.classification_status === "incomplete") ? "incomplete" : "complete",
      compound_command_commitment: sha256(command).slice(0, 32)
    }
  };
}

// sdk/runtime/git.mjs
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
function collectGitPublication(command, cwd = process.cwd(), env = process.env) {
  const match = /^git push ([A-Za-z0-9][A-Za-z0-9_-]*) ([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(command);
  if (!match || match[0] !== command || ["GIT_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].some((key) => env[key])) return null;
  const [, remote, branch] = match;
  const deadline = performance.now() + 1500;
  function git(args, optional = false) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error("Git evidence deadline");
    const result3 = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: Math.min(500, remaining), maxBuffer: 65536, windowsHide: true });
    if (result3.error) throw new Error("Git evidence unavailable");
    if (optional && result3.status === 1) return "";
    if (result3.status !== 0) throw new Error("Git evidence unavailable");
    return result3.stdout.trim();
  }
  try {
    for (const [key, allowed] of [
      [`remote.${remote}.mirror`, ["", "false"]],
      ["push.followTags", ["", "false"]],
      ["push.recurseSubmodules", ["", "no"]],
      [`remote.${remote}.receivepack`, [""]],
      ["push.pushOption", [""]]
    ]) {
      if (!allowed.includes(git(["config", "--get-all", key], true))) return null;
    }
    const urls = git(["remote", "get-url", "--push", "--all", remote]).split(/\r?\n/);
    if (urls.length !== 1) return null;
    const repository = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/.exec(urls[0]);
    if (!repository) return null;
    const commit = git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return null;
    return {
      schema_version: "osuite.git_publication.v1",
      repository: `github.com/${repository[1]}`,
      remote,
      branch,
      working_directory: realpathSync(cwd),
      push_url: urls[0],
      source_commit: commit,
      command
    };
  } catch {
    return null;
  }
}
function validateGitPublication(context, payload) {
  try {
    const expected = JSON.parse(context.input_summary || "{}").git_publication;
    if (!expected) return true;
    const current = collectGitPublication(expected.command, expected.working_directory);
    const returned = payload?.action || payload;
    const actual = JSON.parse(returned?.input_summary || "{}").git_publication;
    return canonicalJson(expected) === canonicalJson(current) && canonicalJson(expected) === canonicalJson(actual);
  } catch {
    return false;
  }
}

// sdk/runtime/context.mjs
var contentKeys = /* @__PURE__ */ new Set(["content", "new_string", "old_string", "new_source", "old_source", "file_text", "patch", "diff", "input"]);
var publicHosts = /* @__PURE__ */ new Set(["file.io", "transfer.sh", "0x0.st", "pastebin.com", "gofile.io", "wetransfer.com", "tmpfiles.org"]);
var contentSummary = (value) => {
  const raw = typeof value === "string" ? value : canonicalJson(value);
  return { length: [...raw].length, sha256: sha256(raw) };
};
function summarizeToolInput(input, capture = "summary") {
  if (capture === "full") return input;
  if (!isObject(input)) return contentSummary(input);
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    contentKeys.has(key) ? contentSummary(value) : key === "edits" && Array.isArray(value) ? { count: value.length, ...contentSummary(value) } : typeof value === "string" ? value.length <= 500 ? value : { ...contentSummary(value) } : value !== null && typeof value === "object" ? contentSummary(value) : value
  ]));
}
function deriveToolUseId(data) {
  const explicit = data.tool_use_id ?? data.event_id ?? data.id;
  if ((typeof explicit === "string" || typeof explicit === "number") && String(explicit)) return String(explicit);
  return `tool_${sha256(canonicalJson({ session_id: data.session_id || "", tool_name: data.tool_name || "", tool_input: data.tool_input ?? {} })).slice(0, 32)}`;
}
function deriveSessionId(data, config) {
  const explicit = data.session_id || config.runtimeSessionId;
  if (explicit) {
    if (!safeId(String(explicit)) || String(explicit).length > 128) throw new Error("Invalid runtime session evidence");
    return String(explicit);
  }
  return `sess_${sha256(canonicalJson([config.agentId, config.runtimeId, data.cwd || process.cwd()])).slice(0, 32)}`;
}
function autonomySignal(data, config) {
  const raw = String(data.runtime_permission_mode || data.runtimePermissionMode || data.permission_mode || data.permissionMode || config.runtimePermissionMode || "").replace(/[- _]/g, "").toLowerCase();
  const mode = {
    default: "manual",
    manual: "manual",
    ask: "manual",
    askfirst: "manual",
    prompt: "manual",
    confirm: "manual",
    acceptedits: "accept_edits",
    accepteditsmode: "accept_edits",
    bypass: "bypass",
    bypasspermissions: "bypass",
    dangerouslyskippermissions: "bypass",
    auto: "auto",
    automode: "auto",
    automatic: "auto",
    autonomous: "auto",
    plan: "plan",
    planning: "plan",
    readonly: "plan"
  }[raw] || "unknown";
  return {
    runtime_permission_mode: mode,
    runtime_permission_decision: { manual: "manual_prompt_required", accept_edits: "edit_acceptance_mode", bypass: "permissions_bypassed", auto: "auto_mode_observed", plan: "plan_only" }[mode] || "unknown",
    runtime_permission_source: config.host === "claude" ? "claude_code" : config.host,
    runtime_autonomy_level: { manual: "human_prompted", accept_edits: "bounded_edit_autonomy", bypass: "runtime_permission_bypass", auto: "runtime_classifier", plan: "no_side_effects_expected" }[mode] || "unknown"
  };
}
function genericContext(tool2, input, capture = "summary") {
  const serialized = canonicalJson(input), lower = `${tool2} ${serialized}`.toLowerCase();
  let host = "";
  try {
    host = new URL(serialized.match(/https?:\/\/[^\s"\\<>]+/)?.[0]).hostname.toLowerCase();
  } catch {
  }
  const sensitive = [];
  if (/customer|client.data|user.data|personal.data|\bpii\b/.test(lower)) sensitive.push("customer_data");
  if (/credential|secret|api[_ -]?key|private[_ -]?key|password/.test(lower)) sensitive.push("credentials");
  if (/source.code|proprietary|internal.document/.test(lower)) sensitive.push("internal_data");
  let risk = /upload|share|publish|export|send|attach|link/.test(lower) ? 35 : 10;
  const summary = { tool_name: tool2, tool_category: "tool_observation", tool_input_summary: summarizeToolInput(input, capture) };
  if (host) {
    summary.endpoint_host = host;
    summary.tool_category = "network_egress";
    summary.persists_remote = true;
    summary.destination_type = publicHosts.has(host) ? "public_file_host" : /notion|drive|dropbox|slack|confluence|jira|mcp/.test(lower) ? "external_workspace" : "public_api";
    summary.destination_visibility = publicHosts.has(host) ? "external_public" : "external_private";
    risk = Math.max(risk, publicHosts.has(host) ? 70 : summary.destination_type === "external_workspace" ? 45 : 40);
  }
  if (/public link|publicly accessible|anyone with the link|public upload/.test(lower)) {
    summary.destination_type ||= "public_share_link";
    summary.destination_visibility = "external_public";
    summary.persists_remote = true;
    risk = Math.max(risk, 75);
  }
  if (/notion|google drive|dropbox|slack|confluence|jira/.test(lower)) {
    summary.destination_type ||= "external_workspace";
    summary.destination_visibility ||= "external_private";
    summary.persists_remote = true;
  }
  const extra = {};
  if (/okta|cloudtrail|mfa|sign.in|access log|security log|audit log/.test(lower)) {
    summary.payload_class = "identity_security_logs";
    risk = Math.max(risk, 65);
    Object.assign(extra, { personal_data_likelihood: 75, privacy_review_required: true, data_minimization_declared: false, authorization_scope: "identity.logs.export external.processor.share" });
    if (summary.destination_type || /vendor|forensic|third.party/.test(lower)) extra.external_data_processors = ["approved_external_vendor"];
  } else if (sensitive.length) {
    extra.personal_data_likelihood = sensitive.includes("customer_data") ? 55 : 35;
    if (summary.destination_type) {
      risk = Math.max(risk, 50);
      Object.assign(extra, { privacy_review_required: true, data_minimization_declared: false, authorization_scope: "external.share review_required" });
    }
  }
  if (sensitive.length) {
    summary.sensitive_categories = sensitive;
    extra.sensitive_data_categories = sensitive;
  }
  return { action_type: risk >= 35 ? "api" : "other", risk_score: risk, reversible: true, systems_touched: ["tool_runtime", tool2, ...host ? [host] : []], summary, ...extra };
}
function buildActionContext(data, config) {
  if (!isObject(data) || typeof data.tool_name !== "string" || !data.tool_name || data.tool_name.length > 128 || !safeId(config.agentId) || config.agentId.length > 128) throw new Error("Invalid tool invocation evidence");
  const tool2 = data.tool_name, input = data.tool_input ?? {}, objectInput = isObject(input) ? input : {};
  let mapped, goal;
  if (tool2 === "Bash" || config.host === "cursor" && tool2 === "Shell") {
    if (typeof objectInput.command !== "string" || !objectInput.command) throw new Error("Missing Bash command evidence");
    if (config.host === "cursor" && objectInput.working_directory !== void 0 && (typeof objectInput.working_directory !== "string" || !objectInput.working_directory || objectInput.working_directory.includes("\0"))) throw new Error("Invalid Shell working directory");
    const cwd = config.host === "cursor" ? objectInput.working_directory || data.cwd || process.cwd() : data.cwd || process.cwd();
    goal = `${tool2}: ${objectInput.command}`;
    mapped = classifyShell(objectInput.command, cwd);
    const publication = collectGitPublication(objectInput.command, cwd);
    if (publication) mapped.summary.git_publication = publication;
    const external = genericContext(tool2, input, config.captureToolInput);
    if (external.summary.destination_type || external.sensitive_data_categories?.length) {
      mapped = { ...external, ...mapped, risk_score: Math.max(mapped.risk_score, external.risk_score), summary: { ...external.summary, ...mapped.summary } };
    }
  } else if (["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"].includes(tool2)) {
    const file = objectInput.path || objectInput.file_path || objectInput.notebook_path || "unknown";
    goal = `${tool2}: ${file}`;
    const lower = String(file).toLowerCase();
    const type = /\.env|secret|credential|private_key|id_rsa/.test(lower) ? ["security", 85, true] : /migration|schema|seed/.test(lower) ? ["migrate", 70, false] : /deploy|infra|terraform|kubernetes|k8s/.test(lower) ? ["deploy", 75, true] : /auth|login|oauth|jwt|token|password/.test(lower) ? ["security", 75, true] : ["other", 15, true];
    mapped = { action_type: type[0], risk_score: type[1], reversible: type[2], systems_touched: ["filesystem"], summary: { tool_input_summary: summarizeToolInput(input, config.captureToolInput) } };
    if (tool2 === "apply_patch") {
      mapped.action_type = "review";
      mapped.risk_score = 40;
      mapped.summary.classification_status = "incomplete";
    }
  } else {
    mapped = genericContext(tool2, input, config.captureToolInput);
    goal = `${tool2}: ${canonicalJson(summarizeToolInput(input)).slice(0, 120)}`;
  }
  if (goal.length > 2e3) throw new Error("Tool evidence exceeds declared_goal schema; not truncated");
  const { summary, reversible, ...fields } = mapped;
  const signal = autonomySignal(data, config);
  const context = {
    ...fields,
    ...typeof reversible === "boolean" ? { reversible } : {},
    agent_id: config.agentId,
    declared_goal: goal,
    runtime_session_id: deriveSessionId(data, config),
    tool_use_id: deriveToolUseId(data),
    tool_input_digest: toolInputDigest(tool2, input),
    runtime_family: "tool_hook_runtime",
    adapter_mode: "hook",
    install_channel: config.installChannel,
    settings_scope: config.settingsScope,
    trusted_project_required: config.trustedProjectRequired === true,
    ...signal,
    input_summary: JSON.stringify({ ...summary, ...signal, runtime_adapter_id: config.runtimeId, runtime_family: "tool_hook_runtime", adapter_mode: "hook" })
  };
  if (context.input_summary.length > 4e3 || context.tool_use_id.length > 128 || !safeId(context.tool_use_id)) throw new Error("Tool evidence exceeds action schema; not truncated");
  if (config.installCheck) context.health_check = true;
  return context;
}

// sdk/runtime/admission.mjs
import { setTimeout as delay } from "node:timers/promises";
var REVIEW_DECISIONS = /* @__PURE__ */ new Set(["require_approval", "require_dual_approval"]);
var DECISIONS = /* @__PURE__ */ new Set(["allow", "warn", "block", ...REVIEW_DECISIONS]);
var closed = (reason, extra = {}) => ({ authorized: false, decision: "block", reason, retryAutomatically: false, ...extra });
function approvalReceipts(payload) {
  const action = payload?.action || payload || {};
  return [
    action.approval_receipts,
    action.proof_bundle?.approval_receipts,
    payload?.approval_receipts,
    payload?.contracts?.proof_bundle?.approval_receipts
  ].flatMap((value) => Array.isArray(value) ? value.filter(isObject) : []);
}
function cavaFingerprint(payload) {
  return [
    payload?.contracts?.action_envelope?.cava?.fingerprint,
    payload?.contracts?.proof_bundle?.action_envelope?.cava?.fingerprint,
    payload?.action?.action_envelope?.cava?.fingerprint,
    payload?.action?.proof_bundle?.action_envelope?.cava?.fingerprint,
    payload?.action_envelope?.cava?.fingerprint,
    payload?.proof_bundle?.action_envelope?.cava?.fingerprint
  ].find((value) => typeof value === "string" && value.trim()) || null;
}
function matchesAction(payload, context, { actionId = null, fingerprint = null } = {}) {
  const action = payload?.action || payload;
  if (!isObject(action) || !safeId(action.action_id)) return false;
  if (actionId && action.action_id !== actionId) return false;
  if (payload.action_id && payload.action_id !== action.action_id) return false;
  if (action.tool_input_digest && action.tool_input_digest !== context.tool_input_digest) return false;
  if (action.agent_id && action.agent_id !== context.agent_id) return false;
  if (action.runtime_session_id && action.runtime_session_id !== context.runtime_session_id) return false;
  for (const envelope of [action.action_envelope, payload.contracts?.action_envelope]) {
    if (envelope?.runtime_session_id !== void 0 && envelope.runtime_session_id !== context.runtime_session_id) return false;
  }
  if (fingerprint) {
    const receipts = approvalReceipts(payload).filter((receipt) => ["allow", "approved", "approve"].includes(receipt.decision || receipt.status));
    const fingerprints = receipts.flatMap((receipt) => {
      const scope = receipt.approval_scope || {};
      if (scope.reusable === true || (receipt.action_id || scope.action_id) !== action.action_id) return [];
      return [receipt.canonical_fingerprint || scope.canonical_fingerprint].filter(Boolean);
    });
    if (fingerprints.length ? !fingerprints.includes(fingerprint) : cavaFingerprint(payload) !== fingerprint) return false;
  }
  return true;
}
function approvalTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}
function confirmedRedemption({ action, approval }) {
  if (approval?.state !== "approved" || approval.reused !== true || action.approval_decision !== "allow" || typeof action.approved_by !== "string" || !action.approved_by.trim()) return false;
  const approvedAt = approvalTime(action.approved_at);
  const redeemedAt = approvalTime(action.approval_redeemed_at);
  const expiresAt = approvalTime(action.approval_expires_at);
  const now = Date.now();
  if (![approvedAt, redeemedAt, expiresAt].every(Number.isFinite) || approvedAt > redeemedAt || redeemedAt > now || expiresAt <= now) return false;
  if (approval.decided_by !== void 0 && approval.decided_by !== action.approved_by) return false;
  if (approval.decided_at !== void 0 && approvalTime(approval.decided_at) !== approvedAt) return false;
  if (approval.expires_at !== void 0 && approvalTime(approval.expires_at) !== expiresAt) return false;
  return true;
}
function actionAdmission(payload, requestedDecision, context, expected = {}) {
  if (!isObject(payload) || payload.error || !isObject(payload.action) || !safeId(payload.action_id) || payload.action.action_id !== payload.action_id || !matchesAction(payload, context)) return closed("action_creation_not_authorized");
  const actionId = payload.action_id;
  const action = payload.action;
  const decision = payload.decision?.decision;
  const base = { actionId, response: payload };
  if (!DECISIONS.has(decision) || !["running", "pending_approval"].includes(action.status) || payload.status !== void 0 && payload.status !== action.status || action.timestamp_end != null || ["denied", "expired"].includes(payload.approval?.state) || requestedDecision === "block" || decision === "block") return closed("action_creation_not_authorized", base);
  if (action.status === "pending_approval") return { ...base, authorized: false, decision: "require_approval", reason: "awaiting_approval" };
  if (REVIEW_DECISIONS.has(decision) || REVIEW_DECISIONS.has(requestedDecision)) {
    if (!confirmedRedemption(payload) || !matchesAction(payload, context, expected)) return closed("approval_not_confirmed", base);
    return { ...base, authorized: true, decision: "approved_by_reviewer" };
  }
  return { ...base, authorized: true, decision: decision === "warn" || requestedDecision === "warn" ? "warn" : "allow" };
}
function installCheck(payload, context) {
  if (!context.health_check || payload?.approval?.state !== "not_requested") return null;
  if (payload.error || !safeId(payload.action_id) || payload.action?.action_id !== payload.action_id || payload.action?.status !== "cancelled" || payload.status !== void 0 && payload.status !== "cancelled" || !REVIEW_DECISIONS.has(payload.decision?.decision)) return closed("invalid_install_check");
  return { authorized: false, decision: payload.decision.decision, installCheck: true, reason: "approval_not_requested", response: payload };
}
async function admitAction(context, { api, config, sleep = delay, now = () => performance.now(), beforeRelease = async () => true } = {}) {
  const guard = await api.request("POST", "/api/guard", context);
  if (!guard.ok) {
    const failOpen = config.guardFailureMode === "allow" && ![401, 403].includes(guard.status) && !["signing_unavailable", "invalid_response", "invalid_request"].includes(guard.error);
    return { ...closed("guard_unavailable"), decision: failOpen ? "allow" : "block", degraded: true };
  }
  const requestedDecision = guard.body?.decision;
  if (!DECISIONS.has(requestedDecision)) return closed("unsupported_guard_decision");
  if (requestedDecision === "block") {
    if (config.mode === "observe") await api.request("POST", "/api/actions", { ...context, status: "blocked" });
    return { ...closed("policy_block"), observeOnly: config.mode === "observe", response: guard.body };
  }
  const created = await api.request("POST", "/api/actions", {
    ...context,
    status: REVIEW_DECISIONS.has(requestedDecision) ? "pending_approval" : "running"
  });
  if (!created.ok) return closed("admission_unconfirmed");
  const diagnostic = installCheck(created.body, context);
  if (diagnostic) return diagnostic;
  let result3 = actionAdmission(created.body, requestedDecision, context);
  if (result3.authorized) return await beforeRelease(result3.response) ? result3 : closed("action_evidence_changed");
  if (result3.decision !== "require_approval") return result3;
  if (config.mode === "observe") return { ...result3, observeOnly: true };
  const expected = { actionId: result3.actionId, fingerprint: cavaFingerprint(created.body) };
  const waitMs = Math.max(0, Math.min(config.approvalWaitMs ?? 3e4, 6e5));
  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(Math.min(3e3, Math.max(0, deadline - now())));
    const polled = await api.request("GET", `/api/actions/${encodeURIComponent(expected.actionId)}`, void 0, {
      timeoutMs: Math.max(1, Math.min(2500, deadline - now()))
    });
    if (!polled.ok) {
      if ([401, 403].includes(polled.status)) return closed("approval_access_rejected", { actionId: expected.actionId });
      continue;
    }
    const action = polled.body?.action || polled.body;
    if (!matchesAction(polled.body, context, expected)) return closed("approval_binding_mismatch", { actionId: expected.actionId });
    if (action.status === "pending_approval") continue;
    if (action.status !== "running") return closed("approval_closed", { actionId: expected.actionId });
    if (action.approval_redeemed_at != null || action.timestamp_end != null) return closed("execution_outcome_unknown", { actionId: expected.actionId });
    if (!(action.approved_by || action.approved_at) || polled.body.approval?.state === "denied") {
      return closed("approval_not_confirmed", { actionId: expected.actionId });
    }
    const current = await api.request("POST", "/api/actions", { ...context, status: "running" });
    if (!current.ok) return closed("admission_unconfirmed", { actionId: expected.actionId });
    result3 = actionAdmission(current.body, "allow", context, expected);
    if (result3.authorized && !await beforeRelease(result3.response)) return closed("action_evidence_changed", { actionId: result3.actionId });
    return result3;
  }
  return result3;
}

// sdk/runtime/outcome.mjs
var pending = (reason) => ({ recorded: false, reason });
function terminalOutcome(config, data, now = Date.now()) {
  const response = data.tool_response;
  let status;
  let summary;
  if (config.host === "claude" && data.hook_event_name === "PostToolUseFailure" && typeof data.error === "string") {
    status = "failed";
    summary = "Runtime emitted PostToolUseFailure; details omitted.";
  } else if (isObject(response)) {
    const structured = isObject(response.structuredContent) ? response.structuredContent : response;
    const error = [response, structured].some((value) => value.error || value.isError === true || value.is_error === true || value.interrupted === true);
    const exitCode = Object.hasOwn(response, "exit_code") ? response.exit_code : structured.exit_code;
    if (error) {
      status = "failed";
      summary = "Runtime reported a tool error; details omitted.";
    } else if (Number.isSafeInteger(exitCode)) {
      status = exitCode === 0 ? "completed" : "failed";
      summary = `Runtime reported exit_code=${exitCode}; output omitted.`;
    } else if (config.host === "claude" && data.hook_event_name === "PostToolUse" && !response.backgroundTaskId && !response.background_task_id && !response.session_id && data.tool_input?.run_in_background !== true) {
      status = "completed";
      summary = "Claude Code emitted a successful PostToolUse event; output omitted.";
    }
  }
  return status ? { status, output_summary: summary, timestamp_end: new Date(now).toISOString() } : null;
}
function validReport(report, provenance) {
  const outcome = report?.outcome;
  return isObject(outcome) && (provenance.schema === "osuite.diagnostic_terminal_report.v1" ? outcome.status === "cancelled" : ["completed", "failed"].includes(outcome.status)) && Object.keys(outcome).sort().join(",") === "output_summary,status,timestamp_end" && typeof outcome.output_summary === "string" && Number.isFinite(Date.parse(outcome.timestamp_end)) && typeof report.action_reported === "boolean" && canonicalJson(report.provenance) === canonicalJson(provenance);
}
async function recordOutcome(config, data, { api, store, now = Date.now } = {}) {
  if (!isObject(data)) return pending("invalid_hook_input");
  const toolId = deriveToolUseId(data);
  if (!safeId(toolId)) return pending("invalid_tool_id");
  const key = `action:${toolId}`;
  let state;
  try {
    state = store.read(key);
  } catch {
    return pending("unreadable_action_state");
  }
  if (state === null) return { recorded: false, reason: null };
  if (!isObject(state) || state.schema !== "osuite.node_action.v1" || !safeId(state.action_id) || state.runtime_session_id && !safeId(state.runtime_session_id)) return pending("invalid_action_state");
  if (state.tool_use_id !== toolId || data.session_id && data.session_id !== state.runtime_session_id || data.tool_name && data.tool_name !== state.tool_name || data.tool_input !== void 0 && toolInputDigest(data.tool_name || state.tool_name, data.tool_input) !== state.tool_input_digest) {
    return pending("state_binding_mismatch");
  }
  if (state.require_signature && !config.privateKeyBase64) return pending("signing_unavailable");
  const provenance = { schema: state.install_check ? "osuite.diagnostic_terminal_report.v1" : "osuite.structured_terminal_report.v1", action_id: state.action_id, tool_use_id: toolId };
  let report = state.outcome_report;
  if (report !== void 0 && !validReport(report, provenance)) return pending("untrusted_outcome_state");
  if (report === void 0) {
    const outcome2 = state.install_check ? {
      status: "cancelled",
      timestamp_end: new Date(now()).toISOString(),
      output_summary: "Inert diagnostic hook probe; the tool was not executed."
    } : terminalOutcome(config, data, now());
    if (!outcome2) return pending("terminal_evidence_missing");
    report = { outcome: outcome2, action_reported: false, provenance };
    state.outcome_report = report;
    try {
      store.write(key, state);
    } catch {
      return pending("state_persistence_failed");
    }
  }
  const outcome = report.outcome;
  if (!report.action_reported) {
    const response = await api.request("PATCH", `/api/actions/${encodeURIComponent(state.action_id)}`, outcome, { timeoutMs: 2e3 });
    const action = response.body?.action;
    if (!response.ok || response.status !== 200 || !isObject(action) || action.action_id !== state.action_id || action.status !== outcome.status || action.timestamp_end !== outcome.timestamp_end) {
      return pending("outcome_acknowledgement_pending");
    }
    report.action_reported = true;
    try {
      store.write(key, state);
    } catch {
      return pending("state_persistence_failed");
    }
  }
  if (state.runtime_session_id) {
    const event = {
      event_id: `evt_outcome_${sha256(`${state.runtime_session_id}|${state.action_id}|${toolId}|${outcome.timestamp_end}`).slice(0, 24)}`,
      runtime_session_id: state.runtime_session_id,
      event_type: state.install_check ? "turn_stopped" : outcome.status === "completed" ? "tool_completed" : "tool_failed",
      tool_name: state.tool_name,
      tool_use_id: toolId,
      action_id: state.action_id,
      timestamp: outcome.timestamp_end,
      payload: { status: outcome.status, output_summary: outcome.output_summary, ...state.install_check ? { install_check: true } : {} }
    };
    const response = await api.request("POST", `/api/runtime-sessions/${encodeURIComponent(state.runtime_session_id)}/events`, event, { timeoutMs: 2e3 });
    const acknowledged = response.body?.event;
    if (!response.ok || response.status !== 200 || response.body?.ok !== true || !isObject(acknowledged) || ["runtime_session_id", "event_type", "tool_use_id", "action_id"].some((field) => acknowledged[field] !== event[field]) || acknowledged.payload?.status !== outcome.status) return pending("event_acknowledgement_pending");
  }
  try {
    store.remove(key);
  } catch {
    return pending("state_cleanup_pending");
  }
  return { recorded: true };
}

// sdk/runtime/hook.mjs
var note = (message) => ({ exitCode: 0, stdout: message ? { systemMessage: `[OSuite] ${message}` } : {}, stderr: "" });
function deny(message) {
  const reason = `[OSuite] ${message}`;
  return { exitCode: 2, stderr: reason, stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } };
}
function applyPosture(config, posture) {
  return {
    ...config,
    mode: posture.mode,
    guardFailureMode: posture.mode === "strict" ? "block" : posture.on_guard_unavailable,
    signatureMode: posture.require_signature ? "required" : "workspace_key_optional",
    requireAssumptionCapture: posture.require_assumption_capture,
    approvalTimeoutSeconds: posture.approval_timeout_seconds
  };
}
async function emitRuntimeEvent(api, config, context, eventType, actionId = null, payload = {}) {
  return api.request("POST", `/api/runtime-sessions/${encodeURIComponent(context.runtime_session_id)}/events`, {
    event_id: `evt_${randomUUID2()}`,
    runtime_session_id: context.runtime_session_id,
    event_type: eventType,
    tool_name: context.tool_name || null,
    tool_use_id: context.tool_use_id || null,
    action_id: actionId,
    payload: { hook_mode: config.mode, guard_failure_mode: config.guardFailureMode, ...payload }
  }, { timeoutMs: 1500 });
}
async function openSession(api, config, data, store, now = Date.now()) {
  const sessionId = deriveSessionId(data, config);
  const marker = `session:${sessionId}`;
  const cached = store.read(marker);
  if (cached?.mode === config.mode && cached?.signature_mode === config.signatureMode && now - cached.at >= 0 && now - cached.at < 18e5) return sessionId;
  const response = await api.request("POST", "/api/runtime-sessions", {
    runtime_session_id: sessionId,
    agent_id: config.agentId,
    runtime_adapter_id: config.runtimeId,
    runtime_family: "tool_hook_runtime",
    adapter_mode: "hook",
    client_name: config.host,
    governance_posture: config.mode,
    signature_mode: config.signatureMode,
    install_channel: config.installChannel,
    settings_scope: config.settingsScope,
    trusted_project_required: config.trustedProjectRequired === true,
    status: "active",
    metadata: { implementation: "node", runtime_adapter_id: config.runtimeId }
  }, { timeoutMs: 1500 });
  if (response.ok && response.body?.runtime_session?.runtime_session_id === sessionId) {
    store.write(marker, { at: now, mode: config.mode, signature_mode: config.signatureMode });
  }
  return sessionId;
}
function rememberGap(store, reason, now) {
  try {
    const previous = store.read("governance-gap");
    store.write("governance-gap", {
      since: previous?.since || new Date(now).toISOString(),
      last_seen: new Date(now).toISOString(),
      calls: Math.min(Number(previous?.calls || 0) + 1, Number.MAX_SAFE_INTEGER),
      reason
    });
  } catch {
  }
}
async function flushGap(api, config, context, store) {
  const gap = store.read("governance-gap");
  if (!gap) return;
  const response = await emitRuntimeEvent(api, config, context, "governance_unavailable", null, {
    since: gap.since,
    last_seen: gap.last_seen,
    ungoverned_tool_calls: gap.calls,
    reason: gap.reason
  });
  if (response.ok && response.body?.ok === true) store.remove("governance-gap");
}
function updatePending(store, context, entry = null) {
  const key = `pending:${context.runtime_session_id}`;
  const saved = store.read(key);
  const entries = (Array.isArray(saved) ? saved : []).filter((value) => value.tool_input_digest !== context.tool_input_digest);
  if (entry) entries.push(entry);
  if (entries.length) store.write(key, entries.slice(-64));
  else store.remove(key);
}
async function stopHook(data, config, api, store) {
  const session = deriveSessionId(data, config), key = `pending:${session}`;
  const saved = store.read(key);
  if (!Array.isArray(saved) || !saved.length) return note();
  const retained = [], decided = [];
  const deadline = performance.now() + 3e3;
  for (const entry of saved) {
    if (!safeId(entry.action_id)) continue;
    if (performance.now() >= deadline) {
      retained.push(entry);
      continue;
    }
    const response = await api.request("GET", `/api/actions/${encodeURIComponent(entry.action_id)}`, void 0, { timeoutMs: Math.max(1, deadline - performance.now()) });
    if (!response.ok) {
      retained.push(entry);
      continue;
    }
    const action = response.body?.action || response.body;
    if (!matchesAction(response.body, entry, { actionId: entry.action_id, fingerprint: entry.fingerprint })) {
      decided.push("Held action evidence no longer matches. Do not retry automatically; reconcile in Studio.");
      continue;
    }
    if (action.status === "pending_approval") {
      retained.push(entry);
      continue;
    }
    if (action.status === "running" && (action.approved_by || action.approved_at) && action.approval_redeemed_at == null && action.timestamp_end == null) {
      decided.push("A held action was approved. Submit exactly the same tool call through OSuite again; current policy and one-use POST admission must still authorize it.");
    } else if (action.status === "running") {
      decided.push("A held action has an uncertain execution outcome. Do not retry automatically; reconcile its action/replay in Studio.");
    } else decided.push("A held action was denied, expired, or closed. Do not retry automatically; tell the user.");
  }
  if (retained.length) store.write(key, retained);
  else store.remove(key);
  if (decided.length && !data.stop_hook_active) return { exitCode: 0, stderr: "", stdout: { decision: "block", reason: `[OSuite] ${decided.join(" ")}` } };
  return note(decided.join(" ") || "An action is still held for human review. No tool was executed by this hook.");
}
async function runHook(data, localConfig, dependencies = {}) {
  const event = data?.hook_event_name || "PreToolUse";
  const pre = event === "PreToolUse";
  try {
    if (!isObject(data)) return deny("Invalid hook input. No execution was authorized.");
    const initialContext = pre ? buildActionContext(data, localConfig) : null;
    const store = dependencies.store || createStateStore(localConfig);
    const now = dependencies.now || Date.now;
    let api = dependencies.api || createApiClient(localConfig);
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
      const result4 = await recordOutcome(localConfig, data, { api, store, now });
      return note(result4.reason ? "Tool outcome is not yet acknowledged. Evidence was retained; do not repeat the side effect." : "");
    }
    const remote = await resolveRemotePosture(localConfig, { api, store, now: now() });
    const config = applyPosture(localConfig, remote.posture);
    api = dependencies.api || createApiClient(config);
    if (event === "Stop") return stopHook(data, config, api, store);
    if (remote.blocked) return pre ? deny("Verified runtime posture is unavailable or expired. Execution is blocked; reconnect or restore access.") : note("Verified runtime posture is unavailable. Enforce hooks will block execution until it can be verified.");
    if (!pre && event !== "SessionStart" && event !== "SessionEnd") return note("Unsupported hook event; no execution decision was made.");
    const session = await openSession(api, config, data, store, now());
    if (!pre) {
      await emitRuntimeEvent(api, config, { runtime_session_id: session }, event === "SessionStart" ? "session_started" : "session_ended");
      return note(remote.available ? "" : "Observe mode is active without verified remote posture. This is not governance authorization.");
    }
    const context = { ...initialContext, tool_name: data.tool_name };
    if (!remote.available) {
      rememberGap(store, "posture_unavailable", now());
      return note("Not governed: remote posture is unavailable; explicit observe mode does not enforce OSuite policy.");
    }
    await emitRuntimeEvent(api, config, context, "tool_preflight", null, { tool_input_digest: context.tool_input_digest, install_check: config.installCheck === true });
    const result3 = await admitAction(context, { api, config, ...dependencies.admission, beforeRelease: (response) => validateGitPublication(context, response) });
    if (result3.degraded) {
      rememberGap(store, result3.reason, now());
      await emitRuntimeEvent(api, config, context, "governance_unavailable", null, { decision: result3.decision === "allow" ? "guard_unavailable" : "guard_unavailable_blocked" });
      return result3.decision === "allow" ? note("Not governed: the guard is unavailable and this verified posture explicitly allows availability fallback. No authorization or completion is claimed.") : deny("Guard unavailable. Verified policy requires blocking this call.");
    }
    await flushGap(api, config, context, store);
    if (result3.installCheck) {
      await emitRuntimeEvent(api, config, context, "install_check_policy_result", null, { decision: result3.decision, approval_state: "not_requested", install_check: true });
      return deny("Install check: policy would require human approval. No request was sent to reviewers and no tool was executed.");
    }
    if (result3.authorized) {
      try {
        store.write(`action:${context.tool_use_id}`, {
          schema: "osuite.node_action.v1",
          action_id: result3.actionId,
          runtime_session_id: session,
          tool_name: data.tool_name,
          tool_use_id: context.tool_use_id,
          tool_input_digest: context.tool_input_digest,
          require_signature: config.signatureMode === "required",
          install_check: config.installCheck === true
        });
      } catch {
        return deny("Cannot persist the exact-action receipt state. The admitted tool was not released; reconcile its action in Studio before retrying.");
      }
      updatePending(store, context);
      await emitRuntimeEvent(api, config, context, "tool_allowed", result3.actionId, { decision: result3.decision, install_check: config.installCheck === true });
      return note(config.mode === "observe" ? "Observe mode recorded a policy result; it does not enforce OSuite policy." : result3.decision === "warn" ? "OSuite authorized this call with a policy warning." : "");
    }
    if (result3.decision === "require_approval") {
      if (config.mode !== "observe") updatePending(store, context, {
        action_id: result3.actionId,
        agent_id: config.agentId,
        runtime_session_id: session,
        tool_input_digest: context.tool_input_digest,
        fingerprint: cavaFingerprint(result3.response)
      });
      await emitRuntimeEvent(api, config, context, "tool_requires_approval", result3.actionId, { decision: config.mode === "observe" ? "observe_would_require_approval" : result3.response?.decision?.decision || "require_approval" });
      return config.mode === "observe" ? note("Observe mode: this call would require human approval; it is not authorized by a reviewer.") : deny(`Human approval is still required for action ${result3.actionId}. Do not run or automatically retry it. Review it in OSuite Studio.`);
    }
    await emitRuntimeEvent(api, config, context, "tool_blocked", result3.actionId, { decision: config.mode === "observe" ? "observe_would_block" : "block", reason: result3.reason });
    return config.mode === "observe" ? note("Observe mode: OSuite policy would block this call. It is not authorized by OSuite.") : deny(`OSuite policy did not authorize this exact action (${result3.reason}). Do not retry automatically.`);
  } catch {
    return pre ? deny("Hook evidence or state is invalid. Execution is blocked; no successful admission is claimed.") : note("Runtime evidence could not be recorded. No completion or authorization is claimed.");
  }
}
async function readHookInput(input = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > 1048576) throw new Error("Hook input exceeds limit");
    chunks.push(Buffer.from(chunk));
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, "");
  const value = JSON.parse(text);
  if (!isObject(value)) throw new Error("Invalid hook input");
  return value;
}
async function runHookCli({ host, installDir, event = "PreToolUse", runtimeId } = {}) {
  let result3;
  try {
    const data = await readHookInput();
    const allowedEvents = event === "PostToolUse" ? ["PostToolUse", "PostToolUseFailure"] : [event];
    if (data.hook_event_name && !allowedEvents.includes(data.hook_event_name)) throw new Error("Unexpected hook event");
    data.hook_event_name ||= event;
    result3 = await runHook(data, loadRuntimeConfig({ host, installDir, runtimeId }));
  } catch {
    result3 = event === "PreToolUse" ? deny("Invalid hook input. No execution was authorized.") : note("Runtime event could not be processed; no completion is claimed.");
  }
  process.stdout.write(`${JSON.stringify(result3.stdout)}
`);
  if (result3.stderr) process.stderr.write(`${result3.stderr}
`);
  process.exitCode = result3.exitCode;
}

// sdk/runtime/mcp.mjs
import { randomUUID as randomUUID3 } from "node:crypto";
import { setTimeout as delay2 } from "node:timers/promises";
var COVERAGE = "Advisory MCP governance bridge, not an execution gateway. Direct resource access and alternative tools are outside coverage.";
var string = { type: "string" };
var tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: "object", properties, required } });
var MCP_TOOLS = [
  tool("osuite_begin_session", "Open an OSuite governance session; does not execute tools.", { client_name: string, client_version: string, session_label: string }),
  tool("osuite_preflight_action", "Check current policy and request one-use admission for exactly this tool input. Does not execute it.", {
    action_type: string,
    declared_goal: string,
    risk_score: { type: "number" },
    tool_name: string,
    tool_use_id: string,
    tool_input: {},
    systems_touched: { type: "array", items: string },
    reversible: { type: "boolean" },
    metadata: { type: "object" }
  }, ["action_type", "declared_goal", "tool_name", "tool_input"]),
  tool("osuite_record_assumption", "Record an assumption for an action opened through this bridge.", { action_id: string, assumption: string, basis: string }, ["action_id", "assumption"]),
  tool("osuite_wait_for_approval", "Observe review status. A GET is not execution authority; resubmit the exact input through preflight.", { action_id: string, timeout_seconds: { type: "number" } }, ["action_id"]),
  tool("osuite_complete_action", "Record an explicit caller-reported outcome. This is not independent host proof of completion.", {
    action_id: string,
    status: { enum: ["completed", "failed", "cancelled"] },
    output_summary: string,
    side_effects: { type: "array", items: {} },
    artifacts_created: { type: "array", items: {} }
  }, ["action_id", "status"]),
  tool("osuite_replay_link", "Return the Studio replay URL for this action.", { action_id: string }, ["action_id"]),
  tool("osuite_end_session", "Mark the bridge conversation as ended; never infer tool outcomes.", { reason: string })
];
function result2(data, error = false) {
  const payload = { effect_executed: false, ...data };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, ...error ? { isError: true } : {} };
}
var failure = (message) => result2({ authorized: false, error: message }, true);
function createMcpServer(localConfig, dependencies = {}) {
  let store = dependencies.store;
  let sessionId = `sess_${randomUUID3()}`;
  const ensureStore = () => store ||= createStateStore(localConfig);
  const baseApi = () => dependencies.api || createApiClient(localConfig);
  async function current() {
    const remote = await resolveRemotePosture(localConfig, { api: baseApi(), store: ensureStore(), now: Date.now() });
    if (!remote.available || remote.blocked) return null;
    const config = applyPosture(localConfig, remote.posture);
    if (config.signatureMode === "required" && !config.privateKeyBase64) return null;
    return { config, api: dependencies.api || createApiClient(config) };
  }
  async function complete(args, state, { api, config }) {
    if (state.authorized !== true || !["completed", "failed", "cancelled"].includes(args.status)) return failure("An admitted action and an explicit terminal status are required.");
    if (state.outcome_report && state.outcome_report.outcome.status !== args.status) return failure("A different outcome is already pending acknowledgement; reconcile rather than replace it.");
    const key = `mcp:${args.action_id}`;
    const report = state.outcome_report || {
      outcome: {
        status: args.status,
        timestamp_end: (/* @__PURE__ */ new Date()).toISOString(),
        output_summary: `MCP caller reported ${args.status}; not independently verified by a host completion event.`
      },
      action_reported: false
    };
    state.outcome_report = report;
    store.write(key, state);
    if (!report.action_reported) {
      const response2 = await api.request("PATCH", `/api/actions/${encodeURIComponent(args.action_id)}`, report.outcome);
      const action = response2.body?.action;
      if (!response2.ok || response2.status !== 200 || action?.action_id !== args.action_id || action?.status !== report.outcome.status || action?.timestamp_end !== report.outcome.timestamp_end) {
        return result2({ recorded: false, action_id: args.action_id, message: "Outcome acknowledgement is pending. Do not repeat the side effect." }, true);
      }
      report.action_reported = true;
      store.write(key, state);
    }
    const event = {
      event_id: `evt_mcp_outcome_${sha256(`${args.action_id}|${report.outcome.timestamp_end}`).slice(0, 24)}`,
      runtime_session_id: state.context.runtime_session_id,
      event_type: args.status === "completed" ? "tool_completed" : "tool_failed",
      action_id: args.action_id,
      tool_name: state.tool_name,
      tool_use_id: state.context.tool_use_id,
      payload: { status: args.status, outcome_source: "mcp_caller_report", hook_mode: state.mode }
    };
    const response = await api.request("POST", `/api/runtime-sessions/${encodeURIComponent(event.runtime_session_id)}/events`, event);
    if (!response.ok || response.status !== 200 || response.body?.ok !== true || !isObject(response.body.event) || ["runtime_session_id", "action_id", "tool_use_id", "event_type"].some((field) => response.body.event[field] !== event[field]) || response.body.event.payload?.status !== args.status || response.body.event.payload?.outcome_source !== "mcp_caller_report") {
      return result2({ recorded: false, action_id: args.action_id, message: "Outcome event acknowledgement is pending. Do not repeat the side effect." }, true);
    }
    store.remove(key);
    return result2({ recorded: true, action_id: args.action_id, status: args.status, outcome_source: "mcp_caller_report" });
  }
  async function callTool(name, args = {}) {
    try {
      if (!MCP_TOOLS.some((item) => item.name === name) || !isObject(args)) return failure("Unknown tool or invalid arguments.");
      if (["osuite_record_assumption", "osuite_wait_for_approval", "osuite_complete_action", "osuite_replay_link"].includes(name) && !safeId(args.action_id)) return failure("A valid action_id is required.");
      if (name === "osuite_replay_link") return result2({ action_id: args.action_id, replay_href: `${localConfig.baseUrl}/replay/${encodeURIComponent(args.action_id)}` });
      const state = args.action_id ? ensureStore().read(`mcp:${args.action_id}`) : null;
      if (args.action_id && (!isObject(state) || state.schema !== "osuite.mcp_action.v1")) return failure("This action has no admitted or held context in this bridge. Reconcile its record in Studio.");
      const active = await current();
      if (!active) return failure("Verified runtime posture or required signing is unavailable; no execution is authorized.");
      const { api, config } = active;
      if (name === "osuite_complete_action") return complete(args, state, active);
      if (name === "osuite_record_assumption") {
        if (typeof args.assumption !== "string" || !args.assumption.trim() || args.assumption.length > 4e3) return failure("A bounded assumption is required.");
        const response = await api.request("POST", "/api/assumptions", {
          action_id: args.action_id,
          assumption: args.assumption,
          basis: typeof args.basis === "string" ? args.basis.slice(0, 1e3) : "MCP caller statement",
          validated: false
        });
        if (!response.ok || !isObject(response.body?.assumption)) return failure("Assumption acknowledgement is pending.");
        await emitRuntimeEvent(api, config, state.context, "assumption_recorded", args.action_id, { source: "mcp_caller_report" });
        return result2({ action_id: args.action_id, recorded: true, validated: false });
      }
      if (name === "osuite_wait_for_approval") {
        const requested = Number(args.timeout_seconds ?? 30);
        const deadline = performance.now() + (Number.isFinite(requested) ? Math.max(0, Math.min(40, requested)) * 1e3 : 0);
        do {
          const response = await api.request("GET", `/api/actions/${encodeURIComponent(args.action_id)}`, void 0, { timeoutMs: 2e3 });
          if ([401, 403].includes(response.status)) return failure("Approval access was rejected.");
          if (response.ok) {
            const action = response.body?.action || response.body;
            if (!matchesAction(response.body, state.context, { actionId: args.action_id, fingerprint: state.fingerprint })) return failure("Approval evidence no longer matches the held tool input.");
            if (action.status === "running") {
              const observed = Boolean(action.approved_by || action.approved_at) && action.approval_redeemed_at == null && action.timestamp_end == null;
              return result2({
                action_id: args.action_id,
                approved: false,
                approval_observed: observed,
                authorized: false,
                status: "running",
                message: observed ? "Submit exactly the same tool input through osuite_preflight_action again. A GET does not redeem a grant or authorize execution." : "The outcome may be unknown or already consumed. Do not retry automatically; reconcile in Studio."
              });
            }
            if (action.status !== "pending_approval") return result2({ action_id: args.action_id, approved: false, authorized: false, status: action.status, message: "The held request is closed. Do not retry automatically." });
          }
          if (performance.now() >= deadline) break;
          await delay2(Math.min(3e3, deadline - performance.now()));
        } while (performance.now() < deadline);
        return result2({ action_id: args.action_id, approved: false, authorized: false, status: "timeout", message: "Still held; do not execute this call." });
      }
      await openSession(api, config, { session_id: sessionId }, store);
      if (name === "osuite_begin_session") return result2({ runtime_session_id: sessionId, runtime_adapter_id: config.runtimeId, mode: config.mode, guard_failure_mode: config.guardFailureMode, coverage: COVERAGE });
      if (name === "osuite_end_session") {
        await emitRuntimeEvent(api, config, { runtime_session_id: sessionId }, "session_ended", null, { source: "mcp_caller_report" });
        const ended = sessionId;
        sessionId = `sess_${randomUUID3()}`;
        return result2({ ended_runtime_session_id: ended });
      }
      if (typeof args.action_type !== "string" || !args.action_type || args.action_type.length > 128 || typeof args.declared_goal !== "string" || !args.declared_goal || args.declared_goal.length > 2e3 || !Object.hasOwn(args, "tool_input")) return failure("A bounded action_type, declared_goal and complete tool_input are required.");
      const data = { session_id: sessionId, tool_name: args.tool_name, tool_input: args.tool_input, tool_use_id: args.tool_use_id || `tool_${randomUUID3()}` };
      const context = buildActionContext(data, config);
      if (args.tool_name !== "Bash") context.declared_goal = args.declared_goal;
      if (Number.isSafeInteger(args.risk_score) && args.risk_score >= 0 && args.risk_score <= 100) context.risk_score = Math.max(context.risk_score, args.risk_score);
      if (args.reversible === false) context.reversible = false;
      const eventContext = { ...context, tool_name: args.tool_name };
      await emitRuntimeEvent(api, config, eventContext, "tool_preflight", null, { tool_input_digest: context.tool_input_digest, source: "mcp_bridge" });
      const admitted = await admitAction(context, { api, config: { ...config, approvalWaitMs: 0 }, beforeRelease: (response) => validateGitPublication(context, response) });
      if (admitted.actionId && (admitted.authorized || admitted.decision === "require_approval")) {
        const key = `mcp:${admitted.actionId}`;
        const previous = store.read(key);
        if (previous?.outcome_report) return failure("An outcome is already pending for this action. Reconcile before any retry.");
        store.write(key, {
          schema: "osuite.mcp_action.v1",
          authorized: admitted.authorized,
          context,
          mode: config.mode,
          tool_name: args.tool_name,
          fingerprint: cavaFingerprint(admitted.response)
        });
      }
      const eventType = admitted.degraded ? "governance_unavailable" : admitted.authorized ? "tool_allowed" : admitted.decision === "require_approval" ? "tool_requires_approval" : "tool_blocked";
      await emitRuntimeEvent(api, config, eventContext, eventType, admitted.actionId, { decision: admitted.degraded ? "guard_unavailable" : admitted.decision, source: "mcp_bridge" });
      return result2({
        decision: admitted.decision,
        authorized: admitted.authorized === true && config.mode !== "observe",
        action_id: admitted.actionId || null,
        runtime_session_id: sessionId,
        coverage: COVERAGE,
        ...admitted.degraded ? { degraded: true } : {},
        message: admitted.authorized ? "Current policy admitted this exact input. This bridge did not execute it." : "No execution is authorized. Review the action in Studio; do not retry automatically."
      }, !admitted.authorized && admitted.decision !== "require_approval");
    } catch {
      return failure("The governance request could not be confirmed. No execution is authorized; do not retry a side effect automatically.");
    }
  }
  async function handleRequest(request) {
    if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    if (!Object.hasOwn(request, "id")) return null;
    const response = { jsonrpc: "2.0", id: request.id };
    if (request.method === "initialize") return { ...response, result: {
      protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(request.params?.protocolVersion) ? request.params.protocolVersion : "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "osuite_runtime_governance", version: "1.1.0-node" },
      instructions: COVERAGE
    } };
    if (request.method === "ping") return { ...response, result: {} };
    if (request.method === "tools/list") return { ...response, result: { tools: MCP_TOOLS } };
    if (request.method === "tools/call") return { ...response, result: await callTool(request.params?.name, request.params?.arguments ?? {}) };
    return { ...response, error: { code: -32601, message: "Method not found" } };
  }
  return { callTool, handleRequest };
}
async function runMcpCli(options = {}) {
  const server = createMcpServer(loadRuntimeConfig(options));
  let buffer = Buffer.alloc(0), framing = null;
  const maximum = 1048576;
  const write = (payload) => {
    if (!payload) return;
    const encoded = JSON.stringify(payload);
    process.stdout.write(framing === "legacy" ? `Content-Length: ${Buffer.byteLength(encoded)}\r
\r
${encoded}` : `${encoded}
`);
  };
  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (!framing && buffer.length >= 1) framing = buffer[0] === 67 || buffer[0] === 99 ? "legacy" : "ndjson";
        let body;
        if (framing === "legacy") {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buffer.length > 8192) throw new Error("Oversized header");
            break;
          }
          const match = buffer.subarray(0, end).toString("ascii").match(/^Content-Length: ([0-9]+)\r?$/im);
          const length = match ? Number(match[1]) : NaN;
          if (!Number.isSafeInteger(length) || length < 1 || length > maximum) throw new Error("Invalid frame");
          if (buffer.length < end + 4 + length) break;
          body = buffer.subarray(end + 4, end + 4 + length);
          buffer = buffer.subarray(end + 4 + length);
        } else {
          const end = buffer.indexOf(10);
          if (end < 0) break;
          if (end > maximum) throw new Error("Oversized message");
          body = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          if (!body.toString("utf8").trim()) continue;
        }
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
          write(await server.handleRequest(JSON.parse(decoded)));
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        }
      }
      if (buffer.length > maximum + 8192) throw new Error("Oversized message");
    }
    if (buffer.length) throw new Error("Incomplete message");
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid or oversized MCP message" } });
    process.exitCode = 1;
  }
}
export {
  runHookCli,
  runMcpCli
};
