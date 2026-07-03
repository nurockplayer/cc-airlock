// Test fixtures for dangerous-git-guard.js
const { runHook, assertDecision } = require('../run-hook');

const HOOK = '../hooks/dangerous-git-guard.js';

function input(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

// ── git reset --hard (deny) ───────────────────────────────────────
function gitResetHardTests() {
  const denyCases = [
    ['git reset --hard => deny', 'git reset --hard'],
    ['git reset --hard HEAD => deny', 'git reset --hard HEAD'],
    ['git reset --hard HEAD~1 => deny', 'git reset --hard HEAD~1'],
    ['git -C /repo reset --hard => deny', 'git -C /repo reset --hard'],
    ['git --git-dir=/repo/.git reset --hard => deny', 'git --git-dir=/repo/.git reset --hard'],
  ];

  const tests = {};
  for (const [label, cmd] of denyCases) {
    tests[label] = () => { assertDecision(runHook(HOOK, input(cmd)), 'deny'); };
  }
  return tests;
}

// ── git clean (deny) ──────────────────────────────────────────────
function gitCleanTests() {
  const denyCases = [
    ['git clean -fd => deny', 'git clean -fd'],
    ['git clean -n => deny', 'git clean -n'],
    ['git clean -xdf => deny', 'git clean -xdf'],
  ];

  const tests = {};
  for (const [label, cmd] of denyCases) {
    tests[label] = () => { assertDecision(runHook(HOOK, input(cmd)), 'deny'); };
  }
  return tests;
}

// ── Safe git commands (no decision — pass through) ────────────────
function safeGitTests() {
  const safeCases = [
    ['git status => no decision', 'git status'],
    ['git diff => no decision', 'git diff'],
    ['git commit => no decision', 'git commit -m "msg"'],
    ['git push => no decision', 'git push origin main'],
    ['git pull => no decision', 'git pull origin main'],
    ['git checkout -b feature => no decision', 'git checkout -b feature'],
    ['git merge feature => no decision', 'git merge feature'],
    ['git rebase main => no decision', 'git rebase main'],
  ];

  const tests = {};
  for (const [label, cmd] of safeCases) {
    tests[label] = () => {
      const result = runHook(HOOK, input(cmd));
      // No decision = pass (exit 0, no JSON output)
      if (result.decision !== null && result.decision !== 'pass') {
        throw new Error(`expected no decision, got "${result.decision}"`);
      }
    };
  }
  return tests;
}

// ── Wrapper stripping ─────────────────────────────────────────────
function wrapperStrippingTests() {
  const cases = [
    ['env FOO=1 git reset --hard => deny', 'env FOO=1 git reset --hard'],
    ['env FOO=1 BAR=2 git reset --hard => deny', 'env FOO=1 BAR=2 git reset --hard'],
    ['command git reset --hard => deny', 'command git reset --hard'],
    ['env command git reset --hard => deny', 'env command git reset --hard'],
    ['rtk proxy git reset --hard => deny', 'rtk proxy git reset --hard'],
    ['rtk git reset --hard => deny', 'rtk git reset --hard'],
    ['FOO=1 git reset --hard => deny', 'FOO=1 git reset --hard'],
    ['command git clean -fd => deny', 'command git clean -fd'],
    ['rtk proxy git clean -fd => deny', 'rtk proxy git clean -fd'],
    ['env rtk proxy FOO=1 git reset --hard => deny', 'env rtk proxy FOO=1 git reset --hard'],
    ['FOO=1 rtk proxy command git reset --hard => deny', 'FOO=1 rtk proxy command git reset --hard'],
  ];

  const safeWrapped = [
    ['env FOO=1 git status => no decision', 'env FOO=1 git status'],
    ['rtk git diff => no decision', 'rtk git diff'],
    ['command git log => no decision', 'command git log'],
  ];

  const tests = {};
  for (const [label, cmd] of cases) {
    tests[label] = () => { assertDecision(runHook(HOOK, input(cmd)), 'deny'); };
  }
  for (const [label, cmd] of safeWrapped) {
    tests[label] = () => {
      const result = runHook(HOOK, input(cmd));
      if (result.decision === 'deny') throw new Error('unexpected deny for safe command');
    };
  }
  return tests;
}

// ── Deep extraction: $(), backticks, compound ─────────────────────
function deepExtractionTests() {
  const cases = [
    ['git reset --hard in $() => deny', 'echo $(git reset --hard)'],
    ['git clean in backticks => deny', 'echo `git clean -fd`'],
    ['git reset --hard in compound => deny', 'echo hi && git reset --hard'],
    ['git reset --hard after pipe => deny', 'echo hi | git reset --hard'],
    ['bash -c "git reset --hard" => deny', 'bash -c "git reset --hard"'],
    ['multiple wrappers + $() => deny', 'echo $(env FOO=1 git reset --hard)'],
  ];

  const tests = {};
  for (const [label, cmd] of cases) {
    tests[label] = () => { assertDecision(runHook(HOOK, input(cmd)), 'deny'); };
  }
  return tests;
}

// ── Non-Bash tools: no decision ──────────────────────────────────
function nonBashToolTests() {
  const tests = {};
  tests['Write tool => no decision'] = () => {
    const result = runHook(HOOK, { tool_name: 'Write', tool_input: { file_path: 'test.txt' } });
    if (result.decision !== null && result.decision !== 'pass') {
      throw new Error(`expected no decision, got "${result.decision}"`);
    }
  };
  tests['Read tool => no decision'] = () => {
    const result = runHook(HOOK, { tool_name: 'Read', tool_input: { file_path: 'test.txt' } });
    if (result.decision !== null && result.decision !== 'pass') {
      throw new Error(`expected no decision, got "${result.decision}"`);
    }
  };
  return tests;
}

module.exports = { gitResetHardTests, gitCleanTests, safeGitTests, wrapperStrippingTests, deepExtractionTests, nonBashToolTests, destructiveShellTests };

// ── Destructive shell commands ────────────────────────────────────
function destructiveShellTests() {
  const denyCases = [
    ['rm -rf / => deny', 'rm -rf /'],
    ['rm -rf /* => deny', 'rm -rf /*'],
    ['rm -rf ~ => deny', 'rm -rf ~'],
    ['rm -rf .. => deny', 'rm -rf ..'],
    ['rm -rf ./* => deny', 'rm -rf ./*'],
    // P1 variants: -fr, -R, --recursive --force
    ['rm -fr / => deny', 'rm -fr /'],
    ['rm -R /* => deny', 'rm -R /*'],
    ['rm --recursive --force / => deny', 'rm --recursive --force /'],
    ['rm -Rf / => deny', 'rm -Rf /'],
    // P1 home glob variants: ~/*, ${HOME}/*
    ['rm -rf ~/* => deny', 'rm -rf ~/*'],
    ['rm -rf ${HOME}/* => deny', 'rm -rf ${HOME}/*'],
    ['rm -rf ~/*.tmp => deny', 'rm -rf ~/*.tmp'],
  ];

  const askCases = [
    ['docker system prune -a => ask', 'docker system prune -a'],
    ['docker volume rm myvol => ask', 'docker volume rm myvol'],
    ['terraform destroy => ask', 'terraform destroy'],
    ['kubectl delete namespace test => ask', 'kubectl delete namespace test'],
    ['chmod -R 777 /data => ask', 'chmod -R 777 /data'],
  ];

  const safePass = [
    ['rm file.txt => no decision', 'rm file.txt'],
    ['rm -rf node_modules => no decision', 'rm -rf node_modules'],
    ['rm -rf ./dist => no decision', 'rm -rf ./dist'],
    ['find . -name "*.js" => no decision', 'find . -name "*.js"'],
  ];

  const tests = {};
  for (const [label, cmd] of denyCases) {
    tests[label] = () => { assertDecision(runHook(HOOK, input(cmd)), 'deny'); };
  }
  for (const [label, cmd] of askCases) {
    tests[label] = () => { assertDecision(runHook(HOOK, input(cmd)), 'ask'); };
  }
  for (const [label, cmd] of safePass) {
    tests[label] = () => {
      const result = runHook(HOOK, input(cmd));
      if (result.decision !== null && result.decision !== 'pass') {
        throw new Error(`expected no decision, got "${result.decision}"`);
      }
    };
  }
  // For missing tool name, dangerous-git-guard now responds 'ask' (fail-closed)
  tests['missing tool name => ask (fail-closed)'] = () => {
    const result = runHook(HOOK, { tool_name: '' });
    assertDecision(result, 'ask');
  };
  return tests;
}
