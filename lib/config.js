// Shared config helper for multi-model routing
// Model aliases and routing options configured via environment variables.
// All env vars use the CC_AIRLOCK_ prefix.

const DEFAULTS = {
  chatModel: 'deepseek-v4-flash',
  judgeModel: 'deepseek-v4-pro',
  codeModel: 'codex',
  flashConfidenceThreshold: 0.75,
  escalateOnUnsure: true,
  askOnDisagreement: true,
  routingDryRun: false,
  enableRouting: false,
};

function readBool(val, defaultVal) {
  if (val === '' || val === undefined || val === null) return defaultVal;
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return defaultVal;
}

function readNumber(val, defaultVal) {
  if (val === '' || val === undefined || val === null) return defaultVal;
  const n = Number(val);
  return isNaN(n) ? defaultVal : n;
}

function loadConfig(env) {
  const e = env || process.env || {};
  return {
    chatModel: e.CC_AIRLOCK_CHAT_MODEL || DEFAULTS.chatModel,
    judgeModel: e.CC_AIRLOCK_JUDGE_MODEL || DEFAULTS.judgeModel,
    codeModel: e.CC_AIRLOCK_CODE_MODEL || DEFAULTS.codeModel,
    flashConfidenceThreshold: readNumber(e.CC_AIRLOCK_FLASH_CONFIDENCE_THRESHOLD, DEFAULTS.flashConfidenceThreshold),
    escalateOnUnsure: readBool(e.CC_AIRLOCK_ESCALATE_ON_UNSURE, DEFAULTS.escalateOnUnsure),
    askOnDisagreement: readBool(e.CC_AIRLOCK_ASK_ON_DISAGREEMENT, DEFAULTS.askOnDisagreement),
    routingDryRun: readBool(e.CC_AIRLOCK_ROUTING_DRY_RUN, DEFAULTS.routingDryRun),
    enableRouting: readBool(e.CC_AIRLOCK_ENABLE_ROUTING, DEFAULTS.enableRouting),
  };
}

module.exports = { loadConfig, DEFAULTS };
