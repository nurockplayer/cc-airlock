const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook, assertDecision } = require('../run-hook');

const HOOK = '../hooks/workflow-enforcer.js';
const BASE = 'codex exec --sandbox read-only --ephemeral --skip-git-repo-check';
let seq = 0;

function setup(mode = 'enforce') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-airlock-workflow-'));
  const session = `session-${++seq}`;
  const env = { CC_AIRLOCK_STATE_DIR: dir, CC_AIRLOCK_WORKFLOW_MODE: mode };
  const call = (event, opts = {}) => runHook(HOOK, { session_id: session, cwd: '/tmp/project', ...event }, { env, ...opts });
  return { dir, session, env, call };
}

function prompt(call) {
  return call({ hook_event_name: 'UserPromptSubmit', prompt: 'implement the issue' });
}

function pre(call, tool_name, tool_input) {
  return call({ hook_event_name: 'PreToolUse', tool_name, tool_input });
}

function post(call, tool_name, tool_input, tool_response = { success: true }) {
  return call({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response });
}

function stop(call, extra = {}) {
  return call({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], ...extra });
}

function spec(call, response) {
  return post(call, 'Bash', { command: `${BASE} "Analysis Packet Implementation Spec"` }, response || '## Implementation Spec\nA detailed structured implementation plan with scope, invariants, tests, decision boundaries, and rollback notes for this change.');
}

function dual(call, response) {
  return post(call, 'Bash', { command: `${BASE} "Spec Compliance Spec Adequacy 雙重驗證"` }, response || '## Spec Compliance\nVerdict: SAFE\nEvery implementation requirement is satisfied with test evidence and no must-fix gaps.\n## Spec Adequacy\nVerdict: SAFE\nThe original specification covered the material risks and acceptance criteria completely.');
}

function tests() {
  return {
    'UserPromptSubmit injects mandatory lifecycle context': () => {
      const { call } = setup();
      const result = prompt(call);
      assertDecision(result, 'pass');
      assert.match(result.stdout, /Analysis Packet/);
      assert.match(result.stdout, /Spec Adequacy/);
    },
    'read-only tools pass before spec': () => {
      const { call } = setup(); prompt(call);
      assertDecision(pre(call, 'Read', { file_path: 'README.md' }), 'pass');
      assertDecision(pre(call, 'Bash', { command: 'git status' }), 'pass');
    },
    'write is denied before spec': () => {
      const { call } = setup(); prompt(call);
      const result = pre(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      assertDecision(result, 'deny');
      assert.match(result.reason, /Implementation Spec/);
    },
    'plain prose claim cannot unlock writes': () => {
      const { call } = setup(); prompt(call);
      post(call, 'Bash', { command: 'echo "Codex reviewed this and said SAFE"' }, 'SAFE');
      assertDecision(pre(call, 'Edit', { file_path: 'src/a.js', old_string: 'a', new_string: 'b' }), 'deny');
    },
    'invalid spec response is rejected and does not unlock writes': () => {
      const { call } = setup(); prompt(call);
      assertDecision(spec(call, 'ok'), 'block');
      assertDecision(pre(call, 'Write', { file_path: 'src/a.js', content: 'x' }), 'deny');
    },
    'valid spec unlocks mutation': () => {
      const { call } = setup(); prompt(call); spec(call);
      assertDecision(pre(call, 'Write', { file_path: 'src/a.js', content: 'x' }), 'pass');
    },
    'stop blocks until both post-mutation verifications exist': () => {
      const { call } = setup(); prompt(call); spec(call);
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      const result = stop(call);
      assertDecision(result, 'block');
      assert.match(result.reason, /Spec Compliance/);
      assert.match(result.reason, /Spec Adequacy/);
    },
    'compliance alone still requires adequacy': () => {
      const { call } = setup(); prompt(call); spec(call);
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      post(call, 'Bash', { command: `${BASE} "Spec Compliance"` }, '## Spec Compliance\nVerdict: SAFE\nThe implementation conforms to all requirements and tests pass with no must-fix findings.');
      const result = stop(call);
      assertDecision(result, 'block');
      assert.doesNotMatch(result.reason, /Required next: Codex Spec Compliance verification;/);
      assert.match(result.reason, /Spec Adequacy/);
    },
    'combined dual verification allows stop and deletes state': () => {
      const { call, dir, session } = setup(); prompt(call); spec(call);
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      dual(call);
      assertDecision(stop(call), 'pass');
      assert.strictEqual(fs.existsSync(path.join(dir, `${session}.json`)), false);
    },
    'a later mutation invalidates earlier dual verification': () => {
      const { call } = setup(); prompt(call); spec(call);
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      dual(call);
      post(call, 'Edit', { file_path: 'src/a.js', old_string: 'x', new_string: 'y' });
      assertDecision(stop(call), 'block');
    },
    'a late spec cannot erase mutation history': () => {
      const { call } = setup(); prompt(call); spec(call);
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      spec(call);
      assertDecision(stop(call), 'block');
    },
    'dual response needs a verdict in each section': () => {
      const { call } = setup(); prompt(call); spec(call);
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      const result = dual(call, '## Spec Compliance\nVerdict: SAFE\nAll requirements pass with sufficient detail.\n## Spec Adequacy\nThis section has no verdict although it contains a long discussion about scope and risks.');
      assertDecision(result, 'block');
      assertDecision(stop(call), 'block');
    },
    'active background tasks do not trigger a premature stop block': () => {
      const { call } = setup(); prompt(call); spec(call);
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      const result = stop(call, { background_tasks: [{ id: '1', status: 'running' }] });
      assertDecision(result, 'pass');
    },
    'SessionEnd removes state': () => {
      const { call, dir, session } = setup(); prompt(call); spec(call);
      assert.strictEqual(fs.existsSync(path.join(dir, `${session}.json`)), true);
      assertDecision(call({ hook_event_name: 'SessionEnd', reason: 'other' }), 'pass');
      assert.strictEqual(fs.existsSync(path.join(dir, `${session}.json`)), false);
    },
    'audit mode permits writes and stop without continuation': () => {
      const { call } = setup('audit'); prompt(call);
      assertDecision(pre(call, 'Write', { file_path: 'src/a.js', content: 'x' }), 'pass');
      post(call, 'Write', { file_path: 'src/a.js', content: 'x' });
      assertDecision(stop(call), 'pass');
    },
    'off mode is inert': () => {
      const { call } = setup('off');
      assertDecision(pre(call, 'Write', { file_path: 'src/a.js', content: 'x' }), 'pass');
      assertDecision(stop(call), 'pass');
    },
    'malformed input fails closed': () => {
      const { env } = setup();
      const result = runHook(HOOK, '{', { env, raw: true });
      assert.strictEqual(result.exitCode, 2);
    },
  };
}

module.exports = { tests };
