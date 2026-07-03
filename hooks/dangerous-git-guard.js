#!/usr/bin/env node
// Claude Code PreToolUse guard — hard floor for truly dangerous operations.
//
// Recursively scans shell constructs for git reset --hard / git clean:
//   pipes (|), $(), backticks, <(), bash -c, and compound separators
//   (; && || \n) — but only splits on separators OUTSIDE of $()/``/<().
//
// Extraction order matters: $()/backticks/<()/bash -c are extracted FIRST
// (innermost match), then compound separators are applied to the remaining
// text. This prevents ; inside $() from being treated as top-level.

let input = '';
const stdinTimeout = setTimeout(() => {
  respond('ask', '[cc-airlock] 危險 Git 守衛 stdin 逾時，為安全起見請手動確認。');
  process.exit(1);
}, 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });

function respond(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  }));
}

function splitCompound(text) {
  return text
    .split(/(?:;(?!\s*[;])|&&|\|\||\n)/)
    .map(s => s.trim())
    .filter(Boolean);
}

function splitPipes(text) {
  return text.split(/(?<!\|)\|(?!\|)/).map(s => s.trim()).filter(Boolean);
}

function extractInnermost(text, regex, groupIdx) {
  // Extract innermost matches iteratively (non-greedy)
  const results = [];
  let match;
  while ((match = text.match(regex)) !== null) {
    results.push(match[groupIdx]);
    text = text.replace(match[0], ''); // remove matched region
  }
  return results;
}

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

function gitSubcommand(words) {
  let i = 1;
  const optionsWithValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  while (i < words.length && words[i].startsWith('-')) {
    const opt = words[i]; i += 1;
    if (optionsWithValues.has(opt) && i < words.length) i += 1;
  }
  return { subcommand: words[i] || '', args: words.slice(i + 1) };
}

// Deterministic patterns for destructive shell commands (deny)
// These match after wrapper stripping so env/command/rtk wrappers don't bypass.
const DESTRUCTIVE_SHELL_DENY = [
  // rm -rf targeting root, home, wildcards
  { pattern: /^rm\s+(-r[^]*|-rf[^]*|--recursive\b)/, desc: 'recursive rm' },
];

// Patterns that should ask the user (not auto-pass to Codex)
const DESTRUCTIVE_SHELL_ASK = [
  { pattern: /^find\s+\/.*-delete/, desc: 'find -delete from root' },
  { pattern: /^sudo\s+rm\s/, desc: 'sudo rm' },
  { pattern: /^docker\s+system\s+prune/, desc: 'docker system prune' },
  { pattern: /^docker\s+volume\s+rm\b/, desc: 'docker volume rm' },
  { pattern: /^kubectl\s+delete\s+namespace\b/, desc: 'kubectl delete namespace' },
  { pattern: /^terraform\s+destroy\b/, desc: 'terraform destroy' },
  { pattern: /^chmod\s+-R\s+777\s+\//, desc: 'chmod -R 777 /' },
  { pattern: /^chown\s+-R\s+\//, desc: 'chown -R /' },
];

function checkDestructiveTarget(words) {
  if (words[0] === 'rm') {
    // Word-level rm flag parsing — handles all recursive variants:
    // -rf, -fr, -R, --recursive --force, -r, -Rf, -rfx, etc.
    let hasRecursive = false;
    let target = null;

    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === '--recursive') {
        hasRecursive = true;
        continue;
      }
      if (w.startsWith('-') && !w.startsWith('--')) {
        // Short flag bundle: -rf, -fr, -R, -Rf, -rfx, etc.
        if (/[rR]/.test(w.slice(1))) hasRecursive = true;
        continue;
      }
      if (w.startsWith('--')) {
        // Other long flags (--force, --one-file-system, etc.)
        continue;
      }
      // First non-flag argument = target
      target = w;
      break;
    }

    if (hasRecursive && target) {
      const rootDanger = /^\/\s*$|^\/\*$|^~\s*$|^\$HOME\b|^\.\.\s*$|^\.\/\*$|^\*$/.test(target);
      if (rootDanger) {
        return { decision: 'deny', reason: `rm -rf 指向危險路徑（${target}），此操作會永久刪除大量系統檔案。請手動操作。` };
      }
    }
    // Non-root / non-destructive rm passes through
  }

  // Ask patterns for non-rm (and non-destructive-rm) commands
  const full = words.join(' ');
  for (const { pattern, desc } of DESTRUCTIVE_SHELL_ASK) {
    if (pattern.test(full)) {
      return { decision: 'ask', reason: `偵測到潛在破壞性操作（${desc}）。請確認是否允許。` };
    }
  }
  return null;
}

function dangerousSegment(segment) {
  const words = stripWrappers(shellWords(segment));
  if (words.length === 0) return null;

  // Check destructive shell commands first (any tool, not just git)
  const destructive = checkDestructiveTarget(words);
  if (destructive) return destructive;

  if (words[0] !== 'git') return null;
  const { subcommand, args } = gitSubcommand(words);
  if (subcommand === 'reset' && args.includes('--hard')) {
    return { decision: 'deny', reason: 'git reset --hard 會永久銷毀未 commit 的變更。若確定要執行請手動操作。' };
  }
  if (subcommand === 'clean') {
    return { decision: 'deny', reason: 'git clean 會永久刪除未追蹤的檔案。若確定要執行請手動操作。' };
  }
  return null;
}

// ── Core: depth-first extraction ─────────────────────────────────────

function extractAllSubcommands(command, depth) {
  if (depth > 10 || !command || typeof command !== 'string') return [];
  const candidates = [];

  // Phase 1: extract innermost shell constructs that hide commands.
  // Each extracted inner content is compound-split and recursively scanned.

  // $() — innermost first (non-greedy)
  const dollarParens = extractInnermost(command, /\$\(([\s\S]*?)\)/, 1);
  for (const inner of dollarParens) {
    for (const piece of splitCompound(inner)) {
      candidates.push(...extractAllSubcommands(piece, depth + 1));
    }
  }

  // backticks — innermost first
  const backticks = extractInnermost(command, /`([\s\S]*?)`/, 1);
  for (const inner of backticks) {
    for (const piece of splitCompound(inner)) {
      candidates.push(...extractAllSubcommands(piece, depth + 1));
    }
  }

  // <() process substitution
  const procSubs = extractInnermost(command, /<\(([\s\S]*?)\)/, 1);
  for (const inner of procSubs) {
    for (const piece of splitCompound(inner)) {
      candidates.push(...extractAllSubcommands(piece, depth + 1));
    }
  }

  // bash/sh/zsh -c "..."
  const shellCRe = /(?:^|\s)(?:bash|sh|zsh)(?:\s+-[lc]+\s*|\s+)(["'])((?:[^"\\']|\\.)*?)\1/i;
  const shellWrap = command.match(shellCRe);
  if (shellWrap) {
    for (const piece of splitCompound(shellWrap[2])) {
      candidates.push(...extractAllSubcommands(piece, depth + 1));
    }
  }

  // Phase 2: now that hidden commands are extracted, split the original
  // command on compound separators and pipes.
  const compoundParts = splitCompound(command);
  for (const part of compoundParts) {
    // Skip if this part only differs in whitespace from an already-extracted sub
    const pipeParts = splitPipes(part);
    for (const pp of pipeParts) {
      const trimmed = pp.trim();
      if (trimmed) candidates.push(trimmed);
    }
  }

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (!seen.has(c)) { seen.add(c); unique.push(c); }
  }
  return unique.length > 0 ? unique : [command];
}

function scanDeep(command) {
  const subs = extractAllSubcommands(command, 0);
  for (const sub of subs) {
    const finding = dangerousSegment(sub);
    if (finding) return finding;
  }
  return null;
}

process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName;
    if (!toolName) {
      respond('ask', '[cc-airlock] 危險 Git 守衛：缺少工具名稱，為安全起見請手動確認。');
      return;
    }
    if (toolName !== 'Bash') { process.exit(0); return; }

    const command = String(data.tool_input?.command || data.toolInput?.command || '');
    if (!command) { process.exit(0); }

    const finding = scanDeep(command);
    if (finding) { respond(finding.decision, finding.reason); }
  } catch {
    respond('ask', '[cc-airlock] 危險 Git 守衛發生未預期錯誤，為安全起見請手動確認。');
  }
});
