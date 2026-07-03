// Test fixtures for lib/routing-trace.js
const { buildRoutingTrace } = require('../../lib/routing-trace');

function routingTraceTests() {
  const tests = {};

  // ── buildRoutingTrace unit tests ──────────────────────────

  tests['trace: basic flash pass scenario'] = () => {
    const t = buildRoutingTrace({
      dryRun: true,
      initialRoute: 'flash',
      flashVerdict: 'SAFE',
      flashConfidence: 0.95,
      escalatedTo: null,
      proVerdict: null,
      codexUsed: false,
      finalWouldBe: 'pass',
    });
    if (t.dry_run !== true) throw new Error(`expected dry_run true, got ${t.dry_run}`);
    if (t.initial_route !== 'flash') throw new Error(`expected flash, got ${t.initial_route}`);
    if (t.flash_verdict !== 'SAFE') throw new Error(`expected SAFE, got ${t.flash_verdict}`);
    if (t.flash_confidence !== 0.95) throw new Error(`expected 0.95, got ${t.flash_confidence}`);
    if (t.escalated_to !== null) throw new Error(`expected null, got ${t.escalated_to}`);
    if (t.final_would_be !== 'pass') throw new Error(`expected pass, got ${t.final_would_be}`);
  };

  tests['trace: flash unsure → pro escalation'] = () => {
    const t = buildRoutingTrace({
      dryRun: true,
      initialRoute: 'flash',
      flashVerdict: 'UNSURE',
      flashConfidence: 0.52,
      escalatedTo: 'pro',
      proVerdict: 'SAFE',
      codexUsed: false,
      finalWouldBe: 'pass',
    });
    if (t.escalated_to !== 'pro') throw new Error(`expected pro, got ${t.escalated_to}`);
    if (t.pro_verdict !== 'SAFE') throw new Error(`expected SAFE, got ${t.pro_verdict}`);
    if (t.codex_used !== false) throw new Error(`expected false, got ${t.codex_used}`);
    if (t.final_would_be !== 'pass') throw new Error(`expected pass, got ${t.final_would_be}`);
  };

  tests['trace: full escalation to codex'] = () => {
    const t = buildRoutingTrace({
      dryRun: true,
      initialRoute: 'flash',
      flashVerdict: 'UNSURE',
      flashConfidence: 0.4,
      escalatedTo: 'codex',
      proVerdict: 'HUMAN',
      codexUsed: true,
      codexVerdict: 'SAFE',
      finalWouldBe: 'pass',
    });
    if (t.escalated_to !== 'codex') throw new Error(`expected codex, got ${t.escalated_to}`);
    if (t.codex_used !== true) throw new Error(`expected true, got ${t.codex_used}`);
    if (t.codex_verdict !== 'SAFE') throw new Error(`expected SAFE, got ${t.codex_verdict}`);
    if (t.final_would_be !== 'pass') throw new Error(`expected pass, got ${t.final_would_be}`);
  };

  tests['trace: final would-be ask scenario'] = () => {
    const t = buildRoutingTrace({
      dryRun: true,
      initialRoute: 'flash',
      flashVerdict: 'HUMAN',
      flashConfidence: 0.6,
      escalatedTo: 'pro',
      proVerdict: 'HUMAN',
      codexUsed: true,
      codexVerdict: 'HUMAN',
      finalWouldBe: 'ask',
    });
    if (t.final_would_be !== 'ask') throw new Error(`expected ask, got ${t.final_would_be}`);
    if (t.dry_run !== true) throw new Error(`expected dry_run true, got ${t.dry_run}`);
  };

  tests['trace: dry_run=false suppresses output'] = () => {
    const t = buildRoutingTrace({
      dryRun: false,
      initialRoute: 'flash',
      flashVerdict: 'SAFE',
      flashConfidence: 0.9,
      escalatedTo: null,
      proVerdict: null,
      codexUsed: false,
      finalWouldBe: 'pass',
    });
    if (t !== null) throw new Error('expected null when dry_run is false');
  };

  tests['trace: missing required fields throws'] = () => {
    let threw = false;
    try {
      buildRoutingTrace({ dryRun: true, flashVerdict: 'SAFE' });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('expected throw for missing initialRoute');
  };

  tests['trace: finalWouldBe validated to allowed values'] = () => {
    let threw = false;
    try {
      buildRoutingTrace({
        dryRun: true, initialRoute: 'flash', flashVerdict: 'SAFE',
        flashConfidence: 0.9, escalatedTo: null, proVerdict: null,
        codexUsed: false, finalWouldBe: 'invalid',
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('expected throw for invalid finalWouldBe');
  };

  tests['trace: non-null escalatedTo without proVerdict'] = () => {
    let threw = false;
    try {
      buildRoutingTrace({
        dryRun: true, initialRoute: 'flash', flashVerdict: 'UNSURE',
        flashConfidence: 0.5, escalatedTo: 'pro', proVerdict: null,
        codexUsed: false, finalWouldBe: 'ask',
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('expected throw when escalated but no proVerdict');
  };

  // ── formatRoutingTrace output tests ───────────────────────

  tests['formatRoutingTrace: returns JSON string'] = () => {
    const { formatRoutingTrace } = require('../../lib/routing-trace');
    const t = buildRoutingTrace({
      dryRun: true, initialRoute: 'flash',
      flashVerdict: 'SAFE', flashConfidence: 0.9,
      escalatedTo: null, proVerdict: null,
      codexUsed: false, finalWouldBe: 'pass',
    });
    const str = formatRoutingTrace(t);
    if (typeof str !== 'string') throw new Error('expected string');
    const parsed = JSON.parse(str);
    if (parsed.dry_run !== true) throw new Error('expected dry_run true');
  };

  tests['formatRoutingTrace: output includes tool info when provided'] = () => {
    const { formatRoutingTrace } = require('../../lib/routing-trace');
    const t = buildRoutingTrace({
      dryRun: true, initialRoute: 'flash',
      flashVerdict: 'SAFE', flashConfidence: 0.9,
      escalatedTo: null, proVerdict: null,
      codexUsed: false, finalWouldBe: 'pass',
      toolName: 'Bash',
      toolSummary: 'git push origin main',
    });
    const str = formatRoutingTrace(t);
    const parsed = JSON.parse(str);
    if (parsed.tool_name !== 'Bash') throw new Error('expected Bash');
    if (!parsed.tool_summary) throw new Error('expected tool_summary');
  };

  // ── config integration ────────────────────────────────────

  tests['config includes routingDryRun default'] = () => {
    const { loadConfig } = require('../../lib/config');
    const cfg = loadConfig({});
    if (cfg.routingDryRun !== false) throw new Error(`expected routingDryRun false, got ${cfg.routingDryRun}`);
  };

  tests['config routingDryRun override via env'] = () => {
    const { loadConfig } = require('../../lib/config');
    const cfg = loadConfig({ CC_AIRLOCK_ROUTING_DRY_RUN: 'true' });
    if (cfg.routingDryRun !== true) throw new Error(`expected routingDryRun true, got ${cfg.routingDryRun}`);
  };

  tests['config routingDryRun false override'] = () => {
    const { loadConfig } = require('../../lib/config');
    const cfg = loadConfig({ CC_AIRLOCK_ROUTING_DRY_RUN: 'false' });
    if (cfg.routingDryRun !== false) throw new Error(`expected routingDryRun false, got ${cfg.routingDryRun}`);
  };

  return tests;
}

module.exports = { routingTraceTests };
