import WebSocket from 'ws';
export class KSwarmWsClient {
    config;
    ws = null;
    handlers = new Map();
    reconnectTimer = null;
    connected = false;
    constructor(config) {
        this.config = config;
    }
    connect() {
        if (this.ws)
            return;
        this.ws = new WebSocket(this.config.kswarmWsUrl);
        this.ws.on('open', () => {
            this.connected = true;
        });
        this.ws.on('message', (data) => {
            try {
                const event = JSON.parse(data.toString());
                this.dispatch(event);
            }
            catch { }
        });
        this.ws.on('close', () => {
            this.connected = false;
            this.ws = null;
            this.scheduleReconnect();
        });
        this.ws.on('error', () => {
            this.connected = false;
            this.ws?.close();
            this.ws = null;
            this.scheduleReconnect();
        });
    }
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
    isConnected() {
        return this.connected;
    }
    idleTimer = null;
    subscribe(workflowRunId, handler) {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (!this.handlers.has(workflowRunId)) {
            this.handlers.set(workflowRunId, new Set());
        }
        this.handlers.get(workflowRunId).add(handler);
        return () => {
            const set = this.handlers.get(workflowRunId);
            if (set) {
                set.delete(handler);
                if (set.size === 0)
                    this.handlers.delete(workflowRunId);
            }
            if (this.handlers.size === 0) {
                this.idleTimer = setTimeout(() => {
                    this.idleTimer = null;
                    this.disconnect();
                }, 30_000);
            }
        };
    }
    dispatch(event) {
        const runId = event.workflowRunId ||
            event.workflowRun?.id;
        if (!runId)
            return;
        const set = this.handlers.get(runId);
        if (set) {
            for (const handler of set) {
                handler(event);
            }
        }
    }
    scheduleReconnect() {
        if (this.handlers.size === 0)
            return;
        if (this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 3000);
    }
}
//# sourceMappingURL=ws-client.js.map