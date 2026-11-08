/** Normal server process ownership; this is not a native custody grant. */
export function createServerOperations() {
  const controller = new AbortController();
  const reason = Object.assign(new Error('server_shutting_down'), { code: 'server_shutting_down' });
  const pending = new Set();
  let closed = false;
  let drainPromise;
  function assertOpen() { if (closed) throw reason; }
  return Object.freeze({
    get closed() { return closed; },
    signal: controller.signal,
    assertOpen,
    run(body) {
      if (closed) return Promise.reject(reason);
      // Publish the actual pending work before a body can reenter shutdown.
      let resolve, reject;
      const work = new Promise((yes, no) => { resolve = yes; reject = no; });
      pending.add(work);
      work.then(() => pending.delete(work), () => pending.delete(work));
      try { resolve(body()); } catch (error) { reject(error); }
      return work;
    },
    seal() { closed = true; },
    abort() { closed = true; controller.abort(reason); },
    drain() {
      closed = true;
      return drainPromise ??= Promise.allSettled([...pending]).then(() => undefined);
    },
  });
}

export function shutdownSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
