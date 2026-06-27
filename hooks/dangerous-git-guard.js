#!/usr/bin/env node
// Claude Code PreToolUse guard — only blocks truly dangerous git/gh operations.
// Ask-level decisions are handled by codex-full-access-guard.js downstream.

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
  const raw = segment.toLowerCase();
  const words = stripWrappers(shellWords(segment));
  if (words.length === 0) {
    return null;
  }

  if (['bash', 'sh', 'zsh'].includes(words[0])) {
    const commandIndex = words.findIndex(word => word === '-c' || word === '-lc' || word === '-ic');
    if (commandIndex >= 0 && words[commandIndex + 1]) {
      const nestedCommand = words.slice(commandIndex + 1).join(' ');
      return splitCommands(nestedCommand).map(dangerousSegment).find(Boolean) || null;
    }
  }

  if (words[0] === 'git') {
    const { subcommand, args } = gitSubcommand(words);
    // Block git reset --hard
    if (subcommand === 'reset' && args.includes('--hard')) {
      return { decision: 'deny', reason: 'git reset --hard is blocked because it can destroy user changes.' };
    }
    // Block git clean
    if (subcommand === 'clean') {
      return { decision: 'deny', reason: 'git clean is blocked because it can delete untracked user files.' };
    }
    // Block force push: --force, -f, --force-with-lease, +refspec, --mirror, --delete
    if (subcommand === 'push') {
      if (args.some(arg => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease') || arg === '--mirror' || arg === '--delete')) {
        return { decision: 'deny', reason: `git push ${args.find(a => a.startsWith('--')) || 'force'} is blocked globally. Ask the user to run it manually if it is truly required.` };
      }
      if (args.some(arg => arg.startsWith('+') && arg.length > 1 && !arg.startsWith('++'))) {
        // +refspec (e.g., +main) is a force push
        return { decision: 'deny', reason: 'Force push via +refspec is blocked globally. Ask the user to run it manually if it is truly required.' };
      }
    }
    // All other git operations (push, commit, merge, rebase, checkout, branch...) → let Codex judge
    return null;
  }

  if (words[0] === 'gh') {
    // All gh operations → let Codex judge (no blocking needed at this level)
    return null;
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

    const finding = splitCommands(command).map(dangerousSegment).find(r => r && r.decision === 'deny');
    if (finding) {
      respond('deny', finding.reason);
    }
  } catch {
    process.exit(0);
  }
});
