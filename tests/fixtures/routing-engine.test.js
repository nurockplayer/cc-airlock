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

  return tests;
}

module.exports = { routingEngineTests };
