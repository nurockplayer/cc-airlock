// Routing engine for multi-model escalation
// Decides the initial route: pass, ask, deny, flash, pro, or codex.
// All behind the CC_AIRLOCK_ENABLE_ROUTING experimental flag.

// ── Borrowed constants from codex-full-access-guard.js ────────────

const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob',
  'TaskList', 'TaskGet', 'TaskOutput',
  'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'WebFetch', 'WebSearch', 'CronList',
  'Skill', 'Plan',
  'NotebookRead',
]);

const MCP_READ_ONLY_RE = /^mcp__.+__(?:read|list|search|get|query|resolve|check|load|stats|summary|timeline|lint|lsp_)/i;

const SENSITIVE_PATH_RE = /(?:^|\/)(\.env[^\/]*|credentials[^\/]*|secrets?[^\/]*|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.key|.*\.pfx|.*\.p12|service-account[^\/]*\.json)(?:$|\/)/i;

const PR_GATED_ACTIONS = new Set(['create', 'merge', 'close', 'reopen']);

const WORKFLOW_CODEX_PATTERNS = [
  /Implementation\s*Spec/i,
  /Spec\s*Compliance/i,
  /Spec\s*Adequacy/i,
  /雙重驗證/,
  /規格合規性/,
  /Analysis\s*Packet/i,
  /Decision\s*boundar(y|ies)/i,
  /\[ASK\s*CODEX\]/i,
  /\[Executors\s*may\s*decide\]/i,
  /\[DO\s*NOT\s*CHANGE\]/i,
];

const ROUTE_TYPES = ['pass', 'ask', 'deny', 'flash', 'pro', 'codex'];

// ── Shell helpers (matching hooks/dangerous-git-guard.js) ─────────

function shellWords(command) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) { quote = null; } else { current += ch; } continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { words.push(current); current = ''; } continue; }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

function stripWrappers(words) {
  const result = [...words];
  let changed = true;
  while (changed) {
    changed = false;
    if (result[0] === 'rtk') {
      result.shift();
      if (result[0] === 'proxy') result.shift();
      changed = true;
      continue;
    }
    while (result[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(result[0])) { result.shift(); changed = true; }
    if (result[0] === 'command' || result[0] === 'env') { result.shift(); changed = true; }
  }
  return result;
}

function splitCompound(command) {
  return command.split(/(?:;(?!\s*[;])|&&|\|\||\n)/).map(s => s.trim()).filter(Boolean);
}

function gitSubcommand(words) {
  let i = 1;
  const flagOpts = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  while (i < words.length && words[i].startsWith('-')) {
    if (flagOpts.has(words[i]) && i + 1 < words.length) i += 2;
    else i += 1;
  }
  return { subcommand: words[i] || '', args: words.slice(i + 1) };
}

function extractNestedCommands(command) {
  const candidates = [];
  // $() — innermost first
  let dollarMatch;
  while ((dollarMatch = command.match(/\$\(([\s\S]*?)\)/)) !== null) {
    candidates.push(dollarMatch[1].trim());
    command = command.replace(dollarMatch[0], '');
  }
  // backticks
  let btMatch;
  while ((btMatch = command.match(/`([\s\S]*?)`/)) !== null) {
    candidates.push(btMatch[1].trim());
    command = command.replace(btMatch[0], '');
  }
  // bash/sh -c
  const shellRe = /(?:^|\s)(?:bash|sh|zsh)(?:\s+-[lc]+\s*|\s+)(["'])((?:[^"\\']|\\.)*?)\1/i;
  const shellMatch = command.match(shellRe);
  if (shellMatch) candidates.push(shellMatch[2].trim());
  return candidates;
}

// ── Helpers ────────────────────────────────────────────────────────

function isSensitivePath(filePath) {
  return SENSITIVE_PATH_RE.test(filePath);
}

function isWorkflowCodexCall(cmd) {
  if (!/^(?:rtk\s+)?codex\s+exec\b/.test(cmd)) return false;
  if (!/--skip-git-repo-check/.test(cmd)) return false;
  if (!/--sandbox\s+read-only/.test(cmd)) return false;
  if (!/--ephemeral\b/.test(cmd)) return false;
  if (/[;&|]/.test(cmd.replace(/<[^>]*>/g, '')) || /\n/.test(cmd)) return false;
  const DANGEROUS_FLAGS = [
    /--sandbox\s+workspace-write/,
    /--full-auto\b/,
    /--dangerously-bypass-approvals-and-sandbox/,
    /--approval-mode\s+full-auto/,
    /-o\s+sandbox_workspace_write/,
  ];
  if (DANGEROUS_FLAGS.some(f => f.test(cmd))) return false;
  return WORKFLOW_CODEX_PATTERNS.some(p => p.test(cmd));
}

function isDangerousGitCommand(cmd) {
  // Scan all compound segments and nested constructs (matching dangerous-git-guard.js)
  for (const inner of extractNestedCommands(cmd)) {
    if (checkDangerousGit(inner)) return true;
  }
  for (const seg of splitCompound(cmd)) {
    if (checkDangerousGit(seg)) return true;
  }
  return false;
}

function checkDangerousGit(segment) {
  const words = stripWrappers(shellWords(segment));
  if (words.length === 0 || words[0] !== 'git') return false;
  const { subcommand, args } = gitSubcommand(words);
  if (subcommand === 'reset' && args.includes('--hard')) return true;
  if (subcommand === 'clean') return true;
  return false;
}

function isDestructiveShell(cmd) {
  // Scan all compound segments
  for (const seg of splitCompound(cmd)) {
    const words = stripWrappers(shellWords(seg));
    if (words.length === 0) continue;
    if (checkDestructiveRm(words)) return true;
  }
  return false;
}

function checkDestructiveRm(words) {
  if (words[0] !== 'rm') return false;
  let hasRecursive = false;
  let target = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--recursive') { hasRecursive = true; continue; }
    if (w.startsWith('-') && !w.startsWith('--')) {
      if (/[rR]/.test(w.slice(1))) hasRecursive = true;
      continue;
    }
    if (w.startsWith('--')) continue;
    target = w;
    break;
  }
  if (!hasRecursive || !target) return false;
  return /^\/\s*$|^\/\*$|^~\s*$|^~\/*|^\$HOME\b|\$\{HOME\}|^\.\.\s*$|^\.\/\*$|^\*$/.test(target);
}

function isPrWriteCommand(cmd) {
  // Scan all compound segments
  for (const seg of splitCompound(cmd)) {
    const words = stripWrappers(shellWords(seg));
    if (words.length === 0) continue;
    let i = 0;
    while (i < words.length) {
      if (words[i] === 'gh') { i++; continue; }
      if (words[i] === '-R' || words[i] === '--repo') { i += 2; continue; }
      break;
    }
    if (i >= words.length) continue;
    const remaining = words.slice(i);
    if (remaining[0] === 'pr' && PR_GATED_ACTIONS.has(remaining[1])) return true;
  }
  return false;
}

// ── classifyAction ──────────────────────────────────────────────────

function classifyAction(toolName, toolInput) {
  const input = toolInput || {};

  // Read-only tools
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { route: 'pass', reason: 'Read-only tool, auto-approved', risk_category: 'read_only' };
  }

  // MCP read-only
  if (MCP_READ_ONLY_RE.test(toolName)) {
    return { route: 'pass', reason: 'MCP read-only tool, auto-approved', risk_category: 'read_only' };
  }

  // Write/Edit/MultiEdit sensitive paths
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    let paths = [];
    if (toolName === 'MultiEdit') {
      paths = (input.edits || []).map(e => e.file_path).filter(Boolean);
      if (input.file_path) paths.push(input.file_path);
    } else {
      paths = [input.file_path || ''];
    }
    const sensitive = paths.find(p => isSensitivePath(p));
    if (sensitive) {
      return { route: 'ask', reason: `Sensitive path: ${sensitive}`, risk_category: 'file_write' };
    }
    return { route: 'flash', reason: 'Normal file write, route to Flash', risk_category: 'file_write' };
  }

  // Bash-specific checks
  if (toolName === 'Bash') {
    const cmd = String(input.command || '').trim();

    // Workflow Codex bypass
    if (isWorkflowCodexCall(cmd)) {
      return { route: 'pass', reason: 'Workflow Codex call, auto-approved', risk_category: 'read_only' };
    }

    // Destructive shell (scans compound segments)
    if (isDestructiveShell(cmd)) {
      return { route: 'deny', reason: 'Destructive shell command blocked', risk_category: 'destructive_shell' };
    }

    // Dangerous git commands (scans nested + compound)
    if (isDangerousGitCommand(cmd)) {
      return { route: 'deny', reason: 'Dangerous git command blocked', risk_category: 'git_mutation' };
    }

    // PR write commands (scans compound segments with wrapper stripping)
    if (isPrWriteCommand(cmd)) {
      return { route: 'pro', reason: 'PR write operation, route to Pro', risk_category: 'pr_operation' };
    }

    // Default Bash route
    return { route: 'flash', reason: 'Bash command, route to Flash', risk_category: 'unknown' };
  }

  // Agent / Task / other tools → flash
  return { route: 'flash', reason: `Tool ${toolName} routed to Flash`, risk_category: 'unknown' };
}

// ── routeDecision ──────────────────────────────────────────────────

function routeDecision(toolName, toolInput, opts) {
  if (!opts || !opts.enableRouting) return null;
  return classifyAction(toolName, toolInput);
}

module.exports = { classifyAction, routeDecision, ROUTE_TYPES };
