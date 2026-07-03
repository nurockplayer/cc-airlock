#!/usr/bin/env node
const { spawnSync } = require('child_process');

const CODEX_TIMEOUT_MS = positiveInt(process.env.CC_AIRLOCK_CODEX_TIMEOUT_MS, 45000);
const DEEPSEEK_TIMEOUT_MS = positiveInt(process.env.CC_AIRLOCK_DEEPSEEK_TIMEOUT_MS, 20000);
const GIT_FAST_PATH = process.env.CC_AIRLOCK_GIT_FAST_PATH !== '0';

const SENSITIVE_PATH_RE = /(?:^|\/)(\.env[^\/]*|credentials[^\/]*|secrets?[^\/]*|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.key|.*\.pfx|.*\.p12|service-account[^\/]*\.json)(?:$|\/)/i;
const PROTECTED_BRANCH_RE = /^(?:refs\/heads\/)?(?:main|master|production|prod|stable|release|release\/.+)$/i;

const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'TaskList', 'TaskGet', 'TaskOutput',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode', 'WebFetch', 'WebSearch', 'CronList',
  'Skill', 'Plan', 'NotebookRead',
]);
const MCP_READ_ONLY_RE = /^mcp__.+__(?:read|list|search|get|query|resolve|check|load|stats|summary|timeline|lint|lsp_)/i;
const READ_ONLY_GIT_SUB = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'blame', 'shortlog']);
const READ_ONLY_GH_ACTION = new Set(['view', 'list', 'status', 'checks', 'diff']);
const READ_ONLY_CMDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'which', 'whoami', 'date', 'uname', 'df', 'du', 'file', 'stat', 'env', 'printenv', 'basename', 'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut', 'tr', 'grep', 'rg', 'ag', 'jq', 'yq', 'tree', 'comm', 'diff', 'cmp']);
const CODE_WRITE_CMDS = new Set(['echo', 'printf', 'sed', 'awk', 'find', 'xargs', 'tee', 'node', 'python', 'python3', 'ruby', 'perl', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'rustc', 'make', 'cmake', 'open', 'say', 'codex', 'gemini', 'rtk']);
const WORKFLOW_CODEX_PATTERNS = [/Implementation\s*Spec/i, /Spec\s*Compliance/i, /Spec\s*Adequacy/i, /雙重驗證/, /規格合規性/, /Analysis\s*Packet/i, /Decision\s*boundar(y|ies)/i, /\[ASK\s*CODEX\]/i, /\[Executors\s*may\s*decide\]/i, /\[DO\s*NOT\s*CHANGE\]/i];

let input = '';
const stdinTimeout = setTimeout(() => {
  respond('ask', '[cc-airlock] stdin 逾時，無法解析工具呼叫。為安全起見請手動確認。');
  process.exit(1);
}, 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', main);

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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
  for (const ch of String(command || '')) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; else current += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { words.push(current); current = ''; } continue; }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

function splitCompound(command) {
  return String(command || '').split(/(?:;(?!\s*[;])|&&|\|\||\n)/).map(s => s.trim()).filter(Boolean);
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
    const opt = words[i++];
    if (optionsWithValues.has(opt) && i < words.length) i++;
  }
  return { subcommand: words[i] || '', args: words.slice(i + 1) };
}

function normalizeBranch(raw) {
  return String(raw || '').replace(/^refs\/heads\//, '').replace(/^origin\//, '').replace(/^:/, '').trim();
}

function isProtectedBranch(raw) {
  const branch = normalizeBranch(raw);
  return Boolean(branch) && PROTECTED_BRANCH_RE.test(branch);
}

function execGit(args, cwd, fallback) {
  try {
    const result = spawnSync('git', args, { timeout: 5000, maxBuffer: 65536, encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {}
  return fallback;
}

function currentBranch(cwd) {
  return execGit(['branch', '--show-current'], cwd, '') || '';
}

function extractPushRefspecs(args) {
  const positional = [];
  const flagsWithValue = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!w) continue;
    if (flagsWithValue.has(w)) { i++; continue; }
    if (w === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!w.startsWith('-')) positional.push(w);
  }
  return positional.slice(1);
}

function classifyGitSegment(words, cwd) {
  const { subcommand, args } = gitSubcommand(words);
  if (!subcommand) return { decision: 'review', reason: 'missing git subcommand' };
  if (READ_ONLY_GIT_SUB.has(subcommand)) return { decision: 'safe', reason: `git ${subcommand} is read-only` };

  if (subcommand === 'reset' && args.includes('--hard')) return { decision: 'human', reason: 'git reset --hard can discard local work' };
  if (subcommand === 'clean') return { decision: 'human', reason: 'git clean can delete untracked files' };

  if (subcommand === 'push') {
    const forcePush = args.some(a => a === '-f' || a === '--force' || a === '--force-with-lease' || a.startsWith('--force-with-lease='));
    const deletePush = args.some(a => a === '-d' || a === '--delete') || args.some(a => /^:(?:refs\/heads\/)?\S+/.test(a));
    const refspecs = extractPushRefspecs(args);
    const protectedTarget = refspecs.some(ref => isProtectedBranch(ref.includes(':') ? ref.split(':').pop() : ref));
    if ((forcePush || deletePush) && protectedTarget) return { decision: 'human', reason: 'force/delete push targets a protected branch' };
    if ((forcePush || deletePush) && refspecs.length === 0 && isProtectedBranch(currentBranch(cwd))) return { decision: 'human', reason: 'force/delete push from protected current branch' };
    return { decision: 'safe', reason: 'git push does not force/delete a protected branch' };
  }

  if (subcommand === 'branch') {
    const destructive = args.some(a => /^-[dDmM]/.test(a) || a === '--delete');
    if (!destructive) return { decision: 'safe', reason: 'git branch create/list is routine' };
    const protectedTarget = args.filter(a => !a.startsWith('-')).some(isProtectedBranch);
    return protectedTarget ? { decision: 'human', reason: 'git branch delete/rename targets a protected branch' } : { decision: 'safe', reason: 'git branch mutation is not targeting a protected branch' };
  }

  if (subcommand === 'checkout' || subcommand === 'switch') {
    const forceCreate = args.some(a => a === '-B' || a === '-C' || a === '--force-create');
    const force = args.some(a => a === '-f' || a === '--force');
    const target = args.find(a => !a.startsWith('-')) || '';
    if ((forceCreate || force) && isProtectedBranch(target)) return { decision: 'human', reason: `git ${subcommand} force operation targets a protected branch` };
    return { decision: 'safe', reason: `git ${subcommand} is routine branch navigation` };
  }

  if (['fetch', 'pull', 'add', 'commit', 'stash', 'merge', 'rebase'].includes(subcommand)) return { decision: 'safe', reason: `git ${subcommand} is routine` };
  if (subcommand === 'tag') return args.some(a => a === '-d' || a === '--delete') ? { decision: 'review', reason: 'git tag deletion should be reviewed' } : { decision: 'safe', reason: 'git tag create/list is routine' };
  if (subcommand === 'remote') {
    const writeActions = new Set(['add', 'remove', 'rename', 'set-url', 'set-head', 'delete', 'prune', 'update', 'set-branches', 'rm']);
    if (args.some(w => writeActions.has(w))) return { decision: 'review', reason: 'git remote mutation should be reviewed' };
    return { decision: 'safe', reason: 'git remote read-only query' };
  }
  if (subcommand === 'config') {
    const writeFlags = new Set(['--add', '--unset', '--replace-all', '--unset-all', '--rename-section', '--remove-section']);
    const readFlags = new Set(['--get', '--list', '--get-all', '--get-regexp']);
    if (args.some(w => writeFlags.has(w))) return { decision: 'review', reason: 'git config mutation should be reviewed' };
    if (args.some(w => readFlags.has(w))) return { decision: 'safe', reason: 'git config read-only query' };
    return { decision: 'review', reason: 'git config positional operation is ambiguous' };
  }
  if (subcommand === 'worktree') {
    const action = args.find(w => !w.startsWith('-'));
    return (!action || action === 'list') ? { decision: 'safe', reason: 'git worktree list is read-only' } : { decision: 'review', reason: 'git worktree mutation should be reviewed' };
  }
  if (subcommand === 'reflog') {
    const action = args.find(w => !w.startsWith('-'));
    return (!action || action === 'show') ? { decision: 'safe', reason: 'git reflog show is read-only' } : { decision: 'review', reason: 'git reflog mutation should be reviewed' };
  }
  return { decision: 'review', reason: `git ${subcommand} is not in the deterministic allowlist` };
}

function classifyGitCommand(command, cwd) {
  if (!GIT_FAST_PATH) return { decision: 'review', reason: 'git fast path disabled' };
  const segments = splitCompound(command);
  if (segments.length === 0) return { decision: 'safe', reason: 'empty command' };
  let sawGit = false;
  for (const segment of segments) {
    const words = stripWrappers(shellWords(segment));
    if (words.length === 0) continue;
    if (words[0] !== 'git') return { decision: 'review', reason: 'compound command includes non-git segment' };
    sawGit = true;
    const verdict = classifyGitSegment(words, cwd);
    if (verdict.decision !== 'safe') return verdict;
  }
  return sawGit ? { decision: 'safe', reason: 'all git segments are deterministic low-risk operations' } : { decision: 'review', reason: 'no git segment found' };
}

function isReadOnlyBash(command) {
  if (!command || typeof command !== 'string') return true;
  const segments = String(command).split(/(?:&&|\|\||[|;])/).map(s => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const words = stripWrappers(shellWords(segment));
    if (words.length === 0) continue;
    const cmd = words[0];
    if (cmd === 'git') {
      const { subcommand, args } = gitSubcommand(words);
      if (READ_ONLY_GIT_SUB.has(subcommand)) continue;
      if (subcommand === 'branch' && args.every(w => !/^-[dDmM]/.test(w) && w !== '--delete')) continue;
      if (subcommand === 'remote' && !args.some(w => ['add', 'remove', 'rename', 'set-url', 'set-head', 'delete', 'prune', 'update', 'set-branches', 'rm'].includes(w))) continue;
      if (subcommand === 'config' && args.some(w => ['--get', '--list', '--get-all', '--get-regexp'].includes(w))) continue;
      if (subcommand === 'worktree' && args.find(w => !w.startsWith('-')) === 'list') continue;
      if (subcommand === 'reflog' && args.find(w => !w.startsWith('-')) === 'show') continue;
      return false;
    }
    if (cmd === 'gh') {
      const resource = words[1];
      const action = words[2];
      if ((resource === 'pr' || resource === 'issue') && action && READ_ONLY_GH_ACTION.has(action)) continue;
      if (resource === 'api' && !words.some(w => ['-X', '--method', '-f', '--field', '-F', '--raw-field'].includes(w))) continue;
      return false;
    }
    if (READ_ONLY_CMDS.has(cmd)) continue;
    if (CODE_WRITE_CMDS.has(cmd)) return false;
    return false;
  }
  return true;
}

function isWorkflowCodexCall(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const cmd = String(toolInput?.command || '').trim();
  if (/[;&|]/.test(cmd.replace(/<[^>]*>/g, '')) || /\n/.test(cmd)) return false;
  if (!/^(?:rtk\s+)?codex\s+exec\b/.test(cmd)) return false;
  if (!/--skip-git-repo-check/.test(cmd) || !/--sandbox\s+read-only/.test(cmd) || !/--ephemeral\b/.test(cmd)) return false;
  if ([/--sandbox\s+workspace-write/, /--full-auto\b/, /--dangerously-bypass-approvals-and-sandbox/, /--approval-mode\s+full-auto/, /-o\s+sandbox_workspace_write/].some(f => f.test(cmd))) return false;
  return WORKFLOW_CODEX_PATTERNS.some(p => p.test(cmd));
}

function summarizeInput(toolName, toolInput) {
  if (toolName === 'Bash') return `Command: ${String(toolInput.command || '').substring(0, 500)}`;
  if (toolName === 'Write') return `File: ${String(toolInput.file_path || '')}\nContent preview: ${String(toolInput.content || '').substring(0, 300)}`;
  if (toolName === 'Edit') return `File: ${String(toolInput.file_path || '')}\nOld: ${String(toolInput.old_string || '').substring(0, 200)}\nNew: ${String(toolInput.new_string || '').substring(0, 200)}`;
  if (toolName === 'MultiEdit') return `Files: ${[...new Set((toolInput.edits || []).map(e => e.file_path))].join(', ')}\nEdit count: ${(toolInput.edits || []).length}`;
  if (toolName === 'Agent') return `Agent: ${String(toolInput.description || '')}\nPrompt preview: ${String(toolInput.prompt || '').substring(0, 300)}`;
  if (toolName === 'TaskCreate' || toolName === 'TaskUpdate') return `${toolName}: ${String(toolInput.subject || '')}`;
  if (toolName === 'NotebookEdit') return `Notebook: ${String(toolInput.notebook_path || '')}`;
  if (toolName === 'CronCreate' || toolName === 'CronDelete') return `${toolName}: ${String(toolInput.prompt || '').substring(0, 300)}`;
  if (toolName === 'EnterWorktree' || toolName === 'ExitWorktree') return `${toolName}`;
  if (toolName === 'Workflow') return `Workflow: ${String(toolInput.description || '').substring(0, 300)}`;
  return JSON.stringify(toolInput).substring(0, 500);
}

function callJudgeAPI(apiKey, model, prompt, timeout) {
  const payload = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 10, temperature: 0 });
  const result = spawnSync('curl', ['-s', '-m', String(Math.ceil(timeout / 1000)), 'https://api.deepseek.com/v1/chat/completions', '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${apiKey}`, '-d', payload], { timeout, maxBuffer: 65536, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const content = JSON.parse(result.stdout || '{}').choices?.[0]?.message?.content?.trim().toUpperCase() || '';
    if (content === 'SAFE' || content === 'HUMAN') return content;
  } catch {}
  return null;
}

function askCodex(toolName, toolInput, cwd) {
  const prompt = [
    'Safety gate: judge this tool call. Reply ONLY "SAFE" or "HUMAN".',
    `Tool: ${toolName}`,
    `Directory: ${cwd || 'unknown'}`,
    summarizeInput(toolName, toolInput),
    '',
    'SAFE = ordinary development work, including normal Git operations on non-protected branches, tests, dependency installs, source edits, and project file moves/deletions.',
    'HUMAN = force push or deletion targeting main/master/production/release, protected history rewrites, secrets or credential changes, production database/infrastructure mutations, dangerous recursive deletes, semantic CI/test-oracle changes, or genuinely unclear risk.',
    'Reply with exactly one word: SAFE or HUMAN.',
  ].join('\n');

  try {
    const result = spawnSync('codex', ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', prompt], { timeout: CODEX_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8', cwd: cwd || process.cwd(), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (combined) {
      const tail = combined.split('\n').slice(-20).join('\n').toUpperCase();
      const match = tail.match(/(?:^|\n)\s*(SAFE|HUMAN)\s*(?:\n|$)/);
      if (match) return match[1];
    }
    process.stderr.write(`[codex-full-access] Codex returned no verdict within ${CODEX_TIMEOUT_MS}ms, falling back to DeepSeek\n`);
  } catch (err) {
    process.stderr.write(`[codex-full-access] Codex unavailable: ${err.message}, falling back to DeepSeek\n`);
  }

  try {
    const dsKey = process.env.DEEPSEEK_API_KEY;
    if (dsKey) {
      const verdict = callJudgeAPI(dsKey, 'deepseek-chat', prompt, DEEPSEEK_TIMEOUT_MS);
      if (verdict === 'SAFE' || verdict === 'HUMAN') return verdict;
    }
    process.stderr.write('[codex-full-access] DeepSeek API also returned no verdict, asking human\n');
  } catch (err) {
    process.stderr.write(`[codex-full-access] DeepSeek API also unavailable: ${err.message}, asking human\n`);
  }
  return 'HUMAN';
}

function sensitivePathFromTool(toolName, toolInput) {
  if (toolName === 'MultiEdit') {
    const edits = toolInput.edits || [];
    const paths = edits.map(e => e.file_path).filter(Boolean);
    if (toolInput.file_path) paths.push(toolInput.file_path);
    return paths.find(p => SENSITIVE_PATH_RE.test(String(p || '')));
  }
  return SENSITIVE_PATH_RE.test(String(toolInput.file_path || '')) ? toolInput.file_path : null;
}

function main() {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName;
    if (!toolName) return respond('ask', '[cc-airlock] 缺少工具名稱，無法判斷安全等級。請手動確認。');
    if (READ_ONLY_TOOLS.has(toolName)) process.exit(0);

    const toolInput = data.tool_input || data.toolInput || {};
    const cwd = data.cwd || process.cwd();

    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
      const sensitive = sensitivePathFromTool(toolName, toolInput);
      if (sensitive) return respond('ask', `[cc-airlock] 目標檔案 "${sensitive}" 符合敏感檔案模式（.env / credentials / secrets / key）。請手動確認是否允許此操作。`);
      process.exit(0);
    }

    if (MCP_READ_ONLY_RE.test(toolName)) process.exit(0);
    if (isWorkflowCodexCall(toolName, toolInput)) process.exit(0);

    if (toolName === 'Bash') {
      const command = String(toolInput.command || '');
      if (isReadOnlyBash(command)) process.exit(0);
      const gitVerdict = classifyGitCommand(command, cwd);
      if (gitVerdict.decision === 'safe') process.exit(0);
      if (gitVerdict.decision === 'human') return respond('ask', `[cc-airlock] ${gitVerdict.reason}。請手動確認是否允許。`);
    }

    const verdict = askCodex(toolName, toolInput, cwd);
    if (verdict === 'SAFE') process.exit(0);
    respond('ask', `[Codex Full Access] Codex 認為此操作需要人類判斷才能執行。\nTool: ${toolName}\n請確認是否允許此操作。`);
  } catch (err) {
    respond('ask', `[cc-airlock] 守衛發生未預期錯誤（${err?.message || 'unknown'}），為安全起見請手動確認。`);
  }
}
