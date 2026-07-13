#!/usr/bin/env node
const {
  READ_ONLY_TOOLS,
  MCP_READ_ONLY_RE,
  isWorkflowCodexCall,
  isReadOnlyBash,
} = require('../lib/shared');
const {
  readState,
  resetState,
  withState,
  deleteState,
  digest,
} = require('../lib/workflow-state');

const NON_MUTATING_CONTROL_TOOLS = new Set([
  'Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskStop', 'TodoWrite',
  'Workflow', 'TeamCreate', 'TeamDelete', 'SendMessage',
]);

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function permissionDecision(decision, reason) {
  output({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

function topLevelBlock(reason) {
  output({ decision: 'block', reason });
}

function context(eventName, text) {
  output({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  });
}

function workflowMode(env = process.env) {
  const mode = String(env.CC_AIRLOCK_WORKFLOW_MODE || 'enforce').toLowerCase();
  return ['enforce', 'audit', 'off'].includes(mode) ? mode : 'enforce';
}

function commandOf(input) {
  return String(input?.tool_input?.command || '').trim();
}

function classifyCodexPhase(command) {
  if (!isWorkflowCodexCall(command)) return null;
  const hasPacket = /Analysis\s*Packet|分析封包/i.test(command);
  const hasSpec = /Implementation\s*Spec|實作規格/i.test(command);
  const hasCompliance = /Spec\s*Compliance|規格合規性/i.test(command);
  const hasAdequacy = /Spec\s*Adequacy|規格充分性/i.test(command);
  if (hasCompliance && hasAdequacy) return 'dual';
  if (hasPacket && hasSpec) return 'spec';
  if (hasCompliance) return 'compliance';
  if (hasAdequacy) return 'adequacy';
  return null;
}

function isMutation(input) {
  const tool = String(input?.tool_name || '');
  if (!tool) return true;
  if (READ_ONLY_TOOLS.has(tool) || MCP_READ_ONLY_RE.test(tool) || NON_MUTATING_CONTROL_TOOLS.has(tool)) return false;
  if (tool === 'Bash') {
    const command = commandOf(input);
    if (isWorkflowCodexCall(command)) return false;
    return !isReadOnlyBash(command);
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return true;
  return true;
}

function responseText(input) {
  const response = input?.tool_response;
  if (typeof response === 'string') return response;
  try { return JSON.stringify(response ?? ''); } catch { return String(response ?? ''); }
}

const VERDICT_RE = /\b(?:SAFE|PASS|APPROVE(?:D)?|HUMAN|FAIL|REQUEST_CHANGES)\b|must[- ]fix|需要修正|通過|不通過/i;

function sectionHasVerdict(text, startRe, otherRe) {
  const match = text.match(startRe);
  if (!match) return false;
  const start = match.index;
  const tail = text.slice(start + match[0].length);
  const other = tail.match(otherRe);
  const section = other ? tail.slice(0, other.index) : tail;
  return VERDICT_RE.test(section);
}

function phaseResponseValid(phase, text) {
  const normalized = String(text || '').trim();
  if (normalized.length < 80) return false;
  const specRe = /Implementation\s*Spec|實作規格/i;
  const complianceRe = /Spec\s*Compliance|規格合規性/i;
  const adequacyRe = /Spec\s*Adequacy|規格充分性/i;
  if (phase === 'spec') return specRe.test(normalized);
  if (phase === 'compliance') return sectionHasVerdict(normalized, complianceRe, adequacyRe);
  if (phase === 'adequacy') return sectionHasVerdict(normalized, adequacyRe, complianceRe);
  if (phase === 'dual') {
    return sectionHasVerdict(normalized, complianceRe, adequacyRe)
      && sectionHasVerdict(normalized, adequacyRe, complianceRe);
  }
  return false;
}

function recordPhase(input, phase) {
  const command = commandOf(input);
  const response = responseText(input);
  return withState(input.session_id, input.cwd, process.env, (state) => {
    state.revision += 1;
    const evidence = {
      revision: state.revision,
      commandSha256: digest(command),
      responseSha256: digest(response),
      recordedAt: new Date().toISOString(),
    };
    if (phase === 'spec') {
      state.specRevision = state.revision;
      if (!state.mutationRevision) {
        state.complianceRevision = 0;
        state.adequacyRevision = 0;
        delete state.evidence.compliance;
        delete state.evidence.adequacy;
      }
      if (state.violation !== 'mutation_before_spec') state.violation = null;
      state.evidence.spec = evidence;
    } else if (phase === 'compliance') {
      state.complianceRevision = state.revision;
      state.evidence.compliance = evidence;
    } else if (phase === 'adequacy') {
      state.adequacyRevision = state.revision;
      state.evidence.adequacy = evidence;
    } else if (phase === 'dual') {
      state.complianceRevision = state.revision;
      state.adequacyRevision = state.revision;
      state.evidence.compliance = evidence;
      state.evidence.adequacy = evidence;
    }
    state.stopBlocks = 0;
    return state;
  });
}

function recordMutation(input) {
  return withState(input.session_id, input.cwd, process.env, (state) => {
    state.revision += 1;
    state.mutationRevision = state.revision;
    state.complianceRevision = 0;
    state.adequacyRevision = 0;
    delete state.evidence.compliance;
    delete state.evidence.adequacy;
    state.evidence.lastMutation = {
      revision: state.revision,
      tool: String(input.tool_name || ''),
      inputSha256: digest(JSON.stringify(input.tool_input || {})),
      recordedAt: new Date().toISOString(),
    };
    if (!state.specRevision) state.violation = 'mutation_before_spec';
    state.stopBlocks = 0;
    return state;
  });
}

function pendingSteps(state) {
  if (state.violation === 'corrupt_state') return ['workflow state is corrupt; start a fresh user turn'];
  if (state.violation === 'mutation_before_spec') return ['implementation occurred before Codex Implementation Spec; start a fresh user turn and redo the change in order'];
  if (!state.mutationRevision) return [];
  const pending = [];
  if (!(state.complianceRevision > state.mutationRevision)) pending.push('Codex Spec Compliance verification');
  if (!(state.adequacyRevision > state.mutationRevision)) pending.push('Codex Spec Adequacy verification');
  return pending;
}

function handleUserPromptSubmit(input) {
  resetState(input.session_id, input.cwd, process.env);
  context('UserPromptSubmit', [
    'cc-airlock workflow enforcement is active.',
    'Before any mutation: prepare an Analysis Packet and obtain a Codex Implementation Spec.',
    'After the final mutation: obtain Codex Spec Compliance and Spec Adequacy verification before finishing.',
    'Claims in prose do not count; only successful strict read-only codex exec calls advance workflow state.',
  ].join(' '));
}

function handlePreToolUse(input, mode) {
  const phase = input.tool_name === 'Bash' ? classifyCodexPhase(commandOf(input)) : null;
  if (phase || !isMutation(input)) return;
  const state = readState(input.session_id, input.cwd, process.env);
  if (state.specRevision > 0 && !state.violation) return;
  const reason = 'cc-airlock workflow gate: mutation denied. First send an Analysis Packet to Codex and obtain a successful Implementation Spec using strict read-only codex exec flags.';
  if (mode === 'audit') {
    context('PreToolUse', `AUDIT ONLY: ${reason}`);
    return;
  }
  permissionDecision('deny', reason);
}

function handlePostToolUse(input, mode) {
  if (input.tool_name === 'Bash') {
    const phase = classifyCodexPhase(commandOf(input));
    if (phase) {
      const text = responseText(input);
      if (!phaseResponseValid(phase, text)) {
        const reason = `cc-airlock rejected the ${phase} workflow evidence because the Codex response was empty or missing the required structured section/verdict. Retry the strict read-only Codex call.`;
        if (mode === 'enforce') topLevelBlock(reason);
        return;
      }
      const state = recordPhase(input, phase);
      if (phase === 'spec') {
        context('PostToolUse', 'Codex Implementation Spec recorded. Mutating tools are now unlocked for this turn. Any later mutation will invalidate prior verification.');
      } else {
        const pending = pendingSteps(state);
        if (pending.length) context('PostToolUse', `Workflow evidence recorded. Still required: ${pending.join(' and ')}.`);
        else context('PostToolUse', 'Both Codex verification gates are satisfied after the latest mutation.');
      }
      return;
    }
  }
  if (isMutation(input)) recordMutation(input);
}

function handleStop(input, mode) {
  const activeBackground = Array.isArray(input.background_tasks) && input.background_tasks.some(task => task && !['completed', 'failed', 'cancelled'].includes(task.status));
  if (activeBackground) return;
  const state = readState(input.session_id, input.cwd, process.env);
  if (!state.mutationRevision && !state.violation) {
    deleteState(input.session_id, process.env);
    return;
  }
  const pending = pendingSteps(state);
  if (pending.length === 0) {
    deleteState(input.session_id, process.env);
    return;
  }
  const next = withState(input.session_id, input.cwd, process.env, (current) => {
    current.stopBlocks = current.lastStopRevision === current.revision ? current.stopBlocks + 1 : 1;
    current.lastStopRevision = current.revision;
    return current;
  });
  const reason = `cc-airlock workflow gate: cannot finish. Required next: ${pending.join('; ')}. Verification must be produced by a successful strict read-only Codex call after revision ${state.mutationRevision}. Stop block ${next.stopBlocks}/8.`;
  if (mode === 'audit') return;
  topLevelBlock(reason);
}

function handleSessionEnd(input) {
  deleteState(input.session_id, process.env);
}

function failClosed(event, reason) {
  if (event === 'PreToolUse') return permissionDecision('deny', reason);
  if (event === 'SessionEnd') return;
  return topLevelBlock(reason);
}

function main() {
  let input;
  try { input = JSON.parse(require('fs').readFileSync(0, 'utf8')); }
  catch {
    process.stderr.write('cc-airlock workflow gate received malformed hook input.\n');
    process.exitCode = 2;
    return;
  }
  const mode = workflowMode(process.env);
  if (mode === 'off') return;
  const event = input.hook_event_name;
  try {
    if (event === 'UserPromptSubmit') return handleUserPromptSubmit(input);
    if (event === 'PreToolUse') return handlePreToolUse(input, mode);
    if (event === 'PostToolUse') return handlePostToolUse(input, mode);
    if (event === 'Stop') return handleStop(input, mode);
    if (event === 'SessionEnd') return handleSessionEnd(input);
  } catch {
    return failClosed(event, 'cc-airlock workflow gate failed to read or persist workflow state. The operation was blocked fail-closed.');
  }
}

main();
