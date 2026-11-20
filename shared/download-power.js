(function () {
  'use strict';

  function needsPower(jobs, queueActive) {
    const active = [...jobs];
    return active.some((job) => ['queued', 'preparing', 'downloading', 'merging', 'saving'].includes(job.state)) ||
      (queueActive && active.length === 0);
  }

  function createClient({ runtime, needed, log }) {
    let port = null;
    let retryTimer = null;
    let stopped = false;
    let unsupported = false;
    const report = (error) => log('防休眠', String(error?.message || error));

    function disconnect(connection) {
      try { connection?.disconnect(); } catch (error) { report(error); }
    }

    function retry() {
      if (stopped || unsupported || retryTimer || !needed()) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        update();
      }, 1000);
    }

    function update() {
      if (stopped || unsupported) return;
      if (!needed()) {
        clearTimeout(retryTimer);
        retryTimer = null;
        const previous = port;
        port = null;
        disconnect(previous);
        return;
      }
      try {
        if (!port) {
          const connection = runtime.connect({ name: 'BILI_DL_POWER' });
          port = connection;
          connection.onMessage.addListener((message) => {
            if (port !== connection) return;
            if (message.type === 'POLL') update();
            if (message.type === 'ERROR') {
              report(message.error);
              if (message.unsupported) {
                unsupported = true;
                port = null;
                disconnect(connection);
              }
            }
          });
          connection.onDisconnect.addListener(() => {
            // Read lastError to consume a failed connection without an unhandled warning.
            const error = runtime.lastError;
            if (port !== connection) return;
            port = null;
            if (error) report(error);
            retry();
          });
        }
        port.postMessage({ type: 'STATE', active: true });
      } catch (error) {
        const previous = port;
        port = null;
        disconnect(previous);
        report(error);
        // An updated/removed extension cannot reconnect from this document.
        if (/context invalidated/i.test(String(error?.message || error))) stopped = true;
        retry();
      }
    }

    function stop() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      const previous = port;
      port = null;
      disconnect(previous);
    }

    function resume() {
      stopped = false;
      update();
    }

    return { update, stop, resume };
  }

  globalThis.BiliDlPower = { needsPower, createClient };
})();
