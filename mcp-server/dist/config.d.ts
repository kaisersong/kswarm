export interface Config {
    kswarmUrl: string;
    kswarmWsUrl: string;
    timeoutMs: number;
    pollIntervalMs: number;
    defaultProjectId: string | undefined;
}
export declare function loadConfig(): Config;
