// Test fixtures for codex-full-access-guard.js
const { runHook, assertDecision } = require('../run-hook');

const HOOK = '../hooks/codex-full-access-guard.js';

function input(toolName, fields = {}, cwd = '/tmp') {
  return { tool_name: toolName, tool_input: { ...fields }, cwd };
}

// ── Sensitive file guard ─────────────────────────────────────────
function sensitiveFileTests() {
  const cases = [
    ['Write .env => ask', input('Write', { file_path: '.env', content: 'x' })],
    ['Write .env.local => ask', input('Write', { file_path: '.env.local', content: 'x' })],
    ['Write credentials.json => ask', input('Write', { file_path: 'credentials.json', content: '{}' })],
    ['Write secrets.yml => ask', input('Write', { file_path: 'secrets.yml' })],
    ['Write id_rsa => ask', input('Write', { file_path: 'id_rsa' })],
    ['Write id_ed25519 => ask', input('Write', { file_path: 'id_ed25519' })],
    ['Edit .env => ask', input('Edit', { file_path: '.env', old_string: 'x', new_string: 'y' })],
    ['MultiEdit with .env => ask', input('MultiEdit', { edits: [{ file_path: '.env' }, { file_path: 'src/index.js' }] })],
    ['MultiEdit with .env via top-level file_path => ask', input('MultiEdit', { file_path: '.env', edits: [{ file_path: 'src/foo.js' }] })],
    ['Write service-account-prod.json => ask', input('Write', { file_path: 'service-account-prod.json' })],
    ['Write *.pem => ask', input('Write', { file_path: 'cert.pem' })],
    ['Write *.key => ask', input('Write', { file_path: 'server.key' })],
    ['Write src/index.js => pass', input('Write', { file_path: 'src/index.js', content: '// code' })],
    ['Edit src/app.ts => pass', input('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })],
    ['Write README.md => pass', input('Write', { file_path: 'README.md', content: '# hi' })],
  ];

  const tests = {};
  for (const [label, inp] of cases) {
    tests[label] = () => {
      const result = runHook(HOOK, inp, { env: { MOCK_CODEX_RESPONSE: 'SAFE' } });
      const expected = label.endsWith('=> ask') ? 'ask' : 'pass';
      assertDecision(result, expected);
    };
  }
  return tests;
}

// ── Git read-only classification ─────────────────────────────────
function gitReadOnlyTests() {
  const passCases = [
    ['git status => pass', input('Bash', { command: 'git status' })],
    ['git log --oneline => pass', input('Bash', { command: 'git log --oneline' })],
    ['git diff --stat => pass', input('Bash', { command: 'git diff --stat' })],
    ['git show HEAD => pass', input('Bash', { command: 'git show HEAD' })],
    ['git blame main..HEAD => pass', input('Bash', { command: 'git blame main..HEAD' })],
    ['git shortlog => pass', input('Bash', { command: 'git shortlog' })],
    ['git describe --tags => pass', input('Bash', { command: 'git describe --tags' })],
    ['git rev-parse HEAD => pass', input('Bash', { command: 'git rev-parse HEAD' })],
    ['git rev-list --count HEAD => pass', input('Bash', { command: 'git rev-list --count HEAD' })],
    ['git ls-files => pass', input('Bash', { command: 'git ls-files' })],
    ['git ls-tree HEAD => pass', input('Bash', { command: 'git ls-tree HEAD' })],
    ['git remote -v => pass', input('Bash', { command: 'git remote -v' })],
    ['git remote show origin => pass', input('Bash', { command: 'git remote show origin' })],
    ['git remote get-url origin => pass', input('Bash', { command: 'git remote get-url origin' })],
    ['git config --get user.email => pass', input('Bash', { command: 'git config --get user.email' })],
    ['git config --list => pass', input('Bash', { command: 'git config --list' })],
    ['git reflog show --oneline => pass', input('Bash', { command: 'git reflog show --oneline' })],
    ['git worktree list => pass', input('Bash', { command: 'git worktree list' })],
    ['ls => pass', input('Bash', { command: 'ls -la' })],
    ['cat file => pass', input('Bash', { command: 'cat README.md' })],
    ['grep pattern => pass', input('Bash', { command: 'grep -r "todo" src/' })],
    ['pwd => pass', input('Bash', { command: 'pwd' })],
  ];

  // For guard cases: MOCK_CODEX_RESPONSE=HUMAN so we see 'ask' when Codex is called.
  // Current (buggy) code auto-passes these as read-only → 'pass'. After fix → 'ask'.
  const guardCases = [
    ['git remote add origin url => guard (must NOT auto-pass)', input('Bash', { command: 'git remote add origin https://github.com/user/repo.git' })],
    ['git remote remove origin => guard', input('Bash', { command: 'git remote remove origin' })],
    ['git remote set-url origin url => guard', input('Bash', { command: 'git remote set-url origin https://newurl.git' })],
    ['git remote set-branches --add origin main => guard', input('Bash', { command: 'git remote set-branches --add origin main' })],
    ['git remote rm origin => guard (rm alias)', input('Bash', { command: 'git remote rm origin' })],
    ['git config user.email foo@example.com => guard', input('Bash', { command: 'git config user.email foo@example.com' })],
    ['git config --global credential.helper store => guard', input('Bash', { command: 'git config --global credential.helper store' })],
    ['git worktree add ../tmp => guard', input('Bash', { command: 'git worktree add ../tmp' })],
    ['git worktree remove ../tmp => guard', input('Bash', { command: 'git worktree remove ../tmp' })],
    ['git worktree prune => guard', input('Bash', { command: 'git worktree prune' })],
    ['git reflog expire --expire=now --all => guard', input('Bash', { command: 'git reflog expire --expire=now --all' })],
    ['git reflog delete HEAD@{0} => guard', input('Bash', { command: 'git reflog delete HEAD@{0}' })],
  ];

  // Guard cases with mixed read/write tokens — must NOT auto-pass
  const mixedGuardCases = [
    ['git worktree add list => guard (mixed)', input('Bash', { command: 'git worktree add list' })],
    ['git reflog delete show => guard (mixed)', input('Bash', { command: 'git reflog delete show' })],
    ['git config --add foo.bar --list => guard (mixed)', input('Bash', { command: 'git config --add foo.bar --list' })],
  ];

  const tests = {};
  for (const [label, inp] of passCases) {
    tests[label] = () => { assertDecision(runHook(HOOK, inp, { env: { MOCK_CODEX_RESPONSE: 'SAFE' } }), 'pass'); };
  }
  for (const [label, inp] of guardCases) {
    // Use MOCK_CODEX_RESPONSE=HUMAN: if it goes through Codex → 'ask'.
    // If auto-passed as read-only → 'pass'.
    tests[label] = () => {
      const result = runHook(HOOK, inp, { env: { MOCK_CODEX_RESPONSE: 'HUMAN' } });
      // Passing via Codex (HUMAN → ask) is correct. Silent pass is not.
      assertDecision(result, 'ask');
    };
  }
  for (const [label, inp] of mixedGuardCases) {
    tests[label] = () => {
      const result = runHook(HOOK, inp, { env: { MOCK_CODEX_RESPONSE: 'HUMAN' } });
      assertDecision(result, 'ask');
    };
  }
  return tests;
}

// ── Workflow Codex bypass ─────────────────────────────────────────
function workflowCodexBypassTests() {
  const base = 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check';

  // Safe bypass cases — must pass silently regardless of MOCK_CODEX_RESPONSE
  const passCases = [
    ['Safe spec call => pass', input('Bash', { command: `${base} "Implementation Spec for auth"` })],
    ['Safe compliance => pass', input('Bash', { command: `${base} "Spec Compliance report"` })],
    ['Safe adequacy => pass', input('Bash', { command: `${base} "Spec Adequacy verification"` })],
    ['Safe Analysis Packet => pass', input('Bash', { command: `${base} "Analysis Packet for phase2"` })],
    ['Safe Decision boundaries => pass', input('Bash', { command: `${base} "Decision boundaries for hooks"` })],
    ['Safe ASK CODEX => pass', input('Bash', { command: `${base} "[ASK CODEX] about error model"` })],
    ['Safe Executors may decide => pass', input('Bash', { command: `${base} "[Executors may decide] private helper"` })],
    ['Safe DO NOT CHANGE => pass', input('Bash', { command: `${base} "[DO NOT CHANGE] API semantics"` })],
  ];

  // No-bypass cases: MOCK_CODEX_RESPONSE=HUMAN → should see 'ask', not silent pass.
  // Current (buggy) code: isWorkflowCodexCall may return true → silent pass. After fix → 'ask'.
  const noBypassCases = [
    ['No --sandbox readonly => ask (not bypass)', input('Bash', { command: `codex exec --ephemeral --skip-git-repo-check "Implementation Spec"` })],
    ['No --ephemeral => ask', input('Bash', { command: `codex exec --sandbox read-only --skip-git-repo-check "Implementation Spec"` })],
    ['No --skip-git-repo-check => ask', input('Bash', { command: `codex exec --sandbox read-only --ephemeral "Implementation Spec"` })],
    ['Workspace-write sandbox => ask', input('Bash', { command: `codex exec --sandbox workspace-write --ephemeral --skip-git-repo-check "Implementation Spec"` })],
    ['--full-auto flag => ask', input('Bash', { command: `codex exec --full-auto --skip-git-repo-check "Implementation Spec"` })],
    ['--dangerously-bypass-approvals => ask', input('Bash', { command: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "Spec Compliance"` })],
    ['evilcodex exec => guard (faux prefix)', input('Bash', { command: `evilcodex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec"` })],
    ['badcodex exec => guard', input('Bash', { command: `abc-codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec"` })],
    ['With && chain => ask', input('Bash', { command: `rm -rf /tmp && codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec"` })],
    ['With ; chain => ask', input('Bash', { command: `echo hi; codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Analysis Packet"` })],
    ['With pipe => ask', input('Bash', { command: `codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Spec" | grep foo` })],
    ['Non-codex exec => ask', input('Bash', { command: `npm test` })],
  ];

  const tests = {};
  for (const [label, inp] of passCases) {
    tests[label] = () => { assertDecision(runHook(HOOK, inp), 'pass'); };
  }
  for (const [label, inp] of noBypassCases) {
    tests[label] = () => {
      const result = runHook(HOOK, inp, { env: { MOCK_CODEX_RESPONSE: 'HUMAN' } });
      // Should reach Codex → HUMAN → ask. If bypassed → 'pass'.
      assertDecision(result, 'ask');
    };
  }
  return tests;
}

// ── Fail-closed tests ─────────────────────────────────────────────
function failClosedTests() {
  const tests = {};

  // Current code exits 0 on malformed JSON — test expects 'ask' (RED until #6).
  tests['malformed JSON => ask'] = () => {
    const result = runHook(HOOK, 'not-json{{{', { env: { MOCK_CODEX_RESPONSE: 'SAFE' }, raw: true });
    assertDecision(result, 'ask');
  };

  // Current code exits 0 on missing tool name — test expects 'ask' (RED until #6).
  tests['missing tool name => ask'] = () => {
    const result = runHook(HOOK, input('', {}), { env: { MOCK_CODEX_RESPONSE: 'SAFE' } });
    assertDecision(result, 'ask');
  };

  return tests;
}

// ── Read-only tools pass ──────────────────────────────────────────
function readOnlyToolTests() {
  const tools = ['Read', 'Grep', 'Glob', 'TaskList', 'TaskGet',
    'WebFetch', 'WebSearch', 'AskUserQuestion', 'EnterPlanMode'];

  const tests = {};
  for (const tool of tools) {
    tests[`${tool} => pass`] = () => {
      assertDecision(runHook(HOOK, input(tool, {})), 'pass');
    };
  }
  return tests;
}

// ── MCP read-only pass ────────────────────────────────────────────
function mcpReadOnlyTests() {
  const tools = ['mcp__filesystem__read_file', 'mcp__github__search_code',
    'mcp__database__list_tables', 'mcp__api__get_endpoints'];

  const tests = {};
  for (const tool of tools) {
    tests[`${tool} => pass`] = () => {
      assertDecision(runHook(HOOK, input(tool, {})), 'pass');
    };
  }
  return tests;
}

module.exports = { sensitiveFileTests, gitReadOnlyTests, workflowCodexBypassTests, failClosedTests, readOnlyToolTests, mcpReadOnlyTests };
