/** Owns the actual HTTP listener, accepted sockets and upgraded WebSockets. */
export function createServerNetworkLifetime(server, wss) {
  const sockets = new Map(), websockets = new Map();
  const errors = [];
  let sealed = false, closePromise, listenAttempt = Promise.resolve();
  function capture(target, collection, stop) {
    let resolve;
    const closed = new Promise(yes => { resolve = yes; });
    const record = { closed, timer: null, stopping: false };
    collection.set(target, record);
    target.once('close', () => {
      clearTimeout(record.timer); collection.delete(target); resolve();
    });
    if (sealed) stop(target, record);
  }
  function stopSocket(socket, record) {
    if (record.stopping) return;
    record.stopping = true;
    record.timer = setTimeout(() => {
      try { socket.destroy(); } catch (error) { errors.push(error); }
    }, 1_000);
  }
  function stopWebSocket(ws, record) {
    if (record.stopping) return;
    record.stopping = true;
    try { ws.close(); } catch (error) { errors.push(error); }
    record.timer = setTimeout(() => {
      try { ws.terminate(); } catch (error) { errors.push(error); }
    }, 1_000);
  }
  server.on('connection', socket => capture(socket, sockets, stopSocket));
  wss.on('connection', ws => capture(ws, websockets, stopWebSocket));
  return Object.freeze({
    listen(...args) {
      if (sealed) throw new Error('server_shutting_down');
      let resolve;
      listenAttempt = new Promise(yes => { resolve = yes; });
      const settle = () => {
        server.removeListener('listening', settle); server.removeListener('error', failed); resolve();
      };
      const failed = error => { errors.push(error); settle(); };
      server.once('listening', settle); server.once('error', failed);
      try { return server.listen(...args); } catch (error) { failed(error); throw error; }
    },
    close() {
      if (closePromise) return closePromise;
      sealed = true;
      // Publish before any server/socket callback can reenter.
      let resolve, reject;
      closePromise = new Promise((yes, no) => { resolve = yes; reject = no; });
      closePromise.catch(() => {});
      const close = async () => {
        for (const [socket, record] of sockets) stopSocket(socket, record);
        for (const [ws, record] of websockets) stopWebSocket(ws, record);
        // A pending actual listen attempt is not an absent listener.
        await listenAttempt;
        const httpClosed = new Promise(done => {
          // A thrown close call is not proof that the listener closed.
          server.once('close', done);
          try {
            server.close(error => {
              if (error) {
                if (error.code === 'ERR_SERVER_NOT_RUNNING' && !server.listening) done();
                else errors.push(error);
              } else done();
            });
          } catch (error) { errors.push(error); }
        });
        const wsClosed = new Promise(done => {
          wss.once('close', done);
          try { wss.close(error => { if (error) errors.push(error); else done(); }); }
          catch (error) { errors.push(error); }
        });
        await Promise.all([httpClosed, wsClosed]);
        // New sockets accepted during the listen-attempt await are also owned.
        await Promise.all([...sockets.values(), ...websockets.values()].map(record => record.closed));
        if (errors.length) throw new AggregateError(errors, 'server_network_close_failed');
      };
      close().then(resolve, reject);
      return closePromise;
    },
  });
}
