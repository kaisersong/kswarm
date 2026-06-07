export interface WorkflowRun {
  id: string;
  projectId: string;
  workflowId: string;
  title: string;
  status: 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  source: string;
  phases: WorkflowPhase[];
  nodes: WorkflowNode[];
  parallelGroups: ParallelGroup[];
  scriptCheckpoints: unknown[];
  completedAt?: number;
  gateDecision?: GateDecision;
  scriptResult?: Record<string, unknown>;
}

export interface WorkflowPhase {
  id: string;
  title: string;
  status: string;
  nodeIds: string[];
}

export interface WorkflowNode {
  id: string;
  phaseId: string;
  title: string;
  kind: string;
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  assignedAgent?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  completedAt?: number;
}

export interface ParallelGroup {
  id: string;
  workflowRunId: string;
  phaseId: string;
  primitiveId?: string;
  kind: string;
  label?: string;
  status: string;
  limit: number;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  failurePolicy: string;
  quorum?: number | null;
}

export interface GateDecision {
  status: string;
  reason?: string;
  evidenceRefs?: string[];
}

export interface WorkflowProposal {
  id: string;
  projectId: string;
  workflowId: string;
  status: string;
  title: string;
}

export type FailurePolicy = 'required_all' | 'collect_errors' | 'fail_fast' | 'quorum';
