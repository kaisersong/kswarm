/**
 * ProjectDetailPage — full project detail with plan, kanban, activity, deliverables tabs.
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText, LayoutGrid, Activity, Package, CheckCircle2, Send, XCircle, Archive, RefreshCw, AlertTriangle, Clock3 } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';
import { deriveAgentStatuses } from '../../utils/agent-status';
import { PlanView } from './PlanView';
import { KanbanBoard } from './KanbanBoard';
import { ActivityTimeline } from './ActivityTimeline';
import { DeliverableView } from './DeliverableView';

const TABS = [
  { id: 'plan', label: '计划', icon: FileText },
  { id: 'board', label: '看板', icon: LayoutGrid },
  { id: 'activity', label: '动态', icon: Activity },
  { id: 'deliverables', label: '产物', icon: Package },
];

const STATUS_LABELS = {
  draft: '草稿', planning: '规划中', created: '已创建', active: '进行中',
  review: '审核中', delivered: '已交付', closed: '已关闭',
};

const PRE_APPROVAL_STATUSES = new Set(['draft', 'created', 'planning']);
function isInterruptedPlanProject(project, plan, tasks) {
  return project?.status === 'active' && !plan && (tasks || []).length === 0;
}

function canRetryPlanForProject(project, plan, tasks) {
  if (!project || project.status === 'closed' || project.status === 'delivered') return false;
  return PRE_APPROVAL_STATUSES.has(project.status) || isInterruptedPlanProject(project, plan, tasks);
}

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getProjectFullDetail, approveProject, dispatchTasks, deliverProject, closeProject, retryPlan, connected, agents, participants, logs } = useKSwarm();
  const [detail, setDetail] = useState(null);
  const [activeTab, setActiveTab] = useState('board');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const refreshRef = useRef(null);

  const load = async () => {
    if (!projectId) return;
    const data = await getProjectFullDetail(projectId);
    if (data) setDetail(data);
    return data;
  };

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const doLoad = async () => { const data = await load(); if (!cancelled) setLoading(false); };
    doLoad();
    refreshRef.current = setInterval(load, 5000);
    return () => { cancelled = true; if (refreshRef.current) clearInterval(refreshRef.current); };
  }, [projectId]);

  const refreshOnce = async () => { return await load(); };

  const handleAction = async (action, fn) => {
    if (!projectId) return;
    setActionLoading(action);
    await fn();
    await refreshOnce();
    setActionLoading(null);
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center bg-white"><div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" /></div>;
  }

  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-white">
        <p className="text-sm text-gray-500">项目未找到</p>
        <button type="button" onClick={() => navigate('/')} className="text-sm text-gray-500 hover:text-gray-900">返回项目列表</button>
      </div>
    );
  }

  const { project, tasks, activities, humanActions, workspace, plan, planProgress, projectHealth, dispatchPlan } = detail;
  const showApprove = project.status === 'created' || project.status === 'draft' || project.status === 'planning';
  const showRetryPlan = canRetryPlanForProject(project, plan, tasks);
  const showInterruptedPlanHint = isInterruptedPlanProject(project, plan, tasks);
  const showDispatch = project.status === 'active' && tasks.some(t => t.status === 'pending');
  const showDeliver = project.status === 'active' && tasks.every(t => t.status === 'done' || t.status === 'cancelled');
  const showClose = project.status === 'active' || project.status === 'delivered';
  const statusLabel = STATUS_LABELS[project.status] || project.status;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white text-gray-900">
      <div className="flex items-center gap-3 border-b border-gray-200 px-6 py-4">
        <button type="button" onClick={() => navigate('/')} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[14px] font-semibold text-gray-900 truncate">{project.name}</h1>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-gray-300 text-gray-500">{statusLabel}</span>
          </div>
          {project.goal && <p className="text-[12px] text-gray-500 truncate mt-0.5">{project.goal}</p>}
          {project.requirements && <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-1">{project.requirements}</p>}
          {workspace?.path && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[10px] text-gray-500">Workspace:</span>
              <span className="text-[10px] text-gray-500 font-mono truncate max-w-[300px]">{workspace.path}</span>
              {workspace.artifacts?.length > 0 && <span className="text-[9px] px-1 rounded bg-gray-100 text-gray-500">{workspace.artifacts.length} files</span>}
            </div>
          )}
          {showInterruptedPlanHint && (
            <p className="text-[10px] text-yellow-400 mt-1">计划中断，可重新制定计划</p>
          )}
          {!showInterruptedPlanHint && (project.status === 'created' || project.status === 'draft' || project.status === 'planning') && !plan && (
            <p className="text-[10px] text-yellow-400 mt-1">等待 PO 制定计划...</p>
          )}
          {(project.status === 'created' || project.status === 'draft' || project.status === 'planning') && plan && (
            <p className="text-[10px] text-green-400 mt-1">Plan v{plan.version} 已就绪，可审批</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showRetryPlan && (
            <button type="button" onClick={() => handleAction('retry', () => retryPlan(projectId))} disabled={actionLoading === 'retry'}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-indigo-400 bg-gray-100 hover:brightness-95 disabled:opacity-50">
              <RefreshCw size={13} /><span>{actionLoading === 'retry' ? '...' : '重新制定计划'}</span>
            </button>
          )}
          {showApprove && (
            <button type="button" onClick={() => handleAction('approve', () => approveProject(projectId))} disabled={actionLoading === 'approve'}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-green-400 bg-gray-100 hover:brightness-95 disabled:opacity-50">
              <CheckCircle2 size={13} /><span>{actionLoading === 'approve' ? '...' : '审批'}</span>
            </button>
          )}
          {showDispatch && (
            <button type="button" onClick={() => handleAction('dispatch', () => dispatchTasks(projectId, project?.poAgent))} disabled={actionLoading === 'dispatch'}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-gray-900 bg-gray-100 hover:brightness-95 disabled:opacity-50">
              <Send size={13} /><span>{actionLoading === 'dispatch' ? '...' : '分发任务'}</span>
            </button>
          )}
          {showDeliver && (
            <button type="button" onClick={() => handleAction('deliver', () => deliverProject(projectId))} disabled={actionLoading === 'deliver'}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-green-400 bg-gray-100 hover:brightness-95 disabled:opacity-50">
              <Archive size={13} /><span>{actionLoading === 'deliver' ? '...' : '交付'}</span>
            </button>
          )}
          {showClose && !confirmClose && (
            <button type="button" onClick={() => setConfirmClose(true)}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-red-400 bg-gray-100 hover:brightness-95">
              <XCircle size={13} /><span>完成项目</span>
            </button>
          )}
          {confirmClose && (
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => handleAction('close', () => closeProject(projectId))} disabled={actionLoading === 'close'}
                className="rounded-lg px-2.5 py-1 text-[11px] font-medium bg-red-400 text-white">
                {actionLoading === 'close' ? '...' : '确认完成'}
              </button>
              <button type="button" onClick={() => setConfirmClose(false)} className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100">取消</button>
            </div>
          )}
          {!connected && <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">离线</span>}
        </div>
      </div>

      <ProjectHealthBanner health={projectHealth} dispatchPlan={dispatchPlan} />
      <AgentStatusStrip project={project} tasks={tasks} agents={agents} participants={participants} logs={logs} />

      <div className="flex items-center gap-1 border-b border-gray-200 px-6">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12px] font-medium transition-colors ${
                activeTab === tab.id ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-500'
              }`}>
              <Icon size={14} /><span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'plan' && <PlanView plan={plan} planProgress={planProgress} tasks={tasks} />}
        {activeTab === 'board' && <KanbanBoard project={{ ...project, tasks }} />}
        {activeTab === 'activity' && <ActivityTimeline project={project} activities={activities} humanActions={humanActions} />}
        {activeTab === 'deliverables' && <DeliverableView project={project} tasks={tasks} />}
      </div>
    </div>
  );
}

const HEALTH_STYLES = {
  blocked: { icon: AlertTriangle, label: '阻塞', cls: 'border-red-200 bg-red-50 text-red-700' },
  waiting: { icon: Clock3, label: '等待', cls: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
  needs_review: { icon: CheckCircle2, label: '待审核', cls: 'border-green-200 bg-green-50 text-green-700' },
  running: { icon: Activity, label: '运行中', cls: 'border-blue-200 bg-blue-50 text-blue-700' },
  dispatchable: { icon: Send, label: '可派发', cls: 'border-indigo-200 bg-indigo-50 text-indigo-700' },
  complete: { icon: CheckCircle2, label: '已完成', cls: 'border-green-200 bg-green-50 text-green-700' },
  idle: { icon: Clock3, label: '空闲', cls: 'border-gray-200 bg-gray-50 text-gray-600' },
};

function ProjectHealthBanner({ health, dispatchPlan }) {
  if (!health) return null;
  const style = HEALTH_STYLES[health.state] || HEALTH_STYLES.idle;
  const Icon = style.icon;
  const reason = health.reasons?.[0];
  const message = reason?.message || health.gate || (dispatchPlan?.projectGate ? dispatchPlan.projectGate : '');
  return (
    <div className={`border-b px-6 py-2 ${style.cls}`}>
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        <Icon size={13} className="shrink-0" />
        <span className="font-medium">{style.label}</span>
        {message && <span className="truncate opacity-80">{message}</span>}
        {health.counts && (
          <span className="ml-auto shrink-0 opacity-75">
            运行 {health.counts.dispatched + health.counts.accepted + health.counts.inProgress} / 待审 {health.counts.submitted} / 阻塞 {health.counts.blocked}
          </span>
        )}
      </div>
    </div>
  );
}

const AGENT_STATUS_STYLES = {
  working: { dot: 'bg-blue-500 animate-pulse', chip: 'border-blue-200 bg-blue-50 text-blue-700' },
  reviewing: { dot: 'bg-green-500 animate-pulse', chip: 'border-green-200 bg-green-50 text-green-700' },
  waiting_review: { dot: 'bg-green-500', chip: 'border-green-200 bg-green-50 text-green-700' },
  waiting: { dot: 'bg-gray-400', chip: 'border-gray-200 bg-gray-50 text-gray-600' },
  blocked: { dot: 'bg-yellow-500', chip: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
  failed: { dot: 'bg-red-500', chip: 'border-red-200 bg-red-50 text-red-700' },
  error: { dot: 'bg-red-500 animate-pulse', chip: 'border-red-200 bg-red-50 text-red-700' },
  cooldown: { dot: 'bg-orange-500', chip: 'border-orange-200 bg-orange-50 text-orange-700' },
  stalled: { dot: 'bg-red-500 animate-pulse', chip: 'border-red-200 bg-red-50 text-red-700' },
  artifact_mismatch: { dot: 'bg-red-500', chip: 'border-red-200 bg-red-50 text-red-700' },
  cancelled: { dot: 'bg-gray-400', chip: 'border-gray-200 bg-gray-50 text-gray-500' },
  done: { dot: 'bg-green-500', chip: 'border-green-200 bg-green-50 text-green-700' },
  offline: { dot: 'bg-gray-300', chip: 'border-gray-200 bg-gray-50 text-gray-400' },
};

function AgentStatusStrip({ project, tasks, agents, participants, logs }) {
  const statuses = deriveAgentStatuses({ project, tasks, agents, participants, logs });
  if (!statuses.length) return null;

  return (
    <div className="border-b border-gray-200 bg-white px-6 py-2">
      <div className="flex items-center gap-2 overflow-x-auto">
        {statuses.map(status => {
          const style = AGENT_STATUS_STYLES[status.status] || AGENT_STATUS_STYLES.waiting;
          return (
            <div
              key={status.id}
              title={status.taskTitle ? `${status.detail}: ${status.taskTitle}` : status.detail}
              className={`min-w-[150px] max-w-[220px] rounded-md border px-2.5 py-1.5 ${style.chip}`}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                <span className="truncate text-[11px] font-medium">{status.name}</span>
                <span className="shrink-0 text-[9px] opacity-60">{status.role}</span>
                <span className="ml-auto shrink-0 text-[10px]">{status.label}</span>
              </div>
              <div className="mt-0.5 truncate text-[9px] opacity-65">
                {status.taskTitle || status.detail}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
