// Test fixtures for lib/codex-helper-modes.js
const {
  formatSpecRequest,
  formatComplianceRequest,
  formatAdequacyRequest,
  formatReviewRequest,
  formatJudgmentPrompt,
} = require('../../lib/codex-helper-modes');

function codexHelperModesTests() {
  const tests = {};

  // ── formatSpecRequest ──────────────────────────────────────

  tests['formatSpecRequest: basic spec request'] = () => {
    const result = formatSpecRequest({
      goal: 'Add user login',
      nonGoals: ['OAuth', 'SSO'],
      files: ['src/auth.js', 'src/login.tsx'],
      contracts: 'User type must remain backward compatible',
      traps: ['No auth token in URL', 'Rate limiting required'],
      riskLevel: 'S2',
    });
    if (!result.includes('Add user login')) throw new Error('missing goal');
    if (!result.includes('OAuth')) throw new Error('missing non-goals');
    if (!result.includes('src/auth.js')) throw new Error('missing files');
    if (!result.includes('Risk: S2')) throw new Error('missing risk level');
    if (!result.includes('[Executors may decide]')) throw new Error('missing decision boundaries');
  };

  tests['formatSpecRequest: minimal spec request'] = () => {
    const result = formatSpecRequest({ goal: 'Fix typo', riskLevel: 'S1' });
    if (!result.includes('Fix typo')) throw new Error('missing goal');
    if (!result.includes('Risk: S1')) throw new Error('missing risk level');
  };

  // ── formatComplianceRequest ────────────────────────────────

  tests['formatComplianceRequest: includes spec and diff headers'] = () => {
    const result = formatComplianceRequest('spec content', 'diff content');
    if (!result.includes('Spec Compliance Report')) throw new Error('missing header');
    if (!result.includes('spec content')) throw new Error('missing spec');
    if (!result.includes('diff content')) throw new Error('missing diff');
    if (!result.includes('Verdict: SAFE / must-fix')) throw new Error('missing verdict');
  };

  tests['formatComplianceRequest: empty inputs'] = () => {
    const result = formatComplianceRequest('', '');
    if (!result.includes('Spec Compliance Report')) throw new Error('missing header');
  };

  // ── formatAdequacyRequest ──────────────────────────────────

  tests['formatAdequacyRequest: includes spec and task headers'] = () => {
    const result = formatAdequacyRequest('spec', 'original task');
    if (!result.includes('Spec Adequacy Report')) throw new Error('missing header');
    if (!result.includes('spec')) throw new Error('missing spec');
    if (!result.includes('original task')) throw new Error('missing task');
    if (!result.includes('Adversarial Review')) throw new Error('missing adversarial review label');
  };

  // ── formatReviewRequest ────────────────────────────────────

  tests['formatReviewRequest: includes context and diff'] = () => {
    const result = formatReviewRequest('review context', 'patch content');
    if (!result.includes('Codex Review Request')) throw new Error('missing header');
    if (!result.includes('review context')) throw new Error('missing context');
    if (!result.includes('patch content')) throw new Error('missing diff');
    if (!result.includes('Phase A')) throw new Error('missing Phase A');
    if (!result.includes('Phase B')) throw new Error('missing Phase B');
    if (!result.includes('APPROVE / REQUEST_CHANGES')) throw new Error('missing verdict');
  };

  // ── formatJudgmentPrompt ───────────────────────────────────

  tests['formatJudgmentPrompt: includes tool and directory'] = () => {
    const result = formatJudgmentPrompt('Bash', { command: 'npm test' }, '/repo', 'summary text');
    if (!result.includes('Bash')) throw new Error('missing tool name');
    if (!result.includes('/repo')) throw new Error('missing directory');
    if (!result.includes('summary text')) throw new Error('missing summary');
    if (!result.includes('SAFE')) throw new Error('missing SAFE keyword');
    if (!result.includes('HUMAN')) throw new Error('missing HUMAN keyword');
  };

  tests['formatJudgmentPrompt: minimal inputs'] = () => {
    const result = formatJudgmentPrompt('Read', {}, undefined, '');
    if (!result.includes('Read')) throw new Error('missing tool name');
    if (!result.includes('unknown')) throw new Error('should show unknown cwd');
  };

  return tests;
}

module.exports = { codexHelperModesTests };
