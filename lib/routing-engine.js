// Routing engine for multi-model escalation
// Decides the initial route: pass, ask, deny, flash, pro, or codex.
// All behind the CC_AIRLOCK_ENABLE_ROUTING experimental flag.

const {
  READ_ONLY_TOOLS,
  MCP_READ_ONLY_RE,
  SENSITIVE_PATH_RE,
  shellWords,
  stripWrappers,
  splitCompound,
  gitSubcommand,
  extractDollarParens,
  extractNestedCommands,
  scanAllSegments,
  isSensitivePath,
  isWorkflowCodexCall,
  isDangerousGitCommand,
  checkDestructiveRm,
  isDestructiveShell,
  isDestructiveNonRm,
  isPrWriteCommand,
  isReadOnlyBash,
} = require('./shared');

const ROUTE_TYPES = ['pass', 'ask', 'deny', 'flash', 'pro', 'codex'];

// ── classifyAction ──────────────────────────────────────────────────

function classifyAction(toolName, toolInput) {
  const input = toolInput || {};

  // Read-only tools
  if (READ_ONLY_TOOLS.has(toolName)) {
    return makeResult('pass', 'Read-only tool, auto-approved', 'read_only', toolName, input);
  }

  // MCP read-only
  if (MCP_READ_ONLY_RE.test(toolName)) {
    return makeResult('pass', 'MCP read-only tool, auto-approved', 'read_only', toolName, input);
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
      return makeResult('ask', `Sensitive path: ${sensitive}`, 'file_write', toolName, input, { sensitivePath: sensitive });
    }
    return makeResult('flash', 'Normal file write, route to Flash', 'file_write', toolName, input);
  }

  // Bash-specific checks
  if (toolName === 'Bash') {
    const cmd = String(input.command || '').trim();

    // 1. Destructive shell (scans nested + compound + pipes)
    if (isDestructiveShell(cmd)) {
      return makeResult('deny', 'Destructive shell command blocked', 'destructive_shell', toolName, input, { command: cmd });
    }

    // 2. Dangerous git commands (scans nested + compound + pipes)
    if (isDangerousGitCommand(cmd)) {
      return makeResult('deny', 'Dangerous git command blocked', 'git_mutation', toolName, input, { command: cmd });
    }

    // 3. Non-rm destructive commands that need human confirmation
    if (isDestructiveNonRm(cmd)) {
      return makeResult('ask', 'Destructive non-rm command, ask human', 'destructive_shell', toolName, input, { command: cmd });
    }

    // 4. Workflow Codex bypass (allow-through after deny checks)
    if (isWorkflowCodexCall(cmd)) {
      return makeResult('pass', 'Workflow Codex call, auto-approved', 'read_only', toolName, input, { command: cmd });
    }

    // 5. Read-only bash commands
    if (isReadOnlyBash(cmd)) {
      return makeResult('pass', 'Read-only Bash command, auto-approved', 'read_only', toolName, input, { command: cmd, readOnlyBash: true });
    }

    // 6. PR write commands
    if (isPrWriteCommand(cmd)) {
      return makePrResult('pro', 'PR write operation, route to Pro', 'pr_operation', toolName, input, cmd);
    }

    // 7. Default Bash route
    return makeResult('flash', 'Bash command, route to Flash', 'unknown', toolName, input, { command: cmd });
  }

  // Agent / Task / other tools → flash
  return makeResult('flash', `Tool ${toolName} routed to Flash`, 'unknown', toolName, input);
}

// ── Result helpers ──────────────────────────────────────────────────

function makeResult(route, reason, risk_category, toolName, input, extra) {
  const result = {
    route,
    reason,
    risk_category,
    hook: toHookDecision({ route, reason, risk_category }),
    context: {
      toolName,
    },
  };
  if (extra) {
    Object.assign(result.context, extra);
  }
  if (toolName === 'Bash') {
    result.context.command = result.context.command || String(input.command || '').trim();
  }
  return result;
}

function makePrResult(route, reason, risk_category, toolName, input, cmd) {
  // Extract PR context from command
  const prContext = findPrContext(cmd);
  const result = {
    route,
    reason,
    risk_category,
    hook: toHookDecision({ route, reason, risk_category }),
    context: {
      toolName,
      command: cmd,
      prContext,
    },
  };
  return result;
}

function findPrContext(cmd) {
  // Scan across ALL compound segments and nested constructs for a PR command.
  // Uses the shared.js helpers that already handle $(), backticks, compound, pipes.
  const { scanAllSegments } = require('./shared');
  let foundWords = null;
  scanAllSegments(cmd, (seg) => {
    if (foundWords) return false; // already found
    const words = stripWrappers(shellWords(seg));
    if (findPrWords(words)) {
      foundWords = words;
      return true;
    }
    return false;
  });
  if (!foundWords) return null;
  return {
    isPrCommand: true,
    commandWords: foundWords,
  };
}

function findPrWords(words) {
  if (words.length === 0) return null;
  let i = 0;
  while (i < words.length) {
    if (words[i] === 'gh') { i++; continue; }
    if (words[i] === '-R' || words[i] === '--repo') { i += 2; continue; }
    break;
  }
  if (i >= words.length) return null;
  const remaining = words.slice(i);
  if (remaining[0] !== 'pr') return null;
  if (!new Set(['create', 'merge', 'close', 'reopen']).has(remaining[1])) return null;
  return words;
}

// ── toHookDecision ──────────────────────────────────────────────────

function toHookDecision(classification) {
  if (!classification) return null;
  switch (classification.route) {
    case 'pass': return { decision: 'pass', exitCode: 0, reason: classification.reason };
    case 'ask':  return { decision: 'ask', exitCode: 1, reason: classification.reason };
    case 'deny': return { decision: 'deny', exitCode: 1, reason: classification.reason };
    default:     return null; // flash, pro, codex → not a hook decision
  }
}

// ── routeDecision (gate) ────────────────────────────────────────────

function routeDecision(toolName, toolInput, opts) {
  if (!opts || !opts.enableRouting) return null;
  return classifyAction(toolName, toolInput);
}

module.exports = { classifyAction, routeDecision, toHookDecision, ROUTE_TYPES };
