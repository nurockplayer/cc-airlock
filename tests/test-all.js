#!/usr/bin/env node
// Hook test runner entry point
const path = require('path');

// Ensure mock binaries are in PATH
const mockDir = path.resolve(__dirname, 'mock');
process.env.PATH = `${mockDir}:${process.env.PATH}`;

const { suite } = require('./run-hook');

// Load fixture modules
const codexGuardFixtures = require('./fixtures/codex-full-access-guard.test');
const dangerousGitFixtures = require('./fixtures/dangerous-git-guard.test');

suite('codex-full-access-guard: sensitive file guard', codexGuardFixtures.sensitiveFileTests());
suite('codex-full-access-guard: git read-only classification', codexGuardFixtures.gitReadOnlyTests());
suite('codex-full-access-guard: workflow Codex bypass', codexGuardFixtures.workflowCodexBypassTests());
suite('codex-full-access-guard: fail-closed behavior', codexGuardFixtures.failClosedTests());
suite('codex-full-access-guard: read-only tools pass', codexGuardFixtures.readOnlyToolTests());
suite('codex-full-access-guard: MCP read-only pass', codexGuardFixtures.mcpReadOnlyTests());

suite('dangerous-git-guard: git reset --hard', dangerousGitFixtures.gitResetHardTests());
suite('dangerous-git-guard: git clean', dangerousGitFixtures.gitCleanTests());
suite('dangerous-git-guard: safe git commands', dangerousGitFixtures.safeGitTests());
suite('dangerous-git-guard: wrapper stripping', dangerousGitFixtures.wrapperStrippingTests());
suite('dangerous-git-guard: deep extraction', dangerousGitFixtures.deepExtractionTests());
suite('dangerous-git-guard: non-Bash tools', dangerousGitFixtures.nonBashToolTests());
suite('dangerous-git-guard: destructive shell', dangerousGitFixtures.destructiveShellTests());

suite('config: model aliases and routing options', require('./fixtures/config.test').configTests());

suite('deepseek-client: Flash and Pro judge client', require('./fixtures/deepseek-client.test').deepSeekClientTests());

suite('routing-trace: dry-run mode and trace output', require('./fixtures/routing-trace.test').routingTraceTests());

suite('routing-engine: Flash to Pro to Codex escalation', require('./fixtures/routing-engine.test').routingEngineTests());

suite('codex-judge: schema validation and Codex adapter', require('./fixtures/codex-judge.test').codexJudgeTests());
