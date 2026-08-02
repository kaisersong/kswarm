/**
 * Persistence — durable state backends for the Hub.
 *
 * Two explicitly-selected backends:
 *   - 'json'   : synchronous, atomic (unique temp + file/dir fsync + rename),
 *                error-propagating JSON file. Kept for legacy/embedded/test callers
 *                that pass a string path. NOT debounced.
 *   - 'sqlite' : durable per-entity SQLite store (see ./sqlite-persistence.js).
 *
 * API (both backends):
 *   load()                       -> full legacy state object | null
 *   save(stateFactory, scope)    -> synchronous durable commit (throws on failure)
 *   saveSync(stateFactory, scope)-> alias of save in P0
 *   close()
 *   getHealth()                  -> { status, backend, ... }
 *
 * `stateFactory(scope)` may return either a plain full-state object (legacy) or a
 * scoped persistence payload ({ entities, humanActions, full }). The JSON backend
 * serializes the full state; the SQLite backend consumes scoped entities.
 */

import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createSqlitePersistence } from './sqlite-persistence.js';

export {
  PersistenceLoadError,
  PersistenceCommitError,
  isPersistenceCommitError,
  isPersistenceLoadError,
  EXIT_LOAD_UNRECOVERABLE,
  EXIT_SAVE_FAILED,
} from './sqlite-persistence.js';

const DEFAULT_PATH = new URL('../../../data/state.json', import.meta.url).pathname;

const IS_WINDOWS = process.platform === 'win32';

function defaultFs() {
  return {
    openSync: nodeFs.openSync,
    writeSync: nodeFs.writeSync,
    fsyncSync: nodeFs.fsyncSync,
    closeSync: nodeFs.closeSync,
    renameSync: nodeFs.renameSync,
    rmSync: nodeFs.rmSync,
    readFileSync: nodeFs.readFileSync,
    writeFileSync: nodeFs.writeFileSync,
    mkdirSync: nodeFs.mkdirSync,
    readdirSync: nodeFs.readdirSync,
    existsSync: nodeFs.existsSync,
  };
}

/**
 * Atomic write with a UNIQUE temp file name, file fsync, rename, and best-effort
 * directory fsync. On any failure the original target is untouched, the temp file
 * is best-effort removed, and the error propagates.
 */
function writeAtomic(filePath, data, fs, uniqueToken) {
  const dir = dirname(filePath);
  const tmp = `${filePath}.${process.pid}.${uniqueToken}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
  // Best-effort directory durability (skip on Windows; some FS reject dir fsync).
  if (!IS_WINDOWS) {
    let dfd;
    try {
      dfd = fs.openSync(dir, 'r');
      fs.fsyncSync(dfd);
    } catch { /* directory fsync best-effort */ }
    finally { if (dfd !== undefined) { try { fs.closeSync(dfd); } catch { /* ignore */ } } }
  }
}

function extractFullState(stateFactory, scope) {
  const out = typeof stateFactory === 'function' ? stateFactory(scope) : stateFactory;
  if (out && typeof out.full === 'function') return out.full();
  return out;
}

function createJsonPersistence({ filePath = DEFAULT_PATH, fs: injectedFs, now = Date.now } = {}) {
  const fs = injectedFs || defaultFs();
  fs.mkdirSync(dirname(filePath), { recursive: true });
  let counter = 0;
  let status = 'ok';

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  function commit(stateFactory, scope) {
    const state = extractFullState(stateFactory, scope);
    const data = JSON.stringify(state, null, 2);
    counter += 1;
    writeAtomic(filePath, data, fs, `${now()}-${counter}`);
  }

  return {
    load,
    save: (stateFactory, scope) => commit(stateFactory, scope),
    saveSync: (stateFactory, scope) => commit(stateFactory, scope),
    close: () => {},
    getHealth: () => ({ status, backend: 'json', filePath }),
  };
}

export function createPersistence(optionsOrPath = DEFAULT_PATH) {
  if (typeof optionsOrPath === 'string') {
    return createJsonPersistence({ filePath: optionsOrPath });
  }
  const options = optionsOrPath || {};
  if (!options.backend) {
    throw new Error('[persistence] backend must be explicitly specified (\'sqlite\' | \'json\')');
  }
  if (options.backend === 'json') return createJsonPersistence(options);
  if (options.backend === 'sqlite') return createSqlitePersistence(options);
  throw new Error(`[persistence] unknown backend: ${options.backend}`);
}
