// Test fixtures for lib/config.js
const { loadConfig } = require('../../lib/config');

function configTests() {
  const tests = {};

  tests['default values when no env vars set'] = () => {
    const cfg = loadConfig({});
    if (cfg.chatModel !== 'deepseek-v4-flash') {
      throw new Error(`expected chatModel "deepseek-v4-flash", got "${cfg.chatModel}"`);
    }
    if (cfg.judgeModel !== 'deepseek-v4-pro') {
      throw new Error(`expected judgeModel "deepseek-v4-pro", got "${cfg.judgeModel}"`);
    }
    if (cfg.codeModel !== 'codex') {
      throw new Error(`expected codeModel "codex", got "${cfg.codeModel}"`);
    }
    if (cfg.flashConfidenceThreshold !== 0.75) {
      throw new Error(`expected flashConfidenceThreshold 0.75, got ${cfg.flashConfidenceThreshold}`);
    }
    if (cfg.escalateOnUnsure !== true) {
      throw new Error(`expected escalateOnUnsure true, got ${cfg.escalateOnUnsure}`);
    }
    if (cfg.askOnDisagreement !== true) {
      throw new Error(`expected askOnDisagreement true, got ${cfg.askOnDisagreement}`);
    }
  };

  tests['override chat model via env'] = () => {
    const cfg = loadConfig({ CC_AIRLOCK_CHAT_MODEL: 'deepseek-v4-pro' });
    if (cfg.chatModel !== 'deepseek-v4-pro') {
      throw new Error(`expected chatModel "deepseek-v4-pro", got "${cfg.chatModel}"`);
    }
    // Other values should still be defaults
    if (cfg.judgeModel !== 'deepseek-v4-pro') {
      throw new Error(`expected judgeModel default "deepseek-v4-pro", got "${cfg.judgeModel}"`);
    }
  };

  tests['override judge model via env'] = () => {
    const cfg = loadConfig({ CC_AIRLOCK_JUDGE_MODEL: 'deepseek-v4-ultra' });
    if (cfg.judgeModel !== 'deepseek-v4-ultra') {
      throw new Error(`expected judgeModel "deepseek-v4-ultra", got "${cfg.judgeModel}"`);
    }
  };

  tests['override code model via env'] = () => {
    const cfg = loadConfig({ CC_AIRLOCK_CODE_MODEL: 'gpt-5' });
    if (cfg.codeModel !== 'gpt-5') {
      throw new Error(`expected codeModel "gpt-5", got "${cfg.codeModel}"`);
    }
  };

  tests['override flash confidence threshold via env'] = () => {
    const cfg = loadConfig({ CC_AIRLOCK_FLASH_CONFIDENCE_THRESHOLD: '0.9' });
    if (cfg.flashConfidenceThreshold !== 0.9) {
      throw new Error(`expected flashConfidenceThreshold 0.9, got ${cfg.flashConfidenceThreshold}`);
    }
  };

  tests['override escalateOnUnsure via env'] = () => {
    const cfg = loadConfig({ CC_AIRLOCK_ESCALATE_ON_UNSURE: 'false' });
    if (cfg.escalateOnUnsure !== false) {
      throw new Error(`expected escalateOnUnsure false, got ${cfg.escalateOnUnsure}`);
    }
  };

  tests['override askOnDisagreement via env'] = () => {
    const cfg = loadConfig({ CC_AIRLOCK_ASK_ON_DISAGREEMENT: 'false' });
    if (cfg.askOnDisagreement !== false) {
      throw new Error(`expected askOnDisagreement false, got ${cfg.askOnDisagreement}`);
    }
  };

  tests['override all values via env'] = () => {
    const cfg = loadConfig({
      CC_AIRLOCK_CHAT_MODEL: 'custom-chat',
      CC_AIRLOCK_JUDGE_MODEL: 'custom-judge',
      CC_AIRLOCK_CODE_MODEL: 'custom-code',
      CC_AIRLOCK_FLASH_CONFIDENCE_THRESHOLD: '0.5',
      CC_AIRLOCK_ESCALATE_ON_UNSURE: 'false',
      CC_AIRLOCK_ASK_ON_DISAGREEMENT: 'false',
    });
    if (cfg.chatModel !== 'custom-chat') throw new Error('chatModel mismatch');
    if (cfg.judgeModel !== 'custom-judge') throw new Error('judgeModel mismatch');
    if (cfg.codeModel !== 'custom-code') throw new Error('codeModel mismatch');
    if (cfg.flashConfidenceThreshold !== 0.5) throw new Error('flashConfidenceThreshold mismatch');
    if (cfg.escalateOnUnsure !== false) throw new Error('escalateOnUnsure mismatch');
    if (cfg.askOnDisagreement !== false) throw new Error('askOnDisagreement mismatch');
  };

  tests['returns fresh object each call'] = () => {
    const a = loadConfig({});
    const b = loadConfig({});
    if (a === b) throw new Error('loadConfig should return a new object each call');
  };

  tests['empty string env var falls back to default'] = () => {
    const cfg = loadConfig({ CC_AIRLOCK_CHAT_MODEL: '' });
    if (cfg.chatModel !== 'deepseek-v4-flash') {
      throw new Error(`expected chatModel default "deepseek-v4-flash", got "${cfg.chatModel}"`);
    }
  };

  return tests;
}

module.exports = { configTests };
