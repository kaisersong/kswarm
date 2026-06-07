import { z } from 'zod';
import { runReview } from '../orchestrator/review-orchestrator.js';
export const reviewSchema = {
    projectId: z.string().describe('KSwarm project ID to run the review in'),
    target: z.object({
        files: z.array(z.string()).optional().describe('File paths to review'),
        diff: z.string().optional().describe('Git diff content to review'),
        scope: z.string().optional().describe('Free-text scope description'),
        context: z.string().optional().describe('Additional context for reviewers'),
    }).describe('What to review'),
    dimensions: z.array(z.string()).min(1).describe('Review dimensions, e.g. ["security", "correctness", "performance"]'),
    agents: z.number().int().min(1).max(10).optional().describe('Number of parallel reviewer agents (defaults to dimensions count)'),
    assignedAgents: z.array(z.string()).optional().describe('Specific agent IDs to assign'),
    failurePolicy: z.enum(['required_all', 'collect_errors', 'fail_fast', 'quorum']).default('required_all').describe('How to handle individual reviewer failures'),
    quorum: z.number().int().optional().describe('Minimum passing reviews for quorum policy'),
    timeoutMs: z.number().int().min(5000).optional().describe('Maximum wait time in milliseconds (default 10min, min 5s)'),
};
const schema = z.object(reviewSchema);
export async function handleReview(httpClient, wsClient, config, args) {
    const result = await runReview(httpClient, wsClient, config, args);
    return JSON.stringify(result, null, 2);
}
//# sourceMappingURL=review.js.map