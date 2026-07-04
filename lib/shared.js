// Shared constants and helpers for cc-airlock routing engine and hooks.
// Centralizes duplicated logic between lib/routing-engine.js and hooks/*.guard.js.
// Use routing-engine.js versions as canonical (quote-aware, depth-counting).

// ── Tool classification constants ─────────────────────────────────

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

// Non-rm destructive patterns that need human confirmation
const DESTRUCTIVE_NON_RM_PATTERNS = [
  /^terraform\s+destroy\b/,
  /^docker\s+system\s+prune\b/,
  /^kubectl\s+delete\s+namespace\b/,
  /^docker\s+rm\s+/,
  /^docker\s+image\s+rm\b/,
  /^docker\s+volume\s+rm\b/,
  /^virsh\s+destroy\b/,
  /^lvremove\b/,
  /^pvremove\b/,
  /^vgremove\b/,
];

const READ_ONLY_GIT_SUB = new Set([
  'status', 'log', 'diff', 'show',
  'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'describe',
  'blame', 'shortlog',
]);

const GIT_REMOTE_READ = new Set(['-v', 'show', 'get-url']);
const GIT_CONFIG_READ = new Set(['--get', '--list', '--get-all', '--get-regexp']);
const GIT_WORKTREE_READ = new Set(['list']);
const GIT_REFLOG_READ = new Set(['show']);

const READ_ONLY_GH_ACTION = new Set([
  'view', 'list', 'status', 'checks', 'diff',
]);

const READ_ONLY_CMDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc',
  'which', 'whoami', 'date', 'uname', 'df', 'du',
  'file', 'stat',
  'env', 'printenv',
  'basename', 'dirname', 'realpath', 'readlink',
  'sort', 'uniq', 'cut', 'tr',
  'grep', 'rg', 'ag',
  'jq', 'yq',
  'tree',
  'comm', 'diff', 'cmp',
]);

const CODE_WRITE_CMDS = new Set([
  'echo', 'printf',
  'sed', 'awk',
  'find', 'xargs', 'tee',
  'node', 'python', 'python3', 'ruby', 'perl',
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'cargo', 'go', 'rustc',
  'make', 'cmake',
  'open', 'say',
  'codex', 'gemini', 'rtk',
]);

const BRANCH_DESTRUCTIVE = /^-[dDmM]/;

// ── Shell parsers ─────────────────────────────────────────────────

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
    if (result[0] === 'command' || result[0] === 'env' || result[0] === 'sudo') { result.shift(); changed = true; }
  }
  return result;
}

function splitCompound(command) {
  // Quote-aware compound separator split.
  // Tracks single-quote, double-quote, and escape state so that
  // separators (;, &&, ||, &, newline) inside quoted strings are ignored.
  const parts = [];
  let current = '';
  let sq = false, dq = false, esc = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (esc) { current += ch; esc = false; continue; }
    if (ch === '\\' && !sq) { current += ch; esc = true; continue; }
    if (ch === "'" && !dq) { sq = !sq; current += ch; continue; }
    if (ch === '"' && !sq) { dq = !dq; current += ch; continue; }
    if (!sq && !dq) {
      if (ch === ';') {
        if (command[i + 1] === ';') { current += ';;'; i++; continue; }
        parts.push(current.trim()); current = ''; continue;
      }
      if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
        parts.push(current.trim()); current = ''; i++; continue;
      }
      // Background operator & (not &&, not a redirect &>)
      if (ch === '&' && command[i + 1] !== '&' && command[i + 1] !== '>') {
        parts.push(current.trim()); current = ''; continue;
      }
      if (ch === '\n') { parts.push(current.trim()); current = ''; continue; }
    }
    current += ch;
  }
  const last = current.trim();
  if (last) parts.push(last);
  return parts;
}

function splitPipes(text) {
  return text.split(/(?<!\|)\|(?!\|)/).map(s => s.trim()).filter(Boolean);
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

function extractDollarParens(command) {
  // Depth-counting $() extractor that handles nesting correctly.
  // Tracks shell quote state so parentheses inside quoted strings don't
  // affect depth, and $() inside single-quotes is not extracted.
  const candidates = [];
  let i = 0;
  let sq = false, dq = false, esc = false;
  while (i < command.length) {
    const ch = command[i];
    if (esc) { esc = false; i++; continue; }
    if (ch === '\\' && !sq) { esc = true; i++; continue; }
    if (ch === "'" && !dq) { sq = !sq; i++; continue; }
    if (ch === '"' && !sq) { dq = !dq; i++; continue; }
    if (!sq && command[i] === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let innerSq = false, innerDq = false, innerEsc = false;
      while (j < command.length && depth > 0) {
        const c = command[j];
        if (innerEsc) { innerEsc = false; j++; continue; }
        if (c === '\\' && !innerSq) { innerEsc = true; j++; continue; }
        if (c === "'" && !innerDq) { innerSq = !innerSq; j++; continue; }
        if (c === '"' && !innerSq) { innerDq = !innerDq; j++; continue; }
        if (!innerSq && !innerDq) {
          if (c === '(') depth++;
          else if (c === ')') depth--;
        }
        if (depth > 0) j++;
      }
      if (depth === 0) {
        const inner = command.slice(i + 2, j).trim();
        if (inner) {
          candidates.push(inner);
          candidates.push(...extractDollarParens(inner));
        }
        i = j + 1;
      } else {
        i = i + 2;
      }
    } else {
      i++;
    }
  }
  return candidates;
}

function extractNestedCommands(command) {
  const candidates = [];
  // $() — depth-counting recursive extraction
  candidates.push(...extractDollarParens(command));
  // backticks
  let btMatch;
  let cmd = command;
  while ((btMatch = cmd.match(/`([\s\S]*?)`/)) !== null) {
    candidates.push(btMatch[1].trim());
    cmd = cmd.replace(btMatch[0], '');
  }
  // bash/sh -c
  const shellRe = /(?:^|\s)(?:bash|sh|zsh)(?:\s+-[lc]+\s*|\s+)(["'])((?:[^"\\']|\\.)*?)\1/i;
  const shellMatch = cmd.match(shellRe);
  if (shellMatch) candidates.push(shellMatch[2].trim());
  // Process substitution <(cmd) and >(cmd)
  const procSubRe = /<\(([\s\S]*?)\)|>\(([\s\S]*?)\)/g;
  let psMatch;
  while ((psMatch = procSubRe.exec(command)) !== null) {
    const inner = (psMatch[1] || psMatch[2]).trim();
    if (inner) candidates.push(inner);
  }
  return candidates;
}

function scanAllSegments(cmd, checkFn) {
  for (const inner of extractNestedCommands(cmd)) {
    for (const seg of splitCompound(inner)) {
      if (checkFn(seg)) return true;
      const parts = splitPipes(seg);
      for (const part of parts) {
        if (checkFn(part)) return true;
      }
    }
  }
  for (const seg of splitCompound(cmd)) {
    if (checkFn(seg)) return true;
    const parts = splitPipes(seg);
    for (const part of parts) {
      if (checkFn(part)) return true;
    }
  }
  return false;
}

// ── Safety helpers ────────────────────────────────────────────────

function isSensitivePath(filePath) {
  return SENSITIVE_PATH_RE.test(filePath);
}

function isWorkflowCodexCall(cmd) {
  if (!/^(?:rtk\s+)?codex\s+exec\b/.test(cmd)) return false;
  if (!/--skip-git-repo-check/.test(cmd)) return false;
  if (!/--sandbox\s+read-only/.test(cmd)) return false;
  if (!/--ephemeral\b/.test(cmd)) return false;
  // Reject output redirection (> >> 2> <) — these are side-effect operations.
  const noQuotes = cmd.replace(/"([^"\\]|\\.)*"/g, '').replace(/'[^']*'/g, '');
  if (/[12]?>>?|<<?/.test(noQuotes)) return false;
  if (/[;&|]/.test(cmd.replace(/<[^>]*>/g, '')) || /\n/.test(cmd)) return false;
  // Reject if command contains $() or backtick substitutions
  if (/\$\(/.test(cmd) || /`/.test(cmd.replace(/'[^']*'/g, ''))) return false;
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

function checkDangerousGit(segment) {
  const words = stripWrappers(shellWords(segment));
  if (words.length === 0 || words[0] !== 'git') return false;
  const { subcommand, args } = gitSubcommand(words);
  if (subcommand === 'reset' && args.includes('--hard')) return true;
  if (subcommand === 'clean') return true;
  return false;
}

function isDangerousGitCommand(cmd) {
  return scanAllSegments(cmd, checkDangerousGit);
}

function checkDestructiveRm(words) {
  if (words[0] !== 'rm') return false;
  let hasRecursive = false;
  const targets = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--recursive') { hasRecursive = true; continue; }
    if (w.startsWith('-') && !w.startsWith('--')) {
      if (/[rR]/.test(w.slice(1))) hasRecursive = true;
      continue;
    }
    if (w.startsWith('--')) continue;
    targets.push(w);
  }
  if (!hasRecursive || targets.length === 0) return false;
  return targets.some(t => /^\/\s*$|^\/\*$|^~\s*$|^~\/*|^\$HOME\b|\$\{HOME\}|^\.\.\s*$|^\.\/\*$|^\*$/.test(t));
}

function isDestructiveShell(cmd) {
  return scanAllSegments(cmd, (seg) => {
    const words = stripWrappers(shellWords(seg));
    if (words.length === 0) return false;
    return checkDestructiveRm(words);
  });
}

function isDestructiveNonRm(cmd) {
  return scanAllSegments(cmd, (seg) => {
    const words = stripWrappers(shellWords(seg));
    if (words.length === 0) return false;
    return DESTRUCTIVE_NON_RM_PATTERNS.some(p => p.test(words.join(' ')));
  });
}

// PR write detection — command string version (scans all segments)
function isPrWriteCommand(cmd) {
  return scanAllSegments(cmd, (seg) => {
    const words = stripWrappers(shellWords(seg));
    if (words.length === 0) return false;
    let i = 0;
    while (i < words.length) {
      if (words[i] === 'gh') { i++; continue; }
      if (words[i] === '-R' || words[i] === '--repo') { i += 2; continue; }
      break;
    }
    if (i >= words.length) return false;
    const remaining = words.slice(i);
    return remaining[0] === 'pr' && PR_GATED_ACTIONS.has(remaining[1]);
  });
}

// PR write detection — pre-split words version (for guard's segment iteration)
function isPrWriteCommandWords(words) {
  let i = 0;
  while (i < words.length) {
    if (words[i] === 'gh') { i++; continue; }
    if (words[i] === '-R' || words[i] === '--repo') { i += 2; continue; }
    break;
  }
  if (i >= words.length) return false;
  const remaining = words.slice(i);
  if (remaining[0] !== 'pr') return false;
  return PR_GATED_ACTIONS.has(remaining[1]);
}

function findPrCommandInSegment(segment) {
  const words = stripWrappers(shellWords(segment));
  return isPrWriteCommandWords(words) ? words : null;
}

function isReadOnlyBash(command) {
  if (!command || typeof command !== 'string') return true;

  const segments = command.split(/(?:&&|\|\||[|;])/).map(s => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const words = stripWrappers(shellWords(segment));
    if (words.length === 0) return true;

    const cmd = words[0];
    const sub = words[1];

    if (cmd === 'git') {
      if (sub && READ_ONLY_GIT_SUB.has(sub)) continue;

      if (sub === 'branch') {
        if (words.every(w => !BRANCH_DESTRUCTIVE.test(w) && w !== '--delete')) continue;
        return false;
      }

      if (sub === 'remote') {
        const WRITE_ACTIONS = new Set(['add', 'remove', 'rename', 'set-url', 'set-head', 'delete', 'prune', 'update', 'set-branches', 'rm']);
        const rest = words.slice(2);
        if (rest.length === 0) continue;
        if (rest.some(w => WRITE_ACTIONS.has(w))) return false;
        continue;
      }

      if (sub === 'config') {
        const CONFIG_WRITE_FLAGS = new Set(['--add', '--unset', '--replace-all', '--unset-all', '--rename-section', '--remove-section']);
        if (words.some(w => CONFIG_WRITE_FLAGS.has(w))) return false;
        if (words.some(w => GIT_CONFIG_READ.has(w))) continue;
        return false;
      }

      if (sub === 'worktree') {
        const wtAction = words.slice(2).find(w => !w.startsWith('-'));
        if (wtAction && GIT_WORKTREE_READ.has(wtAction)) continue;
        return false;
      }

      if (sub === 'reflog') {
        const rlAction = words.slice(2).find(w => !w.startsWith('-'));
        if (rlAction && GIT_REFLOG_READ.has(rlAction)) continue;
        return false;
      }

      return false;
    }

    if (cmd === 'gh') {
      const resource = words[1];
      const action = words[2];
      if (resource === 'pr' || resource === 'issue') {
        if (action && READ_ONLY_GH_ACTION.has(action)) continue;
        return false;
      }
      if (resource === 'api') {
        const hasMethod = words.some(w => w === '-X' || w === '--method');
        const hasFormField = words.some(w => w === '-f' || w === '--field' || w === '-F' || w === '--raw-field');
        if (hasMethod || hasFormField) return false;
        continue;
      }
      return false;
    }

    if (READ_ONLY_CMDS.has(cmd)) continue;
    if (CODE_WRITE_CMDS.has(cmd)) return false;
    return false;
  }

  return true;
}

module.exports = {
  READ_ONLY_TOOLS,
  MCP_READ_ONLY_RE,
  SENSITIVE_PATH_RE,
  PR_GATED_ACTIONS,
  WORKFLOW_CODEX_PATTERNS,
  DESTRUCTIVE_NON_RM_PATTERNS,
  READ_ONLY_GIT_SUB,
  GIT_REMOTE_READ,
  GIT_CONFIG_READ,
  GIT_WORKTREE_READ,
  GIT_REFLOG_READ,
  READ_ONLY_GH_ACTION,
  READ_ONLY_CMDS,
  CODE_WRITE_CMDS,
  BRANCH_DESTRUCTIVE,
  shellWords,
  stripWrappers,
  splitCompound,
  splitPipes,
  gitSubcommand,
  extractDollarParens,
  extractNestedCommands,
  scanAllSegments,
  isSensitivePath,
  isWorkflowCodexCall,
  checkDangerousGit,
  isDangerousGitCommand,
  checkDestructiveRm,
  isDestructiveShell,
  isDestructiveNonRm,
  isPrWriteCommand,
  isPrWriteCommandWords,
  findPrCommandInSegment,
  isReadOnlyBash,
};
