/**
 * ProjectDetailPage — full project detail with plan, kanban, activity, deliverables tabs.
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText, LayoutGrid, Activity, Package, CheckCircle2, Send, XCircle, Archive, RefreshCw } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';
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

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getProjectFullDetail, approveProject, dispatchTasks, deliverProject, closeProject, retryPlan, connected } = useKSwarm();
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

  const { project, tasks, activities, humanActions, workspace, plan, planProgress } = detail;
  const showApprove = project.status === 'created' || project.status === 'draft' || project.status === 'planning';
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
          {(project.status === 'created' || project.status === 'draft' || project.status === 'planning') && !plan && (
            <p className="text-[10px] text-yellow-400 mt-1">等待 PO 制定计划...</p>
          )}
          {(project.status === 'created' || project.status === 'draft' || project.status === 'planning') && plan && (
            <p className="text-[10px] text-green-400 mt-1">Plan v{plan.version} 已就绪，可审批</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showApprove && !plan && (
            <button type="button" onClick={async () => {
              await retryPlan(projectId);
              await refreshOnce();
            }} disabled={actionLoading === 'retry'}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-indigo-400 bg-gray-100 hover:brightness-95 disabled:opacity-50">
              <RefreshCw size={13} /><span>重新制定计划</span>
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
