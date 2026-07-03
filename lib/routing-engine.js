// Routing engine for multi-model escalation
// Decides the initial route: pass, ask, deny, flash, pro, or codex.
// All behind the CC_AIRLOCK_ENABLE_ROUTING experimental flag.

const path = require('path');
const fs = require('fs');

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
  // Matches dangerous-git-guard.js: git reset --hard / git clean
  const words = cmd.trim().split(/\s+/);
  // Strip wrappers (env/rtk/command)
  const clean = [];
  for (const w of words) {
    if (w === 'rtk' || w === 'proxy' || w === 'env' || w === 'command') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    clean.push(w);
  }
  if (clean[0] !== 'git') return false;
  // Skip git flags (-C, -c, --git-dir, etc.)
  let i = 1;
  const flagOpts = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  while (i < clean.length && clean[i].startsWith('-')) {
    if (flagOpts.has(clean[i]) && i + 1 < clean.length) i += 2;
    else i += 1;
  }
  const sub = clean[i];
  const args = clean.slice(i + 1);
  if (sub === 'reset' && args.includes('--hard')) return true;
  if (sub === 'clean') return true;
  return false;
}

function isDestructiveShell(cmd) {
  const words = cmd.trim().split(/\s+/);
  if (words[0] === 'rm') {
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
    if (hasRecursive && target) {
      const rootDanger = /^\/\s*$|^\/\*$|^~\s*$|^\$HOME\b|^\.\.\s*$|^\.\/\*$|^\*$/.test(target);
      if (rootDanger) return true;
    }
  }
  return false;
}

function isPrWriteCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length) {
    if (parts[i] === 'gh') { i++; continue; }
    if (parts[i] === '-R' || parts[i] === '--repo') { i += 2; continue; }
    break;
  }
  if (i >= parts.length) return false;
  if (parts[i] !== 'pr') return false;
  return PR_GATED_ACTIONS.has(parts[i + 1]);
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

    // Destructive shell
    if (isDestructiveShell(cmd)) {
      return { route: 'deny', reason: 'Destructive shell command blocked', risk_category: 'destructive_shell' };
    }

    // Dangerous git commands
    if (isDangerousGitCommand(cmd)) {
      return { route: 'deny', reason: 'Dangerous git command blocked', risk_category: 'git_mutation' };
    }

    // PR write commands
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
