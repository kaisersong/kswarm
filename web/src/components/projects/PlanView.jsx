/**
 * PlanView — plan display with analysis, success criteria, expandable phases with progress,
 * review results, and revision history.
 */

import { useState } from 'react';
import { CheckCircle2, Circle, Loader2, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';

function TaskStatusIcon({ status }) {
  switch (status) {
    case 'done': return <CheckCircle2 size={13} className="text-green-400 shrink-0" />;
    case 'in_progress': case 'dispatched': return <Loader2 size={13} className="text-gray-500 animate-spin shrink-0" />;
    case 'failed': case 'cancelled': return <AlertCircle size={13} className="text-red-400 shrink-0" />;
    default: return <Circle size={13} className="text-gray-500 shrink-0" />;
  }
}

const ITEM_STATUS_STYLES = {
  planned: 'text-gray-500 bg-gray-100 border-gray-300',
  active: 'text-gray-500 bg-gray-100 border-gray-300',
  completed: 'text-green-400 bg-gray-100 border-green-400/20',
  revised: 'text-yellow-400 bg-gray-100 border-yellow-400/20',
  dropped: 'text-gray-500 line-through opacity-50',
};

function phaseItemsDone(phase) {
  if (!phase.items) return 0;
  return phase.items.filter(item => item.status === 'completed').length;
}

function activePhaseIndex(phases, tasksByPhase) {
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const phaseTasks = tasksByPhase.get(phase.id) || [];
    const allDone = phase.items ? phase.items.every(item => item.status === 'completed') : phaseTasks.every(t => t.status === 'done');
    if (!allDone) return i;
  }
  return 0;
}

export function PlanView({ plan, planProgress, tasks }) {
  const tasks_ = tasks || [];
  const [expandedPhases, setExpandedPhases] = useState(() => new Set((plan?.phases || []).map(p => p.id)));
  const [showRevisions, setShowRevisions] = useState(false);

  const tasksByPhase = new Map();
  for (const task of tasks_) {
    const phase = task.phase ?? 0;
    if (!tasksByPhase.has(phase)) tasksByPhase.set(phase, []);
    tasksByPhase.get(phase).push(task);
  }

  const progressMap = new Map();
  if (planProgress?.phases) {
    for (const p of planProgress.phases) progressMap.set(p.phaseId, { total: p.total, done: p.done });
  }

  const togglePhase = (id) => {
    setExpandedPhases(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (!plan && tasks_.length === 0) {
    return <div className="flex h-full items-center justify-center"><p className="text-sm text-gray-500">暂无计划</p></div>;
  }

  if (!plan && tasks_.length > 0) {
    return (
      <div className="p-6">
        <div className="flex flex-col gap-2">
          {tasks_.map(task => (
            <div key={task.id} className="flex items-start gap-2.5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
              <TaskStatusIcon status={task.status} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-gray-900">{task.title}</p>
                {task.description && <p className="mt-0.5 text-[12px] text-gray-500 line-clamp-2">{task.description}</p>}
              </div>
              {task.assignedAgent && <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">{task.assignedAgent}</span>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const phases = plan?.phases || [];

  return (
    <div className="p-6 space-y-4">
      {plan?.analysis && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Analysis</h4>
          <div className="text-[13px] text-gray-900 whitespace-pre-wrap leading-relaxed">{plan.analysis}</div>
        </div>
      )}
      {plan && plan.successCriteria && plan.successCriteria.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Success Criteria</h4>
          <ul className="space-y-1">
            {plan.successCriteria.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <span className="text-gray-500 mt-0.5">-</span>
                <span className="text-gray-900">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {phases.map((phase, idx) => {
        const phaseTasks = tasksByPhase.get(phase.id) || [];
        const progress = progressMap.get(phase.id) || { total: phaseTasks.length, done: phaseTasks.filter(t => t.status === 'done').length };
        const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
        const isExpanded = expandedPhases.has(phase.id);
        const isCompleted = phaseItemsDone(phase) === (phase.items?.length || 0);
        const isActive = idx === activePhaseIndex(phases, tasksByPhase);

        return (
          <div key={phase.id} className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
            <button type="button" onClick={() => togglePhase(phase.id)}
              className="w-full flex items-center gap-3 p-4 hover:bg-gray-50 transition-colors text-left">
              {isExpanded ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
              <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0 ${
                isCompleted ? 'bg-gray-100 text-green-400' : isActive ? 'bg-gray-100 text-gray-900' : 'bg-gray-100 text-gray-500'
              }`}>{idx + 1}</div>
              <span className="text-[13px] font-medium text-gray-900 flex-1">{phase.name}</span>
              <span className="text-[11px] text-gray-500">{progress.done}/{progress.total}</span>
              <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden shrink-0">
                <div className="h-full bg-green-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
            </button>
            {isExpanded && phase.items && phase.items.length > 0 && (
              <div className="border-t border-gray-200 divide-y divide-zinc-800/50">
                {phase.items.map(item => {
                  const task = tasks_.find(t => t.id === item.id || t.planItemId === item.id);
                  const status = item.status || (task?.status === 'done' ? 'completed' : task?.status === 'in_progress' ? 'active' : 'planned');
                  const review = task?.reviewResult;
                  return (
                    <div key={item.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-medium ${ITEM_STATUS_STYLES[status] || ITEM_STATUS_STYLES.planned}`}>{status}</span>
                        <span className="text-[12px] font-medium text-gray-900 flex-1">{item.title}</span>
                        {item.assignedAgent && <span className="text-[10px] text-gray-500">@{item.assignedAgent}</span>}
                      </div>
                      {item.brief && <p className="text-[11px] text-gray-500 mt-1 ml-6">{item.brief}</p>}
                      {item.acceptanceCriteria && <p className="text-[10px] text-gray-400 mt-0.5 ml-6">Acceptance: {item.acceptanceCriteria}</p>}
                      {review && (
                        <div className={`mt-2 ml-6 px-2.5 py-1.5 rounded-lg text-[10px] border ${
                          review.passed ? 'border-green-400/20 bg-green-400/5 text-green-400' : 'border-red-400/20 bg-red-400/5 text-red-400'
                        }`}>
                          <span className="font-medium">{review.passed ? 'PASSED' : 'REWORK'}</span>
                          {review.feedback && <p className="mt-0.5 text-gray-500">{review.feedback}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {isExpanded && (!phase.items || phase.items.length === 0) && (
              <div className="border-t border-gray-200 px-4 py-3"><p className="text-[12px] text-gray-500">暂无任务</p></div>
            )}
          </div>
        );
      })}
      {plan && plan.revisions && plan.revisions.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50">
          <button type="button" onClick={() => setShowRevisions(!showRevisions)}
            className="w-full flex items-center gap-2 p-4 hover:bg-gray-50 transition-colors text-left">
            {showRevisions ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
            <span className="text-[11px] font-semibold text-gray-500">Revision History ({plan.revisions.length})</span>
          </button>
          {showRevisions && plan.revisions && (
            <div className="border-t border-gray-200 p-4 space-y-3">
              {plan.revisions.map((rev, i) => (
                <div key={i} className="border-l-2 border-yellow-400/30 pl-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500">v{rev.version}</span>
                    {rev.ts && <span className="text-[10px] text-gray-400">{new Date(rev.ts).toLocaleString()}</span>}
                  </div>
                  {rev.reason && <p className="text-[11px] text-gray-500 mt-0.5">{rev.reason}</p>}
                  {rev.changes && rev.changes.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-gray-500">
                      {rev.changes.map((c, j) => <span key={j}>{c.type === 'add' ? '+' : c.type === 'drop' ? '-' : '~'} {c.item?.title || c.itemId || ''}</span>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
