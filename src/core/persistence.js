/**
 * Persistence — Simple JSON file persistence for Hub state
 *
 * Saves projects + tasks to a JSON file on every mutation.
 * Loads on startup to restore state across restarts.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_PATH = new URL('../../../data/state.json', import.meta.url).pathname;

function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

export function createPersistence(filePath = DEFAULT_PATH) {
  mkdirSync(dirname(filePath), { recursive: true });

  let dirty = false;
  let saveTimer = null;

  function load() {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      console.warn('[persistence] Failed to load state:', err.message);
      return null;
    }
  }

  function save(state) {
    dirty = true;
    // Debounce writes to avoid thrashing on rapid mutations
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        if (dirty) {
          dirty = false;
          try {
            writeAtomic(filePath, JSON.stringify(state(), null, 2));
          } catch (err) {
            console.warn('[persistence] Failed to save state:', err.message);
          }
        }
      }, 500);
    }
  }

  function saveSync(state) {
    try {
      writeAtomic(filePath, JSON.stringify(state(), null, 2));
      dirty = false;
    } catch (err) {
      console.warn('[persistence] Failed to save state:', err.message);
    }
  }

  return { load, save, saveSync };
}
