const REQUEST_TIMEOUT_MS = 30_000;
function enc(segment) {
    return encodeURIComponent(segment);
}
export class KSwarmHttpClient {
    config;
    baseUrl;
    constructor(config) {
        this.config = config;
        this.baseUrl = config.kswarmUrl;
    }
    async healthCheck() {
        try {
            const res = await this.fetchWithTimeout(`${this.baseUrl}/health`);
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async propose(projectId, body) {
        const preview = {
            ok: true,
            source: 'script_generated',
            strategy: 'workflow',
            projectId,
            ...body,
        };
        return this.post(`/projects/${enc(projectId)}/workflows/script-generated/proposal`, preview);
    }
    async startRun(projectId, proposalId, approvedBy = 'mcp-client') {
        return this.post(`/projects/${enc(projectId)}/workflows/script-generated/runs`, { proposalId, approvedBy });
    }
    async createParallelGroup(projectId, workflowRunId, body) {
        return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/parallel-groups`, body);
    }
    async createNode(projectId, workflowRunId, body) {
        return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/nodes`, body);
    }
    async submitResult(projectId, workflowRunId, nodeId, body) {
        return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/nodes/${enc(nodeId)}/result`, body);
    }
    async complete(projectId, workflowRunId, body) {
        return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/complete`, body || {});
    }
    async getStatus(projectId, workflowRunId) {
        return this.get(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}`);
    }
    async cancel(projectId, workflowRunId, reason = 'mcp_client_cancelled') {
        return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/cancel`, { reason });
    }
    async get(path) {
        const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`);
        return this.parseResponse(res);
    }
    async post(path, body) {
        const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return this.parseResponse(res);
    }
    async fetchWithTimeout(url, init) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        }
        finally {
            clearTimeout(timer);
        }
    }
    async parseResponse(res) {
        const text = await res.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new Error(`kswarm API error (${res.status}): ${text.slice(0, 200)}`);
        }
        if (!res.ok) {
            const err = parsed;
            if (err?.error) {
                return parsed;
            }
            throw new Error(`kswarm API error (${res.status}): ${text.slice(0, 200)}`);
        }
        return parsed;
    }
}
//# sourceMappingURL=http-client.js.map