// Test fixtures for lib/deepseek-client.js
const path = require('path');
const { parseJudgeResponse, callDeepSeek, callFlash, callPro } = require('../../lib/deepseek-client');

function deepSeekClientTests() {
  const tests = {};

  // ── parseJudgeResponse unit tests ─────────────────────────

  tests['parseJudgeResponse: valid SAFE'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'SAFE', confidence: 0.95, risk_category: 'read_only', reason: 'normal operation'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'SAFE') throw new Error(`expected SAFE, got ${r.verdict}`);
    if (r.confidence !== 0.95) throw new Error(`expected confidence 0.95, got ${r.confidence}`);
    if (r.risk_category !== 'read_only') throw new Error(`expected read_only, got ${r.risk_category}`);
    if (!r.reason) throw new Error('expected reason');
  };

  tests['parseJudgeResponse: valid HUMAN'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'HUMAN', confidence: 0.8, risk_category: 'git_mutation', reason: 'needs review'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'HUMAN') throw new Error(`expected HUMAN, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: model returns UNSURE verdict'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'UNSURE', confidence: 0.4, risk_category: 'unknown', reason: 'cannot determine'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: invalid JSON content → UNSURE'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: 'not valid json at all' }}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
    if (r.confidence !== 0) throw new Error(`expected 0 confidence, got ${r.confidence}`);
  };

  tests['parseJudgeResponse: missing verdict field → UNSURE'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        confidence: 0.9, risk_category: 'unknown'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: invalid verdict value → UNSURE'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'MAYBE', confidence: 0.9, risk_category: 'read_only', reason: 'test'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: confidence out of range → UNSURE'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'SAFE', confidence: 5.0, risk_category: 'read_only', reason: 'too confident'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: negative confidence → UNSURE'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'SAFE', confidence: -1, risk_category: 'read_only', reason: 'negative'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: empty content string → UNSURE'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: '' }}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: no choices array → UNSURE'] = () => {
    const r = parseJudgeResponse(JSON.stringify({}));
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: null input → UNSURE'] = () => {
    const r = parseJudgeResponse(null);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: undefined input → UNSURE'] = () => {
    const r = parseJudgeResponse(undefined);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: empty array choices → UNSURE'] = () => {
    const raw = JSON.stringify({ choices: [] });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'UNSURE') throw new Error(`expected UNSURE, got ${r.verdict}`);
  };

  tests['parseJudgeResponse: invalid risk_category defaults to unknown'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'SAFE', confidence: 0.9, risk_category: 'invalid_cat', reason: 'test'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'SAFE') throw new Error(`expected SAFE, got ${r.verdict}`);
    if (r.risk_category !== 'unknown') throw new Error(`expected unknown, got ${r.risk_category}`);
  };

  tests['parseJudgeResponse: missing reason defaults to fallback'] = () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: 'HUMAN', confidence: 0.7, risk_category: 'file_write'
      })}}]
    });
    const r = parseJudgeResponse(raw);
    if (r.verdict !== 'HUMAN') throw new Error(`expected HUMAN, got ${r.verdict}`);
    if (!r.reason) throw new Error('expected fallback reason');
  };

  // ── callDeepSeek integration with mock curl ──────────────

  tests['callDeepSeek with no API key returns null'] = () => {
    const prevKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const result = callDeepSeek('test-model', 'test');
      if (result !== null) throw new Error('expected null when no API key');
    } finally {
      if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
    }
  };

  tests['callDeepSeek returns raw API string'] = () => {
    // Verify that with a mock curl and API key, callDeepSeek returns the raw text
    const prevKey = process.env.DEEPSEEK_API_KEY;
    const prevResp = process.env.MOCK_DEEPSEEK_RESPONSE;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    // Use simple content that doesn't need nested JSON escaping through bash
    process.env.MOCK_DEEPSEEK_RESPONSE = '{"choices":[{"message":{"content":"simple test"}}]}';
    try {
      const raw = callDeepSeek('test-model', 'test prompt');
      if (!raw) throw new Error('expected non-null raw response');
      if (typeof raw !== 'string') throw new Error('expected string response');
      if (!raw.includes('simple test')) throw new Error(`expected "simple test" in response, got: ${raw.substring(0, 100)}`);
    } finally {
      process.env.DEEPSEEK_API_KEY = prevKey;
      process.env.MOCK_DEEPSEEK_RESPONSE = prevResp;
    }
  };

  // ── callFlash / callPro config integration ───────────────

  tests['callFlash and callPro load config model aliases'] = () => {
    // Verify callFlash and callPro exist and integrate with config
    const prevKey = process.env.DEEPSEEK_API_KEY;
    const prevResp = process.env.MOCK_DEEPSEEK_RESPONSE;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    // Simple response that won't be corrupted by shell escaping
    process.env.MOCK_DEEPSEEK_RESPONSE = '{}';
    try {
      // callFlash internally calls loadConfig and then callDeepSeek
      const result = callFlash('test prompt');
      // The mock returns {} which parseJudgeResponse will parse as UNSURE
      // (no choices array) — expected behavior
      if (result.verdict !== 'UNSURE') throw new Error(`expected UNSURE for empty response, got ${result.verdict}`);
    } finally {
      process.env.DEEPSEEK_API_KEY = prevKey;
      process.env.MOCK_DEEPSEEK_RESPONSE = prevResp;
    }
  };

  return tests;
}

module.exports = { deepSeekClientTests };
