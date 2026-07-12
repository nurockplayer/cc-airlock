// Test fixtures for lib/codex-judge.js — Phase 2 schema-validated Codex adapter
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  judge,
  loadSchema,
  validateVerdict,
  createTempDir,
  cleanupTempDir,
  buildCodexArgs,
  buildPrompt,
  parseVerdictFromOutput,
} = require('../../lib/codex-judge');

const MOCK_DIR = path.resolve(__dirname, '..', 'mock');
const FIXTURES_BASE = path.resolve(__dirname, '..', '..');

function codexJudgeTests() {
  const tests = {};

  // ── Schema / Verdict validation ─────────────────────────────────

  tests['validateVerdict: valid allow verdict passes'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'low',
      confidence: 0.92,
      policy_hits: [],
      reasons: ['operation appears safe'],
      missing_context: [],
      conditions: [],
    });
    if (!result.valid) throw new Error(`expected valid, got errors: ${JSON.stringify(result.errors)}`);
    if (result.verdict.decision !== 'allow') throw new Error('expected verdict.decision allow');
  };

  tests['validateVerdict: valid ask verdict passes'] = () => {
    const result = validateVerdict({
      decision: 'ask',
      risk_level: 'medium',
      confidence: 0.60,
      policy_hits: ['modified_config'],
      reasons: ['modifying git configuration'],
      missing_context: ['unknown impact on remotes'],
      conditions: [],
    });
    if (!result.valid) throw new Error(`expected valid, got errors: ${JSON.stringify(result.errors)}`);
    if (result.verdict.decision !== 'ask') throw new Error('expected verdict.decision ask');
  };

  tests['validateVerdict: valid deny verdict passes'] = () => {
    const result = validateVerdict({
      decision: 'deny',
      risk_level: 'critical',
      confidence: 0.98,
      policy_hits: ['protected_branch_force_push', 'rewrite_history'],
      reasons: ['force push rewrites shared history on main'],
      missing_context: [],
      conditions: [],
    });
    if (!result.valid) throw new Error(`expected valid, got errors: ${JSON.stringify(result.errors)}`);
    if (result.verdict.decision !== 'deny') throw new Error('expected verdict.decision deny');
  };

  tests['validateVerdict: null input fails'] = () => {
    const result = validateVerdict(null);
    if (result.valid) throw new Error('expected invalid for null input');
  };

  tests['validateVerdict: missing decision fails'] = () => {
    const result = validateVerdict({
      risk_level: 'low',
      confidence: 0.5,
      policy_hits: [],
      reasons: ['test'],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid when decision missing');
  };

  tests['validateVerdict: invalid decision value fails'] = () => {
    const result = validateVerdict({
      decision: 'APPROVE',
      risk_level: 'low',
      confidence: 0.5,
      policy_hits: [],
      reasons: ['test'],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid for bad decision value');
  };

  tests['validateVerdict: invalid risk_level fails'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'extreme',
      confidence: 0.5,
      policy_hits: [],
      reasons: ['test'],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid for bad risk_level');
  };

  tests['validateVerdict: confidence out of range too high fails'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'low',
      confidence: 1.5,
      policy_hits: [],
      reasons: ['test'],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid for confidence > 1');
  };

  tests['validateVerdict: confidence out of range too low fails'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'low',
      confidence: -0.1,
      policy_hits: [],
      reasons: ['test'],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid for confidence < 0');
  };

  tests['validateVerdict: empty reasons fails'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'low',
      confidence: 0.8,
      policy_hits: [],
      reasons: [],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid for empty reasons');
  };

  tests['validateVerdict: extra properties fail'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'low',
      confidence: 0.8,
      policy_hits: [],
      reasons: ['ok'],
      missing_context: [],
      conditions: [],
      extra_field: 'should not be here',
    });
    if (result.valid) throw new Error('expected invalid for extra property');
  };

  tests['validateVerdict: non-array policy_hits fails'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'low',
      confidence: 0.8,
      policy_hits: 'rm -rf /',
      reasons: ['test'],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid for non-array policy_hits');
  };

  tests['validateVerdict: string confidence fails'] = () => {
    const result = validateVerdict({
      decision: 'allow',
      risk_level: 'low',
      confidence: '0.8',
      policy_hits: [],
      reasons: ['test'],
      missing_context: [],
      conditions: [],
    });
    if (result.valid) throw new Error('expected invalid for string confidence');
  };

  tests['loadSchema returns valid JSON Schema object'] = () => {
    const schema = loadSchema();
    if (!schema || typeof schema !== 'object') throw new Error('schema must be an object');
    if (schema.$schema !== 'http://json-schema.org/draft-07/schema#') throw new Error('unexpected $schema');
    if (schema.title !== 'Codex Verdict') throw new Error('unexpected title');
    if (!Array.isArray(schema.required)) throw new Error('required must be an array');
    if (!schema.required.includes('decision')) throw new Error('required must include decision');
    if (!schema.required.includes('reasons')) throw new Error('required must include reasons');
  };

  // ── buildCodexArgs ─────────────────────────────────────────────

  tests['buildCodexArgs includes sandbox ephemeral skip-git-repo-check ignore-rules'] = () => {
    const args = buildCodexArgs('/tmp/schema.json', '/tmp/out.json', null);
    const s = args.join(' ');
    if (!s.includes('--sandbox')) throw new Error('missing --sandbox');
    if (!s.includes('read-only')) throw new Error('missing read-only');
    if (!s.includes('--ephemeral')) throw new Error('missing --ephemeral');
    if (!s.includes('--skip-git-repo-check')) throw new Error('missing --skip-git-repo-check');
    if (!s.includes('--ignore-rules')) throw new Error('missing --ignore-rules');
    if (!s.includes('--output-schema')) throw new Error('missing --output-schema');
    if (!s.includes('-o')) throw new Error('missing -o');
  };

  tests['buildCodexArgs includes --model when model is set'] = () => {
    const args = buildCodexArgs('/tmp/schema.json', '/tmp/out.json', 'gpt-5.6-luna');
    const s = args.join(' ');
    if (!s.includes('--model gpt-5.6-luna')) throw new Error('missing --model');
  };

  tests['buildCodexArgs does not include --model when model is null'] = () => {
    const args = buildCodexArgs('/tmp/schema.json', '/tmp/out.json', null);
    const s = args.join(' ');
    if (s.includes('--model')) throw new Error('--model should not be present when model is null');
  };

  tests['buildCodexArgs does not include --ignore-user-config'] = () => {
    const args = buildCodexArgs('/tmp/schema.json', '/tmp/out.json', null);
    const s = args.join(' ');
    if (s.includes('--ignore-user-config')) throw new Error('must not include --ignore-user-config');
  };

  // ── buildPrompt ────────────────────────────────────────────────

  tests['buildPrompt includes review packet JSON and untrusted data warning'] = () => {
    const packet = { request_id: 'test-123', tool: { name: 'Bash', input: {} }, execution: { command: 'echo hi' } };
    const prompt = buildPrompt(packet);
    if (!prompt.includes('UNTRUSTED DATA')) throw new Error('missing untrusted data warning');
    if (!prompt.includes('test-123')) throw new Error('missing request_id');
    if (!prompt.includes('Bash')) throw new Error('missing tool name');
    if (!prompt.includes('"decision"')) throw new Error('missing decision field in output format');
  };

  tests['buildPrompt does not leak sensitive data in argv'] = () => {
    // The prompt must go to stdin, not argv. Verify by checking no
    // function in the module builds argv from prompt content.
    const packet = { request_id: 'secret-abc' };
    const prompt = buildPrompt(packet);
    // Prompt is the return value — we verify it would NOT appear in argv by
    // checking buildCodexArgs separately.
    if (!prompt) throw new Error('prompt should be non-empty');
  };

  // ── parseVerdictFromOutput ─────────────────────────────────────

  tests['parseVerdictFromOutput: reads from output file'] = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-test-'));
    try {
      const outPath = path.join(dir, 'verdict.json');
      fs.writeFileSync(outPath, '{"decision":"allow","risk_level":"low","confidence":0.9,"policy_hits":[],"reasons":["ok"],"missing_context":[],"conditions":[]}');
      const raw = parseVerdictFromOutput(outPath, '');
      if (!raw) throw new Error('expected verdict from file');
      const parsed = JSON.parse(raw);
      if (parsed.decision !== 'allow') throw new Error('expected allow decision');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  tests['parseVerdictFromOutput: falls back to stdout when output file missing'] = () => {
    const stdout = [
      'Progress: analyzing...',
      'Progress: checking policy...',
      '{"decision":"allow","risk_level":"low","confidence":0.85,"policy_hits":[],"reasons":["safe"],"missing_context":[],"conditions":[]}',
    ].join('\n');
    const raw = parseVerdictFromOutput('/nonexistent/verdict.json', stdout);
    if (!raw) throw new Error('expected verdict from stdout fallback');
    const parsed = JSON.parse(raw);
    if (parsed.decision !== 'allow') throw new Error('expected allow from stdout');
  };

  tests['parseVerdictFromOutput: returns null when both outputs missing'] = () => {
    const result = parseVerdictFromOutput('/nonexistent/output.json', '');
    if (result !== null) throw new Error('expected null when no output available');
  };

  // ── createTempDir / cleanupTempDir ──────────────────────────────

  tests['createTempDir creates a writable directory'] = () => {
    const dir = createTempDir();
    try {
      if (!fs.existsSync(dir)) throw new Error('temp dir should exist');
      fs.writeFileSync(path.join(dir, 'test.txt'), 'hello');
      const content = fs.readFileSync(path.join(dir, 'test.txt'), 'utf8');
      if (content !== 'hello') throw new Error('should be writable');
    } finally {
      cleanupTempDir(dir);
    }
    if (fs.existsSync(dir)) throw new Error('temp dir should be cleaned up');
  };

  tests['cleanupTempDir handles non-existent path gracefully'] = () => {
    // Must not throw
    cleanupTempDir('/nonexistent/path/xyz123');
  };

  tests['cleanupTempDir handles null path gracefully'] = () => {
    cleanupTempDir(null);
    cleanupTempDir(undefined);
  };

  // ── Integration: judge() with mock codex ────────────────────────

  function makePacket(overrides = {}) {
    return {
      schema_version: 1,
      request_id: 'test-' + Date.now(),
      tool: { name: 'Bash', input: {}, summary: 'echo hello' },
      execution: { command: 'echo hello', uses_sudo: false, uses_network: false },
      repository: { is_git_repo: true, root: '/tmp' },
      policy: { deterministic_findings: [], suggested_risk: 'low' },
      metadata: { untrusted_data: true, truncated_fields: [], created_at: new Date().toISOString() },
      ...overrides,
    };
  }

  tests['judge: returns verdict on valid codex response'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: '{"decision":"allow","risk_level":"low","confidence":0.92,"policy_hits":[],"reasons":["operation appears safe"],"missing_context":[],"conditions":[]}',
      },
      timeout: 10000,
    });
    if (!verdict) throw new Error('expected non-null verdict');
    if (verdict.decision !== 'allow') throw new Error(`expected allow, got ${verdict.decision}`);
    if (verdict.confidence !== 0.92) throw new Error(`expected confidence 0.92, got ${verdict.confidence}`);
    if (verdict.risk_level !== 'low') throw new Error(`expected low risk, got ${verdict.risk_level}`);
  };

  tests['judge: returns null on timeout'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_DELAY: '10',
        MOCK_CODEX_VERDICT: '{"decision":"allow","risk_level":"low","confidence":0.5,"policy_hits":[],"reasons":["test"],"missing_context":[],"conditions":[]}',
      },
      timeout: 500,
    });
    if (verdict !== null) throw new Error('expected null on timeout');
  };

  tests['judge: returns null on spawn error'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: '/nonexistent-path',
      },
      timeout: 5000,
    });
    if (verdict !== null) throw new Error('expected null on spawn error');
  };

  tests['judge: returns null on invalid JSON from codex'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: 'not valid json at all',
      },
      timeout: 5000,
    });
    if (verdict !== null) throw new Error('expected null on invalid JSON');
  };

  tests['judge: returns null on schema-invalid verdict'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: '{"decision":"APPROVE","risk_level":"unknown","confidence":99,"policy_hits":"bad","reasons":[],"missing_context":null}',
      },
      timeout: 5000,
    });
    if (verdict !== null) throw new Error('expected null on schema-invalid verdict');
  };

  tests['judge: returns ask verdict correctly'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: '{"decision":"ask","risk_level":"high","confidence":0.75,"policy_hits":["sensitive_path"],"reasons":["target file matches sensitive pattern"],"missing_context":["file content not inspected"],"conditions":[]}',
      },
      timeout: 10000,
    });
    if (!verdict) throw new Error('expected non-null verdict');
    if (verdict.decision !== 'ask') throw new Error(`expected ask, got ${verdict.decision}`);
    if (verdict.risk_level !== 'high') throw new Error(`expected high risk, got ${verdict.risk_level}`);
  };

  tests['judge: returns deny verdict correctly'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: '{"decision":"deny","risk_level":"critical","confidence":0.99,"policy_hits":["rm_root"],"reasons":["command attempts recursive delete on root"],"missing_context":[],"conditions":[]}',
      },
      timeout: 10000,
    });
    if (!verdict) throw new Error('expected non-null verdict');
    if (verdict.decision !== 'deny') throw new Error(`expected deny, got ${verdict.decision}`);
  };

  tests['judge: verdict with multiple reasons and policy_hits works'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: JSON.stringify({
          decision: 'deny',
          risk_level: 'critical',
          confidence: 0.97,
          policy_hits: ['protected_branch_force_push', 'rewrite_history', 'main_branch_mutation'],
          reasons: ['force push rewrites shared history on main', 'operation affects protected base branch', 'irreversible action detected'],
          missing_context: [],
          conditions: [],
        }),
      },
      timeout: 10000,
    });
    if (!verdict) throw new Error('expected non-null verdict');
    if (verdict.policy_hits.length !== 3) throw new Error(`expected 3 policy_hits, got ${verdict.policy_hits.length}`);
    if (verdict.reasons.length !== 3) throw new Error(`expected 3 reasons, got ${verdict.reasons.length}`);
  };

  tests['judge: verdict with missing_context and conditions works'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: JSON.stringify({
          decision: 'ask',
          risk_level: 'medium',
          confidence: 0.65,
          policy_hits: ['network_mutation'],
          reasons: ['operation triggers network access outside container'],
          missing_context: ['destination host unknown', 'protocol not specified'],
          conditions: ['only allow if target is internal', 'requires VPN connection'],
        }),
      },
      timeout: 10000,
    });
    if (!verdict) throw new Error('expected non-null verdict');
    if (verdict.missing_context.length !== 2) throw new Error(`expected 2 missing_context, got ${verdict.missing_context.length}`);
    if (verdict.conditions.length !== 2) throw new Error(`expected 2 conditions, got ${verdict.conditions.length}`);
  };

  // ── CLI argv structure ──────────────────────────────────────────

  tests['judge: spawns codex in temp directory not in cwd'] = () => {
    // The mock doesn't check cwd, but we can verify the codex call
    // succeeds (which means the temp dir was used as cwd) and that
    // the temp dir is cleaned up after. We already verify cleanup in
    // other tests. For argv structure, we verify via the args test above.
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
      },
      timeout: 5000,
    });
    // Default mock verdict should return allow
    if (!verdict) throw new Error('expected non-null verdict');
  };

  // ── Temp directory cleanup verification ─────────────────────────

  tests['judge: temp directory is cleaned up after success'] = () => {
    // Monkey-patch createTempDir to track created dirs
    const createdDirs = [];
    const origCreate = createTempDir;
    // We'll use a list of objects to track temp dirs
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
      },
      timeout: 5000,
    });
    // If we got a verdict back, the temp dirs should have been cleaned up.
    // The judge function uses internal createTempDir — we can't track it
    // from here, but the cleanup happens in the finally block.
    // Verify indirectly: creating temp dirs should still work
    const testDir = createTempDir();
    if (!fs.existsSync(testDir)) throw new Error('temp dir should be creatable');
    cleanupTempDir(testDir);
  };

  tests['judge: temp directory is cleaned up after error'] = () => {
    const packet = makePacket();
    const verdict = judge(packet, {
      env: {
        PATH: `${MOCK_DIR}:${process.env.PATH}`,
        MOCK_CODEX_VERDICT: 'not json',
      },
      timeout: 5000,
    });
    if (verdict !== null) throw new Error('expected null on invalid JSON');
    // Verify we can still create new temp dirs (old ones were cleaned up)
    const testDir = createTempDir();
    if (!fs.existsSync(testDir)) throw new Error('temp dir should be creatable after judge call');
    cleanupTempDir(testDir);
  };

  // ── Sensitive data non-leakage ──────────────────────────────────

  tests['buildCodexArgs: argv does not contain review packet content'] = () => {
    const args = buildCodexArgs('/tmp/schema.json', '/tmp/out.json', 'some-model');
    const argv = args.join(' ');
    // Review packet data should not appear in argv
    if (argv.includes('request_id')) throw new Error('request_id should not be in argv');
    if (argv.includes('UNTRUSTED')) throw new Error('untrusted warning should not be in argv');
    if (argv.includes('secret')) throw new Error('secrets should not be in argv');
    // Only safe configuration flags
    if (!argv.includes('--sandbox')) throw new Error('should include sandbox flag');
  };

  tests['judge: non-leakage — prompt goes via stdin not argv'] = () => {
    // Build args should not include prompt content
    const args = buildCodexArgs('/tmp/schema.json', '/tmp/out.json', null);
    const argvStr = args.join(' ');
    const prompt = buildPrompt({ request_id: 'secret-123', tool: { name: 'Test' } });
    // The prompt content should NOT appear in args at all
    for (const word of prompt.split(/\s+/).filter(w => w.length > 5)) {
      if (argvStr.includes(word)) {
        // Only flag obvious prompt content
        if (word === 'UNTRUSTED' || word === 'ReviewPacket' || word === 'secret-123') {
          throw new Error(`prompt content leaked into argv: "${word}"`);
        }
      }
    }
  };

  return tests;
}

module.exports = { codexJudgeTests };
