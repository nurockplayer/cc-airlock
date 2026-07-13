const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_VERSION = 1;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 200;
const STALE_LOCK_MS = 30000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sanitizeSessionId(sessionId) {
  const value = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return value.slice(0, 180) || 'unknown';
}

function stateRoot(env = process.env) {
  return env.CC_AIRLOCK_STATE_DIR || path.join(os.homedir(), '.claude', 'cc-airlock', 'workflow-state');
}

function ensureStateRoot(env = process.env) {
  const root = stateRoot(env);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  return root;
}

function statePath(sessionId, env = process.env) {
  return path.join(stateRoot(env), `${sanitizeSessionId(sessionId)}.json`);
}

function lockPath(sessionId, env = process.env) {
  return `${statePath(sessionId, env)}.lock`;
}

function acquireLock(sessionId, env = process.env) {
  ensureStateRoot(env);
  const file = lockPath(sessionId, env);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      return { fd, file };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {}
      sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error('workflow state lock timeout');
}

function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.file); } catch {}
}

function defaultState(sessionId, cwd = '') {
  return {
    version: STATE_VERSION,
    sessionId: sanitizeSessionId(sessionId),
    cwd: String(cwd || ''),
    revision: 0,
    specRevision: 0,
    mutationRevision: 0,
    complianceRevision: 0,
    adequacyRevision: 0,
    violation: null,
    stopBlocks: 0,
    lastStopRevision: 0,
    evidence: {},
    updatedAt: new Date().toISOString(),
  };
}

function readStateUnlocked(sessionId, cwd = '', env = process.env) {
  const file = statePath(sessionId, env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== STATE_VERSION || parsed.sessionId !== sanitizeSessionId(sessionId)) {
      return defaultState(sessionId, cwd);
    }
    return { ...defaultState(sessionId, cwd), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState(sessionId, cwd);
    return { ...defaultState(sessionId, cwd), violation: 'corrupt_state' };
  }
}

function writeStateUnlocked(state, env = process.env) {
  const root = ensureStateRoot(env);
  const file = path.join(root, `${sanitizeSessionId(state.sessionId)}.json`);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n';
  fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
}

function withState(sessionId, cwd, env, updater) {
  const lock = acquireLock(sessionId, env);
  try {
    const state = readStateUnlocked(sessionId, cwd, env);
    const next = updater(state) || state;
    writeStateUnlocked(next, env);
    return next;
  } finally {
    releaseLock(lock);
  }
}

function readState(sessionId, cwd = '', env = process.env) {
  const lock = acquireLock(sessionId, env);
  try { return readStateUnlocked(sessionId, cwd, env); }
  finally { releaseLock(lock); }
}

function resetState(sessionId, cwd = '', env = process.env) {
  return withState(sessionId, cwd, env, () => defaultState(sessionId, cwd));
}

function deleteState(sessionId, env = process.env) {
  const lock = acquireLock(sessionId, env);
  try {
    try { fs.unlinkSync(statePath(sessionId, env)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  } finally {
    releaseLock(lock);
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

module.exports = {
  STATE_VERSION,
  sanitizeSessionId,
  stateRoot,
  statePath,
  defaultState,
  readState,
  resetState,
  withState,
  deleteState,
  digest,
};
