/**
 * ActivityTimeline — event timeline from server-side activity log.
 */

import { useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Play, FileText, Users, Plus, Send, Eye, Archive } from 'lucide-react';
import { useKSwarm } from '../../hooks/useKSwarm';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';

const EVENT_META = {
  'project.created': { icon: Plus, label: '创建项目', color: 'text-gray-500' },
  'po.assigned': { icon: Users, label: '指定 PO', color: 'text-gray-500' },
  'tasks.created': { icon: FileText, label: 'PO 创建任务', color: 'text-gray-500' },
  'tasks.added_by_human': { icon: Plus, label: '人工添加任务', color: 'text-gray-900' },
  'project.approved': { icon: CheckCircle2, label: '审批通过', color: 'text-green-400' },
  'task.assigned': { icon: Users, label: '分配任务', color: 'text-gray-500' },
  'task.dispatched': { icon: Send, label: '派发任务', color: 'text-gray-500' },
  'task.accepted': { icon: Play, label: '接受任务', color: 'text-yellow-400' },
  'task.progress': { icon: Play, label: '执行中', color: 'text-yellow-400' },
  'task.submitted': { icon: Eye, label: '提交结果', color: 'text-green-400' },
  'task.done': { icon: CheckCircle2, label: '确认完成', color: 'text-green-400' },
  'task.rework': { icon: AlertCircle, label: '要求返工', color: 'text-red-400' },
  'task.failed': { icon: AlertCircle, label: '任务失败', color: 'text-red-400' },
  'task.cancelled': { icon: AlertCircle, label: '任务取消', color: 'text-gray-500' },
  'project.delivered': { icon: Archive, label: 'PO 提交交付', color: 'text-green-400' },
  'project.closed': { icon: CheckCircle2, label: '项目关闭', color: 'text-gray-500' },
  'plan.submitted': { icon: FileText, label: '提交计划', color: 'text-gray-500' },
  'plan.revised': { icon: FileText, label: '修订计划', color: 'text-yellow-400' },
  'task.reviewed': { icon: Eye, label: 'PO 质量验收', color: 'text-green-400' },
};

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ''; }
}

export function ActivityTimeline({ project, activities, humanActions }) {
  const { agents } = useKSwarm();
  const [previewArtifact, setPreviewArtifact] = useState(null);
  const bottomRef = useRef(null);

  const agentName = (id) => {
    if (!id) return '';
    const a = agents.find(a => a.id === id);
    return a?.name || id;
  };

  const acts = activities || [];
  const humans = humanActions || [];

  if (acts.length === 0 && humans.length === 0) {
    return <div className="flex h-full items-center justify-center"><p className="text-sm text-gray-500">暂无动态</p></div>;
  }

  return (
    <div className="p-6">
      <div className="flex flex-col gap-0">
        {acts.map((event, idx) => {
          const meta = EVENT_META[event.type] || { icon: FileText, label: event.type, color: 'text-gray-500' };
          const Icon = meta.icon;
          const agent = event.agent || event.by || event.target || '';
          const taskTitle = event.taskTitle || '';
          const artifacts = event.output?.artifacts || [];

          return (
            <div key={idx} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100">
                  <Icon size={13} className={meta.color} />
                </div>
                {idx < acts.length - 1 && <div className="w-px flex-1 bg-gray-100 mt-1" />}
              </div>
              <div className="flex-1 pb-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-medium text-gray-900">{meta.label}</span>
                  {agent && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">@{agentName(agent)}</span>}
                  {taskTitle && <span className="text-[10px] text-gray-500">"{taskTitle}"</span>}
                </div>
                {event.tasks && event.tasks.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {event.tasks.map((t, j) => (
                      <span key={j} className="text-[10px] text-gray-500">
                        {t.title}{t.assignedAgent ? ` → @${agentName(t.assignedAgent)}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {artifacts.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {artifacts.map((art, j) => {
                      const a = typeof art === 'string' ? { name: art } : art;
                      return (
                        <button key={j} type="button" onClick={() => setPreviewArtifact(a)}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-300 hover:bg-gray-200">
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {event.count && <span className="text-[10px] text-gray-500 ml-1">{event.count} tasks</span>}
              </div>
              <span className="text-[10px] text-gray-500 shrink-0 font-mono pt-1">{formatTime(event.ts)}</span>
            </div>
          );
        })}
      </div>
      {humans.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-3">你的操作记录</h4>
          <div className="flex flex-col gap-1">
            {humans.map((action, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <div className="flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600">
                  <span className="text-[7px] font-bold text-white">H</span>
                </div>
                <span className="text-[12px] text-gray-900">{action.action}</span>
                {action.projectName && <span className="text-[11px] text-gray-500">— {action.projectName}</span>}
                <span className="text-[10px] text-gray-500 font-mono ml-auto">{formatTime(action.ts)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div ref={bottomRef} />
      {previewArtifact && <ArtifactPreviewModal artifact={previewArtifact} onClose={() => setPreviewArtifact(null)} />}
    </div>
  );
}
