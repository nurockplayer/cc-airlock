// Shared DeepSeek judge client for multi-model routing
// Supports Flash (chatModel) and Pro (judgeModel) aliases from config.
// Always requires parseable JSON output. Invalid responses normalize to UNSURE.
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');

// Valid risk categories
const RISK_CATEGORIES = new Set([
  'read_only', 'file_write', 'git_mutation', 'destructive_shell',
  'pr_operation', 'infra', 'unknown',
]);

// Valid verdicts
const VALID_VERDICTS = new Set(['SAFE', 'HUMAN', 'UNSURE']);

function parseJudgeResponse(rawApiResponse) {
  const result = {
    verdict: 'UNSURE',
    confidence: 0,
    risk_category: 'unknown',
    reason: 'failed to parse judge response',
  };

  if (!rawApiResponse || typeof rawApiResponse !== 'string') return result;

  let data;
  try {
    data = JSON.parse(rawApiResponse);
  } catch {
    return result;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') return result;

  // Try to parse the model's JSON content
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return result;
  }

  // Validate verdict
  const verdict = String(parsed.verdict || '').toUpperCase();
  if (!VALID_VERDICTS.has(verdict)) return result;

  // Validate confidence (0.0 - 1.0)
  const confidence = Number(parsed.confidence);
  if (isNaN(confidence) || confidence < 0 || confidence > 1) return result;

  // Validate risk_category
  let riskCategory = String(parsed.risk_category || 'unknown').toLowerCase();
  if (!RISK_CATEGORIES.has(riskCategory)) {
    riskCategory = 'unknown';
  }

  return {
    verdict,
    confidence,
    risk_category: riskCategory,
    reason: String(parsed.reason || `Judge decision: ${verdict} (confidence: ${confidence})`),
  };
}

function callDeepSeek(model, prompt, timeout = 10000) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const payload = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300,
    temperature: 0,
  });

  const result = spawnSync('curl', [
    '-s', '-m', String(Math.ceil(timeout / 1000)),
    'https://api.deepseek.com/v1/chat/completions',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', payload,
  ], {
    timeout,
    maxBuffer: 131072,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

function callFlash(prompt, timeout) {
  const cfg = loadConfig();
  const raw = callDeepSeek(cfg.chatModel, prompt, timeout);
  return parseJudgeResponse(raw);
}

function callPro(prompt, timeout) {
  const cfg = loadConfig();
  const raw = callDeepSeek(cfg.judgeModel, prompt, timeout);
  return parseJudgeResponse(raw);
}

module.exports = { parseJudgeResponse, callDeepSeek, callFlash, callPro };
