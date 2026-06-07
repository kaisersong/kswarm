import type { Config } from '../config.js';
export type WsEventHandler = (event: WsEvent) => void;
export interface WsEvent {
    type: string;
    workflowRunId?: string;
    workflowRun?: Record<string, unknown>;
    [key: string]: unknown;
}
export declare class KSwarmWsClient {
    private config;
    private ws;
    private handlers;
    private reconnectTimer;
    private connected;
    constructor(config: Config);
    connect(): void;
    disconnect(): void;
    isConnected(): boolean;
    private idleTimer;
    subscribe(workflowRunId: string, handler: WsEventHandler): () => void;
    private dispatch;
    private scheduleReconnect;
}
