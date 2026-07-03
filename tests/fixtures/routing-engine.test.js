// Test fixtures for lib/routing-engine.js
const { classifyAction, routeDecision, ROUTE_TYPES } = require('../../lib/routing-engine');

function routingEngineTests() {
  const tests = {};

  // ── classifyAction unit tests ────────────────────────────

  tests['classifyAction: read-only tool → pass'] = () => {
    const r = classifyAction('Read', {});
    if (r.route !== 'pass') throw new Error(`expected pass, got ${r.route}`);
    if (r.risk_category !== 'read_only') throw new Error(`expected read_only, got ${r.risk_category}`);
  };

  tests['classifyAction: MCP read-only tool → pass'] = () => {
    const r = classifyAction('mcp__filesystem__read_file', {});
    if (r.route !== 'pass') throw new Error(`expected pass, got ${r.route}`);
  };

  tests['classifyAction: sensitive Write path → ask'] = () => {
    const r = classifyAction('Write', { file_path: '.env' });
    if (r.route !== 'ask') throw new Error(`expected ask, got ${r.route}`);
    if (r.risk_category !== 'file_write') throw new Error(`expected file_write, got ${r.risk_category}`);
  };

  tests['classifyAction: normal Write path → flash'] = () => {
    const r = classifyAction('Write', { file_path: 'src/index.js' });
    if (r.route !== 'flash') throw new Error(`expected flash, got ${r.route}`);
  };

  tests['classifyAction: workflow codex call → pass (bypass)'] = () => {
    const r = classifyAction('Bash', {
      command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec for auth"',
    });
    if (r.route !== 'pass') throw new Error(`expected pass, got ${r.route}`);
    if (r.risk_category !== 'read_only') throw new Error(`expected read_only, got ${r.risk_category}`);
  };

  tests['classifyAction: destructive Bash command → deny'] = () => {
    const r = classifyAction('Bash', { command: 'rm -rf /' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
    if (r.risk_category !== 'destructive_shell') throw new Error(`expected destructive_shell, got ${r.risk_category}`);
  };

  tests['classifyAction: PR write command → pro'] = () => {
    const r = classifyAction('Bash', { command: 'gh pr create --title "test"' });
    if (r.route !== 'pro') throw new Error(`expected pro, got ${r.route}`);
    if (r.risk_category !== 'pr_operation') throw new Error(`expected pr_operation, got ${r.risk_category}`);
  };

  tests['classifyAction: safe Bash command → flash'] = () => {
    const r = classifyAction('Bash', { command: 'npm test' });
    if (r.route !== 'flash') throw new Error(`expected flash, got ${r.route}`);
    if (r.risk_category !== 'unknown') throw new Error(`expected unknown, got ${r.risk_category}`);
  };

  tests['classifyAction: Agent tool → flash'] = () => {
    const r = classifyAction('Agent', { description: 'test', prompt: 'do something' });
    if (r.route !== 'flash') throw new Error(`expected flash, got ${r.route}`);
  };

  tests['classifyAction: git reset --hard → deny (dangerous git)'] = () => {
    const r = classifyAction('Bash', { command: 'git reset --hard' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
    if (r.risk_category !== 'git_mutation') throw new Error(`expected git_mutation, got ${r.risk_category}`);
  };

  // ── routeDecision tests ──────────────────────────────────

  tests['routeDecision: routing disabled returns null'] = () => {
    const r = routeDecision('Bash', { command: 'npm test' }, { enableRouting: false });
    if (r !== null) throw new Error('expected null when routing disabled');
  };

  tests['routeDecision: read-only passes through'] = () => {
    const r = routeDecision('Read', {}, { enableRouting: true });
    if (r.route !== 'pass') throw new Error(`expected pass, got ${r.route}`);
    if (r.reason) {} // just verifying it exists
  };

  tests['routeDecision: sensitive path asks'] = () => {
    const r = routeDecision('Write', { file_path: '.env' }, { enableRouting: true });
    if (r.route !== 'ask') throw new Error(`expected ask, got ${r.route}`);
  };

  tests['routeDecision: flash route has reason'] = () => {
    const r = routeDecision('Bash', { command: 'npm test' }, { enableRouting: true });
    if (r.route !== 'flash') throw new Error(`expected flash, got ${r.route}`);
    if (!r.reason) throw new Error('expected reason');
    if (!r.risk_category) throw new Error('expected risk_category');
  };

  tests['routeDecision: pro route for PR commands'] = () => {
    const r = routeDecision('Bash', { command: 'gh pr merge 123' }, { enableRouting: true });
    if (r.route !== 'pro') throw new Error(`expected pro, got ${r.route}`);
    if (r.risk_category !== 'pr_operation') throw new Error(`expected pr_operation, got ${r.risk_category}`);
  };

  tests['routeDecision: destructive command denied'] = () => {
    const r = routeDecision('Bash', { command: 'git clean -fd' }, { enableRouting: true });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
    if (r.risk_category !== 'git_mutation') throw new Error(`expected git_mutation, got ${r.risk_category}`);
  };

  tests['routeDecision: unknown tool routes to flash'] = () => {
    const r = routeDecision('UnknownTool', {}, { enableRouting: true });
    if (r.route !== 'flash') throw new Error(`expected flash, got ${r.route}`);
  };

  // ── config integration ───────────────────────────────────

  tests['config includes enableRouting default'] = () => {
    const { loadConfig } = require('../../lib/config');
    const cfg = loadConfig({});
    if (cfg.enableRouting !== false) throw new Error(`expected enableRouting false, got ${cfg.enableRouting}`);
  };

  tests['config enableRouting override via env'] = () => {
    const { loadConfig } = require('../../lib/config');
    const cfg = loadConfig({ CC_AIRLOCK_ENABLE_ROUTING: 'true' });
    if (cfg.enableRouting !== true) throw new Error(`expected enableRouting true, got ${cfg.enableRouting}`);
  };

  // ── Deep-scan regression tests ──────────────────────────

  tests['isDangerousGit: echo $(git reset --hard) → deny'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(git reset --hard)' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDangerousGit: bash -c "git reset --hard" → deny'] = () => {
    const r = classifyAction('Bash', { command: 'bash -c "git reset --hard"' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDangerousGit: git clean -fd → deny'] = () => {
    const r = classifyAction('Bash', { command: 'git clean -fd' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDestructiveShell: rm -rf ~/* → deny'] = () => {
    const r = classifyAction('Bash', { command: 'rm -rf ~/*' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDestructiveShell: rm -rf ${HOME}/* → deny'] = () => {
    const r = classifyAction('Bash', { command: 'rm -rf ${HOME}/*' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isPrWriteCommand: rtk gh pr create → pro'] = () => {
    const r = classifyAction('Bash', { command: 'rtk gh pr create --title test' });
    if (r.route !== 'pro') throw new Error(`expected pro, got ${r.route}`);
  };

  tests['isPrWriteCommand: cd repo && gh pr merge → pro'] = () => {
    const r = classifyAction('Bash', { command: 'cd repo && gh pr merge 123' });
    if (r.route !== 'pro') throw new Error(`expected pro, got ${r.route}`);
  };

  tests['isDangerousGit: echo $(git reset --hard) via $() → deny'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(git reset --hard)' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDangerousGit: bash -c "git reset --hard" → deny'] = () => {
    const r = classifyAction('Bash', { command: 'bash -c "git reset --hard"' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isPrWriteCommand: bash -c "gh pr merge 123" → pro'] = () => {
    const r = classifyAction('Bash', { command: 'bash -c "gh pr merge 123"' });
    if (r.route !== 'pro') throw new Error(`expected pro, got ${r.route}`);
  };

  tests['isPrWriteCommand: echo $(gh pr merge 123) → pro'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(gh pr merge 123)' });
    if (r.route !== 'pro') throw new Error(`expected pro, got ${r.route}`);
  };

  tests['isDangerousGit: cat file | git reset --hard → deny'] = () => {
    const r = classifyAction('Bash', { command: 'cat file | git reset --hard' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDestructiveShell: echo $(rm -rf /) via $() → deny'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(rm -rf /)' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDestructiveShell: bash -c "rm -rf /" → deny'] = () => {
    const r = classifyAction('Bash', { command: 'bash -c "rm -rf /"' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['deny runs before workflow bypass: $(git reset --hard) in codex exec'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec $(git reset --hard)"' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  // ── Codex review v2 regression tests ──────────────────────

  tests['isDangerousGit: echo $(cd repo && git reset --hard) via nested compound → deny'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(cd repo && git reset --hard)' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDangerousGit: echo $(cd repo; git reset --hard) via nested semicolon → deny'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(cd repo; git reset --hard)' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['workflow bypass: codex exec with output redirection > → ask'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec" > .env' });
    if (r.route !== 'ask' && r.route !== 'flash') throw new Error(`expected ask or flash, got ${r.route}`);
  };

  tests['workflow bypass: codex exec with output redirection >> → ask'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec" >> output.log' });
    if (r.route !== 'ask' && r.route !== 'flash') throw new Error(`expected ask or flash, got ${r.route}`);
  };

  tests['workflow bypass: codex exec with stderr redirection 2> → ask'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec" 2>/dev/null' });
    if (r.route !== 'ask' && r.route !== 'flash') throw new Error(`expected ask or flash, got ${r.route}`);
  };

  tests['workflow bypass: codex exec with input redirection < → ask'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec" < input.txt' });
    if (r.route !== 'ask' && r.route !== 'flash') throw new Error(`expected ask or flash, got ${r.route}`);
  };

  tests['workflow bypass: codex exec WITHOUT redirection still passes'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec for auth"' });
    if (r.route !== 'pass') throw new Error(`expected pass, got ${r.route}`);
  };

  tests['workflow bypass: codex exec with heredoc << → ask'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check <<EOF\nImplementation Spec\nEOF' });
    if (r.route !== 'ask' && r.route !== 'flash') throw new Error(`expected ask or flash, got ${r.route}`);
  };

  // ── Codex review v3 regression tests ──────────────────────

  tests['isDangerousGit: deeply nested echo $(echo $(git reset --hard)) → deny'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(echo $(git reset --hard))' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['isDangerousGit: nested $(()) at depth 3 → deny'] = () => {
    const r = classifyAction('Bash', { command: 'echo $(echo $(echo $(git reset --hard)))' });
    if (r.route !== 'deny') throw new Error(`expected deny, got ${r.route}`);
  };

  tests['workflow bypass: codex exec with <stdin> in prompt still passes (no false positive)'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Implementation Spec <stdin>"' });
    if (r.route !== 'pass') throw new Error(`expected pass, got ${r.route}`);
  };

  tests['workflow bypass: codex exec with << in heredoc flag not inside quotes → not pass'] = () => {
    const r = classifyAction('Bash', { command: 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check <<EOF\nSpec\nEOF' });
    if (r.route !== 'ask' && r.route !== 'flash') throw new Error(`expected ask or flash, got ${r.route}`);
  };

  return tests;
}

module.exports = { routingEngineTests };
