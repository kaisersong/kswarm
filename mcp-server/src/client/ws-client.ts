import WebSocket from 'ws';
import type { Config } from '../config.js';

export type WsEventHandler = (event: WsEvent) => void;

export interface WsEvent {
  type: string;
  workflowRunId?: string;
  workflowRun?: Record<string, unknown>;
  [key: string]: unknown;
}

export class KSwarmWsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WsEventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  constructor(private config: Config) {}

  connect(): void {
    if (this.ws) return;

    this.ws = new WebSocket(this.config.kswarmWsUrl);

    this.ws.on('open', () => {
      this.connected = true;
    });

    this.ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as WsEvent;
        this.dispatch(event);
      } catch {}
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

  disconnect(): void {
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

  isConnected(): boolean {
    return this.connected;
  }

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(workflowRunId: string, handler: WsEventHandler): () => void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.handlers.has(workflowRunId)) {
      this.handlers.set(workflowRunId, new Set());
    }
    this.handlers.get(workflowRunId)!.add(handler);

    return () => {
      const set = this.handlers.get(workflowRunId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(workflowRunId);
      }
      if (this.handlers.size === 0) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          this.disconnect();
        }, 30_000);
      }
    };
  }

  private dispatch(event: WsEvent): void {
    const runId = event.workflowRunId ||
      (event.workflowRun as Record<string, unknown>)?.id as string | undefined;
    if (!runId) return;

    const set = this.handlers.get(runId);
    if (set) {
      for (const handler of set) {
        handler(event);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.handlers.size === 0) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}
