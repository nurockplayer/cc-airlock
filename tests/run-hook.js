#!/usr/bin/env node
// Shared hook test runner — spawns hook scripts with JSON on stdin and interprets the result.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOOK_DIR = path.resolve(__dirname, '..', 'hooks');
const MOCK_DIR = path.resolve(__dirname, 'mock');

function resolveHook(hookFile) {
  const p = hookFile.startsWith('/') ? hookFile : path.resolve(HOOK_DIR, hookFile);
  if (!fs.existsSync(p)) throw new Error(`Hook not found: ${p}`);
  return p;
}

function runHook(hookFile, input, opts = {}) {
  const hookPath = resolveHook(hookFile);

  // Prepend mock dir + original PATH so mock codex/curl intercept
  const env = {
    ...process.env,
    PATH: `${MOCK_DIR}:${process.env.PATH}`,
    ...(opts.env || {}),
  };

  const stdinInput = opts.raw ? input : JSON.stringify(input);

  const result = spawnSync('node', [hookPath], {
    input: stdinInput,
    timeout: opts.timeout || 5000,
    maxBuffer: 65536,
    encoding: 'utf8',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const exitCode = result.status;
  const signal = result.signal;

  let decision = null;
  let reason = null;
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
      decision = parsed.hookSpecificOutput?.permissionDecision || parsed.decision || null;
      reason = parsed.hookSpecificOutput?.permissionDecisionReason || parsed.reason || null;
    } catch {
      // non-JSON stdout — treat as no decision
    }
  }

  if (exitCode === 0 && !decision) {
    decision = 'pass';
  }

  return { decision, reason, parsed, exitCode, signal, stdout, stderr };
}

function suite(name, tests) {
  console.log(`\n# ${name}`);
  let passed = 0;
  let failed = 0;
  for (const [label, fn] of Object.entries(tests)) {
    try {
      fn();
      console.log(`  ✓ ${label}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${label}: ${err.message}`);
      failed++;
    }
  }
  const total = passed + failed;
  console.log(`\n  ${passed}/${total} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

function assertDecision(result, expected) {
  if (result.decision !== expected) {
    const got = result.decision || '(no decision)';
    const extra = result.reason ? ` — reason: ${result.reason}` : '';
    throw new Error(`expected decision "${expected}", got "${got}"${extra}`);
  }
}

module.exports = { runHook, suite, assertDecision };
