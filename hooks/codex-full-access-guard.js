#!/usr/bin/env node
// Claude Code PreToolUse guard — Codex Full Access mode.
// Read-only tools pass through immediately.
// Write tools are delegated to Codex for a SAFE/HUMAN decision.
// Only Codex HUMAN verdicts pause to ask the user.
//
// PR commands (gh pr create/merge/close/reopen) get enriched git context
// so Codex can judge risk based on actual branch/commit/diff state.
// When Codex is offline, falls through to human permission prompt.

const { spawnSync } = require('child_process');

// PR commands that get enriched context for Codex judgment
const PR_GATED_ACTIONS = new Set(['create', 'merge', 'close', 'reopen']);

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

// Read-only git subcommands — no Codex overhead
// NOTE: `branch` is listed here because `git branch` without -d/-D/-m/-M is read-only.
// Destructive branch flags are caught below.
const READ_ONLY_GIT_SUB = new Set([
  'status', 'log', 'diff', 'show',
  'remote', 'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'config', 'describe',
  'blame', 'shortlog', 'reflog',
  'worktree',
]);

// Read-only gh subcommands
const READ_ONLY_GH_ACTION = new Set([
  'view', 'list', 'status', 'checks', 'diff',
]);

// Commands that are read-only WITHOUT destructive flags
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

// Commands that can mutate files but are often used read-only — always ask Codex
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

// Destructive branch flags that turn `git branch` into a write
const BRANCH_DESTRUCTIVE = /^-[dDmM]/;

// ── PR context gathering ──────────────────────────────────────────────

function isPrWriteCommand(words) {
  if (words[0] !== 'gh') return false;
  if (words[1] !== 'pr') return false;
  return PR_GATED_ACTIONS.has(words[2]);
}

function execGit(args, cwd, fallback) {
  try {
    const result = spawnSync('git', args, {
      timeout: 5000,
      maxBuffer: 65536,
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return (result.stdout || result.stderr || '').trim() || fallback;
  } catch {
    return fallback;
  }
}

function gatherPrContext(cwd) {
  return {
    branch: execGit(['branch', '--show-current'], cwd, 'unknown'),
    baseBranch: execGit(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd, '')
      || execGit(['remote', 'show', 'origin'], cwd, '').match(/HEAD branch:\s*(\S+)/)?.[1]
      || 'main',
    commitsAhead: execGit(['rev-list', '--count', 'HEAD', '--not', '@{u}'], cwd, '?'),
    commitsBehind: execGit(['rev-list', '--count', '@{u}', '--not', 'HEAD'], cwd, '?'),
    lastCommits: execGit(['log', '--oneline', '-5'], cwd, '(no commits)'),
    changedFiles: execGit(['diff', '--stat', 'HEAD', '@{u}'], cwd, '(no diff)'),
    hasUncommitted: execGit(['status', '--porcelain'], cwd, '').length > 0,
    remoteUrl: execGit(['remote', 'get-url', 'origin'], cwd, 'unknown'),
  };
}

function buildPrPrompt(toolName, toolInput, cwd) {
  const ctx = gatherPrContext(cwd);
  const cmd = String(toolInput?.command || '');

  return [
    '你是一個 PR 安全閘道，負責判斷這個 GitHub PR 操作是否應被允許自動執行。',
    '',
    '=== Git 上下文（自動收集） ===',
    `目前分支: ${ctx.branch}`,
    `目標基礎分支: ${ctx.baseBranch}`,
    `比 remote 超前 commit 數: ${ctx.commitsAhead}`,
    `比 remote 落後 commit 數: ${ctx.commitsBehind}`,
    `最近 5 個 commits:`,
    ...ctx.lastCommits.split('\n').map(l => `  ${l}`),
    `與 upstream 的差異 (--stat):`,
    ...ctx.changedFiles.split('\n').map(l => `  ${l}`),
    `有未 commit 變更: ${ctx.hasUncommitted ? '是' : '否'}`,
    `Remote origin: ${ctx.remoteUrl}`,
    '',
    '=== 即將執行的指令 ===',
    cmd,
    '',
    '=== 判斷標準 ===',
    '回答 SAFE（允許自動執行）如果：',
    '- 分支看起來是正常的 feature/bugfix/chore 分支',
    '- 有實際變更（至少一個 commit），不是空分支',
    '- 沒有未 commit 的變更（已全部 commit）',
    '- 目標是合理的基礎分支（main/master/develop）',
    '- PR 標題看起來是認真的（不是 WIP/DONT MERGE/test 等明顯測試）',
    '',
    '回答 HUMAN（退回問人類）如果：',
    '- 分支是 main/master/production/release 等重要分支直接發 PR',
    '- 目標分支看起來不對（例如發到錯誤的 repo）',
    '- 分支是空的或幾乎沒有變更（超前 commit 數 = 0）',
    '- PR 標題包含 WIP/DO NOT MERGE/測試/draft 等字眼',
    '- 變更範圍包含 .env/credentials/secrets 等敏感檔案',
    '- 有不確定性，你無法判斷',
    '',
    '只回答一個字：SAFE 或 HUMAN。',
  ].join('\n');
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
  while (result[0] === 'rtk') {
    result.shift();
    if (result[0] === 'proxy') result.shift();
  }
  while (result[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(result[0])) result.shift();
  while (result[0] === 'command' || result[0] === 'env') result.shift();
  return result;
}

function isReadOnlyBash(command) {
  if (!command || typeof command !== 'string') return true;

  // Split on && || ; | — treat as potentially compound
  const segments = command.split(/(?:&&|\|\||[|;])/).map(s => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const words = stripWrappers(shellWords(segment));
    if (words.length === 0) return true;

    const cmd = words[0];
    const sub = words[1];

    // git
    if (cmd === 'git') {
      if (sub && READ_ONLY_GIT_SUB.has(sub)) continue; // truly read-only
      if (sub === 'branch') {
        // branch with no args or --list → read-only
        if (words.every(w => !BRANCH_DESTRUCTIVE.test(w) && w !== '--delete')) continue;
        return false; // branch -d/-D/-m/-M → write
      }
      // Other git commands (push, commit, merge, rebase, tag, stash, checkout, switch, reset) → write
      return false;
    }

    // gh
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
      // Unknown gh subcommand → ask Codex
      return false;
    }

    // Safely read-only commands
    if (READ_ONLY_CMDS.has(cmd)) continue;

    // Commands that COULD write → always ask Codex
    if (CODE_WRITE_CMDS.has(cmd)) return false;

    // Anything unknown → ask Codex
    return false;
  }

  // All segments are read-only
  return true;
}

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

function summarizeInput(toolName, toolInput) {
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    return `Command: ${cmd.substring(0, 500)}`;
  }
  if (toolName === 'Write') {
    const fp = String(toolInput.file_path || '');
    const content = String(toolInput.content || '');
    return `File: ${fp}\nContent preview: ${content.substring(0, 300)}`;
  }
  if (toolName === 'Edit') {
    const fp = String(toolInput.file_path || '');
    const oldStr = String(toolInput.old_string || '');
    const newStr = String(toolInput.new_string || '');
    return `File: ${fp}\nOld: ${oldStr.substring(0, 200)}\nNew: ${newStr.substring(0, 200)}`;
  }
  if (toolName === 'MultiEdit') {
    const edits = toolInput.edits || [];
    const files = [...new Set(edits.map(e => e.file_path))].join(', ');
    return `Files: ${files}\nEdit count: ${edits.length}`;
  }
  if (toolName === 'Agent') {
    const desc = String(toolInput.description || '');
    const prompt = String(toolInput.prompt || '');
    return `Agent: ${desc}\nPrompt preview: ${prompt.substring(0, 300)}`;
  }
  if (toolName === 'TaskCreate' || toolName === 'TaskUpdate') {
    const subject = String(toolInput.subject || '');
    return `${toolName}: ${subject}`;
  }
  if (toolName === 'NotebookEdit') {
    const fp = String(toolInput.notebook_path || '');
    return `Notebook: ${fp}`;
  }
  if (toolName === 'CronCreate' || toolName === 'CronDelete') {
    const cronPrompt = String(toolInput.prompt || '');
    return `${toolName}: ${cronPrompt.substring(0, 300)}`;
  }
  if (toolName === 'EnterWorktree' || toolName === 'ExitWorktree') {
    return `${toolName}`;
  }
  if (toolName === 'Workflow') {
    const desc = String(toolInput.description || '');
    return `Workflow: ${desc.substring(0, 300)}`;
  }
  return JSON.stringify(toolInput).substring(0, 500);
}

function callJudgeAPI(apiKey, model, prompt, timeout) {
  const payload = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 10,
    temperature: 0,
  });

  const result = spawnSync('curl', [
    '-s', '-m', String(Math.ceil(timeout / 1000)),
    'https://api.deepseek.com/v1/chat/completions',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', payload,
  ], {
    timeout,
    maxBuffer: 65536,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    const data = JSON.parse(result.stdout || '{}');
    const content = data.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
    // Exact match only — prevent substring bypass (UNSAFE, SAFETY etc.)
    if (/^(SAFE)$/.test(content)) return 'SAFE';
    if (/^(HUMAN)$/.test(content)) return 'HUMAN';
  } catch {}
  return null;
}

function askCodex(toolName, toolInput, cwd, prContextWords) {
  const summary = summarizeInput(toolName, toolInput);

  // PR commands get enriched git context for better judgment
  const isPrCmd = prContextWords && isPrWriteCommand(prContextWords);
  const prompt = isPrCmd
    ? buildPrPrompt(toolName, toolInput, cwd)
    : [
        'Safety gate: judge this tool call. Reply ONLY "SAFE" or "HUMAN".',
        `Tool: ${toolName}`,
        `Directory: ${cwd || 'unknown'}`,
        summary,
        '',
        'Rules:',
        '- SAFE = everyday dev work: editing source files, running tests, git push/commit/fetch/pull,',
        '  git merge/rebase on feature branches, git branch (create/switch), git stash, git tag,',
        '  installing dependencies (npm/pnpm/yarn/bun/cargo/go), searching, scaffolding,',
        '  creating/closing/reopening PRs and issues (gh pr/issue create/comment/review/close/reopen),',
        '  deleting/moving files (rm/mv), and other normal dev workflow actions.',
        '- HUMAN = force push to main/master, git push --delete main/master,',
        '  git branch -D on main/master/protected branches, force-altering shared history,',
        '  removing/changing .env/credentials/keys/secrets files,',
        '  production database or infrastructure mutations,',
        '  rm -rf on root/home/wildcard targets,',
        '  or operations where you genuinely cannot determine the risk.',
        '',
        'Key rule: force push to feature branches is SAFE (common rebase workflow).',
        'Force push / branch delete targeting main/master/production → HUMAN.',
        'Normal git operations (merge/rebase/checkout/branch without -D) on any branch → SAFE.',
        'Reply with exactly one word: SAFE or HUMAN.',
      ].join('\n');

  // Primary: Codex
  try {
    const result = spawnSync('codex', [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', prompt,
    ], {
      timeout: 12000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = (result.stdout || '').trim();
    if (stdout) {
      const tail = stdout.split('\n').slice(-10).join('\n').toUpperCase();
      const verdictMatch = tail.match(/(?:^|\n)\s*(SAFE|HUMAN)\s*(?:\n|$)/);
      if (verdictMatch) return verdictMatch[1];
    }
    process.stderr.write(`[codex-full-access] Codex returned no verdict, falling back to DeepSeek\n`);
  } catch (err) {
    process.stderr.write(`[codex-full-access] Codex unavailable: ${err.message}, falling back to DeepSeek\n`);
  }

  // Fallback: DeepSeek API
  try {
    const dsKey = process.env.DEEPSEEK_API_KEY;
    if (dsKey) {
      const verdict = callJudgeAPI(dsKey, 'deepseek-chat', prompt, 10000);
      if (verdict === 'SAFE') return 'SAFE';
      if (verdict === 'HUMAN') return 'HUMAN';
    }
    process.stderr.write(`[codex-full-access] DeepSeek API also returned no verdict, asking human\n`);
  } catch (err) {
    process.stderr.write(`[codex-full-access] DeepSeek API also unavailable: ${err.message}, asking human\n`);
  }

  // Both down — ask human
  return 'HUMAN';
}

process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName;

    if (!toolName) {
      process.exit(0);
    }

    // Read-only built-in tools — pass through immediately
    if (READ_ONLY_TOOLS.has(toolName)) {
      process.exit(0);
    }

    // File writes are normal dev work — pass through immediately
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
      process.exit(0);
    }

    // MCP read-only tools — pass through immediately
    if (MCP_READ_ONLY_RE.test(toolName)) {
      process.exit(0);
    }

    const toolInput = data.tool_input || data.toolInput || {};
    const cwd = data.cwd || process.cwd();

    // Read-only Bash commands — pass through immediately
    let prContextWords = null;
    if (toolName === 'Bash') {
      const command = String(toolInput.command || '');
      if (isReadOnlyBash(command)) {
        process.exit(0);
      }
      // Detect PR write commands for enriched git context
      const words = stripWrappers(shellWords(command));
      if (isPrWriteCommand(words)) {
        prContextWords = words;
      }
    }

    const verdict = askCodex(toolName, toolInput, cwd, prContextWords);

    if (verdict === 'SAFE') {
      process.exit(0);
    }

    const reason = `[Codex Full Access] Codex 認為此操作需要人類判斷才能執行。\nTool: ${toolName}\n請確認是否允許此操作。`;
    respond('ask', reason);
  } catch {
    process.exit(0);
  }
});
