#!/usr/bin/env node
// Claude Code PreToolUse guard — hard floor for truly dangerous operations.
// Only blocks operations that irreversibly destroy LOCAL state.
// Everything else passes through to the Codex judgment layer.
//
// Security: recursively scans pipeline (|), command substitution ($() and ``),
// and process substitution (<()) to prevent bypass via shell composition.

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
});

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

function shellWords(command) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) {
    words.push(current);
  }
  return words;
}

// Recursively extract sub-commands from shell constructs that can hide
// dangerous operations: pipes, $(), backticks, <(), and bash -c wrappers.
function extractAllSubcommands(command, depth) {
  if (depth > 8) return []; // guard against pathological nesting
  const results = [];

  // bash/sh/zsh -c "..." — extract the inner command string
  const shellWrap = command.match(/(?:^|\s)(?:bash|sh|zsh)(?:\s+-[lc]+\s*|\s+)(["'`])((?:[^"\\'`]|\\.)*?)\1/i);
  if (shellWrap) {
    results.push(...extractAllSubcommands(shellWrap[2], depth + 1));
  }

  // $() command substitution — extract content inside (captures nested parens)
  const dollarParen = command.match(/\$\(([\s\S]*)\)/);
  if (dollarParen) {
    results.push(...extractAllSubcommands(dollarParen[1], depth + 1));
  }

  // Backtick command substitution
  const backtickMatch = command.match(/`([^`]*)`/);
  if (backtickMatch) {
    results.push(...extractAllSubcommands(backtickMatch[1], depth + 1));
  }

  // <() process substitution
  const procSub = command.match(/<\(([\s\S]*)\)/);
  if (procSub) {
    results.push(...extractAllSubcommands(procSub[1], depth + 1));
  }

  // Split on pipes (|) — but NOT || (logical or) which is handled by splitCommands
  const pipeParts = command.split(/(?<!\|)\|(?!\|)/);
  for (const part of pipeParts) {
    results.push(part.trim());
  }

  return results.length > 0 ? results : [command];
}

function splitCommands(command) {
  return command
    .replace(/\\\n/g, ' ')
    .split(/(?:&&|\|\||;|\n)/)
    .map(part => part.trim())
    .filter(Boolean);
}

function stripWrappers(words) {
  const result = [...words];

  while (result[0] && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(result[0])) {
    result.shift();
  }
  while (result[0] === 'command' || result[0] === 'env') {
    result.shift();
  }
  while (result[0] === 'rtk') {
    result.shift();
    if (result[0] === 'proxy') {
      result.shift();
    }
  }

  return result;
}

function gitSubcommand(words) {
  let i = 1;
  const optionsWithValues = new Set([
    '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env',
  ]);

  while (i < words.length && words[i].startsWith('-')) {
    const option = words[i];
    i += 1;
    if (optionsWithValues.has(option) && i < words.length) {
      i += 1;
    }
  }

  return { subcommand: words[i] || '', args: words.slice(i + 1) };
}

function dangerousSegment(segment) {
  const words = stripWrappers(shellWords(segment));
  if (words.length === 0) {
    return null;
  }

  if (words[0] === 'git') {
    const { subcommand, args } = gitSubcommand(words);

    // Hard-deny: destroys local uncommitted work with no recovery
    if (subcommand === 'reset' && args.includes('--hard')) {
      return { decision: 'deny', reason: 'git reset --hard 會永久銷毀未 commit 的變更。若確定要執行請手動操作。' };
    }

    // Hard-deny: deletes untracked local files
    if (subcommand === 'clean') {
      return { decision: 'deny', reason: 'git clean 會永久刪除未追蹤的檔案。若確定要執行請手動操作。' };
    }

    // Everything else → passes through to Codex
    return null;
  }

  if (words[0] === 'gh') {
    return null;
  }

  return null;
}

function scanDeep(command) {
  const segments = splitCommands(command);
  for (const segment of segments) {
    const subs = extractAllSubcommands(segment, 0);
    for (const sub of subs) {
      const finding = dangerousSegment(sub);
      if (finding && finding.decision === 'deny') return finding;
    }
  }
  return null;
}

process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName;
    if (toolName !== 'Bash') {
      process.exit(0);
    }

    const command = String(data.tool_input?.command || data.toolInput?.command || '');
    if (!command) {
      process.exit(0);
    }

    const finding = scanDeep(command);
    if (finding) {
      respond('deny', finding.reason);
    }
    // If no hard denial, exit silently → flows to codex-full-access-guard.js next
  } catch {
    process.exit(0);
  }
});
