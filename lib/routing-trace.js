// Routing trace helper for dry-run mode
// Produces structured output showing what the multi-model routing engine
// would have decided, without altering the real hook decision.

const VALID_FINAL = new Set(['pass', 'ask', 'deny']);

function buildRoutingTrace(opts) {
  if (!opts.dryRun) return null;

  if (!opts.initialRoute) {
    throw new Error('initialRoute is required');
  }
  if (!VALID_FINAL.has(opts.finalWouldBe)) {
    throw new Error(`finalWouldBe must be one of: ${[...VALID_FINAL].join(', ')}`);
  }
  if (opts.escalatedTo && opts.proVerdict === undefined || opts.escalatedTo && opts.proVerdict === null) {
    throw new Error('proVerdict is required when escalatedTo is set');
  }

  const trace = {
    dry_run: opts.dryRun,
    initial_route: opts.initialRoute,
    flash_verdict: opts.flashVerdict || null,
    flash_confidence: opts.flashConfidence ?? null,
    escalated_to: opts.escalatedTo || null,
    pro_verdict: opts.proVerdict || null,
    codex_used: opts.codexUsed || false,
    final_would_be: opts.finalWouldBe,
  };

  if (opts.codexVerdict) {
    trace.codex_verdict = opts.codexVerdict;
  }
  if (opts.toolName) {
    trace.tool_name = opts.toolName;
  }
  if (opts.toolSummary) {
    trace.tool_summary = opts.toolSummary;
  }

  return trace;
}

function formatRoutingTrace(trace) {
  if (!trace) return null;
  return JSON.stringify(trace, null, 2);
}

module.exports = { buildRoutingTrace, formatRoutingTrace };
