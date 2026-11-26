import { spawn } from 'node:child_process';

/** Direct children actually spawned here only; no PID discovery or native grant. */
export function createServerWorkerLifetime() {
  const children = new Map(), failures = [];
  let sealed = false, closePromise;
  function signal(child, name) {
    try {
      if (!child.kill(name)) failures.push(Object.assign(new Error(`child_signal_failed:${name}`), { code: 'child_signal_failed' }));
    } catch (error) { failures.push(error); }
  }
  function stop(child, record) {
    if (record.stopping) return;
    record.stopping = true;
    if (!record.exited && child.pid) {
      signal(child, 'SIGTERM');
    }
    record.timer = setTimeout(() => {
      if (!record.exited && child.pid) {
        signal(child, 'SIGKILL');
      }
    }, 1_000);
  }
  return Object.freeze({
    spawn(...args) {
      if (sealed) throw new Error('server_shutting_down');
      const child = spawn(...args);
      let resolve;
      const record = { closed: new Promise(yes => { resolve = yes; }), timer: null, exited: false, stopping: false };
      children.set(child, record);
      child.on('error', error => { if (record.stopping && child.pid) failures.push(error); }); // Spawn errors with no PID remain producer failures.
      child.once('exit', () => { record.exited = true; });
      child.once('close', () => {
        clearTimeout(record.timer); children.delete(child); resolve();
      });
      return child;
    },
    close() {
      if (closePromise) return closePromise;
      sealed = true;
      let resolve, reject;
      closePromise = new Promise((yes, no) => { resolve = yes; reject = no; });
      closePromise.catch(() => {});
      const records = [...children];
      for (const [child, record] of records) stop(child, record);
      Promise.all(records.map(([, record]) => record.closed)).then(() => {
        if (failures.length) reject(new AggregateError(failures, 'server_worker_close_failed'));
        else resolve();
      }, reject);
      return closePromise;
    },
  });
}
