// Codex helper modes — prompt template builders for Codex spec/review workflows.
// These format the prompts used in the 三角色工作流 (Three-Role Workflow):
// - Architect (Codex): produces Implementation Spec
// - Verifier (Codex): Spec Compliance + Spec Adequacy dual verification
// - Reviewer (Codex): Codex review for PR approval

// ── Implementation Spec request ──────────────────────────────────────

function formatSpecRequest(analysisPacket) {
  const { goal, nonGoals, files, contracts, traps, riskLevel } = analysisPacket;
  return [
    '## Implementation Spec Request',
    '',
    'Produce an Implementation Spec with the following structure:',
    '',
    '## Implementation Spec (Risk: ' + (riskLevel || 'S2') + ')',
    '',
    '### Requirements & non-goals',
    goal || '',
    '',
    nonGoals && nonGoals.length ? 'Non-goals: ' + nonGoals.join(', ') : '',
    '',
    '### Existing contracts',
    contracts || '',
    '',
    '### Files to modify (in order)',
    (files || []).map(f => '- ' + f).join('\n') || '',
    '',
    '### Function signatures',
    '',
    '### Behavior examples (input → output / side effect / error)',
    '',
    '### Edge cases (null, empty, extreme, concurrent, reentrant, partial failure)',
    '',
    '### Invariants (must hold before and after)',
    '',
    '### Forbidden implementations',
    '',
    '### Test case outlines (at least one per behavior: input → expected output)',
    '',
    '### Acceptance criteria',
    '',
    '### Spec assumptions (if any of these fail, stop and re-spec)',
    '',
    '### Decision boundaries',
    '- [Executors may decide]: (private mechanics only)',
    '- [ASK CODEX]: (semantics, public behavior, data format, error model, new deps, migration, security, perf tradeoffs)',
    '- [DO NOT CHANGE]: (API semantics, error behavior, schema, compatibility, invariants, test oracles)',
    '',
    '### Analysis Packet (supplied)',
    traps && traps.length ? 'Known traps: ' + traps.join('; ') : '',
  ].filter(Boolean).join('\n');
}

// ── Spec Compliance request ─────────────────────────────────────────

function formatComplianceRequest(spec, diff) {
  return [
    '## Spec Compliance Report',
    '',
    'Review the implementation against the following spec.',
    'Check: deviations from spec, spec gaps (behavior not covered), invariant violations.',
    '',
    '### Spec',
    spec || '',
    '',
    '### Implementation (diff)',
    diff || '',
    '',
    '### Output format',
    '#### Deviations from spec (must-fix)',
    '#### Spec gaps (behavior in code not covered by spec)',
    '#### Invariant violations',
    '',
    '### Verdict: SAFE / must-fix',
  ].join('\n');
}

// ── Spec Adequacy request (adversarial review) ──────────────────────

function formatAdequacyRequest(spec, originalTask) {
  return [
    '## Spec Adequacy Report (Adversarial Review)',
    '',
    'Review the spec against the original task requirements.',
    'Check: does the spec satisfy the original task? Are existing contracts maintained?',
    'Are spec assumptions still valid? What should the spec have covered but didn\'t?',
    '',
    '### Spec',
    spec || '',
    '',
    '### Original task',
    originalTask || '',
    '',
    '### Output format',
    '#### Does the spec satisfy the original task?',
    '#### Are existing contracts maintained?',
    '#### Are spec assumptions still valid?',
    '#### Missing: what should the spec have covered but didn\'t?',
    '',
    '### Verdict: SAFE / must-fix',
  ].join('\n');
}

// ── Codex review request ────────────────────────────────────────────

function formatReviewRequest(context, diff) {
  return [
    '## Codex Review Request',
    '',
    'Review the following code changes. Provide Phase A (Spec Compliance),',
    'Phase B (Spec Adequacy), and Verdict (APPROVE or REQUEST_CHANGES).',
    '',
    '### Context',
    context || '',
    '',
    '### Diff',
    diff || '',
    '',
    '### Output format',
    '#### Phase A — Spec Compliance',
    'Deviations from intended behavior, spec gaps, edge cases missed.',
    '',
    '#### Phase B — Spec Adequacy',
    'Does the fix address the reported issue? Are tests correct and thorough?',
    'Are there remaining blind spots?',
    '',
    '#### Verdict: APPROVE / REQUEST_CHANGES',
    '(If REQUEST_CHANGES, list specific items that must be fixed before approval.)',
  ].join('\n');
}

// ── Safe / HUMAN judgment prompt (for codex-full-access-guard) ──────

function formatJudgmentPrompt(toolName, toolInput, cwd, summary) {
  return [
    'Safety gate: judge this tool call. Reply ONLY "SAFE" or "HUMAN".',
    'Tool: ' + toolName,
    'Directory: ' + (cwd || 'unknown'),
    summary,
    '',
    'Rules (三角色工作流 aware):',
    '- SAFE = everyday dev work: editing source files, running tests, git push/commit/fetch/pull,',
    '  git merge/rebase on feature branches, git branch (create/switch), git stash, git tag,',
    '  installing dependencies (npm/pnpm/yarn/bun/cargo/go), searching, scaffolding,',
    '  creating/closing/reopening PRs and issues (gh pr/issue create/comment/review/close/reopen),',
    '  deleting/moving files (rm/mv), codex exec for spec/compliance/adequacy review,',
    '  and other normal dev workflow actions.',
    '- SAFE (workflow step) = codex exec calls containing Implementation Spec, Spec Compliance,',
    '  Spec Adequacy, Analysis Packet, Decision boundaries, [ASK CODEX], [Executors may decide],',
    '  or [DO NOT CHANGE] markers — these are part of the Codex architect/verifier role.',
    '- SAFE (mechanical fix) = CI fix for lint/type errors/mock setup/formatting only.',
    '- HUMAN = force push to main/master, git push --delete main/master,',
    '  git branch -D on main/master/protected branches, force-altering shared history,',
    '  removing/changing .env/credentials/keys/secrets files,',
    '  production database or infrastructure mutations,',
    '  rm -rf on root/home/wildcard targets,',
    '  CI fix that changes semantics or test oracles,',
    '  or operations where you genuinely cannot determine the risk.',
    '',
    'Key rules:',
    '- force push to feature branches is SAFE (common rebase workflow).',
    '- Force push / branch delete targeting main/master/production → HUMAN.',
    '- Normal git operations (merge/rebase/checkout/branch without -D) on any branch → SAFE.',
    '- Workflow codex exec calls (spec/compliance/adequacy) → SAFE (gate within a gate).',
    'Reply with exactly one word: SAFE or HUMAN.',
  ].join('\n');
}

module.exports = {
  formatSpecRequest,
  formatComplianceRequest,
  formatAdequacyRequest,
  formatReviewRequest,
  formatJudgmentPrompt,
};
