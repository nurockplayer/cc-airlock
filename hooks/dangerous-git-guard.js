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
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
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
  while (result[0] === 'rtk') { result.shift(); if (result[0] === 'proxy') result.shift(); }
  while (result[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(result[0])) result.shift();
  while (result[0] === 'command' || result[0] === 'env') result.shift();
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

function dangerousSegment(segment) {
  const words = stripWrappers(shellWords(segment));
  if (words.length === 0) return null;
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
  const shellWrap = command.match(/(?:^|\s)(?:bash|sh|zsh)(?:\s+-[lc]+\s*|\s+)(["'])((?:[^"\\']|\\.)*?)\1/i);
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
    if (finding && finding.decision === 'deny') return finding;
  }
  return null;
}

process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName;
    if (toolName !== 'Bash') { process.exit(0); }

    const command = String(data.tool_input?.command || data.toolInput?.command || '');
    if (!command) { process.exit(0); }

    const finding = scanDeep(command);
    if (finding) { respond('deny', finding.reason); }
  } catch { process.exit(0); }
});
